import type Database from "better-sqlite3";
import type {
  Finding,
  Effort,
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
import { WebflowAdapter, getRemediationTemplate, clearRemediationCache } from "../adapters/webflow.js";

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

  const rawGroups: FindingGroup[] = [];

  for (const [hash, groupFindings] of groupMap) {
    const first = groupFindings[0];
    const failureType = extractFailureType(first);
    const severity = highestSeverity(groupFindings);

    rawGroups.push({
      hash,
      criterion: first.wcag_criterion,
      failureType,
      instanceCount: groupFindings.length,
      severity,
      findings: groupFindings,
    });
  }

  // Merge groups that share the same criterion + failureType but got
  // different hashes (e.g. axe_violation vs axe_incomplete for the same rule).
  const mergeKey = (g: FindingGroup) => `${g.criterion}::${g.failureType}`;
  const mergedMap = new Map<string, FindingGroup>();

  for (const group of rawGroups) {
    const key = mergeKey(group);
    const existing = mergedMap.get(key);
    if (existing) {
      existing.findings.push(...group.findings);
      existing.instanceCount = existing.findings.length;
      if (SEVERITY_ORDER[group.severity] < SEVERITY_ORDER[existing.severity]) {
        existing.severity = group.severity;
      }
    } else {
      mergedMap.set(key, { ...group });
    }
  }

  const groups = Array.from(mergedMap.values());

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
// Per-type effort estimation
// ---------------------------------------------------------------------------

/**
 * Hours keyed by failure_type (or criterion:failure_type).
 * More specific keys take priority over generic failure_type keys.
 */
const EFFORT_BY_FAILURE_TYPE: Record<string, number> = {
  // Low effort (1h) — single attribute or CSS fix
  "focus_indicator_low_contrast": 1,
  "no_visible_focus_indicator": 1,
  "link-name": 1,
  "image_link_no_alt": 1,
  "semantic": 1,
  "empty_alt_on_informative": 1,
  "missing_alt": 1,
  "decorative_with_alt": 1,
  "skipped_level": 1,
  "missing_heading": 1,
  "missing_autocomplete": 1,
  "input_purpose": 1,
  "missing_lang": 1,
  "missing_title": 1,
  "empty_link": 1,
  "non_descriptive_link": 1,
  "missing_required_indication": 1,
  // Low-moderate (2h) — style changes across multiple elements
  "color-contrast": 2,
  "insufficient_contrast": 2,
  "color_alone": 2,
  // Moderate (2-3h) — custom embed or structural change
  "missing_skip_navigation": 2,
  "missing_skip_link": 2,
  "focus_order_mismatch": 3,
  "insufficient_navigation_methods": 3,
  "error_not_announced": 2,
  // Moderate-high (4h) — keyboard/interaction work
  "unreachable_interactive_element": 4,
  "not_keyboard_accessible": 4,
  "tabs_keyboard": 3,
  "dropdown_keyboard": 3,
  "modal_focus_trap": 4,
  // High (6h) — significant process change
  "high_risk_form": 6,
  // New checks
  "duplicate_nav_landmark": 1,
  "unlabeled_nav_landmark": 1,
  "missing_aria_expanded": 3,
  "missing_tab_role": 3,
  "custom_interactive_no_role": 3,
  "table_no_caption": 1,
  "table_header_no_scope": 1,
  "table_missing_headers": 2,
  "layout_table": 0.5,
  "duplicate_link_text": 1,
};

/** Fallback effort hours based on the stored Effort enum */
const EFFORT_ENUM_HOURS: Record<Effort, number> = {
  trivial: 0.25,
  minor: 0.5,
  moderate: 2,
  significant: 4,
};

/** Get the effort hours for a finding group, using the failure-type-specific lookup. */
export function getEffortHours(group: FindingGroup): number {
  const ft = group.failureType;
  // Try criterion:failure_type first (most specific)
  const specific = EFFORT_BY_FAILURE_TYPE[`${group.criterion}:${ft}`];
  if (specific !== undefined) return specific;
  // Try failure_type alone
  const byType = EFFORT_BY_FAILURE_TYPE[ft];
  if (byType !== undefined) return byType;
  // Fall back to stored effort enum
  const effort = group.findings[0]?.remediation.estimated_effort ?? "moderate";
  return EFFORT_ENUM_HOURS[effort as Effort] ?? 2;
}

/**
 * Estimate total remediation effort at the **finding-type** level.
 *
 * A finding type that appears on 15 pages is still one fix — the effort
 * is counted once per unique group, not once per instance.
 */
export function estimateEffortByType(groups: FindingGroup[]): string {
  let total = 0;
  for (const group of groups) {
    total += getEffortHours(group);
  }

  if (total <= 2) return "< 2 hours";
  if (total <= 8) return `~${Math.round(total)} hours`;
  return `~${Math.round(total)} hours (~${Math.round(total / 8)} days)`;
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
  // Clear the remediation cache to avoid stale generic entries from prior runs
  clearRemediationCache();

  const adapter = new WebflowAdapter();
  adapter.detect('<meta name="generator" content="Webflow">');

  for (const finding of findings) {
    // Always attempt backfill — the adapter templates have been expanded to
    // cover actual failure_type values from the scan data.  Even if the
    // finding already has stub "two-sentence placeholder" steps we want to
    // replace them with the real template content.
    try {
      const failureType = (finding.evidence.measured_values?.failure_type as string) ?? "";
      const templateKey = `${finding.wcag_criterion}:${failureType}`;
      const template = getRemediationTemplate(templateKey);

      if (template) {
        // Direct template match — use it
        finding.remediation = {
          generic_fix: template.generic_fix,
          platform_fix: {
            platform: "webflow",
            platform_version: "2024.1",
            steps: template.steps,
            designer_path: template.designer_path,
            screenshots: [],
            generated_by: "template",
            platform_docs_url: template.platform_docs_url,
          },
          code_fix: template.code_fix,
          estimated_effort: template.estimated_effort,
          fix_verified: false,
        };
      } else {
        // No template — fall back to adapter (which may produce a generic fix)
        const platformFix = adapter.getRemediationSteps(finding);
        finding.remediation = {
          generic_fix: platformFix.steps[0] ?? "",
          platform_fix: platformFix,
          code_fix: null,
          estimated_effort: finding.remediation.estimated_effort,
          fix_verified: false,
        };
      }
    } catch {
      // Ignore errors — keep existing remediation
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
  const storedSummary = getScanSummary(db, scanId) ?? null;

  // Recalculate effort at the finding-type level (not per-instance)
  const summary = storedSummary
    ? { ...storedSummary, estimated_total_effort: estimateEffortByType(groups) }
    : null;

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
