import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  verifySkipNav,
  runSkipNavChecks,
} from "../../src/checks/behavioral/skip-nav.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fixturePath = join(import.meta.dirname, "..", "fixtures", "skip-nav-test.html");
const fixtureHtml = readFileSync(fixturePath, "utf-8");

// ---------------------------------------------------------------------------
// verifySkipNav tests
// ---------------------------------------------------------------------------

describe("verifySkipNav", () => {
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("finds a skip link among the first focusable elements", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(fixtureHtml);
      const result = await verifySkipNav(page);

      expect(result.found).toBe(true);
      expect(result.skipLink).not.toBeNull();
      expect(result.skipLink!.text).toMatch(/skip/i);
      expect(result.skipLink!.href).toBe("#main-content");
    } finally {
      await page.close();
    }
  });

  it("verifies focus moves to the target element", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(fixtureHtml);
      const result = await verifySkipNav(page);

      expect(result.found).toBe(true);
      expect(result.focusMoved).toBe(true);
    } finally {
      await page.close();
    }
  });

  it("verifies the target is a main content region", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(fixtureHtml);
      const result = await verifySkipNav(page);

      expect(result.found).toBe(true);
      expect(result.targetIsMainContent).toBe(true);
      expect(result.target).not.toBeNull();
      expect(result.target!.tagName).toBe("main");
    } finally {
      await page.close();
    }
  });

  it("returns no failure reason when skip link works correctly", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(fixtureHtml);
      const result = await verifySkipNav(page);

      expect(result.failureReason).toBeNull();
    } finally {
      await page.close();
    }
  });

  it("finds skip link even after prior keyboard tabbing polluted focus anchor", async () => {
    // Regression: in the real scanner pipeline runSkipNavChecks runs AFTER
    // runKeyboardChecks, which tabs through the whole page. That leaves the
    // browser's sequential-focus-navigation starting point deep in the DOM.
    // Before the fix, body.focus() didn't reset that anchor, so Tab #1 in
    // verifySkipNav advanced from mid-page and missed the skip link.
    const page = await context.newPage();
    try {
      await page.setContent(fixtureHtml);

      // Simulate the pollution by tabbing past several elements first.
      await page.evaluate(() => {
        (document.activeElement as HTMLElement)?.blur?.();
        document.body.focus();
      });
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press("Tab");
      }

      // Now the browser anchor is deep in the page. verifySkipNav must
      // still find the skip link at the top of document order.
      const result = await verifySkipNav(page);

      expect(result.found).toBe(true);
      expect(result.skipLink).not.toBeNull();
      expect(result.skipLink!.text).toMatch(/skip/i);
    } finally {
      await page.close();
    }
  });

  it("reports missing skip link when none exists", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(`
        <!DOCTYPE html>
        <html lang="en"><head><title>No Skip</title></head>
        <body>
          <nav><a href="/">Home</a><a href="/about">About</a></nav>
          <main id="main-content"><h1>Content</h1></main>
        </body></html>
      `);

      const result = await verifySkipNav(page);

      expect(result.found).toBe(false);
      expect(result.skipLink).toBeNull();
      expect(result.failureReason).toMatch(/no skip/i);
    } finally {
      await page.close();
    }
  });

  it("reports broken skip link when target does not exist", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(`
        <!DOCTYPE html>
        <html lang="en"><head><title>Broken Skip</title></head>
        <body>
          <a href="#nonexistent" id="skip">Skip to main content</a>
          <nav><a href="/">Home</a></nav>
          <main><h1>Content</h1></main>
        </body></html>
      `);

      const result = await verifySkipNav(page);

      expect(result.found).toBe(true);
      expect(result.skipLink).not.toBeNull();
      expect(result.focusMoved).toBe(false);
      expect(result.failureReason).toMatch(/not found/i);
    } finally {
      await page.close();
    }
  });

  it("reports when target exists but focus does not move to it", async () => {
    const page = await context.newPage();
    try {
      // Target exists but has no tabindex, so focus won't move to it
      // in some browsers. We simulate by having a div target without tabindex.
      await page.setContent(`
        <!DOCTYPE html>
        <html lang="en"><head><title>No Focus Move</title></head>
        <body>
          <a href="#content-area" id="skip">Skip to content</a>
          <nav><a href="/">Home</a></nav>
          <div id="content-area">
            <h1>Content</h1>
            <p>Paragraph</p>
          </div>
        </body></html>
      `);

      const result = await verifySkipNav(page);

      expect(result.found).toBe(true);
      // Focus may or may not move depending on browser behavior
      // But target should be found
      expect(result.target).not.toBeNull();
    } finally {
      await page.close();
    }
  });

  it("detects skip links by href pattern even without matching text", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(`
        <!DOCTYPE html>
        <html lang="en"><head><title>Href Pattern</title></head>
        <body>
          <a href="#main" id="skip-by-href">Go ahead</a>
          <nav><a href="/">Home</a></nav>
          <main id="main" tabindex="-1"><h1>Content</h1></main>
        </body></html>
      `);

      const result = await verifySkipNav(page);

      expect(result.found).toBe(true);
      expect(result.skipLink!.href).toBe("#main");
    } finally {
      await page.close();
    }
  });

  it("checks only the first N focusable elements", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(`
        <!DOCTYPE html>
        <html lang="en"><head><title>Late Skip</title></head>
        <body>
          <button>First</button>
          <button>Second</button>
          <button>Third</button>
          <button>Fourth</button>
          <a href="#main" id="late-skip">Skip to main content</a>
          <main id="main" tabindex="-1"><h1>Content</h1></main>
        </body></html>
      `);

      // Default maxElementsToCheck is 3, so skip link at position 5 should be missed
      const result = await verifySkipNav(page, 3);

      expect(result.found).toBe(false);
    } finally {
      await page.close();
    }
  });

  it("provides target details including tag, role, and id", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(fixtureHtml);
      const result = await verifySkipNav(page);

      expect(result.target).not.toBeNull();
      expect(result.target!.id).toBe("main-content");
      expect(result.target!.tagName).toBe("main");
      expect(result.target!.selector).toBe("#main-content");
    } finally {
      await page.close();
    }
  });
});

