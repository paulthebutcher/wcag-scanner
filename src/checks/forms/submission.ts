import type { Page, Request as PlaywrightRequest, Route } from "playwright";
import type { CheckResult } from "../../types.js";
import type { FormInfo, FormFieldInfo } from "./discovery.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A test scenario describing how to fill a form before submitting */
export interface SubmissionScenario {
  /** Human-readable name for the scenario */
  name: string;
  /** Values to fill in each field (by field selector) */
  fieldValues: Map<string, string>;
  /** Description of what this scenario tests */
  description: string;
}

/** State captured before and after a form submission */
export interface SubmissionState {
  /** Which scenario was run */
  scenario: SubmissionScenario;
  /** DOM snapshot before submission */
  domBefore: string;
  /** DOM snapshot after submission */
  domAfter: string;
  /** Screenshot after submission (base64) */
  screenshotAfter: string;
  /** Error messages detected after submission */
  errorMessages: DetectedError[];
  /** Whether a page navigation occurred */
  navigated: boolean;
  /** Form info for the form tested */
  formInfo: FormInfo;
}

/** An error message detected on the page after form submission */
export interface DetectedError {
  /** CSS selector for the error element */
  selector: string;
  /** Text content of the error message */
  text: string;
  /** How the error was identified */
  detectionMethod: "role_alert" | "aria_live" | "aria_invalid" | "error_class" | "visibility_change";
  /** Whether the error is programmatically associated with a field */
  associatedWithField: boolean;
  /** Selector of the associated field (if any) */
  fieldSelector: string | null;
  /** Whether this appears to use only color to indicate error */
  colorOnlyIndicator: boolean;
  /** aria-describedby association present */
  hasAriaDescribedby: boolean;
  /** Whether the error element is visible */
  isVisible: boolean;
}

// ---------------------------------------------------------------------------
// Submission scenario generation
// ---------------------------------------------------------------------------

/**
 * Generate test scenarios for a form based on its fields.
 *
 * Produces:
 * 1. Empty submission (all fields blank)
 * 2. Invalid email (if email field exists)
 * 3. Short password (if password field exists)
 * 4. Mismatched confirms (if confirm password exists)
 */
export function generateScenarios(form: FormInfo): SubmissionScenario[] {
  const scenarios: SubmissionScenario[] = [];

  // 1. Empty submission — submit with no field values
  scenarios.push({
    name: "empty_submission",
    fieldValues: new Map(),
    description: "Submit form with all fields empty to trigger required field validation",
  });

  // 2. Invalid email — fill email fields with invalid value
  const emailFields = form.fields.filter((f) => f.type === "email");
  if (emailFields.length > 0) {
    const values = new Map<string, string>();
    for (const field of emailFields) {
      values.set(field.selector, "not-an-email");
    }
    // Fill other required fields with valid data so we isolate the email error
    for (const field of form.fields) {
      if (field.type !== "email" && field.required) {
        values.set(field.selector, getValidValueForType(field));
      }
    }
    scenarios.push({
      name: "invalid_email",
      fieldValues: values,
      description: "Submit form with invalid email to test email validation error messages",
    });
  }

  // 3. Short password — fill password field with too-short value
  const passwordFields = form.fields.filter((f) => f.type === "password");
  if (passwordFields.length > 0) {
    const values = new Map<string, string>();
    for (const field of passwordFields) {
      values.set(field.selector, "ab"); // Too short for most validation
    }
    for (const field of form.fields) {
      if (field.type !== "password" && field.required) {
        values.set(field.selector, getValidValueForType(field));
      }
    }
    scenarios.push({
      name: "short_password",
      fieldValues: values,
      description: "Submit form with short password to test password validation error messages",
    });
  }

  // 4. Mismatched confirms — fill password and confirm with different values
  const confirmField = form.fields.find((f) =>
    f.type === "password" && (
      /confirm/i.test(f.name ?? "") ||
      /confirm/i.test(f.label) ||
      /re.?enter/i.test(f.label) ||
      /repeat/i.test(f.label)
    ),
  );
  const mainPassword = passwordFields.find((f) => f !== confirmField);
  if (confirmField && mainPassword) {
    const values = new Map<string, string>();
    values.set(mainPassword.selector, "ValidPass123!");
    values.set(confirmField.selector, "DifferentPass456!");
    for (const field of form.fields) {
      if (field.type !== "password" && field.required) {
        values.set(field.selector, getValidValueForType(field));
      }
    }
    scenarios.push({
      name: "mismatched_confirms",
      fieldValues: values,
      description: "Submit form with mismatched password fields to test confirmation validation",
    });
  }

  return scenarios;
}

