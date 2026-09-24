import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import {
  relativeLuminance,
  contrastRatio,
  compareScreenshots,
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
// compareScreenshots — algorithmic unit tests with synthetic pixel buffers
// These are environment-independent and directly verify the perimeter-contrast
// algorithm that drives the composite pass/fail decision.
// ---------------------------------------------------------------------------

/** Build a PNG buffer from a per-pixel RGB function */
async function createPng(
  width: number,
  height: number,
  pixelFn: (x: number, y: number) => [number, number, number],
): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelFn(x, y);
      const i = (y * width + x) * 3;
      data[i] = r; data[i + 1] = g; data[i + 2] = b;
    }
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

describe("compareScreenshots", () => {
  it("no change at all: diffPercent=0, perimeterContrast=0, hasFillChange=false", async () => {
    const img = await createPng(40, 30, () => [200, 200, 200]);
    const r = await compareScreenshots(img, img);
    expect(r.diffPercent).toBe(0);
    expect(r.perimeterContrast).toBe(0);
    expect(r.hasFillChange).toBe(false);
  });

  it("low-contrast thin outline (#e0e0e0 on white): perimeterContrast < 3.0", async () => {
    // Unfocused: all white.  Focused: 1px outer ring of #e0e0e0.
    // The ring edge contrast = #e0e0e0 vs #ffffff ≈ 1.31:1 → should fail.
    const W = 50, H = 30;
    const unfocused = await createPng(W, H, () => [255, 255, 255]);
    const focused = await createPng(W, H, (x, y) => {
      const isRing = x === 0 || x === W - 1 || y === 0 || y === H - 1;
      return isRing ? [224, 224, 224] : [255, 255, 255];
    });
    const r = await compareScreenshots(unfocused, focused);
    expect(r.diffPercent).toBeGreaterThan(0);
    expect(r.perimeterContrast).toBeLessThan(3.0);
    expect(r.hasFillChange).toBe(false);
  });

  it("black outer ring + white inner ring: perimeterContrast > 3.0, hasFillChange=false", async () => {
    // Simulates the Lakewood Court false positive: cream background, element
    // interior unchanged, 3px black outer ring + 3px white inner ring.
    // Old algorithm: average of black+white ring pixels = gray → low contrast.
    // New algorithm: outer edge pixels (black) vs cream background → >10:1.
    const W = 60, H = 40;
    const creamBg: [number, number, number] = [253, 246, 227];
    const elementBg: [number, number, number] = [240, 235, 210];
    const unfocused = await createPng(W, H, (x, y) => {
      const isElement = x >= 8 && x < W - 8 && y >= 8 && y < H - 8;
      return isElement ? elementBg : creamBg;
    });
    const focused = await createPng(W, H, (x, y) => {
      const inOuter = x >= 2 && x < W - 2 && y >= 2 && y < H - 2;
      const inInner = x >= 5 && x < W - 5 && y >= 5 && y < H - 5;
      const inElement = x >= 8 && x < W - 8 && y >= 8 && y < H - 8;
      if (inElement) return elementBg;          // unchanged interior
      if (inInner) return [255, 255, 255];       // white inner ring
      if (inOuter) return [0, 0, 0];             // black outer ring
      return creamBg;                            // unchanged cream bg
    });
    const r = await compareScreenshots(unfocused, focused);
    expect(r.diffPercent).toBeGreaterThan(0.5);
    expect(r.perimeterContrast).toBeGreaterThan(3.0);
    expect(r.hasFillChange).toBe(false);
  });

  it("fill-based focus state (dark fill on light bg): hasFillChange=true", async () => {
    const W = 60, H = 40;
    const unfocused = await createPng(W, H, (x, y) => {
      const isElement = x >= 8 && x < W - 8 && y >= 8 && y < H - 8;
      return isElement ? [232, 224, 240] : [255, 255, 255];
    });
    const focused = await createPng(W, H, (x, y) => {
      const isElement = x >= 8 && x < W - 8 && y >= 8 && y < H - 8;
      return isElement ? [26, 26, 26] : [255, 255, 255]; // dark fill on focus
    });
    const r = await compareScreenshots(unfocused, focused);
    expect(r.hasFillChange).toBe(true);
    expect(r.diffPercent).toBeGreaterThan(0.5);
  });

  it("white-fill + black border on focus: perimeterContrast > 3.0 and hasFillChange=true", async () => {
    const W = 60, H = 40;
    const unfocused = await createPng(W, H, (x, y) => {
      const isElement = x >= 8 && x < W - 8 && y >= 8 && y < H - 8;
      return isElement ? [232, 224, 240] : [255, 255, 255]; // light purple element
    });
    const focused = await createPng(W, H, (x, y) => {
      const inElement = x >= 8 && x < W - 8 && y >= 8 && y < H - 8;
      const inInner = x >= 11 && x < W - 11 && y >= 11 && y < H - 11;
      if (!inElement) return [255, 255, 255]; // unchanged bg
      if (!inInner) return [0, 0, 0];         // black 3px border
      return [255, 255, 255];                 // white fill
    });
    const r = await compareScreenshots(unfocused, focused);
    expect(r.perimeterContrast).toBeGreaterThan(3.0);
    expect(r.hasFillChange).toBe(true);
  });

  it("thick black solid outline (3px): perimeterContrast > 3.0", async () => {
    const W = 60, H = 40;
    const unfocused = await createPng(W, H, () => [255, 255, 255]);
    const focused = await createPng(W, H, (x, y) => {
      const inBorder = x >= 2 && x < W - 2 && y >= 2 && y < H - 2
                    && !(x >= 5 && x < W - 5 && y >= 5 && y < H - 5);
      return inBorder ? [0, 0, 0] : [255, 255, 255];
    });
    const r = await compareScreenshots(unfocused, focused);
    expect(r.perimeterContrast).toBeGreaterThan(3.0);
    expect(r.hasFillChange).toBe(false);
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
        // New composite metrics should always be present
        expect(typeof r.focusMetrics.perimeterContrast).toBe("number");
        expect(typeof r.focusMetrics.hasFillChange).toBe("boolean");
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

  // -------------------------------------------------------------------------
  // False-positive regression tests
  //
  // Each of these patterns was previously flagged as a violation because the
  // old algorithm averaged all changed pixels into a single "focus indicator
  // color", which produced low contrast for multi-ring or fill-based states.
  // The new perimeter-contrast algorithm should pass all of them.
  // -------------------------------------------------------------------------

  it("does NOT flag multi-ring (black outer + white inner) nav links on cream background", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(`
        <!DOCTYPE html>
        <html lang="en"><head><title>Multi-ring</title>
        <style>
          body { background: #fdf6e3; margin: 20px; }
          a { color: #007b7b; padding: 6px 12px; display: inline-block;
              text-decoration: none; font-weight: 600; outline: none; }
          a:focus {
            outline: 3px solid #000000;
            outline-offset: 2px;
            box-shadow: 0 0 0 5px #ffffff;
          }
        </style></head>
        <body>
          <a href="/home" id="nav-home">Home</a>
          <a href="/about" id="nav-about">About</a>
        </body></html>
      `);

      const tabSeq = await recordTabSequence(page, { maxTabs: 10 });
      await page.evaluate(() => document.body.focus());
      const results = await runFocusVisibleChecks(page, tabSeq);

      const flagged = results.filter(
        (r) => r.element_selector.includes("nav-home") ||
               r.element_selector.includes("nav-about"),
      );
      expect(flagged).toHaveLength(0);
    } finally {
      await page.close();
    }
  });

  it("does NOT flag CTA pill buttons with thick black focus ring", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(`
        <!DOCTYPE html>
        <html lang="en"><head><title>CTA Pill</title>
        <style>
          button {
            background: #1a73e8; color: #fff; border: none;
            border-radius: 999px; padding: 12px 28px; font-size: 16px;
            cursor: pointer; outline: none;
          }
          button:focus {
            outline: 4px solid #000000;
            outline-offset: 3px;
          }
        </style></head>
        <body>
          <button id="pay-bill">Pay Bill</button>
          <button id="search-docket">Search Court Docket</button>
        </body></html>
      `);

      const tabSeq = await recordTabSequence(page, { maxTabs: 10 });
      await page.evaluate(() => document.body.focus());
      const results = await runFocusVisibleChecks(page, tabSeq);

      const flagged = results.filter(
        (r) => r.element_selector.includes("pay-bill") ||
               r.element_selector.includes("search-docket"),
      );
      expect(flagged).toHaveLength(0);
    } finally {
      await page.close();
    }
  });

  it("does NOT flag TOC links with visible black boxed focus state", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(`
        <!DOCTYPE html>
        <html lang="en"><head><title>TOC</title>
        <style>
          a { display: block; color: #2c5f8a; text-decoration: none;
              padding: 4px 8px; outline: none; }
          a:focus { outline: 2px solid #000000; outline-offset: 1px; }
        </style></head>
        <body>
          <nav>
            <a href="#s1" id="toc-1">Section 1</a>
            <a href="#s2" id="toc-2">Section 2</a>
          </nav>
        </body></html>
      `);

      const tabSeq = await recordTabSequence(page, { maxTabs: 10 });
      await page.evaluate(() => document.body.focus());
      const results = await runFocusVisibleChecks(page, tabSeq);

      // TOC links with 2px black outline should not be flagged
      const flagged = results.filter(
        (r) => r.element_selector.includes("toc-"),
      );
      expect(flagged).toHaveLength(0);
    } finally {
      await page.close();
    }
  });

  it("does NOT flag tab links with fill/background inversion on focus", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(`
        <!DOCTYPE html>
        <html lang="en"><head><title>Tab fill</title>
        <style>
          a { display: inline-block; color: #333; text-decoration: none;
              padding: 8px 16px; border: 2px solid #ccc; margin-right: 4px;
              background: #fff; outline: none; }
          a:focus { background: #1a1a1a; color: #fff; border-color: #000; }
        </style></head>
        <body>
          <a href="/forms" id="tab-forms">Court Forms</a>
          <a href="/faq" id="tab-faq">FAQ</a>
        </body></html>
      `);

      const tabSeq = await recordTabSequence(page, { maxTabs: 10 });
      await page.evaluate(() => document.body.focus());
      const results = await runFocusVisibleChecks(page, tabSeq);

      const flagged = results.filter(
        (r) => r.element_selector.includes("tab-forms") ||
               r.element_selector.includes("tab-faq"),
      );
      expect(flagged).toHaveLength(0);
    } finally {
      await page.close();
    }
  });

  it("does NOT flag white-fill focus box with black border", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(`
        <!DOCTYPE html>
        <html lang="en"><head><title>White fill</title>
        <style>
          button { background: #e8e0f0; color: #333; border: 2px solid #b0a0c8;
                   padding: 10px 20px; cursor: pointer; outline: none; font-size: 15px; }
          button:focus { background: #ffffff; border: 3px solid #000000; }
        </style></head>
        <body>
          <button id="search-btn">Search</button>
        </body></html>
      `);

      const tabSeq = await recordTabSequence(page, { maxTabs: 10 });
      await page.evaluate(() => document.body.focus());
      const results = await runFocusVisibleChecks(page, tabSeq);

      const flagged = results.filter((r) => r.element_selector.includes("search-btn"));
      expect(flagged).toHaveLength(0);
    } finally {
      await page.close();
    }
  });

  it("DOES flag elements with outline:none (regression guard)", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(`
        <!DOCTYPE html>
        <html lang="en"><head><title>No outline</title>
        <style>
          button { padding: 8px 16px; outline: none; }
          button:focus { outline: none; }
        </style></head>
        <body>
          <button id="no-outline-btn">No Outline</button>
        </body></html>
      `);

      const tabSeq = await recordTabSequence(page, { maxTabs: 10 });
      await page.evaluate(() => document.body.focus());
      const results = await runFocusVisibleChecks(page, tabSeq);

      const flagged = results.find((r) => r.element_selector.includes("no-outline-btn"));
      expect(flagged).toBeDefined();
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
        // New composite metrics should appear in measured_values
        expect(typeof measured.perimeter_contrast).toBe("number");
        expect(typeof measured.has_fill_change).toBe("boolean");
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

  it("new pattern elements in fixture do not produce violations", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(fixtureHtml);
      const tabSeq = await recordTabSequence(page, { maxTabs: 50 });
      await page.evaluate(() => document.body.focus());

      const results = await runFocusVisibleChecks(page, tabSeq);
      const flaggedSelectors = results.map((r) => r.element_selector);

      // None of the clearly-visible new patterns should be flagged
      const falsePositiveIds = [
        "nav-teal-home", "nav-teal-about", "nav-teal-contact",
        "btn-pay-bill", "btn-search-docket",
        "toc-link-1", "toc-link-2", "toc-link-3",
        "tab-link-forms", "tab-link-faq", "tab-link-calendar",
        "btn-search",
      ];

      for (const id of falsePositiveIds) {
        const hit = flaggedSelectors.some((s) => s.includes(id));
        expect(hit, `Expected ${id} not to be flagged as a focus violation`).toBe(false);
      }
    } finally {
      await page.close();
    }
  });
});
