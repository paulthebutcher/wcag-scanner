import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  detectKeyboardTraps,
  runTrapChecks,
  type KeyboardTrap,
} from "../../src/checks/behavioral/keyboard.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const trapFixturePath = join(import.meta.dirname, "..", "fixtures", "keyboard-trap-test.html");
const trapFixtureHtml = readFileSync(trapFixturePath, "utf-8");

// ---------------------------------------------------------------------------
// Keyboard trap detection tests (C2-02)
// ---------------------------------------------------------------------------

describe("detectKeyboardTraps", () => {
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("detects traps in custom widgets that cycle focus", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(trapFixtureHtml);

      const result = await detectKeyboardTraps(page, {
        targetSelectors: ["#trapped-widget"],
      });

      expect(result.traps.length).toBe(1);

      const trap = result.traps[0];
      expect(trap.elementsInCycle.length).toBeGreaterThanOrEqual(1);
      expect(trap.containerSelector).toBe("#trapped-widget");
      expect(trap.trapContext).toBe("custom_widget");
      expect(trap.tabsBeforeDetected).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });

  it("detects traps in dropdown menus", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(trapFixtureHtml);

      const result = await detectKeyboardTraps(page, {
        targetSelectors: ["#trapped-dropdown"],
      });

      expect(result.traps.length).toBe(1);

      const trap = result.traps[0];
      expect(trap.elementsInCycle.length).toBeGreaterThanOrEqual(1);
      expect(trap.containerSelector).toBe("#trapped-dropdown");
      expect(trap.trapContext).toBe("dropdown");
    } finally {
      await page.close();
    }
  });

  it("records elements in the cycle and tabs before detection", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(trapFixtureHtml);

      const result = await detectKeyboardTraps(page, {
        targetSelectors: ["#trapped-widget"],
      });

      const trap = result.traps[0];
      // Should record the elements involved in the cycle
      for (const el of trap.elementsInCycle) {
        expect(el.selector).toBeTruthy();
        expect(el.tagName).toBeTruthy();
      }
      // Should have taken some tabs to detect the trap
      expect(trap.tabsBeforeDetected).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });

  it("does NOT flag modal dialogs with intentional focus trapping", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(trapFixtureHtml);

      // The modal has aria-modal="true" — should be excluded from candidates
      const result = await detectKeyboardTraps(page, {
        targetSelectors: ["#modal-dialog"],
      });

      // Modal dialog is display:none so it shouldn't trap (no tabbable children)
      expect(result.traps.length).toBe(0);
    } finally {
      await page.close();
    }
  });

  it("does NOT flag widgets that allow Tab to escape", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(trapFixtureHtml);

      const result = await detectKeyboardTraps(page, {
        targetSelectors: ["#safe-widget"],
      });

      expect(result.traps.length).toBe(0);
    } finally {
      await page.close();
    }
  });

  it("auto-detects trap candidates when no selectors provided", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(trapFixtureHtml);

      const result = await detectKeyboardTraps(page);

      // Should find traps in the auto-detected candidates
      // The trapped-widget and trapped-dropdown should be detected
      expect(result.traps.length).toBeGreaterThanOrEqual(1);
    } finally {
      await page.close();
    }
  });

  it("detects iframes as candidates for trapping", async () => {
    const page = await context.newPage();
    try {
      // Create a page with an iframe that could trap focus
      await page.setContent(`
        <!DOCTYPE html>
        <html lang="en"><head><title>Iframe Test</title></head>
        <body>
          <button id="before">Before</button>
          <iframe id="test-iframe" src="about:blank" width="200" height="100"></iframe>
          <button id="after">After</button>
        </body></html>
      `);

      const result = await detectKeyboardTraps(page, {
        targetSelectors: ["#test-iframe"],
      });

      // about:blank iframe should not trap (no tabbable content)
      // But the detection should run without errors
      expect(result.totalTabs).toBeGreaterThanOrEqual(0);
    } finally {
      await page.close();
    }
  });

  it("returns totalTabs count for all tests performed", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(trapFixtureHtml);

      const result = await detectKeyboardTraps(page, {
        targetSelectors: ["#trapped-widget", "#safe-widget"],
      });

      expect(result.totalTabs).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });
});

// ---------------------------------------------------------------------------
// runTrapChecks — CheckResult generation (C2-02)
// ---------------------------------------------------------------------------

describe("runTrapChecks", () => {
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("produces CheckResult per detected trap with criterion 2.1.2", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(trapFixtureHtml);

      const results = await runTrapChecks(page, {
        targetSelectors: ["#trapped-widget"],
      });

      expect(results.length).toBe(1);

      const result = results[0];
      expect(result.wcag_criterion).toBe("2.1.2");
      expect(result.detected_by).toBe("playwright");
      expect(result.element_selector).toBeTruthy();

      const raw = result.raw_result as Record<string, unknown>;
      expect(raw.type).toBe("keyboard_trap");
      expect(raw.trapContext).toBe("custom_widget");
      expect(raw.elementsInCycle).toBeTruthy();
      expect(raw.tabsBeforeDetected).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });

  it("includes measured_values with trap details", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(trapFixtureHtml);

      const results = await runTrapChecks(page, {
        targetSelectors: ["#trapped-widget"],
      });

      const measured = results[0].measured_values as Record<string, unknown>;
      expect(measured.elements_in_cycle).toBeGreaterThanOrEqual(1);
      expect(measured.tabs_before_detected).toBeGreaterThan(0);
      expect(measured.trap_context).toBe("custom_widget");
    } finally {
      await page.close();
    }
  });

  it("produces no results for pages without traps", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(`
        <!DOCTYPE html>
        <html lang="en"><head><title>No Traps</title></head>
        <body>
          <a href="/">Home</a>
          <button>Click me</button>
          <input type="text" placeholder="Name">
        </body></html>
      `);

      const results = await runTrapChecks(page);
      expect(results).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
