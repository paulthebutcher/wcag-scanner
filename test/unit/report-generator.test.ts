import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  groupFindingsByHash,
  computeDiff,
  queryFindings,
  type FindingGroup,
} from "../../src/report/generator.js";
import {
  openDatabase,
  insertScanSession,
  insertPageSnapshot,
  insertFinding,
  upsertScanSummary,
  upsertCriterionResult,
} from "../../src/store/db.js";
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
// Helpers
// ---------------------------------------------------------------------------

function makeEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    element_selector: "#el",
    element_html: "<div></div>",
    element_screenshot: "",
    element_computed_styles: {},
    context_screenshot: "",
    measured_values: {},
    keyboard_sequence: null,
    aria_attributes: {},
    detected_by: "axe_core",
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    method: "rule_based",
    reasoning: "Test reasoning",
    llm_input: null,
    llm_output: null,
    impact_description: "Test impact",
    affected_users: ["screen_reader"],
    ...overrides,
  };
}

function makeConfidence(overrides: Partial<Confidence> = {}): Confidence {
  return {
    score: 0.95,
    tier: "definitive",
    basis: "axe-core rule",
    requires_human: false,
    false_positive_risk: "low",
    ...overrides,
  };
}

function makePlatformFix(): PlatformFix {
  return {
    platform: "webflow",
    platform_version: "",
    steps: [],
    designer_path: "",
    screenshots: [],
    generated_by: "template",
    platform_docs_url: null,
  };
}

function makeRemediation(overrides: Partial<Remediation> = {}): Remediation {
  return {
    generic_fix: "Fix it",
    platform_fix: makePlatformFix(),
    code_fix: null,
    estimated_effort: "minor",
    fix_verified: false,
    ...overrides,
  };
}

