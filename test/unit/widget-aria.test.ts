import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  collectWidgetCandidates,
  runWidgetAriaChecks,
  getAttr,
} from "../../src/checks/semantic/widget-aria.js";
import { PromptRunner } from "../../src/core/prompt-runner.js";

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