/** Return a plausible valid value for a field type */
function getValidValueForType(field: FormFieldInfo): string {
  switch (field.type) {
    case "email": return "test@example.com";
    case "tel": return "+1234567890";
    case "url": return "https://example.com";
    case "number": return "42";
    case "date": return "2024-01-15";
    case "password": return "SecurePass123!";
    default: return "Test value";
  }
}

// ---------------------------------------------------------------------------
// Form filling and submission
// ---------------------------------------------------------------------------

/**
 * Fill form fields according to a scenario's field values.
 */
async function fillForm(
  page: Page,
  form: FormInfo,
  scenario: SubmissionScenario,
): Promise<void> {
  for (const field of form.fields) {
    const value = scenario.fieldValues.get(field.selector);
    if (value === undefined) continue;

    try {
      const element = await page.$(field.selector);
      // Hidden fields would otherwise block for the full action timeout
      if (!element || !(await element.isVisible())) continue;

      if (field.tagName === "select") {
        await element.selectOption(value);
      } else {
        await element.fill(value);
      }
    } catch {
      // Field might not be interactable — continue with other fields
    }
  }
}

/**
 * Count the form's user-fillable fields that are visible on the live page.
 *
 * Forms rendered hidden at load (inside a closed modal, a collapsed panel, or
 * a third-party embed that hasn't opened) can't be exercised by the
 * submission or on-input tests; callers use this to skip them and report
 * those criteria as not tested rather than passed.
 */
export async function countVisibleFields(page: Page, form: FormInfo): Promise<number> {
  let visible = 0;
  for (const field of form.fields) {
    if (["hidden", "submit", "button", "image", "reset"].includes(field.type)) continue;
    try {
      const element = await page.$(field.selector);
      if (element && (await element.isVisible())) visible++;
    } catch {
      // Invalid selector on the live DOM — treat as not visible
    }
  }
  return visible;
}

/**
 * Submit a form by clicking its submit button or calling form.submit().
 */
async function submitForm(
  page: Page,
  form: FormInfo,
): Promise<boolean> {
  let navigated = false;

  // Set up navigation detection
  const navPromise = page.waitForNavigation({ timeout: 3000 }).then(() => {
    navigated = true;
  }).catch(() => {
    // No navigation — form likely uses client-side validation
  });

  try {
    if (form.submitButtonSelector) {
      await page.click(form.submitButtonSelector, { timeout: 3000 });
    } else if (!form.isDivBased) {
      // Use JavaScript to submit the form
      await page.evaluate((selector) => {
        const form = document.querySelector(selector) as HTMLFormElement | null;
        form?.requestSubmit();
      }, form.selector);
    }
  } catch {
    // Click might fail — form still may have submitted via JS
  }

  // Wait briefly for async validation / DOM updates
  await navPromise;
  await page.waitForTimeout(500);

  return navigated;
}

// ---------------------------------------------------------------------------
// Error detection
// ---------------------------------------------------------------------------

/**
 * Detect error messages on the page after form submission.
 * Checks:
 * - role="alert" elements
 * - aria-live regions with content
 * - aria-invalid="true" fields
 * - Elements with error-related CSS classes
 * - Newly visible elements (comparing before/after)
 */
