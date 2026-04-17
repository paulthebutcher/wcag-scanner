import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  evaluateErrorMessages,
  evaluateInputPurpose,
  inputPurposePassesPreFilter,
  isPersonalInfoField,
  ALL_ERROR_FAILURE_MODES,
  type ErrorMessageEvaluation,
  type InputPurposeEvaluation,
} from "../../src/checks/forms/error-evaluation.js";
import type { FormInfo, FormFieldInfo } from "../../src/checks/forms/discovery.js";
import type { SubmissionState, DetectedError, SubmissionScenario } from "../../src/checks/forms/submission.js";
import { PromptRunner } from "../../src/core/prompt-runner.js";
import type { PromptResult } from "../../src/core/prompt-runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeField(overrides: Partial<FormFieldInfo> = {}): FormFieldInfo {
  return {
    selector: "#field",
    html: '<input type="text" name="field">',
    tagName: "input",
    type: "text",
    name: "field",
    label: "Field",
    required: false,
    autocomplete: null,
    placeholder: null,
    ariaDescribedby: null,
    ariaInvalid: null,
    ...overrides,
  };
}

function makeForm(overrides: Partial<FormInfo> = {}): FormInfo {
  return {
    selector: "#form",
    html: "<form></form>",
    action: "/submit",
    method: "POST",
    fields: [],
    submitButtonText: "Submit",
    submitButtonSelector: 'button[type="submit"]',
    purpose: "unknown",
    isWebflowForm: false,
    isDivBased: false,
    ...overrides,
  };
}

function makeScenario(overrides: Partial<SubmissionScenario> = {}): SubmissionScenario {
  return {
    name: "empty_submission",
    fieldValues: new Map(),
    description: "Submit empty",
    ...overrides,
  };
}

function makeDetectedError(overrides: Partial<DetectedError> = {}): DetectedError {
  return {
    selector: ".error",
    text: "This field is required",
    detectionMethod: "role_alert",
    associatedWithField: true,
    fieldSelector: "#email",
    colorOnlyIndicator: false,
    hasAriaDescribedby: true,
    isVisible: true,
    ...overrides,
  };
}

function makeSubmissionState(overrides: Partial<SubmissionState> = {}): SubmissionState {
  return {
    scenario: makeScenario(),
    domBefore: "<html><body><form></form></body></html>",
    domAfter: '<html><body><form><div role="alert">Error</div></form></body></html>',
    screenshotAfter: "base64screenshot",
    errorMessages: [makeDetectedError()],
    navigated: false,
    formInfo: makeForm({
      fields: [makeField({ selector: "#email", type: "email", name: "email", label: "Email", required: true })],
    }),
    ...overrides,
  };
}