let findingCounter = 0;
function makeFinding(overrides: Partial<Finding> = {}): Finding {
  findingCounter++;
  return {
    id: `finding-${findingCounter}`,
    page_snapshot_id: "snap-1",
    interaction_state_id: null,
    wcag_criterion: "1.1.1",
    wcag_level: "A",
    severity: "major",
    category: "images",
    finding_type_hash: "hash-a",
    evidence: makeEvidence(),
    analysis: makeAnalysis(),
    confidence: makeConfidence(),
    remediation: makeRemediation(),
    human_review: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// groupFindingsByHash — pure function tests
// ---------------------------------------------------------------------------

describe("groupFindingsByHash", () => {
  beforeEach(() => { findingCounter = 0; });

  it("groups findings by finding_type_hash", () => {
    const findings = [
      makeFinding({ finding_type_hash: "hash-a", wcag_criterion: "1.1.1" }),
      makeFinding({ finding_type_hash: "hash-a", wcag_criterion: "1.1.1" }),
      makeFinding({ finding_type_hash: "hash-b", wcag_criterion: "2.4.7" }),
    ];

    const groups = groupFindingsByHash(findings);
    expect(groups.length).toBe(2);

    const groupA = groups.find((g) => g.hash === "hash-a")!;
    expect(groupA.instanceCount).toBe(2);
    expect(groupA.criterion).toBe("1.1.1");
    expect(groupA.findings.length).toBe(2);

    const groupB = groups.find((g) => g.hash === "hash-b")!;
    expect(groupB.instanceCount).toBe(1);
  });

  it("extracts failure_type from measured_values", () => {
    const findings = [
      makeFinding({
        finding_type_hash: "hash-x",
        evidence: makeEvidence({
          measured_values: { failure_type: "missing_alt" },
        }),
      }),
    ];

    const groups = groupFindingsByHash(findings);
    expect(groups[0].failureType).toBe("missing_alt");
  });

  it("defaults failure_type to 'unknown' when not in measured_values", () => {
    const findings = [
      makeFinding({ finding_type_hash: "hash-y" }),
    ];

    const groups = groupFindingsByHash(findings);
    expect(groups[0].failureType).toBe("unknown");
  });

  it("sorts by severity (critical first)", () => {
    const findings = [
      makeFinding({ finding_type_hash: "hash-minor", severity: "minor" }),
      makeFinding({ finding_type_hash: "hash-critical", severity: "critical" }),
      makeFinding({ finding_type_hash: "hash-major", severity: "major" }),
    ];

    const groups = groupFindingsByHash(findings);
    expect(groups[0].severity).toBe("critical");
    expect(groups[1].severity).toBe("major");
    expect(groups[2].severity).toBe("minor");
  });

  it("sorts by instance count (descending) when same severity", () => {
    const findings = [
      makeFinding({ finding_type_hash: "hash-few", severity: "major" }),
      makeFinding({ finding_type_hash: "hash-many", severity: "major" }),
      makeFinding({ finding_type_hash: "hash-many", severity: "major" }),
      makeFinding({ finding_type_hash: "hash-many", severity: "major" }),
    ];

    const groups = groupFindingsByHash(findings);
    expect(groups[0].hash).toBe("hash-many");
    expect(groups[0].instanceCount).toBe(3);
    expect(groups[1].hash).toBe("hash-few");
    expect(groups[1].instanceCount).toBe(1);
  });

  it("uses highest severity in group", () => {
    const findings = [
      makeFinding({ finding_type_hash: "hash-mixed", severity: "minor" }),
      makeFinding({ finding_type_hash: "hash-mixed", severity: "critical" }),
    ];

    const groups = groupFindingsByHash(findings);
    expect(groups[0].severity).toBe("critical");
  });

  it("returns empty array for empty findings", () => {
    expect(groupFindingsByHash([])).toEqual([]);
  });

  it("each group includes all individual findings", () => {
    const findings = [
      makeFinding({ id: "f1", finding_type_hash: "hash-a" }),
      makeFinding({ id: "f2", finding_type_hash: "hash-a" }),
      makeFinding({ id: "f3", finding_type_hash: "hash-a" }),
    ];

    const groups = groupFindingsByHash(findings);
    expect(groups[0].findings.length).toBe(3);
    expect(groups[0].findings.map((f) => f.id)).toEqual(["f1", "f2", "f3"]);
  });
});

// ---------------------------------------------------------------------------
// computeDiff — pure function tests
// ---------------------------------------------------------------------------

describe("computeDiff", () => {
  beforeEach(() => { findingCounter = 0; });

  function makeGroup(hash: string, severity: Severity = "major"): FindingGroup {
    return {
      hash,
      criterion: "1.1.1",
      failureType: "test",
      instanceCount: 1,
      severity,
      findings: [makeFinding({ finding_type_hash: hash, severity })],
    };
  }

  it("identifies resolved findings (in old, not in new)", () => {
    const current = [makeGroup("hash-a")];
    const comparison = [makeGroup("hash-a"), makeGroup("hash-b")];

    const diff = computeDiff(current, comparison);
    expect(diff.resolved.length).toBe(1);
    expect(diff.resolved[0].hash).toBe("hash-b");
  });

  it("identifies new findings (in new, not in old)", () => {
    const current = [makeGroup("hash-a"), makeGroup("hash-c")];
    const comparison = [makeGroup("hash-a")];

    const diff = computeDiff(current, comparison);
    expect(diff.newFindings.length).toBe(1);
    expect(diff.newFindings[0].hash).toBe("hash-c");
  });

  it("identifies persistent findings (in both)", () => {
    const current = [makeGroup("hash-a"), makeGroup("hash-b")];
    const comparison = [makeGroup("hash-a"), makeGroup("hash-b")];

    const diff = computeDiff(current, comparison);
    expect(diff.persistent.length).toBe(2);
  });

  it("handles empty current scan", () => {
    const comparison = [makeGroup("hash-a"), makeGroup("hash-b")];
    const diff = computeDiff([], comparison);
    expect(diff.resolved.length).toBe(2);
    expect(diff.newFindings.length).toBe(0);
    expect(diff.persistent.length).toBe(0);
  });

  it("handles empty comparison scan", () => {
    const current = [makeGroup("hash-a")];
    const diff = computeDiff(current, []);
    expect(diff.resolved.length).toBe(0);
    expect(diff.newFindings.length).toBe(1);
    expect(diff.persistent.length).toBe(0);
  });

  it("handles both empty", () => {
    const diff = computeDiff([], []);
    expect(diff.resolved).toEqual([]);
    expect(diff.newFindings).toEqual([]);
    expect(diff.persistent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// queryFindings — integration tests with real SQLite
// ---------------------------------------------------------------------------

describe("queryFindings", () => {
  let db: Database.Database;

  beforeEach(() => {
    findingCounter = 0;
    db = openDatabase(":memory:");

    // Insert a scan session
    insertScanSession(db, {
      id: "scan-1",
      url: "https://example.com",
      platform: "webflow",
      platform_detected_via: "meta_generator",
      initiated_at: "2024-01-01T00:00:00Z",
      completed_at: "2024-01-01T00:01:00Z",
      comparison_scan_id: null,
      scan_type: "initial",
    });

    // Insert a page snapshot
    insertPageSnapshot(db, {
      id: "snap-1",
      scan_session_id: "scan-1",
      url: "https://example.com",
      title: "Example",
      captured_at: "2024-01-01T00:00:30Z",
      full_dom: "<html></html>",
      screenshot: "screenshot.png",
      viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    });
  });

  afterEach(() => {
    db.close();
  });

  it("returns findings grouped by finding_type_hash", () => {
    insertFinding(db, makeFinding({ id: "f1", finding_type_hash: "hash-a" }));
    insertFinding(db, makeFinding({ id: "f2", finding_type_hash: "hash-a" }));
    insertFinding(db, makeFinding({ id: "f3", finding_type_hash: "hash-b" }));

    const report = queryFindings(db, "scan-1");
    expect(report.groups.length).toBe(2);

    const groupA = report.groups.find((g) => g.hash === "hash-a")!;
    expect(groupA.instanceCount).toBe(2);
    expect(groupA.findings.length).toBe(2);
  });

  it("includes scan session in report", () => {
    const report = queryFindings(db, "scan-1");
    expect(report.scanSession.id).toBe("scan-1");
    expect(report.scanSession.url).toBe("https://example.com");
    expect(report.scanSession.platform).toBe("webflow");
  });

  it("includes criterion results", () => {
    upsertCriterionResult(db, {
      scan_session_id: "scan-1",
      wcag_criterion: "1.1.1",
      status: "failed",
      tested_by: "axe_core",
      evidence_summary: "Alt text missing on 3 images",
      finding_ids: ["f1"],
    });
    upsertCriterionResult(db, {
      scan_session_id: "scan-1",
      wcag_criterion: "2.4.1",
      status: "passed",
      tested_by: "playwright",
      evidence_summary: "Skip nav link found",
      finding_ids: [],
    });

    const report = queryFindings(db, "scan-1");
    expect(report.criterionResults.length).toBe(2);
    expect(report.criterionResults[0].wcag_criterion).toBe("1.1.1");
    expect(report.criterionResults[1].wcag_criterion).toBe("2.4.1");
  });

  it("includes scan summary", () => {
    upsertScanSummary(db, {
      scan_session_id: "scan-1",
      total_findings: 5,
      by_severity: { critical: 1, major: 2, minor: 1, advisory: 1 },
      by_confidence: { definitive: 3, high: 1, moderate: 1, needs_review: 0 },
      by_category: { contrast: 1, semantics: 0, keyboard: 1, forms: 1, images: 2, aria: 0, structure: 0 },
      human_reviewed_pct: 0,
      estimated_total_effort: "2-4 hours",
      wcag_criteria_failed: ["1.1.1", "2.4.7"],
      wcag_criteria_passed: ["2.4.1", "3.1.1"],
    });

    const report = queryFindings(db, "scan-1");
    expect(report.summary).not.toBeNull();
    expect(report.summary!.total_findings).toBe(5);
    expect(report.summary!.by_severity.critical).toBe(1);
  });

  it("returns null summary when none exists", () => {
    const report = queryFindings(db, "scan-1");
    expect(report.summary).toBeNull();
  });

  it("sorts groups by severity then instance count", () => {
    insertFinding(db, makeFinding({
      id: "f1", finding_type_hash: "hash-minor", severity: "minor",
      wcag_criterion: "2.4.6",
    }));
    insertFinding(db, makeFinding({
      id: "f2", finding_type_hash: "hash-critical", severity: "critical",
      wcag_criterion: "2.1.1",
    }));
    insertFinding(db, makeFinding({
      id: "f3", finding_type_hash: "hash-major-many", severity: "major",
      wcag_criterion: "1.1.1",
    }));
    insertFinding(db, makeFinding({
      id: "f4", finding_type_hash: "hash-major-many", severity: "major",
      wcag_criterion: "1.1.1",
    }));
    insertFinding(db, makeFinding({
      id: "f5", finding_type_hash: "hash-major-few", severity: "major",
      wcag_criterion: "2.4.7",
    }));

    const report = queryFindings(db, "scan-1");
    expect(report.groups[0].severity).toBe("critical");
    expect(report.groups[1].severity).toBe("major");
    expect(report.groups[1].instanceCount).toBe(2); // many first
    expect(report.groups[2].severity).toBe("major");
    expect(report.groups[2].instanceCount).toBe(1);
    expect(report.groups[3].severity).toBe("minor");
  });

  it("computes diff when comparison_scan_id is set", () => {
    // Insert comparison scan
    insertScanSession(db, {
      id: "scan-old",
      url: "https://example.com",
      platform: "webflow",
      platform_detected_via: "meta_generator",
      initiated_at: "2023-12-01T00:00:00Z",
      completed_at: "2023-12-01T00:01:00Z",
      comparison_scan_id: null,
      scan_type: "initial",
    });
    insertPageSnapshot(db, {
      id: "snap-old",
      scan_session_id: "scan-old",
      url: "https://example.com",
      title: "Example",
      captured_at: "2023-12-01T00:00:30Z",
      full_dom: "<html></html>",
      screenshot: "screenshot.png",
      viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    });

    // Update current scan to link to comparison
    db.prepare("UPDATE scan_sessions SET comparison_scan_id = 'scan-old' WHERE id = 'scan-1'").run();

    // Old scan has hash-a (will be resolved) and hash-b (persistent)
    insertFinding(db, makeFinding({
      id: "old-f1", page_snapshot_id: "snap-old",
      finding_type_hash: "hash-resolved", severity: "major",
    }));
    insertFinding(db, makeFinding({
      id: "old-f2", page_snapshot_id: "snap-old",
      finding_type_hash: "hash-persistent", severity: "minor",
    }));

    // New scan has hash-b (persistent) and hash-c (new)
    insertFinding(db, makeFinding({
      id: "new-f1", page_snapshot_id: "snap-1",
      finding_type_hash: "hash-persistent", severity: "minor",
    }));
    insertFinding(db, makeFinding({
      id: "new-f2", page_snapshot_id: "snap-1",
      finding_type_hash: "hash-new", severity: "critical",
    }));

    const report = queryFindings(db, "scan-1");
    expect(report.diff).not.toBeNull();
    expect(report.diff!.resolved.length).toBe(1);
    expect(report.diff!.resolved[0].hash).toBe("hash-resolved");
    expect(report.diff!.newFindings.length).toBe(1);
    expect(report.diff!.newFindings[0].hash).toBe("hash-new");
    expect(report.diff!.persistent.length).toBe(1);
    expect(report.diff!.persistent[0].hash).toBe("hash-persistent");
  });

  it("returns null diff when no comparison scan", () => {
    const report = queryFindings(db, "scan-1");
    expect(report.diff).toBeNull();
  });

  it("throws when scan session not found", () => {
    expect(() => queryFindings(db, "nonexistent")).toThrow("Scan session not found");
  });

  it("handles scan with no findings", () => {
    const report = queryFindings(db, "scan-1");
    expect(report.groups).toEqual([]);
  });

  it("each group has correct criterion from its findings", () => {
    insertFinding(db, makeFinding({
      id: "f1", finding_type_hash: "hash-img", wcag_criterion: "1.1.1",
    }));
    insertFinding(db, makeFinding({
      id: "f2", finding_type_hash: "hash-kb", wcag_criterion: "2.1.1",
    }));

    const report = queryFindings(db, "scan-1");
    const imgGroup = report.groups.find((g) => g.hash === "hash-img")!;
    expect(imgGroup.criterion).toBe("1.1.1");
    const kbGroup = report.groups.find((g) => g.hash === "hash-kb")!;
    expect(kbGroup.criterion).toBe("2.1.1");
  });
});