export async function detectErrors(page: Page, formSelector: string): Promise<DetectedError[]> {
  return page.evaluate((selector) => {
    const errors: DetectedError[] = [];
    const formEl = document.querySelector(selector);
    const searchRoot = formEl ?? document.body;

    // Helper: check if element is visible
    function isElementVisible(el: Element): boolean {
      const style = window.getComputedStyle(el);
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0" &&
        el.getBoundingClientRect().height > 0;
    }

    // Helper: get a unique selector for an element
    function getSelector(el: Element): string {
      if (el.id) return `#${el.id}`;
      const classes = Array.from(el.classList).join(".");
      if (classes) return `${el.tagName.toLowerCase()}.${classes}`;
      return el.tagName.toLowerCase();
    }

    // Helper: check if error is associated with a field
    function findAssociatedField(el: Element): { associated: boolean; fieldSelector: string | null; hasAriaDescribedby: boolean } {
      const elId = el.id;
      if (!elId) return { associated: false, fieldSelector: null, hasAriaDescribedby: false };

      // Check if any field has aria-describedby pointing to this error
      const field = searchRoot.querySelector(`[aria-describedby~="${elId}"]`) ??
        searchRoot.querySelector(`[aria-errormessage="${elId}"]`);

      if (field) {
        return {
          associated: true,
          fieldSelector: getSelector(field),
          hasAriaDescribedby: field.hasAttribute("aria-describedby"),
        };
      }

      return { associated: false, fieldSelector: null, hasAriaDescribedby: false };
    }

    // Helper: check for color-only indicators
    function isColorOnly(el: Element): boolean {
      const text = el.textContent?.trim() ?? "";
      if (text.length === 0) return true; // No text = color only
      const style = window.getComputedStyle(el);
      // If the only indicator is a color change (red text, red border) with no icon or text
      return text.length === 0 && (
        style.color.includes("rgb(2") || // Reddish
        style.borderColor.includes("rgb(2")
      );
    }

    // 1. role="alert" elements
    searchRoot.querySelectorAll('[role="alert"]').forEach((el) => {
      const text = el.textContent?.trim() ?? "";
      if (!text) return;
      const assoc = findAssociatedField(el);
      errors.push({
        selector: getSelector(el),
        text,
        detectionMethod: "role_alert",
        associatedWithField: assoc.associated,
        fieldSelector: assoc.fieldSelector,
        colorOnlyIndicator: isColorOnly(el),
        hasAriaDescribedby: assoc.hasAriaDescribedby,
        isVisible: isElementVisible(el),
      });
    });

    // 2. aria-live regions
    searchRoot.querySelectorAll('[aria-live="polite"], [aria-live="assertive"]').forEach((el) => {
      // Skip if already captured as role="alert"
      if (el.getAttribute("role") === "alert") return;
      const text = el.textContent?.trim() ?? "";
      if (!text) return;
      const assoc = findAssociatedField(el);
      errors.push({
        selector: getSelector(el),
        text,
        detectionMethod: "aria_live",
        associatedWithField: assoc.associated,
        fieldSelector: assoc.fieldSelector,
        colorOnlyIndicator: isColorOnly(el),
        hasAriaDescribedby: assoc.hasAriaDescribedby,
        isVisible: isElementVisible(el),
      });
    });

    // 3. aria-invalid="true" fields
    searchRoot.querySelectorAll('[aria-invalid="true"]').forEach((el) => {
      const fieldSelector = getSelector(el);
      // Look for associated error message via aria-describedby or aria-errormessage
      const describedbyIds = el.getAttribute("aria-describedby")?.split(/\s+/) ?? [];
      const errormsgId = el.getAttribute("aria-errormessage");
      const allIds = [...describedbyIds, ...(errormsgId ? [errormsgId] : [])];

      let errorText = "";
      let errorSelector: string | null = null;
      for (const id of allIds) {
        const target = document.getElementById(id);
        if (target) {
          errorText = target.textContent?.trim() ?? "";
          errorSelector = getSelector(target);
          break;
        }
      }

      errors.push({
        selector: errorSelector ?? fieldSelector,
        text: errorText || `Field ${fieldSelector} marked invalid`,
        detectionMethod: "aria_invalid",
        associatedWithField: true,
        fieldSelector,
        colorOnlyIndicator: !errorText,
        hasAriaDescribedby: describedbyIds.length > 0,
        isVisible: true,
      });
    });

    // 4. Elements with error-related classes
    const errorClassPatterns = [
      ".error", ".error-message", ".field-error", ".form-error",
      ".invalid", ".validation-error", ".has-error",
      ".w-form-fail", // Webflow
      "[data-error]",
    ];
    for (const pattern of errorClassPatterns) {
      searchRoot.querySelectorAll(pattern).forEach((el) => {
        // Skip if already captured
        const sel = getSelector(el);
        if (errors.some((e) => e.selector === sel)) return;

        const text = el.textContent?.trim() ?? "";
        if (!text && !isElementVisible(el)) return;

        const assoc = findAssociatedField(el);
        errors.push({
          selector: sel,
          text: text || "(empty error element)",
          detectionMethod: "error_class",
          associatedWithField: assoc.associated,
          fieldSelector: assoc.fieldSelector,
          colorOnlyIndicator: isColorOnly(el),
          hasAriaDescribedby: assoc.hasAriaDescribedby,
          isVisible: isElementVisible(el),
        });
      });
    }

    return errors;
  }, formSelector);
}

