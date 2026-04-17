import { describe, it, expect } from "vitest";
import type { Finding, Severity, ConfidenceTier, FalsePositiveRisk, DetectedBy } from "../../src/types.js";
import {
  classifyTriage,
  shouldFilterFromClientReport,
  renderFindingMarkdown,
} from "../../src/report/findings-dump.js";

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

function makeFinding(opts: {
  severity?: Severity;
  detectedBy?: DetectedBy;
  tier?: ConfidenceTier;
  fpRisk?: FalsePositiveRisk;
  requiresHuman?: boolean;
  criterion?: string;
}): Finding {
  return {
    id: "fake-uuid",
    page_snapshot_id: "page-1",
    interaction_state_id: null,
    wcag_criterion: opts.criterion ?? "1.1.1",
    wcag_level: "A",
    severity: opts.severity ?? "major",
    category: "semantics",
    finding_type_hash: "h",
    evidence: {
      element_selector: "a#x",
      element_html: "<a id=\"x\">x</a>",
      element_screenshot: "",
      element_computed_styles: {},
      context_screenshot: "",
      measured_values: { failure_type: "generic_link_text" },
      keyboard_sequence: null,
      aria_attributes: {},
      detected_by: opts.detectedBy ?? "claude_api",
    },
    analysis: {
      method: "llm_semantic",
      reasoning: "why",
      llm_input: null,
      llm_output: null,
      impact_description: "impact",
      affected_users: ["screen_reader"],
    },
    confidence: {
      score: 0.8,
      tier: opts.tier ?? "high",
      basis: "basis",
      requires_human: opts.requiresHuman ?? false,
      false_positive_risk: opts.fpRisk ?? "low",
    },
    remediation: {
      generic_fix: "fix it",
      platform_fix: {
        platform: "webflow",
        platform_version: "v",
        steps: ["step 1"],
        designer_path: "",
        screenshots: [],
        generated_by: "template",
        platform_docs_url: null,
      },
      code_fix: null,
      estimated_effort: "minor",
      fix_verified: false,
    },
    human_review: null,
  };
}

// ---------------------------------------------------------------------------
// classifyTriage
// ---------------------------------------------------------------------------

describe("classifyTriage", () => {
  it("advisory severity → advisory bucket (regardless of other signals)", () => {
    expect(classifyTriage(makeFinding({ severity: "advisory", detectedBy: "axe_core", tier: "definitive" })))
      .toBe("advisory");
  });

  it("axe_core high-severity definitive → fix_now", () => {
    expect(classifyTriage(makeFinding({ detectedBy: "axe_core", tier: "definitive", severity: "critical" })))
      .toBe("fix_now");
  });

  it("playwright major with high tier → fix_now", () => {
    expect(classifyTriage(makeFinding({ detectedBy: "playwright", tier: "high", severity: "major" })))
      .toBe("fix_now");
  });

  it("claude_api with needs_review tier → possibly_noisy", () => {
    expect(classifyTriage(makeFinding({ detectedBy: "claude_api", tier: "needs_review", severity: "minor" })))
      .toBe("possibly_noisy");
  });

  it("claude_api with high FP risk → possibly_noisy", () => {
    expect(classifyTriage(makeFinding({ detectedBy: "claude_api", fpRisk: "high", severity: "minor" })))
      .toBe("possibly_noisy");
  });

  it("requires_human → verify_manually", () => {
    expect(classifyTriage(makeFinding({ detectedBy: "claude_api", requiresHuman: true, tier: "high", severity: "minor" })))
      .toBe("verify_manually");
  });

  it("moderate tier → verify_manually", () => {
    expect(classifyTriage(makeFinding({ detectedBy: "claude_api", tier: "moderate", severity: "minor" })))
      .toBe("verify_manually");
  });

  it("medium FP risk → verify_manually", () => {
    expect(classifyTriage(makeFinding({ detectedBy: "claude_api", fpRisk: "medium", tier: "high", severity: "minor" })))
      .toBe("verify_manually");
  });

  it("playwright minor is not fix_now (severity must be critical/major)", () => {
    expect(classifyTriage(makeFinding({ detectedBy: "playwright", tier: "high", severity: "minor" })))
      .not.toBe("fix_now");
  });
});

// ---------------------------------------------------------------------------
// shouldFilterFromClientReport
// ---------------------------------------------------------------------------

describe("shouldFilterFromClientReport", () => {
  it("filters possibly_noisy findings", () => {
    expect(shouldFilterFromClientReport(
      makeFinding({ detectedBy: "claude_api", fpRisk: "high" }),
    )).toBe(true);
    expect(shouldFilterFromClientReport(
      makeFinding({ detectedBy: "claude_api", tier: "needs_review" }),
    )).toBe(true);
  });

  it("does not filter fix_now findings", () => {
    expect(shouldFilterFromClientReport(
      makeFinding({ detectedBy: "axe_core", tier: "definitive", severity: "critical" }),
    )).toBe(false);
  });

  it("does not filter advisory findings", () => {
    expect(shouldFilterFromClientReport(
      makeFinding({ severity: "advisory", detectedBy: "playwright" }),
    )).toBe(false);
  });

  it("does not filter verify_manually findings", () => {
    expect(shouldFilterFromClientReport(
      makeFinding({ detectedBy: "claude_api", fpRisk: "medium", tier: "high" }),
    )).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// renderFindingMarkdown
// ---------------------------------------------------------------------------

describe("renderFindingMarkdown", () => {
  it("includes criterion, bucket, detection, selector, reasoning, remediation", () => {
    const f = makeFinding({ criterion: "2.4.4", detectedBy: "claude_api", tier: "high" });
    const md = renderFindingMarkdown({ finding: f, bucket: "verify_manually", pageUrl: "/home" });
    expect(md).toContain("WCAG 2.4.4");
    expect(md).toContain("Verify manually");
    expect(md).toContain("claude_api");
    expect(md).toContain("a#x");
    expect(md).toContain("why");
    expect(md).toContain("fix it");
  });

  it("includes LLM input/output sections when present", () => {
    const f = makeFinding({ detectedBy: "claude_api" });
    f.analysis.llm_input = { prompt: "RENDERED PROMPT", dom_snippet: "<a>", screenshot_provided: false };
    f.analysis.llm_output = { raw_response: "RAW JSON", model: "claude-sonnet-4-6", tokens_used: 150 };
    const md = renderFindingMarkdown({ finding: f, bucket: "verify_manually", pageUrl: "/home" });
    expect(md).toContain("## LLM input");
    expect(md).toContain("RENDERED PROMPT");
    expect(md).toContain("## LLM output");
    expect(md).toContain("RAW JSON");
  });

  it("omits LLM sections for non-LLM findings", () => {
    const f = makeFinding({ detectedBy: "axe_core" });
    const md = renderFindingMarkdown({ finding: f, bucket: "fix_now", pageUrl: "/home" });
    expect(md).not.toContain("## LLM input");
    expect(md).not.toContain("## LLM output");
  });
});
