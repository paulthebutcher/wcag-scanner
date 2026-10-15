import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { compareRuns, labelSnapshotSha, unanchoredCases, type CompareInputs } from "../../src/eval/compare.js";
import { loadEvalConfig } from "../../src/eval/config.js";
import { evalPaths } from "../../src/eval/paths.js";
import { foldLabels, officialJudgments, LABEL_SCHEMA, type CaseRecord, type LabelEvent } from "../../src/eval/labels.js";
import { assertValid } from "../../src/eval/schema.js";
import { computeMetrics, type RunInputs } from "../../src/eval/metrics.js";
import type { Prediction } from "../../src/eval/predictions.js";
import type { CoverageRow, CriterionStatusRow } from "../../src/eval/normalize.js";
import type { RunManifest } from "../../src/eval/manifest.js";
import type { StaticCaseOutcome } from "../../src/eval/static.js";
import { sha256 } from "../../src/eval/util.js";

const REPO = join(import.meta.dirname, "..", "..");
const config = loadEvalConfig(evalPaths(REPO).config);
const PAGES = ["p001", "p002"];

function c(id: number, page: string, selector: string, criterion: string): CaseRecord {
  return {
    case_id: `C-${String(id).padStart(6, "0")}`, revision: 1, revision_reason: null, created_at: "2026-10-12T00:00:00Z", created_by: "paul", site: "t01", page,
    corpus_version: "v1", unit: "element", target: { selector, html: `<x class="${selector}">`, html_sha256: sha256(`<x class="${selector}">`), context_sha256: null, state: null },
    assertions: [{ assertion_id: "A1", criterion, issue: "i", failure_type: null }], origin: "review", propagation_group: null, evidence_refs: [], source_seed_id: null,
  };
}
function l(seq: number, cs: CaseRecord, verdict: LabelEvent["verdict"], extra: Partial<LabelEvent> = {}): LabelEvent {
  return {
    label_id: `L-${String(seq).padStart(6, "0")}`, seq, kind: "judgment", case_id: cs.case_id, assertion_id: "A1", verdict, severity_correction: null, reviewer: "paul",
    batch: "queue", phase: null, active_seconds: 5, timestamp: "2026-10-12T00:00:00Z", propagation_group: null, propagation_source: null, undoes: null, prediction_ref: null, note: null, ...extra,
  };
}
function p(page: string, selector: string, criterion: string, extra: Partial<Prediction> = {}): Prediction {
  const html = `<x class="${selector}">`;
  return {
    prediction_key: sha256(`${page}${selector}${criterion}${JSON.stringify(extra)}`).slice(0, 12), site: "t01", page, criterion, selector, element_html: html, html_sha256: sha256(html),
    failure_type: "f", check: criterion === "1.1.1" ? "alt-text" : "landmark-labels", tier: 3, state: "load", severity: "major", confidence_tier: "high", confidence_score: 0.9,
    detected_by: "claude_api", reasoning: "r", tooling_error: false, model_image: false, also_found_on: [], evidence: { element_screenshot: null, context_screenshot: null, page_screenshot: null }, measured_values: {}, ...extra,
  };
}

function manifest(label: string, extra: Partial<RunManifest> = {}): RunManifest {
  return {
    run_id: `replay-20261012T00000${label === "base" ? 0 : 1}Z-abcdef`, completion: "completed", purpose: "official-regression",
    validity: { valid: true, official: true, reasons: [], unavailable: [] }, harness: { sha: "a".repeat(40), dirty: false, changed_paths: [] },
    corpus: { version: "v1", split: "tuning", sites: ["t01"], page_set_sha256: "b".repeat(64), artifact_hashes: { "t01/p001": "c".repeat(64), "t01/p002": "d".repeat(64) }, exclusions: [], declared_exclusions_version: 1 },
    scan_contract: { tiers: [1, 2, 3, 4, 5], checks: null, viewport: { width: 1280, height: 800, deviceScaleFactor: 1 }, locale: "en-US", timezone: "America/Denver", user_agent: "ua", page_order: ["t01/p001", "t01/p002"], page_concurrency: 1, llm_concurrency: 5, service_workers: "block" },
    model: { cache_namespace: "ns", mode: "replay", entries_read: 1, entries_created: 0, model_ids: [], template_hashes: {}, system_prompt_hashes: {}, parameters: {}, image_index_sha256: "e".repeat(64), shared_responses: 0, entries_sha256: null, cost_usd_estimate: 0 },
    totals: { pages: 2, coverage: {}, tooling_errors: 0, ambiguities: 0, image_misses: 0, har_misses: 0, cache_misses: 0, attempted_egress: 0, contained_submissions: 0, declared_exclusion_hits: 0 },
    engine: { label, sha: "f".repeat(40), bridge: null }, extra: {}, ...extra,
  } as unknown as RunManifest;
}

