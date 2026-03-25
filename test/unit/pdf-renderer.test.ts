import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildReportDataWithComparison,
  buildPageUrlMap,
  htmlToPdf,
} from "../../src/report/pdf-renderer.js";
import { renderHtmlReport } from "../../src/report/templates/html-template.js";
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
  Evidence,
  Analysis,
  Confidence,
  Remediation,
  PlatformFix,
  ScanSummary,
  Severity,
} from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    element_selector: "#el", element_html: "<div></div>", element_screenshot: "",
    element_computed_styles: {}, context_screenshot: "", measured_values: {},
    keyboard_sequence: null, aria_attributes: {}, detected_by: "axe_core", ...overrides,
  };
}

function makeAnalysis(): Analysis {
  return { method: "rule_based", reasoning: "Test", llm_input: null, llm_output: null, impact_description: "Impact", affected_users: ["screen_reader"] };
}

function makeConfidence(): Confidence {
  return { score: 0.95, tier: "definitive", basis: "axe", requires_human: false, false_positive_risk: "low" };
}

function makePlatformFix(): PlatformFix {
  return { platform: "webflow", platform_version: "", steps: [], designer_path: "", screenshots: [], generated_by: "template", platform_docs_url: null };
}

function makeRemediation(): Remediation {
  return { generic_fix: "Fix it", platform_fix: makePlatformFix(), code_fix: null, estimated_effort: "minor", fix_verified: false };
}

