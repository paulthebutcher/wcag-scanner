import { canonicalJson, sha256 } from "./util.js";
import { multisetDiff } from "./normalize.js";
import { matchCases, coverageMap, type AssertionOutcome } from "./matcher.js";
import { falsePasses, computeMetrics, type RunInputs, type LabelInputs, type FalsePass } from "./metrics.js";
import type { EvalConfig } from "./config.js";
import type { RunManifest } from "./manifest.js";
import type { Prediction } from "./predictions.js";
import type { LabelEvent } from "./labels.js";
import type { StaticCaseOutcome } from "./static.js";
import type { RepeatabilityReport } from "./runs.js";

// ---------------------------------------------------------------------------
// D7 compare and gate. Consumes two pinned runs, verifies they are
// comparable, rescored both against one label snapshot, and decides:
//   0  valid comparison, no regression
//   1  valid comparison with a regression
//   2  invalid or incomplete comparison
// Regressions protect individual known defects at any n; metric drops count
// only for gated splits with n ≥ the configured minimum. Existing oracle
// failures that are not new are printed as existing blockers.
// ---------------------------------------------------------------------------

export interface CompareInputs {
  config: EvalConfig;
  base: RunInputs;
  head: RunInputs;
  labels: LabelInputs;
  /** sha256 of the label events folded (through labels.labelsThrough) */
  labelSnapshotSha: string;
  /** If given, the snapshot the caller pinned; a different one is an invalid comparison */
  expectedLabelSnapshotSha?: string;
  /** Static results for the same two engines (optional) */
  staticBase?: StaticCaseOutcome[];
  staticHead?: StaticCaseOutcome[];
  staticSettled?: Set<string>;
  /** Corpus verification problems (artifact corruption) */
  corpusProblems?: string[];
  /** Corpus page DOM (dom.html) for the anchoring check; null when the page is not in the corpus */
  pageDom?: (site: string, page: string) => string | null;
}

export interface UnanchoredCase {
  case_id: string;
  site: string;
  page: string;
  reason: "page not in corpus" | "element HTML not found on the page" | "no element HTML to verify";
}

/**
 * Cases with a settled or provisional judgment whose target cannot be found
 * in the corpus: a dead case would otherwise count as TN or FN without
 * testing anything. Page-level cases (no selector, no HTML) are anchored by
 * their page; a selector-only case cannot be verified from the DOM string.
 */
export function unanchoredCases(cases: LabelInputs["cases"], judgments: LabelInputs["judgments"], pageDom: (site: string, page: string) => string | null): UnanchoredCase[] {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const out: UnanchoredCase[] = [];
  for (const c of cases) {
    if (c.page === "scan") continue;
    if (!c.assertions.some((a) => judgments.has(`${c.case_id}|${a.assertion_id}`))) continue;
    const dom = pageDom(c.site, c.page);
    const base = { case_id: c.case_id, site: c.site, page: c.page };
    if (dom === null) { out.push({ ...base, reason: "page not in corpus" }); continue; }
    if (c.target.html) {
      if (!norm(dom).includes(norm(c.target.html))) out.push({ ...base, reason: "element HTML not found on the page" });
    } else if (c.target.selector) {
      out.push({ ...base, reason: "no element HTML to verify" });
    }
  }
  return out.sort((a, b) => a.case_id.localeCompare(b.case_id));
}

export interface Regression {
  kind: "tp_lost" | "static_broken" | "fp_returned" | "severity_regressed" | "false_pass" | "coverage_dropped" | "metric_drop";
  detail: string;
}

export interface CompareResult {
  exit: 0 | 1 | 2;
  invalid: string[];
  regressions: Regression[];
  existing_blockers: Regression[];
  report: {
    findings_added: Record<string, number>;
    findings_removed: Record<string, number>;
    criterion_transitions: Array<{ site: string; criterion: string; base: string; head: string }>;
    case_changes: Array<{ case_id: string; assertion_id: string; criterion: string; base: string; head: string }>;
    severity_disagreements: { base: number; head: number };
    unlabeled: { base: number; head: number };
    coverage_changes: Array<{ site: string; page: string; check: string; base: string; head: string }>;
    /** "compared", or why coverage could not be compared (an engine without coverage recording) */
    coverage_comparison: string;
    tooling_errors: { base: number; head: number };
    ambiguities: { base: number; head: number };
    flake_rates: { base: Array<{ check: string; flake_rate: number | null }>; head: Array<{ check: string; flake_rate: number | null }> };
    shared_pages: number;
    /** Judged cases whose target is not in the corpus (see unanchoredCases); null when no page DOM was given */
    unanchored: UnanchoredCase[] | null;
  };
}

