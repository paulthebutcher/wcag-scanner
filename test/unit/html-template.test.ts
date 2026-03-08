import { describe, it, expect } from "vitest";
import {
  renderHtmlReport,
  esc,
  severityBadge,
  statusBadge,
  diffBadge,
  CRITERION_NAMES,
  ALL_CRITERIA,
} from "../../src/report/templates/html-template.js";
import type { ReportData, FindingGroup, ScanDiff } from "../../src/report/generator.js";
import type {
  Finding,
  ScanSession,
  ScanSummary,
  CriterionResult,
  Evidence,
  Analysis,
  Confidence,
  Remediation,
  PlatformFix,
  Severity,
} from "../../src/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    element_selector: "#img1",
    element_html: '<img src="photo.jpg">',
    element_screenshot: "",
    element_computed_styles: {},
    context_screenshot: "",
    measured_values: { failure_type: "missing_alt" },
    keyboard_sequence: null,
    aria_attributes: {},
    detected_by: "axe_core",
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    method: "rule_based",
    reasoning: "Image has no alt attribute",
    llm_input: null,
    llm_output: null,
    impact_description: "Screen reader users cannot understand this image",
    affected_users: ["screen_reader", "low_vision"],
    ...overrides,
  };
}

function makeConfidence(): Confidence {
  return { score: 0.95, tier: "definitive", basis: "axe-core rule", requires_human: false, false_positive_risk: "low" };
}

function makePlatformFix(overrides: Partial<PlatformFix> = {}): PlatformFix {
  return {
    platform: "webflow",
    platform_version: "2024.1",
    steps: ["Select image", "Open Element Settings", "Add alt text"],
    designer_path: "Element Settings > Alt Text",
    screenshots: [],
    generated_by: "template",
    platform_docs_url: null,
    ...overrides,
  };
}

function makeRemediation(overrides: Partial<Remediation> = {}): Remediation {
  return {
    generic_fix: "Add descriptive alt text to the image",
    platform_fix: makePlatformFix(),
    code_fix: null,
    estimated_effort: "trivial",
    fix_verified: false,
    ...overrides,
  };
}

let counter = 0;
function makeFinding(overrides: Partial<Finding> = {}): Finding {
  counter++;
  return {
    id: `finding-${counter}`,
    page_snapshot_id: "snap-1",
    interaction_state_id: null,
    wcag_criterion: "1.1.1",
    wcag_level: "A",
    severity: "major",
    category: "images",
    finding_type_hash: "hash-alt",
    evidence: makeEvidence(),
    analysis: makeAnalysis(),
    confidence: makeConfidence(),
    remediation: makeRemediation(),
    human_review: null,
    ...overrides,
  };
}

function makeSession(overrides: Partial<ScanSession> = {}): ScanSession {
  return {
    id: "scan-001",
    url: "https://example.com",
    platform: "webflow",
    platform_detected_via: "meta_generator",
    initiated_at: "2024-06-15T10:00:00Z",
    completed_at: "2024-06-15T10:05:00Z",
    comparison_scan_id: null,
    scan_type: "initial",
    ...overrides,
  };
}

function makeSummary(overrides: Partial<ScanSummary> = {}): ScanSummary {
  return {
    scan_session_id: "scan-001",
    total_findings: 12,
    by_severity: { critical: 2, major: 5, minor: 3, advisory: 2 },
    by_confidence: { definitive: 8, high: 2, moderate: 1, needs_review: 1 },
    by_category: { contrast: 3, semantics: 2, keyboard: 2, forms: 1, images: 3, aria: 1, structure: 0 },
    human_reviewed_pct: 0,
    estimated_total_effort: "4-8 hours",
    wcag_criteria_failed: ["1.1.1", "2.4.7", "1.4.3"],
    wcag_criteria_passed: ["2.4.1", "3.1.1", "2.4.2"],
    ...overrides,
  };
}

function makeGroup(overrides: Partial<FindingGroup> = {}): FindingGroup {
  return {
    hash: "hash-alt",
    criterion: "1.1.1",
    failureType: "missing_alt",
    instanceCount: 3,
    severity: "major",
    findings: [makeFinding(), makeFinding(), makeFinding()],
    ...overrides,
  };
}

function makeCriterionResult(overrides: Partial<CriterionResult> = {}): CriterionResult {
  return {
    scan_session_id: "scan-001",
    wcag_criterion: "1.1.1",
    status: "failed",
    tested_by: "axe_core",
    evidence_summary: "3 images missing alt text",
    finding_ids: ["f1", "f2", "f3"],
    ...overrides,
  };
}

