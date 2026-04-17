import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  recordTabSequence,
  runKeyboardChecks,
  type FocusStop,
  type TabSequenceResult,
} from "../../src/checks/behavioral/keyboard.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const fixturePath = join(import.meta.dirname, "..", "fixtures", "keyboard-test.html");
const fixtureHtml = readFileSync(fixturePath, "utf-8");

const autofocusFixturePath = join(import.meta.dirname, "..", "fixtures", "keyboard-autofocus-test.html");
const autofocusFixtureHtml = readFileSync(autofocusFixturePath, "utf-8");

// ---------------------------------------------------------------------------
// Tab sequence recording tests (C2-01)
// ---------------------------------------------------------------------------

describe("recordTabSequence", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
  });

  afterAll(async () => {
    await browser.close();
  });

  async function loadFixturePage(): Promise<Page> {
    const p = await context.newPage();
    await p.setContent(fixtureHtml);
    return p;
  }

  it("records focused elements at each tab stop", async () => {
    page = await loadFixturePage();
    try {
      const result = await recordTabSequence(page, { maxTabs: 50 });

      expect(result.focusStops.length).toBeGreaterThan(0);

      // Each stop should have the required fields
      for (const stop of result.focusStops) {
        expect(stop.selector).toBeTruthy();
        expect(stop.tagName).toBeTruthy();
        expect(typeof stop.sequenceIndex).toBe("number");
        expect(stop.outerHtml).toBeTruthy();
      }
    } finally {
      await page.close();
    }
  });

  it("records tag name, role, and bounding box at each stop", async () => {
    page = await loadFixturePage();
    try {
      const result = await recordTabSequence(page, { maxTabs: 50 });

      // Should find links, buttons, inputs
      const tagNames = result.focusStops.map((s) => s.tagName);
      expect(tagNames).toContain("a");
      expect(tagNames).toContain("button");
      expect(tagNames).toContain("input");

      // At least some elements should have bounding boxes
      const withBox = result.focusStops.filter((s) => s.boundingBox !== null);
      expect(withBox.length).toBeGreaterThan(0);

      for (const stop of withBox) {
        expect(stop.boundingBox!.x).toBeGreaterThanOrEqual(0);
        expect(stop.boundingBox!.y).toBeGreaterThanOrEqual(0);
        expect(stop.boundingBox!.width).toBeGreaterThan(0);
        expect(stop.boundingBox!.height).toBeGreaterThan(0);
      }
    } finally {
      await page.close();
    }
  });

  it("records tab index for elements with explicit tabindex", async () => {
    page = await context.newPage();
    try {
      await page.setContent(`
        <!DOCTYPE html>
        <html lang="en"><head><title>TabIndex Test</title></head>
        <body>
          <button tabindex="5">First</button>
          <button>No tabindex</button>
          <button tabindex="0">Explicit zero</button>
        </body></html>
      `);

      const result = await recordTabSequence(page, { maxTabs: 20 });

      // The button with tabindex=5 should have tabIndex recorded
      const withTabIndex = result.focusStops.filter((s) => s.tabIndex !== null);
      expect(withTabIndex.length).toBeGreaterThan(0);

      const tab5 = result.focusStops.find((s) => s.tabIndex === 5);
      expect(tab5).toBeDefined();
    } finally {
      await page.close();
    }
  });

  it("records sequence as ordered array with correct indices", async () => {
    page = await loadFixturePage();
    try {
      const result = await recordTabSequence(page, { maxTabs: 50 });

      for (let i = 0; i < result.focusStops.length; i++) {
        expect(result.focusStops[i].sequenceIndex).toBe(i);
      }
    } finally {
      await page.close();
    }
  });

  it("detects cycle when same element focused twice", async () => {
    page = await loadFixturePage();
    try {
      // With enough tabs, the browser will cycle back
      const result = await recordTabSequence(page, { maxTabs: 200 });

      // Should end by cycle on a normal page
      expect(result.endedByCycle).toBe(true);
      expect(result.endedByMax).toBe(false);
    } finally {
      await page.close();
    }
  });

  it("stops at maxTabs limit", async () => {
    page = await context.newPage();
    try {
      // Create page with many tabbable elements
      const buttons = Array.from({ length: 100 }, (_, i) =>
        `<button id="btn-${i}">Button ${i}</button>`
      ).join("\n");
      await page.setContent(`
        <!DOCTYPE html>
        <html lang="en"><head><title>Many Buttons</title></head>
        <body>${buttons}</body></html>
      `);

      const result = await recordTabSequence(page, { maxTabs: 10 });

      expect(result.totalTabs).toBe(10);
      expect(result.endedByMax).toBe(true);
      expect(result.endedByCycle).toBe(false);
    } finally {
      await page.close();
    }
  });

  it("detects interactive elements NOT reached by tabbing", async () => {
    page = await loadFixturePage();
    try {
      const result = await recordTabSequence(page, { maxTabs: 200 });

      // The fixture has div[role="button"] and span[role="link"] without tabindex
      expect(result.unreachableElements.length).toBeGreaterThan(0);

      // Should find the fake button (role="button" without tabindex)
      const fakeButton = result.unreachableElements.find(
        (e) => e.role === "button" && e.tagName === "div",
      );
      expect(fakeButton).toBeDefined();
      expect(fakeButton!.outerHtml).toContain("Click Me");

      // Should find the fake link (role="link" without href/tabindex)
      const fakeLink = result.unreachableElements.find(
        (e) => e.role === "link" && e.tagName === "span",
      );
      expect(fakeLink).toBeDefined();
    } finally {
      await page.close();
    }
  });

  it("does NOT flag hidden or disabled elements as unreachable", async () => {
    page = await loadFixturePage();
    try {
      const result = await recordTabSequence(page, { maxTabs: 200 });

      // Hidden buttons, invisible elements, disabled inputs should NOT appear
      for (const el of result.unreachableElements) {
        expect(el.outerHtml).not.toContain("Hidden Button");
        expect(el.outerHtml).not.toContain("Invisible Button");
        expect(el.outerHtml).not.toContain("Disabled input");
        expect(el.outerHtml).not.toContain("Hidden Link");
      }
    } finally {
      await page.close();
    }
  });

  it("does NOT flag tabindex=-1 elements as unreachable", async () => {
    page = await loadFixturePage();
    try {
      const result = await recordTabSequence(page, { maxTabs: 200 });

      for (const el of result.unreachableElements) {
        expect(el.outerHtml).not.toContain("Removed from tab order");
      }
    } finally {
      await page.close();
    }
  });

  // ---------------------------------------------------------------------------
  // Ancestor-walk regression tests: the browser's tab order skips descendants
  // of hidden / aria-hidden / inert / disabled-fieldset ancestors. The
  // scanner's expected-reachable set must mirror this.
  // ---------------------------------------------------------------------------

  it("does NOT flag descendants of display:none ancestor as unreachable", async () => {
    page = await loadFixturePage();
    try {
      const result = await recordTabSequence(page, { maxTabs: 200 });

      for (const el of result.unreachableElements) {
        expect(el.outerHtml).not.toContain("Link in display-none wrapper");
        expect(el.outerHtml).not.toContain("Button in display-none wrapper");
      }
    } finally {
      await page.close();
    }
  });

  it('does NOT flag descendants of aria-hidden="true" ancestor', async () => {
    page = await loadFixturePage();
    try {
      const result = await recordTabSequence(page, { maxTabs: 200 });

      for (const el of result.unreachableElements) {
        expect(el.outerHtml).not.toContain("Link in aria-hidden wrapper");
        expect(el.outerHtml).not.toContain("Button in aria-hidden wrapper");
      }
    } finally {
      await page.close();
    }
  });

  it("does NOT flag descendants of an inert ancestor", async () => {
    page = await loadFixturePage();
    try {
      const result = await recordTabSequence(page, { maxTabs: 200 });

      for (const el of result.unreachableElements) {
        expect(el.outerHtml).not.toContain("Link in inert wrapper");
        expect(el.outerHtml).not.toContain("Button in inert wrapper");
      }
    } finally {
      await page.close();
    }
  });

  it("does NOT flag form controls inside <fieldset disabled>", async () => {
    page = await loadFixturePage();
    try {
      const result = await recordTabSequence(page, { maxTabs: 200 });

      for (const el of result.unreachableElements) {
        expect(el.outerHtml).not.toContain('id="f1"');
        expect(el.outerHtml).not.toContain("Submit fieldset");
      }
    } finally {
      await page.close();
    }
  });

  it("reaches elements that come before the autofocus anchor in document order", async () => {
    // Regression: Webflow password pages autofocus the password input.
    // Before the fix, recordTabSequence's first Tab advanced past the
    // autofocused element (browser anchor stayed on it), so the full tab
    // cycle was missed and elements before/including the autofocus target
    // were falsely flagged as unreachable.
    const p = await context.newPage();
    try {
      await p.setContent(autofocusFixtureHtml);

      const result = await recordTabSequence(p, { maxTabs: 50 });

      // All five tabbable elements must appear in the tab sequence
      const reachedIds = new Set(
        result.focusStops
          .map((s) => {
            const m = s.outerHtml.match(/id="([^"]+)"/);
            return m ? m[1] : null;
          })
          .filter((id): id is string => id !== null),
      );

      expect(reachedIds).toContain("top-link");
      expect(reachedIds).toContain("before-pass");
      expect(reachedIds).toContain("pass");         // autofocus target — must be reached
      expect(reachedIds).toContain("submit-btn");
      expect(reachedIds).toContain("bottom-link");

      // No element should end up in unreachableElements
      const unreachableIds = result.unreachableElements
        .map((e) => e.outerHtml.match(/id="([^"]+)"/)?.[1])
        .filter((id): id is string | undefined => id !== undefined);
      expect(unreachableIds).toEqual([]);

      // Should end by cycle detection (revisit), not by max-tabs
      expect(result.endedByCycle).toBe(true);
      expect(result.endedByMax).toBe(false);
    } finally {
      await p.close();
    }
  });

  it("does NOT flag Webflow-style hidden mobile nav at desktop viewport", async () => {
    page = await loadFixturePage();
    try {
      // Default viewport is desktop; mobile wrapper is display:none.
      const result = await recordTabSequence(page, { maxTabs: 200 });

      for (const el of result.unreachableElements) {
        expect(el.outerHtml).not.toContain("Mobile Home");
        expect(el.outerHtml).not.toContain("Mobile About");
        expect(el.outerHtml).not.toContain("Menu trigger");
      }

      // Desktop nav links ARE reachable
      const reachedHtml = result.focusStops.map((s) => s.outerHtml).join(" ");
      expect(reachedHtml).toContain("Desktop Home");
      expect(reachedHtml).toContain("Desktop About");
    } finally {
      await page.close();
    }
  });
});

