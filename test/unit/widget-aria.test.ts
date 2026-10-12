import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  collectWidgetCandidates,
  runWidgetAriaChecks,
  getAttr,
  passesNameRoleFocusPreCheck,
  mapWidgetVerdict,
} from "../../src/checks/semantic/widget-aria.js";
import { PromptRunner } from "../../src/core/prompt-runner.js";
import { scoreConfidence } from "../../src/core/confidence.js";
import { shouldFilterFromClientReport } from "../../src/report/findings-dump.js";
import { makeTestFinding } from "./finding-factory.js";

// ---------------------------------------------------------------------------
// Test HTML snippets
// ---------------------------------------------------------------------------

const DROPDOWN_HTML = `
<html><body>
  <div class="w-dropdown" id="menu1">
    <div class="w-dropdown-toggle">Menu</div>
    <nav class="w-dropdown-list"><a href="/about">About</a></nav>
  </div>
</body></html>
`;

const DROPDOWN_WITH_ARIA_HTML = `
<html><body>
  <div class="w-dropdown" aria-expanded="false" id="menu1">
    <div class="w-dropdown-toggle">Menu</div>
    <nav class="w-dropdown-list"><a href="/about">About</a></nav>
  </div>
</body></html>
`;

const TABS_HTML = `
<html><body>
  <div class="w-tabs" id="tabs1">
    <div class="w-tab-menu">
      <a class="w-tab-link w--current">Tab 1</a>
      <a class="w-tab-link">Tab 2</a>
    </div>
    <div class="w-tab-content">Content</div>
  </div>
</body></html>
`;

const TABS_WITH_ROLE_HTML = `
<html><body>
  <div class="w-tabs" id="tabs1">
    <div class="w-tab-menu" role="tablist">
      <a class="w-tab-link" role="tab">Tab 1</a>
      <a class="w-tab-link" role="tab">Tab 2</a>
    </div>
  </div>
</body></html>
`;

const CUSTOM_INTERACTIVE_HTML = `
<html><body>
  <div data-w-id="abc-123" class="custom-widget">Click me</div>
</body></html>
`;

const CUSTOM_INTERACTIVE_WITH_ROLE_HTML = `
<html><body>
  <div data-w-id="abc-123" class="custom-widget" role="button" tabindex="0">Click me</div>
</body></html>
`;

const CUSTOM_INSIDE_BUTTON_HTML = `
<html><body>
  <button><span data-w-id="abc-123" class="icon">X</span></button>
</body></html>
`;

const CUSTOM_INSIDE_LINK_HTML = `
<html><body>
  <a href="/home"><div data-w-id="abc-123" class="icon">Home</div></a>
</body></html>
`;

const EMPTY_HTML = `<html><body><div>No widgets here</div></body></html>`;

const ALL_PROPER_HTML = `
<html><body>
  <div class="w-dropdown" aria-expanded="false">
    <div class="w-dropdown-toggle">Menu</div>
  </div>
  <div class="w-tabs">
    <div class="w-tab-menu">
      <a class="w-tab-link" role="tab">Tab 1</a>
    </div>
  </div>
</body></html>
`;

const MANY_WIDGETS_HTML = (() => {
  const items = Array.from({ length: 25 }, (_, i) =>
    `<div data-w-id="id-${i}" class="widget-${i}">Widget ${i}</div>`
  ).join("\n");
  return `<html><body>${items}</body></html>`;
})();

// ---------------------------------------------------------------------------
// getAttr
// ---------------------------------------------------------------------------