export function labelSnapshotSha(events: LabelEvent[], through: number): string {
  return sha256(events.filter((e) => e.seq <= through).sort((a, b) => a.seq - b.seq).map((e) => canonicalJson(e)).join("\n"));
}

function contract(m: RunManifest) {
  const c = m.scan_contract;
  return c ? { viewport: c.viewport, locale: c.locale, timezone: c.timezone, user_agent: c.user_agent, page_order: c.page_order, page_concurrency: c.page_concurrency, service_workers: c.service_workers, tiers: c.tiers } : null;
}

function preconditions(i: CompareInputs): string[] {
  const out: string[] = [];
  const { base, head } = i;
  for (const [name, r] of [["base", base], ["head", head]] as const) {
    const m = r.manifest;
    if (m.completion !== "completed") out.push(`${name} run did not complete`);
    if (!m.validity.valid) out.push(`${name} run is invalid: ${m.validity.reasons.join("; ")}`);
    if (m.harness.dirty) out.push(`${name} run was made on a dirty tree`);
    if (!m.corpus) out.push(`${name} run has no corpus`);
    if (m.totals.har_misses + m.totals.cache_misses + m.totals.image_misses + m.totals.attempted_egress > 0) out.push(`${name} run has misses or egress`);
    const rep = m.extra?.repeatability as RepeatabilityReport | null | undefined;
    if (rep && !rep.non_behavioral_identical) out.push(`${name} run has unresolved repeatability (non-behavioral checks varied)`);
  }
  const bc = base.manifest.corpus, hc = head.manifest.corpus;
  if (bc && hc) {
    if (bc.version !== hc.version || bc.split !== hc.split) out.push("runs used different corpus versions or splits");
    if (bc.page_set_sha256 !== hc.page_set_sha256) out.push("runs used different page sets");
    if (canonicalJson(bc.artifact_hashes) !== canonicalJson(hc.artifact_hashes)) out.push("artifact hashes differ between runs");
  }
  if (canonicalJson(contract(base.manifest)) !== canonicalJson(contract(head.manifest))) out.push("browser contracts differ");
  const bm = base.manifest.model, hm = head.manifest.model;
  if (!bm || !hm || bm.mode !== "replay" || hm.mode !== "replay") out.push("both runs must replay recorded model responses");
  if (bm && hm && bm.image_index_sha256 !== hm.image_index_sha256) out.push("runs used different image indexes");
  if (i.expectedLabelSnapshotSha && i.expectedLabelSnapshotSha !== i.labelSnapshotSha) out.push("label snapshot changed (labels were rewritten or the pinned sequence differs)");
  for (const p of i.corpusProblems ?? []) out.push(`corpus: ${p}`);
  return out;
}

function outcomesFor(i: CompareInputs, run: RunInputs, view: "confirmed"): { outcomes: AssertionOutcome[]; unlabeled: Prediction[] } {
  const preds = run.sites.flatMap((s) => s.predictions);
  const coverage = new Map<string, string>();
  let any = false;
  for (const s of run.sites) {
    const m = coverageMap(s.site, s.coverage);
    if (m) { any = true; for (const [k, v] of m) coverage.set(k, v); }
  }
  const sites = new Set(run.sites.map((s) => s.site));
  const r = matchCases({
    config: i.config, view, cases: i.labels.cases.filter((c) => sites.has(c.site)), judgments: i.labels.judgments, overrides: i.labels.overrides,
    predictions: preds, coverage: any ? coverage : null, corpusPages: new Set(run.sites.flatMap((s) => s.pages.map((p) => `${s.site}/${p}`))),
    corpusVersion: run.manifest.corpus!.version, unresolvedSeeds: i.labels.unresolvedSeeds,
  });
  return { outcomes: r.outcomes, unlabeled: r.unlabeled };
}

const fpKey = (f: FalsePass) => `${f.site}|${f.criterion}|${f.rule}`;