// ---------------------------------------------------------------------------
// Request interception
// ---------------------------------------------------------------------------

/**
 * Set up request interception to block actual form submissions.
 * Returns an abort handler and a list of intercepted requests.
 */
export async function setupRequestInterception(
  page: Page,
): Promise<{ interceptedRequests: Array<{ url: string; method: string; postData: string | null }>; cleanup: () => Promise<void> }> {
  const interceptedRequests: Array<{ url: string; method: string; postData: string | null }> = [];

  const handler = async (route: Route) => {
    const request = route.request();
    const method = request.method();
    const resourceType = request.resourceType();

    // Block form submissions (POST requests from forms or navigation from GET forms)
    if (
      (method === "POST" && resourceType === "document") ||
      (method === "POST" && resourceType === "fetch") ||
      (method === "POST" && resourceType === "xhr")
    ) {
      interceptedRequests.push({
        url: request.url(),
        method,
        postData: request.postData(),
      });
      await route.abort("blockedbyclient");
    } else {
      await route.continue();
    }
  };

  await page.route("**/*", handler);

  return {
    interceptedRequests,
    cleanup: async () => {
      await page.unroute("**/*", handler);
    },
  };
}

// ---------------------------------------------------------------------------
// Main submission testing function
// ---------------------------------------------------------------------------

/**
 * Test form submission for a single form.
 *
 * 1. Generates scenarios (empty, invalid email, short password, mismatched confirms)
 * 2. For each scenario:
 *    - Captures DOM before submission
 *    - Fills form fields per scenario
 *    - Submits form (with request interception to block actual submissions)
 *    - Captures DOM after submission + screenshot
 *    - Detects error messages
 * 3. Returns CheckResult[] for any accessibility issues found in error handling.
 */
