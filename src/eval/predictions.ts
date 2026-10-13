import type { Finding, PageSnapshot } from "../types.js";
import { checkForFinding } from "../core/check-registry.js";
import { canonicalJson, sha256 } from "./util.js";

// ---------------------------------------------------------------------------
// Predictions: an engine's findings in the form the matcher and the review
// screen use. Identity is content-based (site, page, criterion, locator,
// element HTML, failure type, check, state) and never a finding UUID or
// finding_type_hash. Private: carries element HTML and reasoning.
// ---------------------------------------------------------------------------

export interface Prediction {
  prediction_key: string;
  site: string;
  page: string;
  criterion: string;
  selector: string;
  element_html: string;
  html_sha256: string;
  failure_type: string | null;
  check: string | null;
  tier: number | null;
  state: string;
  severity: string;
  confidence_tier: string;
  confidence_score: number;
  detected_by: string;
  reasoning: string;
  model_image: boolean;
  also_found_on: string[];
  evidence: { element_screenshot: string | null; context_screenshot: string | null; page_screenshot: string | null };
  measured_values: Record<string, unknown>;
}

export function predictionState(f: Finding): string {
  const mv = f.evidence.measured_values ?? {};
  if (typeof mv.scenario === "string") return `scenario:${mv.scenario}`;
  return "load";
}

/** Evidence paths stay relative to the engine data directory of the run. */
export function buildPredictions(site: string, findings: Finding[], snapshots: PageSnapshot[], pageIdOf: (url: string) => string, checkTiers: Record<string, number>): Prediction[] {
  const pageBySnapshot = new Map(snapshots.map((s) => [s.id, { page: pageIdOf(s.url), screenshot: s.screenshot }]));
  const seen = new Map<string, number>();
  return findings.map((f) => {
    const snap = pageBySnapshot.get(f.page_snapshot_id);
    const mv = (f.evidence.measured_values ?? {}) as Record<string, unknown>;
    const also = Array.isArray(mv.also_found_on_urls) ? (mv.also_found_on_urls as string[]).map(pageIdOf).sort() : [];
    const check = checkForFinding(f);
    const base = {
      site, page: snap?.page ?? "(unknown)", criterion: f.wcag_criterion, selector: f.evidence.element_selector,
      html_sha256: sha256(f.evidence.element_html ?? ""), failure_type: typeof mv.failure_type === "string" ? mv.failure_type : null,
      check, state: predictionState(f),
    };
    let key = sha256(canonicalJson(base)).slice(0, 24);
    // Identical findings on one page (rare) stay distinct but stable
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    if (n > 0) key = `${key}-${n}`;
    return {
      prediction_key: key,
      ...base,
      element_html: f.evidence.element_html ?? "",
      tier: check ? (checkTiers[check] ?? null) : null,
      severity: f.severity,
      confidence_tier: f.confidence.tier,
      confidence_score: f.confidence.score,
      detected_by: f.evidence.detected_by,
      reasoning: f.analysis.reasoning,
      model_image: Boolean(f.analysis.llm_input?.screenshot_provided),
      also_found_on: also,
      evidence: {
        element_screenshot: f.evidence.element_screenshot || null,
        context_screenshot: f.evidence.context_screenshot || null,
        page_screenshot: snap?.screenshot || null,
      },
      measured_values: Object.fromEntries(Object.entries(mv).filter(([k]) => k !== "also_found_on_urls")),
    };
  });
}