export function compareRuns(i: CompareInputs): CompareResult {
  const invalid = preconditions(i);
  const regressions: Regression[] = [];
  const blockers: Regression[] = [];
  const base = outcomesFor(i, i.base, "confirmed");
  const head = outcomesFor(i, i.head, "confirmed");
  const key = (o: AssertionOutcome) => `${o.case_id}|${o.assertion_id}`;
  const headByKey = new Map(head.outcomes.map((o) => [key(o), o]));
  const caseChanges: CompareResult["report"]["case_changes"] = [];

  for (const b of base.outcomes) {
    const h = headByKey.get(key(b));
    if (!h) continue;
    if (b.class !== h.class) caseChanges.push({ case_id: b.case_id, assertion_id: b.assertion_id, criterion: b.criterion, base: b.class, head: h.class });
    const settled = b.verdict !== null && b.class !== "disputed" && b.class !== "unsure" && b.class !== "excluded";
    if (!settled) continue;
    if (b.class === "TP" && h.class !== "TP") {
      regressions.push({ kind: "tp_lost", detail: `${b.case_id}/${b.assertion_id} (${b.criterion}): TP → ${h.class}${h.wrong_criterion.length ? ` (now reported as ${h.wrong_criterion.join(", ")})` : ""}` });
    } else if (b.class === "TN" && h.class === "FP") {
      regressions.push({ kind: "fp_returned", detail: `${b.case_id}/${b.assertion_id} (${b.criterion}): TN → FP` });
    } else if (b.class === "TP" && h.class === "TP" && !b.severity_disagreement && h.severity_disagreement) {
      regressions.push({ kind: "severity_regressed", detail: `${b.case_id}/${b.assertion_id} (${b.criterion}): severity ${h.severity_disagreement.engine}, corrected ${h.severity_disagreement.corrected}` });
    }
    // Existing oracle failures present in both
    if (b.class === "FN" && h.class === "FN") blockers.push({ kind: "tp_lost", detail: `${b.case_id}/${b.assertion_id} (${b.criterion}): FN in both` });
    if (b.class === "FP" && h.class === "FP") blockers.push({ kind: "fp_returned", detail: `${b.case_id}/${b.assertion_id} (${b.criterion}): FP in both` });
  }

  // Static set: a settled case that passed at base and fails at head
  if (i.staticBase && i.staticHead) {
    const h = new Map(i.staticHead.map((o) => [o.case_id, o]));
    for (const b of i.staticBase) {
      if (i.staticSettled && !i.staticSettled.has(b.case_id)) continue;
      const ho = h.get(b.case_id);
      if (!ho) continue;
      if (b.outcome === "pass" && ho.outcome === "fail") regressions.push({ kind: "static_broken", detail: `${b.case_id}: ${ho.reason}` });
      else if (b.outcome === "fail" && ho.outcome === "fail") blockers.push({ kind: "static_broken", detail: `${b.case_id}: fails in both (${ho.reason})` });
      else if (b.outcome === "pass" && ho.outcome === "unavailable") invalid.push(`static ${b.case_id} unavailable at head (${ho.reason})`);
    }
  }

  // False passes: new ones are regressions; shared ones are blockers
  const fpBase = falsePasses(i.config, i.base, base.outcomes);
  const fpHead = falsePasses(i.config, i.head, head.outcomes);
  const baseFp = new Set(fpBase.map(fpKey));
  for (const f of fpHead) {
    if (baseFp.has(fpKey(f))) blockers.push({ kind: "false_pass", detail: `${f.site} ${f.criterion} ${f.rule}: ${f.detail}` });
    else regressions.push({ kind: "false_pass", detail: `${f.site} ${f.criterion} ${f.rule}: ${f.detail}` });
  }

  // Coverage: a (page, check) that ran at base and no longer does
  const coverageChanges: CompareResult["report"]["coverage_changes"] = [];
  let coverageComparison = "compared";
  const established = (s: string) => s === "ran" || s === "partial";
  for (const bs of i.base.sites) {
    const hs = i.head.sites.find((x) => x.site === bs.site);
    if (!hs) { invalid.push(`site ${bs.site} missing from head`); continue; }
    if (bs.coverage && !hs.coverage) { invalid.push(`head run for ${bs.site} records no coverage`); continue; }
    if (!bs.coverage || !hs.coverage) {
      coverageComparison = `unavailable for ${bs.site}: the ${!bs.coverage ? "base" : "head"} engine records no coverage`;
      continue;
    }
    const hm = new Map(hs.coverage.map((r) => [`${r.page}|${r.check}`, r.status]));
    for (const r of bs.coverage) {
      const now = hm.get(`${r.page}|${r.check}`) ?? "not_recorded";
      if (now !== r.status) coverageChanges.push({ site: bs.site, page: r.page, check: r.check, base: r.status, head: now });
      if (r.status === "ran" && !established(now)) regressions.push({ kind: "coverage_dropped", detail: `${bs.site}/${r.page} ${r.check}: ran → ${now}` });
    }
  }

  // Metric drops on gated splits with enough evidence
  const g = i.config.gate;
  if (g.metric_gate_splits.includes(i.head.manifest.corpus?.split ?? "")) {
    const mb = computeMetrics(i.config, i.base, i.labels);
    const mh = computeMetrics(i.config, i.head, i.labels);
    for (const cb of mb.criteria) {
      const ch = mh.criteria.find((x) => x.criterion === cb.criterion)!;
      for (const [origin, metric] of [["queue", "precision"], ["random", "precision"], ["audit", "recall"]] as const) {
        const rb = cb.views.confirmed.by_origin[origin][metric];
        const rh = ch.views.confirmed.by_origin[origin][metric];
        if (rb.value === null || rh.value === null || rb.n < g.metric_gate_min_n || rh.n < g.metric_gate_min_n) continue;
        if (rb.value - rh.value > g.metric_drop_threshold) {
          regressions.push({ kind: "metric_drop", detail: `${cb.criterion} ${origin} ${metric}: ${rb.value} → ${rh.value} (n ${rb.n} → ${rh.n})` });
        }
      }
    }
  }

  // Always-reported deltas
  const fkey = (p: Prediction) => `${p.criterion}|${p.failure_type ?? "-"}`;
  const occ = (p: Prediction) => `${p.site}|${p.page}|${p.criterion}|${p.selector}|${p.html_sha256}|${p.failure_type}|${p.check}|${p.state}`;
  const sharedPages = new Set(i.base.sites.flatMap((s) => s.pages.map((p) => `${s.site}/${p}`)).filter((k) => i.head.sites.some((s) => s.pages.some((p) => `${s.site}/${p}` === k))));
  const onShared = (p: Prediction) => sharedPages.has(`${p.site}/${p.page}`);
  const bp = i.base.sites.flatMap((s) => s.predictions).filter(onShared);
  const hp = i.head.sites.flatMap((s) => s.predictions).filter(onShared);
  const tag = (p: Prediction) => ({ o: occ(p), f: fkey(p) });
  const diff = multisetDiff(bp.map(tag), hp.map(tag));
  const tally = (xs: Array<{ f: string }>) => xs.reduce<Record<string, number>>((m, x) => ({ ...m, [x.f]: (m[x.f] ?? 0) + 1 }), {});
  const added = tally(diff.onlyB);
  const removed = tally(diff.onlyA);
  const transitions: CompareResult["report"]["criterion_transitions"] = [];
  for (const bs of i.base.sites) {
    const hs = i.head.sites.find((x) => x.site === bs.site);
    if (!hs) continue;
    const hmap = new Map(hs.criteria.map((c) => [c.criterion, c.status]));
    for (const c of bs.criteria) if ((hmap.get(c.criterion) ?? "absent") !== c.status) transitions.push({ site: bs.site, criterion: c.criterion, base: c.status, head: hmap.get(c.criterion) ?? "absent" });
  }
  const flake = (m: RunManifest) => ((m.extra?.repeatability as RepeatabilityReport | null | undefined)?.checks ?? []).filter((c) => c.behavioral).map((c) => ({ check: c.check, flake_rate: c.flake_rate }));
  const tooling = (r: RunInputs, o: AssertionOutcome[]) => r.sites.flatMap((s) => s.predictions).filter((p) => p.tooling_error).length + o.filter((x) => x.class === "tooling_error").length;

  const exit: 0 | 1 | 2 = invalid.length > 0 ? 2 : regressions.length > 0 ? 1 : 0;
  return {
    exit,
    invalid,
    regressions,
    existing_blockers: blockers,
    report: {
      findings_added: added,
      findings_removed: removed,
      criterion_transitions: transitions,
      case_changes: caseChanges,
      severity_disagreements: { base: base.outcomes.filter((o) => o.severity_disagreement).length, head: head.outcomes.filter((o) => o.severity_disagreement).length },
      unlabeled: { base: base.unlabeled.length, head: head.unlabeled.length },
      coverage_changes: coverageChanges,
      coverage_comparison: coverageComparison,
      tooling_errors: { base: tooling(i.base, base.outcomes), head: tooling(i.head, head.outcomes) },
      ambiguities: { base: base.outcomes.filter((o) => o.class === "ambiguous").length, head: head.outcomes.filter((o) => o.class === "ambiguous").length },
      flake_rates: { base: flake(i.base.manifest), head: flake(i.head.manifest) },
      shared_pages: sharedPages.size,
      unanchored: i.pageDom ? unanchoredCases(i.labels.cases.filter((c) => i.head.sites.some((s) => s.site === c.site)), i.labels.judgments, i.pageDom) : null,
    },
  };
}