const cov = (): CoverageRow[] => PAGES.flatMap((page) => ["alt-text", "axe-core", "landmark-labels", "headings", "table-structure", "keyboard"].map((check) => ({ check, page, status: "ran", message: null })));
const crit = (): CriterionStatusRow[] => [{ criterion: "1.1.1", status: "failed", tested_by: "claude_api", evidence_summary: "" }, { criterion: "2.1.1", status: "passed", tested_by: "playwright", evidence_summary: "" }];

function run(label: string, predictions: Prediction[], opts: { coverage?: CoverageRow[]; criteria?: CriterionStatusRow[]; manifest?: Partial<RunManifest> } = {}): RunInputs {
  return { manifest: manifest(label, opts.manifest), runDir: "/tmp", sites: [{ site: "t01", predictions, coverage: opts.coverage ?? cov(), criteria: opts.criteria ?? crit(), pages: PAGES }] };
}

// Ground truth: tp case (engine finds it), tn case (engine is clean), fn case (engine misses it in both)
const tp = c(1, "p001", "img.a", "1.1.1");
const tn = c(2, "p001", "img.b", "1.1.1");
const fn = c(3, "p002", "nav.x", "1.3.1");
const events = [l(1, tp, "violation"), l(2, tn, "no_violation"), l(3, fn, "violation")];
const basePreds = [p("p001", "img.a", "1.1.1")];

function inputs(base: RunInputs, head: RunInputs, extra: Partial<CompareInputs> = {}): CompareInputs {
  return {
    config, base, head, labels: { cases: [tp, tn, fn], judgments: foldLabels(events), overrides: [], unresolvedSeeds: new Set(), labelsThrough: 3 },
    labelSnapshotSha: labelSnapshotSha(events, 3), ...extra,
  };
}

