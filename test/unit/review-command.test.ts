import { describe, it, expect } from "vitest";
import { createReviewCommand, formatFindingSummary, formatPendingList, formatReviewStats } from "../../src/cli/commands/review.js";
import type { Finding } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helper: mock finding
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f-123-456",
    page_snapshot_id: "ps-1",
    interaction_state_id: null,
    wcag_criterion: "1.1.1",
    wcag_level: "A",
    severity: "major",
    category: "images",
    finding_type_hash: "hash-alt",
    evidence: {
      element_selector: "#img1",
      element_html: '<img src="photo.jpg">',
      element_screenshot: "",
      element_computed_styles: {},
      context_screenshot: "",
      measured_values: { failure_type: "missing_alt" },
      keyboard_sequence: null,
      aria_attributes: {},
      detected_by: "axe_core",
    },
    analysis: {
      method: "rule_based",
      reasoning: "Image is missing alt text attribute",
      llm_input: null,
      llm_output: null,
      impact_description: "Screen readers cannot interpret this image",
      affected_users: ["screen_reader"],
    },
    confidence: { score: 0.95, tier: "definitive", basis: "axe", requires_human: false, false_positive_risk: "low" },
    remediation: {
      generic_fix: "Add alt text",
      platform_fix: { platform: "webflow", platform_version: "2024.1", steps: [], designer_path: "", screenshots: [], generated_by: "template", platform_docs_url: null },
      code_fix: null,
      estimated_effort: "trivial",
      fix_verified: false,
    },
    human_review: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createReviewCommand structure tests
// ---------------------------------------------------------------------------

describe("createReviewCommand", () => {
  const cmd = createReviewCommand();

  it("has name 'review'", () => {
    expect(cmd.name()).toBe("review");
  });

  it("has a description", () => {
    expect(cmd.description()).toContain("Review");
  });

  it("accepts an optional finding-id argument", () => {
    const args = cmd.registeredArguments;
    expect(args.length).toBe(1);
    expect(args[0].name()).toBe("finding-id");
    expect(args[0].required).toBe(false);
  });

  it("has --scan option", () => {
    const opt = cmd.options.find((o) => o.long === "--scan");
    expect(opt).toBeDefined();
  });

  it("has --pending option", () => {
    const opt = cmd.options.find((o) => o.long === "--pending");
    expect(opt).toBeDefined();
  });

  it("has --stats option", () => {
    const opt = cmd.options.find((o) => o.long === "--stats");
    expect(opt).toBeDefined();
  });

  it("has --verdict option", () => {
    const opt = cmd.options.find((o) => o.long === "--verdict");
    expect(opt).toBeDefined();
  });

  it("has --severity option", () => {
    const opt = cmd.options.find((o) => o.long === "--severity");
    expect(opt).toBeDefined();
  });

  it("has --notes option", () => {
    const opt = cmd.options.find((o) => o.long === "--notes");
    expect(opt).toBeDefined();
  });

  it("has --reviewer option with default cli-user", () => {
    const opt = cmd.options.find((o) => o.long === "--reviewer");
    expect(opt).toBeDefined();
    expect(opt!.defaultValue).toBe("cli-user");
  });

  it("has --data-dir option with default ./wcag-data", () => {
    const opt = cmd.options.find((o) => o.long === "--data-dir");
    expect(opt).toBeDefined();
    expect(opt!.defaultValue).toBe("./wcag-data");
  });
});

// ---------------------------------------------------------------------------
// formatFindingSummary tests
// ---------------------------------------------------------------------------

describe("formatFindingSummary", () => {
  it("includes finding ID", () => {
    const output = formatFindingSummary(makeFinding());
    expect(output).toContain("f-123-456");
  });

  it("includes WCAG criterion and level", () => {
    const output = formatFindingSummary(makeFinding());
    expect(output).toContain("WCAG 1.1.1 (A)");
  });

  it("includes severity", () => {
    const output = formatFindingSummary(makeFinding());
    expect(output).toContain("major");
  });

  it("includes element selector", () => {
    const output = formatFindingSummary(makeFinding());
    expect(output).toContain("#img1");
  });

  it("includes reasoning", () => {
    const output = formatFindingSummary(makeFinding());
    expect(output).toContain("missing alt text");
  });

  it("includes confidence tier", () => {
    const output = formatFindingSummary(makeFinding());
    expect(output).toContain("definitive");
  });

  it("shows 'pending review' when no human_review", () => {
    const output = formatFindingSummary(makeFinding());
    expect(output).toContain("pending review");
  });

  it("shows review details when human_review exists", () => {
    const finding = makeFinding({
      human_review: {
        reviewer: "alice",
        reviewed_at: "2024-06-15T12:00:00Z",
        verdict: "confirmed",
        notes: "Verified",
        severity_override: null,
        remediation_override: null,
      },
    });
    const output = formatFindingSummary(finding);
    expect(output).toContain("confirmed");
    expect(output).toContain("alice");
  });
});

// ---------------------------------------------------------------------------
// formatPendingList tests
// ---------------------------------------------------------------------------

describe("formatPendingList", () => {
  it("shows message for empty list", () => {
    const output = formatPendingList([]);
    expect(output).toContain("No findings pending review");
  });

  it("shows count for non-empty list", () => {
    const findings = [makeFinding(), makeFinding({ id: "f-789" })];
    const output = formatPendingList(findings);
    expect(output).toContain("2 finding(s) pending review");
  });

  it("includes finding ID prefix", () => {
    const output = formatPendingList([makeFinding()]);
    expect(output).toContain("f-123-45");
  });

  it("includes WCAG criterion", () => {
    const output = formatPendingList([makeFinding()]);
    expect(output).toContain("1.1.1");
  });

  it("includes severity", () => {
    const output = formatPendingList([makeFinding()]);
    expect(output).toContain("major");
  });
});

// ---------------------------------------------------------------------------
// formatReviewStats tests
// ---------------------------------------------------------------------------

describe("formatReviewStats", () => {
  it("shows total count", () => {
    const output = formatReviewStats([makeFinding(), makeFinding({ id: "f-2" })]);
    expect(output).toContain("Total findings: 2");
  });

  it("shows reviewed count and percentage", () => {
    const findings = [
      makeFinding(),
      makeFinding({
        id: "f-2",
        human_review: {
          reviewer: "alice", reviewed_at: "2024-01-01T00:00:00Z",
          verdict: "confirmed", notes: "", severity_override: null, remediation_override: null,
        },
      }),
    ];
    const output = formatReviewStats(findings);
    expect(output).toContain("Reviewed: 1 (50%)");
    expect(output).toContain("Pending: 1");
  });

  it("shows 0% when nothing is reviewed", () => {
    const output = formatReviewStats([makeFinding()]);
    expect(output).toContain("Reviewed: 0 (0%)");
  });

  it("shows verdict breakdown", () => {
    const reviewed = makeFinding({
      id: "f-reviewed",
      human_review: {
        reviewer: "bob", reviewed_at: "2024-01-01T00:00:00Z",
        verdict: "false_positive", notes: "", severity_override: null, remediation_override: null,
      },
    });
    const output = formatReviewStats([reviewed]);
    expect(output).toContain("false_positive: 1");
  });

  it("handles empty findings list", () => {
    const output = formatReviewStats([]);
    expect(output).toContain("Total findings: 0");
    expect(output).toContain("Reviewed: 0 (0%)");
  });
});
