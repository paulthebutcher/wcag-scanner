import type { CheckResult } from "../../types.js";
import type { PromptRunner, PromptResult, PromptInput } from "../../core/prompt-runner.js";
import type { FormInfo, FormFieldInfo } from "./discovery.js";
import type { SubmissionState, DetectedError } from "./submission.js";
import {
  errorMessageQuality,
  inputPurposeMatching,
  buildErrorMessageUserPrompt,
  buildInputPurposeUserPrompt,
  ERROR_MESSAGE_FAILURE_MODES,
  INPUT_PURPOSE_FAILURE_MODES,
} from "../../prompts/form-interaction.js";
import { buildLlmCapture } from "../semantic/llm-capture.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result from Claude's error message quality evaluation */
export interface ErrorMessageEvaluation {
  verdict: "pass" | "fail" | "needs_review";
  confidence: number;
  reasoning: string;
  wcag_criterion: string;
  failure_type: string | null;
  suggestion: string | null;
  affected_users: string[];
  requires_human_verification: boolean;
  form_fields_evaluated: number;
  errors_found: number;
}

/** Result from Claude's input purpose evaluation */
export interface InputPurposeEvaluation {
  verdict: "pass" | "fail" | "needs_review";
  confidence: number;
  reasoning: string;
  wcag_criterion: string;
  failure_type: string | null;
  suggestion: string | null;
  affected_users: string[];
  requires_human_verification: boolean;
}

// ---------------------------------------------------------------------------
// All 8 error message failure modes
// ---------------------------------------------------------------------------

/**
 * The 8 failure modes detected by error message evaluation:
 *
 * 1. error_not_identified — Error occurs but is not communicated in text
 * 2. error_no_text — Error element exists but has no text content
 * 3. error_not_associated — Error message not programmatically linked to field
 * 4. error_color_only — Error indicated only through color change
 * 5. error_not_descriptive — Error message doesn't clearly explain the problem
 * 6. error_not_near_field — Error message not visually near the field it refers to
 * 7. error_no_suggestion — Error doesn't suggest how to fix the problem (3.3.3)
 * 8. error_suggestion_unclear — Suggestion exists but is too vague to act on (3.3.3)
 */
export const ALL_ERROR_FAILURE_MODES = ERROR_MESSAGE_FAILURE_MODES;

// ---------------------------------------------------------------------------
// Error message quality evaluation (Prompt 9)
// ---------------------------------------------------------------------------

/**
 * Evaluate error message quality using Claude API (Prompt 9).
 *
 * Called after form submission testing has captured before/after DOM states
 * and detected error messages. Sends the form state to Claude for evaluation
 * of WCAG 3.3.1 (Error Identification) and 3.3.3 (Error Suggestion).
 *
 * Detects all 8 failure modes:
 * - error_not_identified, error_no_text, error_not_associated
 * - error_color_only, error_not_descriptive, error_not_near_field
 * - error_no_suggestion, error_suggestion_unclear
 */
export async function evaluateErrorMessages(
  states: SubmissionState[],
  runner: PromptRunner,
  options: {
    screenshotProvider?: (state: SubmissionState) => Promise<string | undefined>;
  } = {},
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Filter to states that have errors or should have errors (required fields with empty submission)
  const relevantStates = states.filter(
    (s) => s.errorMessages.length > 0 || s.scenario.name === "empty_submission",
  );

  if (relevantStates.length === 0) return [];

  // Build prompt inputs for each state
  const promptInputs = relevantStates.map((state) => ({
    template: errorMessageQuality,
    userMessage: buildErrorMessageUserPrompt({
      formHtml: truncateHtml(state.domAfter, 8000),
      errorMessages: state.errorMessages.map((e) => ({
        fieldName: e.fieldSelector ?? e.selector,
        message: e.text,
        associated: e.associatedWithField,
      })),
      totalFields: state.formInfo.fields.length,
    }),
    imageBase64: state.screenshotAfter || undefined,
    imageMediaType: "image/png" as const,
  }));

  // Get optional screenshots from provider
  if (options.screenshotProvider) {
    for (let i = 0; i < relevantStates.length; i++) {
      const screenshot = await options.screenshotProvider(relevantStates[i]);
      if (screenshot) {
        promptInputs[i].imageBase64 = screenshot;
      }
    }
  }

  // Send to Claude
  const evalResults = await runner.runPrompts<ErrorMessageEvaluation>(promptInputs);

  // Map results to CheckResults
  for (let i = 0; i < relevantStates.length; i++) {
    const state = relevantStates[i];
    const evalResult = evalResults[i];
    const checkResult = mapErrorEvalToCheckResult(state, evalResult, promptInputs[i]);
    if (checkResult) results.push(checkResult);
  }

  return results;
}

/**
 * Map a Claude error message evaluation to a CheckResult (if failing).
 */
