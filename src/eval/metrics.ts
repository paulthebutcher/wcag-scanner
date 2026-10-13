import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, readJsonl } from "./util.js";
import { matchCases, coverageMap, type AssertionOutcome, type MatchClass, type View } from "./matcher.js";
import { CaseStore, LabelStore, foldLabels, type CaseRecord, type FoldedJudgment, type LabelOverride, type OverridesFile, type SeedResolution } from "./labels.js";
import type { Prediction } from "./predictions.js";
import type { CoverageRow, CriterionStatusRow } from "./normalize.js";
import type { EvalConfig } from "./config.js";
import type { EvalPaths } from "./paths.js";
import type { RunManifest } from "./manifest.js";
import { loadSiteCapture, type Split } from "./corpus.js";

// ---------------------------------------------------------------------------
// D5 metrics. Every ratio has an explicit denominator and a Wilson 95%
// interval; a zero denominator is "unavailable", never 0% or 100%. A
// propagation group is one sample (instances are reported separately).
// Queue-based precision, random-audit precision, audit recall and
// known-defect recall are separate numbers with their own n and are never
// blended into one figure. Tooling errors, untested outcomes, ambiguity and
// staleness are counted and never become passes.
// ---------------------------------------------------------------------------

export interface Ratio {
  value: number | null;
  lower: number | null;
  upper: number | null;
  numerator: number;
  n: number;
  insufficient: boolean;
  unavailable: string | null;
}

export function wilson(numerator: number, n: number, insufficientBelow: number, z = 1.96): Ratio {
  if (n === 0) return { value: null, lower: null, upper: null, numerator, n, insufficient: true, unavailable: "zero denominator" };
  const p = numerator / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  const round = (x: number) => Math.round(x * 10000) / 10000;
  return { value: round(p), lower: round(Math.max(0, centre - half)), upper: round(Math.min(1, centre + half)), numerator, n, insufficient: n < insufficientBelow, unavailable: null };
}

export type SampleOrigin = "queue" | "random" | "audit" | "seed";

export interface Counts {
  tp: number; fp: number; fn: number; tn: number;
}

export interface OriginMetrics {
  samples: Counts;
  precision: Ratio;
  recall: Ratio;
}

export interface CriterionMetrics {
  criterion: string;
  level: string;
  coverage: string;
  views: Record<View, {
    by_origin: Record<SampleOrigin, OriginMetrics>;
    /** Pooled sample counts across origins (no pooled ratio is reported) */
    pooled_samples: Counts;
    instances: Counts;
  }>;
  counts: {
    sites: number; cases: number; clusters: number; labeled_instances: number;
    unsure: number; disputed: number; excluded: number; tooling_errors: number; untested: number; ambiguous: number; stale: number;
    unresolved_fixture: number; unreviewed: number;
    predictions: number; unlabeled_predictions: number; needs_review_predictions: number; api_failure_predictions: number;
  };
  needs_review_rate: Ratio;
  diagnostics: { known_defect_misses: number; audit_misses: number; wrong_criterion: number; severity_disagreements: number };
}

export interface CheckPrecision {
  check: string;
  tier: number | null;
  precision_by_origin: Record<"queue" | "random", Ratio>;
}

export interface FalsePass {
  rule: "known_violation_with_pass" | "pass_with_unestablished_checks" | "pass_with_api_failures" | "pass_without_checks";
  site: string;
  criterion: string;
  detail: string;
}

export interface CoverageSummary {
  ran: number; partial: number; failed: number; skipped: number; not_recorded: number; not_applicable: number;
  by_check: Record<string, { ran: number; partial: number; failed: number; skipped: number; not_recorded: number; not_applicable: number }>;
}

export interface MetricsReport {
  run_id: string;
  split: Split;
  corpus_version: string;
  labels_through: number;
  views: View[];
  criteria: CriterionMetrics[];
  checks: CheckPrecision[];
  coverage: CoverageSummary | null;
  false_passes: FalsePass[];
  wrong_criterion_assignments: number;
  severity_disagreements: number;
  unlabeled_predictions: number;
  outcomes: Record<View, AssertionOutcome[]>;
}