describe("getAttr", () => {
  it("extracts double-quoted attribute", () => {
    expect(getAttr('class="w-dropdown" id="test"', "class")).toBe("w-dropdown");
  });

  it("extracts single-quoted attribute", () => {
    expect(getAttr("class='w-dropdown'", "class")).toBe("w-dropdown");
  });

  it("returns null for missing attribute", () => {
    expect(getAttr('class="w-dropdown"', "id")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// collectWidgetCandidates
// ---------------------------------------------------------------------------

describe("collectWidgetCandidates", () => {
  it("finds w-dropdown elements", () => {
    const candidates = collectWidgetCandidates(DROPDOWN_HTML);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const accordion = candidates.find(c => c.type === "accordion");
    expect(accordion).toBeDefined();
    expect(accordion!.hasAriaExpanded).toBe(false);
  });

  it("detects aria-expanded on dropdown", () => {
    const candidates = collectWidgetCandidates(DROPDOWN_WITH_ARIA_HTML);
    const accordion = candidates.find(c => c.type === "accordion");
    expect(accordion).toBeDefined();
    expect(accordion!.hasAriaExpanded).toBe(true);
  });

  it("finds w-tabs elements", () => {
    const candidates = collectWidgetCandidates(TABS_HTML);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const tabs = candidates.find(c => c.type === "tabs");
    expect(tabs).toBeDefined();
    expect(tabs!.hasTabRole).toBe(false);
  });

  it("detects role=tab on tab elements", () => {
    const candidates = collectWidgetCandidates(TABS_WITH_ROLE_HTML);
    const tabs = candidates.find(c => c.type === "tabs");
    expect(tabs).toBeDefined();
    expect(tabs!.hasTabRole).toBe(true);
  });

  it("finds elements with data-w-id", () => {
    const candidates = collectWidgetCandidates(CUSTOM_INTERACTIVE_HTML);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const custom = candidates.find(c => c.type === "custom_interactive");
    expect(custom).toBeDefined();
    expect(custom!.hasRole).toBe(false);
    expect(custom!.hasTabindex).toBe(false);
  });

  it("skips data-w-id elements inside buttons", () => {
    const candidates = collectWidgetCandidates(CUSTOM_INSIDE_BUTTON_HTML);
    const custom = candidates.find(c => c.type === "custom_interactive");
    expect(custom).toBeUndefined();
  });

  it("skips data-w-id elements inside links", () => {
    const candidates = collectWidgetCandidates(CUSTOM_INSIDE_LINK_HTML);
    const custom = candidates.find(c => c.type === "custom_interactive");
    expect(custom).toBeUndefined();
  });

  it("returns empty for no widgets", () => {
    const candidates = collectWidgetCandidates(EMPTY_HTML);
    expect(candidates).toEqual([]);
  });

  it("limits to 20 candidates", () => {
    const candidates = collectWidgetCandidates(MANY_WIDGETS_HTML);
    expect(candidates.length).toBeLessThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// runWidgetAriaChecks
// ---------------------------------------------------------------------------

describe("runWidgetAriaChecks", () => {
  let mockRunner: PromptRunner;
  let runPromptsSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRunner = new PromptRunner("test-key", { max_retries: 0 });
    runPromptsSpy = vi.fn().mockResolvedValue([]);
    mockRunner.runPrompts = runPromptsSpy;
  });

  it("creates structural finding for w-dropdown without aria-expanded", async () => {
    const results = await runWidgetAriaChecks(DROPDOWN_HTML, mockRunner);
    const finding = results.find(r => r.measured_values?.failure_type === "missing_aria_expanded");
    expect(finding).toBeDefined();
    expect(finding!.wcag_criterion).toBe("4.1.2");
    expect(finding!.detected_by).toBe("playwright");
    expect(finding!.measured_values?.widget_type).toBe("accordion");
  });

  it("creates structural finding for w-tabs without role=tab", async () => {
    const results = await runWidgetAriaChecks(TABS_HTML, mockRunner);
    const finding = results.find(r => r.measured_values?.failure_type === "missing_tab_role");
    expect(finding).toBeDefined();
    expect(finding!.wcag_criterion).toBe("4.1.2");
    expect(finding!.detected_by).toBe("playwright");
    expect(finding!.measured_values?.widget_type).toBe("tabs");
  });

  it("creates structural finding for custom interactive without role or tabindex", async () => {
    const results = await runWidgetAriaChecks(CUSTOM_INTERACTIVE_HTML, mockRunner);
    const finding = results.find(r => r.measured_values?.failure_type === "custom_interactive_no_role");
    expect(finding).toBeDefined();
    expect(finding!.wcag_criterion).toBe("4.1.2");
    expect(finding!.detected_by).toBe("playwright");
    expect(finding!.measured_values?.widget_type).toBe("custom_interactive");
  });

  it("returns empty when all widgets have proper ARIA", async () => {
    const results = await runWidgetAriaChecks(ALL_PROPER_HTML, mockRunner);
    // Dropdown has aria-expanded, tabs have role="tab" — both pass structurally
    // They may go to Claude as ambiguous, which returns [] from mock
    const structuralFailures = results.filter(r => r.detected_by === "playwright");
    expect(structuralFailures.length).toBe(0);
  });

  it("returns empty for no widgets", async () => {
    const results = await runWidgetAriaChecks(EMPTY_HTML, mockRunner);
    expect(results).toEqual([]);
    expect(runPromptsSpy).not.toHaveBeenCalled();
  });

  it("sets correct wcag_criterion 4.1.2 on all findings", async () => {
    const dom = `
      <html><body>
        <div class="w-dropdown">Menu</div>
        <div class="w-tabs"><div class="w-tab-menu"><a>Tab</a></div></div>
        <div data-w-id="x" class="custom">Click</div>
      </body></html>
    `;
    const results = await runWidgetAriaChecks(dom, mockRunner);
    for (const result of results) {
      expect(result.wcag_criterion).toBe("4.1.2");
    }
  });

  it("sets correct failure_types for each widget type", async () => {
    const dom = `
      <html><body>
        <div class="w-dropdown">Menu</div>
        <div class="w-tabs"><div class="w-tab-menu"><a>Tab</a></div></div>
        <div data-w-id="x" class="custom">Click</div>
      </body></html>
    `;
    const results = await runWidgetAriaChecks(dom, mockRunner);
    const failureTypes = results.map(r => r.measured_values?.failure_type);
    expect(failureTypes).toContain("missing_aria_expanded");
    expect(failureTypes).toContain("missing_tab_role");
    expect(failureTypes).toContain("custom_interactive_no_role");
  });

  it("sends ambiguous candidates to Claude", async () => {
    // Custom interactive with role but no tabindex — ambiguous
    const dom = `
      <html><body>
        <div data-w-id="abc" class="widget" role="button">Click</div>
      </body></html>
    `;

    runPromptsSpy.mockResolvedValue([{
      success: true,
      data: {
        verdict: "fail",
        confidence: 0.8,
        reasoning: "Missing tabindex for keyboard access",
        wcag_criterion: "4.1.2",
        failure_type: "custom_interactive_no_role",
        suggestion: "Add tabindex=\"0\"",
        affected_users: ["keyboard_only", "screen_reader"],
        requires_human_verification: false,
      },
      rawResponse: "{}",
      model: "claude-sonnet-4-6",
      tokensUsed: 150,
      latencyMs: 300,
      retries: 0,
    }]);

    const results = await runWidgetAriaChecks(dom, mockRunner);
    expect(runPromptsSpy).toHaveBeenCalledTimes(1);
    expect(results.length).toBe(1);
    expect(results[0].detected_by).toBe("claude_api");
    expect(results[0].measured_values?.failure_type).toBe("custom_interactive_no_role");
  });

  it("handles Claude evaluation failure gracefully", async () => {
    const dom = `
      <html><body>
        <div data-w-id="abc" class="widget" role="button">Click</div>
      </body></html>
    `;

    runPromptsSpy.mockResolvedValue([{
      success: false,
      data: null,
      rawResponse: "",
      model: "claude-sonnet-4-6",
      tokensUsed: 0,
      latencyMs: 500,
      retries: 2,
      error: "Parse error",
    }]);

    const results = await runWidgetAriaChecks(dom, mockRunner);
    expect(results.length).toBe(1);
    expect(results[0].detected_by).toBe("claude_api");
    expect((results[0].raw_result as { verdict: string }).verdict).toBe("needs_review");
  });

  it("does not flag dropdown that has aria-expanded", async () => {
    const results = await runWidgetAriaChecks(DROPDOWN_WITH_ARIA_HTML, mockRunner);
    const structuralDropdown = results.find(
      r => r.detected_by === "playwright" && r.measured_values?.failure_type === "missing_aria_expanded"
    );
    expect(structuralDropdown).toBeUndefined();
  });

  it("does not flag tabs that have role=tab", async () => {
    const results = await runWidgetAriaChecks(TABS_WITH_ROLE_HTML, mockRunner);
    const structuralTabs = results.find(
      r => r.detected_by === "playwright" && r.measured_values?.failure_type === "missing_tab_role"
    );
    expect(structuralTabs).toBeUndefined();
  });

  it("does not flag custom interactive with role and tabindex", async () => {
    const results = await runWidgetAriaChecks(CUSTOM_INTERACTIVE_WITH_ROLE_HTML, mockRunner);
    const structural = results.find(
      r => r.detected_by === "playwright" && r.measured_values?.failure_type === "custom_interactive_no_role"
    );
    expect(structural).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pre-check and verdict mapping (contradicting AI findings)
// ---------------------------------------------------------------------------

describe("name/role/focus pre-check and verdict mapping", () => {
  // The element from scan 0b7d5e28 that was flagged missing_accessible_name
  // and missing_aria_expanded on 49 pages
  const REQUEST_DEMO = `<div tabindex="0" role="button" data-w-id="ff1fba9b-c373-5725-91ea-e26e90dbbe5c" class="btn modal full"><div>Request a Demo</div></div>`;
  const page = (body: string) => `<html><body>${body}</body></html>`;

  const llm = (data: Record<string, unknown>) => ({
    success: true,
    data: { confidence: 0.8, reasoning: "r", wcag_criterion: "4.1.2", suggestion: null, affected_users: [], requires_human_verification: false, ...data },
    rawResponse: "{}", model: "m", tokensUsed: 1, latencyMs: 1, retries: 0,
  });

  let mockRunner: PromptRunner;
  let runPromptsSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockRunner = new PromptRunner("test-key", { max_retries: 0 });
    runPromptsSpy = vi.fn().mockResolvedValue([]);
    mockRunner.runPrompts = runPromptsSpy;
  });

  it("reads the accessible name from visible text, aria-label and aria-labelledby", () => {
    const [demo] = collectWidgetCandidates(page(REQUEST_DEMO));
    expect(demo.accessibleName).toBe("Request a Demo");
    expect(demo.role).toBe("button");
    expect(demo.tabindex).toBe("0");
    expect(demo.opensModal).toBe(true);
    expect(passesNameRoleFocusPreCheck(demo)).toBe(true);

    const [labelled] = collectWidgetCandidates(page(`<span id="lbl">Next slide</span><div data-w-id="a" role="button" tabindex="0" aria-labelledby="lbl"><img src="arrow.svg" alt=""></div>`));
    expect(labelled.accessibleName).toBe("Next slide");
    const [aria] = collectWidgetCandidates(page(`<div data-w-id="b" role="button" tabindex="0" aria-label="Close"></div>`));
    expect(aria.accessibleName).toBe("Close");
  });

  it("fails the pre-check without a role, without focusability, or without a name", () => {
    const base = { role: "button", tabindex: "0", accessibleName: "Go", tagName: "div" };
    expect(passesNameRoleFocusPreCheck(base)).toBe(true);
    expect(passesNameRoleFocusPreCheck({ ...base, role: null })).toBe(false);
    expect(passesNameRoleFocusPreCheck({ ...base, role: "presentation" })).toBe(false);
    expect(passesNameRoleFocusPreCheck({ ...base, tabindex: null })).toBe(false);
    expect(passesNameRoleFocusPreCheck({ ...base, tabindex: "-1" })).toBe(false);
    expect(passesNameRoleFocusPreCheck({ ...base, accessibleName: "  " })).toBe(false);
  });

  it("maps verdicts: only fail is a failure; hedged types are uncertain", () => {
    const plain = { role: null, tabindex: null, accessibleName: "", tagName: "div", opensModal: false };
    expect(mapWidgetVerdict({ verdict: "fail", failure_type: "custom_interactive_no_role" }, plain)).toBe("fail");
    expect(mapWidgetVerdict({ verdict: "pass", failure_type: null }, plain)).toBe("pass");
    expect(mapWidgetVerdict({ verdict: "uncertain", failure_type: null }, plain)).toBe("uncertain");
    expect(mapWidgetVerdict({ verdict: "needs_review", failure_type: null }, plain)).toBe("uncertain");
    expect(mapWidgetVerdict({ verdict: "fail", failure_type: "possible_missing_accessible_name" }, plain)).toBe("uncertain");
    expect(mapWidgetVerdict({ verdict: "fail", failure_type: "potentially_missing_aria_selected_or_aria_controls" }, plain)).toBe("uncertain");
  });

  it("drops name/role/focus failures and modal aria-expanded for the Request a Demo button", () => {
    const [demo] = collectWidgetCandidates(page(REQUEST_DEMO));
    expect(mapWidgetVerdict({ verdict: "fail", failure_type: "missing_accessible_name" }, demo)).toBe("pass");
    expect(mapWidgetVerdict({ verdict: "needs_review", failure_type: "potentially_missing_accessible_name" }, demo)).toBe("pass");
    expect(mapWidgetVerdict({ verdict: "fail", failure_type: "missing_aria_expanded" }, demo)).toBe("pass");
    // A disclosure that toggles content in place still needs aria-expanded
    const [toggle] = collectWidgetCandidates(page(`<div data-w-id="c" role="button" tabindex="0" class="faq-question">Shipping</div>`));
    expect(toggle.opensModal).toBe(false);
    expect(mapWidgetVerdict({ verdict: "fail", failure_type: "missing_aria_expanded" }, toggle)).toBe("fail");
  });

  it("creates no finding for the Request a Demo button and does not ask the model", async () => {
    const results = await runWidgetAriaChecks(page(REQUEST_DEMO), mockRunner);
    expect(results).toHaveLength(0);
    expect(runPromptsSpy).not.toHaveBeenCalled();
  });

  it("drops a contradicting model failure and keeps uncertain answers for review only", async () => {
    const dom = page(`
      <div data-w-id="d1" role="button" tabindex="0" class="card-toggle">Pricing details</div>
      <div data-w-id="d2" role="button" class="card-toggle">Plans</div>
      <div data-w-id="d3" role="tab" tabindex="0" class="slider-dot"></div>`);
    runPromptsSpy.mockResolvedValue([
      llm({ verdict: "fail", failure_type: "missing_accessible_name" }), // contradicts the pre-check
      llm({ verdict: "fail", failure_type: "custom_interactive_no_role" }), // no tabindex: a real failure
      llm({ verdict: "fail", failure_type: "possible_missing_accessible_name" }), // hedged
    ]);
    const results = await runWidgetAriaChecks(dom, mockRunner);
    const byType = Object.fromEntries(results.map((r) => [r.measured_values?.failure_type as string, r.measured_values?.verdict]));
    expect(byType).toEqual({ custom_interactive_no_role: "fail", possible_missing_accessible_name: "uncertain" });
  });
});

describe("uncertain widget verdicts are scored for review", () => {
  it("scores verdict uncertain as needs_review, which the client report filters", () => {
    const f = makeTestFinding({ criterion: "4.1.2", failureType: "possible_missing_accessible_name", detectedBy: "claude_api", measured: { verdict: "uncertain", confidence: 0.8 } });
    const c = scoreConfidence(f);
    expect(c.tier).toBe("needs_review");
    expect(shouldFilterFromClientReport({ ...f, confidence: c })).toBe(true);
  });
});
