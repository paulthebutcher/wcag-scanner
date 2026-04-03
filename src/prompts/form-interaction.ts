import type { PromptTemplate, ModelRoute } from "../core/prompt-runner.js";
import type { ConfidenceCalibration } from "./element-evaluation.js";

// ---------------------------------------------------------------------------
// Form Interaction family system prompt
// ---------------------------------------------------------------------------

const FORM_BASE_SYSTEM = `You are a WCAG 2.1 AA accessibility expert evaluating form behavior and error handling.
You analyze form submissions, error messages, and input field configurations to identify accessibility violations.

Rules:
- Apply WCAG 2.1 Level A and AA success criteria only.
- Evaluate both the content and programmatic association of error messages.
- Consider how screen readers and keyboard-only users experience form errors.
- Return your response as a single JSON object (no markdown code fences).
- Do not include explanations outside the JSON.`;

// ---------------------------------------------------------------------------
// Form-specific output schema
// ---------------------------------------------------------------------------

export const FORM_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["verdict", "confidence", "reasoning", "wcag_criterion", "failure_type", "affected_users", "requires_human_verification"],
  properties: {
    verdict: { type: "string", enum: ["pass", "fail", "needs_review"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reasoning: { type: "string" },
    wcag_criterion: { type: "string" },
    failure_type: { type: ["string", "null"] },
    suggestion: { type: ["string", "null"] },
    affected_users: { type: "array", items: { type: "string" } },
    requires_human_verification: { type: "boolean" },
    form_fields_evaluated: { type: "number" },
    errors_found: { type: "number" },
  },
};

// ---------------------------------------------------------------------------
// Failure mode enums
// ---------------------------------------------------------------------------

export const ERROR_MESSAGE_FAILURE_MODES = [
  "error_not_identified",
  "error_no_text",
  "error_not_associated",
  "error_color_only",
  "error_not_descriptive",
  "error_not_near_field",
  "error_no_suggestion",
  "error_suggestion_unclear",
] as const;

export const HIGH_RISK_FORM_FAILURE_MODES = [
  "no_confirmation_step",
  "no_review_page",
  "no_undo_option",
  "financial_no_safeguard",
  "legal_no_safeguard",
  "data_deletion_no_safeguard",
] as const;

export const INPUT_PURPOSE_FAILURE_MODES = [
  "missing_autocomplete",
  "wrong_autocomplete",
  "missing_input_type",
  "wrong_input_type",
] as const;

// ---------------------------------------------------------------------------
// Prompt 9: Error Message Quality (3.3.1, 3.3.3)
// ---------------------------------------------------------------------------

export const errorMessageQuality: PromptTemplate = {
  name: "error_message_quality",
  family: "form_interaction",
  model: "sonnet" as ModelRoute,
  vision: true,
  systemPrompt: `${FORM_BASE_SYSTEM}

You are evaluating form error messages. Two criteria apply:

WCAG 3.3.1 (Error Identification):
- Errors must be identified in text (not just color).
- Error messages must be programmatically associated with the field (aria-describedby, aria-errormessage, or live region).
- Error messages must be clear about which field has the error.

WCAG 3.3.3 (Error Suggestion):
- When errors are detected and suggestions can be provided, they must be.
- Suggestions must be specific (not just "invalid input").
- Suggestions must not compromise security (e.g., don't reveal valid usernames).

Common failure types: ${ERROR_MESSAGE_FAILURE_MODES.join(", ")}

Output format extends the base with:
{
  ...base,
  "form_fields_evaluated": number,
  "errors_found": number
}

You will receive: form HTML after submission, error messages visible, field-error associations, and a screenshot.`,
  outputSchema: FORM_OUTPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Prompt 10: High-Risk Form Detection (3.3.4)
// ---------------------------------------------------------------------------

export const highRiskFormDetection: PromptTemplate = {
  name: "high_risk_form_detection",
  family: "form_interaction",
  model: "sonnet" as ModelRoute,
  vision: true,
  systemPrompt: `${FORM_BASE_SYSTEM}

You are evaluating high-risk forms for error prevention. WCAG 3.3.4 requires that for forms causing legal, financial, or data commitments:
- Submissions are reversible, OR
- Data is checked and the user is given an opportunity to correct errors, OR
- A confirmation mechanism is provided before final submission.

Classify the form risk level:
- Financial: payment, banking, money transfer
- Legal: contracts, agreements, subscriptions, licenses
- Data: account deletion, data export, permanent changes

Common failure types: ${HIGH_RISK_FORM_FAILURE_MODES.join(", ")}

You will receive: form HTML, field labels, button text, and a screenshot. You must determine if the form is high-risk and if adequate safeguards exist.`,
  outputSchema: FORM_OUTPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Prompt 11: Input Purpose Matching (1.3.5)
// ---------------------------------------------------------------------------

export const inputPurposeMatching: PromptTemplate = {
  name: "input_purpose_matching",
  family: "form_interaction",
  model: "sonnet" as ModelRoute,
  vision: false,
  systemPrompt: `${FORM_BASE_SYSTEM}

You are evaluating input purpose identification. WCAG 1.3.5 requires:
- Form fields collecting personal information must have appropriate autocomplete attributes.
- The autocomplete value must match the actual purpose of the field.

Valid autocomplete tokens per the HTML spec include (this is not exhaustive):
name, honorific-prefix, given-name, additional-name, family-name, honorific-suffix,
nickname, email, username, new-password, current-password, one-time-code,
organization-title, organization, street-address, address-line1, address-line2,
address-line3, address-level4, address-level3, address-level2, address-level1,
country, country-name, postal-code, cc-name, cc-given-name, cc-additional-name,
cc-family-name, cc-number, cc-exp, cc-exp-month, cc-exp-year, cc-csc, cc-type,
transaction-currency, transaction-amount, language, bday, bday-day, bday-month,
bday-year, sex, tel, tel-country-code, tel-national, tel-area-code, tel-local,
tel-extension, impp, url, photo.

IMPORTANT: If the autocomplete attribute is present and its value is a valid token from this list that reasonably matches the field's purpose, the input PASSES 1.3.5. Do not flag a valid token as incorrect merely because a more specific token exists (e.g., "name" is valid even if "given-name" would be more precise; "tel" is valid even if "tel-national" would be more specific).

Common failure types: ${INPUT_PURPOSE_FAILURE_MODES.join(", ")}

You will receive: input element HTML, associated labels, current autocomplete value (if any), and input type.
Evaluate whether the autocomplete attribute is present and correct for the field's purpose.`,
  outputSchema: FORM_OUTPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// User prompt template functions
// ---------------------------------------------------------------------------

export function buildErrorMessageUserPrompt(params: {
  formHtml: string;
  errorMessages: Array<{ fieldName: string; message: string; associated: boolean }>;
  totalFields: number;
}): string {
  const errorList = params.errorMessages
    .map((e) => `  Field: "${e.fieldName}" → "${e.message}" (programmatically associated: ${e.associated})`)
    .join("\n");

  return `Evaluate form error messages for WCAG 3.3.1 and 3.3.3 compliance.

Form HTML (after submission):
${params.formHtml}

Error messages found:
${errorList || "  (none visible)"}

Total form fields: ${params.totalFields}`;
}

export function buildHighRiskFormUserPrompt(params: {
  formHtml: string;
  fieldLabels: string[];
  submitButtonText: string;
  hasConfirmation: boolean;
  hasReviewStep: boolean;
}): string {
  return `Evaluate this form for WCAG 3.3.4 error prevention requirements.

Form HTML:
${params.formHtml}

Field labels: ${params.fieldLabels.map((l) => `"${l}"`).join(", ")}
Submit button text: "${params.submitButtonText}"
Has confirmation dialog: ${params.hasConfirmation}
Has review/preview step: ${params.hasReviewStep}

Determine if this is a high-risk form (financial, legal, or data commitment) and whether adequate safeguards exist.`;
}

export function buildInputPurposeUserPrompt(params: {
  elementHtml: string;
  labelText: string;
  autocompleteValue: string | null;
  inputType: string;
}): string {
  return `Evaluate this input field's autocomplete attribute for WCAG 1.3.5 compliance.

Element HTML:
${params.elementHtml}

Label text: "${params.labelText}"
Current autocomplete value: ${params.autocompleteValue ? `"${params.autocompleteValue}"` : "(not set)"}
Input type: "${params.inputType}"

Determine if the autocomplete attribute is present and correct for this field's purpose.`;
}

// ---------------------------------------------------------------------------
// Confidence calibration
// ---------------------------------------------------------------------------

export const ERROR_MESSAGE_CALIBRATION: ConfidenceCalibration[] = [
  { failureType: "error_not_identified", minConfidence: 0.85, maxConfidence: 0.95, requiresHuman: false, falsePositiveRisk: "low" },
  { failureType: "error_not_associated", minConfidence: 0.80, maxConfidence: 0.95, requiresHuman: false, falsePositiveRisk: "low" },
  { failureType: "error_color_only", minConfidence: 0.75, maxConfidence: 0.90, requiresHuman: false, falsePositiveRisk: "medium" },
  { failureType: "error_not_descriptive", minConfidence: 0.60, maxConfidence: 0.80, requiresHuman: true, falsePositiveRisk: "medium" },
  { failureType: "error_no_suggestion", minConfidence: 0.65, maxConfidence: 0.85, requiresHuman: true, falsePositiveRisk: "medium" },
];

export const HIGH_RISK_FORM_CALIBRATION: ConfidenceCalibration[] = [
  { failureType: "no_confirmation_step", minConfidence: 0.70, maxConfidence: 0.90, requiresHuman: true, falsePositiveRisk: "medium" },
  { failureType: "financial_no_safeguard", minConfidence: 0.75, maxConfidence: 0.90, requiresHuman: true, falsePositiveRisk: "medium" },
  { failureType: "data_deletion_no_safeguard", minConfidence: 0.80, maxConfidence: 0.95, requiresHuman: false, falsePositiveRisk: "low" },
];

export const INPUT_PURPOSE_CALIBRATION: ConfidenceCalibration[] = [
  { failureType: "missing_autocomplete", minConfidence: 0.85, maxConfidence: 0.95, requiresHuman: false, falsePositiveRisk: "low" },
  { failureType: "wrong_autocomplete", minConfidence: 0.70, maxConfidence: 0.90, requiresHuman: true, falsePositiveRisk: "medium" },
  { failureType: "missing_input_type", minConfidence: 0.80, maxConfidence: 0.95, requiresHuman: false, falsePositiveRisk: "low" },
];

// ---------------------------------------------------------------------------
// Prompt registry for Form Interaction family
// ---------------------------------------------------------------------------

export const FORM_PROMPTS: Record<string, PromptTemplate> = {
  error_message_quality: errorMessageQuality,
  high_risk_form_detection: highRiskFormDetection,
  input_purpose_matching: inputPurposeMatching,
};

export const FORM_CALIBRATIONS: Record<string, ConfidenceCalibration[]> = {
  error_message_quality: ERROR_MESSAGE_CALIBRATION,
  high_risk_form_detection: HIGH_RISK_FORM_CALIBRATION,
  input_purpose_matching: INPUT_PURPOSE_CALIBRATION,
};
