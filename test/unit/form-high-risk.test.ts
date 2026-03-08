import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  classifyFormRisk,
  evaluateHighRiskForms,
  type HighRiskFormEvaluation,
  type FormRiskClassification,
  type RiskCategory,
} from "../../src/checks/forms/high-risk.js";
import type { FormInfo, FormFieldInfo } from "../../src/checks/forms/discovery.js";
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
// classifyFormRisk — Step 1 (rule-based)
// ---------------------------------------------------------------------------

describe("classifyFormRisk", () => {
  it("classifies payment form as financial", () => {
    const form = makeForm({
      html: '<form><input name="card_number"><button>Pay Now</button></form>',
      submitButtonText: "Pay Now",
      fields: [
        makeField({ name: "card_number", label: "Credit Card Number", autocomplete: "cc-number" }),
      ],
    });
    const result = classifyFormRisk(form);
    expect(result.riskCategory).toBe("financial");
    expect(result.riskSignals.length).toBeGreaterThan(0);
    expect(result.riskSignals.some((s) => s.startsWith("financial"))).toBe(true);
  });

  it("classifies subscription form as financial", () => {
    const form = makeForm({
      html: '<form><input name="billing_address"><button>Subscribe</button></form>',
      submitButtonText: "Subscribe",
      fields: [
        makeField({ name: "billing_address", label: "Billing Address" }),
      ],
    });
    const result = classifyFormRisk(form);
    expect(result.riskCategory).toBe("financial");
  });

  it("classifies terms agreement form as legal", () => {
    const form = makeForm({
      html: '<form><input type="checkbox" name="agree"><label>I agree to the terms and conditions</label><button>Accept</button></form>',
      submitButtonText: "Accept",
      fields: [
        makeField({ type: "checkbox", name: "agree", label: "I agree to the terms and conditions" }),
      ],
    });
    const result = classifyFormRisk(form);
    expect(result.riskCategory).toBe("legal");
  });

  it("classifies account deletion form as data", () => {
    const form = makeForm({
      html: '<form><p>This will permanently delete your account.</p><button>Delete Account</button></form>',
      submitButtonText: "Delete Account",
      fields: [
        makeField({ type: "password", name: "password", label: "Confirm Password" }),
      ],
    });
    const result = classifyFormRisk(form);
    expect(result.riskCategory).toBe("data");
  });

  it("classifies contact form as none (not high-risk)", () => {
    const form = makeForm({
      html: '<form><input name="name"><input name="message"><button>Send</button></form>',
      submitButtonText: "Send",
      purpose: "contact",
      fields: [
        makeField({ name: "name", label: "Name" }),
        makeField({ name: "message", label: "Message" }),
      ],
    });
    const result = classifyFormRisk(form);
    expect(result.riskCategory).toBe("none");
  });

  it("classifies search form as none", () => {
    const form = makeForm({
      html: '<form><input type="search" name="q"><button>Search</button></form>',
      submitButtonText: "Search",
      purpose: "search",
      fields: [
        makeField({ type: "search", name: "q", label: "Search" }),
      ],
    });
    const result = classifyFormRisk(form);
    expect(result.riskCategory).toBe("none");
  });

  it("detects confirmation mechanism", () => {
    const form = makeForm({
      html: '<form><p>Are you sure you want to delete?</p><button>Confirm Delete</button></form>',
      submitButtonText: "Confirm Delete",
      fields: [makeField()],
    });
    const result = classifyFormRisk(form);
    expect(result.hasConfirmation).toBe(true);
  });

  it("detects review step", () => {
    const form = makeForm({
      html: '<form><h2>Review Order</h2><div class="summary">Items: 3</div><button>Place Order</button></form>',
      submitButtonText: "Place Order",
      fields: [makeField()],
    });
    const result = classifyFormRisk(form);
    expect(result.hasReviewStep).toBe(true);
  });

  it("prioritizes financial over legal risk", () => {
    const form = makeForm({
      html: '<form>Payment terms and conditions billing agreement</form>',
      submitButtonText: "Accept and Pay",
      fields: [makeField()],
    });
    const result = classifyFormRisk(form);
    expect(result.riskCategory).toBe("financial");
    // Should have both financial and legal signals
    expect(result.riskSignals.some((s) => s.startsWith("financial"))).toBe(true);
    expect(result.riskSignals.some((s) => s.startsWith("legal"))).toBe(true);
  });

  it("includes all matching risk signals", () => {
    const form = makeForm({
      html: '<form>Purchase payment credit card billing checkout</form>',
      submitButtonText: "Buy Now",
      fields: [makeField()],
    });
    const result = classifyFormRisk(form);
    expect(result.riskSignals.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// evaluateHighRiskForms — Step 2 (Claude API)
// ---------------------------------------------------------------------------

describe("evaluateHighRiskForms", () => {
  let mockRunner: PromptRunner;
  let runPromptsSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRunner = new PromptRunner("test-key", { max_retries: 0 });
    runPromptsSpy = vi.fn().mockResolvedValue([]);
    mockRunner.runPrompts = runPromptsSpy;
  });

  it("sends only high-risk forms to Claude", async () => {
    const paymentForm = makeForm({
      selector: "#payment",
      html: '<form id="payment">Credit card payment form</form>',
      submitButtonText: "Pay",
      fields: [makeField({ name: "card", label: "Card Number" })],
    });
    const contactForm = makeForm({
      selector: "#contact",
      html: '<form id="contact">Contact us form</form>',
      submitButtonText: "Send",
      fields: [makeField({ name: "name", label: "Name" })],
    });

    runPromptsSpy.mockResolvedValue([
      makeEvalResult<HighRiskFormEvaluation>({
        verdict: "fail",
        confidence: 0.80,
        reasoning: "No confirmation step for payment",
        wcag_criterion: "3.3.4",
        failure_type: "no_confirmation_step",
        suggestion: "Add a review/confirm step before processing payment",
        affected_users: ["cognitive", "motor_impaired"],
        requires_human_verification: true,
      }),
    ]);

    const results = await evaluateHighRiskForms([paymentForm, contactForm], mockRunner);

    // Only the payment form should be sent to Claude
    expect(runPromptsSpy).toHaveBeenCalledTimes(1);
    const inputs = runPromptsSpy.mock.calls[0][0];
    expect(inputs.length).toBe(1);
    expect(results.length).toBe(1);
    expect(results[0].wcag_criterion).toBe("3.3.4");
    expect(results[0].element_selector).toBe("#payment");
  });

  it("auto-passes non-covered forms with no CheckResult", async () => {
    const contactForm = makeForm({
      html: '<form>Contact us form</form>',
      submitButtonText: "Send",
      fields: [makeField({ name: "name", label: "Name" })],
    });
    const searchForm = makeForm({
      html: '<form><input type="search" name="q"></form>',
      submitButtonText: "Search",
      fields: [makeField({ type: "search", name: "q" })],
    });

    const results = await evaluateHighRiskForms([contactForm, searchForm], mockRunner);

    // No forms should be sent to Claude
    expect(runPromptsSpy).not.toHaveBeenCalled();
    // No CheckResults produced (auto-pass = no violation)
    expect(results).toEqual([]);
  });

  it("produces CheckResult for financial form missing safeguards", async () => {
    const form = makeForm({
      html: '<form>Purchase form billing</form>',
      submitButtonText: "Buy Now",
      fields: [makeField({ name: "card", label: "Credit Card" })],
    });

    runPromptsSpy.mockResolvedValue([
      makeEvalResult<HighRiskFormEvaluation>({
        verdict: "fail",
        confidence: 0.85,
        reasoning: "Financial form lacks confirmation step",
        wcag_criterion: "3.3.4",
        failure_type: "financial_no_safeguard",
        suggestion: "Add confirmation dialog or review step",
        affected_users: ["cognitive", "motor_impaired"],
        requires_human_verification: true,
      }),
    ]);

    const results = await evaluateHighRiskForms([form], mockRunner);
    expect(results.length).toBe(1);
    expect(results[0].wcag_criterion).toBe("3.3.4");
    expect(results[0].measured_values?.failure_type).toBe("financial_no_safeguard");
    expect(results[0].measured_values?.risk_category).toBe("financial");
  });

  it("produces CheckResult for data deletion without safeguards", async () => {
    const form = makeForm({
      html: '<form>Permanently delete your account</form>',
      submitButtonText: "Delete",
      fields: [makeField({ type: "password", name: "password", label: "Password" })],
    });

    runPromptsSpy.mockResolvedValue([
      makeEvalResult<HighRiskFormEvaluation>({
        verdict: "fail",
        confidence: 0.90,
        reasoning: "Account deletion has no undo option",
        wcag_criterion: "3.3.4",
        failure_type: "data_deletion_no_safeguard",
        suggestion: "Add confirmation step and grace period",
        affected_users: ["cognitive"],
        requires_human_verification: false,
      }),
    ]);

    const results = await evaluateHighRiskForms([form], mockRunner);
    expect(results.length).toBe(1);
    expect(results[0].measured_values?.failure_type).toBe("data_deletion_no_safeguard");
    expect(results[0].measured_values?.risk_category).toBe("data");
  });

  it("does not produce CheckResult for passing high-risk form", async () => {
    const form = makeForm({
      html: '<form>Payment form with review step confirmation</form>',
      submitButtonText: "Review Order",
      fields: [makeField({ name: "card", label: "Card" })],
    });

    runPromptsSpy.mockResolvedValue([
      makeEvalResult<HighRiskFormEvaluation>({
        verdict: "pass",
        confidence: 0.90,
        reasoning: "Form has adequate review step before payment",
        wcag_criterion: "3.3.4",
        failure_type: null,
        suggestion: null,
        affected_users: [],
        requires_human_verification: false,
      }),
    ]);

    const results = await evaluateHighRiskForms([form], mockRunner);
    expect(results.length).toBe(0);
  });

  it("returns needs_review for API failures", async () => {
    const form = makeForm({
      html: '<form>Payment checkout</form>',
      submitButtonText: "Pay",
      fields: [makeField({ name: "amount", label: "Amount" })],
    });

    runPromptsSpy.mockResolvedValue([
      makeEvalResult<HighRiskFormEvaluation>(null as unknown as HighRiskFormEvaluation, {
        success: false,
        data: null,
        error: "API timeout",
      }),
    ]);

    const results = await evaluateHighRiskForms([form], mockRunner);
    expect(results.length).toBe(1);
    expect((results[0].raw_result as Record<string, unknown>).verdict).toBe("needs_review");
    expect(results[0].measured_values?.risk_category).toBe("financial");
  });

  it("sends correct prompt template name", async () => {
    const form = makeForm({
      html: '<form>Payment billing form</form>',
      submitButtonText: "Pay",
      fields: [makeField({ name: "card", label: "Card" })],
    });

    runPromptsSpy.mockResolvedValue([
      makeEvalResult<HighRiskFormEvaluation>({
        verdict: "pass",
        confidence: 0.9,
        reasoning: "OK",
        wcag_criterion: "3.3.4",
        failure_type: null,
        suggestion: null,
        affected_users: [],
        requires_human_verification: false,
      }),
    ]);

    await evaluateHighRiskForms([form], mockRunner);
    const inputs = runPromptsSpy.mock.calls[0][0];
    expect(inputs[0].template.name).toBe("high_risk_form_detection");
  });

  it("includes risk classification info in measured_values", async () => {
    const form = makeForm({
      html: '<form>Terms and conditions agreement contract</form>',
      submitButtonText: "Accept Terms",
      fields: [makeField({ type: "checkbox", name: "agree", label: "I agree" })],
    });

    runPromptsSpy.mockResolvedValue([
      makeEvalResult<HighRiskFormEvaluation>({
        verdict: "fail",
        confidence: 0.75,
        reasoning: "Legal form without review step",
        wcag_criterion: "3.3.4",
        failure_type: "legal_no_safeguard",
        suggestion: "Add review step",
        affected_users: ["cognitive"],
        requires_human_verification: true,
      }),
    ]);

    const results = await evaluateHighRiskForms([form], mockRunner);
    expect(results[0].measured_values?.risk_category).toBe("legal");
    expect(results[0].measured_values?.risk_signals).toBeDefined();
    expect(Array.isArray(results[0].measured_values?.risk_signals)).toBe(true);
  });

  it("handles multiple high-risk forms in one call", async () => {
    const form1 = makeForm({
      selector: "#payment",
      html: '<form id="payment">Payment checkout</form>',
      submitButtonText: "Pay",
      fields: [makeField({ name: "card", label: "Card" })],
    });
    const form2 = makeForm({
      selector: "#delete",
      html: '<form id="delete">Delete account permanently</form>',
      submitButtonText: "Delete",
      fields: [makeField({ type: "password", name: "password", label: "Password" })],
    });

    runPromptsSpy.mockResolvedValue([
      makeEvalResult<HighRiskFormEvaluation>({
        verdict: "fail",
        confidence: 0.80,
        reasoning: "No safeguard",
        wcag_criterion: "3.3.4",
        failure_type: "financial_no_safeguard",
        suggestion: "Add confirmation",
        affected_users: ["cognitive"],
        requires_human_verification: true,
      }),
      makeEvalResult<HighRiskFormEvaluation>({
        verdict: "fail",
        confidence: 0.90,
        reasoning: "No undo",
        wcag_criterion: "3.3.4",
        failure_type: "data_deletion_no_safeguard",
        suggestion: "Add grace period",
        affected_users: ["cognitive"],
        requires_human_verification: false,
      }),
    ]);

    const results = await evaluateHighRiskForms([form1, form2], mockRunner);
    expect(results.length).toBe(2);
    expect(results[0].element_selector).toBe("#payment");
    expect(results[1].element_selector).toBe("#delete");
  });

  it("passes risk classification through to evaluation", async () => {
    const form = makeForm({
      html: '<form>Confirm payment billing Are you sure?</form>',
      submitButtonText: "Confirm Purchase",
      fields: [makeField({ name: "amount", label: "Amount" })],
    });

    runPromptsSpy.mockResolvedValue([
      makeEvalResult<HighRiskFormEvaluation>({
        verdict: "pass",
        confidence: 0.90,
        reasoning: "Has confirmation mechanism",
        wcag_criterion: "3.3.4",
        failure_type: null,
        suggestion: null,
        affected_users: [],
        requires_human_verification: false,
      }),
    ]);

    await evaluateHighRiskForms([form], mockRunner);
    const inputs = runPromptsSpy.mock.calls[0][0];
    // The prompt should mention confirmation status
    expect(inputs[0].userMessage).toContain("Has confirmation dialog: true");
  });
});

// ---------------------------------------------------------------------------
// Two-step process integration
// ---------------------------------------------------------------------------

describe("two-step classify → evaluate", () => {
  it("Step 1 classifies, Step 2 evaluates only high-risk", () => {
    const forms = [
      makeForm({ html: '<form>Payment billing</form>', fields: [makeField()] }),
      makeForm({ html: '<form>Contact us</form>', fields: [makeField()] }),
      makeForm({ html: '<form>Delete account permanently</form>', fields: [makeField()] }),
    ];

    const classifications = forms.map(classifyFormRisk);
    const highRisk = classifications.filter((c) => c.riskCategory !== "none");
    const noRisk = classifications.filter((c) => c.riskCategory === "none");

    expect(highRisk.length).toBe(2);
    expect(noRisk.length).toBe(1);
    expect(highRisk[0].riskCategory).toBe("financial");
    expect(highRisk[1].riskCategory).toBe("data");
    expect(noRisk[0].riskCategory).toBe("none");
  });

  it("auto-pass has clear reasoning via riskSignals being empty", () => {
    const form = makeForm({
      html: '<form>Newsletter signup</form>',
      fields: [makeField({ type: "email", name: "email", label: "Email" })],
    });

    const result = classifyFormRisk(form);
    expect(result.riskCategory).toBe("none");
    expect(result.riskSignals.length).toBe(0);
  });
});
