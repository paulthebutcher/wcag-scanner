import { describe, it, expect, vi } from "vitest";
import { analyze, analyzeBatch } from "../../src/core/analyzer.js";
import type { CheckResult } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeCheckResult(overrides?: Partial<CheckResult>): CheckResult {
  return {
    element_selector: "img.hero",
    element_html: '<img class="hero" src="photo.jpg">',
    wcag_criterion: "1.1.1",
    detected_by: "axe_core",
    raw_result: { impact: "serious", id: "image-alt", failureSummary: "Fix any of the following: Element does not have an alt attribute" },
    measured_values: {},
    aria_attributes: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Routing by detected_by
// ---------------------------------------------------------------------------

describe("analyze — routing", () => {
  it("routes axe_core to rule_based analysis", () => {
    const result = analyze(makeCheckResult({ detected_by: "axe_core" }));
    expect(result.method).toBe("rule_based");
    expect(result.llm_input).toBeNull();
    expect(result.llm_output).toBeNull();
  });

  it("routes playwright to rule_based analysis", () => {
    const result = analyze(makeCheckResult({
      detected_by: "playwright",
      wcag_criterion: "2.1.1",
      raw_result: { type: "unreachable_interactive_element", tagName: "button", role: "button" },
      measured_values: { tab_sequence_length: 12, total_tabs: 15 },
    }));
    expect(result.method).toBe("rule_based");
    expect(result.llm_input).toBeNull();
    expect(result.llm_output).toBeNull();
  });

  it("routes claude_api to LLM analysis with llm_input and llm_output", () => {
    const result = analyze(makeCheckResult({
      detected_by: "claude_api",
      raw_result: {
        verdict: "fail",
        confidence: 0.85,
        reasoning: "Alt text is a filename pattern",
        failure_type: "filename_as_alt",
        requires_human_verification: false,
      },
      measured_values: { prompt_name: "alt_text_quality", model: "claude-sonnet-4-6", tokens_used: 350 },
    }));
    expect(result.method).toBe("llm_semantic");
    expect(result.llm_input).not.toBeNull();
    expect(result.llm_input!.prompt).toBe("alt_text_quality");
    expect(result.llm_input!.dom_snippet).toContain("img");
    expect(result.llm_output).not.toBeNull();
    expect(result.llm_output!.model).toBe("claude-sonnet-4-6");
    expect(result.llm_output!.tokens_used).toBe(350);
  });

  it("routes claude_api with screenshot to llm_visual method", () => {
    const result = analyze(makeCheckResult({
      detected_by: "claude_api",
      screenshot: Buffer.from("fake-png"),
      raw_result: { verdict: "fail", reasoning: "Image appears informative" },
    }));
    expect(result.method).toBe("llm_visual");
  });

  it("routes manual to human analysis method", () => {
    const result = analyze(makeCheckResult({ detected_by: "manual" }));
    expect(result.method).toBe("human");
    expect(result.llm_input).toBeNull();
    expect(result.llm_output).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rule-based reasoning generation
// ---------------------------------------------------------------------------

describe("analyze — rule-based reasoning", () => {
  it("includes axe-core rule ID in reasoning", () => {
    const result = analyze(makeCheckResult({
      raw_result: { id: "image-alt", failureSummary: "Element does not have an alt attribute" },
    }));
    expect(result.reasoning).toContain("image-alt");
    expect(result.reasoning).toContain("Element does not have an alt attribute");
  });

  it("includes contrast ratio in reasoning when measured", () => {
    const result = analyze(makeCheckResult({
      wcag_criterion: "1.4.3",
      raw_result: { id: "color-contrast", failureSummary: "Insufficient contrast ratio" },
      measured_values: { contrast_ratio: 3.2 },
    }));
    expect(result.reasoning).toContain("3.2");
  });

  it("generates reasoning for unreachable keyboard elements", () => {
    const result = analyze(makeCheckResult({
      detected_by: "playwright",
      wcag_criterion: "2.1.1",
      raw_result: { type: "unreachable_interactive_element", tagName: "button" },
      measured_values: { tab_sequence_length: 12, total_tabs: 15 },
    }));
    expect(result.reasoning).toContain("button");
    expect(result.reasoning).toContain("12");
  });

  it("generates reasoning for keyboard traps", () => {
    const result = analyze(makeCheckResult({
      detected_by: "playwright",
      wcag_criterion: "2.1.2",
      raw_result: { type: "keyboard_trap", trapContext: "dropdown" },
      measured_values: { elements_in_cycle: 3, tabs_before_detected: 25 },
    }));
    expect(result.reasoning).toContain("trapped");
    expect(result.reasoning).toContain("dropdown");
    expect(result.reasoning).toContain("3");
  });

  it("generates reasoning for focus visibility issues", () => {
    const result = analyze(makeCheckResult({
      detected_by: "playwright",
      wcag_criterion: "2.4.7",
      raw_result: { type: "focus_not_visible" },
      measured_values: { focus_contrast: "1.5:1", min_contrast: "3:1" },
    }));
    expect(result.reasoning).toContain("visible focus indicator");
  });

  it("generates reasoning for missing skip navigation", () => {
    const result = analyze(makeCheckResult({
      detected_by: "playwright",
      wcag_criterion: "2.4.1",
      raw_result: { type: "no_skip_nav" },
    }));
    expect(result.reasoning).toContain("skip navigation");
  });

  it("falls back gracefully for unknown playwright test types", () => {
    const result = analyze(makeCheckResult({
      detected_by: "playwright",
      wcag_criterion: "2.4.3",
      raw_result: { type: "some_new_type" },
      measured_values: { something: true },
    }));
    expect(result.reasoning).toContain("some_new_type");
  });

  it("handles null raw_result without crashing", () => {
    const result = analyze(makeCheckResult({
      raw_result: null,
    }));
    expect(result.reasoning).toBeTruthy();
    expect(result.method).toBe("rule_based");
  });
});

// ---------------------------------------------------------------------------
// LLM analysis transparency
// ---------------------------------------------------------------------------

describe("analyze — LLM transparency", () => {
  it("stores raw_response as stringified JSON in llm_output", () => {
    const rawResult = {
      verdict: "fail",
      confidence: 0.75,
      reasoning: "Link text is generic",
      failure_type: "click_here",
    };
    const result = analyze(makeCheckResult({
      detected_by: "claude_api",
      wcag_criterion: "2.4.4",
      raw_result: rawResult,
    }));

    expect(result.llm_output!.raw_response).toBe(JSON.stringify(rawResult));
  });

  it("records screenshot_provided in llm_input", () => {
    const withScreenshot = analyze(makeCheckResult({
      detected_by: "claude_api",
      screenshot: Buffer.from("data"),
      raw_result: { reasoning: "test" },
    }));
    expect(withScreenshot.llm_input!.screenshot_provided).toBe(true);

    const withoutScreenshot = analyze(makeCheckResult({
      detected_by: "claude_api",
      raw_result: { reasoning: "test" },
    }));
    expect(withoutScreenshot.llm_input!.screenshot_provided).toBe(false);
  });

  it("uses Claude reasoning when available", () => {
    const result = analyze(makeCheckResult({
      detected_by: "claude_api",
      raw_result: { reasoning: "The alt text 'IMG_3847.jpg' is a filename pattern" },
    }));
    expect(result.reasoning).toContain("IMG_3847.jpg");
  });

  it("falls back to generic reasoning when Claude provides none", () => {
    const result = analyze(makeCheckResult({
      detected_by: "claude_api",
      raw_result: { verdict: "fail", failure_type: "filename_as_alt" },
    }));
    expect(result.reasoning).toContain("WCAG");
    expect(result.reasoning).toContain("filename_as_alt");
  });
});

// ---------------------------------------------------------------------------
// Impact description and affected users
// ---------------------------------------------------------------------------

describe("analyze — impact and affected users", () => {
  it("produces correct impact for 1.1.1 (non-text content)", () => {
    const result = analyze(makeCheckResult({ wcag_criterion: "1.1.1" }));
    expect(result.impact_description.toLowerCase()).toContain("screen reader");
    expect(result.affected_users).toContain("screen_reader");
  });

  it("produces correct impact for 2.1.1 (keyboard)", () => {
    const result = analyze(makeCheckResult({
      detected_by: "playwright",
      wcag_criterion: "2.1.1",
      raw_result: { type: "unreachable_interactive_element" },
    }));
    expect(result.impact_description).toContain("keyboard");
    expect(result.affected_users).toContain("keyboard_only");
    expect(result.affected_users).toContain("motor_limited");
  });

  it("produces correct impact for 1.4.3 (contrast)", () => {
    const result = analyze(makeCheckResult({
      wcag_criterion: "1.4.3",
      raw_result: { id: "color-contrast" },
    }));
    expect(result.impact_description).toContain("contrast");
    expect(result.affected_users).toContain("low_vision");
  });

  it("produces correct impact for 2.4.7 (focus visible)", () => {
    const result = analyze(makeCheckResult({
      detected_by: "playwright",
      wcag_criterion: "2.4.7",
      raw_result: { type: "focus_not_visible" },
    }));
    expect(result.affected_users).toContain("keyboard_only");
    expect(result.affected_users).toContain("low_vision");
  });

  it("produces correct impact for 3.2.3 (consistent navigation)", () => {
    const result = analyze(makeCheckResult({
      detected_by: "claude_api",
      wcag_criterion: "3.2.3",
      raw_result: { reasoning: "Nav order changed" },
    }));
    expect(result.affected_users).toContain("cognitive");
    expect(result.affected_users).toContain("screen_reader");
  });

  it("produces correct impact for 4.1.2 (name/role/value)", () => {
    const result = analyze(makeCheckResult({
      wcag_criterion: "4.1.2",
      raw_result: { id: "aria-required-attr" },
    }));
    expect(result.affected_users).toContain("screen_reader");
  });

  it("uses default impact for unknown criteria", () => {
    const result = analyze(makeCheckResult({
      wcag_criterion: "99.99.99",
      raw_result: { id: "unknown-rule" },
    }));
    expect(result.impact_description).toBeTruthy();
    expect(result.affected_users.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// analyzeBatch
// ---------------------------------------------------------------------------

describe("analyzeBatch", () => {
  it("analyzes multiple CheckResults", () => {
    const results = analyzeBatch([
      makeCheckResult({ wcag_criterion: "1.1.1" }),
      makeCheckResult({ detected_by: "playwright", wcag_criterion: "2.1.1", raw_result: { type: "unreachable_interactive_element" } }),
      makeCheckResult({ detected_by: "claude_api", wcag_criterion: "2.4.4", raw_result: { reasoning: "test" } }),
    ]);

    expect(results).toHaveLength(3);
    expect(results[0].method).toBe("rule_based");
    expect(results[1].method).toBe("rule_based");
    expect(results[2].method).toBe("llm_semantic");
  });

  it("isolates errors — one bad analysis does not fail the batch", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Create a check result that could cause issues
    const results = analyzeBatch([
      makeCheckResult({ wcag_criterion: "1.1.1" }),
      makeCheckResult({ wcag_criterion: "1.4.3" }),
    ]);

    expect(results).toHaveLength(2);
    warnSpy.mockRestore();
  });
});
