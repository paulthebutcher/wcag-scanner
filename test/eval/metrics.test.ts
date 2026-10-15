import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { wilson, computeMetrics, aggregateExport, type RunInputs, type LabelInputs } from "../../src/eval/metrics.js";
import { loadEvalConfig } from "../../src/eval/config.js";
import { evalPaths } from "../../src/eval/paths.js";
import { foldLabels, type CaseRecord, type LabelEvent } from "../../src/eval/labels.js";
import type { Prediction } from "../../src/eval/predictions.js";
import type { CoverageRow, CriterionStatusRow } from "../../src/eval/normalize.js";
import type { RunManifest } from "../../src/eval/manifest.js";
import { sha256 } from "../../src/eval/util.js";
import { scanText } from "../../src/eval/privacy.js";

const REPO = join(import.meta.dirname, "..", "..");
const config = loadEvalConfig(evalPaths(REPO).config);

let caseSeq = 0;
let labelSeq = 0;
function mkCase(page: string, selector: string, criterion: string, extra: Partial<CaseRecord> = {}): CaseRecord {
  caseSeq++;
  return {
    case_id: `C-${String(caseSeq).padStart(6, "0")}`, revision: 1, revision_reason: null, created_at: "2026-10-12T00:00:00Z", created_by: "paul",
    site: "t01", page, corpus_version: "v1", unit: "element",
    target: { selector, html: `<x class="${selector}">`, html_sha256: sha256(`<x class="${selector}">`), context_sha256: null, state: null },
    assertions: [{ assertion_id: "A1", criterion, issue: "i", failure_type: null }], origin: "review", propagation_group: null, evidence_refs: [], source_seed_id: null, ...extra,
  };
}
function mkLabel(c: CaseRecord, verdict: LabelEvent["verdict"], extra: Partial<LabelEvent> = {}): LabelEvent {
  labelSeq++;
  return {
    label_id: `L-${String(labelSeq).padStart(6, "0")}`, seq: labelSeq, kind: "judgment", case_id: c.case_id, assertion_id: "A1", verdict,
    severity_correction: null, reviewer: "paul", batch: "queue", phase: null, active_seconds: 10, timestamp: "2026-10-12T00:00:00Z",
    propagation_group: null, propagation_source: null, undoes: null, prediction_ref: null, note: null, ...extra,
  };
}
function mkPred(page: string, selector: string, criterion: string, extra: Partial<Prediction> = {}): Prediction {
  const html = `<x class="${selector}">`;
  return {
    prediction_key: sha256(`${page}|${selector}|${criterion}|${JSON.stringify(extra)}`).slice(0, 12), site: "t01", page, criterion, selector, element_html: html,
    html_sha256: sha256(html), failure_type: "f", check: criterion === "1.1.1" ? "alt-text" : "landmark-labels", tier: 3, state: "load", severity: "major",
    confidence_tier: "high", confidence_score: 0.9, detected_by: "claude_api", reasoning: "r", tooling_error: false, model_image: false, also_found_on: [],
    evidence: { element_screenshot: null, context_screenshot: null, page_screenshot: null }, measured_values: {}, ...extra,
  };
}

const PAGES = ["p001", "p002", "p003", "p004"];
function ran(checks: string[]): CoverageRow[] {
  return PAGES.flatMap((page) => checks.map((check) => ({ check, page, status: "ran", message: null })));
}

function inputs(predictions: Prediction[], cases: CaseRecord[], events: LabelEvent[], opts: { coverage?: CoverageRow[] | null; criteria?: CriterionStatusRow[] } = {}): { run: RunInputs; labels: LabelInputs } {
  const manifest = { run_id: "replay-20261012T000000Z-abcdef", corpus: { version: "v1", split: "tuning" }, engine: { label: "head", sha: "a".repeat(40), bridge: null } } as unknown as RunManifest;
  return {
    run: { manifest, runDir: "/tmp/x", sites: [{ site: "t01", predictions, coverage: opts.coverage === undefined ? ran(["alt-text", "axe-core", "landmark-labels", "headings", "table-structure"]) : opts.coverage, criteria: opts.criteria ?? [], pages: PAGES }] },
    labels: { cases, judgments: foldLabels(events), overrides: [], unresolvedSeeds: new Set(), labelsThrough: labelSeq },
  };
}