let cnt = 0;
function makeFinding(overrides: Partial<Finding> = {}): Finding {
  cnt++;
  return {
    id: `finding-${cnt}`, page_snapshot_id: "snap-1", interaction_state_id: null,
    wcag_criterion: "1.1.1", wcag_level: "A", severity: "major", category: "images",
    finding_type_hash: "hash-a", evidence: makeEvidence(), analysis: makeAnalysis(),
    confidence: makeConfidence(), remediation: makeRemediation(), human_review: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Database test setup
// ---------------------------------------------------------------------------

describe("buildReportDataWithComparison", () => {
  let db: Database.Database;

  beforeEach(() => {
    cnt = 0;
    db = openDatabase(":memory:");

    insertScanSession(db, {
      id: "scan-new", url: "https://example.com", platform: "webflow",
      platform_detected_via: "meta_generator", initiated_at: "2024-06-15T10:00:00Z",
      completed_at: "2024-06-15T10:05:00Z", comparison_scan_id: null, scan_type: "initial",
    });
    insertPageSnapshot(db, {
      id: "snap-1", scan_session_id: "scan-new", url: "https://example.com",
      title: "Example", captured_at: "2024-06-15T10:00:30Z", full_dom: "<html></html>",
      screenshot: "s.png", viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    });
  });

  afterEach(() => { db.close(); });

  it("returns report data for a single scan", () => {
    insertFinding(db, makeFinding({ id: "f1", finding_type_hash: "hash-a", wcag_criterion: "1.1.1" }));
    insertFinding(db, makeFinding({ id: "f2", finding_type_hash: "hash-b", severity: "critical", wcag_criterion: "2.4.7" }));

    const data = buildReportDataWithComparison(db, "scan-new");
    expect(data.groups.length).toBe(2);
    expect(data.diff).toBeNull();
  });

  it("computes diff when comparison scan provided", () => {
    insertScanSession(db, {
      id: "scan-old", url: "https://example.com", platform: "webflow",
      platform_detected_via: "meta_generator", initiated_at: "2024-05-01T10:00:00Z",
      completed_at: "2024-05-01T10:05:00Z", comparison_scan_id: null, scan_type: "initial",
    });
    insertPageSnapshot(db, {
      id: "snap-old", scan_session_id: "scan-old", url: "https://example.com",
      title: "Example", captured_at: "2024-05-01T10:00:30Z", full_dom: "<html></html>",
      screenshot: "s.png", viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    });

    // Old scan: hash-resolved + hash-persistent (distinct criteria so dedup doesn't merge)
    insertFinding(db, makeFinding({ id: "old-1", page_snapshot_id: "snap-old", finding_type_hash: "hash-resolved", wcag_criterion: "1.4.3" }));
    insertFinding(db, makeFinding({ id: "old-2", page_snapshot_id: "snap-old", finding_type_hash: "hash-persistent", wcag_criterion: "2.4.7" }));

    // New scan: hash-persistent + hash-new
    insertFinding(db, makeFinding({ id: "new-1", finding_type_hash: "hash-persistent", wcag_criterion: "2.4.7" }));
    insertFinding(db, makeFinding({ id: "new-2", finding_type_hash: "hash-new", severity: "critical", wcag_criterion: "2.1.1" }));

    const data = buildReportDataWithComparison(db, "scan-new", "scan-old");
    expect(data.diff).not.toBeNull();
    expect(data.diff!.resolved.length).toBe(1);
    expect(data.diff!.newFindings.length).toBe(1);
    expect(data.diff!.persistent.length).toBe(1);
  });

  it("sets comparison_scan_id on session", () => {
    insertScanSession(db, {
      id: "scan-old-2", url: "https://example.com", platform: "webflow",
      platform_detected_via: "meta_generator", initiated_at: "2024-05-01T10:00:00Z",
      completed_at: "2024-05-01T10:05:00Z", comparison_scan_id: null, scan_type: "initial",
    });
    insertPageSnapshot(db, {
      id: "snap-old-2", scan_session_id: "scan-old-2", url: "https://example.com",
      title: "Example", captured_at: "2024-05-01T10:00:30Z", full_dom: "<html></html>",
      screenshot: "s.png", viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    });

    const data = buildReportDataWithComparison(db, "scan-new", "scan-old-2");
    expect(data.scanSession.comparison_scan_id).toBe("scan-old-2");
  });

  it("throws when comparison scan not found", () => {
    expect(() => buildReportDataWithComparison(db, "scan-new", "nonexistent")).toThrow("Comparison scan not found");
  });

  it("filters findings by severity", () => {
    insertFinding(db, makeFinding({ id: "f1", finding_type_hash: "hash-crit", severity: "critical" }));
    insertFinding(db, makeFinding({ id: "f2", finding_type_hash: "hash-minor", severity: "minor" }));
    insertFinding(db, makeFinding({ id: "f3", finding_type_hash: "hash-adv", severity: "advisory" }));

    const data = buildReportDataWithComparison(db, "scan-new", undefined, ["critical", "major"]);
    expect(data.groups.length).toBe(1);
    expect(data.groups[0].severity).toBe("critical");
  });

  it("filters severity within groups", () => {
    insertFinding(db, makeFinding({ id: "f1", finding_type_hash: "hash-mixed", severity: "critical" }));
    insertFinding(db, makeFinding({ id: "f2", finding_type_hash: "hash-mixed", severity: "minor" }));

    const data = buildReportDataWithComparison(db, "scan-new", undefined, ["critical"]);
    expect(data.groups.length).toBe(1);
    expect(data.groups[0].instanceCount).toBe(1);
    expect(data.groups[0].findings[0].severity).toBe("critical");
  });
});

// ---------------------------------------------------------------------------
// buildPageUrlMap
// ---------------------------------------------------------------------------

describe("buildPageUrlMap", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    insertScanSession(db, {
      id: "scan-1", url: "https://example.com", platform: "webflow",
      platform_detected_via: "meta_generator", initiated_at: "2024-06-15T10:00:00Z",
      completed_at: "2024-06-15T10:05:00Z", comparison_scan_id: null, scan_type: "initial",
    });
    insertPageSnapshot(db, {
      id: "snap-1", scan_session_id: "scan-1", url: "https://example.com",
      title: "Home", captured_at: "2024-06-15T10:00:30Z", full_dom: "<html></html>",
      screenshot: "s.png", viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    });
    insertPageSnapshot(db, {
      id: "snap-2", scan_session_id: "scan-1", url: "https://example.com/about",
      title: "About", captured_at: "2024-06-15T10:00:45Z", full_dom: "<html></html>",
      screenshot: "s2.png", viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    });
  });

  afterEach(() => { db.close(); });

  it("maps snapshot IDs to URLs", () => {
    const map = buildPageUrlMap(db, "scan-1");
    expect(map.size).toBe(2);
    expect(map.get("snap-1")).toBe("https://example.com");
    expect(map.get("snap-2")).toBe("https://example.com/about");
  });
});

// ---------------------------------------------------------------------------
// htmlToPdf — integration test
// ---------------------------------------------------------------------------

