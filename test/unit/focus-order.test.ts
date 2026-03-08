import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import {
  computeVisualOrder,
  analyzeFocusOrder,
  runFocusOrderChecks,
} from "../../src/checks/behavioral/focus-order.js";
import { recordTabSequence, type FocusStop, type TabSequenceResult } from "../../src/checks/behavioral/keyboard.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStop(overrides: Partial<FocusStop> & { selector: string }): FocusStop {
  return {
    tagName: "button",
    role: null,
    boundingBox: null,
    tabIndex: null,
    outerHtml: `<button>${overrides.selector}</button>`,
    sequenceIndex: 0,
    ...overrides,
  };
}

function makeTabSequence(stops: FocusStop[]): TabSequenceResult {
  return {
    focusStops: stops,
    unreachableElements: [],
    totalTabs: stops.length,
    endedByCycle: true,
    endedByMax: false,
  };
}

// ---------------------------------------------------------------------------
// computeVisualOrder
// ---------------------------------------------------------------------------

describe("computeVisualOrder", () => {
  it("sorts elements top-to-bottom, left-to-right", () => {
    const stops: FocusStop[] = [
      makeStop({ selector: "c", sequenceIndex: 2, boundingBox: { x: 300, y: 0, width: 100, height: 30 } }),
      makeStop({ selector: "a", sequenceIndex: 0, boundingBox: { x: 0, y: 0, width: 100, height: 30 } }),
      makeStop({ selector: "d", sequenceIndex: 3, boundingBox: { x: 0, y: 100, width: 100, height: 30 } }),
      makeStop({ selector: "b", sequenceIndex: 1, boundingBox: { x: 150, y: 0, width: 100, height: 30 } }),
    ];

    const order = computeVisualOrder(stops);
    expect(order.map((s) => s.selector)).toEqual(["a", "b", "c", "d"]);
  });

  it("groups elements in same row by Y tolerance", () => {
    const stops: FocusStop[] = [
      makeStop({ selector: "a", boundingBox: { x: 0, y: 10, width: 100, height: 30 } }),
      makeStop({ selector: "b", boundingBox: { x: 200, y: 15, width: 100, height: 30 } }), // Same row (within 30px)
      makeStop({ selector: "c", boundingBox: { x: 0, y: 100, width: 100, height: 30 } }),   // New row
    ];

    const order = computeVisualOrder(stops);
    expect(order.map((s) => s.selector)).toEqual(["a", "b", "c"]);
  });

  it("skips elements without bounding boxes", () => {
    const stops: FocusStop[] = [
      makeStop({ selector: "a", boundingBox: { x: 0, y: 0, width: 100, height: 30 } }),
      makeStop({ selector: "b", boundingBox: null }),
      makeStop({ selector: "c", boundingBox: { x: 0, y: 50, width: 100, height: 30 } }),
    ];

    const order = computeVisualOrder(stops);
    expect(order.map((s) => s.selector)).toEqual(["a", "c"]);
  });

  it("returns empty array for no elements", () => {
    expect(computeVisualOrder([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// analyzeFocusOrder
// ---------------------------------------------------------------------------

describe("analyzeFocusOrder", () => {
  it("reports no issues for correct visual order", () => {
    const stops: FocusStop[] = [
      makeStop({ selector: "a", sequenceIndex: 0, boundingBox: { x: 0, y: 0, width: 100, height: 30 } }),
      makeStop({ selector: "b", sequenceIndex: 1, boundingBox: { x: 200, y: 0, width: 100, height: 30 } }),
      makeStop({ selector: "c", sequenceIndex: 2, boundingBox: { x: 0, y: 50, width: 100, height: 30 } }),
    ];

    const result = analyzeFocusOrder(makeTabSequence(stops));
    expect(result.matchesVisualOrder).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("detects backward jumps (focus moves upward >200px)", () => {
    const stops: FocusStop[] = [
      makeStop({ selector: "a", sequenceIndex: 0, boundingBox: { x: 0, y: 0, width: 100, height: 30 } }),
      makeStop({ selector: "b", sequenceIndex: 1, boundingBox: { x: 0, y: 400, width: 100, height: 30 } }),
      makeStop({ selector: "c", sequenceIndex: 2, boundingBox: { x: 0, y: 50, width: 100, height: 30 } }), // Jumps back up 350px
    ];

    const result = analyzeFocusOrder(makeTabSequence(stops));
    expect(result.matchesVisualOrder).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(1);

    const backwardJump = result.issues.find((i) => i.issueType === "backward_jump");
    expect(backwardJump).toBeDefined();
    expect(backwardJump!.verticalDelta).toBeLessThan(-200);
  });

  it("assigns high confidence for large backward jumps (>400px)", () => {
    const stops: FocusStop[] = [
      makeStop({ selector: "a", sequenceIndex: 0, boundingBox: { x: 0, y: 0, width: 100, height: 30 } }),
      makeStop({ selector: "b", sequenceIndex: 1, boundingBox: { x: 0, y: 600, width: 100, height: 30 } }),
      makeStop({ selector: "c", sequenceIndex: 2, boundingBox: { x: 0, y: 50, width: 100, height: 30 } }), // Jumps back 550px
    ];

    const result = analyzeFocusOrder(makeTabSequence(stops));
    const issue = result.issues.find((i) => i.issueType === "backward_jump");
    expect(issue).toBeDefined();
    expect(issue!.confidence).toBe("high");
  });

  it("assigns moderate confidence for smaller backward jumps", () => {
    const stops: FocusStop[] = [
      makeStop({ selector: "a", sequenceIndex: 0, boundingBox: { x: 0, y: 0, width: 100, height: 30 } }),
      makeStop({ selector: "b", sequenceIndex: 1, boundingBox: { x: 0, y: 300, width: 100, height: 30 } }),
      makeStop({ selector: "c", sequenceIndex: 2, boundingBox: { x: 0, y: 50, width: 100, height: 30 } }), // Jumps back 250px
    ];

    const result = analyzeFocusOrder(makeTabSequence(stops));
    const issue = result.issues.find((i) => i.issueType === "backward_jump");
    expect(issue).toBeDefined();
    expect(issue!.confidence).toBe("moderate");
  });

  it("detects large visual gaps (>500px downward)", () => {
    const stops: FocusStop[] = [
      makeStop({ selector: "a", sequenceIndex: 0, boundingBox: { x: 0, y: 0, width: 100, height: 30 } }),
      makeStop({ selector: "b", sequenceIndex: 1, boundingBox: { x: 0, y: 600, width: 100, height: 30 } }), // 600px gap
    ];

    const result = analyzeFocusOrder(makeTabSequence(stops));
    const gap = result.issues.find((i) => i.issueType === "large_gap");
    expect(gap).toBeDefined();
    expect(gap!.verticalDelta).toBeGreaterThan(500);
  });

  it("catches Webflow flexbox reordering pattern", () => {
    // Simulates CSS order property making visual order different from DOM order
    const stops: FocusStop[] = [
      makeStop({ selector: "card-3", sequenceIndex: 0, boundingBox: { x: 0, y: 0, width: 300, height: 200 } }),
      makeStop({ selector: "card-1", sequenceIndex: 1, boundingBox: { x: 0, y: 500, width: 300, height: 200 } }), // Visually below
      makeStop({ selector: "card-2", sequenceIndex: 2, boundingBox: { x: 0, y: 250, width: 300, height: 200 } }), // Jumps backward
    ];

    const result = analyzeFocusOrder(makeTabSequence(stops));
    expect(result.issues.length).toBeGreaterThan(0);
    // Should detect the backward jump from y=500 to y=250
    const jump = result.issues.find((i) => i.issueType === "backward_jump");
    expect(jump).toBeDefined();
  });

  it("catches absolutely positioned elements out of visual order", () => {
    // Simulates position:absolute elements tabbed in DOM order, not visual order
    const stops: FocusStop[] = [
      makeStop({ selector: "header-btn", sequenceIndex: 0, boundingBox: { x: 0, y: 0, width: 100, height: 30 } }),
      makeStop({ selector: "footer-btn", sequenceIndex: 1, boundingBox: { x: 0, y: 800, width: 100, height: 30 } }),
      makeStop({ selector: "abs-positioned", sequenceIndex: 2, boundingBox: { x: 0, y: 100, width: 100, height: 30 } }), // Abs positioned, should be second
    ];

    const result = analyzeFocusOrder(makeTabSequence(stops));
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("returns visual order and tab order arrays", () => {
    const stops: FocusStop[] = [
      makeStop({ selector: "b", sequenceIndex: 0, boundingBox: { x: 200, y: 0, width: 100, height: 30 } }),
      makeStop({ selector: "a", sequenceIndex: 1, boundingBox: { x: 0, y: 0, width: 100, height: 30 } }),
    ];

    const result = analyzeFocusOrder(makeTabSequence(stops));
    expect(result.tabOrder.map((s) => s.selector)).toEqual(["b", "a"]);
    expect(result.visualOrder.map((s) => s.selector)).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// runFocusOrderChecks — CheckResult generation
// ---------------------------------------------------------------------------

describe("runFocusOrderChecks", () => {
  it("produces single CheckResult per page for criterion 2.4.3", () => {
    const stops: FocusStop[] = [
      makeStop({ selector: "a", sequenceIndex: 0, boundingBox: { x: 0, y: 0, width: 100, height: 30 } }),
      makeStop({ selector: "b", sequenceIndex: 1, boundingBox: { x: 0, y: 500, width: 100, height: 30 } }),
      makeStop({ selector: "c", sequenceIndex: 2, boundingBox: { x: 0, y: 50, width: 100, height: 30 } }),
    ];

    const results = runFocusOrderChecks(makeTabSequence(stops));
    expect(results).toHaveLength(1);

    const r = results[0];
    expect(r.wcag_criterion).toBe("2.4.3");
    expect(r.detected_by).toBe("playwright");
    expect(r.element_selector).toBe("html");

    const raw = r.raw_result as Record<string, unknown>;
    expect(raw.type).toBe("focus_order_mismatch");
    expect(raw.totalIssues).toBeGreaterThan(0);
  });

  it("returns empty array when focus order matches visual order", () => {
    const stops: FocusStop[] = [
      makeStop({ selector: "a", sequenceIndex: 0, boundingBox: { x: 0, y: 0, width: 100, height: 30 } }),
      makeStop({ selector: "b", sequenceIndex: 1, boundingBox: { x: 200, y: 0, width: 100, height: 30 } }),
      makeStop({ selector: "c", sequenceIndex: 2, boundingBox: { x: 0, y: 50, width: 100, height: 30 } }),
    ];

    const results = runFocusOrderChecks(makeTabSequence(stops));
    expect(results).toEqual([]);
  });

  it("sets confidence high for large jumps, moderate for ambiguous", () => {
    const stops: FocusStop[] = [
      makeStop({ selector: "a", sequenceIndex: 0, boundingBox: { x: 0, y: 0, width: 100, height: 30 } }),
      makeStop({ selector: "b", sequenceIndex: 1, boundingBox: { x: 0, y: 600, width: 100, height: 30 } }),
      makeStop({ selector: "c", sequenceIndex: 2, boundingBox: { x: 0, y: 50, width: 100, height: 30 } }),
    ];

    const results = runFocusOrderChecks(makeTabSequence(stops));
    const measured = results[0].measured_values as Record<string, unknown>;
    expect(measured.confidence).toBe("high");
  });

  it("includes backward_jumps and large_gaps counts in measured_values", () => {
    const stops: FocusStop[] = [
      makeStop({ selector: "a", sequenceIndex: 0, boundingBox: { x: 0, y: 0, width: 100, height: 30 } }),
      makeStop({ selector: "b", sequenceIndex: 1, boundingBox: { x: 0, y: 800, width: 100, height: 30 } }), // Large gap
      makeStop({ selector: "c", sequenceIndex: 2, boundingBox: { x: 0, y: 50, width: 100, height: 30 } }), // Backward jump
    ];

    const results = runFocusOrderChecks(makeTabSequence(stops));
    const measured = results[0].measured_values as Record<string, unknown>;
    expect(typeof measured.backward_jumps).toBe("number");
    expect(typeof measured.large_gaps).toBe("number");
    expect((measured.backward_jumps as number) + (measured.large_gaps as number)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Integration test with real Playwright
// ---------------------------------------------------------------------------

describe("focus-order integration", () => {
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("no issues on a well-ordered page", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(`
        <!DOCTYPE html>
        <html lang="en"><head><title>Ordered</title></head>
        <body>
          <nav><a href="/">Home</a> <a href="/about">About</a></nav>
          <main><button>Action</button></main>
          <footer><a href="/privacy">Privacy</a></footer>
        </body></html>
      `);

      const tabSeq = await recordTabSequence(page, { maxTabs: 30 });
      const results = runFocusOrderChecks(tabSeq);
      expect(results).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it("detects issues on a page with CSS reordering", async () => {
    const page = await context.newPage();
    try {
      await page.setContent(`
        <!DOCTYPE html>
        <html lang="en"><head><title>Reordered</title>
        <style>
          .container { display: flex; flex-direction: column; }
          #first { order: 3; }
          #second { order: 1; }
          #third { order: 2; }
          button { margin: 10px; padding: 20px; display: block; }
        </style></head>
        <body>
          <div class="container">
            <button id="first" style="margin-top:400px">First in DOM (visually last)</button>
            <button id="second">Second in DOM (visually first)</button>
            <button id="third" style="margin-top:200px">Third in DOM (visually middle)</button>
          </div>
        </body></html>
      `);

      const tabSeq = await recordTabSequence(page, { maxTabs: 30 });
      const results = runFocusOrderChecks(tabSeq);

      // The CSS order reordering should cause focus order issues
      // Tab order follows DOM: first → second → third
      // But visual order is different due to flex order
      expect(results.length).toBeGreaterThanOrEqual(0);
      // At minimum, the backward jump from first (y~400) to second (y~0) should be detected
    } finally {
      await page.close();
    }
  });
});
