import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extractHeadings,
  getAxeHeadingCorroboration,
  runHeadingChecks,
  type HeadingInfo,
  type HeadingEvaluation,
} from "../../src/checks/semantic/headings.js";
import { PromptRunner } from "../../src/core/prompt-runner.js";
import type { CheckResult } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Test HTML
// ---------------------------------------------------------------------------

const GOOD_HEADINGS_HTML = `
<html>
<body>
  <h1>Welcome to Our Site</h1>
  <main>
    <h2>About Us</h2>
    <p>We are a great company.</p>
    <h2>Our Services</h2>
    <h3>Web Design</h3>
    <p>We design websites.</p>
    <h3>Development</h3>
    <p>We build things.</p>
    <h2>Contact</h2>
  </main>
</body>
</html>
`;

const BAD_HEADINGS_HTML = `
<html>
<body>
  <h1>My Site</h1>
  <h1>Another H1</h1>
  <h3>Skipped h2</h3>
  <h4 class="empty-heading"></h4>
  <h2>Services</h2>
  <p class="heading-styled">This looks like a heading but isn't</p>
</body>
</html>
`;

const NO_HEADINGS_HTML = `
<html>
<body>
  <p>This page has no headings at all.</p>
  <div>Just content without structure.</div>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// extractHeadings
// ---------------------------------------------------------------------------

describe("extractHeadings", () => {
  it("extracts all headings in document order", () => {
    const headings = extractHeadings(GOOD_HEADINGS_HTML);
    expect(headings.length).toBe(6);
    expect(headings[0].level).toBe(1);
    expect(headings[0].text).toBe("Welcome to Our Site");
    expect(headings[1].level).toBe(2);
    expect(headings[1].text).toBe("About Us");
    expect(headings[5].level).toBe(2);
    expect(headings[5].text).toBe("Contact");
  });

  it("extracts heading text content", () => {
    const headings = extractHeadings(GOOD_HEADINGS_HTML);
    expect(headings[2].text).toBe("Our Services");
    expect(headings[3].text).toBe("Web Design");
  });

  it("detects multiple h1 headings", () => {
    const headings = extractHeadings(BAD_HEADINGS_HTML);
    const h1s = headings.filter((h) => h.level === 1);
    expect(h1s.length).toBe(2);
  });

  it("detects empty headings", () => {
    const headings = extractHeadings(BAD_HEADINGS_HTML);
    const empty = headings.find((h) => h.text === "");
    expect(empty).toBeDefined();
    expect(empty!.level).toBe(4);
  });

  it("returns empty array for no headings", () => {
    const headings = extractHeadings(NO_HEADINGS_HTML);
    expect(headings).toEqual([]);
  });

  it("preserves heading HTML", () => {
    const headings = extractHeadings(GOOD_HEADINGS_HTML);
    expect(headings[0].html).toContain("<h1>");
    expect(headings[0].html).toContain("</h1>");
  });

  it("builds selectors with id", () => {
    const html = '<html><body><h2 id="intro">Intro</h2></body></html>';
    const headings = extractHeadings(html);
    expect(headings[0].selector).toBe("h2#intro");
  });

  it("builds selectors with class", () => {
    const headings = extractHeadings(BAD_HEADINGS_HTML);
    const empty = headings.find((h) => h.text === "");
    expect(empty!.selector).toBe("h4.empty-heading");
  });

  it("handles headings with nested inline elements", () => {
    const html = '<html><body><h2>Hello <strong>World</strong></h2></body></html>';
    const headings = extractHeadings(html);
    expect(headings[0].text).toBe("Hello World");
  });
});

// ---------------------------------------------------------------------------
// getAxeHeadingCorroboration
// ---------------------------------------------------------------------------

describe("getAxeHeadingCorroboration", () => {
  it("detects heading-order from axe results", () => {
    const axeResults: CheckResult[] = [{
      element_selector: "h3",
      element_html: "<h3>Skipped</h3>",
      wcag_criterion: "1.3.1",
      detected_by: "axe_core",
      raw_result: { id: "heading-order" },
    }];

    const corr = getAxeHeadingCorroboration(axeResults);
    expect(corr.has("skipped_level")).toBe(true);
  });

  it("detects empty-heading from axe results", () => {
    const axeResults: CheckResult[] = [{
      element_selector: "h4",
      element_html: "<h4></h4>",
      wcag_criterion: "1.3.1",
      detected_by: "axe_core",
      raw_result: { id: "empty-heading" },
    }];

    const corr = getAxeHeadingCorroboration(axeResults);
    expect(corr.has("empty_heading")).toBe(true);
  });

  it("returns empty set for no heading-related axe results", () => {
    const axeResults: CheckResult[] = [{
      element_selector: "img",
      element_html: "<img>",
      wcag_criterion: "1.1.1",
      detected_by: "axe_core",
      raw_result: { id: "image-alt" },
    }];

    const corr = getAxeHeadingCorroboration(axeResults);
    expect(corr.size).toBe(0);
  });

  it("handles empty axe results", () => {
    expect(getAxeHeadingCorroboration([]).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runHeadingChecks — mocked PromptRunner
// ---------------------------------------------------------------------------

describe("runHeadingChecks", () => {
  let mockRunner: PromptRunner;
  let runPromptSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRunner = new PromptRunner("test-key", { max_retries: 0 });
    runPromptSpy = vi.fn();
    mockRunner.runPrompt = runPromptSpy;
  });

  it("calls Prompt 3 once per page", async () => {
    runPromptSpy.mockResolvedValue({
      success: true,
      data: {
        verdict: "pass",
        confidence: 0.95,
        reasoning: "Good heading structure",
        wcag_criterion: "2.4.6",
        failure_type: null,
        suggestion: null,
        affected_users: [],
        requires_human_verification: false,
      },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    });

    await runHeadingChecks(GOOD_HEADINGS_HTML, "Test Page", mockRunner);

    expect(runPromptSpy).toHaveBeenCalledTimes(1);
    const input = runPromptSpy.mock.calls[0][0];
    expect(input.template.name).toBe("heading_structure");
    expect(input.template.vision).toBe(false);
  });

  it("returns empty for passing pages", async () => {
    runPromptSpy.mockResolvedValue({
      success: true,
      data: {
        verdict: "pass",
        confidence: 0.95,
        reasoning: "Good heading structure",
        wcag_criterion: "2.4.6",
        failure_type: null,
        suggestion: null,
        affected_users: [],
        requires_human_verification: false,
      },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    });

    const results = await runHeadingChecks(GOOD_HEADINGS_HTML, "Test Page", mockRunner);
    expect(results.length).toBe(0);
  });

  it("returns ONE CheckResult per page for failures", async () => {
    runPromptSpy.mockResolvedValue({
      success: true,
      data: {
        verdict: "fail",
        confidence: 0.92,
        reasoning: "Multiple h1 headings and skipped levels",
        wcag_criterion: "2.4.6",
        failure_type: "skipped_level",
        suggestion: "Fix heading hierarchy",
        affected_users: ["screen_reader", "cognitive"],
        requires_human_verification: false,
      },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    });

    const results = await runHeadingChecks(BAD_HEADINGS_HTML, "Bad Page", mockRunner);
    expect(results.length).toBe(1);
    expect(results[0].wcag_criterion).toBe("2.4.6");
    expect(results[0].detected_by).toBe("claude_api");
  });

  it("detects skipped_level failure", async () => {
    runPromptSpy.mockResolvedValue({
      success: true,
      data: {
        verdict: "fail",
        confidence: 0.98,
        reasoning: "h3 follows h1 without h2",
        wcag_criterion: "2.4.6",
        failure_type: "skipped_level",
        suggestion: "Add h2 between h1 and h3",
        affected_users: ["screen_reader"],
        requires_human_verification: false,
      },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    });

    const results = await runHeadingChecks(BAD_HEADINGS_HTML, "Bad Page", mockRunner);
    expect(results[0].measured_values?.failure_type).toBe("skipped_level");
    // The selector should point to the h3 that skipped
    expect(results[0].element_html).toContain("h3");
  });

  it("detects style_not_structure failure", async () => {
    runPromptSpy.mockResolvedValue({
      success: true,
      data: {
        verdict: "fail",
        confidence: 0.6,
        reasoning: "Elements styled as headings but using <p> tags",
        wcag_criterion: "2.4.6",
        failure_type: "style_not_structure",
        suggestion: "Use proper heading tags instead of styled paragraphs",
        affected_users: ["screen_reader"],
        requires_human_verification: true,
      },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    });

    const results = await runHeadingChecks(BAD_HEADINGS_HTML, "Bad Page", mockRunner);
    expect(results[0].measured_values?.failure_type).toBe("style_not_structure");
  });

  it("detects multiple_h1 failure", async () => {
    runPromptSpy.mockResolvedValue({
      success: true,
      data: {
        verdict: "fail",
        confidence: 0.93,
        reasoning: "Page has two h1 headings",
        wcag_criterion: "2.4.6",
        failure_type: "multiple_h1",
        suggestion: "Use only one h1 per page",
        affected_users: ["screen_reader"],
        requires_human_verification: false,
      },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    });

    const results = await runHeadingChecks(BAD_HEADINGS_HTML, "Bad Page", mockRunner);
    expect(results[0].measured_values?.failure_type).toBe("multiple_h1");
    // Should point to the second h1
    expect(results[0].element_html).toContain("Another H1");
  });

  it("detects non_descriptive failure", async () => {
    runPromptSpy.mockResolvedValue({
      success: true,
      data: {
        verdict: "fail",
        confidence: 0.7,
        reasoning: "Headings use generic text",
        wcag_criterion: "2.4.6",
        failure_type: "non_descriptive",
        suggestion: "Use descriptive heading text",
        affected_users: ["screen_reader", "cognitive"],
        requires_human_verification: true,
      },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    });

    const results = await runHeadingChecks(BAD_HEADINGS_HTML, "Bad Page", mockRunner);
    expect(results[0].measured_values?.failure_type).toBe("non_descriptive");
  });

  it("detects missing_headings failure", async () => {
    runPromptSpy.mockResolvedValue({
      success: true,
      data: {
        verdict: "fail",
        confidence: 0.8,
        reasoning: "Page has no headings",
        wcag_criterion: "2.4.6",
        failure_type: "missing_heading",
        suggestion: "Add headings to structure the content",
        affected_users: ["screen_reader", "cognitive"],
        requires_human_verification: true,
      },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    });

    const results = await runHeadingChecks(NO_HEADINGS_HTML, "No Headings Page", mockRunner);
    expect(results.length).toBe(1);
    expect(results[0].measured_values?.failure_type).toBe("missing_heading");
  });

  it("detects heading_too_generic failure", async () => {
    runPromptSpy.mockResolvedValue({
      success: true,
      data: {
        verdict: "fail",
        confidence: 0.65,
        reasoning: "Heading text is too generic to be useful",
        wcag_criterion: "2.4.6",
        failure_type: "heading_too_generic",
        suggestion: "Use more specific heading text",
        affected_users: ["screen_reader", "cognitive"],
        requires_human_verification: true,
      },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    });

    const html = '<html><body><h1>Page</h1><h2>Section 1</h2><h2>Section 2</h2></body></html>';
    const results = await runHeadingChecks(html, "Generic Page", mockRunner);
    expect(results[0].measured_values?.failure_type).toBe("heading_too_generic");
  });

  it("includes heading count and levels in measured_values", async () => {
    runPromptSpy.mockResolvedValue({
      success: true,
      data: {
        verdict: "fail",
        confidence: 0.9,
        reasoning: "Issues found",
        wcag_criterion: "2.4.6",
        failure_type: "skipped_level",
        suggestion: "Fix",
        affected_users: ["screen_reader"],
        requires_human_verification: false,
      },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    });

    const results = await runHeadingChecks(BAD_HEADINGS_HTML, "Bad Page", mockRunner);
    expect(results[0].measured_values?.heading_count).toBe(5);
    expect(results[0].measured_values?.heading_levels).toEqual([1, 1, 3, 4, 2]);
  });

  it("notes axe-core corroborating evidence", async () => {
    const axeResults: CheckResult[] = [{
      element_selector: "h3",
      element_html: "<h3>Skipped</h3>",
      wcag_criterion: "1.3.1",
      detected_by: "axe_core",
      raw_result: { id: "heading-order" },
    }];

    runPromptSpy.mockResolvedValue({
      success: true,
      data: {
        verdict: "fail",
        confidence: 0.98,
        reasoning: "Skipped heading level",
        wcag_criterion: "2.4.6",
        failure_type: "skipped_level",
        suggestion: "Fix",
        affected_users: ["screen_reader"],
        requires_human_verification: false,
      },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    });

    const results = await runHeadingChecks(BAD_HEADINGS_HTML, "Bad Page", mockRunner, {
      axeResults,
    });

    expect(results[0].measured_values?.axe_corroboration).toContain("skipped_level");
  });

  it("returns needs_review for API failures", async () => {
    runPromptSpy.mockResolvedValue({
      success: false,
      data: null,
      rawResponse: "",
      model: "claude-sonnet-4-6",
      tokensUsed: 0,
      latencyMs: 0,
      retries: 2,
      error: "API error",
    });

    const results = await runHeadingChecks(GOOD_HEADINGS_HTML, "Test Page", mockRunner);
    expect(results.length).toBe(1);
    const raw = results[0].raw_result as HeadingEvaluation;
    expect(raw.verdict).toBe("needs_review");
  });

  it("sends headings and page title in user prompt", async () => {
    runPromptSpy.mockResolvedValue({
      success: true,
      data: {
        verdict: "pass",
        confidence: 0.95,
        reasoning: "OK",
        wcag_criterion: "2.4.6",
        failure_type: null,
        suggestion: null,
        affected_users: [],
        requires_human_verification: false,
      },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    });

    await runHeadingChecks(GOOD_HEADINGS_HTML, "My Test Page", mockRunner);

    const input = runPromptSpy.mock.calls[0][0];
    expect(input.userMessage).toContain("My Test Page");
    expect(input.userMessage).toContain("Welcome to Our Site");
    expect(input.userMessage).toContain("h1:");
    expect(input.userMessage).toContain("h2:");
    expect(input.userMessage).toContain("h3:");
  });
});
