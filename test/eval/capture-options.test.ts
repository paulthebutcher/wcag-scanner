import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { loadEvalConfig, maxPagesFor, type EvalConfig } from "../../src/eval/config.js";
import { evalPaths } from "../../src/eval/paths.js";
import { scrollPass } from "../../src/eval/capture.js";

const REPO = join(import.meta.dirname, "..", "..");
const config = loadEvalConfig(evalPaths(REPO).config);

describe("capture page cap", () => {
  it("uses the default for municipal sites and the recorded override for t01", () => {
    expect(maxPagesFor(config, "m01")).toEqual({ max_pages_per_site: 30, source: "default", reason: null });
    const t01 = maxPagesFor(config, "t01");
    expect(t01.max_pages_per_site).toBe(51);
    expect(t01.source).toBe("site_override");
    expect(t01.reason).toMatch(/8e03985c/);
  });

  it("falls back to the default when no overrides are configured", () => {
    const bare: EvalConfig = { ...config, capture: { ...config.capture, site_overrides: undefined } };
    expect(maxPagesFor(bare, "t01").max_pages_per_site).toBe(config.capture.max_pages_per_site);
  });
});

describe("capture scroll pass", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  it("scrolls top to bottom in viewport steps, triggers scroll-revealed content, and returns to the top", async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent(`<body style="margin:0">
      <div style="height:3000px"></div><div id="late">late</div>
      <script>
        window.maxY = 0;
        addEventListener("scroll", () => { maxY = Math.max(maxY, scrollY); });
        new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) document.body.dataset.revealed = "1"; })
          .observe(document.getElementById("late"));
      </script></body>`);
    const r = await scrollPass(page);
    expect(r.steps).toBeGreaterThanOrEqual(5);
    expect(await page.evaluate(() => (window as unknown as { maxY: number }).maxY)).toBeGreaterThan(2000);
    expect(await page.evaluate(() => document.body.dataset.revealed)).toBe("1");
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.close();
  }, 20_000);
});