function makeEvalResult<T>(data: T, overrides: Partial<PromptResult<T>> = {}): PromptResult<T> {
  return {
    success: true,
    data,
    rawResponse: "{}",
    model: "claude-sonnet-4-6",
    tokensUsed: 100,
    latencyMs: 500,
    retries: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// evaluateErrorMessages (Prompt 9)
// ---------------------------------------------------------------------------

describe("evaluateErrorMessages", () => {
  let mockRunner: PromptRunner;
  let runPromptsSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRunner = new PromptRunner("test-key", { max_retries: 0 });
    runPromptsSpy = vi.fn().mockResolvedValue([]);
    mockRunner.runPrompts = runPromptsSpy;
  });

  it("sends states with errors to Claude for evaluation", async () => {
    const state = makeSubmissionState();

    runPromptsSpy.mockResolvedValue([
      makeEvalResult<ErrorMessageEvaluation>({
        verdict: "fail",
        confidence: 0.85,
        reasoning: "Error message not programmatically associated",
        wcag_criterion: "3.3.1",
        failure_type: "error_not_associated",
        suggestion: "Add aria-describedby linking error to field",
        affected_users: ["screen_reader"],
        requires_human_verification: false,
        form_fields_evaluated: 1,
        errors_found: 1,
      }),
    ]);

    const results = await evaluateErrorMessages([state], mockRunner);
    expect(results.length).toBe(1);
    expect(results[0].wcag_criterion).toBe("3.3.1");
    expect(results[0].detected_by).toBe("claude_api");
    expect(results[0].measured_values?.failure_type).toBe("error_not_associated");
  });

  it("returns empty for states with no errors and non-empty scenarios", async () => {
    const state = makeSubmissionState({
      scenario: makeScenario({ name: "invalid_email" }),
      errorMessages: [],
    });

    const results = await evaluateErrorMessages([state], mockRunner);
    expect(results).toEqual([]);
    expect(runPromptsSpy).not.toHaveBeenCalled();
  });

  it("evaluates empty submission states even with no errors", async () => {
    const state = makeSubmissionState({
      scenario: makeScenario({ name: "empty_submission" }),
      errorMessages: [],
    });

    runPromptsSpy.mockResolvedValue([
      makeEvalResult<ErrorMessageEvaluation>({
        verdict: "fail",
        confidence: 0.90,
        reasoning: "No error messages shown for required fields",
        wcag_criterion: "3.3.1",
        failure_type: "error_not_identified",
        suggestion: "Show error messages for required fields",
        affected_users: ["screen_reader", "cognitive"],
        requires_human_verification: false,
        form_fields_evaluated: 1,
        errors_found: 0,
      }),
    ]);

    const results = await evaluateErrorMessages([state], mockRunner);
    expect(results.length).toBe(1);
    expect(results[0].measured_values?.failure_type).toBe("error_not_identified");
  });

  it("does not return CheckResult for passing evaluation", async () => {
    const state = makeSubmissionState();

    runPromptsSpy.mockResolvedValue([
      makeEvalResult<ErrorMessageEvaluation>({
        verdict: "pass",
        confidence: 0.95,
        reasoning: "Error messages are well-formed and accessible",
        wcag_criterion: "3.3.1",
        failure_type: null,
        suggestion: null,
        affected_users: [],
        requires_human_verification: false,
        form_fields_evaluated: 1,
        errors_found: 1,
      }),
    ]);

    const results = await evaluateErrorMessages([state], mockRunner);
    expect(results.length).toBe(0);
  });

  it("returns needs_review for API failures", async () => {
    const state = makeSubmissionState();

    runPromptsSpy.mockResolvedValue([
      makeEvalResult<ErrorMessageEvaluation>(null as unknown as ErrorMessageEvaluation, {
        success: false,
        data: null,
        error: "API timeout",
      }),
    ]);

    const results = await evaluateErrorMessages([state], mockRunner);
    expect(results.length).toBe(1);
    expect((results[0].raw_result as Record<string, unknown>).verdict).toBe("needs_review");
  });

  it("maps error_no_suggestion to 3.3.3 criterion", async () => {
    const state = makeSubmissionState();

    runPromptsSpy.mockResolvedValue([
      makeEvalResult<ErrorMessageEvaluation>({
        verdict: "fail",
        confidence: 0.75,
        reasoning: "Error doesn't suggest how to fix the problem",
        wcag_criterion: "3.3.3",
        failure_type: "error_no_suggestion",
        suggestion: "Add suggestion like 'Email must include @'",
        affected_users: ["cognitive"],
        requires_human_verification: true,
        form_fields_evaluated: 1,
        errors_found: 1,
      }),
    ]);

    const results = await evaluateErrorMessages([state], mockRunner);
    expect(results.length).toBe(1);
    expect(results[0].wcag_criterion).toBe("3.3.3");
  });

  it("maps error_suggestion_unclear to 3.3.3 criterion", async () => {
    const state = makeSubmissionState();

    runPromptsSpy.mockResolvedValue([
      makeEvalResult<ErrorMessageEvaluation>({
        verdict: "fail",
        confidence: 0.70,
        reasoning: "Suggestion is too vague",
        wcag_criterion: "3.3.3",
        failure_type: "error_suggestion_unclear",
        suggestion: "Make suggestion more specific",
        affected_users: ["cognitive"],
        requires_human_verification: true,
        form_fields_evaluated: 1,
        errors_found: 1,
      }),
    ]);

    const results = await evaluateErrorMessages([state], mockRunner);
    expect(results[0].wcag_criterion).toBe("3.3.3");
  });

  it("sends correct prompt template name", async () => {
    const state = makeSubmissionState();

    runPromptsSpy.mockResolvedValue([
      makeEvalResult<ErrorMessageEvaluation>({
        verdict: "pass",
        confidence: 0.9,
        reasoning: "OK",
        wcag_criterion: "3.3.1",
        failure_type: null,
        suggestion: null,
        affected_users: [],
        requires_human_verification: false,
        form_fields_evaluated: 1,
        errors_found: 0,
      }),
    ]);

    await evaluateErrorMessages([state], mockRunner);
    const inputs = runPromptsSpy.mock.calls[0][0];
    expect(inputs[0].template.name).toBe("error_message_quality");
  });

  it("includes screenshot in prompt when available", async () => {
    const state = makeSubmissionState({ screenshotAfter: "base64data" });

    runPromptsSpy.mockResolvedValue([
      makeEvalResult<ErrorMessageEvaluation>({
        verdict: "pass",
        confidence: 0.9,
        reasoning: "OK",
        wcag_criterion: "3.3.1",
        failure_type: null,
        suggestion: null,
        affected_users: [],
        requires_human_verification: false,
        form_fields_evaluated: 1,
        errors_found: 0,
      }),
    ]);

    await evaluateErrorMessages([state], mockRunner);
    const inputs = runPromptsSpy.mock.calls[0][0];
    expect(inputs[0].imageBase64).toBe("base64data");
  });

  it("detects all 8 failure modes via Claude evaluation", async () => {
    for (const mode of ALL_ERROR_FAILURE_MODES) {
      const state = makeSubmissionState();
      runPromptsSpy.mockResolvedValue([
        makeEvalResult<ErrorMessageEvaluation>({
          verdict: "fail",
          confidence: 0.80,
          reasoning: `Failure: ${mode}`,
          wcag_criterion: mode.includes("suggestion") ? "3.3.3" : "3.3.1",
          failure_type: mode,
          suggestion: "Fix it",
          affected_users: ["screen_reader"],
          requires_human_verification: false,
          form_fields_evaluated: 1,
          errors_found: 1,
        }),
      ]);

      const results = await evaluateErrorMessages([state], mockRunner);
      expect(results.length).toBe(1);
      expect(results[0].measured_values?.failure_type).toBe(mode);
    }
  });

  it("handles multiple states in a single call", async () => {
    const state1 = makeSubmissionState();
    const state2 = makeSubmissionState({
      scenario: makeScenario({ name: "empty_submission" }),
      errorMessages: [makeDetectedError({ text: "Name is required" })],
    });

    runPromptsSpy.mockResolvedValue([
      makeEvalResult<ErrorMessageEvaluation>({
        verdict: "fail",
        confidence: 0.85,
        reasoning: "Not associated",
        wcag_criterion: "3.3.1",
        failure_type: "error_not_associated",
        suggestion: "Add aria-describedby",
        affected_users: ["screen_reader"],
        requires_human_verification: false,
        form_fields_evaluated: 1,
        errors_found: 1,
      }),
      makeEvalResult<ErrorMessageEvaluation>({
        verdict: "pass",
        confidence: 0.95,
        reasoning: "OK",
        wcag_criterion: "3.3.1",
        failure_type: null,
        suggestion: null,
        affected_users: [],
        requires_human_verification: false,
        form_fields_evaluated: 1,
        errors_found: 1,
      }),
    ]);

    const results = await evaluateErrorMessages([state1, state2], mockRunner);
    expect(results.length).toBe(1); // Only state1 fails
  });
});

