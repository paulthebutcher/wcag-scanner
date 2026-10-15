import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaseStore, LabelStore, foldLabels, StoreLocked, type CaseRecord, type LabelInput } from "../../src/eval/labels.js";
import { matchCases, type MatchInput } from "../../src/eval/matcher.js";
import { loadEvalConfig } from "../../src/eval/config.js";
import { evalPaths } from "../../src/eval/paths.js";
import type { Prediction } from "../../src/eval/predictions.js";
import { sha256 } from "../../src/eval/util.js";

const REPO = join(import.meta.dirname, "..", "..");
const config = loadEvalConfig(evalPaths(REPO).config);

let dir: string;
let cases: CaseStore;
let labels: LabelStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eval-labels-"));
  cases = new CaseStore(join(dir, "cases.jsonl"));
  labels = new LabelStore(join(dir, "labels.jsonl"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const html = (s: string) => `<img src="${s}.png" alt="">`;

function newCase(page: string, selector: string | null, h: string | null, criteria: string[], extra: Partial<CaseRecord> = {}): CaseRecord {
  return cases.create({
    created_by: "paul", site: "t01", page, corpus_version: "v1", unit: "element",
    target: { selector, html: h, html_sha256: null, context_sha256: null, state: null },
    assertions: criteria.map((c, i) => ({ assertion_id: `A${i + 1}`, criterion: c, issue: `issue ${c}`, failure_type: null })),
    origin: "review", propagation_group: null, evidence_refs: [], source_seed_id: null, ...extra,
  });
}

function judge(caseId: string, assertion: string, verdict: "violation" | "no_violation" | "unsure", extra: Partial<LabelInput> = {}): LabelInput {
  return {
    kind: "judgment", case_id: caseId, assertion_id: assertion, verdict, severity_correction: null, reviewer: "paul", batch: "queue",
    phase: null, active_seconds: 12, propagation_group: null, propagation_source: null, undoes: null, prediction_ref: null, note: null, ...extra,
  };
}

function pred(page: string, selector: string, h: string, criterion: string, extra: Partial<Prediction> = {}): Prediction {
  return {
    prediction_key: sha256(`${page}|${selector}|${h}|${criterion}|${JSON.stringify(extra)}`).slice(0, 12), site: "t01", page, criterion, selector,
    element_html: h, html_sha256: sha256(h), failure_type: "x", check: "alt-text", tier: 3, state: "load", severity: "major",
    confidence_tier: "high", confidence_score: 0.8, detected_by: "claude_api", reasoning: "r", tooling_error: false, model_image: false, also_found_on: [],
    evidence: { element_screenshot: null, context_screenshot: null, page_screenshot: null }, measured_values: {}, ...extra,
  };
}

const ranEverywhere = (pages: string[]) => new Map(pages.flatMap((p) => ["axe-core", "alt-text", "link-text", "headings", "widget-aria"].map((c) => [`t01|${p}|${c}`, "ran"] as [string, string])));

function run(predictions: Prediction[], extra: Partial<MatchInput> = {}) {
  return matchCases({
    config, view: "confirmed", cases: Array.from(cases.current().values()), judgments: foldLabels(labels.events()), overrides: [],
    predictions, coverage: ranEverywhere(["p001", "p002", "p003"]), corpusPages: new Set(["t01/p001", "t01/p002", "t01/p003"]),
    corpusVersion: "v1", ...extra,
  });
}

const cls = (r: ReturnType<typeof run>, caseId: string, a = "A1") => r.outcomes.find((o) => o.case_id === caseId && o.assertion_id === a)?.class;

describe("append-only stores", () => {
  it("assigns ids and sequence numbers and refuses a second writer", () => {
    const c = newCase("p001", "img.a", html("a"), ["1.1.1"]);
    expect(c.case_id).toBe("C-000001");
    const [l1, l2] = labels.append([judge(c.case_id, "A1", "violation"), judge(c.case_id, "A1", "no_violation")]);
    expect([l1.label_id, l2.label_id, l2.seq]).toEqual(["L-000001", "L-000002", 2]);
    writeFileSync(`${labels.path}.lock`, "");
    expect(() => labels.append([judge(c.case_id, "A1", "unsure")])).toThrow(StoreLocked);
  });

  it("validates judgments: severity corrections annotate violations only", () => {
    const c = newCase("p001", "img.a", html("a"), ["1.1.1"]);
    expect(() => labels.append([judge(c.case_id, "A1", "no_violation", { severity_correction: "minor" })])).toThrow(/violation only/);
  });

  it("a criterion change is an appended revision with a reason", () => {
    const c = newCase("p001", "img.a", html("a"), ["1.1.1"]);
    expect(() => cases.revise(c.case_id, { assertions: [{ assertion_id: "A1", criterion: "2.4.4", issue: "link", failure_type: null }] }, "", "paul")).toThrow(/reason/);
    const r = cases.revise(c.case_id, { assertions: [{ assertion_id: "A1", criterion: "2.4.4", issue: "link", failure_type: null }] }, "image is the link's only content", "paul");
    expect(r.revision).toBe(2);
    expect(cases.records()).toHaveLength(2);
    expect(cases.current().get(c.case_id)?.assertions[0].criterion).toBe("2.4.4");
  });
});

describe("folding", () => {
  it("latest judgment supersedes; undo restores the previous one", () => {
    const c = newCase("p001", "img.a", html("a"), ["1.1.1"]);
    const [a, b] = labels.append([judge(c.case_id, "A1", "violation"), judge(c.case_id, "A1", "no_violation")]);
    expect(foldLabels(labels.events()).get(`${c.case_id}|A1`)?.verdict).toBe("no_violation");
    labels.append([{ ...judge(c.case_id, "A1", "violation"), kind: "undo", verdict: null, case_id: null, assertion_id: null, undoes: b.label_id }]);
    const f = foldLabels(labels.events()).get(`${c.case_id}|A1`)!;
    expect(f.verdict).toBe("violation");
    expect(f.label_id).toBe(a.label_id);
    // Folding through an earlier sequence ignores later events
    expect(foldLabels(labels.events(), 1).get(`${c.case_id}|A1`)?.verdict).toBe("violation");
    expect(foldLabels(labels.events(), 2).get(`${c.case_id}|A1`)?.verdict).toBe("no_violation");
  });

  it("undoing a propagated judgment restores the whole group", () => {
    const g = "G-1";
    const cs = ["p001", "p002", "p003"].map((p) => newCase(p, "nav.main", "<nav class=\"main\">", ["1.3.1"], { propagation_group: g }));
    const ev = labels.append(cs.map((c, i) => judge(c.case_id, "A1", "violation", { propagation_group: g, propagation_source: i === 0 ? null : "L-000001" })));
    expect(foldLabels(labels.events()).size).toBe(3);
    labels.append([{ ...judge(cs[1].case_id, "A1", "violation"), kind: "undo", verdict: null, case_id: null, assertion_id: null, undoes: ev[1].label_id }]);
    expect(foldLabels(labels.events()).size).toBe(0);
  });
});

describe("matcher classes", () => {
  it("TP, FN, FP, TN, unsure and unreviewed", () => {
    const tp = newCase("p001", "img.a", html("a"), ["1.1.1"]);
    const fn = newCase("p001", "img.b", html("b"), ["1.1.1"]);
    const fp = newCase("p002", "img.c", html("c"), ["1.1.1"]);
    const tn = newCase("p002", "img.d", html("d"), ["1.1.1"]);
    const un = newCase("p003", "img.e", html("e"), ["1.1.1"]);
    const nr = newCase("p003", "img.f", html("f"), ["1.1.1"]);
    labels.append([judge(tp.case_id, "A1", "violation"), judge(fn.case_id, "A1", "violation"), judge(fp.case_id, "A1", "no_violation"), judge(tn.case_id, "A1", "no_violation"), judge(un.case_id, "A1", "unsure")]);
    const r = run([pred("p001", "img.a", html("a"), "1.1.1"), pred("p002", "img.c", html("c"), "1.1.1"), pred("p003", "img.z", html("z"), "1.1.1")]);
    expect([cls(r, tp.case_id), cls(r, fn.case_id), cls(r, fp.case_id), cls(r, tn.case_id), cls(r, un.case_id), cls(r, nr.case_id)])
      .toEqual(["TP", "FN", "FP", "TN", "unsure", "unreviewed"]);
    expect(r.unlabeled.map((p) => p.selector)).toEqual(["img.z"]);
  });

  it("a wrong-criterion association is not a TP; one prediction serves only its own assertion", () => {
    const c = newCase("p001", "a.logo", "<a class=\"logo\"><img></a>", ["1.1.1", "2.4.4"]);
    labels.append([judge(c.case_id, "A1", "violation"), judge(c.case_id, "A2", "violation")]);
    const r = run([pred("p001", "a.logo", "<a class=\"logo\"><img></a>", "2.4.4")]);
    expect(cls(r, c.case_id, "A1")).toBe("FN");
    expect(r.outcomes.find((o) => o.assertion_id === "A1")?.wrong_criterion).toEqual(["2.4.4"]);
    expect(cls(r, c.case_id, "A2")).toBe("TP");
  });

  it("multiple predictions: identical duplicates pick one, distinct ties are ambiguous", () => {
    const c = newCase("p001", "img.a", html("a"), ["1.1.1"]);
    const amb = newCase("p001", null, html("q"), ["1.1.1"]);
    labels.append([judge(c.case_id, "A1", "violation"), judge(amb.case_id, "A1", "violation")]);
    const dup1 = pred("p001", "img.a", html("a"), "1.1.1");
    const dup2 = { ...pred("p001", "img.a", html("a"), "1.1.1"), prediction_key: "dup2" };
    const r = run([dup1, dup2, pred("p001", "img.q1", html("q"), "1.1.1"), pred("p001", "img.q2", html("q"), "1.1.1")]);
    expect(cls(r, c.case_id)).toBe("TP");
    expect(cls(r, amb.case_id)).toBe("ambiguous");
  });

  it("a changed selector still matches on the element HTML (documented fallback)", () => {
    const c = newCase("p001", "img.old-class", html("a"), ["1.1.1"]);
    labels.append([judge(c.case_id, "A1", "violation")]);
    const r = run([pred("p001", "img.new-class", html("a"), "1.1.1")]);
    expect(r.outcomes[0].class).toBe("TP");
    expect(r.outcomes[0].association).toBe("html");
  });

  it("deduplicated predictions satisfy other pages only through the alias with the same element", () => {
    const c2 = newCase("p002", "footer img", html("logo"), ["1.1.1"]);
    const c3 = newCase("p003", "footer img", html("other"), ["1.1.1"]);
    labels.append([judge(c2.case_id, "A1", "violation"), judge(c3.case_id, "A1", "violation")]);
    const r = run([pred("p001", "footer img", html("logo"), "1.1.1", { also_found_on: ["p002", "p003"] })]);
    expect(cls(r, c2.case_id)).toBe("TP");
    expect(r.outcomes.find((o) => o.case_id === c2.case_id)?.association).toBe("alias");
    expect(cls(r, c3.case_id)).toBe("FN");
  });

  it("missing evidence is stale; unresolved seeds and overrides are excluded and counted", () => {
    const gone = newCase("p009", "img.a", html("a"), ["1.1.1"]);
    const moved = { ...newCase("p001", "img.m", html("moved"), ["1.1.1"]) };
    const seed = newCase("p001", "img.s", html("s"), ["1.1.1"], { origin: "seed", source_seed_id: "SL-005" });
    const scan = newCase("p001", "img.k", html("k"), ["1.1.1"], { origin: "seed", source_seed_id: "SL-016" });
    labels.append([gone, moved, seed, scan].map((c) => judge(c.case_id, "A1", "violation")));
    const r = run([], {
      corpusVersion: "v2",
      pageDom: () => "<html><body><p>new content</p></body></html>",
      unresolvedSeeds: new Set(["SL-005"]),
      overrides: [{ seed_id: "SL-016", status: "scan_level", reason: "scan level", pending: null, exclude_from: ["element", "criterion"] }],
    });
    expect([cls(r, gone.case_id), cls(r, moved.case_id), cls(r, seed.case_id), cls(r, scan.case_id)]).toEqual(["stale", "stale", "unresolved_fixture", "excluded"]);
  });

  it("an outcome the engine never established is a tooling error or untested, never TN or FN", () => {
    const failed = newCase("p001", "img.a", html("a"), ["1.1.1"]);
    const manual = newCase("p001", "p.x", "<p class=\"x\">", ["1.3.3"]);
    labels.append([judge(failed.case_id, "A1", "no_violation"), judge(manual.case_id, "A1", "violation")]);
    const coverage = new Map([["t01|p001|axe-core", "failed"], ["t01|p001|alt-text", "skipped"]]);
    const r = run([], { coverage });
    expect(cls(r, failed.case_id)).toBe("tooling_error");
    expect(cls(r, manual.case_id)).toBe("untested");
  });

  it("confirmed view counts a needs_review-only detection as FN; inclusive view as TP", () => {
    const c = newCase("p001", "img.a", html("a"), ["1.1.1"]);
    labels.append([judge(c.case_id, "A1", "violation", { severity_correction: "minor" })]);
    const p = pred("p001", "img.a", html("a"), "1.1.1", { confidence_tier: "needs_review" });
    const confirmed = run([p]);
    expect(confirmed.outcomes[0].class).toBe("FN");
    expect(confirmed.outcomes[0].needs_review_only).toBe(true);
    const inclusive = run([p], { view: "inclusive" });
    expect(inclusive.outcomes[0].class).toBe("TP");
    expect(inclusive.outcomes[0].severity_disagreement).toEqual({ engine: "major", corrected: "minor" });
  });

  it("disputed overrides are excluded and counted", () => {
    const c = newCase("p001", "h4", "<h4>History</h4>", ["2.4.6"], { origin: "seed", source_seed_id: "SL-014" });
    labels.append([judge(c.case_id, "A1", "violation")]);
    const r = run([pred("p001", "h4", "<h4>History</h4>", "2.4.6")], { overrides: [{ seed_id: "SL-014", status: "disputed", reason: "level skip is best practice", pending: "Paul", exclude_from: ["element", "criterion"] }] });
    expect(r.outcomes[0].class).toBe("disputed");
  });

  it("a page-level tested negative is an FP when the engine flags that criterion anywhere on the page", () => {
    const neg = newCase("p001", null, null, ["1.3.1"], { unit: "page" });
    const pos = newCase("p002", null, null, ["2.4.5"], { unit: "page" });
    labels.append([judge(neg.case_id, "A1", "no_violation"), judge(pos.case_id, "A1", "violation")]);
    const r = run([pred("p001", "nav.a", "<nav class=\"a\">", "1.3.1"), pred("p001", "nav.b", "<nav class=\"b\">", "1.3.1"), pred("p002", "html", "<html>", "2.4.5", { check: "multiple-ways" })],
      { coverage: new Map([...ranEverywhere(["p001", "p002"]), ["t01|p002|multiple-ways", "ran"]]) });
    expect(cls(r, neg.case_id)).toBe("FP");
    expect(r.outcomes.find((o) => o.case_id === neg.case_id)?.association).toBe("page");
    expect(cls(r, pos.case_id)).toBe("TP");
  });

  it("a failed model evaluation is a tooling error, never a detection or a pass", () => {
    const v = newCase("p001", "img.a", html("a"), ["1.1.1"]);
    const n = newCase("p002", "img.b", html("b"), ["1.1.1"]);
    labels.append([judge(v.case_id, "A1", "violation"), judge(n.case_id, "A1", "no_violation")]);
    const failed = (page: string, sel: string, h: string) => pred(page, sel, h, "1.1.1", { tooling_error: true, confidence_tier: "needs_review", reasoning: "Prompt evaluation failed after 1 retries: 400" });
    const r = run([failed("p001", "img.a", html("a")), failed("p002", "img.b", html("b"))], { view: "inclusive" });
    expect(cls(r, v.case_id)).toBe("tooling_error");
    expect(cls(r, n.case_id)).toBe("tooling_error");
    expect(r.unlabeled).toHaveLength(0);
  });
});