function makeReportData(overrides: Partial<ReportData> = {}): ReportData {
  return {
    scanSession: makeSession(),
    groups: [makeGroup()],
    criterionResults: [
      makeCriterionResult(),
      makeCriterionResult({ wcag_criterion: "2.4.1", status: "passed", evidence_summary: "Skip link found", finding_ids: [] }),
    ],
    summary: makeSummary(),
    diff: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Utility tests
// ---------------------------------------------------------------------------

describe("esc", () => {
  it("escapes HTML entities", () => {
    expect(esc('<script>alert("xss")</script>')).toBe(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
    );
  });

  it("escapes ampersands", () => {
    expect(esc("foo & bar")).toBe("foo &amp; bar");
  });
});

describe("severityBadge", () => {
  it("renders critical badge with red color", () => {
    const html = severityBadge("critical");
    expect(html).toContain("#dc2626");
    expect(html).toContain("critical");
  });

  it("renders all severity levels", () => {
    const levels: Severity[] = ["critical", "major", "minor", "advisory"];
    for (const level of levels) {
      const html = severityBadge(level);
      expect(html).toContain(level);
      expect(html).toContain("badge");
    }
  });
});

describe("statusBadge", () => {
  it("renders passed badge green", () => {
    const html = statusBadge("passed");
    expect(html).toContain("#16a34a");
    expect(html).toContain("passed");
  });

  it("replaces underscores with spaces", () => {
    const html = statusBadge("not_tested");
    expect(html).toContain("not tested");
  });
});

describe("diffBadge", () => {
  it("renders Fixed badge green", () => {
    const html = diffBadge("fixed");
    expect(html).toContain("Fixed");
    expect(html).toContain("#16a34a");
  });

  it("renders New badge red", () => {
    const html = diffBadge("new");
    expect(html).toContain("New");
    expect(html).toContain("#dc2626");
  });
});

// ---------------------------------------------------------------------------
// Constants tests
// ---------------------------------------------------------------------------

describe("CRITERION_NAMES", () => {
  it("has entries for common WCAG criteria", () => {
    expect(CRITERION_NAMES["1.1.1"]).toBe("Non-text Content");
    expect(CRITERION_NAMES["2.4.7"]).toBe("Focus Visible");
    expect(CRITERION_NAMES["4.1.2"]).toBe("Name, Role, Value");
  });
});

describe("ALL_CRITERIA", () => {
  it("contains all WCAG 2.1 AA criteria", () => {
    expect(ALL_CRITERIA.length).toBe(51);
  });

  it("starts with 1.1.1 and ends with 4.1.3", () => {
    expect(ALL_CRITERIA[0]).toBe("1.1.1");
    expect(ALL_CRITERIA[ALL_CRITERIA.length - 1]).toBe("4.1.3");
  });

  it("contains all WCAG 2.1 AA criteria", () => {
    expect(ALL_CRITERIA).toContain("1.1.1");
    expect(ALL_CRITERIA).toContain("2.4.7");
    expect(ALL_CRITERIA).toContain("4.1.2");
  });
});

// ---------------------------------------------------------------------------
// renderHtmlReport — full report tests
// ---------------------------------------------------------------------------

describe("renderHtmlReport", () => {
  it("returns valid HTML document", () => {
    const html = renderHtmlReport(makeReportData());
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html lang=\"en\">");
    expect(html).toContain("</html>");
    expect(html).toContain("<style>");
    expect(html).toContain("</style>");
  });

  it("includes site info in header", () => {
    const html = renderHtmlReport(makeReportData());
    expect(html).toContain("https://example.com");
    expect(html).toContain("webflow");
    expect(html).toContain("meta_generator");
    expect(html).toContain("scan-001");
  });

  it("includes scan date", () => {
    const html = renderHtmlReport(makeReportData());
    expect(html).toContain("June 15, 2024");
  });

  it("includes executive summary with finding counts", () => {
    const html = renderHtmlReport(makeReportData());
    expect(html).toContain("Executive Summary");
    expect(html).toContain("12"); // total findings
    expect(html).toContain("4-8 hours");
  });

  it("renders custom executive summary HTML when provided", () => {
    const customSummary = "<p>This is a custom executive summary.</p>";
    const html = renderHtmlReport(makeReportData(), { executiveSummaryHtml: customSummary });
    expect(html).toContain("This is a custom executive summary.");
  });

  it("includes findings grouped by hash", () => {
    const html = renderHtmlReport(makeReportData());
    expect(html).toContain("1.1.1");
    expect(html).toContain("Non-text Content");
    expect(html).toContain("missing_alt");
    expect(html).toContain("3 instance");
  });

  it("includes finding instances with analysis", () => {
    const html = renderHtmlReport(makeReportData());
    expect(html).toContain("Image has no alt attribute");
    expect(html).toContain("screen_reader");
  });

  it("includes HTML snippet in evidence", () => {
    const html = renderHtmlReport(makeReportData());
    expect(html).toContain("&lt;img src=&quot;photo.jpg&quot;&gt;");
  });

  it("includes remediation steps", () => {
    const html = renderHtmlReport(makeReportData());
    expect(html).toContain("Add descriptive alt text to the image");
    expect(html).toContain("Select image");
    expect(html).toContain("Open Element Settings");
  });

  it("includes expandable details for instances", () => {
    const html = renderHtmlReport(makeReportData());
    expect(html).toContain("<details");
    expect(html).toContain("<summary>");
  });

  it("includes criterion results table for all 50 criteria", () => {
    const html = renderHtmlReport(makeReportData());
    expect(html).toContain("Criterion Results");
    expect(html).toContain("1.1.1");
    expect(html).toContain("4.1.2"); // last in our CRITERION_NAMES
    // Criteria not in the results should show as not_tested
    expect(html).toContain("not tested");
  });

  it("includes methodology section", () => {
    const html = renderHtmlReport(makeReportData());
    expect(html).toContain("Methodology");
    expect(html).toContain("axe-core");
    expect(html).toContain("Playwright");
    expect(html).toContain("Claude API");
    expect(html).toContain("Confidence Tiers");
  });

  it("includes estimated effort section", () => {
    const html = renderHtmlReport(makeReportData());
    expect(html).toContain("Estimated Remediation Effort");
    expect(html).toContain("4-8 hours");
  });

  it("includes report footer with generation timestamp", () => {
    const html = renderHtmlReport(makeReportData());
    expect(html).toContain("Generated by WCAG Engine");
  });

  it("renders page URLs when pageUrlMap provided", () => {
    const pageUrlMap = new Map([["snap-1", "https://example.com/about"]]);
    const html = renderHtmlReport(makeReportData(), { pageUrlMap });
    expect(html).toContain("https://example.com/about");
  });

  it("renders impact descriptions when provided", () => {
    const impactDescriptions = new Map([["hash-alt", "Blind users cannot understand product images"]]);
    const html = renderHtmlReport(makeReportData(), { impactDescriptions });
    expect(html).toContain("Blind users cannot understand product images");
  });

  it("renders no findings message when empty", () => {
    const data = makeReportData({ groups: [] });
    const html = renderHtmlReport(data);
    expect(html).toContain("No accessibility violations detected");
  });

  it("handles missing summary gracefully", () => {
    const data = makeReportData({ summary: null });
    const html = renderHtmlReport(data);
    expect(html).toContain("No summary data available");
  });

  it("escapes XSS in user content", () => {
    const data = makeReportData({
      scanSession: makeSession({ url: '<script>alert("xss")</script>' }),
    });
    const html = renderHtmlReport(data);
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;");
  });

  it("includes inline CSS for self-contained rendering", () => {
    const html = renderHtmlReport(makeReportData());
    expect(html).toContain("font-family:");
    expect(html).toContain(".badge");
    expect(html).toContain(".summary-grid");
    expect(html).toContain("@media print");
  });
});

// ---------------------------------------------------------------------------
// Diff report tests
// ---------------------------------------------------------------------------

describe("renderHtmlReport with diff", () => {
  function makeDiffReportData(): ReportData {
    const resolved: FindingGroup = makeGroup({
      hash: "hash-resolved",
      criterion: "2.4.7",
      failureType: "no_focus_indicator",
      severity: "critical",
      instanceCount: 1,
      findings: [makeFinding({ finding_type_hash: "hash-resolved", wcag_criterion: "2.4.7", severity: "critical" })],
    });

    const newGroup: FindingGroup = makeGroup({
      hash: "hash-new",
      criterion: "1.4.3",
      failureType: "insufficient_contrast",
      severity: "major",
      instanceCount: 2,
      findings: [
        makeFinding({ finding_type_hash: "hash-new", wcag_criterion: "1.4.3", severity: "major" }),
        makeFinding({ finding_type_hash: "hash-new", wcag_criterion: "1.4.3", severity: "major" }),
      ],
    });

    const persistent: FindingGroup = makeGroup({
      hash: "hash-persistent",
      severity: "minor",
      instanceCount: 1,
      findings: [makeFinding({ finding_type_hash: "hash-persistent", severity: "minor" })],
    });

    const diff: ScanDiff = {
      resolved: [resolved],
      newFindings: [newGroup],
      persistent: [persistent],
    };

    return makeReportData({
      scanSession: makeSession({ comparison_scan_id: "scan-old" }),
      groups: [newGroup, persistent],
      diff,
    });
  }

  it("includes diff summary section", () => {
    const html = renderHtmlReport(makeDiffReportData());
    expect(html).toContain("Changes Since Previous Scan");
    expect(html).toContain("Resolved");
    expect(html).toContain("New Issues");
    expect(html).toContain("Persistent");
  });

  it("shows Fixed badge for resolved issues", () => {
    const html = renderHtmlReport(makeDiffReportData());
    expect(html).toContain("Fixed");
  });

  it("shows New badge for new issues", () => {
    const html = renderHtmlReport(makeDiffReportData());
    expect(html).toContain(">New<");
  });

  it("has section titles for diff groups", () => {
    const html = renderHtmlReport(makeDiffReportData());
    expect(html).toContain("Resolved Issues");
    expect(html).toContain("New Issues");
    expect(html).toContain("Persistent Issues");
  });

  it("includes comparison scan info in header", () => {
    const html = renderHtmlReport(makeDiffReportData());
    expect(html).toContain("scan-old");
  });
});