export async function testFormSubmission(
  page: Page,
  form: FormInfo,
): Promise<{ states: SubmissionState[]; results: CheckResult[] }> {
  const scenarios = generateScenarios(form);
  const states: SubmissionState[] = [];
  const results: CheckResult[] = [];
  const pageUrl = page.url();

  for (const scenario of scenarios) {
    try {
      // Navigate back to original page if navigated away
      if (page.url() !== pageUrl) {
        await page.goto(pageUrl, { waitUntil: "load", timeout: 10_000 });
      }

      // Set up request interception
      const { interceptedRequests, cleanup } = await setupRequestInterception(page);

      try {
        // Capture DOM before
        const domBefore = await page.content();

        // Fill form fields
        await fillForm(page, form, scenario);

        // Submit form
        const navigated = await submitForm(page, form);

        // Wait for DOM updates
        await page.waitForTimeout(300);

        // Capture DOM after
        const domAfter = await page.content();

        // Take screenshot
        const screenshotBuffer = await page.screenshot();
        const screenshotAfter = screenshotBuffer.toString("base64");

        // Detect errors
        const errorMessages = await detectErrors(page, form.selector);

        const state: SubmissionState = {
          scenario,
          domBefore,
          domAfter,
          screenshotAfter,
          errorMessages,
          navigated,
          formInfo: form,
        };
        states.push(state);

        // Generate CheckResults for detected accessibility issues
        const checkResults = evaluateSubmissionState(state);
        results.push(...checkResults);
      } finally {
        await cleanup();
      }
    } catch (err) {
      // Log but don't crash — continue to next scenario
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[form-submission] Scenario "${scenario.name}" failed for ${form.selector}: ${msg}`);
    }
  }

  return { states, results };
}

// ---------------------------------------------------------------------------
// Submission state evaluation (rule-based)
// ---------------------------------------------------------------------------

/**
 * Evaluate a submission state for accessibility issues.
 * Produces CheckResult[] for:
 * - Missing error identification (3.3.1)
 * - Errors not programmatically associated (3.3.1)
 * - Color-only error indication (1.4.1)
 * - Missing aria-describedby (3.3.1)
 */
function evaluateSubmissionState(state: SubmissionState): CheckResult[] {
  const results: CheckResult[] = [];
  const { scenario, errorMessages, formInfo } = state;

  // Only check non-empty scenarios for error detection
  // Empty submission is expected to have errors on required fields
  if (scenario.name === "empty_submission") {
    // Check: required fields should produce errors
    const requiredFields = formInfo.fields.filter((f) => f.required);
    if (requiredFields.length > 0 && errorMessages.length === 0) {
      results.push({
        element_selector: formInfo.selector,
        element_html: truncate(formInfo.html, 500),
        wcag_criterion: "3.3.1",
        detected_by: "playwright",
        raw_result: {
          scenario: scenario.name,
          issue: "no_errors_on_required_fields",
          required_field_count: requiredFields.length,
          error_count: 0,
        },
        measured_values: {
          scenario: scenario.name,
          required_fields: requiredFields.length,
          errors_detected: 0,
          failure_type: "error_not_identified",
        },
      });
    }
  }

  // Check each error for accessibility issues
  for (const error of errorMessages) {
    // Check: error not programmatically associated with field
    if (!error.associatedWithField && error.detectionMethod !== "aria_invalid") {
      results.push({
        element_selector: error.selector,
        element_html: `<error>${error.text}</error>`,
        wcag_criterion: "3.3.1",
        detected_by: "playwright",
        raw_result: {
          scenario: scenario.name,
          issue: "error_not_associated",
          error_text: error.text,
          error_selector: error.selector,
        },
        measured_values: {
          scenario: scenario.name,
          error_text: error.text,
          associated: false,
          failure_type: "error_not_associated",
        },
      });
    }

    // Check: color-only error indication
    if (error.colorOnlyIndicator) {
      results.push({
        element_selector: error.selector,
        element_html: `<error>${error.text}</error>`,
        wcag_criterion: "1.4.1",
        detected_by: "playwright",
        raw_result: {
          scenario: scenario.name,
          issue: "color_only_indicator",
          error_text: error.text,
        },
        measured_values: {
          scenario: scenario.name,
          error_text: error.text,
          color_only: true,
          failure_type: "error_color_only",
        },
      });
    }

    // Check: error not visible
    if (!error.isVisible) {
      results.push({
        element_selector: error.selector,
        element_html: `<error>${error.text}</error>`,
        wcag_criterion: "3.3.1",
        detected_by: "playwright",
        raw_result: {
          scenario: scenario.name,
          issue: "error_not_visible",
          error_text: error.text,
        },
        measured_values: {
          scenario: scenario.name,
          error_text: error.text,
          visible: false,
          failure_type: "error_not_identified",
        },
      });
    }
  }

  return results;
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen) + "...";
}
