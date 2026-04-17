import type { CheckResult } from "../../types.js";
import type { PromptRunner, PromptResult, PromptInput } from "../../core/prompt-runner.js";
import type { FormInfo } from "./discovery.js";
import {
  highRiskFormDetection,
  buildHighRiskFormUserPrompt,
  HIGH_RISK_FORM_FAILURE_MODES,
} from "../../prompts/form-interaction.js";
import { buildLlmCapture } from "../semantic/llm-capture.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Risk classification for a form */
export type RiskCategory = "financial" | "legal" | "data" | "none";

/** Result from Claude's high-risk form evaluation */
export interface HighRiskFormEvaluation {
  verdict: "pass" | "fail" | "needs_review";
  confidence: number;
  reasoning: string;
  wcag_criterion: string;
  failure_type: string | null;
  suggestion: string | null;
  affected_users: string[];
  requires_human_verification: boolean;
}

/** Pre-classification result before sending to Claude */
export interface FormRiskClassification {
  form: FormInfo;
  riskCategory: RiskCategory;
  riskSignals: string[];
  hasConfirmation: boolean;
  hasReviewStep: boolean;
}

// ---------------------------------------------------------------------------
// Step 1: Classify form risk (rule-based pre-filter)
// ---------------------------------------------------------------------------