describe("compare and gate (D7)", () => {
  it("valid comparison with no regression exits 0 and prints existing blockers", () => {
    const r = compareRuns(inputs(run("base", basePreds), run("head", basePreds)));
    expect(r.exit).toBe(0);
    expect(r.existing_blockers.map((b) => b.detail)).toEqual(expect.arrayContaining([expect.stringContaining("C-000003/A1 (1.3.1): FN in both")]));
  });

  it("removing a true finding is a regression (exit 1)", () => {
    const r = compareRuns(inputs(run("base", basePreds), run("head", [])));
    expect(r.exit).toBe(1);
    expect(r.regressions[0].kind).toBe("tp_lost");
    expect(r.report.findings_removed["1.1.1|f"]).toBe(1);
  });

  it("reintroducing a false positive is a regression (exit 1)", () => {
    const r = compareRuns(inputs(run("base", basePreds), run("head", [...basePreds, p("p001", "img.b", "1.1.1")])));
    expect(r.exit).toBe(1);
    expect(r.regressions.map((x) => x.kind)).toContain("fp_returned");
    expect(r.report.findings_added["1.1.1|f"]).toBe(1);
  });

  it("dropping coverage is a regression (exit 1)", () => {
    const dropped = cov().map((x) => (x.check === "keyboard" && x.page === "p002" ? { ...x, status: "failed" } : x));
    const r = compareRuns(inputs(run("base", basePreds), run("head", basePreds, { coverage: dropped })));
    expect(r.exit).toBe(1);
    expect(r.regressions.map((x) => x.kind)).toContain("coverage_dropped");
    expect(r.report.coverage_comparison).toBe("compared");
    const noCov = compareRuns(inputs({ ...run("base", basePreds), sites: [{ ...run("base", basePreds).sites[0], coverage: null }] }, run("head", basePreds)));
    expect(noCov.report.coverage_comparison).toContain("base engine records no coverage");
  });

  it("a failed API call that loses a settled TP is a regression (exit 1)", () => {
    const failed = [p("p001", "img.a", "1.1.1", { tooling_error: true, confidence_tier: "needs_review", reasoning: "Prompt evaluation failed after 1 retries: 529" })];
    const r = compareRuns(inputs(run("base", basePreds), run("head", failed)));
    expect(r.exit).toBe(1);
    expect(r.regressions[0].detail).toContain("TP → tooling_error");
    expect(r.report.tooling_errors.head).toBeGreaterThan(r.report.tooling_errors.base);
  });

  it("creating a false pass is a regression (exit 1)", () => {
    const headCrit = [{ criterion: "1.1.1", status: "passed", tested_by: "claude_api", evidence_summary: "" }, crit()[1]];
    const r = compareRuns(inputs(run("base", basePreds), run("head", basePreds, { criteria: headCrit })));
    expect(r.exit).toBe(1);
    expect(r.regressions.map((x) => x.kind)).toContain("false_pass");
    expect(r.report.criterion_transitions).toEqual([{ site: "t01", criterion: "1.1.1", base: "failed", head: "passed" }]);
  });

  it("changing a finding's criterion is a regression (exit 1)", () => {
    const r = compareRuns(inputs(run("base", basePreds), run("head", [p("p001", "img.a", "2.4.4")])));
    expect(r.exit).toBe(1);
    expect(r.regressions[0].detail).toContain("now reported as 2.4.4");
  });

  it("a corrupted artifact makes the comparison invalid (exit 2)", () => {
    const corrupted = run("head", basePreds, { manifest: { corpus: { ...manifest("head").corpus!, artifact_hashes: { "t01/p001": "0".repeat(64), "t01/p002": "d".repeat(64) } } } });
    expect(compareRuns(inputs(run("base", basePreds), corrupted)).exit).toBe(2);
    const r = compareRuns(inputs(run("base", basePreds), run("head", basePreds), { corpusProblems: ["checksum mismatch p001/page.har"] }));
    expect(r.exit).toBe(2);
    expect(r.invalid[0]).toContain("checksum mismatch");
  });

  it("a changed label snapshot makes the comparison invalid (exit 2)", () => {
    const pinned = labelSnapshotSha(events, 3);
    const rewritten = [l(1, tp, "violation"), l(2, tn, "violation"), l(3, fn, "violation")];
    const r = compareRuns({ ...inputs(run("base", basePreds), run("head", basePreds)), labelSnapshotSha: labelSnapshotSha(rewritten, 3), expectedLabelSnapshotSha: pinned });
    expect(r.exit).toBe(2);
    expect(r.invalid).toContain("label snapshot changed (labels were rewritten or the pinned sequence differs)");
  });

  it("dirty trees, misses, unresolved repeatability and incompatible contracts are invalid (exit 2)", () => {
    const dirty = run("head", basePreds, { manifest: { harness: { sha: "a".repeat(40), dirty: true, changed_paths: ["src/x.ts"] } } });
    expect(compareRuns(inputs(run("base", basePreds), dirty)).exit).toBe(2);
    const misses = run("head", basePreds, { manifest: { totals: { ...manifest("head").totals, cache_misses: 3 } } });
    expect(compareRuns(inputs(run("base", basePreds), misses)).exit).toBe(2);
    const flaky = run("head", basePreds, { manifest: { extra: { repeatability: { non_behavioral_identical: false, checks: [] } } } });
    expect(compareRuns(inputs(run("base", basePreds), flaky)).exit).toBe(2);
    const contract = run("head", basePreds, { manifest: { scan_contract: { ...manifest("head").scan_contract!, locale: "en-GB" } } });
    expect(compareRuns(inputs(run("base", basePreds), contract)).exit).toBe(2);
  });

  it("a settled static case that breaks is a regression; one failing in both is an existing blocker", () => {
    const o = (id: string, outcome: StaticCaseOutcome["outcome"]): StaticCaseOutcome => ({ case_id: id, engine: "x", outcome, reason: "r", confirmed_detected: null, inclusive_detected: null, severity_ok: null, matched: [] });
    const r = compareRuns(inputs(run("base", basePreds), run("head", basePreds), {
      staticBase: [o("LS-001", "pass"), o("LS-012", "fail")], staticHead: [o("LS-001", "fail"), o("LS-012", "fail")], staticSettled: new Set(["LS-001", "LS-012"]),
    }));
    expect(r.exit).toBe(1);
    expect(r.regressions.map((x) => x.kind)).toEqual(["static_broken"]);
    expect(r.existing_blockers.map((x) => x.kind)).toContain("static_broken");
  });

  it("a corrected severity that regresses is a regression", () => {
    const sevEvents = [l(1, tp, "violation", { severity_correction: "major" }), l(2, tn, "no_violation"), l(3, fn, "violation")];
    const i = { ...inputs(run("base", basePreds), run("head", [p("p001", "img.a", "1.1.1", { severity: "critical" })])), labels: { cases: [tp, tn, fn], judgments: foldLabels(sevEvents), overrides: [], unresolvedSeeds: new Set<string>(), labelsThrough: 3 } };
    const r = compareRuns(i);
    expect(r.exit).toBe(1);
    expect(r.regressions[0].kind).toBe("severity_regressed");
  });

  it("a precision drop above the threshold counts on gated splits with n ≥ 30", () => {
    const cases: CaseRecord[] = [];
    const evs: LabelEvent[] = [];
    const preds: Prediction[] = [];
    for (let n = 0; n < 40; n++) {
      const cs = c(100 + n, "p001", `e${n}`, "1.1.1");
      cases.push(cs);
      evs.push(l(10 + n, cs, n < 36 ? "violation" : "no_violation"));
      preds.push(p("p001", `e${n}`, "1.1.1"));
    }
    // Head adds 8 false positives on cases labelled clean
    for (let n = 0; n < 8; n++) {
      const cs = c(200 + n, "p002", `clean${n}`, "1.1.1");
      cases.push(cs);
      evs.push(l(60 + n, cs, "no_violation"));
    }
    const headPreds = [...preds, ...Array.from({ length: 8 }, (_, n) => p("p002", `clean${n}`, "1.1.1"))];
    const dev = (label: string, ps: Prediction[]) => run(label, ps, { manifest: { corpus: { ...manifest(label).corpus!, split: "dev" } } });
    const r = compareRuns({ config, base: dev("base", preds), head: dev("head", headPreds), labels: { cases, judgments: foldLabels(evs), overrides: [], unresolvedSeeds: new Set(), labelsThrough: 100 }, labelSnapshotSha: "x" });
    expect(r.exit).toBe(1);
    expect(r.regressions.map((x) => x.kind)).toContain("metric_drop");
  });
});

