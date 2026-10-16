import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import http from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { runAxeChecks } from "../../src/checks/automated/index.js";
import { scan } from "../../src/core/scanner.js";
import { loadThirdPartyReport, thirdPartyTagOf } from "../../src/core/third-party.js";
import { exclusionFor } from "../../src/report/clustering.js";

const MAIN = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Embeds</title></head><body><main>
  <h1>Embeds</h1>
  <iframe src="/vendor/instagram.com/p/x/embed" width="300" height="80"></iframe>
  <blockquote class="tiktok-embed" cite="https://www.tiktok.com/@u"><img src="/y.png"><a href="https://www.tiktok.com/@u">See on TikTok</a></blockquote>
  <p>Own content</p>
</main></body></html>`;
const EMBED = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Embed</title></head><body><img src="/x.png"><a href="#">in</a></body></html>`;

describe("axe results inside third-party embeds are tagged (P2-017)", () => {
  let browser: Browser;
  let server: http.Server;
  let origin = "";

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    server = http.createServer((req, res) => {
      if (req.url?.endsWith(".png")) { res.statusCode = 404; res.end(); return; }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(req.url?.startsWith("/vendor/") ? EMBED : MAIN);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("tags iframe content by its frame and blockquote content by position; the iframe's own missing title stays untagged", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/`, { waitUntil: "load" });
      const out = await runAxeChecks(page, "t");
      const byRule = (id: string) => out.violations.filter((v) => (v.raw_result as { ruleId: string }).ruleId === id);
      const imageAlt = byRule("image-alt");
      expect(imageAlt).toHaveLength(2);
      const inFrame = imageAlt.find((v) => Array.isArray(v.measured_values?.axe_frame_path))!;
      expect(inFrame.measured_values).toMatchObject({ third_party: { vendor: "instagram", vendor_name: "Instagram", via: "frame" } });
      expect(inFrame.element_selector).toMatch(/^iframe/);
      const inQuote = imageAlt.find((v) => !v.measured_values?.axe_frame_path)!;
      expect(inQuote.measured_values).toMatchObject({ third_party: { vendor: "tiktok", vendor_name: "TikTok", via: "dom", container: "blockquote.tiktok-embed" } });
      const frameTitle = byRule("frame-title");
      expect(frameTitle).toHaveLength(1);
      expect(frameTitle[0].measured_values?.third_party).toBeUndefined();
    } finally {
      await context.close();
    }
  }, 60_000);

  it("a scan lists tagged findings apart and lets them set no criterion status", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wcag-tp-scan-"));
    try {
      const r = await scan({ url: `${origin}/`, dataDir, maxPages: 1, tiers: [1] }, browser);
      const tagged = r.findings.filter((f) => thirdPartyTagOf(f));
      expect(tagged.map((f) => thirdPartyTagOf(f)!.vendor_name).sort()).toEqual(["Instagram", "TikTok"]);
      expect(tagged.every((f) => exclusionFor(f)?.reason === "third_party")).toBe(true);
      // 1.1.1: both image-alt violations are embed content, so they set no status
      expect(r.criterionResults.find((c) => c.wcag_criterion === "1.1.1")?.status).not.toBe("failed");
      // The iframe's missing title is the site's own failure
      expect(r.criterionResults.find((c) => c.wcag_criterion === "4.1.2")?.status).toBe("failed");
      expect(r.summary.third_party_findings).toBe(2);
      expect(r.summary.third_party_by_vendor).toEqual({ Instagram: 1, TikTok: 1 });
      expect(r.summary.total_findings).toBe(r.findings.length - 2);
      expect(r.summary.wcag_criteria_failed).not.toContain("1.1.1");
      const record = loadThirdPartyReport(dataDir, r.scanSession.id)!;
      expect(record.pages[0].containers.map((c) => c.vendor)).toEqual(["instagram", "tiktok"]);
      expect(record.pages[0].sweep).toBeNull();
      expect(existsSync(join(dataDir, r.scanSession.id, "third-party.json"))).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