function mapErrorEvalToCheckResult(
  state: SubmissionState,
  evalResult: PromptResult<ErrorMessageEvaluation>,
  promptInput: PromptInput,
): CheckResult | null {
  const capture = buildLlmCapture(promptInput, evalResult);
  // Handle API failure
  if (!evalResult.success && !evalResult.data) {
    return {
      element_selector: state.formInfo.selector,
      element_html: truncateHtml(state.formInfo.html, 500),
      wcag_criterion: "3.3.1",
      detected_by: "claude_api",
      raw_result: {
        verdict: "needs_review",
        confidence: 0,
        reasoning: `Error message evaluation failed: ${evalResult.error}`,
        requires_human_verification: true,
        scenario: state.scenario.name,
      },
      measured_values: {
        scenario: state.scenario.name,
        failure_type: null,
        error_count: state.errorMessages.length,
      },
      llm_input: capture.llm_input,
      llm_output: capture.llm_output,
    };
  }

  const evaluation = evalResult.data!;

  // Only produce CheckResult for failures and needs_review
  if (evaluation.verdict === "pass") return null;

  // Determine the WCAG criterion based on failure type
  const criterion = isErrorSuggestionFailure(evaluation.failure_type)
    ? "3.3.3"
    : "3.3.1";

  return {
    element_selector: state.formInfo.selector,
    element_html: truncateHtml(state.formInfo.html, 500),
    wcag_criterion: criterion,
    detected_by: "claude_api",
    raw_result: evaluation,
    measured_values: {
      scenario: state.scenario.name,
      failure_type: evaluation.failure_type,
      confidence: evaluation.confidence,
      error_count: state.errorMessages.length,
      fields_evaluated: evaluation.form_fields_evaluated,
    },
    llm_input: capture.llm_input,
    llm_output: capture.llm_output,
  };
}

/** Check if a failure type belongs to 3.3.3 (Error Suggestion) */
function isErrorSuggestionFailure(failureType: string | null): boolean {
  return failureType === "error_no_suggestion" || failureType === "error_suggestion_unclear";
}

// ---------------------------------------------------------------------------
// Input purpose matching evaluation (Prompt 11)
// ---------------------------------------------------------------------------

/**
 * Evaluate input purpose matching using Claude API (Prompt 11).
 *
 * Checks each form field for correct autocomplete attributes per WCAG 1.3.5.
 * Only evaluates fields that collect personal information (name, email, phone, etc.).
 */
export async function evaluateInputPurpose(
  form: FormInfo,
  runner: PromptRunner,
): Promise<CheckResult[]> {
  // Filter to fields that might need autocomplete
  const personalFields = form.fields.filter(isPersonalInfoField);

  if (personalFields.length === 0) return [];

  // Pre-filter: skip fields that already have a valid, type-compatible
  // autocomplete token. These are categorically passing 1.3.5 and don't
  // need an API call.
  const fieldsToCheck = personalFields.filter((f) => !inputPurposePassesPreFilter(f));

  if (fieldsToCheck.length === 0) return [];

  // Build prompt inputs
  const promptInputs = fieldsToCheck.map((field) => ({
    template: inputPurposeMatching,
    userMessage: buildInputPurposeUserPrompt({
      elementHtml: field.html,
      labelText: field.label,
      autocompleteValue: field.autocomplete,
      inputType: field.type,
    }),
  }));

  // Send to Claude
  const evalResults = await runner.runPrompts<InputPurposeEvaluation>(promptInputs);
  const results: CheckResult[] = [];

  // Map results to CheckResults
  for (let i = 0; i < fieldsToCheck.length; i++) {
    const field = fieldsToCheck[i];
    const evalResult = evalResults[i];
    const checkResult = mapInputPurposeToCheckResult(field, evalResult, promptInputs[i]);
    if (checkResult) results.push(checkResult);
  }

  return results;
}

/**
 * Map a Claude input purpose evaluation to a CheckResult (if failing).
 */
function mapInputPurposeToCheckResult(
  field: FormFieldInfo,
  evalResult: PromptResult<InputPurposeEvaluation>,
  promptInput: PromptInput,
): CheckResult | null {
  const capture = buildLlmCapture(promptInput, evalResult);
  // Handle API failure
  if (!evalResult.success && !evalResult.data) {
    return {
      element_selector: field.selector,
      element_html: field.html,
      wcag_criterion: "1.3.5",
      detected_by: "claude_api",
      raw_result: {
        verdict: "needs_review",
        confidence: 0,
        reasoning: `Input purpose evaluation failed: ${evalResult.error}`,
        requires_human_verification: true,
      },
      measured_values: {
        field_name: field.name,
        field_type: field.type,
        failure_type: null,
      },
      llm_input: capture.llm_input,
      llm_output: capture.llm_output,
    };
  }

  const evaluation = evalResult.data!;

  if (evaluation.verdict === "pass") return null;

  return {
    element_selector: field.selector,
    element_html: field.html,
    wcag_criterion: "1.3.5",
    detected_by: "claude_api",
    raw_result: evaluation,
    measured_values: {
      field_name: field.name,
      field_type: field.type,
      field_label: field.label,
      current_autocomplete: field.autocomplete,
      failure_type: evaluation.failure_type,
      confidence: evaluation.confidence,
    },
    llm_input: capture.llm_input,
    llm_output: capture.llm_output,
  };
}