// ---------------------------------------------------------------------------
// evaluateInputPurpose (Prompt 11)
// ---------------------------------------------------------------------------

describe("evaluateInputPurpose", () => {
  let mockRunner: PromptRunner;
  let runPromptsSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRunner = new PromptRunner("test-key", { max_retries: 0 });
    runPromptsSpy = vi.fn().mockResolvedValue([]);
    mockRunner.runPrompts = runPromptsSpy;
  });

  it("evaluates personal info fields for autocomplete", async () => {
    const form = makeForm({
      fields: [
        makeField({ selector: "#email", type: "email", name: "email", label: "Email" }),
        makeField({ selector: "#name", type: "text", name: "name", label: "Full Name" }),
      ],
    });

    runPromptsSpy.mockResolvedValue([
      makeEvalResult<InputPurposeEvaluation>({
        verdict: "fail",
        confidence: 0.90,
        reasoning: "Email field missing autocomplete",
        wcag_criterion: "1.3.5",
        failure_type: "missing_autocomplete",
        suggestion: 'Add autocomplete="email"',
        affected_users: ["cognitive", "motor_impaired"],
        requires_human_verification: false,
      }),
      makeEvalResult<InputPurposeEvaluation>({
        verdict: "fail",
        confidence: 0.85,
        reasoning: "Name field missing autocomplete",
        wcag_criterion: "1.3.5",
        failure_type: "missing_autocomplete",
        suggestion: 'Add autocomplete="name"',
        affected_users: ["cognitive", "motor_impaired"],
        requires_human_verification: false,
      }),
    ]);

    const results = await evaluateInputPurpose(form, mockRunner);
    expect(results.length).toBe(2);
    expect(results[0].wcag_criterion).toBe("1.3.5");
    expect(results[0].detected_by).toBe("claude_api");
  });

  it("skips non-personal fields", async () => {
    const form = makeForm({
      fields: [
        makeField({ selector: "#comments", type: "text", name: "comments", label: "Comments" }),
        makeField({ selector: "#quantity", type: "number", name: "qty", label: "Quantity" }),
      ],
    });

    const results = await evaluateInputPurpose(form, mockRunner);
    expect(results).toEqual([]);
    expect(runPromptsSpy).not.toHaveBeenCalled();
  });

  it("does not return CheckResult for passing fields", async () => {
    const form = makeForm({
      fields: [
        makeField({ selector: "#email", type: "email", name: "email", label: "Email", autocomplete: "email" }),
      ],
    });

    runPromptsSpy.mockResolvedValue([
      makeEvalResult<InputPurposeEvaluation>({
        verdict: "pass",
        confidence: 0.95,
        reasoning: "Correct autocomplete value",
        wcag_criterion: "1.3.5",
        failure_type: null,
        suggestion: null,
        affected_users: [],
        requires_human_verification: false,
      }),
    ]);

    const results = await evaluateInputPurpose(form, mockRunner);
    expect(results.length).toBe(0);
  });

  it("returns needs_review for API failures", async () => {
    const form = makeForm({
      fields: [
        makeField({ selector: "#email", type: "email", name: "email", label: "Email" }),
      ],
    });

    runPromptsSpy.mockResolvedValue([
      makeEvalResult<InputPurposeEvaluation>(null as unknown as InputPurposeEvaluation, {
        success: false,
        data: null,
        error: "API error",
      }),
    ]);

    const results = await evaluateInputPurpose(form, mockRunner);
    expect(results.length).toBe(1);
    expect((results[0].raw_result as Record<string, unknown>).verdict).toBe("needs_review");
  });

  it("sends correct prompt template name", async () => {
    const form = makeForm({
      fields: [
        makeField({ selector: "#tel", type: "tel", name: "phone", label: "Phone" }),
      ],
    });

    runPromptsSpy.mockResolvedValue([
      makeEvalResult<InputPurposeEvaluation>({
        verdict: "pass",
        confidence: 0.9,
        reasoning: "OK",
        wcag_criterion: "1.3.5",
        failure_type: null,
        suggestion: null,
        affected_users: [],
        requires_human_verification: false,
      }),
    ]);

    await evaluateInputPurpose(form, mockRunner);
    const inputs = runPromptsSpy.mock.calls[0][0];
    expect(inputs[0].template.name).toBe("input_purpose_matching");
  });

  it("pre-filter skips API call for fields with valid autocomplete", async () => {
    const form = makeForm({
      fields: [
        makeField({ selector: "#email", type: "email", name: "email", label: "Email", autocomplete: "email" }),
        makeField({ selector: "#fname", type: "text", name: "fname", label: "First name", autocomplete: "given-name" }),
      ],
    });

    const results = await evaluateInputPurpose(form, mockRunner);
    expect(runPromptsSpy).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("pre-filter sends to API only fields that don't already have valid autocomplete", async () => {
    const form = makeForm({
      fields: [
        // Pre-filter passes — not sent to API
        makeField({ selector: "#email", type: "email", name: "email", label: "Email", autocomplete: "email" }),
        // Missing autocomplete — must be sent to API
        makeField({ selector: "#phone", type: "tel", name: "phone", label: "Phone" }),
      ],
    });

    runPromptsSpy.mockResolvedValue([
      makeEvalResult<InputPurposeEvaluation>({
        verdict: "fail",
        confidence: 0.9,
        reasoning: "phone field missing autocomplete",
        wcag_criterion: "1.3.5",
        failure_type: "missing_autocomplete",
        suggestion: 'Add autocomplete="tel"',
        affected_users: ["cognitive"],
        requires_human_verification: false,
      }),
    ]);

    await evaluateInputPurpose(form, mockRunner);
    expect(runPromptsSpy).toHaveBeenCalledOnce();
    const inputs = runPromptsSpy.mock.calls[0][0];
    // Only the phone field (no autocomplete) should be in the prompt inputs
    expect(inputs.length).toBe(1);
  });

  it("detects wrong_autocomplete failure", async () => {
    const form = makeForm({
      fields: [
        makeField({
          selector: "#email",
          type: "email",
          name: "email",
          label: "Email",
          autocomplete: "tel",
        }),
      ],
    });

    runPromptsSpy.mockResolvedValue([
      makeEvalResult<InputPurposeEvaluation>({
        verdict: "fail",
        confidence: 0.80,
        reasoning: "autocomplete=tel on email field",
        wcag_criterion: "1.3.5",
        failure_type: "wrong_autocomplete",
        suggestion: 'Change autocomplete to "email"',
        affected_users: ["cognitive"],
        requires_human_verification: true,
      }),
    ]);

    const results = await evaluateInputPurpose(form, mockRunner);
    expect(results.length).toBe(1);
    expect(results[0].measured_values?.failure_type).toBe("wrong_autocomplete");
    expect(results[0].measured_values?.current_autocomplete).toBe("tel");
  });
});

