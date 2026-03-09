import type Database from "better-sqlite3";
import type {
  Finding,
  ScanSession,
  ScanSummary,
  CriterionResult,
  Severity,
} from "../types.js";
import {
  getScanSession,
  getScanSummary,
  listCriterionResults,
  listFindingsByScan,
} from "../store/db.js";
import { WebflowAdapter, getRemediationTemplate } from "../adapters/webflow.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A group of findings sharing the same finding_type_hash */
export interface FindingGroup {
  /** The shared finding_type_hash */
  hash: string;
  /** WCAG criterion code, e.g. "1.1.1" */
  criterion: string;
  /** Failure type extracted from the first finding's measured_values */
  failureType: string;
  /** Number of individual instances */
  instanceCount: number;
  /** Highest severity in the group */
  severity: Severity;
  /** All individual findings in this group */
  findings: Finding[];
}

/** Complete report data returned by queryFindings */
export interface ReportData {
  /** Scan session metadata */
  scanSession: ScanSession;
  /** Findings grouped by finding_type_hash, sorted by severity then count */
  groups: FindingGroup[];
  /** Criterion results (pass/fail/not_tested for each criterion) */
  criterionResults: CriterionResult[];
  /** Aggregated scan summary */
  summary: ScanSummary | null;
  /** Diff against comparison scan (if comparison_scan_id present) */
  diff: ScanDiff | null;
}

/** Diff between two scans */
export interface ScanDiff {
  /** Finding groups that existed in old scan but not in new (fixed) */
  resolved: FindingGroup[];
  /** Finding groups that exist in new scan but not in old (newly introduced) */
  newFindings: FindingGroup[];
  /** Finding groups present in both scans (still open) */
  persistent: FindingGroup[];
}

// ---------------------------------------------------------------------------
// Severity ordering for sorting
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  advisory: 3,
};

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Group findings by finding_type_hash.
 *
 * Each group contains:
 * - hash, criterion, failure_type, instance count, severity
 * - All individual findings in the group
 *
 * Sorted by severity (critical first), then instance count (descending).
 */
export function groupFindingsByHash(findings: Finding[]): FindingGroup[] {
  const groupMap = new Map<string, Finding[]>();

  for (const finding of findings) {
    const existing = groupMap.get(finding.finding_type_hash);
    if (existing) {
      existing.push(finding);
    } else {
      groupMap.set(finding.finding_type_hash, [finding]);
    }
  }

  const groups: FindingGroup[] = [];

  for (const [hash, groupFindings] of groupMap) {
    const first = groupFindings[0];

    // Extract failure_type from measured_values if available
    const failureType = extractFailureType(first);

    // Use the highest severity in the group
    const severity = highestSeverity(groupFindings);

    groups.push({
      hash,
      criterion: first.wcag_criterion,
      failureType,
      instanceCount: groupFindings.length,
      severity,
      findings: groupFindings,
    });
  }

  // Sort: severity first (critical → advisory), then instance count descending
  groups.sort((a, b) => {
    const sevDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sevDiff !== 0) return sevDiff;
    return b.instanceCount - a.instanceCount;
  });

  return groups;
}

/**
 * Extract the failure_type from a finding's evidence.measured_values.
 * Falls back to "unknown" if not present.
 */
function extractFailureType(finding: Finding): string {
  const mv = finding.evidence.measured_values;
  if (mv && typeof mv === "object" && "failure_type" in mv) {
    return String(mv.failure_type);
  }
  // Try raw_result from analysis
  const raw = finding.analysis.llm_output?.raw_response;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.failure_type) return String(parsed.failure_type);
    } catch {
      // Not JSON — ignore
    }
  }
  return "unknown";
}

/**
 * Get the highest (most severe) severity in a list of findings.
 */
function highestSeverity(findings: Finding[]): Severity {
  let highest: Severity = "advisory";
  for (const f of findings) {
    if (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[highest]) {
      highest = f.severity;
    }
  }
  return highest;
}

