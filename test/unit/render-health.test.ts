import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { chromium, type Browser } from "playwright";
import { readFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import http from "node:http";
import sharp from "sharp";
import {
  assessRenderHealth, classifyRenderHealth, isUniformImage, measureServedHtml, RENDER_HEALTH_LIMITS,
  type RenderHealthMeasures,
} from "../../src/core/render-health.js";
import { CoverageRecorder } from "../../src/core/coverage.js";
import { renderCoverageMarkdown, renderCoverageHtml } from "../../src/report/coverage-report.js";
import { scan, blockPassesOnRenderFailure } from "../../src/core/scanner.js";
import type { CriterionResult } from "../../src/types.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const fixture = (name: string) => readFileSync(join(FIXTURES, `${name}.html`), "utf8");

const healthy: RenderHealthMeasures = {
  visible_text_chars: 2400, rendered_structure: 9, served_structure: 9, served_text_chars: 2600,
  swallowed_elements: 0, swallowed_body: false, screenshot_uniform: false,
};

describe("classifyRenderHealth", () => {
  it("passes a page that rendered what was served", () => {
    expect(classifyRenderHealth(healthy)).toEqual({ status: "ok", reasons: [], measures: healthy });
  });

  it("fails body markup inside style text", () => {
    const r = classifyRenderHealth({ ...healthy, swallowed_elements: 40, swallowed_body: true });
    expect(r.status).toBe("render_failed");
    expect(r.reasons[0]).toMatch(/inside a <style> element \(40 element tag\(s\), including <body>\)/);
  });

  it("tolerates a CSS comment that quotes a tag or two", () => {
    expect(classifyRenderHealth({ ...healthy, swallowed_elements: RENDER_HEALTH_LIMITS.swallowedElements - 1 }).status).toBe("ok");
  });

  it("fails when far fewer sections render than were served", () => {
    const r = classifyRenderHealth({ ...healthy, rendered_structure: 3, served_structure: 9 });
    expect(r.reasons).toEqual(["rendered 3 of 9 served section/landmark elements"]);
    expect(classifyRenderHealth({ ...healthy, rendered_structure: 5, served_structure: 9 }).status).toBe("ok");
    // Too little served structure to compare
    expect(classifyRenderHealth({ ...healthy, rendered_structure: 0, served_structure: 3 }).status).toBe("ok");
  });

  it("fails a page with no visible text when the server sent text", () => {
    const r = classifyRenderHealth({ ...healthy, visible_text_chars: 0 });
    expect(r.reasons[0]).toMatch(/no visible text rendered/);
    // A page that serves almost no text (an app shell) is not judged on text
    expect(classifyRenderHealth({ ...healthy, visible_text_chars: 0, served_text_chars: 100 }).status).toBe("ok");
  });

  it("fails a blank screenshot of a page that served content", () => {
    expect(classifyRenderHealth({ ...healthy, screenshot_uniform: true }).reasons).toEqual(["screenshot is blank (one flat colour)"]);
    expect(classifyRenderHealth({ ...healthy, screenshot_uniform: true, served_structure: 0, served_text_chars: 0 }).status).toBe("ok");
  });

  it("does not judge what it could not measure", () => {
    expect(classifyRenderHealth({ ...healthy, served_structure: null, served_text_chars: null, screenshot_uniform: null, rendered_structure: 0 }).status).toBe("ok");
  });
});

describe("measureServedHtml", () => {
  it("counts structure outside script text and estimates text", () => {
    const m = measureServedHtml(`<body><header>Hi</header><script>const t = "<section><section><main>";</script><section>One two</section><style>p{}</style></body>`);
    expect(m.structure).toBe(2);
    expect(m.text_chars).toBe("Hi One two".length);
  });

  it("counts structure that a broken render swallowed into style text", () => {
    expect(measureServedHtml(fixture("render-broken-blank")).structure).toBeGreaterThanOrEqual(8);
  });
});

describe("isUniformImage", () => {
  it("tells a flat image from one with content", async () => {
    const flat = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#ffffff" } }).png().toBuffer();
    const marked = await sharp(flat).composite([{ input: await sharp({ create: { width: 16, height: 16, channels: 3, background: "#000000" } }).png().toBuffer(), left: 8, top: 8 }]).png().toBuffer();
    expect(await isUniformImage(flat)).toBe(true);
    expect(await isUniformImage(marked)).toBe(false);
  });
});

describe("assessRenderHealth on the 8e03985c-shaped fixtures", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  const cases: Array<[string, "ok" | "render_failed"]> = [
    ["render-broken-blank", "render_failed"],
    ["render-broken-partial", "render_failed"],
    ["render-near-normal", "ok"],
    ["render-healthy", "ok"],
  ];
  for (const [name, expected] of cases) {
    it(`${name}: ${expected}`, async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      try {
        const html = fixture(name);
        await page.setContent(html, { waitUntil: "load" });
        const shot = await page.screenshot({ fullPage: true });
        const health = await assessRenderHealth(page, html, shot);
        expect(health.status, JSON.stringify(health)).toBe(expected);
        if (name === "render-broken-blank") {
          expect(health.measures.swallowed_body).toBe(true);
          expect(health.measures.rendered_structure).toBe(0);
          // The skip-link script found nothing to target (the 47 missing skip links of 8e03985c)
          expect(await page.locator("a.skip-link").count()).toBe(0);
        }
        if (name === "render-broken-partial") {
          // sections 4-6 and the footer render; the header and sections 1-3 were swallowed
          expect(health.measures.rendered_structure).toBe(4);
          expect(health.measures.rendered_structure).toBeLessThan(health.measures.served_structure! / 2);
        }
        if (expected === "ok") expect(await page.locator("a.skip-link").count()).toBe(1);
      } finally {
        await page.close();
      }
    }, 20_000);
  }
});