// ---------------------------------------------------------------------------
// inputPurposePassesPreFilter
// ---------------------------------------------------------------------------

describe("inputPurposePassesPreFilter", () => {
  it("passes email field with autocomplete=email", () => {
    expect(inputPurposePassesPreFilter(makeField({ type: "email", autocomplete: "email" }))).toBe(true);
  });

  it("passes tel field with compatible tel-* token", () => {
    expect(inputPurposePassesPreFilter(makeField({ type: "tel", autocomplete: "tel" }))).toBe(true);
    expect(inputPurposePassesPreFilter(makeField({ type: "tel", autocomplete: "tel-national" }))).toBe(true);
  });

  it("passes password field with new-password / current-password", () => {
    expect(inputPurposePassesPreFilter(makeField({ type: "password", autocomplete: "new-password" }))).toBe(true);
    expect(inputPurposePassesPreFilter(makeField({ type: "password", autocomplete: "current-password" }))).toBe(true);
  });

  it("passes text field with any valid token (e.g. given-name)", () => {
    expect(inputPurposePassesPreFilter(makeField({ type: "text", autocomplete: "given-name" }))).toBe(true);
    expect(inputPurposePassesPreFilter(makeField({ type: "text", autocomplete: "postal-code" }))).toBe(true);
  });

  it("passes multi-token autocomplete (shipping, section, etc.)", () => {
    expect(inputPurposePassesPreFilter(makeField({ type: "text", autocomplete: "shipping street-address" }))).toBe(true);
    expect(inputPurposePassesPreFilter(makeField({ type: "text", autocomplete: "section-ship billing given-name" }))).toBe(true);
  });

  it("fails when no autocomplete present", () => {
    expect(inputPurposePassesPreFilter(makeField({ type: "email", autocomplete: null }))).toBe(false);
    expect(inputPurposePassesPreFilter(makeField({ type: "text", autocomplete: "" }))).toBe(false);
  });

  it("fails when autocomplete token is incompatible with input type", () => {
    expect(inputPurposePassesPreFilter(makeField({ type: "email", autocomplete: "tel" }))).toBe(false);
    expect(inputPurposePassesPreFilter(makeField({ type: "tel", autocomplete: "email" }))).toBe(false);
    expect(inputPurposePassesPreFilter(makeField({ type: "password", autocomplete: "email" }))).toBe(false);
  });

  it("fails when autocomplete token is not in the valid list", () => {
    expect(inputPurposePassesPreFilter(makeField({ type: "text", autocomplete: "bogus-token" }))).toBe(false);
    expect(inputPurposePassesPreFilter(makeField({ type: "email", autocomplete: "emal" }))).toBe(false);
  });

  it('fails when autocomplete is "off" or "on"', () => {
    expect(inputPurposePassesPreFilter(makeField({ type: "email", autocomplete: "off" }))).toBe(false);
    expect(inputPurposePassesPreFilter(makeField({ type: "email", autocomplete: "on" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPersonalInfoField
// ---------------------------------------------------------------------------

describe("isPersonalInfoField", () => {
  it("identifies email fields", () => {
    expect(isPersonalInfoField(makeField({ type: "email" }))).toBe(true);
  });

  it("identifies tel fields", () => {
    expect(isPersonalInfoField(makeField({ type: "tel" }))).toBe(true);
  });

  it("identifies password fields", () => {
    expect(isPersonalInfoField(makeField({ type: "password" }))).toBe(true);
  });

  it("identifies url fields", () => {
    expect(isPersonalInfoField(makeField({ type: "url" }))).toBe(true);
  });

  it("identifies name fields by label", () => {
    expect(isPersonalInfoField(makeField({ label: "Full Name" }))).toBe(true);
    expect(isPersonalInfoField(makeField({ label: "First Name" }))).toBe(true);
    expect(isPersonalInfoField(makeField({ label: "Last Name" }))).toBe(true);
  });

  it("identifies address fields by label", () => {
    expect(isPersonalInfoField(makeField({ label: "Street Address" }))).toBe(true);
    expect(isPersonalInfoField(makeField({ label: "City" }))).toBe(true);
    expect(isPersonalInfoField(makeField({ label: "Zip Code" }))).toBe(true);
  });

  it("identifies fields by name attribute", () => {
    expect(isPersonalInfoField(makeField({ name: "email" }))).toBe(true);
    expect(isPersonalInfoField(makeField({ name: "phone" }))).toBe(true);
    expect(isPersonalInfoField(makeField({ name: "username" }))).toBe(true);
  });

  it("identifies fields by placeholder", () => {
    expect(isPersonalInfoField(makeField({ placeholder: "Enter your email" }))).toBe(true);
  });

  it("rejects non-personal fields", () => {
    expect(isPersonalInfoField(makeField({ type: "text", name: "comments", label: "Comments" }))).toBe(false);
    expect(isPersonalInfoField(makeField({ type: "number", name: "qty", label: "Quantity" }))).toBe(false);
    expect(isPersonalInfoField(makeField({ type: "checkbox", name: "agree", label: "I agree" }))).toBe(false);
  });

  it("identifies credit card fields", () => {
    expect(isPersonalInfoField(makeField({ label: "Credit Card Number" }))).toBe(true);
    expect(isPersonalInfoField(makeField({ name: "cc-number" }))).toBe(true);
  });

  it("identifies organization fields", () => {
    expect(isPersonalInfoField(makeField({ label: "Company" }))).toBe(true);
    expect(isPersonalInfoField(makeField({ name: "organization" }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ALL_ERROR_FAILURE_MODES
// ---------------------------------------------------------------------------

describe("ALL_ERROR_FAILURE_MODES", () => {
  it("contains exactly 8 failure modes", () => {
    expect(ALL_ERROR_FAILURE_MODES.length).toBe(8);
  });

  it("contains all expected failure modes", () => {
    const expected = [
      "error_not_identified",
      "error_no_text",
      "error_not_associated",
      "error_color_only",
      "error_not_descriptive",
      "error_not_near_field",
      "error_no_suggestion",
      "error_suggestion_unclear",
    ];
    expect([...ALL_ERROR_FAILURE_MODES]).toEqual(expected);
  });
});
