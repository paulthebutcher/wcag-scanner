import type { CheckResult } from "../../types.js";
import type { PromptRunner } from "../../core/prompt-runner.js";
import {
  headingStructure,
  buildHeadingStructureUserPrompt,
} from "../../prompts/element-evaluation.js";
import { buildLlmCapture } from "./llm-capture.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A heading extracted from the page DOM */
export interface HeadingInfo {
  /** Heading level (1-6) */
  level: number;
  /** Text content of the heading */
  text: string;
  /** Outer HTML of the heading element */
  html: string;
  /** CSS selector for the heading */
  selector: string;
}

/** Result from Claude's evaluation of heading structure */
export interface HeadingEvaluation {
  verdict: "pass" | "fail" | "needs_review";
  confidence: number;
  reasoning: string;
  wcag_criterion: string;
  failure_type: string | null;
  suggestion: string | null;
  affected_users: string[];
  requires_human_verification: boolean;
  /** Text of the heading that shows the failure */
  failing_heading?: string | null;
  /** Best-practice problems that are not WCAG failures */
  best_practice_issues?: string[];
}

/**
 * Heading problems that fail WCAG, most serious first, with the criterion
 * each one fails. Anything else the model reports (skipped levels,
 * multiple h1, long headings, no headings) is best practice only.
 */
const WCAG_HEADING_FAILURES: Array<[string, string]> = [
  ["empty_heading", "2.4.6"],
  ["style_not_structure", "1.3.1"],
  ["non_descriptive", "2.4.6"],
  ["heading_too_generic", "2.4.6"],
];

