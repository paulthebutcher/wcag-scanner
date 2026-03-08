import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  relativeLuminance,
  contrastRatio,
  checkFocusVisibility,
  runFocusVisibleChecks,
} from "../../src/checks/behavioral/focus-visible.js";
import { recordTabSequence } from "../../src/checks/behavioral/keyboard.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fixturePath = join(import.meta.dirname, "..", "fixtures", "focus-visible-test.html");
const fixtureHtml = readFileSync(fixturePath, "utf-8");

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe("relativeLuminance", () => {
  it("returns 0 for black", () => {
    expect(relativeLuminance(0, 0, 0)).toBeCloseTo(0, 4);
  });

  it("returns 1 for white", () => {
    expect(relativeLuminance(255, 255, 255)).toBeCloseTo(1, 4);
  });

  it("returns intermediate values for mid-gray", () => {
    const lum = relativeLuminance(128, 128, 128);
    expect(lum).toBeGreaterThan(0.2);
    expect(lum).toBeLessThan(0.3);
  });
});

describe("contrastRatio", () => {
  it("returns 21:1 for black on white", () => {
    const l1 = relativeLuminance(0, 0, 0);
    const l2 = relativeLuminance(255, 255, 255);
    expect(contrastRatio(l1, l2)).toBeCloseTo(21, 0);
  });

  it("returns 1:1 for same color", () => {
    const l = relativeLuminance(128, 128, 128);
    expect(contrastRatio(l, l)).toBeCloseTo(1, 2);
  });

  it("is order-independent", () => {
    const l1 = relativeLuminance(50, 50, 50);
    const l2 = relativeLuminance(200, 200, 200);
    expect(contrastRatio(l1, l2)).toBe(contrastRatio(l2, l1));
  });
});

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("checkFocusVisibility", () => {
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("returns results for each tab stop with a bounding box", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(fixtureHtml);
      const tabSeq = await recordTabSequence(page, { maxTabs: 50 });

      // Reset focus for visibility check
      await page.evaluate(() => document.body.focus());

      const results = await checkFocusVisibility(page, tabSeq);

      expect(results.length).toBeGreaterThan(0);

      for (const r of results) {
        expect(r.selector).toBeTruthy();
        expect(r.unfocusedScreenshot).toBeInstanceOf(Buffer);
        expect(r.focusedScreenshot).toBeInstanceOf(Buffer);
        expect(r.unfocusedScreenshot.length).toBeGreaterThan(0);
        expect(r.focusedScreenshot.length).toBeGreaterThan(0);
        expect(typeof r.pixelDiffPercent).toBe("number");
        expect(typeof r.hasVisualChange).toBe("boolean");
      }
    } finally {
      await page.close();
    }
  });

  it("detects visual change on elements with default focus styles", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(fixtureHtml);
      const tabSeq = await recordTabSequence(page, { maxTabs: 50 });
      await page.evaluate(() => document.body.focus());

      const results = await checkFocusVisibility(page, tabSeq);

      // Default button should have visible focus
      const defaultBtn = results.find((r) => r.selector.includes("btn-default"));
      if (defaultBtn) {
        expect(defaultBtn.hasVisualChange).toBe(true);
      }
    } finally {
      await page.close();
    }
  });

  it("detects no visual change on elements with outline:none", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(fixtureHtml);
      const tabSeq = await recordTabSequence(page, { maxTabs: 50 });
      await page.evaluate(() => document.body.focus());

      const results = await checkFocusVisibility(page, tabSeq);

      // No-focus-indicator button should have no visual change
      const noFocusBtn = results.find((r) => r.selector.includes("btn-no-focus"));
      if (noFocusBtn) {
        expect(noFocusBtn.hasVisualChange).toBe(false);
        expect(noFocusBtn.meetsMinimum).toBe(false);
      }
    } finally {
      await page.close();
    }
  });

  it("provides both screenshots as evidence", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(fixtureHtml);
      const tabSeq = await recordTabSequence(page, { maxTabs: 50 });
      await page.evaluate(() => document.body.focus());

      const results = await checkFocusVisibility(page, tabSeq);

      for (const r of results) {
        // Both screenshots should be valid PNG buffers
        expect(r.unfocusedScreenshot[0]).toBe(0x89); // PNG magic byte
        expect(r.focusedScreenshot[0]).toBe(0x89);
      }
    } finally {
      await page.close();
    }
  });
});

// ---------------------------------------------------------------------------
// runFocusVisibleChecks — CheckResult generation
// ---------------------------------------------------------------------------

describe("runFocusVisibleChecks", () => {
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("produces CheckResult for elements failing focus visibility", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(fixtureHtml);
      const tabSeq = await recordTabSequence(page, { maxTabs: 50 });
      await page.evaluate(() => document.body.focus());

      const results = await runFocusVisibleChecks(page, tabSeq);

      // Should flag at least the no-focus-indicator elements
      expect(results.length).toBeGreaterThan(0);

      for (const r of results) {
        expect(r.wcag_criterion).toBe("2.4.7");
        expect(r.detected_by).toBe("playwright");
        expect(r.element_selector).toBeTruthy();
        expect(r.screenshot).toBeInstanceOf(Buffer);
        expect(r.context_screenshot).toBeInstanceOf(Buffer);

        const raw = r.raw_result as Record<string, unknown>;
        expect(["no_visible_focus_indicator", "focus_indicator_low_contrast"]).toContain(
          raw.type,
        );

        const measured = r.measured_values as Record<string, unknown>;
        expect(typeof measured.pixel_diff_percent).toBe("number");
        expect(typeof measured.has_visual_change).toBe("boolean");
      }
    } finally {
      await page.close();
    }
  });

  it("does not flag elements with good focus indicators", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(`
        <!DOCTYPE html>
        <html lang="en"><head><title>Good Focus</title>
        <style>
          button { padding: 10px 20px; }
          button:focus { outline: 3px solid #000000; outline-offset: 2px; }
        </style></head>
        <body>
          <button id="good-btn">Well Styled</button>
        </body></html>
      `);

      const tabSeq = await recordTabSequence(page, { maxTabs: 10 });
      await page.evaluate(() => document.body.focus());

      const results = await runFocusVisibleChecks(page, tabSeq);

      // Good focus styles should not produce violations
      const goodBtn = results.find((r) => r.element_selector.includes("good-btn"));
      expect(goodBtn).toBeUndefined();
    } finally {
      await page.close();
    }
  });

  it("includes both focused and unfocused screenshots in evidence", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(fixtureHtml);
      const tabSeq = await recordTabSequence(page, { maxTabs: 50 });
      await page.evaluate(() => document.body.focus());

      const results = await runFocusVisibleChecks(page, tabSeq);

      if (results.length > 0) {
        expect(results[0].screenshot).toBeTruthy();
        expect(results[0].context_screenshot).toBeTruthy();
        expect(results[0].screenshot!.length).toBeGreaterThan(0);
        expect(results[0].context_screenshot!.length).toBeGreaterThan(0);
      }
    } finally {
      await page.close();
    }
  });
});
