import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findModalTriggers,
  testModal,
  runModalChecks,
  type ModalTrigger,
} from "../../src/checks/behavioral/modal.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const modalFixturePath = join(import.meta.dirname, "..", "fixtures", "modal-test.html");
const modalFixtureHtml = readFileSync(modalFixturePath, "utf-8");

// ---------------------------------------------------------------------------
// Modal trigger detection tests
// ---------------------------------------------------------------------------

describe("findModalTriggers", () => {
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("finds aria-haspopup triggers", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(modalFixtureHtml);
      const triggers = await findModalTriggers(page);

      const ariaTriggers = triggers.filter((t) => t.type === "aria_haspopup");
      expect(ariaTriggers.length).toBeGreaterThanOrEqual(2); // good-trigger + bad-trigger
    } finally {
      await page.close();
    }
  });

  it("finds IX2 modal triggers with data-w-id", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(modalFixtureHtml);
      const triggers = await findModalTriggers(page);

      const ix2Triggers = triggers.filter(
        (t) => t.outerHtml.includes("data-w-id") && t.outerHtml.includes("data-modal-trigger"),
      );
      expect(ix2Triggers.length).toBeGreaterThanOrEqual(1);
    } finally {
      await page.close();
    }
  });

  it("captures target selector from aria-controls", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(modalFixtureHtml);
      const triggers = await findModalTriggers(page);

      const goodTrigger = triggers.find((t) => t.outerHtml.includes("good-trigger"));
      expect(goodTrigger).toBeDefined();
      expect(goodTrigger!.targetSelector).toBe("#good-modal");
    } finally {
      await page.close();
    }
  });

  it("returns empty array for pages with no modal triggers", async () => {
    const page = await context.newPage();
    try {
      await page.setContent("<html><body><p>No modals here</p></body></html>");
      const triggers = await findModalTriggers(page);
      expect(triggers).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it("skips hidden triggers", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(`
        <html><body>
          <button aria-haspopup="dialog" style="display:none">Hidden</button>
          <button aria-haspopup="dialog" id="visible-btn">Visible</button>
        </body></html>
      `);
      const triggers = await findModalTriggers(page);
      expect(triggers.length).toBe(1);
      expect(triggers[0].outerHtml).toContain("visible-btn");
    } finally {
      await page.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Modal testing - good modal (proper focus management)
// ---------------------------------------------------------------------------

describe("testModal — good modal", () => {
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("reports no failures for a well-implemented modal", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(modalFixtureHtml);

      const trigger: ModalTrigger = {
        selector: "#good-trigger",
        type: "aria_haspopup",
        outerHtml: '<button id="good-trigger" aria-haspopup="dialog">Open Good Modal</button>',
        targetSelector: "#good-modal",
      };

      const result = await testModal(page, trigger);

      expect(result.opened).toBe(true);
      expect(result.focusMovedIn).toBe(true);
      expect(result.focusTrapped).toBe(true);
      expect(result.escapeCloses).toBe(true);
      expect(result.focusReturnedToTrigger).toBe(true);
      expect(result.failures).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it("captures InteractionState for opened modals", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(modalFixtureHtml);

      const trigger: ModalTrigger = {
        selector: "#good-trigger",
        type: "aria_haspopup",
        outerHtml: '<button id="good-trigger">Open</button>',
        targetSelector: "#good-modal",
      };

      const result = await testModal(page, trigger);

      expect(result.interactionState).not.toBeNull();
      expect(result.interactionState!.trigger.type).toBe("click");
      expect(result.interactionState!.trigger.target).toBe("#good-trigger");
      expect(result.interactionState!.id).toBeTruthy();
    } finally {
      await page.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Modal testing - bad modal (no focus management)
// ---------------------------------------------------------------------------

describe("testModal — bad modal", () => {
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("reports focus_not_moved for modal without focus management", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(modalFixtureHtml);

      const trigger: ModalTrigger = {
        selector: "#bad-trigger",
        type: "aria_haspopup",
        outerHtml: '<button id="bad-trigger" aria-haspopup="dialog">Open Bad Modal</button>',
        targetSelector: "#bad-modal",
      };

      const result = await testModal(page, trigger);

      expect(result.opened).toBe(true);
      expect(result.focusMovedIn).toBe(false);

      const focusFailure = result.failures.find((f) => f.type === "focus_not_moved");
      expect(focusFailure).toBeDefined();
      expect(focusFailure!.criterion).toBe("2.4.3");
    } finally {
      await page.close();
    }
  });

  it("reports escape_not_close for modal without Escape handler", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(modalFixtureHtml);

      const trigger: ModalTrigger = {
        selector: "#bad-trigger",
        type: "aria_haspopup",
        outerHtml: '<button id="bad-trigger">Open Bad Modal</button>',
        targetSelector: "#bad-modal",
      };

      const result = await testModal(page, trigger);

      expect(result.opened).toBe(true);
      expect(result.escapeCloses).toBe(false);

      const escapeFailure = result.failures.find((f) => f.type === "escape_not_close");
      expect(escapeFailure).toBeDefined();
      expect(escapeFailure!.criterion).toBe("2.1.2");
    } finally {
      await page.close();
    }
  });
});

// ---------------------------------------------------------------------------
// IX2 modal testing
// ---------------------------------------------------------------------------

describe("testModal — IX2 modal", () => {
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("tests IX2-style modal with proper focus management", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(modalFixtureHtml);

      const trigger: ModalTrigger = {
        selector: "#ix2-trigger",
        type: "ix2_trigger",
        outerHtml: '<button id="ix2-trigger" data-w-id="abc-123-ix2">Open IX2 Modal</button>',
        targetSelector: null,
      };

      const result = await testModal(page, trigger);

      expect(result.opened).toBe(true);
      expect(result.focusMovedIn).toBe(true);
      expect(result.escapeCloses).toBe(true);
      expect(result.failures).toEqual([]);
    } finally {
      await page.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Native dialog testing
// ---------------------------------------------------------------------------

describe("testModal — native dialog", () => {
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("tests native dialog with showModal() focus management", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(modalFixtureHtml);

      // Click trigger to open native dialog
      await page.click("#dialog-trigger");
      await page.waitForTimeout(200);

      // Verify dialog is open
      const isOpen = await page.evaluate(() => {
        const dialog = document.getElementById("native-dialog") as HTMLDialogElement;
        return dialog.open;
      });
      expect(isOpen).toBe(true);

      // Native dialog traps focus natively
      // Press Escape to close
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);

      const isClosedAfterEscape = await page.evaluate(() => {
        const dialog = document.getElementById("native-dialog") as HTMLDialogElement;
        return !dialog.open;
      });
      expect(isClosedAfterEscape).toBe(true);
    } finally {
      await page.close();
    }
  });
});

// ---------------------------------------------------------------------------
// runModalChecks integration
// ---------------------------------------------------------------------------

describe("runModalChecks", () => {
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("produces CheckResults for modal failures", { timeout: 30000 }, async () => {
    const page = await context.newPage();
    try {
      await page.setContent(modalFixtureHtml);

      const { results, interactionStates } = await runModalChecks(page);

      // Should have failures from the bad modal at minimum
      expect(results.length).toBeGreaterThanOrEqual(1);

      // All results should be detected by playwright
      for (const r of results) {
        expect(r.detected_by).toBe("playwright");
      }

      // Should have WCAG criteria 2.4.3 or 2.1.2
      const criteria = new Set(results.map((r) => r.wcag_criterion));
      expect(
        criteria.has("2.4.3") || criteria.has("2.1.2"),
      ).toBe(true);

      // Should have interaction states for opened modals
      expect(interactionStates.length).toBeGreaterThanOrEqual(1);
    } finally {
      await page.close();
    }
  });

  it("includes measured_values in CheckResults", { timeout: 30000 }, async () => {
    const page = await context.newPage();
    try {
      await page.setContent(modalFixtureHtml);

      const { results } = await runModalChecks(page);

      for (const r of results) {
        expect(r.measured_values).toBeDefined();
        expect(r.measured_values!.trigger_type).toBeDefined();
        expect(typeof r.measured_values!.modal_opened).toBe("boolean");
      }
    } finally {
      await page.close();
    }
  });

  it("includes raw_result with failure details", { timeout: 30000 }, async () => {
    const page = await context.newPage();
    try {
      await page.setContent(modalFixtureHtml);

      const { results } = await runModalChecks(page);

      for (const r of results) {
        expect(r.raw_result.type).toMatch(/^modal_/);
        expect(r.raw_result.triggerSelector).toBeDefined();
        expect(r.raw_result.failureDescription).toBeDefined();
      }
    } finally {
      await page.close();
    }
  });

  it("returns empty results for page with no modals", { timeout: 30000 }, async () => {
    const page = await context.newPage();
    try {
      await page.setContent("<html><body><p>Plain page</p></body></html>");

      const { results, interactionStates } = await runModalChecks(page);

      expect(results).toEqual([]);
      expect(interactionStates).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it("interaction states have correct trigger info", { timeout: 30000 }, async () => {
    const page = await context.newPage();
    try {
      await page.setContent(modalFixtureHtml);

      const { interactionStates } = await runModalChecks(page);

      for (const state of interactionStates) {
        expect(state.trigger.type).toBe("click");
        expect(state.trigger.target).toBeTruthy();
        expect(state.id).toBeTruthy();
        expect(state.new_elements_visible).toBeDefined();
      }
    } finally {
      await page.close();
    }
  });
});
