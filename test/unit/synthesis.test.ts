import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  generateImpactDescriptions,
  generateExecutiveSummary,
  formatExecutiveSummaryHtml,
  getCachedImpact,
  setCachedImpact,
  clearImpactCache,
  type ImpactOutput,
  type ExecutiveSummaryOutput,
} from "../../src/report/synthesis.js";
import type { FindingGroup, ReportData } from "../../src/report/generator.js";
import type {
  Finding,
  Evidence,
  Analysis,
  Confidence,
  Remediation,
  PlatformFix,
  ScanSession,
  ScanSummary,
  CriterionResult,
} from "../../src/types.js";
import type { PromptRunner, PromptResult } from "../../src/core/prompt-runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvidence(): Evidence {
  return {
    element_selector: "#img1", element_html: '<img src="photo.jpg">', element_screenshot: "",
    element_computed_styles: {}, context_screenshot: "",
    measured_values: { failure_type: "missing_alt" },
    keyboard_sequence: null, aria_attributes: {}, detected_by: "axe_core",
  };
}

function makeAnalysis(): Analysis {
  return {
    method: "rule_based", reasoning: "Image missing alt", llm_input: null, llm_output: null,
    impact_description: "Fallback impact", affected_users: ["screen_reader"],
  };
}

function makeConfidence(): Confidence {
  return { score: 0.95, tier: "definitive", basis: "axe", requires_human: false, false_positive_risk: "low" };
}

function makePlatformFix(): PlatformFix {
  return { platform: "webflow", platform_version: "", steps: [], designer_path: "", screenshots: [], generated_by: "template", platform_docs_url: null };
}

function makeRemediation(): Remediation {
  return { generic_fix: "Fix it", platform_fix: makePlatformFix(), code_fix: null, estimated_effort: "trivial", fix_verified: false };
}

