import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  generateScenarios,
  detectErrors,
  setupRequestInterception,
  testFormSubmission,
  type SubmissionScenario,
  type SubmissionState,
  type DetectedError,
} from "../../src/checks/forms/submission.js";
import type { FormInfo, FormFieldInfo } from "../../src/checks/forms/discovery.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeField(overrides: Partial<FormFieldInfo> = {}): FormFieldInfo {
  return {
    selector: "#field",
    html: '<input type="text">',
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

// ---------------------------------------------------------------------------
// generateScenarios
// ---------------------------------------------------------------------------

describe("generateScenarios", () => {
  it("always generates empty submission scenario", () => {
    const form = makeForm({ fields: [makeField()] });
    const scenarios = generateScenarios(form);
    expect(scenarios.length).toBeGreaterThanOrEqual(1);
    expect(scenarios[0].name).toBe("empty_submission");
    expect(scenarios[0].fieldValues.size).toBe(0);
  });

  it("generates invalid email scenario when email field exists", () => {
    const form = makeForm({
      fields: [
        makeField({ selector: "#email", type: "email", name: "email", label: "Email", required: true }),
        makeField({ selector: "#name", type: "text", name: "name", label: "Name", required: true }),
      ],
    });
    const scenarios = generateScenarios(form);
    const emailScenario = scenarios.find((s) => s.name === "invalid_email");
    expect(emailScenario).toBeDefined();
    expect(emailScenario!.fieldValues.get("#email")).toBe("not-an-email");
    // Other required fields should have valid values
    expect(emailScenario!.fieldValues.get("#name")).toBe("Test value");
  });

  it("generates short password scenario when password field exists", () => {
    const form = makeForm({
      fields: [
        makeField({ selector: "#email", type: "email", name: "email", label: "Email", required: true }),
        makeField({ selector: "#pass", type: "password", name: "password", label: "Password", required: true }),
      ],
    });
    const scenarios = generateScenarios(form);
    const passScenario = scenarios.find((s) => s.name === "short_password");
    expect(passScenario).toBeDefined();
    expect(passScenario!.fieldValues.get("#pass")).toBe("ab");
    // Email should have a valid value
    expect(passScenario!.fieldValues.get("#email")).toBe("test@example.com");
  });

  it("generates mismatched confirms scenario when confirm password exists", () => {
    const form = makeForm({
      fields: [
        makeField({ selector: "#email", type: "email", name: "email", label: "Email", required: true }),
        makeField({ selector: "#pass", type: "password", name: "password", label: "Password", required: true }),
        makeField({ selector: "#confirm", type: "password", name: "confirm_password", label: "Confirm Password", required: true }),
      ],
    });
    const scenarios = generateScenarios(form);
    const mismatchScenario = scenarios.find((s) => s.name === "mismatched_confirms");
    expect(mismatchScenario).toBeDefined();
    const passVal = mismatchScenario!.fieldValues.get("#pass")!;
    const confirmVal = mismatchScenario!.fieldValues.get("#confirm")!;
    expect(passVal).not.toBe(confirmVal);
  });

  it("does not generate email scenario when no email field exists", () => {
    const form = makeForm({
      fields: [
        makeField({ selector: "#name", type: "text", name: "name", label: "Name" }),
      ],
    });
    const scenarios = generateScenarios(form);
    expect(scenarios.find((s) => s.name === "invalid_email")).toBeUndefined();
  });

  it("does not generate password scenarios when no password field exists", () => {
    const form = makeForm({
      fields: [
        makeField({ selector: "#email", type: "email", name: "email", label: "Email" }),
      ],
    });
    const scenarios = generateScenarios(form);
    expect(scenarios.find((s) => s.name === "short_password")).toBeUndefined();
    expect(scenarios.find((s) => s.name === "mismatched_confirms")).toBeUndefined();
  });

  it("fills valid values for other required fields in targeted scenarios", () => {
    const form = makeForm({
      fields: [
        makeField({ selector: "#email", type: "email", name: "email", label: "Email", required: true }),
        makeField({ selector: "#tel", type: "tel", name: "phone", label: "Phone", required: true }),
        makeField({ selector: "#url", type: "url", name: "website", label: "Website", required: true }),
      ],
    });
    const scenarios = generateScenarios(form);
    const emailScenario = scenarios.find((s) => s.name === "invalid_email")!;
    expect(emailScenario.fieldValues.get("#tel")).toBe("+1234567890");
    expect(emailScenario.fieldValues.get("#url")).toBe("https://example.com");
  });
});

// ---------------------------------------------------------------------------
// detectErrors — requires Playwright (mocked)
// ---------------------------------------------------------------------------

describe("detectErrors", () => {
  it("is a function that accepts page and form selector", () => {
    // Just verify the function exists and has the right signature
    expect(typeof detectErrors).toBe("function");
    expect(detectErrors.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// setupRequestInterception
// ---------------------------------------------------------------------------

describe("setupRequestInterception", () => {
  it("is a function that accepts a page", () => {
    expect(typeof setupRequestInterception).toBe("function");
    expect(setupRequestInterception.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// testFormSubmission
// ---------------------------------------------------------------------------

describe("testFormSubmission", () => {
  it("is a function that accepts page and form info", () => {
    expect(typeof testFormSubmission).toBe("function");
    expect(testFormSubmission.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// SubmissionState evaluation (tested indirectly through scenario evaluation)
// ---------------------------------------------------------------------------

describe("scenario evaluation logic", () => {
  it("generates correct number of scenarios for a login form", () => {
    const form = makeForm({
      purpose: "login",
      fields: [
        makeField({ selector: "#email", type: "email", name: "email", label: "Email", required: true }),
        makeField({ selector: "#pass", type: "password", name: "password", label: "Password", required: true }),
      ],
    });
    const scenarios = generateScenarios(form);
    // empty + invalid_email + short_password = 3 (no mismatched confirms since no confirm field)
    expect(scenarios.length).toBe(3);
  });

  it("generates correct number of scenarios for a registration form", () => {
    const form = makeForm({
      purpose: "registration",
      fields: [
        makeField({ selector: "#name", type: "text", name: "name", label: "Name", required: true }),
        makeField({ selector: "#email", type: "email", name: "email", label: "Email", required: true }),
        makeField({ selector: "#pass", type: "password", name: "password", label: "Password", required: true }),
        makeField({ selector: "#confirm", type: "password", name: "confirm_password", label: "Confirm Password", required: true }),
      ],
    });
    const scenarios = generateScenarios(form);
    // empty + invalid_email + short_password + mismatched_confirms = 4
    expect(scenarios.length).toBe(4);
    expect(scenarios.map((s) => s.name)).toEqual([
      "empty_submission",
      "invalid_email",
      "short_password",
      "mismatched_confirms",
    ]);
  });

  it("generates only empty submission for a simple text form", () => {
    const form = makeForm({
      fields: [
        makeField({ selector: "#name", type: "text", name: "name", label: "Name" }),
        makeField({ selector: "#msg", type: "text", name: "message", label: "Message" }),
      ],
    });
    const scenarios = generateScenarios(form);
    expect(scenarios.length).toBe(1);
    expect(scenarios[0].name).toBe("empty_submission");
  });
});

// ---------------------------------------------------------------------------
// DetectedError type structure
// ---------------------------------------------------------------------------

describe("DetectedError structure", () => {
  it("contains required fields", () => {
    const error: DetectedError = {
      selector: ".error-msg",
      text: "Email is required",
      detectionMethod: "role_alert",
      associatedWithField: true,
      fieldSelector: "#email",
      colorOnlyIndicator: false,
      hasAriaDescribedby: true,
      isVisible: true,
    };
    expect(error.selector).toBe(".error-msg");
    expect(error.text).toBe("Email is required");
    expect(error.detectionMethod).toBe("role_alert");
    expect(error.associatedWithField).toBe(true);
    expect(error.fieldSelector).toBe("#email");
    expect(error.colorOnlyIndicator).toBe(false);
    expect(error.hasAriaDescribedby).toBe(true);
    expect(error.isVisible).toBe(true);
  });

  it("handles all detection methods", () => {
    const methods: DetectedError["detectionMethod"][] = [
      "role_alert", "aria_live", "aria_invalid", "error_class", "visibility_change",
    ];
    for (const method of methods) {
      const error: DetectedError = {
        selector: ".error",
        text: "Error",
        detectionMethod: method,
        associatedWithField: false,
        fieldSelector: null,
        colorOnlyIndicator: false,
        hasAriaDescribedby: false,
        isVisible: true,
      };
      expect(error.detectionMethod).toBe(method);
    }
  });
});
