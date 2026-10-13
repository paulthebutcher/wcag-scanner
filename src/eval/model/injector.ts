import { sha256 } from "../util.js";
import type { EffectiveRequest } from "./cache.js";
import type { InjectedOutcome, Injector } from "./client.js";

// ---------------------------------------------------------------------------
// Deterministic injected model responses for the pilot and the default-path
// equivalence check. The outcome depends only on the request (template and
// user text), never on time or order, so two engines that send the same
// request get the same answer. A small, fixed share of requests gets a
// non-retryable API error so the failure path is exercised too.
// ---------------------------------------------------------------------------

const CRITERION: Record<string, [string, string]> = {
  alt_text_quality: ["1.1.1", "alt_text_not_descriptive"],
  link_text_quality: ["2.4.4", "ambiguous_without_context"],
  heading_structure: ["2.4.6", "non_descriptive"],
  widget_aria_evaluation: ["4.1.2", "missing_aria_expanded"],
  consistent_navigation: ["3.2.3", "order_changed"],
  error_message_quality: ["3.3.1", "error_not_descriptive"],
  high_risk_form_detection: ["3.3.4", "no_confirmation_step"],
  input_purpose_matching: ["1.3.5", "missing_autocomplete"],
};

export function deterministicOutcome(req: EffectiveRequest, errorEvery = 13): InjectedOutcome {
  const h = parseInt(sha256(`${req.template_name}\u0000${req.user_text}`).slice(0, 8), 16);
  if (errorEvery > 0 && h % errorEvery === 0) {
    return { error: { status: 400, message: "injected deterministic failure" } };
  }
  const [criterion, failure] = CRITERION[req.template_name] ?? ["4.1.2", "unspecified"];
  const verdict = (["fail", "pass", "needs_review"] as const)[h % 3];
  const body = {
    verdict,
    confidence: verdict === "pass" ? 0.9 : verdict === "fail" ? 0.85 : 0.4,
    reasoning: `Injected ${verdict} for ${req.template_name} (${(h % 1000).toString().padStart(3, "0")}).`,
    wcag_criterion: criterion,
    failure_type: verdict === "pass" ? null : failure,
    suggestion: verdict === "pass" ? null : "Injected suggestion.",
    affected_users: ["screen_reader"],
    requires_human_verification: verdict === "needs_review",
    form_fields_evaluated: 1,
    errors_found: verdict === "fail" ? 1 : 0,
    failing_heading: null,
    best_practice_issues: [],
  };
  return { text: "```json\n" + JSON.stringify(body, null, 2) + "\n```" };
}

export const deterministicInjector: Injector = (req) => deterministicOutcome(req);