// ---------------------------------------------------------------------------
// Autocomplete pre-filter
// ---------------------------------------------------------------------------

/**
 * Full set of valid HTML autocomplete tokens (WHATWG/W3C spec). Mirrors the
 * list in the 1.3.5 prompt — kept in sync there as documentation.
 */
const VALID_AUTOCOMPLETE_TOKENS = new Set([
  "name", "honorific-prefix", "given-name", "additional-name", "family-name",
  "honorific-suffix", "nickname", "email", "username", "new-password",
  "current-password", "one-time-code", "organization-title", "organization",
  "street-address", "address-line1", "address-line2", "address-line3",
  "address-level4", "address-level3", "address-level2", "address-level1",
  "country", "country-name", "postal-code",
  "cc-name", "cc-given-name", "cc-additional-name", "cc-family-name",
  "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc", "cc-type",
  "transaction-currency", "transaction-amount", "language",
  "bday", "bday-day", "bday-month", "bday-year", "sex",
  "tel", "tel-country-code", "tel-national", "tel-area-code",
  "tel-local", "tel-extension", "impp", "url", "photo",
]);

/**
 * When the input type is specific (email/tel/url/password), the autocomplete
 * token should be compatible with it. Otherwise any valid token is acceptable
 * since matching the field's semantic purpose is evaluated separately.
 */
const TYPE_COMPATIBLE_TOKENS: Record<string, Set<string>> = {
  email: new Set(["email"]),
  tel: new Set([
    "tel", "tel-country-code", "tel-national", "tel-area-code",
    "tel-local", "tel-extension",
  ]),
  url: new Set(["url", "photo", "impp"]),
  password: new Set(["new-password", "current-password", "one-time-code"]),
};

/**
 * Return true if the field already has a valid autocomplete token compatible
 * with its input type. Pre-filter skips these fields — no API call needed.
 *
 * The autocomplete attribute can legally have multi-token values such as
 * "shipping street-address" or "section-ship billing given-name". Per the
 * HTML spec the final token is the "autofill field name" — we evaluate that.
 */
export function inputPurposePassesPreFilter(field: FormFieldInfo): boolean {
  if (!field.autocomplete) return false;
  const value = field.autocomplete.trim().toLowerCase();
  if (value.length === 0) return false;
  // "off" / "on" are valid attribute values but not autofill field names —
  // they don't identify the input purpose and shouldn't auto-pass.
  if (value === "off" || value === "on") return false;

  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const lastToken = tokens[tokens.length - 1];

  if (!VALID_AUTOCOMPLETE_TOKENS.has(lastToken)) return false;

  const compatible = TYPE_COMPATIBLE_TOKENS[field.type];
  if (compatible && !compatible.has(lastToken)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Personal info field detection
// ---------------------------------------------------------------------------

/** Keywords indicating a field collects personal information */
const PERSONAL_FIELD_PATTERNS: RegExp[] = [
  /\b(name|first.?name|last.?name|full.?name|given.?name|family.?name)\b/i,
  /\b(email|e-mail)\b/i,
  /\b(tel|phone|mobile|fax)\b/i,
  /\b(address|street|city|state|zip|postal|country|region)\b/i,
  /\b(username|user.?name|user.?id)\b/i,
  /\b(password|pass|pwd)\b/i,
  /\b(birthday|birth.?date|dob|date.?of.?birth)\b/i,
  /\b(cc|credit.?card|card.?number|cvv|cvc|expir)\b/i,
  /\b(organization|company|org)\b/i,
  /\b(url|website|homepage)\b/i,
];

/** Types that commonly collect personal info */
const PERSONAL_INPUT_TYPES = new Set([
  "email", "tel", "url", "password",
]);

/**
 * Determine if a field likely collects personal information
 * and should have an autocomplete attribute per WCAG 1.3.5.
 */
export function isPersonalInfoField(field: FormFieldInfo): boolean {
  // Check by input type
  if (PERSONAL_INPUT_TYPES.has(field.type)) return true;

  // Check field label, name, and placeholder against patterns
  const searchText = [
    field.label,
    field.name ?? "",
    field.placeholder ?? "",
  ].join(" ");

  return PERSONAL_FIELD_PATTERNS.some((p) => p.test(searchText));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateHtml(html: string, maxLength: number): string {
  if (html.length <= maxLength) return html;
  return html.slice(0, maxLength) + "...";
}
