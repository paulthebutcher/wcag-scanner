// ---------------------------------------------------------------------------
// Criterion status integrity (P2-010, P2-004, P2-032, P2-033 and the stored
// gap): the rules every scan's CriterionResult[] is settled by, in one place
// and pure, after the tiers have recorded their results and the findings
// have been reconciled.
// ---------------------------------------------------------------------------

import type { CriterionResult, DetectedBy } from "../types.js";
import type { CoverageEntry } from "./coverage.js";
import { checksForCriterion } from "./check-registry.js";
import { firstLine } from "./coverage.js";
import { WCAG_AA_CRITERIA, criterionName, isAaCriterion } from "./wcag-criteria.js";

export const NO_CHECK_REASON = "no_check";

export interface SettleOptions {
  scanId: string;
  results: CriterionResult[];
  coverage: CoverageEntry[];
}

/**
 * A criterion that passed, or was found not applicable, on a check's
 * evidence is not established when any check addressing it failed (threw or
 * returned an API error) on any page: it becomes not_tested with the reason
 * (P2-010). Failed and needs_review statuses stand on their findings.
 */
export function withholdPassesOnFailedChecks(results: CriterionResult[], coverage: CoverageEntry[]): CriterionResult[] {
  const failedByCheck = new Map<string, CoverageEntry[]>();
  for (const e of coverage) {
    if (e.status !== "failed") continue;
    const list = failedByCheck.get(e.check) ?? [];
    list.push(e);
    failedByCheck.set(e.check, list);
  }
  if (failedByCheck.size === 0) return results;
  return results.map((cr) => {
    if (cr.status !== "passed" && cr.status !== "not_applicable") return cr;
    const failed = checksForCriterion(cr.wcag_criterion).filter((c) => failedByCheck.has(c));
    if (failed.length === 0) return cr;
    const detail = failed.map((c) => {
      const entries = failedByCheck.get(c)!;
      const pages = new Set(entries.map((e) => e.page_url)).size;
      return `${c} failed on ${pages} page(s): ${firstLine(entries[0].message ?? "error")}`;
    }).join("; ");
    return {
      ...cr,
      status: "not_tested",
      evidence_summary: `Not established: ${detail} (was: ${cr.evidence_summary})`,
      finding_ids: [],
    };
  });
}

/**
 * Exactly the 50 A/AA criteria, one row each: out-of-scope rows (1.3.6, AAA)
 * are dropped and a criterion with no row is not_tested with reason
 * `no_check` (P2-032, stored gap).
 */
export function completeCriterionRows(scanId: string, results: CriterionResult[]): CriterionResult[] {
  const byCriterion = new Map<string, CriterionResult>();
  for (const cr of results) {
    if (!isAaCriterion(cr.wcag_criterion)) continue;
    byCriterion.set(cr.wcag_criterion, cr);
  }
  const out: CriterionResult[] = [];
  for (const c of WCAG_AA_CRITERIA) {
    const existing = byCriterion.get(c.id);
    if (existing) {
      out.push(existing);
      continue;
    }
    const testedBy: DetectedBy = "manual";
    out.push({
      scan_session_id: scanId,
      wcag_criterion: c.id,
      status: "not_tested",
      tested_by: testedBy,
      evidence_summary: `${NO_CHECK_REASON}: ${c.name} is not covered by any automated check; needs a manual check`,
      finding_ids: [],
    });
  }
  return out;
}

/** Rows the report lists as not tested, with the stored reason. */
export function notTestedRows(results: CriterionResult[]): Array<{ criterion: string; name: string; reason: string; tested_by: DetectedBy }> {
  return results
    .filter((cr) => cr.status === "not_tested")
    .map((cr) => ({ criterion: cr.wcag_criterion, name: criterionName(cr.wcag_criterion), reason: cr.evidence_summary, tested_by: cr.tested_by }))
    .sort((a, b) => a.criterion.localeCompare(b.criterion, undefined, { numeric: true }));
}

/** The whole rule set, in order: failed checks withhold passes, then every A/AA criterion gets its row. */
export function settleCriterionResults(options: SettleOptions): CriterionResult[] {
  return completeCriterionRows(options.scanId, withholdPassesOnFailedChecks(options.results, options.coverage));
}
