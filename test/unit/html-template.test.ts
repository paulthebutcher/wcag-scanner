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
  it("renders passed badge green with honest label", () => {
    const html = statusBadge("passed");
    expect(html).toContain("#16a34a");
    expect(html).toContain("no issues detected");
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
    expect(html).toContain("Webflow");
    // Scan ID is now in footer, not cover
    expect(html).toContain("scan-001");
  });

  it("includes scan date", () => {
    const html = renderHtmlReport(makeReportData());
    expect(html).toContain("June 15, 2024");
  });

  it("includes executive summary with finding counts", () => {
    const html = renderHtmlReport(makeReportData());
    expect(html).toContain("Executive Summary");
    expect(html).toContain("12"); // total instances
    expect(html).toContain("Total Instances");
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
    expect(html).toContain("Images &amp; Alt Text"); // category label for missing_alt
    expect(html).toContain("3 instance");
  });

  it("includes finding type description in report", () => {
    const html = renderHtmlReport(makeReportData());
    // The remediation generic_fix text appears in the finding card
    expect(html).toContain("Add descriptive alt text to the image");
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

  it("includes criterion results table for all 50 criteria", () => {
    const html = renderHtmlReport(makeReportData());
    expect(html).toContain("Compliance Scorecard");
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
    // Fallback executive summary generates plain-language posture from findings
    expect(html).toContain("significant accessibility gaps");
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

  it("includes diff summary when comparison scan present", () => {
    const html = renderHtmlReport(makeDiffReportData());
    expect(html).toContain("Changes Since Previous Scan");
    expect(html).toContain("diff-summary");
  });
});

// ---------------------------------------------------------------------------
// Screenshot rendering tests
// ---------------------------------------------------------------------------

describe("renderHtmlReport screenshots", () => {
  it("skips screenshot when path set but no dataDir", () => {
    const data = makeReportData({
      groups: [makeGroup({
        findings: [makeFinding({
          evidence: makeEvidence({ element_screenshot: "scan-001/findings/f1-element.png" }),
        })],
      })],
    });
    const html = renderHtmlReport(data);
    // New template silently skips unresolvable screenshots
    expect(html).not.toContain("screenshot-placeholder");
    expect(html).not.toContain("Screenshot not available");
    expect(html).not.toContain("data:image/png;base64,");
  });

  it("skips screenshot when screenshot file does not exist", () => {
    const data = makeReportData({
      groups: [makeGroup({
        findings: [makeFinding({
          evidence: makeEvidence({ element_screenshot: "scan-001/findings/nonexistent.png" }),
        })],
      })],
    });
    const html = renderHtmlReport(data, { dataDir: "/tmp/no-such-dir" });
    // New template silently skips unresolvable screenshots
    expect(html).not.toContain("screenshot-placeholder");
    expect(html).not.toContain("Screenshot not available");
    expect(html).not.toContain("data:image/png;base64,");
  });

  it("does not show screenshot section when screenshot path is empty", () => {
    const finding = makeFinding({
      evidence: makeEvidence({ element_screenshot: "" }),
    });
    const data = makeReportData({
      groups: [makeGroup({
        instanceCount: 1,
        findings: [finding],
      })],
    });
    const html = renderHtmlReport(data);
    // No <div class="instance-screenshot"> should appear in the body
    expect(html).not.toContain('class="instance-screenshot"');
  });

  it("renders base64 data URI when screenshot file exists", () => {
    // Create a temp file to test with
    const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
    const { join } = require("node:path");
    const { tmpdir } = require("node:os");

    const tmpDir = mkdtempSync(join(tmpdir(), "wcag-screenshot-test-"));
    const { mkdirSync } = require("node:fs");
    mkdirSync(join(tmpDir, "scan-001", "findings"), { recursive: true });
    // Write a tiny valid PNG (1x1 pixel)
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    ]);
    writeFileSync(join(tmpDir, "scan-001", "findings", "f1-element.png"), pngHeader);

    try {
      const finding = makeFinding({
        evidence: makeEvidence({ element_screenshot: "scan-001/findings/f1-element.png" }),
      });
      const data = makeReportData({
        groups: [makeGroup({
          instanceCount: 1,
          findings: [finding],
        })],
      });
      const html = renderHtmlReport(data, { dataDir: tmpDir });
      expect(html).toContain("data:image/png;base64,");
      expect(html).not.toContain("Screenshot not available");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("includes snippet-screenshot CSS in report", () => {
    const html = renderHtmlReport(makeReportData());
    expect(html).toContain(".snippet-screenshot");
  });
});

// ---------------------------------------------------------------------------
// Failure type label tests
// ---------------------------------------------------------------------------

describe("renderHtmlReport failure types", () => {
  it("shows category label for failure type", () => {
    const data = makeReportData({
      groups: [makeGroup({
        failureType: "missing_alt",
      })],
    });
    const html = renderHtmlReport(data);
    // Category label appears in card meta and effort table
    expect(html).toContain("Images &amp; Alt Text");
  });

  it("shows category label for behavioral failure type", () => {
    const data = makeReportData({
      groups: [makeGroup({
        failureType: "unreachable_interactive_element",
        criterion: "2.1.1",
      })],
    });
    const html = renderHtmlReport(data);
    expect(html).toContain("Keyboard Access");
  });
});

// ---------------------------------------------------------------------------
// Clarified count tests
// ---------------------------------------------------------------------------

describe("renderHtmlReport clarified counts", () => {
  it("shows issue types and total instances in summary", () => {
    const data = makeReportData({
      groups: [
        makeGroup({ hash: "hash-1", instanceCount: 5, findings: Array(5).fill(null).map(() => makeFinding()) }),
        makeGroup({ hash: "hash-2", instanceCount: 3, findings: Array(3).fill(null).map(() => makeFinding({ wcag_criterion: "2.4.7", finding_type_hash: "hash-2" })) }),
      ],
      summary: makeSummary({ total_findings: 8 }),
    });
    const html = renderHtmlReport(data);
    // Summary grid shows issue types and total instances in separate cards
    expect(html).toContain("2 unique issue type");
    expect(html).toContain("8");
  });

  it("shows instance count and page count in finding group header", () => {
    const data = makeReportData({
      groups: [makeGroup({
        instanceCount: 4,
        findings: [
          makeFinding({ page_snapshot_id: "snap-1" }),
          makeFinding({ page_snapshot_id: "snap-1" }),
          makeFinding({ page_snapshot_id: "snap-2" }),
          makeFinding({ page_snapshot_id: "snap-3" }),
        ],
      })],
    });
    const html = renderHtmlReport(data);
    expect(html).toContain("4 instances across 3 pages");
  });

  it("always shows page count even for single page", () => {
    const data = makeReportData({
      groups: [makeGroup({
        instanceCount: 2,
        findings: [
          makeFinding({ page_snapshot_id: "snap-1" }),
          makeFinding({ page_snapshot_id: "snap-1" }),
        ],
      })],
    });
    const html = renderHtmlReport(data);
    expect(html).toContain("2 instance");
    expect(html).toContain("across 1 page");
  });
});

// ---------------------------------------------------------------------------
// Page-grouped view tests
// ---------------------------------------------------------------------------

describe("renderHtmlReport page-grouped view", () => {
  it("includes Findings by Page section", () => {
    const pageUrlMap = new Map([
      ["snap-1", "https://example.com/"],
      ["snap-2", "https://example.com/about"],
    ]);
    const data = makeReportData({
      groups: [makeGroup({
        findings: [
          makeFinding({ page_snapshot_id: "snap-1" }),
          makeFinding({ page_snapshot_id: "snap-2" }),
        ],
        instanceCount: 2,
      })],
    });
    const html = renderHtmlReport(data, { pageUrlMap });
    expect(html).toContain("Findings by Page");
    expect(html).toContain("https://example.com/");
    expect(html).toContain("https://example.com/about");
  });

  it("includes Findings by Type section before page appendix", () => {
    const html = renderHtmlReport(makeReportData());
    expect(html).toContain("Findings by Type");
    expect(html).toContain("Findings by Page");
    // Type view should appear before page appendix
    const typeIdx = html.indexOf("Findings by Type");
    const pageIdx = html.indexOf("Findings by Page");
    expect(typeIdx).toBeLessThan(pageIdx);
  });

  it("shows consolidated summary in appendix", () => {
    const pageUrlMap = new Map([["snap-1", "https://example.com/"]]);
    const data = makeReportData({
      groups: [makeGroup({
        findings: [
          makeFinding({ page_snapshot_id: "snap-1" }),
          makeFinding({ page_snapshot_id: "snap-1" }),
          makeFinding({ page_snapshot_id: "snap-1" }),
        ],
        instanceCount: 3,
      })],
    });
    const html = renderHtmlReport(data, { pageUrlMap });
    expect(html).toContain("Findings by Page");
    expect(html).toContain("1.1.1");
  });

  it("omits page-grouped view when no findings", () => {
    const data = makeReportData({ groups: [] });
    const html = renderHtmlReport(data);
    expect(html).not.toContain("Findings by Page");
  });
});

// ---------------------------------------------------------------------------
// Group remediation display tests
// ---------------------------------------------------------------------------

describe("renderHtmlReport group remediation", () => {
  it("shows Webflow designer path in group header", () => {
    const data = makeReportData({
      groups: [makeGroup({
        instanceCount: 1,
        findings: [makeFinding({
          remediation: makeRemediation({
            generic_fix: "Add alt text to the image",
            platform_fix: makePlatformFix({
              designer_path: "Element Settings (D) → Alt Text field",
              steps: ["Select image", "Open Element Settings", "Add alt text"],
            }),
          }),
        })],
      })],
    });
    const html = renderHtmlReport(data);
    expect(html).toContain("Element Settings (D)");
    expect(html).toContain("Alt Text field");
    expect(html).toContain("Webflow:");
  });

  it("shows platform-specific steps inline", () => {
    const data = makeReportData({
      groups: [makeGroup({
        instanceCount: 1,
        findings: [makeFinding({
          remediation: makeRemediation({
            platform_fix: makePlatformFix({
              steps: ["Step one", "Step two"],
            }),
          }),
        })],
      })],
    });
    const html = renderHtmlReport(data);
    // Steps are rendered inline (no collapsible wrapper)
    expect(html).toContain("Step one");
    expect(html).toContain("Step two");
  });

  it("shows code fix directly in code block", () => {
    const data = makeReportData({
      groups: [makeGroup({
        instanceCount: 1,
        findings: [makeFinding({
          remediation: makeRemediation({
            code_fix: '<script>document.documentElement.lang = "en";</script>',
            platform_fix: makePlatformFix({ steps: ["Add code"] }),
          }),
        })],
      })],
    });
    const html = renderHtmlReport(data);
    // Code fix rendered directly in a code block, not in a collapsible
    expect(html).toContain("document.documentElement.lang");
  });
});