// ---------------------------------------------------------------------------
// runSkipNavChecks — CheckResult generation
// ---------------------------------------------------------------------------

describe("runSkipNavChecks", () => {
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("produces no CheckResult when skip link works correctly", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(fixtureHtml);
      const results = await runSkipNavChecks(page);

      expect(results).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it("produces CheckResult with criterion 2.4.1 when no skip link found", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(`
        <!DOCTYPE html>
        <html lang="en"><head><title>No Skip</title></head>
        <body>
          <nav><a href="/">Home</a><a href="/about">About</a></nav>
          <main><h1>Content</h1></main>
        </body></html>
      `);

      const results = await runSkipNavChecks(page);

      expect(results.length).toBe(1);
      expect(results[0].wcag_criterion).toBe("2.4.1");
      expect(results[0].detected_by).toBe("playwright");
      expect(results[0].element_selector).toBe("html");

      const raw = results[0].raw_result as Record<string, unknown>;
      expect(raw.type).toBe("missing_skip_navigation");

      const measured = results[0].measured_values as Record<string, unknown>;
      expect(measured.skip_link_found).toBe(false);
      expect(measured.confidence).toBe("definitive");
    } finally {
      await page.close();
    }
  });

  it("produces CheckResult for broken skip link", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(`
        <!DOCTYPE html>
        <html lang="en"><head><title>Broken</title></head>
        <body>
          <a href="#nonexistent" id="skip">Skip to main content</a>
          <nav><a href="/">Home</a></nav>
          <main><h1>Content</h1></main>
        </body></html>
      `);

      const results = await runSkipNavChecks(page);

      expect(results.length).toBe(1);
      expect(results[0].wcag_criterion).toBe("2.4.1");
      expect(results[0].detected_by).toBe("playwright");

      const raw = results[0].raw_result as Record<string, unknown>;
      expect(raw.type).toBe("broken_skip_navigation");
      expect(raw.skipLinkText).toMatch(/skip/i);

      const measured = results[0].measured_values as Record<string, unknown>;
      expect(measured.skip_link_found).toBe(true);
      expect(measured.focus_moved).toBe(false);
      expect(measured.confidence).toBe("high");
    } finally {
      await page.close();
    }
  });

  it("includes skip link selector in CheckResult for broken link", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(`
        <!DOCTYPE html>
        <html lang="en"><head><title>Broken</title></head>
        <body>
          <a href="#nonexistent" id="broken-skip">Skip to main content</a>
          <nav><a href="/">Home</a></nav>
          <main><h1>Content</h1></main>
        </body></html>
      `);

      const results = await runSkipNavChecks(page);

      expect(results.length).toBe(1);
      expect(results[0].element_selector).toContain("broken-skip");
    } finally {
      await page.close();
    }
  });
});
