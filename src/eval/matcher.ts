import type { CaseRecord, FoldedJudgment, LabelOverride } from "./labels.js";
import type { Prediction } from "./predictions.js";
import type { CoverageRow } from "./normalize.js";
import type { EvalConfig } from "./config.js";

// ---------------------------------------------------------------------------
// D4 matcher. Association (which prediction is about which case target) is
// separate from judging (does it qualify for an assertion's criterion).
//
// Association, per case target, in order of strength:
//   1. same page, same state, same selector and same element HTML
//   2. same page and state, same selector (HTML changed)
//   3. same page and state, same element HTML (selector changed; documented
//      content fallback)
//   4. a deduplicated prediction whose also_found_on lists the case page,
//      with the same selector and HTML (the scan-wide dedup alias)
// Never page plus failure type, never finding_type_hash. Candidates that tie
// at the best level and cannot be told apart make the case ambiguous.
// A prediction satisfies at most one assertion per page instance.
// ---------------------------------------------------------------------------

export type MatchClass =
  | "TP" | "FN" | "FP" | "TN"
  | "unsure" | "disputed" | "unreviewed"
  | "tooling_error" | "untested"
  | "stale" | "unresolved_fixture" | "ambiguous"
  /** Scan-level or composite seeds excluded from element and criterion denominators by an override */
  | "excluded";

export type View = "confirmed" | "inclusive";

export interface AssertionOutcome {
  case_id: string;
  assertion_id: string;
  site: string;
  page: string;
  criterion: string;
  origin: CaseRecord["origin"];
  propagation_group: string | null;
  verdict: FoldedJudgment["verdict"] | null;
  class: MatchClass;
  prediction_key: string | null;
  association: "exact" | "selector" | "html" | "alias" | null;
  /** An associated prediction exists but for another criterion */
  wrong_criterion: string[];
  /** TP with a corrected severity that differs from the engine's */
  severity_disagreement: { engine: string; corrected: string } | null;
  /** Only needs_review predictions qualified (confirmed view counts it FN) */
  needs_review_only: boolean;
  detail: string | null;
}

export interface MatchInput {
  config: EvalConfig;
  view: View;
  cases: CaseRecord[];
  judgments: Map<string, FoldedJudgment>;
  overrides: LabelOverride[];
  predictions: Prediction[];
  /** Coverage per (site|page|check) from the run; null = engine has none */
  coverage: Map<string, string> | null;
  /** Pages present in the run's corpus (site/page) */
  corpusPages: Set<string>;
  /** Page DOM lookup for staleness checks across corpus versions */
  pageDom?: (site: string, page: string) => string | null;
  corpusVersion: string;
  /** Seed ids whose fixtures could not be resolved */
  unresolvedSeeds?: Set<string>;
}

export interface MatchResult {
  outcomes: AssertionOutcome[];
  /** Predictions associated with no reviewed assertion */
  unlabeled: Prediction[];
  /** Predictions that satisfied an assertion */
  used: Set<string>;
}

interface Candidate {
  p: Prediction;
  level: 1 | 2 | 3 | 4;
}

function stateMatches(caseState: string | null, p: Prediction): boolean {
  return caseState === null || caseState === p.state;
}

function associate(c: CaseRecord, predictions: Prediction[]): Candidate[] {
  const t = c.target;
  const out: Candidate[] = [];
  for (const p of predictions) {
    if (p.site !== c.site || !stateMatches(t.state, p)) continue;
    const sameSel = t.selector !== null && p.selector === t.selector;
    const sameHtml = t.html_sha256 !== null && p.html_sha256 === t.html_sha256;
    if (p.page === c.page) {
      if (sameSel && sameHtml) out.push({ p, level: 1 });
      else if (sameSel && t.html_sha256 === null) out.push({ p, level: 1 });
      else if (sameSel) out.push({ p, level: 2 });
      else if (sameHtml) out.push({ p, level: 3 });
    } else if (p.also_found_on.includes(c.page) && (sameSel || t.selector === null) && (sameHtml || t.html_sha256 === null)) {
      out.push({ p, level: 4 });
    }
  }
  return out.sort((a, b) => a.level - b.level);
}

const LEVEL_NAME = { 1: "exact", 2: "selector", 3: "html", 4: "alias" } as const;

function qualifies(p: Prediction, criterion: string, view: View): boolean {
  if (p.criterion !== criterion) return false;
  if (view === "confirmed" && p.confidence_tier === "needs_review") return false;
  return true;
}

/** Was any check that addresses `criterion` established on this page? */
function establishment(config: EvalConfig, coverage: Map<string, string> | null, site: string, page: string, criterion: string): "established" | "tooling_error" | "untested" {
  const crit = config.criteria.find((c) => c.id === criterion);
  if (!crit || crit.checks.length === 0) return "untested";
  if (!coverage) return "established";
  const statuses = crit.checks.map((check) => coverage.get(`${site}|${page}|${check}`) ?? "not_recorded");
  if (statuses.some((s) => s === "ran" || s === "partial")) return "established";
  if (statuses.some((s) => s === "failed")) return "tooling_error";
  return "untested";
}