const NOT_APPLICABLE_REASONS = [/no forms on page/i, /needs 2 or more pages/i];

function emptyCounts(): Counts { return { tp: 0, fp: 0, fn: 0, tn: 0 }; }

function add(c: Counts, cls: MatchClass): void {
  if (cls === "TP") c.tp++; else if (cls === "FP") c.fp++; else if (cls === "FN") c.fn++; else if (cls === "TN") c.tn++;
}

/** Severity order used to break ties between instance classes (the worse one wins). */
const CLASS_RANK: Record<string, number> = { FN: 4, FP: 3, TP: 2, TN: 1 };

function originOf(o: AssertionOutcome, judgments: Map<string, FoldedJudgment>): SampleOrigin {
  if (o.origin === "seed") return "seed";
  const j = judgments.get(`${o.case_id}|${o.assertion_id}`);
  if (o.origin === "independent_audit" && j?.phase === "pre_reveal") return "audit";
  if (j?.batch === "calibration") return "random";
  return "queue";
}

export interface RunInputs {
  manifest: RunManifest;
  runDir: string;
  sites: Array<{ site: string; predictions: Prediction[]; coverage: CoverageRow[] | null; criteria: CriterionStatusRow[]; pages: string[] }>;
}

export function loadRunInputs(paths: EvalPaths, manifest: RunManifest): RunInputs {
  const runDir = join(paths.runsDir, manifest.run_id);
  const sitesDir = join(runDir, "sites");
  const chosen = new Map<string, string>();
  if (existsSync(sitesDir)) {
    for (const name of readdirSync(sitesDir).sort()) {
      const summaryPath = join(sitesDir, name, "summary.json");
      if (!existsSync(summaryPath)) continue;
      const s = readJson<{ site: string; tag: string }>(summaryPath);
      if (!chosen.has(s.site) || /-r1$/.test(s.tag)) chosen.set(s.site, join(sitesDir, name));
    }
  }
  const sites = Array.from(chosen.entries()).map(([site, dir]) => {
    const capture = loadSiteCapture(paths, { version: manifest.corpus!.version, split: manifest.corpus!.split as Split, siteId: site });
    return {
      site,
      predictions: readJson<Prediction[]>(join(dir, "predictions.json")),
      coverage: readJson<CoverageRow[] | null>(join(dir, "coverage.json")),
      criteria: readJson<CriterionStatusRow[]>(join(dir, "criteria.json")),
      // The run's own page set (a diagnostic run may replay a subset)
      pages: manifest.scan_contract
        ? manifest.scan_contract.page_order.filter((x) => x.startsWith(`${site}/`)).map((x) => x.slice(site.length + 1))
        : capture.pages.filter((p) => p.status === "captured").map((p) => p.page_id),
    };
  });
  return { manifest, runDir, sites };
}

export interface LabelInputs {
  cases: CaseRecord[];
  judgments: Map<string, FoldedJudgment>;
  overrides: LabelOverride[];
  unresolvedSeeds: Set<string>;
  labelsThrough: number;
}

export function loadLabelInputs(paths: EvalPaths, labelsThrough: number | null): LabelInputs {
  const labels = new LabelStore(paths.labels);
  const through = labelsThrough ?? labels.lastSeq();
  const overrides = existsSync(paths.labelOverrides) ? readJson<OverridesFile>(paths.labelOverrides).overrides : [];
  const resolutions = readJsonl<SeedResolution>(paths.seedResolutions);
  const latest = new Map<string, SeedResolution>();
  for (const r of resolutions.sort((a, b) => a.seq - b.seq)) latest.set(r.seed_id, r);
  return {
    cases: Array.from(new CaseStore(paths.cases).current().values()),
    judgments: foldLabels(labels.events(), through),
    overrides,
    unresolvedSeeds: new Set(Array.from(latest.values()).filter((r) => r.status === "unresolved_fixture" || r.status === "requires_rendering").map((r) => r.seed_id)),
    labelsThrough: through,
  };
}