describe("render failures in coverage, criteria and reports", () => {
  it("records every check as failed on the page and lists the page", () => {
    const rec = new CoverageRecorder();
    rec.ran("axe-core", 1, "https://x.test/");
    rec.renderFailure("https://x.test/b", ["page markup inside a <style> element"], [{ check: "axe-core", tier: 1 }, { check: "alt-text", tier: 3 }]);
    rec.ran("alt-text", 3, "https://x.test/b");
    const cov = rec.toJSON("s", ["https://x.test/", "https://x.test/b"]);
    expect(cov.render_failed).toEqual([{ url: "https://x.test/b", reasons: ["page markup inside a <style> element"] }]);
    const onB = cov.entries.filter((e) => e.page_url === "https://x.test/b");
    expect(onB.map((e) => [e.check, e.status])).toEqual([["axe-core", "failed"], ["alt-text", "failed"]]);
    expect(onB[0].message).toMatch(/^render_failed: /);
    expect(new CoverageRecorder().toJSON("s", []).render_failed).toBeUndefined();

    expect(renderCoverageMarkdown(cov)).toContain("**ALERT: 1 of 2 page(s) rendered broken or blank and were not checked.**");
    expect(renderCoverageHtml(cov)).toContain("ALERT: 1 of 2 page(s) rendered broken or blank and were not checked.");
  });

  it("turns passes and not-applicable results into not_tested; failures stay", () => {
    const cr = (criterion: string, status: CriterionResult["status"]): CriterionResult => ({
      scan_session_id: "s", wcag_criterion: criterion, status, tested_by: "axe_core", evidence_summary: "ok", finding_ids: [],
    });
    const results = [cr("1.1.1", "passed"), cr("2.4.1", "failed"), cr("1.2.1", "not_applicable"), cr("2.2.1", "not_tested")];
    expect(blockPassesOnRenderFailure(results, 0)).toEqual([]);
    const changed = blockPassesOnRenderFailure(results, 2);
    expect(changed.map((c) => c.wcag_criterion)).toEqual(["1.1.1", "1.2.1"]);
    expect(results.map((c) => c.status)).toEqual(["not_tested", "failed", "not_tested", "not_tested"]);
    expect(results[0].evidence_summary).toMatch(/^Cannot pass: 2 page\(s\) rendered broken/);
  });
});

describe("scan with a page that renders broken", () => {
  let browser: Browser;
  let server: http.Server;
  let baseUrl = "";
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `wcag-render-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    browser = await chromium.launch();
    const healthyPage = fixture("render-healthy").replace("</footer>", `</footer><a href="/brands">Brands</a>`);
    server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (req.url === "/") res.end(healthyPage);
      else if (req.url === "/brands") res.end(fixture("render-broken-blank"));
      else { res.statusCode = 404; res.end("<html><body>Not found</body></html>"); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    }));
  });

  afterEach(async () => {
    await browser.close();
    server.close();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("checks only the healthy page, records the broken one, and passes no criterion", async () => {
    const result = await scan({ url: baseUrl, dataDir: tmpDir, maxPages: 5, tiers: [1], urls: [`${baseUrl}/`, `${baseUrl}/brands`] }, browser);
    const broken = result.pageSnapshots.find((p) => p.url.endsWith("/brands"))!;
    expect(result.pageSnapshots).toHaveLength(2);
    expect(broken.render_health?.status).toBe("render_failed");
    expect(result.findings.filter((f) => f.page_snapshot_id === broken.id)).toEqual([]);
    expect(result.coverage.render_failed?.map((f) => f.url)).toEqual([broken.url]);
    const axeOnBroken = result.coverage.entries.find((e) => e.check === "axe-core" && e.page_url === broken.url);
    expect(axeOnBroken?.status).toBe("failed");
    expect(result.criterionResults.filter((c) => c.status === "passed")).toEqual([]);
  }, 60_000);
});