describe("provisional labels", () => {
  const fpCase = c(4, "p002", "a.logo", "1.1.1");
  const provisional = [...events, l(4, fpCase, "no_violation", { provisional: true, batch: "adhoc", reviewer: "review-doc:popfly-scan-review-2026-10-13" })];
  const provInputs = (base: RunInputs, head: RunInputs): CompareInputs => ({
    config, base, head, labels: { cases: [tp, tn, fn, fpCase], judgments: foldLabels(provisional), overrides: [], unresolvedSeeds: new Set(), labelsThrough: 4 },
    labelSnapshotSha: labelSnapshotSha(provisional, 4),
  });

  it("validates and folds the provisional flag; official judgments leave it out until confirmed", () => {
    expect(() => assertValid(LABEL_SCHEMA, provisional[3], "label")).not.toThrow();
    const folded = foldLabels(provisional);
    expect(folded.get("C-000004|A1")?.provisional).toBe(true);
    expect(officialJudgments(folded).has("C-000004|A1")).toBe(false);
    expect(officialJudgments(folded).has("C-000001|A1")).toBe(true);
    const confirmed = foldLabels([...provisional, l(5, fpCase, "no_violation")]);
    expect(confirmed.get("C-000004|A1")?.provisional).toBe(false);
    expect(officialJudgments(confirmed).has("C-000004|A1")).toBe(true);
  });

  it("counts in the gate: a provisional false positive that returns is a regression", () => {
    const r = compareRuns(provInputs(run("base", basePreds), run("head", [...basePreds, p("p002", "a.logo", "1.1.1")])));
    expect(r.exit).toBe(1);
    expect(r.regressions.map((x) => x.detail)).toEqual(expect.arrayContaining([expect.stringContaining("C-000004/A1 (1.1.1): TN → FP")]));
  });

  it("removing a finding that matches a provisional false-positive case is not a regression", () => {
    const r = compareRuns(provInputs(run("base", [...basePreds, p("p002", "a.logo", "1.1.1")]), run("head", basePreds)));
    expect(r.exit).toBe(0);
    expect(r.report.case_changes).toEqual([{ case_id: "C-000004", assertion_id: "A1", criterion: "1.1.1", base: "FP", head: "TN" }]);
  });

  it("stays out of official metrics", () => {
    const labels = { cases: [tp, tn, fn, fpCase], judgments: foldLabels(provisional), overrides: [], unresolvedSeeds: new Set<string>(), labelsThrough: 4 };
    const m = computeMetrics(config, run("head", [...basePreds, p("p002", "a.logo", "1.1.1")]), labels);
    const outcome = m.outcomes.confirmed.find((o) => o.case_id === "C-000004");
    expect(outcome?.class).toBe("unreviewed");
  });
});