/** Split a model failure_type ("a, b") into normalized type names. */
function parseFailureTypes(failureType: string | null | undefined): string[] {
  if (!failureType) return [];
  return failureType.split(/[,;\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
}

/** All 6 heading failure modes from the prompt library */
export const HEADING_FAILURE_TYPES = [
  "skipped_level",
  "multiple_h1",
  "style_not_structure",
  "empty_heading",
  "heading_too_long",
  "missing_heading",
  // Additional modes from acceptance criteria
  "non_descriptive",
  "heading_too_generic",
] as const;

export type HeadingFailureType = (typeof HEADING_FAILURE_TYPES)[number];

// ---------------------------------------------------------------------------
// Heading extraction from DOM
// ---------------------------------------------------------------------------

/**
 * Extract all headings from a page DOM in document order.
 * Works on serialized HTML without requiring a live browser.
 */
export function extractHeadings(dom: string): HeadingInfo[] {
  const headings: HeadingInfo[] = [];
  // Match <h1>...</h1> through <h6>...</h6>
  const headingRegex = /<(h[1-6])\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;

  while ((match = headingRegex.exec(dom)) !== null) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    const innerContent = match[3];
    const level = parseInt(tag[1], 10);
    const text = stripTags(innerContent).trim();
    const selector = buildHeadingSelector(tag, attrs, headings.length);

    headings.push({
      level,
      text,
      html: match[0],
      selector,
    });
  }

  return headings;
}

// ---------------------------------------------------------------------------
// Corroborating evidence from axe-core
// ---------------------------------------------------------------------------

/**
 * Check if axe-core already flagged heading hierarchy violations.
 * Returns the set of axe-detected heading issue types.
 */
export function getAxeHeadingCorroboration(
  axeResults: CheckResult[],
): Set<string> {
  const corroborating = new Set<string>();

  for (const result of axeResults) {
    // axe-core heading-order rule catches skipped levels
    if (result.wcag_criterion === "1.3.1" || result.wcag_criterion === "2.4.6") {
      const rawResult = result.raw_result as Record<string, unknown> | undefined;
      if (rawResult?.id === "heading-order" || rawResult?.ruleId === "heading-order") {
        corroborating.add("skipped_level");
      }
      if (rawResult?.id === "empty-heading" || rawResult?.ruleId === "empty-heading") {
        corroborating.add("empty_heading");
      }
    }
  }

  return corroborating;
}

// ---------------------------------------------------------------------------
// Main check function
// ---------------------------------------------------------------------------

/**
 * Run heading structure check on a page.
 *
 * 1. Extracts all headings from the page DOM in document order.
 * 2. Calls Prompt 3 (heading_structure) once per page.
 * 3. Returns at most ONE CheckResult per page, for the most serious WCAG
 *    failure (2.4.6 or 1.3.1). Best-practice problems are recorded in
 *    measured_values only.
 * 4. Notes heading hierarchy violations already caught by axe-core.
 */
export async function runHeadingChecks(
  dom: string,
  pageTitle: string,
  runner: PromptRunner,
  options: {
    axeResults?: CheckResult[];
  } = {},
): Promise<CheckResult[]> {
  const { axeResults = [] } = options;

  // 1. Extract all headings
  const headings = extractHeadings(dom);

  if (headings.length === 0) {
    // No headings on page — this could be a "missing_heading" failure
    // but we still need Claude to evaluate the page context
    // For a page with no headings at all, send the page title to Claude
  }

  // 2. Get axe-core corroboration
  const axeCorroboration = getAxeHeadingCorroboration(axeResults);

  // 3. Call Prompt 3 once per page
  const userMessage = buildHeadingStructureUserPrompt({
    headings: headings.map((h) => ({ level: h.level, text: h.text })),
    pageTitle,
  });

  const promptInput = {
    template: headingStructure,
    userMessage,
  };
  const evalResult = await runner.runPrompt<HeadingEvaluation>(promptInput);
  const capture = buildLlmCapture(promptInput, evalResult);

  // 4. Process result
  if (!evalResult.success && !evalResult.data) {
    return [{
      element_selector: headings[0]?.selector ?? "body",
      element_html: headings[0]?.html ?? "<body>",
      wcag_criterion: "2.4.6",
      detected_by: "claude_api",
      raw_result: {
        verdict: "needs_review",
        confidence: 0,
        reasoning: `API evaluation failed: ${evalResult.error}`,
        wcag_criterion: "2.4.6",
        failure_type: null,
        suggestion: null,
        affected_users: ["screen_reader", "cognitive"],
        requires_human_verification: true,
      },
      measured_values: {
        heading_count: headings.length,
        heading_levels: headings.map((h) => h.level),
        axe_corroboration: Array.from(axeCorroboration),
      },
      llm_input: capture.llm_input,
      llm_output: capture.llm_output,
    }];
  }

  const evaluation = evalResult.data!;

  // If pass, return empty
  if (evaluation.verdict === "pass") {
    return [];
  }

  // 5. Keep only WCAG failures, choosing the most serious one in code so
  // the same page produces the same finding type from run to run.
  const reported = parseFailureTypes(evaluation.failure_type);
  const primary = WCAG_HEADING_FAILURES.find(([type]) => reported.includes(type));
  const bestPractice = Array.from(new Set([
    ...reported.filter((t) => !WCAG_HEADING_FAILURES.some(([type]) => type === t)),
    ...(evaluation.best_practice_issues ?? []).map((t) => t.trim().toLowerCase()),
  ])).sort();

  // A fail made only of best-practice problems is not a WCAG failure. A
  // needs_review with no failure type is genuine uncertainty and is kept.
  if (!primary && (evaluation.verdict === "fail" || reported.length > 0)) {
    return [];
  }

  const [failureType, criterion] = primary ?? [null, "2.4.6"];
  const failureHeading = findHeadingByText(headings, evaluation.failing_heading)
    ?? findFailureHeading(headings, failureType);

  return [{
    element_selector: failureHeading?.selector ?? "body",
    element_html: failureHeading?.html ?? "<body>",
    wcag_criterion: criterion,
    detected_by: "claude_api",
    raw_result: { ...evaluation, failure_type: failureType, wcag_criterion: criterion },
    measured_values: {
      heading_count: headings.length,
      heading_levels: headings.map((h) => h.level),
      failure_type: failureType,
      confidence: evaluation.confidence,
      best_practice_issues: bestPractice,
      axe_corroboration: Array.from(axeCorroboration),
    },
    llm_input: capture.llm_input,
    llm_output: capture.llm_output,
  }];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the heading whose text matches what the model named. */
function findHeadingByText(
  headings: HeadingInfo[],
  text: string | null | undefined,
): HeadingInfo | undefined {
  if (text === null || text === undefined) return undefined;
  const wanted = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (wanted === "") return headings.find((h) => h.text.trim() === "");
  return headings.find((h) => h.text.trim().toLowerCase() === wanted)
    ?? headings.find((h) => h.text.trim().toLowerCase().startsWith(wanted.slice(0, 40)));
}

/**
 * Find the most relevant heading for a given failure type.
 * For example, for "multiple_h1", return the second h1.
 * For "skipped_level", return the heading that skips.
 */
function findFailureHeading(
  headings: HeadingInfo[],
  failureType: string | null,
): HeadingInfo | undefined {
  if (headings.length === 0) return undefined;

  switch (failureType) {
    case "multiple_h1": {
      // Return the second h1 (first is fine, second is the violation)
      const h1s = headings.filter((h) => h.level === 1);
      return h1s.length > 1 ? h1s[1] : headings[0];
    }

    case "skipped_level": {
      // Find the heading that skips a level
      for (let i = 1; i < headings.length; i++) {
        if (headings[i].level > headings[i - 1].level + 1) {
          return headings[i];
        }
      }
      return headings[0];
    }

    case "empty_heading": {
      // Find the first empty heading
      return headings.find((h) => h.text.length === 0) ?? headings[0];
    }

    default:
      return headings[0];
  }
}

/** Strip HTML tags from a string */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

/** Extract an attribute value from an attribute string */
function extractAttr(attrStr: string, attr: string): string | null {
  const regex = new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = attrStr.match(regex);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/** Build a CSS selector for a heading */
function buildHeadingSelector(
  tag: string,
  attrStr: string,
  index: number,
): string {
  const id = extractAttr(attrStr, "id");
  if (id) return `${tag}#${id}`;

  const className = extractAttr(attrStr, "class");
  if (className) {
    const classes = className.split(/\s+/).filter(Boolean).join(".");
    return `${tag}.${classes}`;
  }

  return `${tag}:nth-of-type(${index + 1})`;
}
