import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { recordTabSequence, runKeyboardChecks, runTrapChecks, isTruncatedSweep } from "../../src/checks/behavioral/keyboard.js";
import { analyzeFocusOrder } from "../../src/checks/behavioral/focus-order.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "..", "fixtures", `${name}.html`), "utf8");

describe("keyboard sweep and third-party embeds (P2-034)", () => {
  let browser: Browser;
  let context: BrowserContext;
  let server: http.Server;
  let origin = "";

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    await context.addInitScript({ content: "globalThis.__name = globalThis.__name || ((fn) => fn);" });
    server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (req.url?.startsWith("/vendor/instagram.com/")) {
        res.end(`<!DOCTYPE html><html lang="en"><head><title>Embed</title></head><body><a href="#a">inside one</a><a href="#b">inside two</a></body></html>`);
      } else if (req.url === "/embeds") {
        res.end(fixture("keyboard-embed-test"));
      } else if (req.url === "/cycle") {
        res.end(fixture("keyboard-cycle-test"));
      } else if (req.url === "/trap") {
        res.end(fixture("keyboard-embed-trap-test"));
      } else if (req.url === "/smooth") {
        res.end(fixture("keyboard-smooth-scroll-test"));
      } else {
        res.statusCode = 404;
        res.end("<html><body>no</body></html>");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("steps over an iframe embed and a blockquote embed, reaching every page control", async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/embeds`, { waitUntil: "load" });
      const seq = await recordTabSequence(page);
      expect(seq.exitReason).toBe("cycle");
      expect(seq.embeds.map((e) => [e.vendor, e.focusables_inside, e.kept_focus])).toEqual([["instagram", null, false], ["instagram", 3, false]]);
      expect(seq.focusStops.map((s) => s.embed ? `embed:${s.embed.vendor}` : s.selector)).toEqual(["#l1", "embed:instagram", "#l2", "embed:instagram", "#l3", "#l4"]);
      expect(seq.candidateCount).toBe(4);
      expect(seq.candidatesInsideEmbeds).toBe(3);
      expect(seq.unreachableElements).toEqual([]);
      expect(seq.lastCandidateReached).toBe(true);
      expect(isTruncatedSweep(seq)).toBe(false);

      await page.goto(`${origin}/embeds`, { waitUntil: "load" });
      const r = await runKeyboardChecks(page);
      expect(r.results).toEqual([]);
      expect(r.partialReason).toBeNull();
      expect(r.sweepSummary).toContain("stepped over 2 third-party embed(s) (Instagram ×2; 3 control(s) inside)");
      expect(r.tabSequence.focusStops.filter((s) => s.embed)).toHaveLength(2);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("a lap that closes before the last control is a truncated sweep, not unreachable controls (no embed involved)", async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/cycle`, { waitUntil: "load" });
      const seq = await recordTabSequence(page);
      expect(seq.exitReason).toBe("cycle");
      expect(seq.lastCandidateReached).toBe(false);
      expect(seq.candidateCount).toBe(6);
      expect(seq.unreachableElements.length).toBeGreaterThan(0);
      expect(isTruncatedSweep(seq)).toBe(true);

      await page.goto(`${origin}/cycle`, { waitUntil: "load" });
      const r = await runKeyboardChecks(page);
      expect(r.retried).toBe(true);
      expect(r.results.map((x) => (x.raw_result as { type: string }).type)).toEqual(["truncated_tab_sweep"]);
      expect(r.results[0].measured_values?.exit_reason).toBe("cycle");
      expect(r.partialReason).toMatch(/stopped early \(cycle\)/);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("an embed that keeps focus is a possible trap for review, and its internals are not trap candidates", async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/trap`, { waitUntil: "load" });
      const r = await runKeyboardChecks(page);
      const types = r.results.map((x) => (x.raw_result as { type: string }).type).sort();
      expect(types).toEqual(["possible_embed_focus_trap", "truncated_tab_sweep"]);
      const trap = r.results.find((x) => (x.raw_result as { type: string }).type === "possible_embed_focus_trap")!;
      expect(trap.wcag_criterion).toBe("2.1.2");
      expect(trap.element_selector).toBe("#tt");
      expect(trap.measured_values).toMatchObject({ failure_type: "possible_embed_focus_trap", vendor: "tiktok", exit_reason: "embed_focus" });
      expect(r.tabSequence.embeds).toEqual([{ vendor: "tiktok", vendor_name: "TikTok", container: "#tt", focusables_inside: 1, kept_focus: true }]);
      expect(r.results.some((x) => (x.raw_result as { type: string }).type === "unreachable_interactive_element")).toBe(false);

      await page.goto(`${origin}/trap`, { waitUntil: "load" });
      const traps = await runTrapChecks(page);
      expect(traps.filter((t) => /#tt|#inner/.test(t.element_selector))).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("reads stop positions in page coordinates, unchanged by a smooth scroll in progress, so DOM-ordered controls raise no focus-order issue (P2-036)", async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/smooth`, { waitUntil: "load" });
      // Document offsets of each control, read with no scroll in progress
      const expected = await page.evaluate(() => Object.fromEntries(["l1", "l2", "b1", "b2", "l3", "l4", "l5", "l6"].map((id) => {
        const r = document.getElementById(id)!.getBoundingClientRect();
        return [id, Math.round(r.y + window.scrollY)];
      })));
      expect(expected.l6).toBeGreaterThan(expected.l1 + 1500); // the last controls are well beyond the first viewport
      const runs = [];
      for (let i = 0; i < 2; i++) {
        await page.goto(`${origin}/smooth`, { waitUntil: "load" });
        const seq = await recordTabSequence(page);
        runs.push(seq.focusStops.map((s) => [s.selector.replace(/^.*#/, "#"), Math.round(s.pagePosition!.y)]));
        // Viewport-relative boxes are still recorded for focus-visible crops
        expect(seq.focusStops.every((s) => s.boundingBox !== null)).toBe(true);
        const r = analyzeFocusOrder(seq);
        expect(r.issues.map((i) => `${i.issueType} ${Math.round(i.verticalDelta)}`)).toEqual([]);
        expect(r.tabOrder.map((s) => s.selector)).toEqual(r.visualOrder.map((s) => s.selector));
      }
      expect(runs[0]).toEqual(runs[1]);
      const byId = Object.fromEntries(runs[0]);
      for (const id of ["#l1", "#l2", "#b1", "#b2", "#l3", "#l4", "#l5", "#l6"]) expect(Math.abs(byId[id] - expected[id.slice(1)])).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
    }
  }, 60_000);
});