// ---------------------------------------------------------------------------
// Webflow remediation backfill
// ---------------------------------------------------------------------------

/**
 * For findings with stub (empty) remediation, backfill from the Webflow
 * adapter templates. This handles scans that were run before the remediation
 * pipeline was wired in.
 */
function backfillWebflowRemediation(findings: Finding[]): void {
  const adapter = new WebflowAdapter();
  // Force detection so getPlatformInfo works
  adapter.detect('<meta name="generator" content="Webflow">');

  for (const finding of findings) {
    // Skip if remediation is already populated
    if (finding.remediation.platform_fix.steps.length > 0) continue;

    try {
      const platformFix = adapter.getRemediationSteps(finding);
      const failureType = (finding.evidence.measured_values?.failure_type as string) ?? "";
      const templateKey = `${finding.wcag_criterion}:${failureType}`;
      const template = getRemediationTemplate(templateKey);

      finding.remediation = {
        generic_fix: template?.generic_fix ?? platformFix.steps[0] ?? "",
        platform_fix: platformFix,
        code_fix: template?.code_fix ?? null,
        estimated_effort: template?.estimated_effort ?? finding.remediation.estimated_effort,
        fix_verified: false,
      };
    } catch {
      // Ignore errors — keep stub remediation
    }
  }
}

// ---------------------------------------------------------------------------
// Diff computation
// ---------------------------------------------------------------------------

/**
 * Compute the diff between the current scan's finding groups and a
 * comparison scan's finding groups.
 *
 * Uses finding_type_hash to classify:
 * - resolved: in old scan but not in new (violations fixed)
 * - new: in new scan but not in old (newly introduced)
 * - persistent: in both scans (still open)
 */
export function computeDiff(
  currentGroups: FindingGroup[],
  comparisonGroups: FindingGroup[],
): ScanDiff {
  const currentHashes = new Set(currentGroups.map((g) => g.hash));
  const comparisonHashes = new Set(comparisonGroups.map((g) => g.hash));

  const resolved = comparisonGroups.filter((g) => !currentHashes.has(g.hash));
  const newFindings = currentGroups.filter((g) => !comparisonHashes.has(g.hash));
  const persistent = currentGroups.filter((g) => comparisonHashes.has(g.hash));

  return { resolved, newFindings, persistent };
}

// ---------------------------------------------------------------------------
// Main query function
// ---------------------------------------------------------------------------

/**
 * Query all findings for a scan and return grouped, sorted report data.
 *
 * Returns:
 * - ScanSession metadata
 * - Findings grouped by finding_type_hash
 * - CriterionResult[] (pass/fail status per criterion)
 * - ScanSummary (aggregated statistics)
 * - ScanDiff (if comparison_scan_id is set on the session)
 */
export function queryFindings(db: Database.Database, scanId: string): ReportData {
  // Fetch scan session
  const scanSession = getScanSession(db, scanId);
  if (!scanSession) {
    throw new Error(`Scan session not found: ${scanId}`);
  }

  // Fetch all findings for this scan
  const findings = listFindingsByScan(db, scanId);

  // Backfill Webflow remediation for findings with stub/empty remediation
  if (scanSession.platform === "webflow") {
    backfillWebflowRemediation(findings);
  }

  // Group by finding_type_hash
  const groups = groupFindingsByHash(findings);

  // Fetch criterion results and summary
  const criterionResults = listCriterionResults(db, scanId);
  const summary = getScanSummary(db, scanId) ?? null;

  // Compute diff if comparison scan exists
  let diff: ScanDiff | null = null;
  if (scanSession.comparison_scan_id) {
    const comparisonFindings = listFindingsByScan(db, scanSession.comparison_scan_id);
    const comparisonGroups = groupFindingsByHash(comparisonFindings);
    diff = computeDiff(groups, comparisonGroups);
  }

  return {
    scanSession,
    groups,
    criterionResults,
    summary,
    diff,
  };
}