export function computeMetrics(config: EvalConfig, run: RunInputs, labels: LabelInputs): MetricsReport {
  const views: View[] = ["confirmed", "inclusive"];
  const corpusVersion = run.manifest.corpus!.version;
  const split = run.manifest.corpus!.split as Split;
  const minN = config.gate.insufficient_evidence_n;
  const allPreds = run.sites.flatMap((s) => s.predictions);
  const coverage = new Map<string, string>();
  let anyCoverage = false;
  for (const s of run.sites) {
    const m = coverageMap(s.site, s.coverage);
    if (m) { anyCoverage = true; for (const [k, v] of m) coverage.set(k, v); }
  }
  const corpusPages = new Set(run.sites.flatMap((s) => s.pages.map((p) => `${s.site}/${p}`)));
  const runSites = new Set(run.sites.map((s) => s.site));
  const cases = labels.cases.filter((c) => runSites.has(c.site) && c.page !== "scan");

  const outcomes = {} as Record<View, AssertionOutcome[]>;
  let unlabeled: Prediction[] = [];
  for (const view of views) {
    const r = matchCases({
      config, view, cases, judgments: labels.judgments, overrides: labels.overrides, predictions: allPreds,
      coverage: anyCoverage ? coverage : null, corpusPages, corpusVersion, unresolvedSeeds: labels.unresolvedSeeds,
    });
    outcomes[view] = r.outcomes;
    if (view === "confirmed") unlabeled = r.unlabeled;
  }

  const criteria: CriterionMetrics[] = config.criteria.map((crit) => {
    const preds = allPreds.filter((p) => p.criterion === crit.id);
    const viewMetrics = {} as CriterionMetrics["views"];
    for (const view of views) {
      const outs = outcomes[view].filter((o) => o.criterion === crit.id);
      const by: Record<SampleOrigin, OriginMetrics> = {} as Record<SampleOrigin, OriginMetrics>;
      const instances = emptyCounts();
      const pooled = emptyCounts();
      const samples = new Map<string, { origin: SampleOrigin; classes: MatchClass[] }>();
      for (const o of outs) {
        if (!["TP", "FP", "FN", "TN"].includes(o.class)) continue;
        add(instances, o.class);
        const key = o.propagation_group ? `group:${o.propagation_group}` : `${o.case_id}|${o.assertion_id}`;
        const s = samples.get(key) ?? { origin: originOf(o, labels.judgments), classes: [] };
        s.classes.push(o.class);
        samples.set(key, s);
      }
      for (const origin of ["queue", "random", "audit", "seed"] as SampleOrigin[]) {
        const c = emptyCounts();
        for (const s of samples.values()) {
          if (s.origin !== origin) continue;
          // A group is one sample: its most frequent class, the worse on a tie
          const tally = new Map<MatchClass, number>();
          for (const cl of s.classes) tally.set(cl, (tally.get(cl) ?? 0) + 1);
          const cls = Array.from(tally.entries()).sort((a, b) => b[1] - a[1] || CLASS_RANK[b[0]] - CLASS_RANK[a[0]])[0][0];
          add(c, cls);
          add(pooled, cls);
        }
        by[origin] = { samples: c, precision: wilson(c.tp, c.tp + c.fp, minN), recall: wilson(c.tp, c.tp + c.fn, minN) };
      }
      viewMetrics[view] = { by_origin: by, pooled_samples: pooled, instances };
    }
    const conf = outcomes.confirmed.filter((o) => o.criterion === crit.id);
    const count = (cls: MatchClass) => conf.filter((o) => o.class === cls).length;
    const labeled = conf.filter((o) => o.verdict !== null);
    const nonFailed = preds.filter((p) => !p.tooling_error);
    return {
      criterion: crit.id,
      level: crit.level,
      coverage: crit.coverage,
      views: viewMetrics,
      counts: {
        sites: new Set(labeled.map((o) => o.site)).size,
        cases: new Set(labeled.map((o) => o.case_id)).size,
        clusters: new Set(labeled.map((o) => o.propagation_group ?? o.case_id)).size,
        labeled_instances: labeled.length,
        unsure: count("unsure"), disputed: count("disputed"), excluded: count("excluded"),
        tooling_errors: count("tooling_error") + preds.filter((p) => p.tooling_error).length,
        untested: count("untested"), ambiguous: count("ambiguous"), stale: count("stale"),
        unresolved_fixture: count("unresolved_fixture"), unreviewed: count("unreviewed"),
        predictions: preds.length,
        unlabeled_predictions: unlabeled.filter((p) => p.criterion === crit.id).length,
        needs_review_predictions: nonFailed.filter((p) => p.confidence_tier === "needs_review").length,
        api_failure_predictions: preds.filter((p) => p.tooling_error).length,
      },
      needs_review_rate: wilson(nonFailed.filter((p) => p.confidence_tier === "needs_review").length, nonFailed.length, minN),
      diagnostics: {
        known_defect_misses: conf.filter((o) => o.origin === "seed" && o.class === "FN").length,
        audit_misses: conf.filter((o) => o.origin === "independent_audit" && o.class === "FN").length,
        wrong_criterion: conf.filter((o) => o.wrong_criterion.length > 0 && o.class !== "TP").length,
        severity_disagreements: conf.filter((o) => o.severity_disagreement !== null).length,
      },
    };
  });

  // Precision by check (prediction side): queue and random samples only
  const checkMap = new Map<string, { tier: number | null; queue: Counts; random: Counts }>();
  const predByKey = new Map(allPreds.map((p) => [p.prediction_key, p]));
  for (const o of outcomes.confirmed) {
    if ((o.class !== "TP" && o.class !== "FP") || !o.prediction_key) continue;
    const origin = originOf(o, labels.judgments);
    if (origin !== "queue" && origin !== "random") continue;
    const p = predByKey.get(o.prediction_key)!;
    const entry = checkMap.get(p.check ?? "unknown") ?? { tier: p.tier, queue: emptyCounts(), random: emptyCounts() };
    add(entry[origin], o.class);
    checkMap.set(p.check ?? "unknown", entry);
  }
  const checks: CheckPrecision[] = Array.from(checkMap.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([check, e]) => ({
    check, tier: e.tier,
    precision_by_origin: { queue: wilson(e.queue.tp, e.queue.tp + e.queue.fp, minN), random: wilson(e.random.tp, e.random.tp + e.random.fp, minN) },
  }));

  return {
    run_id: run.manifest.run_id,
    split,
    corpus_version: corpusVersion,
    labels_through: labels.labelsThrough,
    views,
    criteria,
    checks,
    coverage: anyCoverage ? summarizeCoverage(run, config) : null,
    false_passes: falsePasses(config, run, outcomes.confirmed),
    wrong_criterion_assignments: outcomes.confirmed.filter((o) => o.wrong_criterion.length > 0 && o.class !== "TP").length,
    severity_disagreements: outcomes.confirmed.filter((o) => o.severity_disagreement !== null).length,
    unlabeled_predictions: unlabeled.length,
    outcomes,
  };
}