/** Keywords that signal financial risk */
const FINANCIAL_SIGNALS: RegExp[] = [
  /\b(payment|pay|purchase|buy|order|checkout|cart)\b/i,
  /\b(credit\s*card|debit\s*card|card\s*number|cvv|cvc)\b/i,
  /\b(bank|account\s*number|routing|wire\s*transfer)\b/i,
  /\b(billing|invoice|charge|subscription|recurring)\b/i,
  /\b(donate|donation|tip|contribution)\b/i,
  /autocomplete\s*=\s*["']cc-/i,
  /\b(price|amount|total|cost)\b/i,
];

/** Keywords that signal legal risk */
const LEGAL_SIGNALS: RegExp[] = [
  /\b(agree|agreement|terms|conditions|contract|binding)\b/i,
  /\b(license|tos|terms\s*of\s*service|privacy\s*policy)\b/i,
  /\b(consent|authorize|authorization|signature|sign)\b/i,
  /\b(legal|liability|warranty|indemnify|waiver)\b/i,
  /\b(enrollment|register|membership)\b/i,
];

/** Keywords that signal data commitment risk */
const DATA_SIGNALS: RegExp[] = [
  /\b(delete|remove|destroy|permanent|irreversible)\b/i,
  /\b(close\s*account|deactivate|cancel\s*subscription)\b/i,
  /\b(export|download\s*data|data\s*request)\b/i,
  /\b(transfer|migrate|move\s*account)\b/i,
  /\b(unsubscribe|opt.?out|revoke)\b/i,
];

/** Keywords that signal a confirmation/review mechanism */
const CONFIRMATION_SIGNALS: RegExp[] = [
  /\b(confirm|review|preview|verify|double.?check)\b/i,
  /\b(are\s*you\s*sure|really\s*want\s*to)\b/i,
  /\b(step\s*\d|review\s*order|summary)\b/i,
];

/**
 * Classify a form's risk level using rule-based heuristics.
 *
 * This is Step 1 of the two-step process:
 * 1. Classify risk category (rule-based) — this function
 * 2. Evaluate safeguards (Claude API) — evaluateHighRiskForms
 *
 * Forms classified as "none" are auto-passed with clear reasoning.
 */
export function classifyFormRisk(form: FormInfo): FormRiskClassification {
  const searchText = [
    form.html,
    form.submitButtonText,
    ...form.fields.map((f) => `${f.label} ${f.name ?? ""} ${f.placeholder ?? ""} ${f.autocomplete ?? ""}`),
  ].join(" ");

  const riskSignals: string[] = [];
  let riskCategory: RiskCategory = "none";

  // Check financial signals
  for (const pattern of FINANCIAL_SIGNALS) {
    const match = searchText.match(pattern);
    if (match) {
      riskSignals.push(`financial: "${match[0]}"`);
      if (riskCategory === "none") riskCategory = "financial";
    }
  }

  // Check legal signals
  for (const pattern of LEGAL_SIGNALS) {
    const match = searchText.match(pattern);
    if (match) {
      riskSignals.push(`legal: "${match[0]}"`);
      if (riskCategory === "none") riskCategory = "legal";
    }
  }

  // Check data signals
  for (const pattern of DATA_SIGNALS) {
    const match = searchText.match(pattern);
    if (match) {
      riskSignals.push(`data: "${match[0]}"`);
      if (riskCategory === "none") riskCategory = "data";
    }
  }

  // Check for confirmation/review mechanisms
  let hasConfirmation = false;
  let hasReviewStep = false;

  for (const pattern of CONFIRMATION_SIGNALS) {
    if (pattern.test(searchText)) {
      if (/confirm|are\s*you\s*sure|verify/i.test(searchText)) {
        hasConfirmation = true;
      }
      if (/review|preview|step\s*\d|summary/i.test(searchText)) {
        hasReviewStep = true;
      }
    }
  }

  // Prioritize: financial > legal > data
  if (riskSignals.some((s) => s.startsWith("financial"))) {
    riskCategory = "financial";
  } else if (riskSignals.some((s) => s.startsWith("legal"))) {
    riskCategory = "legal";
  } else if (riskSignals.some((s) => s.startsWith("data"))) {
    riskCategory = "data";
  }

  return {
    form,
    riskCategory,
    riskSignals,
    hasConfirmation,
    hasReviewStep,
  };
}

// ---------------------------------------------------------------------------
// Step 2: Evaluate safeguards via Claude API (Prompt 10)
// ---------------------------------------------------------------------------

/**
 * Evaluate high-risk forms for error prevention safeguards using Claude API (Prompt 10).
 *
 * Two-step process:
 * 1. classifyFormRisk() pre-filters forms by risk category (rule-based)
 * 2. This function sends only high-risk forms to Claude for safeguard evaluation
 *
 * Non-covered forms (riskCategory === "none") are auto-passed with clear reasoning.
 * Produces CheckResult for covered forms missing safeguards (criterion 3.3.4).
 */
export async function evaluateHighRiskForms(
  forms: FormInfo[],
  runner: PromptRunner,
  options: {
    screenshotProvider?: (form: FormInfo) => Promise<string | undefined>;
  } = {},
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Step 1: Classify all forms
  const classifications = forms.map(classifyFormRisk);

  // Separate high-risk from non-risk
  const highRisk = classifications.filter((c) => c.riskCategory !== "none");
  const noRisk = classifications.filter((c) => c.riskCategory === "none");

  // Auto-pass non-covered forms — no CheckResult produced
  // (They simply don't appear in findings, which is correct behavior.
  //  Auto-pass means no violation is reported.)

  if (highRisk.length === 0) return [];

  // Step 2: Send high-risk forms to Claude for safeguard evaluation
  const promptInputs = await Promise.all(highRisk.map(async (classification) => {
    const imageBase64 = options.screenshotProvider
      ? await options.screenshotProvider(classification.form)
      : undefined;

    return {
      template: highRiskFormDetection,
      userMessage: buildHighRiskFormUserPrompt({
        formHtml: truncateHtml(classification.form.html, 8000),
        fieldLabels: classification.form.fields.map((f) => f.label),
        submitButtonText: classification.form.submitButtonText,
        hasConfirmation: classification.hasConfirmation,
        hasReviewStep: classification.hasReviewStep,
      }),
      imageBase64,
      imageMediaType: "image/png" as const,
    };
  }));

  const evalResults = await runner.runPrompts<HighRiskFormEvaluation>(promptInputs);

  // Map results to CheckResults
  for (let i = 0; i < highRisk.length; i++) {
    const classification = highRisk[i];
    const evalResult = evalResults[i];
    const checkResult = mapHighRiskToCheckResult(classification, evalResult, promptInputs[i]);
    if (checkResult) results.push(checkResult);
  }

  return results;
}

/**
 * Map a Claude high-risk evaluation to a CheckResult (if failing).
 */
function mapHighRiskToCheckResult(
  classification: FormRiskClassification,
  evalResult: PromptResult<HighRiskFormEvaluation>,
  promptInput: PromptInput,
): CheckResult | null {
  const capture = buildLlmCapture(promptInput, evalResult);

  // Handle API failure
  if (!evalResult.success && !evalResult.data) {
    return {
      element_selector: classification.form.selector,
      element_html: truncateHtml(classification.form.html, 500),
      wcag_criterion: "3.3.4",
      detected_by: "claude_api",
      raw_result: {
        verdict: "needs_review",
        confidence: 0,
        reasoning: `High-risk form evaluation failed: ${evalResult.error}`,
        requires_human_verification: true,
        risk_category: classification.riskCategory,
        risk_signals: classification.riskSignals,
      },
      measured_values: {
        risk_category: classification.riskCategory,
        risk_signals: classification.riskSignals,
        failure_type: null,
      },
      llm_input: capture.llm_input,
      llm_output: capture.llm_output,
    };
  }

  const evaluation = evalResult.data!;

  // Only produce CheckResult for failures and needs_review
  if (evaluation.verdict === "pass") return null;

  return {
    element_selector: classification.form.selector,
    element_html: truncateHtml(classification.form.html, 500),
    wcag_criterion: "3.3.4",
    detected_by: "claude_api",
    raw_result: evaluation,
    measured_values: {
      risk_category: classification.riskCategory,
      risk_signals: classification.riskSignals,
      has_confirmation: classification.hasConfirmation,
      has_review_step: classification.hasReviewStep,
      failure_type: evaluation.failure_type,
      confidence: evaluation.confidence,
    },
    llm_input: capture.llm_input,
    llm_output: capture.llm_output,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateHtml(html: string, maxLength: number): string {
  if (html.length <= maxLength) return html;
  return html.slice(0, maxLength) + "...";
}