export function matchCases(input: MatchInput): MatchResult {
  const outcomes: AssertionOutcome[] = [];
  const used = new Set<string>();
  /** prediction|page → assertion it satisfied */
  const claimed = new Map<string, string>();
  const overrideBySeed = new Map(input.overrides.map((o) => [o.seed_id, o]));
  const associatedWithReviewed = new Set<string>();

  // Strongest associations first so an exact match is never displaced by a fallback
  const ordered = [...input.cases].sort((a, b) => a.case_id.localeCompare(b.case_id));
  for (const c of ordered) {
    const candidates = associate(c, input.predictions);
    const pageKey = `${c.site}/${c.page}`;
    const override = c.source_seed_id ? overrideBySeed.get(c.source_seed_id) : undefined;
    const stale = !input.corpusPages.has(pageKey) || (c.corpus_version !== input.corpusVersion && c.target.html !== null && input.pageDom
      ? !(input.pageDom(c.site, c.page) ?? "").replace(/\s+/g, " ").includes(c.target.html.replace(/\s+/g, " "))
      : false);

    for (const a of c.assertions) {
      const j = input.judgments.get(`${c.case_id}|${a.assertion_id}`) ?? null;
      const base: AssertionOutcome = {
        case_id: c.case_id, assertion_id: a.assertion_id, site: c.site, page: c.page, criterion: a.criterion, origin: c.origin,
        propagation_group: c.propagation_group, verdict: j?.verdict ?? null, class: "unreviewed", prediction_key: null, association: null,
        wrong_criterion: [], severity_disagreement: null, needs_review_only: false, detail: null,
      };
      if (j && j.verdict !== "unsure") for (const cand of candidates) associatedWithReviewed.add(cand.p.prediction_key);

      if (c.source_seed_id && input.unresolvedSeeds?.has(c.source_seed_id)) { outcomes.push({ ...base, class: "unresolved_fixture" }); continue; }
      if (override && (override.status === "disputed" || override.status === "scan_level" || override.status === "composite")) {
        outcomes.push({ ...base, class: override.status === "disputed" ? "disputed" : "excluded", detail: override.reason });
        continue;
      }
      if (stale) { outcomes.push({ ...base, class: "stale", detail: "case evidence not present in this corpus" }); continue; }
      if (!j) { outcomes.push(base); continue; }
      if (j.verdict === "unsure") { outcomes.push({ ...base, class: "unsure" }); continue; }

      // Judge: qualifying candidates at the strongest level that has any
      const best = candidates.filter((x) => qualifies(x.p, a.criterion, input.view) && !claimed.has(`${x.p.prediction_key}|${c.page}`));
      const wrong = candidates.filter((x) => x.p.criterion !== a.criterion).map((x) => x.p.criterion);
      const nrOnly = input.view === "confirmed" && candidates.some((x) => x.p.criterion === a.criterion && x.p.confidence_tier === "needs_review") && best.length === 0;
      if (best.length > 0) {
        const topLevel = best[0].level;
        const top = best.filter((x) => x.level === topLevel);
        const distinct = new Set(top.map((x) => `${x.p.selector}|${x.p.html_sha256}|${x.p.page}`));
        if (top.length > 1 && distinct.size > 1) {
          outcomes.push({ ...base, class: "ambiguous", detail: `${top.length} indistinguishable candidates at level ${LEVEL_NAME[topLevel]}` });
          continue;
        }
        const chosen = top[0];
        claimed.set(`${chosen.p.prediction_key}|${c.page}`, `${c.case_id}|${a.assertion_id}`);
        used.add(chosen.p.prediction_key);
        const sev = j.verdict === "violation" && j.severity_correction && j.severity_correction !== chosen.p.severity
          ? { engine: chosen.p.severity, corrected: j.severity_correction } : null;
        outcomes.push({
          ...base, class: j.verdict === "violation" ? "TP" : "FP", prediction_key: chosen.p.prediction_key,
          association: LEVEL_NAME[chosen.level], wrong_criterion: wrong, severity_disagreement: sev,
        });
        continue;
      }
      // No qualifying prediction: was the outcome established at all?
      const est = establishment(input.config, input.coverage, c.site, c.page, a.criterion);
      if (est !== "established") { outcomes.push({ ...base, class: est, wrong_criterion: wrong, needs_review_only: nrOnly }); continue; }
      outcomes.push({ ...base, class: j.verdict === "violation" ? "FN" : "TN", wrong_criterion: wrong, needs_review_only: nrOnly });
    }
  }
  const unlabeled = input.predictions.filter((p) => !used.has(p.prediction_key) && !associatedWithReviewed.has(p.prediction_key));
  return { outcomes, unlabeled, used };
}

/** Coverage rows → lookup map keyed site|page|check. */
export function coverageMap(site: string, rows: CoverageRow[] | null): Map<string, string> | null {
  if (!rows) return null;
  return new Map(rows.map((r) => [`${site}|${r.page}|${r.check}`, r.status]));
}
