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
import { computeSummary, reconcileInMemory } from "../core/scanner.js";
import { shouldFilterFromClientReport } from "./findings-dump.js";

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
  // Trivial (0.5h) — single attribute or quick CSS tweak
  "focus_indicator_low_contrast": 0.5,
  "no_visible_focus_indicator": 0.5,
  "missing_alt": 0.5,
  "decorative_with_alt": 0.5,
  "empty_alt_on_informative": 0.5,
  "missing_lang": 0.5,
  "missing_title": 0.5,
  "missing_autocomplete": 0.5,
  "input_purpose": 0.5,
  "missing_required_indication": 0.5,
  "duplicate_nav_landmark": 0.5,
  "unlabeled_nav_landmark": 0.5,
  "table_no_caption": 0.5,
  "table_header_no_scope": 0.5,
  // Low (1h) — template attribute fix or content edit
  "link-name": 1,
  "image_link_no_alt": 1,
  "semantic": 1,
  "empty_link": 1,
  "non_descriptive_link": 1,
  "skipped_level": 1,
  "missing_heading": 1,
  "duplicate_link_text": 1,
  "color-contrast": 1,
  "insufficient_contrast": 1,
  "color_alone": 1,
  "missing_skip_navigation": 1,
  "missing_skip_link": 1,
  "table_missing_headers": 1,
  "layout_table": 0.5,
  // Moderate (2h) — custom embed, JS snippet, or structural change
  "focus_order_mismatch": 2,
  "insufficient_navigation_methods": 1.5,
  "error_not_announced": 2,
  "unreachable_interactive_element": 2,
  "not_keyboard_accessible": 2,
  "custom_interactive_no_role": 2,
  "missing_aria_expanded": 2,
  "missing_tab_role": 2,
  "tabs_keyboard": 2,
  "dropdown_keyboard": 2,
  "high_risk_form": 3,
  "modal_focus_trap": 3,
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

    // Downgrade Webflow password pages from critical 3.3.4 to advisory.
    // Webflow's native .w-password-page is a platform auth form, not a
    // user-submitted legal/financial form.
    if (
      finding.wcag_criterion === "3.3.4" &&
      finding.severity === "critical" &&
      finding.evidence.element_html.includes("w-password-page")
    ) {
      finding.severity = "advisory";
      finding.analysis = {
        ...finding.analysis,
        reasoning: "This page uses Webflow\u2019s built-in password protection form. " +
          "If it protects legal or financial data, consider adding a confirmation step. " +
          "Downgraded from critical because this is a platform-level authentication form, " +
          "not a user data submission form.",
      };
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
export function queryFindings(
  db: Database.Database,
  scanId: string,
  opts: { filterNoisy?: boolean } = {},
): ReportData {
  // Default behavior: filter low-confidence findings from the client-facing
  // report. Callers that need EVERY finding (verbose dump) pass filterNoisy:false.
  const filterNoisy = opts.filterNoisy ?? true;

  // Fetch scan session
  const scanSession = getScanSession(db, scanId);
  if (!scanSession) {
    throw new Error(`Scan session not found: ${scanId}`);
  }

  // Fetch all findings for this scan
  const rawFindings = listFindingsByScan(db, scanId);

  // Backfill Webflow remediation for findings with stub/empty remediation
  if (scanSession.platform === "webflow") {
    backfillWebflowRemediation(rawFindings);
  }

  // Filter low-confidence / noisy findings from the client report. This is
  // THE hook point — everything downstream recomputes from the filtered set.
  const findings = filterNoisy
    ? rawFindings.filter((f) => !shouldFilterFromClientReport(f))
    : rawFindings;

  // Group by finding_type_hash
  const groups = groupFindingsByHash(findings);

  // Fetch stored criterion results and summary
  const storedCriterionResults = listCriterionResults(db, scanId);
  const storedSummary = getScanSummary(db, scanId) ?? null;

  // Re-reconcile criterion results against the filtered finding set. Criteria
  // whose only findings were filtered out flip from "failed" to "passed".
  const criterionResults = filterNoisy
    ? reconcileInMemory(scanId, findings, storedCriterionResults)
    : storedCriterionResults;

  // Recompute summary from the filtered findings + reconciled results ONLY
  // when the filter actually changed the finding set. Otherwise the stored
  // summary is accurate (or null), and we keep null-ness consistent with the
  // no-filter path. Effort is always recalculated per-type.
  const filterRemovedSome = filterNoisy && rawFindings.length !== findings.length;
  let summary: ScanSummary | null;
  if (filterRemovedSome) {
    const recomputed = computeSummary(scanId, findings, criterionResults);
    summary = { ...recomputed, estimated_total_effort: estimateEffortByType(groups) };
  } else {
    summary = storedSummary
      ? { ...storedSummary, estimated_total_effort: estimateEffortByType(groups) }
      : null;
  }

  // Compute diff if comparison scan exists. Apply the SAME filter to the
  // comparison side — otherwise findings filtered out of the current scan
  // would appear as phantom "resolved" items.
  let diff: ScanDiff | null = null;
  if (scanSession.comparison_scan_id) {
    const rawComparison = listFindingsByScan(db, scanSession.comparison_scan_id);
    const comparisonFindings = filterNoisy
      ? rawComparison.filter((f) => !shouldFilterFromClientReport(f))
      : rawComparison;
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