function summarizeCoverage(run: RunInputs, config: EvalConfig): CoverageSummary {
  const checks = [...config.check_classification.behavioral, ...config.check_classification.non_behavioral];
  const out: CoverageSummary = { ran: 0, partial: 0, failed: 0, skipped: 0, not_recorded: 0, not_applicable: 0, by_check: {} };
  for (const s of run.sites) {
    const rows = new Map((s.coverage ?? []).map((r) => [`${r.page}|${r.check}`, r]));
    for (const page of s.pages) {
      for (const check of checks) {
        const r = rows.get(`${page}|${check}`);
        let status: keyof Omit<CoverageSummary, "by_check">;
        if (!r) status = "not_recorded";
        else if (r.status === "skipped" && NOT_APPLICABLE_REASONS.some((re) => re.test(r.message ?? ""))) status = "not_applicable";
        else status = r.status as typeof status;
        out[status]++;
        const bc = out.by_check[check] ?? { ran: 0, partial: 0, failed: 0, skipped: 0, not_recorded: 0, not_applicable: 0 };
        bc[status]++;
        out.by_check[check] = bc;
      }
    }
  }
  return out;
}

/**
 * False-pass rules. Reported as the engine's current violations; statuses are
 * never rewritten to hide them.
 *   1. a known (labelled) violation cannot coexist with a criterion pass
 *   2. a criterion cannot pass when a check addressing it failed, ran
 *      partially or did not run on a page, or when its model evaluations
 *      failed, or when no check addresses it at all
 */