describe("anchoring check: judged cases must point at an element in the corpus", () => {
  const dom = (site: string, page: string) => (page === "p001" ? `<html><body><x   class="img.a"><x class="img.b"></body></html>` : page === "p002" ? "<html><body></body></html>" : null);
  const pageLevel: CaseRecord = { ...c(5, "p001", "x", "1.1.1"), target: { selector: null, html: null, html_sha256: null, context_sha256: null, state: null } };
  const selectorOnly: CaseRecord = { ...c(6, "p001", "div.y", "1.1.1"), target: { selector: "div.y", html: null, html_sha256: null, context_sha256: null, state: null } };
  const offCorpus = c(7, "p047", "a.logo", "1.1.1");
  const unjudged = c(8, "p002", "nav.z", "1.3.1");
  const ev = [...events, l(4, pageLevel, "no_violation"), l(5, selectorOnly, "no_violation"), l(6, offCorpus, "no_violation", { provisional: true })];
  const judgments = foldLabels(ev);

  it("lists judged cases whose page or element is missing, and only those", () => {
    const out = unanchoredCases([tp, tn, fn, pageLevel, selectorOnly, offCorpus, unjudged], judgments, dom);
    expect(out.map((u) => [u.case_id, u.reason])).toEqual([
      ["C-000003", "element HTML not found on the page"],
      ["C-000006", "no element HTML to verify"],
      ["C-000007", "page not in corpus"],
    ]);
  });

  it("is reported by compare when the corpus DOM is given, without changing the exit", () => {
    const r = compareRuns({ ...inputs(run("base", basePreds), run("head", basePreds)), labels: { cases: [tp, tn, fn, offCorpus], judgments, overrides: [], unresolvedSeeds: new Set(), labelsThrough: 6 }, labelSnapshotSha: labelSnapshotSha(ev, 6), pageDom: dom });
    expect(r.exit).toBe(0);
    expect(r.report.unanchored?.map((u) => u.case_id)).toEqual(["C-000003", "C-000007"]);
    expect(compareRuns(inputs(run("base", basePreds), run("head", basePreds))).report.unanchored).toBeNull();
  });
});
