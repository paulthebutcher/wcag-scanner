import { describe, it, expect } from "vitest";
import {
  EFFORT_MODEL,
  estimateRemediation,
  fixUnits,
  formatEstimate,
  formatHours,
  unitKeysFor,
} from "../../src/report/effort.js";
import { computeSummary } from "../../src/core/scanner.js";
import { makeTestFinding, contrastReasoning } from "./finding-factory.js";

const focusLink = (text: string, page = "snap-1", extra: Record<string, unknown> = {}) =>
  makeTestFinding({
    criterion: "2.4.7", failureType: "no_visible_focus_indicator", detectedBy: "playwright",
    selector: `body > section:nth-of-type(3) > div > a:nth-child(${text.length})`,
    html: `<a href="/${text}" class="footer-link-l2 w-inline-block">${text}</a>`,
    pageSnapshotId: page, measured: extra,
  });

describe("fix units", () => {
  it("collapses a class's focus problems into one style edit, whatever the link text", () => {
    const units = fixUnits([focusLink("Centralize"), focusLink("Ambassadorship"), focusLink("Track", "snap-2")]);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ kind: "class-style", findings: 3, low: 0.15, high: 0.3 });
  });

  it("costs a deduplicated finding on 50 pages the same as on one page", () => {
    const urls = Array.from({ length: 49 }, (_, i) => `https://s.test/p${i}`);
    const onOne = estimateRemediation([focusLink("Home")]);
    const onFifty = estimateRemediation([focusLink("Home", "snap-1", { also_found_on_pages: 49, also_found_on_urls: urls })]);
    expect(onFifty.fixes).toEqual(onOne.fixes);
  });

  it("keys colour contrast by text colour, copy by unique element, focus order by page", () => {
    const contrastA = makeTestFinding({ criterion: "1.4.3", failureType: "color-contrast", html: '<a class="tos">Privacy</a>', reasoning: contrastReasoning("#286140", "#17191e") });
    const contrastB = makeTestFinding({ criterion: "1.4.3", failureType: "color-contrast", html: "<a>here</a>", reasoning: contrastReasoning("#286140", "#1e252b") });
    const altA = makeTestFinding({ criterion: "1.1.1", failureType: "alt_not_descriptive", html: '<img src="a.png" alt="1">' });
    const altB = makeTestFinding({ criterion: "1.1.1", failureType: "alt_not_descriptive", html: '<img src="b.png" alt="2">' });
    const order = (page: string) => makeTestFinding({ criterion: "2.4.3", failureType: "focus_order_mismatch", detectedBy: "playwright", html: "<focus-order-summary/>", pageSnapshotId: page });
    const units = fixUnits([contrastA, contrastB, altA, altB, order("snap-1"), order("snap-2"), order("snap-2")]);
    const byKind = (k: string) => units.filter((u) => u.kind === k).length;
    expect(byKind("class-style")).toBe(1);
    expect(byKind("content")).toBe(2);
    expect(byKind("page")).toBe(2);
  });

  it("expands page units to folded pages, resolving snapshot ids to URLs", () => {
    const f = makeTestFinding({ criterion: "2.4.3", failureType: "focus_order_mismatch", detectedBy: "playwright", pageSnapshotId: "snap-1", measured: { also_found_on_pages: 1, also_found_on_urls: ["https://s.test/b"] } });
    expect(unitKeysFor(f, (id) => (id === "snap-1" ? "https://s.test/a" : id))).toEqual([
      "page|focus_order_mismatch|https://s.test/a",
      "page|focus_order_mismatch|https://s.test/b",
    ]);
  });

  it("treats a form's error-handling problems as one rework", () => {
    const form = (ft: string) => makeTestFinding({ criterion: "3.3.1", failureType: ft, detectedBy: "playwright", html: '<form id="email-form" class="logic-form-wrap">' });
    expect(fixUnits([form("error_message"), form("error_not_identified")])).toHaveLength(1);
  });
});

describe("estimateRemediation", () => {
  const button = (cls: string) => makeTestFinding({ criterion: "4.1.2", failureType: "custom_interactive_no_role", detectedBy: "playwright", html: `<div class="${cls}">` });

  it("adds the keyboard snippet once for any number of div buttons", () => {
    const e = estimateRemediation([button("btn modal"), button("main-menu-back"), button("alert-close")]);
    expect(e.units.filter((u) => u.key === "site|keyboard-snippet")).toHaveLength(1);
    const [cLow] = EFFORT_MODEL.kinds.component;
    expect(e.fixes.low).toBeCloseTo(3 * cLow + EFFORT_MODEL.keyboardSnippet[0]);
  });

  it("gives excluded findings no fix hours: third party costs nothing, unmeasurable contrast adds review time", () => {
    const third = makeTestFinding({ failureType: "animated_content_no_pause", html: '<div class="grsf-window">' });
    const manual = makeTestFinding({ criterion: "1.4.3", failureType: "color-contrast", selector: "h1.hero", html: '<h1 class="hero">Hi</h1>', reasoning: "Element's background color could not be determined due to a background gradient" });
    const e = estimateRemediation([third, manual]);
    expect(e.units).toHaveLength(0);
    expect(e.fixes.high).toBe(0);
    expect(e.thirdParty).toBe(1);
    expect(e.manualCheckElements).toBe(1);
    expect(e.review.low).toBeCloseTo(EFFORT_MODEL.manualCheckPerElement[0]);
  });

  it("keeps advisory items out of the headline and in the add-on", () => {
    const advisory = makeTestFinding({ criterion: "2.2.2", failureType: "animated_content_no_pause", detectedBy: "playwright", severity: "advisory", html: '<div class="slider">' });
    const e = estimateRemediation([advisory, button("btn")]);
    expect(e.advisoryAddOn.low).toBe(EFFORT_MODEL.overrides.animated_content_no_pause[0]);
    expect(e.fixes.low).toBeCloseTo(EFFORT_MODEL.kinds.component[0] + EFFORT_MODEL.keyboardSnippet[0]);
    expect(e.low).toBeCloseTo(e.fixes.low + e.qa.low + e.review.low + e.coordination.low);
  });

  it("scores unknown failure types by stored effort instead of blowing up", () => {
    const unknown = makeTestFinding({ failureType: "some-new-axe-rule" });
    const [u] = fixUnits([unknown]);
    expect([u.low, u.high]).toEqual(EFFORT_MODEL.byStoredEffort.minor);
  });

  it("feeds the scan summary instead of a per-instance sum", () => {
    const many = Array.from({ length: 300 }, (_, i) => focusLink(`L${i}`, `snap-${i % 50}`));
    const summary = computeSummary("scan", many, []);
    // One class style edit plus QA, not 300 x 0.5 h
    expect(summary.estimated_total_effort).toBe("< 2 hours");
  });
});

describe("formatting", () => {
  it("formats ranges with days", () => {
    expect(formatEstimate({ low: 27.1, high: 47.2 })).toBe("~27–47 hours (≈ 3–6 days)");
    expect(formatEstimate({ low: 0.5, high: 1.2 })).toBe("< 2 hours");
    expect(formatEstimate({ low: 3, high: 5 })).toBe("~3–5 hours");
    expect(formatHours(0.15, 0.3)).toBe("0.15–0.3 h");
    expect(formatHours(4, 7.2)).toBe("4–7.2 h");
    expect(formatHours(1, 1)).toBe("1 h");
  });
});
