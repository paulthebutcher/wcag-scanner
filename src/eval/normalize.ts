import type { CriterionResult, Finding, PageSnapshot } from "../types.js";
import type { ScanCoverage } from "../core/coverage.js";
import { evalCheckFor } from "./attribution.js";
import { canonicalJson, sha256 } from "./util.js";

// ---------------------------------------------------------------------------
// Normalised scan output. Two forms:
//
//   full:   everything an engine produced, with only ids, timestamps and
//           file paths removed (default-path equivalence, invariant 2)
//   key:    the repeatability tuple of D3 (criterion, locator, failure type,
//           check, severity, confidence) per page
//
// Page URLs are mapped to corpus page ids so results from different runs,
// servers and engines compare directly.
// ---------------------------------------------------------------------------

export type PageIdOf = (url: string) => string;

function pageMapper(snapshots: PageSnapshot[], pageIdOf: PageIdOf): (snapshotId: string) => string {
  const byId = new Map(snapshots.map((s) => [s.id, pageIdOf(s.url)]));
  return (id) => byId.get(id) ?? "(unknown-page)";
}

const PATH_KEYS = new Set(["element_screenshot", "context_screenshot", "screenshot", "screenshots"]);

/** Recursively drop paths and map URLs inside also_found_on_urls to page ids. */
function scrub(value: unknown, pageIdOf: PageIdOf, key = ""): unknown {
  if (Array.isArray(value)) {
    const items = value.map((v) => scrub(v, pageIdOf));
    return key === "also_found_on_urls" ? (items as string[]).map((u) => pageIdOf(String(u))).sort() : items;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PATH_KEYS.has(k)) continue;
      out[k] = scrub(v, pageIdOf, k);
    }
    return out;
  }
  return value;
}

export interface FullFinding {
  page: string;
  record: Record<string, unknown>;
}

export function fullFindings(findings: Finding[], snapshots: PageSnapshot[], pageIdOf: PageIdOf): FullFinding[] {
  const pageOf = pageMapper(snapshots, pageIdOf);
  return findings.map((f) => {
    const { id: _id, page_snapshot_id, interaction_state_id: _is, human_review: _hr, ...rest } = f;
    void _id; void _is; void _hr;
    return { page: pageOf(page_snapshot_id), record: scrub(rest, pageIdOf) as Record<string, unknown> };
  }).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
}

export interface FindingKey {
  page: string;
  criterion: string;
  locator: string;
  html_sha256: string;
  failure_type: string | null;
  check: string | null;
  severity: string;
  confidence: string;
  detected_by: string;
  also_found_on: string[];
  /** Vendor when the finding is on third-party embed content (left out of the identity comparison, P2-023) */
  third_party: string | null;
}

export function findingKeys(findings: Finding[], snapshots: PageSnapshot[], pageIdOf: PageIdOf): FindingKey[] {
  const pageOf = pageMapper(snapshots, pageIdOf);
  return findings.map((f) => {
    const mv = f.evidence.measured_values ?? {};
    const also = Array.isArray(mv.also_found_on_urls) ? (mv.also_found_on_urls as string[]).map((u) => pageIdOf(u)).sort() : [];
    return {
      page: pageOf(f.page_snapshot_id),
      criterion: f.wcag_criterion,
      locator: f.evidence.element_selector,
      html_sha256: sha256(f.evidence.element_html ?? ""),
      failure_type: typeof mv.failure_type === "string" ? mv.failure_type : null,
      check: evalCheckFor(f),
      severity: f.severity,
      confidence: f.confidence.tier,
      detected_by: f.evidence.detected_by,
      also_found_on: also,
      third_party: typeof (mv.third_party as { vendor?: unknown } | undefined)?.vendor === "string" ? (mv.third_party as { vendor: string }).vendor : null,
    };
  }).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
}

export interface CriterionStatusRow {
  criterion: string;
  status: string;
  tested_by: string;
  evidence_summary: string;
}

export function criterionStatuses(results: CriterionResult[]): CriterionStatusRow[] {
  return results
    .map((r) => ({ criterion: r.wcag_criterion, status: r.status, tested_by: r.tested_by, evidence_summary: r.evidence_summary }))
    .sort((a, b) => a.criterion.localeCompare(b.criterion, undefined, { numeric: true }));
}

export interface CoverageRow {
  check: string;
  page: string;
  status: string;
  message: string | null;
}

export function coverageRows(coverage: ScanCoverage | null, pageIdOf: PageIdOf): CoverageRow[] | null {
  if (!coverage) return null;
  return coverage.entries
    .map((e) => ({ check: e.check, page: pageIdOf(e.page_url), status: e.status, message: e.message ?? null }))
    .sort((a, b) => `${a.check}|${a.page}`.localeCompare(`${b.check}|${b.page}`));
}

/** Multiset difference: entries in `a` not matched one-for-one in `b`. */
export function multisetDiff<T>(a: T[], b: T[]): { onlyA: T[]; onlyB: T[] } {
  const counts = new Map<string, number>();
  for (const x of b) {
    const k = canonicalJson(x);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const onlyA: T[] = [];
  for (const x of a) {
    const k = canonicalJson(x);
    const n = counts.get(k) ?? 0;
    if (n > 0) counts.set(k, n - 1);
    else onlyA.push(x);
  }
  const onlyB: T[] = [];
  const countsA = new Map<string, number>();
  for (const x of a) {
    const k = canonicalJson(x);
    countsA.set(k, (countsA.get(k) ?? 0) + 1);
  }
  for (const x of b) {
    const k = canonicalJson(x);
    const n = countsA.get(k) ?? 0;
    if (n > 0) countsA.set(k, n - 1);
    else onlyB.push(x);
  }
  return { onlyA, onlyB };
}