describe("htmlToPdf", () => {
  const outPath = join(tmpdir(), `wcag-test-${Date.now()}.pdf`);

  afterEach(() => {
    if (existsSync(outPath)) unlinkSync(outPath);
  });

  it("renders HTML to PDF file", async () => {
    const html = `<!DOCTYPE html><html><head><title>Test</title></head>
      <body><h1>WCAG Test Report</h1><p>Hello world</p></body></html>`;

    const result = await htmlToPdf(html, outPath);
    expect(result).toBe(outPath);
    expect(existsSync(outPath)).toBe(true);
  }, 30000);

  it("creates a non-empty PDF file", async () => {
    const html = `<!DOCTYPE html><html><head><title>Test</title></head>
      <body><h1>Report</h1></body></html>`;

    await htmlToPdf(html, outPath);
    const { statSync } = await import("node:fs");
    const stat = statSync(outPath);
    expect(stat.size).toBeGreaterThan(100);
  }, 30000);
});

// ---------------------------------------------------------------------------
// Diff badge rendering (via HTML template)
// ---------------------------------------------------------------------------

describe("before/after report rendering", () => {
  let db: Database.Database;

  beforeEach(() => {
    cnt = 0;
    db = openDatabase(":memory:");

    insertScanSession(db, {
      id: "scan-old", url: "https://example.com", platform: "webflow",
      platform_detected_via: "meta_generator", initiated_at: "2024-05-01T10:00:00Z",
      completed_at: "2024-05-01T10:05:00Z", comparison_scan_id: null, scan_type: "initial",
    });
    insertPageSnapshot(db, {
      id: "snap-old", scan_session_id: "scan-old", url: "https://example.com",
      title: "Example", captured_at: "2024-05-01T10:00:30Z", full_dom: "<html></html>",
      screenshot: "s.png", viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    });

    insertScanSession(db, {
      id: "scan-new", url: "https://example.com", platform: "webflow",
      platform_detected_via: "meta_generator", initiated_at: "2024-06-15T10:00:00Z",
      completed_at: "2024-06-15T10:05:00Z", comparison_scan_id: null, scan_type: "rescan",
    });
    insertPageSnapshot(db, {
      id: "snap-new", scan_session_id: "scan-new", url: "https://example.com",
      title: "Example", captured_at: "2024-06-15T10:00:30Z", full_dom: "<html></html>",
      screenshot: "s.png", viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    });

    // Old: hash-resolved, hash-persistent (distinct criteria to avoid merge)
    insertFinding(db, makeFinding({ id: "o1", page_snapshot_id: "snap-old", finding_type_hash: "hash-resolved", wcag_criterion: "1.4.3" }));
    insertFinding(db, makeFinding({ id: "o2", page_snapshot_id: "snap-old", finding_type_hash: "hash-persistent", wcag_criterion: "2.4.7" }));

    // New: hash-persistent, hash-new
    insertFinding(db, makeFinding({ id: "n1", page_snapshot_id: "snap-new", finding_type_hash: "hash-persistent", wcag_criterion: "2.4.7" }));
    insertFinding(db, makeFinding({ id: "n2", page_snapshot_id: "snap-new", finding_type_hash: "hash-new", severity: "critical", wcag_criterion: "2.1.1" }));
  });

  afterEach(() => { db.close(); });

  it("buildReportDataWithComparison classifies findings correctly", () => {
    const data = buildReportDataWithComparison(db, "scan-new", "scan-old");

    expect(data.diff).not.toBeNull();
    expect(data.diff!.resolved.length).toBe(1);
    expect(data.diff!.newFindings.length).toBe(1);
    expect(data.diff!.persistent.length).toBe(1);
  });

  it("report header shows scan date and diff summary", () => {
    const data = buildReportDataWithComparison(db, "scan-new", "scan-old");
    const html = renderHtmlReport(data);

    expect(html).toContain("June 15, 2024"); // new scan date
    expect(html).toContain("Changes Since Previous Scan"); // diff summary section
  });

  it("resolved findings get Fixed badge", () => {
    const data = buildReportDataWithComparison(db, "scan-new", "scan-old");
    const html = renderHtmlReport(data);

    expect(html).toContain("Fixed");
  });

  it("new findings get New badge", () => {
    const data = buildReportDataWithComparison(db, "scan-new", "scan-old");
    const html = renderHtmlReport(data);

    expect(html).toContain(">New<");
  });
});