export function falsePasses(config: EvalConfig, run: RunInputs, confirmed: AssertionOutcome[]): FalsePass[] {
  const out: FalsePass[] = [];
  for (const s of run.sites) {
    const passed = new Set(s.criteria.filter((c) => c.status === "passed").map((c) => c.criterion));
    for (const o of confirmed.filter((x) => x.site === s.site && x.verdict === "violation" && passed.has(x.criterion))) {
      out.push({ rule: "known_violation_with_pass", site: s.site, criterion: o.criterion, detail: `${o.case_id} is a labelled violation on ${o.page}` });
    }
    const rows = new Map((s.coverage ?? []).map((r) => [`${r.page}|${r.check}`, r.status]));
    for (const criterion of passed) {
      const crit = config.criteria.find((c) => c.id === criterion);
      if (!crit || crit.checks.length === 0) {
        out.push({ rule: "pass_without_checks", site: s.site, criterion, detail: "no engine check addresses this criterion" });
        continue;
      }
      if (s.coverage) {
        const bad = s.pages.flatMap((page) => crit.checks.map((check) => ({ page, check, status: rows.get(`${page}|${check}`) ?? "not_recorded" })))
          .filter((x) => x.status === "failed" || x.status === "partial" || x.status === "not_recorded");
        if (bad.length > 0) {
          const kinds = Array.from(new Set(bad.map((b) => `${b.check}:${b.status}`))).slice(0, 6).join(", ");
          out.push({ rule: "pass_with_unestablished_checks", site: s.site, criterion, detail: `${bad.length} (page, check) pair(s) not established: ${kinds}` });
        }
      }
      const failures = s.predictions.filter((p) => p.criterion === criterion && p.tooling_error).length;
      if (failures > 0) out.push({ rule: "pass_with_api_failures", site: s.site, criterion, detail: `${failures} failed model evaluation(s)` });
    }
  }
  return out;
}

/** Aggregate-only export (by split, criterion, check and tier; no sites, pages or content). */
export function aggregateExport(report: MetricsReport, manifest: RunManifest) {
  return {
    schema_version: 1,
    metrics_of_run: report.run_id,
    engine: manifest.engine,
    split: report.split,
    corpus_version: report.corpus_version,
    labels_through: report.labels_through,
    criteria: report.criteria.map((c) => ({
      criterion: c.criterion, level: c.level, coverage: c.coverage,
      confirmed: c.views.confirmed.by_origin, inclusive: c.views.inclusive.by_origin,
      pooled_samples: { confirmed: c.views.confirmed.pooled_samples, inclusive: c.views.inclusive.pooled_samples },
      instances: { confirmed: c.views.confirmed.instances, inclusive: c.views.inclusive.instances },
      counts: { ...c.counts, sites: c.counts.sites },
      needs_review_rate: c.needs_review_rate,
      diagnostics: c.diagnostics,
    })),
    checks: report.checks,
    coverage: report.coverage,
    false_passes: report.false_passes.map((f) => ({ rule: f.rule, criterion: f.criterion })),
    false_pass_counts: report.false_passes.reduce<Record<string, number>>((m, f) => ({ ...m, [f.rule]: (m[f.rule] ?? 0) + 1 }), {}),
    wrong_criterion_assignments: report.wrong_criterion_assignments,
    severity_disagreements: report.severity_disagreements,
    unlabeled_predictions: report.unlabeled_predictions,
  };
}
