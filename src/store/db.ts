import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ScanSession,
  PageSnapshot,
  InteractionState,
  Finding,
  Evidence,
  Analysis,
  Confidence,
  Remediation,
  HumanReview,
  ScanSummary,
  CriterionResult,
  Viewport,
  InteractionTrigger,
} from "../types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scan_sessions (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  platform TEXT NOT NULL,
  platform_detected_via TEXT NOT NULL,
  initiated_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  comparison_scan_id TEXT,
  scan_type TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS page_snapshots (
  id TEXT PRIMARY KEY,
  scan_session_id TEXT NOT NULL REFERENCES scan_sessions(id),
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  full_dom TEXT NOT NULL,
  screenshot TEXT NOT NULL,
  viewport_width INTEGER NOT NULL,
  viewport_height INTEGER NOT NULL,
  viewport_scale REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS interaction_states (
  id TEXT PRIMARY KEY,
  page_snapshot_id TEXT NOT NULL REFERENCES page_snapshots(id),
  trigger TEXT NOT NULL,
  dom_diff TEXT NOT NULL,
  screenshot TEXT NOT NULL,
  new_elements_visible TEXT NOT NULL,
  focus_element TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  page_snapshot_id TEXT NOT NULL REFERENCES page_snapshots(id),
  interaction_state_id TEXT REFERENCES interaction_states(id),
  wcag_criterion TEXT NOT NULL,
  wcag_level TEXT NOT NULL,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  finding_type_hash TEXT NOT NULL,
  evidence TEXT NOT NULL,
  analysis TEXT NOT NULL,
  confidence TEXT NOT NULL,
  remediation TEXT NOT NULL,
  human_review TEXT
);

CREATE TABLE IF NOT EXISTS scan_summaries (
  scan_session_id TEXT PRIMARY KEY REFERENCES scan_sessions(id),
  total_findings INTEGER NOT NULL,
  by_severity TEXT NOT NULL,
  by_confidence TEXT NOT NULL,
  by_category TEXT NOT NULL,
  human_reviewed_pct REAL NOT NULL,
  estimated_total_effort TEXT NOT NULL,
  wcag_criteria_failed TEXT NOT NULL,
  wcag_criteria_passed TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS criterion_results (
  scan_session_id TEXT NOT NULL REFERENCES scan_sessions(id),
  wcag_criterion TEXT NOT NULL,
  status TEXT NOT NULL,
  tested_by TEXT NOT NULL,
  evidence_summary TEXT NOT NULL,
  finding_ids TEXT NOT NULL,
  PRIMARY KEY (scan_session_id, wcag_criterion)
);

CREATE INDEX IF NOT EXISTS idx_page_snapshots_scan ON page_snapshots(scan_session_id);
CREATE INDEX IF NOT EXISTS idx_interaction_states_page ON interaction_states(page_snapshot_id);
CREATE INDEX IF NOT EXISTS idx_findings_page ON findings(page_snapshot_id);
CREATE INDEX IF NOT EXISTS idx_findings_hash ON findings(finding_type_hash);
CREATE INDEX IF NOT EXISTS idx_findings_criterion ON findings(wcag_criterion);
CREATE INDEX IF NOT EXISTS idx_findings_severity ON findings(severity);
CREATE INDEX IF NOT EXISTS idx_criterion_results_scan ON criterion_results(scan_session_id);
`;

// ---------------------------------------------------------------------------
// Database connection
// ---------------------------------------------------------------------------

export function openDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

// ---------------------------------------------------------------------------
// ScanSession CRUD
// ---------------------------------------------------------------------------

export function insertScanSession(db: Database.Database, session: ScanSession): void {
  db.prepare(`
    INSERT INTO scan_sessions (id, url, platform, platform_detected_via, initiated_at, completed_at, comparison_scan_id, scan_type)
    VALUES (@id, @url, @platform, @platform_detected_via, @initiated_at, @completed_at, @comparison_scan_id, @scan_type)
  `).run(session);
}

export function getScanSession(db: Database.Database, id: string): ScanSession | undefined {
  return db.prepare("SELECT * FROM scan_sessions WHERE id = ?").get(id) as ScanSession | undefined;
}

export function updateScanSession(
  db: Database.Database,
  id: string,
  updates: Partial<Pick<ScanSession, "completed_at" | "platform" | "platform_detected_via" | "comparison_scan_id">>,
): void {
  const fields = Object.keys(updates) as (keyof typeof updates)[];
  if (fields.length === 0) return;
  const sets = fields.map((f) => `${f} = @${f}`).join(", ");
  db.prepare(`UPDATE scan_sessions SET ${sets} WHERE id = @id`).run({ id, ...updates });
}

export function listScanSessions(db: Database.Database): ScanSession[] {
  return db.prepare("SELECT * FROM scan_sessions ORDER BY initiated_at DESC").all() as ScanSession[];
}

// ---------------------------------------------------------------------------
// PageSnapshot CRUD
// ---------------------------------------------------------------------------

function snapshotToRow(snapshot: PageSnapshot) {
  return {
    id: snapshot.id,
    scan_session_id: snapshot.scan_session_id,
    url: snapshot.url,
    title: snapshot.title,
    captured_at: snapshot.captured_at,
    full_dom: snapshot.full_dom,
    screenshot: snapshot.screenshot,
    viewport_width: snapshot.viewport.width,
    viewport_height: snapshot.viewport.height,
    viewport_scale: snapshot.viewport.deviceScaleFactor,
  };
}

function rowToSnapshot(row: Record<string, unknown>): PageSnapshot {
  return {
    id: row.id as string,
    scan_session_id: row.scan_session_id as string,
    url: row.url as string,
    title: row.title as string,
    captured_at: row.captured_at as string,
    full_dom: row.full_dom as string,
    screenshot: row.screenshot as string,
    viewport: {
      width: row.viewport_width as number,
      height: row.viewport_height as number,
      deviceScaleFactor: row.viewport_scale as number,
    },
  };
}

export function insertPageSnapshot(db: Database.Database, snapshot: PageSnapshot): void {
  db.prepare(`
    INSERT INTO page_snapshots (id, scan_session_id, url, title, captured_at, full_dom, screenshot, viewport_width, viewport_height, viewport_scale)
    VALUES (@id, @scan_session_id, @url, @title, @captured_at, @full_dom, @screenshot, @viewport_width, @viewport_height, @viewport_scale)
  `).run(snapshotToRow(snapshot));
}

export function getPageSnapshot(db: Database.Database, id: string): PageSnapshot | undefined {
  const row = db.prepare("SELECT * FROM page_snapshots WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToSnapshot(row) : undefined;
}

export function listPageSnapshots(db: Database.Database, scanSessionId: string): PageSnapshot[] {
  const rows = db.prepare("SELECT * FROM page_snapshots WHERE scan_session_id = ? ORDER BY captured_at").all(scanSessionId) as Record<string, unknown>[];
  return rows.map(rowToSnapshot);
}

// ---------------------------------------------------------------------------
// InteractionState CRUD
// ---------------------------------------------------------------------------

function interactionToRow(state: InteractionState) {
  return {
    id: state.id,
    page_snapshot_id: state.page_snapshot_id,
    trigger: JSON.stringify(state.trigger),
    dom_diff: state.dom_diff,
    screenshot: state.screenshot,
    new_elements_visible: JSON.stringify(state.new_elements_visible),
    focus_element: state.focus_element,
  };
}

function rowToInteraction(row: Record<string, unknown>): InteractionState {
  return {
    id: row.id as string,
    page_snapshot_id: row.page_snapshot_id as string,
    trigger: JSON.parse(row.trigger as string) as InteractionTrigger,
    dom_diff: row.dom_diff as string,
    screenshot: row.screenshot as string,
    new_elements_visible: JSON.parse(row.new_elements_visible as string) as string[],
    focus_element: row.focus_element as string,
  };
}

export function insertInteractionState(db: Database.Database, state: InteractionState): void {
  db.prepare(`
    INSERT INTO interaction_states (id, page_snapshot_id, trigger, dom_diff, screenshot, new_elements_visible, focus_element)
    VALUES (@id, @page_snapshot_id, @trigger, @dom_diff, @screenshot, @new_elements_visible, @focus_element)
  `).run(interactionToRow(state));
}

export function getInteractionState(db: Database.Database, id: string): InteractionState | undefined {
  const row = db.prepare("SELECT * FROM interaction_states WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToInteraction(row) : undefined;
}

export function listInteractionStates(db: Database.Database, pageSnapshotId: string): InteractionState[] {
  const rows = db.prepare("SELECT * FROM interaction_states WHERE page_snapshot_id = ?").all(pageSnapshotId) as Record<string, unknown>[];
  return rows.map(rowToInteraction);
}

// ---------------------------------------------------------------------------
// Finding CRUD
// ---------------------------------------------------------------------------

function findingToRow(finding: Finding) {
  return {
    id: finding.id,
    page_snapshot_id: finding.page_snapshot_id,
    interaction_state_id: finding.interaction_state_id,
    wcag_criterion: finding.wcag_criterion,
    wcag_level: finding.wcag_level,
    severity: finding.severity,
    category: finding.category,
    finding_type_hash: finding.finding_type_hash,
    evidence: JSON.stringify(finding.evidence),
    analysis: JSON.stringify(finding.analysis),
    confidence: JSON.stringify(finding.confidence),
    remediation: JSON.stringify(finding.remediation),
    human_review: finding.human_review ? JSON.stringify(finding.human_review) : null,
  };
}

function rowToFinding(row: Record<string, unknown>): Finding {
  return {
    id: row.id as string,
    page_snapshot_id: row.page_snapshot_id as string,
    interaction_state_id: (row.interaction_state_id as string) || null,
    wcag_criterion: row.wcag_criterion as string,
    wcag_level: row.wcag_level as Finding["wcag_level"],
    severity: row.severity as Finding["severity"],
    category: row.category as Finding["category"],
    finding_type_hash: row.finding_type_hash as string,
    evidence: JSON.parse(row.evidence as string) as Evidence,
    analysis: JSON.parse(row.analysis as string) as Analysis,
    confidence: JSON.parse(row.confidence as string) as Confidence,
    remediation: JSON.parse(row.remediation as string) as Remediation,
    human_review: row.human_review ? JSON.parse(row.human_review as string) as HumanReview : null,
  };
}

export function insertFinding(db: Database.Database, finding: Finding): void {
  db.prepare(`
    INSERT INTO findings (id, page_snapshot_id, interaction_state_id, wcag_criterion, wcag_level, severity, category, finding_type_hash, evidence, analysis, confidence, remediation, human_review)
    VALUES (@id, @page_snapshot_id, @interaction_state_id, @wcag_criterion, @wcag_level, @severity, @category, @finding_type_hash, @evidence, @analysis, @confidence, @remediation, @human_review)
  `).run(findingToRow(finding));
}

export function getFinding(db: Database.Database, id: string): Finding | undefined {
  const row = db.prepare("SELECT * FROM findings WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToFinding(row) : undefined;
}

export function listFindings(db: Database.Database, pageSnapshotId: string): Finding[] {
  const rows = db.prepare("SELECT * FROM findings WHERE page_snapshot_id = ?").all(pageSnapshotId) as Record<string, unknown>[];
  return rows.map(rowToFinding);
}

export function listFindingsByScan(db: Database.Database, scanSessionId: string): Finding[] {
  const rows = db.prepare(`
    SELECT f.* FROM findings f
    JOIN page_snapshots p ON f.page_snapshot_id = p.id
    WHERE p.scan_session_id = ?
    ORDER BY
      CASE f.severity WHEN 'critical' THEN 0 WHEN 'major' THEN 1 WHEN 'minor' THEN 2 WHEN 'advisory' THEN 3 END,
      f.wcag_criterion
  `).all(scanSessionId) as Record<string, unknown>[];
  return rows.map(rowToFinding);
}

export function listFindingsByHash(db: Database.Database, findingTypeHash: string): Finding[] {
  const rows = db.prepare("SELECT * FROM findings WHERE finding_type_hash = ?").all(findingTypeHash) as Record<string, unknown>[];
  return rows.map(rowToFinding);
}

/**
 * Update mutable sub-entities on a Finding. Evidence is immutable and cannot be updated.
 */
export function updateFinding(
  db: Database.Database,
  id: string,
  updates: Partial<Pick<Finding, "analysis" | "confidence" | "remediation" | "human_review" | "severity">>,
): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };

  if (updates.analysis !== undefined) {
    sets.push("analysis = @analysis");
    params.analysis = JSON.stringify(updates.analysis);
  }
  if (updates.confidence !== undefined) {
    sets.push("confidence = @confidence");
    params.confidence = JSON.stringify(updates.confidence);
  }
  if (updates.remediation !== undefined) {
    sets.push("remediation = @remediation");
    params.remediation = JSON.stringify(updates.remediation);
  }
  if (updates.human_review !== undefined) {
    sets.push("human_review = @human_review");
    params.human_review = updates.human_review ? JSON.stringify(updates.human_review) : null;
  }
  if (updates.severity !== undefined) {
    sets.push("severity = @severity");
    params.severity = updates.severity;
  }

  if (sets.length === 0) return;
  db.prepare(`UPDATE findings SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

// ---------------------------------------------------------------------------
// ScanSummary CRUD
// ---------------------------------------------------------------------------

function summaryToRow(summary: ScanSummary) {
  return {
    scan_session_id: summary.scan_session_id,
    total_findings: summary.total_findings,
    by_severity: JSON.stringify(summary.by_severity),
    by_confidence: JSON.stringify(summary.by_confidence),
    by_category: JSON.stringify(summary.by_category),
    human_reviewed_pct: summary.human_reviewed_pct,
    estimated_total_effort: summary.estimated_total_effort,
    wcag_criteria_failed: JSON.stringify(summary.wcag_criteria_failed),
    wcag_criteria_passed: JSON.stringify(summary.wcag_criteria_passed),
  };
}

function rowToSummary(row: Record<string, unknown>): ScanSummary {
  return {
    scan_session_id: row.scan_session_id as string,
    total_findings: row.total_findings as number,
    by_severity: JSON.parse(row.by_severity as string) as ScanSummary["by_severity"],
    by_confidence: JSON.parse(row.by_confidence as string) as ScanSummary["by_confidence"],
    by_category: JSON.parse(row.by_category as string) as ScanSummary["by_category"],
    human_reviewed_pct: row.human_reviewed_pct as number,
    estimated_total_effort: row.estimated_total_effort as string,
    wcag_criteria_failed: JSON.parse(row.wcag_criteria_failed as string) as string[],
    wcag_criteria_passed: JSON.parse(row.wcag_criteria_passed as string) as string[],
  };
}

export function upsertScanSummary(db: Database.Database, summary: ScanSummary): void {
  db.prepare(`
    INSERT INTO scan_summaries (scan_session_id, total_findings, by_severity, by_confidence, by_category, human_reviewed_pct, estimated_total_effort, wcag_criteria_failed, wcag_criteria_passed)
    VALUES (@scan_session_id, @total_findings, @by_severity, @by_confidence, @by_category, @human_reviewed_pct, @estimated_total_effort, @wcag_criteria_failed, @wcag_criteria_passed)
    ON CONFLICT(scan_session_id) DO UPDATE SET
      total_findings = excluded.total_findings,
      by_severity = excluded.by_severity,
      by_confidence = excluded.by_confidence,
      by_category = excluded.by_category,
      human_reviewed_pct = excluded.human_reviewed_pct,
      estimated_total_effort = excluded.estimated_total_effort,
      wcag_criteria_failed = excluded.wcag_criteria_failed,
      wcag_criteria_passed = excluded.wcag_criteria_passed
  `).run(summaryToRow(summary));
}

export function getScanSummary(db: Database.Database, scanSessionId: string): ScanSummary | undefined {
  const row = db.prepare("SELECT * FROM scan_summaries WHERE scan_session_id = ?").get(scanSessionId) as Record<string, unknown> | undefined;
  return row ? rowToSummary(row) : undefined;
}

// ---------------------------------------------------------------------------
// CriterionResult CRUD
// ---------------------------------------------------------------------------

function criterionToRow(result: CriterionResult) {
  return {
    scan_session_id: result.scan_session_id,
    wcag_criterion: result.wcag_criterion,
    status: result.status,
    tested_by: result.tested_by,
    evidence_summary: result.evidence_summary,
    finding_ids: JSON.stringify(result.finding_ids),
  };
}

function rowToCriterion(row: Record<string, unknown>): CriterionResult {
  return {
    scan_session_id: row.scan_session_id as string,
    wcag_criterion: row.wcag_criterion as string,
    status: row.status as CriterionResult["status"],
    tested_by: row.tested_by as CriterionResult["tested_by"],
    evidence_summary: row.evidence_summary as string,
    finding_ids: JSON.parse(row.finding_ids as string) as string[],
  };
}

export function upsertCriterionResult(db: Database.Database, result: CriterionResult): void {
  db.prepare(`
    INSERT INTO criterion_results (scan_session_id, wcag_criterion, status, tested_by, evidence_summary, finding_ids)
    VALUES (@scan_session_id, @wcag_criterion, @status, @tested_by, @evidence_summary, @finding_ids)
    ON CONFLICT(scan_session_id, wcag_criterion) DO UPDATE SET
      status = excluded.status,
      tested_by = excluded.tested_by,
      evidence_summary = excluded.evidence_summary,
      finding_ids = excluded.finding_ids
  `).run(criterionToRow(result));
}

export function getCriterionResult(db: Database.Database, scanSessionId: string, wcagCriterion: string): CriterionResult | undefined {
  const row = db.prepare("SELECT * FROM criterion_results WHERE scan_session_id = ? AND wcag_criterion = ?").get(scanSessionId, wcagCriterion) as Record<string, unknown> | undefined;
  return row ? rowToCriterion(row) : undefined;
}

export function listCriterionResults(db: Database.Database, scanSessionId: string): CriterionResult[] {
  const rows = db.prepare("SELECT * FROM criterion_results WHERE scan_session_id = ? ORDER BY wcag_criterion").all(scanSessionId) as Record<string, unknown>[];
  return rows.map(rowToCriterion);
}