// ---------------------------------------------------------------------------
// runKeyboardChecks — CheckResult generation (C2-01)
// ---------------------------------------------------------------------------

describe("runKeyboardChecks", () => {
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("produces CheckResult for each unreachable interactive element", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(fixtureHtml);

      const { results } = await runKeyboardChecks(page, { maxTabs: 200 });

      // Should have results for unreachable elements
      expect(results.length).toBeGreaterThan(0);

      for (const result of results) {
        expect(result.wcag_criterion).toBe("2.1.1");
        expect(result.detected_by).toBe("playwright");
        expect(result.element_selector).toBeTruthy();
        expect(result.element_html).toBeTruthy();
        expect(result.raw_result).toBeTruthy();
        expect((result.raw_result as Record<string, unknown>).type).toBe(
          "unreachable_interactive_element",
        );
      }
    } finally {
      await page.close();
    }
  });

  it("returns tab sequence alongside results", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(fixtureHtml);

      const { results, tabSequence } = await runKeyboardChecks(page, { maxTabs: 200 });

      expect(tabSequence.focusStops.length).toBeGreaterThan(0);
      expect(tabSequence.totalTabs).toBeGreaterThan(0);

      // Results should have measured_values with tab sequence info
      if (results.length > 0) {
        const measured = results[0].measured_values as Record<string, unknown>;
        expect(measured.tab_sequence_length).toBe(tabSequence.focusStops.length);
        expect(measured.total_tabs).toBe(tabSequence.totalTabs);
      }
    } finally {
      await page.close();
    }
  });

  it("produces no results for a fully accessible page", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(`
        <!DOCTYPE html>
        <html lang="en"><head><title>Accessible Page</title></head>
        <body>
          <a href="/">Home</a>
          <button>Click me</button>
          <input type="text" placeholder="Name">
        </body></html>
      `);

      const { results } = await runKeyboardChecks(page, { maxTabs: 50 });
      expect(results).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