let cnt = 0;
function makeFinding(overrides: Partial<Finding> = {}): Finding {
  cnt++;
  return {
    id: `f-${cnt}`, page_snapshot_id: "snap-1", interaction_state_id: null,
    wcag_criterion: "1.1.1", wcag_level: "A", severity: "major", category: "images",
    finding_type_hash: "hash-alt", evidence: makeEvidence(), analysis: makeAnalysis(),
    confidence: makeConfidence(), remediation: makeRemediation(), human_review: null,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<FindingGroup> = {}): FindingGroup {
  return {
    hash: "hash-alt", criterion: "1.1.1", failureType: "missing_alt",
    instanceCount: 2, severity: "major",
    findings: [makeFinding(), makeFinding()],
    ...overrides,
  };
}

function makeSession(): ScanSession {
  return {
    id: "scan-1", url: "https://example.com", platform: "webflow",
    platform_detected_via: "meta_generator", initiated_at: "2024-06-15T10:00:00Z",
    completed_at: "2024-06-15T10:05:00Z", comparison_scan_id: null, scan_type: "initial",
  };
}

function makeSummary(): ScanSummary {
  return {
    scan_session_id: "scan-1", total_findings: 5,
    by_severity: { critical: 1, major: 2, minor: 1, advisory: 1 },
    by_confidence: { definitive: 3, high: 1, moderate: 1, needs_review: 0 },
    by_category: { contrast: 1, semantics: 1, keyboard: 1, forms: 0, images: 2, aria: 0, structure: 0 },
    human_reviewed_pct: 0, estimated_total_effort: "4 hours",
    wcag_criteria_failed: ["1.1.1", "2.4.7"], wcag_criteria_passed: ["2.4.1"],
  };
}

function makeReportData(overrides: Partial<ReportData> = {}): ReportData {
  return {
    scanSession: makeSession(),
    groups: [makeGroup()],
    criterionResults: [],
    summary: makeSummary(),
    diff: null,
    ...overrides,
  };
}

// Mock PromptRunner
function createMockRunner(responses: Map<string, PromptResult>): PromptRunner {
  const runPrompt = vi.fn(async (input: { template: { name: string }; userMessage: string }) => {
    const key = input.template.name;
    return responses.get(key) ?? { success: false, data: null, rawResponse: "", model: "test", tokensUsed: 0, latencyMs: 0, retries: 0, error: "no mock" };
  });

  return { runPrompt, runPrompts: vi.fn(), flushBatch: vi.fn(), getBatchQueueSize: vi.fn(() => 0), getConfig: vi.fn() } as unknown as PromptRunner;
}

// ---------------------------------------------------------------------------
// Impact cache tests
// ---------------------------------------------------------------------------

describe("impact cache", () => {
  beforeEach(() => { clearImpactCache(); cnt = 0; });

  it("setCachedImpact / getCachedImpact round-trips", () => {
    const impact: ImpactOutput = {
      impact_description: "Users cannot see image", affected_users: ["screen_reader"],
      severity_justification: "Critical", user_story: "A blind user...",
      workaround_exists: false, workaround_description: null,
    };
    setCachedImpact("hash-a", impact);
    expect(getCachedImpact("hash-a")).toEqual(impact);
  });

  it("returns undefined for missing cache entry", () => {
    expect(getCachedImpact("nonexistent")).toBeUndefined();
  });

  it("clearImpactCache removes all entries", () => {
    setCachedImpact("hash-a", { impact_description: "test" } as ImpactOutput);
    clearImpactCache();
    expect(getCachedImpact("hash-a")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// generateImpactDescriptions tests
// ---------------------------------------------------------------------------

describe("generateImpactDescriptions", () => {
  beforeEach(() => { clearImpactCache(); cnt = 0; });

  it("calls Prompt 14 once per unique hash", async () => {
    const impactResult: PromptResult<ImpactOutput> = {
      success: true,
      data: {
        impact_description: "Screen readers cannot interpret this image",
        affected_users: ["screen_reader"], severity_justification: "Major",
        user_story: "A blind user...", workaround_exists: false, workaround_description: null,
      },
      rawResponse: "{}", model: "sonnet", tokensUsed: 500, latencyMs: 200, retries: 0,
    };
    const runner = createMockRunner(new Map([["impact_description", impactResult as PromptResult]]));

    const groups = [makeGroup({ hash: "hash-1" }), makeGroup({ hash: "hash-2" })];
    const descriptions = await generateImpactDescriptions(groups, runner);

    expect(runner.runPrompt).toHaveBeenCalledTimes(2);
    expect(descriptions.size).toBe(2);
    expect(descriptions.get("hash-1")).toBe("Screen readers cannot interpret this image");
    expect(descriptions.get("hash-2")).toBe("Screen readers cannot interpret this image");
  });

  it("uses cached results and skips API calls", async () => {
    setCachedImpact("hash-cached", {
      impact_description: "Cached impact", affected_users: ["screen_reader"],
      severity_justification: "ok", user_story: "...", workaround_exists: false, workaround_description: null,
    });

    const runner = createMockRunner(new Map());
    const groups = [makeGroup({ hash: "hash-cached" })];
    const descriptions = await generateImpactDescriptions(groups, runner);

    expect(runner.runPrompt).not.toHaveBeenCalled();
    expect(descriptions.get("hash-cached")).toBe("Cached impact");
  });

  it("falls back to analysis.impact_description on failure", async () => {
    const failResult: PromptResult = {
      success: false, data: null, rawResponse: "", model: "sonnet",
      tokensUsed: 0, latencyMs: 0, retries: 2, error: "API error",
    };
    const runner = createMockRunner(new Map([["impact_description", failResult]]));

    const groups = [makeGroup({ hash: "hash-fail" })];
    const descriptions = await generateImpactDescriptions(groups, runner);

    expect(descriptions.get("hash-fail")).toBe("Fallback impact");
  });

  it("caches successful results", async () => {
    const impactResult: PromptResult<ImpactOutput> = {
      success: true,
      data: {
        impact_description: "Generated impact", affected_users: ["screen_reader"],
        severity_justification: "ok", user_story: "...", workaround_exists: false, workaround_description: null,
      },
      rawResponse: "{}", model: "sonnet", tokensUsed: 500, latencyMs: 200, retries: 0,
    };
    const runner = createMockRunner(new Map([["impact_description", impactResult as PromptResult]]));

    await generateImpactDescriptions([makeGroup({ hash: "hash-gen" })], runner);
    expect(getCachedImpact("hash-gen")?.impact_description).toBe("Generated impact");
  });

  it("returns empty map for empty groups", async () => {
    const runner = createMockRunner(new Map());
    const descriptions = await generateImpactDescriptions([], runner);
    expect(descriptions.size).toBe(0);
    expect(runner.runPrompt).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// generateExecutiveSummary tests
// ---------------------------------------------------------------------------

describe("generateExecutiveSummary", () => {
  beforeEach(() => { cnt = 0; });

  it("calls Prompt 15 with scan data", async () => {
    const summaryResult: PromptResult<ExecutiveSummaryOutput> = {
      success: true,
      data: {
        summary: "The site has moderate accessibility issues.",
        overall_grade: "C",
        critical_findings: [{ criterion: "2.4.7", description: "No focus", affected_users: ["keyboard_only"], fix_effort: "2 hours" }],
        priority_actions: ["Fix focus indicators"],
        positive_aspects: ["Good heading structure"],
        compliance_percentage: 72,
        estimated_total_effort: "8 hours",
        recommended_timeline: "2 weeks",
      },
      rawResponse: "{}", model: "opus", tokensUsed: 2000, latencyMs: 1500, retries: 0,
    };
    const runner = createMockRunner(new Map([["executive_summary", summaryResult as PromptResult]]));

    const result = await generateExecutiveSummary(makeReportData(), 5, runner);

    expect(runner.runPrompt).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
    expect(result!.overall_grade).toBe("C");
    expect(result!.compliance_percentage).toBe(72);
  });

  it("returns null on failure", async () => {
    const failResult: PromptResult = {
      success: false, data: null, rawResponse: "", model: "opus",
      tokensUsed: 0, latencyMs: 0, retries: 2, error: "API error",
    };
    const runner = createMockRunner(new Map([["executive_summary", failResult]]));

    const result = await generateExecutiveSummary(makeReportData(), 5, runner);
    expect(result).toBeNull();
  });

  it("uses summary data from ReportData", async () => {
    const summaryResult: PromptResult<ExecutiveSummaryOutput> = {
      success: true,
      data: {
        summary: "Test", overall_grade: "B",
        critical_findings: [], priority_actions: [], positive_aspects: [],
        compliance_percentage: 85, estimated_total_effort: "4 hours", recommended_timeline: "1 week",
      },
      rawResponse: "{}", model: "opus", tokensUsed: 1000, latencyMs: 1000, retries: 0,
    };
    const runner = createMockRunner(new Map([["executive_summary", summaryResult as PromptResult]]));

    const data = makeReportData({ summary: makeSummary() });
    await generateExecutiveSummary(data, 10, runner);

    const call = (runner.runPrompt as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.userMessage).toContain("https://example.com");
    expect(call.userMessage).toContain("10"); // pages
    expect(call.userMessage).toContain("1.1.1"); // failed criteria
  });
});

// ---------------------------------------------------------------------------
// formatExecutiveSummaryHtml tests
// ---------------------------------------------------------------------------

describe("formatExecutiveSummaryHtml", () => {
  const output: ExecutiveSummaryOutput = {
    summary: "The site needs work.",
    overall_grade: "C",
    critical_findings: [{ criterion: "2.4.7", description: "No focus visible", affected_users: ["keyboard_only"], fix_effort: "2 hours" }],
    priority_actions: ["Add focus styles", "Fix alt text"],
    positive_aspects: ["Good heading structure"],
    compliance_percentage: 68,
    estimated_total_effort: "12 hours",
    recommended_timeline: "3 weeks",
  };

  it("includes overall grade with color", () => {
    const html = formatExecutiveSummaryHtml(output);
    expect(html).toContain("C");
    expect(html).toContain("#ca8a04"); // C = yellow
  });

  it("includes compliance percentage", () => {
    const html = formatExecutiveSummaryHtml(output);
    expect(html).toContain("68%");
  });

  it("includes summary text", () => {
    const html = formatExecutiveSummaryHtml(output);
    expect(html).toContain("The site needs work.");
  });

  it("lists critical findings", () => {
    const html = formatExecutiveSummaryHtml(output);
    expect(html).toContain("2.4.7");
    expect(html).toContain("No focus visible");
  });

  it("lists priority actions as ordered list", () => {
    const html = formatExecutiveSummaryHtml(output);
    expect(html).toContain("<ol>");
    expect(html).toContain("Add focus styles");
    expect(html).toContain("Fix alt text");
  });

  it("lists positive aspects", () => {
    const html = formatExecutiveSummaryHtml(output);
    expect(html).toContain("Good heading structure");
  });

  it("includes estimated effort and timeline", () => {
    const html = formatExecutiveSummaryHtml(output);
    expect(html).toContain("12 hours");
    expect(html).toContain("3 weeks");
  });

  it("escapes HTML in content", () => {
    const xssOutput: ExecutiveSummaryOutput = {
      ...output,
      summary: '<script>alert("xss")</script>',
    };
    const html = formatExecutiveSummaryHtml(xssOutput);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("handles grade A with green color", () => {
    const html = formatExecutiveSummaryHtml({ ...output, overall_grade: "A" });
    expect(html).toContain("#16a34a");
  });

  it("handles grade F with red color", () => {
    const html = formatExecutiveSummaryHtml({ ...output, overall_grade: "F" });
    expect(html).toContain("#dc2626");
  });

  it("handles empty critical findings", () => {
    const html = formatExecutiveSummaryHtml({ ...output, critical_findings: [] });
    expect(html).not.toContain("Critical Findings");
  });

  it("handles empty priority actions", () => {
    const html = formatExecutiveSummaryHtml({ ...output, priority_actions: [] });
    expect(html).not.toContain("Priority Actions");
  });
});
