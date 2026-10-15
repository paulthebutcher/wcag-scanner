import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { EvalPaths } from "./paths.js";
import type { RunManifest } from "./manifest.js";
import type { CompareResult } from "./compare.js";

// ---------------------------------------------------------------------------
// D6 reference export: what goes under eval/baselines/2026-10-04/. Aggregates
// only. The original baseline scan's totals are context, never a target: the
// frozen corpus has at most 30 pages per site, so no count is matched.
// ---------------------------------------------------------------------------

export const BASELINE_SCAN_ID = "77a43f3b-9ec7-4dd3-9ce9-ec2fbc172fce";

export interface HistoricalContext {
  scan_id_prefix: string;
  pages: number;
  findings: number;
  by_criterion: Record<string, number>;
  note: string;
}

/** Totals of the original baseline scan, read from its separate store (read-only). */
export function historicalContext(paths: EvalPaths): HistoricalContext | null {
  const store = join(paths.dataDir, "baselines", "2026-10-04", "wcag.db");
  if (!existsSync(store)) return null;
  const db = new Database(store, { readonly: true, fileMustExist: true });
  try {
    const pages = (db.prepare("select count(*) as n from page_snapshots where scan_session_id = ?").get(BASELINE_SCAN_ID) as { n: number }).n;
    const rows = db.prepare("select f.wcag_criterion as c, count(*) as n from findings f join page_snapshots p on f.page_snapshot_id = p.id where p.scan_session_id = ? group by 1").all(BASELINE_SCAN_ID) as Array<{ c: string; n: number }>;
    return {
      scan_id_prefix: BASELINE_SCAN_ID.slice(0, 8),
      pages,
      findings: rows.reduce((s, r) => s + r.n, 0),
      by_criterion: Object.fromEntries(rows.sort((a, b) => a.c.localeCompare(b.c, undefined, { numeric: true })).map((r) => [r.c, r.n])),
      note: "Context only: the original 50-page live scan. The frozen corpus uses at most 30 pages per site; no count-matching threshold applies.",
    };
  } finally {
    db.close();
  }
}

export interface CapabilityRow {
  check: string;
  baseline: "present" | "unsupported";
  head: "present" | "unsupported";
}

/** Map baseline check names to current ids; a check the baseline never had is an unsupported capability. */
export function capabilityMap(baselineChecks: string[], headChecks: string[]): CapabilityRow[] {
  return Array.from(new Set([...baselineChecks, ...headChecks])).sort().map((check) => ({
    check,
    baseline: baselineChecks.includes(check) ? "present" : "unsupported",
    head: headChecks.includes(check) ? "present" : "unsupported",
  }));
}

export function referenceExport(input: {
  base: RunManifest;
  head: RunManifest;
  compare: CompareResult;
  capability: CapabilityRow[];
  history: HistoricalContext | null;
  compareRunId: string;
}) {
  const engine = (m: RunManifest) => ({ label: m.engine.label, sha: m.engine.sha, bridge: m.engine.bridge, run_id: m.run_id, valid: m.validity.valid, official: m.validity.official });
  return {
    schema_version: 1,
    corpus: { version: input.head.corpus?.version ?? null, split: input.head.corpus?.split ?? null, page_set_sha256: input.head.corpus?.page_set_sha256 ?? null, pages: input.head.totals.pages },
    baseline: engine(input.base),
    head: engine(input.head),
    compare_run_id: input.compareRunId,
    exit: input.compare.exit,
    capability_map: input.capability,
    shared_pages: input.compare.report.shared_pages,
    findings_added_by_criterion_and_failure_type: input.compare.report.findings_added,
    findings_removed_by_criterion_and_failure_type: input.compare.report.findings_removed,
    criterion_transitions: input.compare.report.criterion_transitions.map((t) => ({ criterion: t.criterion, base: t.base, head: t.head })),
    regressions: input.compare.regressions.map((r) => r.kind),
    existing_blockers: input.compare.existing_blockers.map((r) => r.kind),
    historical_context: input.history,
  };
}