const crit = (r: ReturnType<typeof computeMetrics>, id: string) => r.criteria.find((c) => c.criterion === id)!;

describe("Wilson intervals", () => {
  it("matches the textbook interval and marks small n", () => {
    const r = wilson(8, 10, 30);
    expect(r.value).toBe(0.8);
    expect(r.lower).toBeCloseTo(0.4902, 3);
    expect(r.upper).toBeCloseTo(0.9433, 3);
    expect(r.insufficient).toBe(true);
    expect(wilson(40, 40, 30).upper).toBe(1);
    expect(wilson(40, 40, 30).insufficient).toBe(false);
  });
  it("a zero denominator is unavailable, never 0% or 100%", () => {
    const r = wilson(0, 0, 30);
    expect(r.value).toBeNull();
    expect(r.unavailable).toBe("zero denominator");
  });
});

describe("metrics (D5)", () => {
  it("keeps queue, random-audit, audit and known-defect samples in separate denominators", () => {
    const q1 = mkCase("p001", "q1", "1.1.1"), q2 = mkCase("p001", "q2", "1.1.1");
    const r1 = mkCase("p002", "r1", "1.1.1");
    const a1 = mkCase("p003", "a1", "1.1.1", { origin: "independent_audit" }), a2 = mkCase("p003", "a2", "1.1.1", { origin: "independent_audit" });
    const s1 = mkCase("p004", "s1", "1.1.1", { origin: "seed", source_seed_id: "SL-013" });
    const events = [
      mkLabel(q1, "violation"), mkLabel(q2, "no_violation"), mkLabel(r1, "no_violation", { batch: "calibration" }),
      mkLabel(a1, "violation", { batch: "audit", phase: "pre_reveal" }), mkLabel(a2, "violation", { batch: "audit", phase: "pre_reveal" }),
      mkLabel(s1, "violation"),
    ];
    const preds = [mkPred("p001", "q1", "1.1.1"), mkPred("p001", "q2", "1.1.1"), mkPred("p002", "r1", "1.1.1"), mkPred("p003", "a1", "1.1.1")];
    const { run, labels } = inputs(preds, [q1, q2, r1, a1, a2, s1], events);
    const m = crit(computeMetrics(config, run, labels), "1.1.1").views.confirmed.by_origin;
    expect(m.queue.samples).toEqual({ tp: 1, fp: 1, fn: 0, tn: 0 });
    expect(m.queue.precision.value).toBe(0.5);
    expect(m.random.samples).toEqual({ tp: 0, fp: 1, fn: 0, tn: 0 });
    expect(m.random.precision.value).toBe(0);
    expect(m.audit.recall.value).toBe(0.5);
    expect(m.audit.recall.n).toBe(2);
    expect(m.seed.recall.value).toBe(0);
    expect(m.seed.precision.unavailable).toBe("zero denominator");
  });

  it("reports confirmed and inclusive views on the same ground truth", () => {
    const c = mkCase("p001", "nr", "1.1.1");
    const { run, labels } = inputs([mkPred("p001", "nr", "1.1.1", { confidence_tier: "needs_review" })], [c], [mkLabel(c, "violation")]);
    const r = computeMetrics(config, run, labels);
    expect(crit(r, "1.1.1").views.confirmed.by_origin.queue.samples.fn).toBe(1);
    expect(crit(r, "1.1.1").views.inclusive.by_origin.queue.samples.tp).toBe(1);
    expect(crit(r, "1.1.1").needs_review_rate.value).toBe(1);
  });

  it("counts a propagation group as one sample and its instances separately", () => {
    const cs = ["p001", "p002", "p003"].map((p) => mkCase(p, "nav", "1.3.1", { propagation_group: "G-1" }));
    const events = cs.map((c) => mkLabel(c, "violation", { propagation_group: "G-1" }));
    const preds = ["p001", "p002"].map((p) => mkPred(p, "nav", "1.3.1"));
    const { run, labels } = inputs(preds, cs, events);
    const v = crit(computeMetrics(config, run, labels), "1.3.1").views.confirmed;
    expect(v.instances).toEqual({ tp: 2, fp: 0, fn: 1, tn: 0 });
    expect(v.by_origin.queue.samples).toEqual({ tp: 1, fp: 0, fn: 0, tn: 0 });
    expect(crit(computeMetrics(config, run, labels), "1.3.1").counts.clusters).toBe(1);
  });

  it("counts deduplicated alias matches and wrong-criterion assignments", () => {
    const c2 = mkCase("p002", "logo", "1.1.1");
    const c3 = mkCase("p003", "hdr", "1.3.1");
    const preds = [mkPred("p001", "logo", "1.1.1", { also_found_on: ["p002"] }), mkPred("p003", "hdr", "2.4.6")];
    const { run, labels } = inputs(preds, [c2, c3], [mkLabel(c2, "violation"), mkLabel(c3, "violation")]);
    const r = computeMetrics(config, run, labels);
    expect(crit(r, "1.1.1").views.confirmed.by_origin.queue.samples.tp).toBe(1);
    expect(crit(r, "1.3.1").views.confirmed.by_origin.queue.samples.fn).toBe(1);
    expect(crit(r, "1.3.1").diagnostics.wrong_criterion).toBe(1);
    expect(r.wrong_criterion_assignments).toBe(1);
  });

  it("missing or failed coverage never becomes TN; it is counted", () => {
    const c = mkCase("p001", "x", "1.1.1");
    const coverage: CoverageRow[] = [{ check: "alt-text", page: "p001", status: "failed", message: "boom" }, { check: "axe-core", page: "p001", status: "skipped", message: "x" }];
    const { run, labels } = inputs([], [c], [mkLabel(c, "no_violation")], { coverage });
    const r = computeMetrics(config, run, labels);
    expect(crit(r, "1.1.1").views.confirmed.by_origin.queue.samples.tn).toBe(0);
    expect(crit(r, "1.1.1").counts.tooling_errors).toBe(1);
    expect(r.coverage!.failed).toBe(1);
    expect(r.coverage!.not_recorded).toBeGreaterThan(0);
  });

  it("reports false passes under API failure, partial runs, known violations and unchecked criteria", () => {
    const c = mkCase("p001", "img", "1.1.1");
    const coverage = [...ran(["alt-text", "axe-core", "keyboard"]).map((r) => (r.check === "keyboard" && r.page === "p002" ? { ...r, status: "partial" } : r))];
    const criteria: CriterionStatusRow[] = [
      { criterion: "1.1.1", status: "passed", tested_by: "claude_api", evidence_summary: "" },
      { criterion: "2.1.1", status: "passed", tested_by: "playwright", evidence_summary: "" },
      { criterion: "1.3.3", status: "passed", tested_by: "axe_core", evidence_summary: "" },
    ];
    const failedEval = mkPred("p003", "img2", "1.1.1", { tooling_error: true, confidence_tier: "needs_review", reasoning: "Prompt evaluation failed after 3 retries: 400" });
    const { run, labels } = inputs([failedEval], [c], [mkLabel(c, "violation")], { coverage, criteria });
    const r = computeMetrics(config, run, labels);
    const rules = r.false_passes.map((f) => `${f.rule}:${f.criterion}`).sort();
    expect(rules).toEqual(expect.arrayContaining([
      "known_violation_with_pass:1.1.1", "pass_with_api_failures:1.1.1", "pass_with_unestablished_checks:2.1.1", "pass_without_checks:1.3.3",
    ]));
    expect(crit(r, "1.1.1").counts.api_failure_predictions).toBe(1);
  });

  it("marks insufficient evidence below 30 samples and exports aggregates only", () => {
    const cs = Array.from({ length: 31 }, (_, i) => mkCase("p001", `e${i}`, "1.1.1"));
    const preds = cs.map((c) => mkPred("p001", c.target.selector!, "1.1.1"));
    const { run, labels } = inputs(preds, cs, cs.map((c, i) => mkLabel(c, i < 25 ? "violation" : "no_violation")));
    const r = computeMetrics(config, run, labels);
    const q = crit(r, "1.1.1").views.confirmed.by_origin.queue;
    expect(q.precision.n).toBe(31);
    expect(q.precision.insufficient).toBe(false);
    expect(crit(r, "1.3.1").views.confirmed.by_origin.queue.precision.unavailable).toBe("zero denominator");
    const exported = aggregateExport(r, run.manifest);
    const text = JSON.stringify(exported);
    expect(text).not.toContain("<x class");
    expect(text).not.toContain("p001");
    expect(scanText(text, "export", [])).toEqual([]);
  });
});
