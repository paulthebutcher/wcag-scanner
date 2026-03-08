import type { Page } from "playwright";
import type { CheckResult, PageSnapshot } from "../../types.js";
import type { FormInfo, FormFieldInfo } from "../forms/discovery.js";
import type { SubmissionState } from "../forms/submission.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Observed state change when an input value is modified */
export interface InputStateChange {
  fieldSelector: string;
  fieldLabel: string;
  fieldType: string;
  /** The value that was entered into the field */
  valueEntered: string;
  /** Type of state change observed */
  changeType: StateChangeType;
  /** Description of the change */
  description: string;
}

export type StateChangeType =
  | "navigation"
  | "dom_mutation"
  | "alert_dialog"
  | "new_elements"
  | "none";

// ---------------------------------------------------------------------------
// On-Input check: 3.2.2
// ---------------------------------------------------------------------------

/**
 * Test whether changing form inputs causes unexpected state changes.
 *
 * For each form field:
 * 1. Record DOM state before changing the input
 * 2. Enter a value / change the input
 * 3. Move focus away (blur)
 * 4. Check for unexpected state changes (navigation, alert dialogs,
 *    significant DOM mutations, newly visible elements)
 *
 * Auto-passes inputs with no side effects.
 * Flags state changes for human review.
 */
export async function checkOnInput(
  page: Page,
  form: FormInfo,
): Promise<{ results: CheckResult[]; stateChanges: InputStateChange[] }> {
  const results: CheckResult[] = [];
  const stateChanges: InputStateChange[] = [];
  const originalUrl = page.url();

  for (const field of form.fields) {
    // Skip hidden, submit, button, and image inputs
    if (["hidden", "submit", "button", "image", "reset"].includes(field.type)) {
      continue;
    }

    try {
      const change = await testSingleInput(page, field, originalUrl);
      stateChanges.push(change);

      if (change.changeType !== "none") {
        results.push({
          element_selector: field.selector,
          element_html: field.html,
          wcag_criterion: "3.2.2",
          detected_by: "playwright",
          raw_result: {
            verdict: "needs_review",
            changeType: change.changeType,
            description: change.description,
            reasoning:
              "Changing this input caused an unexpected state change. " +
              "WCAG 3.2.2 requires that changing the setting of a UI component " +
              "does not automatically cause a change of context unless the user " +
              "has been advised in advance.",
          },
          measured_values: {
            field_selector: field.selector,
            field_type: field.type,
            field_label: field.label,
            change_type: change.changeType,
            value_entered: change.valueEntered,
            failure_type: `on_input_${change.changeType}`,
          },
        });
      }

      // Navigate back if the page changed
      if (page.url() !== originalUrl) {
        await page.goto(originalUrl, { waitUntil: "load", timeout: 10_000 });
        await page.waitForTimeout(300);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[on-input] Failed testing field ${field.selector}: ${msg}`);
    }
  }

  return { results, stateChanges };
}

/**
 * Test a single input field for unexpected state changes.
 */
async function testSingleInput(
  page: Page,
  field: FormFieldInfo,
  originalUrl: string,
): Promise<InputStateChange> {
  const baseChange: Omit<InputStateChange, "changeType" | "description"> = {
    fieldSelector: field.selector,
    fieldLabel: field.label,
    fieldType: field.type,
    valueEntered: getTestValue(field),
  };

  // Record DOM state before
  const elementCountBefore = await page.evaluate(() => document.body.querySelectorAll("*").length);

  // Set up dialog listener for alert/confirm/prompt
  let dialogFired = false;
  const dialogHandler = () => { dialogFired = true; };
  page.on("dialog", dialogHandler);

  try {
    const element = await page.$(field.selector);
    if (!element) {
      return { ...baseChange, changeType: "none", description: "Element not found" };
    }

    // Change the input value
    if (field.type === "checkbox" || field.type === "radio") {
      await element.click();
    } else if (field.tagName === "select") {
      // Try to select second option if available
      const options = await element.evaluate((el) => {
        const select = el as HTMLSelectElement;
        return Array.from(select.options).map((o) => o.value);
      });
      if (options.length > 1) {
        await element.selectOption(options[1]);
      }
    } else {
      await element.fill(baseChange.valueEntered);
    }

    // Blur the field to trigger change/blur events
    await element.evaluate((el) => (el as HTMLElement).blur());
    await page.waitForTimeout(500);

    // Check for navigation
    if (page.url() !== originalUrl) {
      return {
        ...baseChange,
        changeType: "navigation",
        description: `Page navigated to ${page.url()} after input change`,
      };
    }

    // Check for dialogs
    if (dialogFired) {
      return {
        ...baseChange,
        changeType: "alert_dialog",
        description: "Alert/confirm/prompt dialog appeared after input change",
      };
    }

    // Check for significant DOM mutations
    const elementCountAfter = await page.evaluate(() => document.body.querySelectorAll("*").length);
    const elementDiff = Math.abs(elementCountAfter - elementCountBefore);

    // Threshold: more than 5 new elements is suspicious
    if (elementDiff > 5) {
      return {
        ...baseChange,
        changeType: "dom_mutation",
        description: `Significant DOM change detected: ${elementDiff} elements added/removed`,
      };
    }

    return { ...baseChange, changeType: "none", description: "No unexpected changes" };
  } finally {
    page.off("dialog", dialogHandler);
  }
}

/**
 * Get a test value appropriate for a field type.
 */
function getTestValue(field: FormFieldInfo): string {
  switch (field.type) {
    case "email": return "test@example.com";
    case "tel": return "+1234567890";
    case "url": return "https://example.com";
    case "number": return "42";
    case "date": return "2024-01-15";
    case "password": return "TestPass123!";
    case "color": return "#ff0000";
    case "range": return "50";
    case "checkbox": return "checked";
    case "radio": return "selected";
    default: return "Test input value";
  }
}

// ---------------------------------------------------------------------------
// Error quality surfacing: 3.3.1 / 3.3.3
// ---------------------------------------------------------------------------

/**
 * Surface findings where error messages may not be semantically helpful.
 *
 * Scans SubmissionState results from Tier 4 form testing and flags:
 * - Error messages that are too short to be descriptive
 * - Error messages that are generic ("Error", "Invalid", "Required")
 * - Missing error suggestions (3.3.3)
 *
 * All flagged as needs_review for human judgment.
 */
export function surfaceErrorQualityFindings(
  states: SubmissionState[],
): CheckResult[] {
  const results: CheckResult[] = [];

  for (const state of states) {
    for (const error of state.errorMessages) {
      const issues = evaluateErrorQuality(error.text);
      if (issues.length === 0) continue;

      results.push({
        element_selector: error.selector,
        element_html: `<error>${truncate(error.text, 200)}</error>`,
        wcag_criterion: issues.some((i) => i === "no_suggestion") ? "3.3.3" : "3.3.1",
        detected_by: "playwright",
        raw_result: {
          verdict: "needs_review",
          error_text: error.text,
          quality_issues: issues,
          reasoning:
            "Error message may not be semantically helpful. " +
            "Human review needed to determine if the message adequately " +
            "identifies the error and suggests how to fix it.",
          scenario: state.scenario.name,
        },
        measured_values: {
          error_text: error.text,
          quality_issues: issues,
          scenario: state.scenario.name,
          field_selector: error.fieldSelector,
          failure_type: `error_quality_${issues[0]}`,
        },
      });
    }
  }

  return results;
}

/** Generic error patterns that are too vague to be helpful */
const GENERIC_PATTERNS = [
  /^error\.?$/i,
  /^invalid\.?$/i,
  /^required\.?$/i,
  /^this field is required\.?$/i,
  /^please fill (in|out) this field\.?$/i,
  /^invalid (input|value|entry)\.?$/i,
  /^error occurred\.?$/i,
  /^something went wrong\.?$/i,
];

/**
 * Evaluate the quality of an error message.
 * Returns a list of quality issues found.
 */
export function evaluateErrorQuality(errorText: string): string[] {
  const issues: string[] = [];
  const trimmed = errorText.trim();

  // Too short to be descriptive (< 5 chars after trimming)
  if (trimmed.length > 0 && trimmed.length < 5) {
    issues.push("too_short");
  }

  // Generic/unhelpful message
  if (GENERIC_PATTERNS.some((p) => p.test(trimmed))) {
    issues.push("too_generic");
  }

  // No suggestion on how to fix (3.3.3 indicator)
  // Simple heuristic: if message doesn't contain actionable language
  const hasActionableLanguage =
    /\b(should|must|need|try|use|enter|provide|include|make sure|at least|between|format|example)\b/i.test(trimmed);
  if (!hasActionableLanguage && trimmed.length > 0) {
    issues.push("no_suggestion");
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(str: string, max: number): string {
  return str.length <= max ? str : str.slice(0, max) + "...";
}
