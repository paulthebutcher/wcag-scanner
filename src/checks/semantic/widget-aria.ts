/**
 * Widget ARIA checks — detects interactive widgets missing ARIA roles.
 *
 * WCAG criteria:
 * - 4.1.2 Name, Role, Value (interactive elements must have appropriate roles/states)
 *
 * Failure types:
 * - missing_aria_expanded — accordion/dropdown without aria-expanded
 * - missing_tab_role — tab interface without role="tab" on children
 * - custom_interactive_no_role — custom interactive element with no ARIA role or tabindex
 */

import type { CheckResult } from "../../types.js";
import type { PromptRunner, PromptResult, PromptTemplate, ModelRoute } from "../../core/prompt-runner.js";
import { ELEMENT_EVAL_BASE_SYSTEM, ELEMENT_EVAL_OUTPUT_SCHEMA } from "../../prompts/element-evaluation.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WidgetCandidate {
  selector: string;
  html: string;
  type: "accordion" | "tabs" | "custom_interactive";
  hasAriaExpanded: boolean;
  hasTabRole: boolean;
  hasRole: boolean;
  hasTabindex: boolean;
  tagName: string;
}

interface WidgetEvaluation {
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
// Prompt template
// ---------------------------------------------------------------------------

const widgetAriaEval: PromptTemplate = {
  name: "widget_aria_evaluation",
  family: "element_evaluation",
  model: "sonnet" as ModelRoute,
  vision: false,
  systemPrompt: `${ELEMENT_EVAL_BASE_SYSTEM}

You are evaluating interactive widget patterns for WCAG 4.1.2 (Name, Role, Value).
Check if the element:
1. Has an appropriate ARIA role (button, tab, menuitem, etc.) if it's a non-native interactive element
2. Has required ARIA states (aria-expanded for accordions, aria-selected for tabs)
3. Is keyboard accessible (has tabindex if not natively focusable)

Common failure types: missing_aria_expanded, missing_tab_role, custom_interactive_no_role`,
  outputSchema: ELEMENT_EVAL_OUTPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// DOM extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract an attribute value from an HTML attribute string.
 * Handles double-quoted, single-quoted, and unquoted values.
 */
export function getAttr(attrStr: string, attr: string): string | null {
  const re = new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = attrStr.match(re);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/** Build a CSS selector from an element's tag, attributes, and index. */
function buildSelector(tagName: string, attrStr: string, index: number): string {
  const id = getAttr(attrStr, "id");
  if (id) return `${tagName}#${id}`;
  const cls = getAttr(attrStr, "class");
  if (cls) {
    const classes = cls.trim().split(/\s+/).filter(Boolean).slice(0, 3).join(".");
    return `${tagName}.${classes}`;
  }
  return `${tagName}:nth-of-type(${index + 1})`;
}

// ---------------------------------------------------------------------------
// Candidate collection
// ---------------------------------------------------------------------------

/**
 * Extract interactive widget candidates from serialized DOM.
 *
 * Finds:
 * - Webflow dropdown elements (w-dropdown) -> type "accordion"
 * - Webflow tab elements (w-tabs, w-tab-menu) -> type "tabs"
 * - Elements with data-w-id (Webflow interactions) that are not inside
 *   a link or button -> type "custom_interactive"
 *
 * Limits to first 20 candidates to avoid prompt overload.
 */
export function collectWidgetCandidates(dom: string): WidgetCandidate[] {
  const candidates: WidgetCandidate[] = [];
  let match: RegExpExecArray | null;

  // --- Accordion: elements with class containing w-dropdown ---
  const dropdownRegex = /<(div|span|a)\b([^>]*class\s*=\s*(?:"[^"]*w-dropdown[^"]*"|'[^']*w-dropdown[^']*')[^>]*)>([\s\S]*?)<\/\1>/gi;
  let accIndex = 0;
  while ((match = dropdownRegex.exec(dom)) !== null) {
    if (candidates.length >= 20) break;
    const tagName = match[1].toLowerCase();
    const attrStr = match[2];
    const fullHtml = match[0];
    const hasAriaExpanded = /aria-expanded\s*=/i.test(attrStr) || /aria-expanded\s*=/i.test(fullHtml);

    candidates.push({
      selector: buildSelector(tagName, attrStr, accIndex),
      html: fullHtml.length > 200 ? fullHtml.slice(0, 200) + "..." : fullHtml,
      type: "accordion",
      hasAriaExpanded,
      hasTabRole: false,
      hasRole: getAttr(attrStr, "role") !== null,
      hasTabindex: getAttr(attrStr, "tabindex") !== null,
      tagName,
    });
    accIndex++;
  }

  // --- Tabs: elements with class containing w-tabs or w-tab-menu ---
  const tabsRegex = /<(div|span|a)\b([^>]*class\s*=\s*(?:"[^"]*w-tab(?:s|-menu)[^"]*"|'[^']*w-tab(?:s|-menu)[^']*')[^>]*)>([\s\S]*?)<\/\1>/gi;
  let tabIndex = 0;
  while ((match = tabsRegex.exec(dom)) !== null) {
    if (candidates.length >= 20) break;
    const tagName = match[1].toLowerCase();
    const attrStr = match[2];
    const fullHtml = match[0];
    const hasTabRole = /role\s*=\s*["']tab["']/i.test(fullHtml);

    candidates.push({
      selector: buildSelector(tagName, attrStr, tabIndex),
      html: fullHtml.length > 200 ? fullHtml.slice(0, 200) + "..." : fullHtml,
      type: "tabs",
      hasAriaExpanded: false,
      hasTabRole,
      hasRole: getAttr(attrStr, "role") !== null || hasTabRole,
      hasTabindex: getAttr(attrStr, "tabindex") !== null,
      tagName,
    });
    tabIndex++;
  }

  // --- Custom interactive: div/span with data-w-id, not inside a link/button ---
  const interactiveRegex = /<(div|span)\b([^>]*data-w-id\s*=\s*(?:"[^"]*"|'[^']*')[^>]*)>/gi;
  let intIndex = 0;
  while ((match = interactiveRegex.exec(dom)) !== null) {
    if (candidates.length >= 20) break;
    const tagName = match[1].toLowerCase();
    const attrStr = match[2];
    const fullHtml = match[0];

    // Skip if this element has a class indicating it's already a known widget type
    const cls = getAttr(attrStr, "class") ?? "";
    if (/w-dropdown/i.test(cls) || /w-tab/i.test(cls)) continue;

    // Check if it appears to be inside a <button> or <a> tag by looking backwards
    const precedingChunk = dom.slice(Math.max(0, match.index - 200), match.index);
    const lastButtonOpen = precedingChunk.lastIndexOf("<button");
    const lastButtonClose = precedingChunk.lastIndexOf("</button");
    const lastAnchorOpen = precedingChunk.lastIndexOf("<a ");
    const lastAnchorClose = precedingChunk.lastIndexOf("</a");

    const insideButton = lastButtonOpen > lastButtonClose;
    const insideAnchor = lastAnchorOpen > lastAnchorClose;
    if (insideButton || insideAnchor) continue;

    const hasRole = getAttr(attrStr, "role") !== null;
    const hasTabindex = getAttr(attrStr, "tabindex") !== null;

    candidates.push({
      selector: buildSelector(tagName, attrStr, intIndex),
      html: fullHtml.length > 200 ? fullHtml.slice(0, 200) + "..." : fullHtml,
      type: "custom_interactive",
      hasAriaExpanded: /aria-expanded\s*=/i.test(attrStr),
      hasTabRole: false,
      hasRole,
      hasTabindex,
      tagName,
    });
    intIndex++;
  }

  return candidates.slice(0, 20);
}

// ---------------------------------------------------------------------------
// Check logic
// ---------------------------------------------------------------------------

/**
 * Run widget ARIA checks on a serialized DOM string.
 *
 * For structural issues (accordion without aria-expanded, tabs without
 * role="tab"), creates CheckResult directly without Claude (detected_by:
 * "playwright", high confidence).
 *
 * For ambiguous cases, sends to Claude for evaluation using runner.runPrompts.
 *
 * Returns CheckResult[] with wcag_criterion "4.1.2".
 */
export async function runWidgetAriaChecks(
  dom: string,
  runner: PromptRunner,
): Promise<CheckResult[]> {
  const candidates = collectWidgetCandidates(dom);
  if (candidates.length === 0) return [];

  const results: CheckResult[] = [];
  const ambiguousCandidates: WidgetCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.type === "accordion" && !candidate.hasAriaExpanded) {
      // Structural: accordion without aria-expanded
      results.push({
        element_selector: candidate.selector,
        element_html: candidate.html,
        wcag_criterion: "4.1.2",
        detected_by: "playwright",
        raw_result: {
          type: "missing_aria_expanded",
          widget_type: "accordion",
          has_aria_expanded: false,
        },
        measured_values: {
          failure_type: "missing_aria_expanded",
          widget_type: "accordion",
          has_aria_expanded: false,
          has_role: candidate.hasRole,
          has_tabindex: candidate.hasTabindex,
        },
        aria_attributes: {
          "aria-expanded": "",
          role: candidate.hasRole ? "present" : "",
        },
      });
    } else if (candidate.type === "tabs" && !candidate.hasTabRole) {
      // Structural: tabs without role="tab"
      results.push({
        element_selector: candidate.selector,
        element_html: candidate.html,
        wcag_criterion: "4.1.2",
        detected_by: "playwright",
        raw_result: {
          type: "missing_tab_role",
          widget_type: "tabs",
          has_tab_role: false,
        },
        measured_values: {
          failure_type: "missing_tab_role",
          widget_type: "tabs",
          has_tab_role: false,
          has_role: candidate.hasRole,
          has_tabindex: candidate.hasTabindex,
        },
        aria_attributes: {
          role: "",
        },
      });
    } else if (candidate.type === "custom_interactive" && !candidate.hasRole && !candidate.hasTabindex) {
      // Structural: custom interactive with no role and no tabindex
      results.push({
        element_selector: candidate.selector,
        element_html: candidate.html,
        wcag_criterion: "4.1.2",
        detected_by: "playwright",
        raw_result: {
          type: "custom_interactive_no_role",
          widget_type: "custom_interactive",
          has_role: false,
          has_tabindex: false,
        },
        measured_values: {
          failure_type: "custom_interactive_no_role",
          widget_type: "custom_interactive",
          has_role: false,
          has_tabindex: false,
        },
        aria_attributes: {
          role: "",
          tabindex: "",
        },
      });
    } else {
      // Ambiguous — needs Claude evaluation
      ambiguousCandidates.push(candidate);
    }
  }

  // Send ambiguous candidates to Claude for evaluation
  if (ambiguousCandidates.length > 0) {
    const inputs = ambiguousCandidates.map((candidate) => ({
      template: widgetAriaEval,
      userMessage: `Evaluate this interactive widget for WCAG 4.1.2 compliance.

Element HTML:
${candidate.html}

Widget type detected: ${candidate.type}
Tag name: ${candidate.tagName}
Has ARIA role: ${candidate.hasRole}
Has tabindex: ${candidate.hasTabindex}
Has aria-expanded: ${candidate.hasAriaExpanded}
Has role="tab": ${candidate.hasTabRole}`,
    }));

    const llmResults: PromptResult<WidgetEvaluation>[] = await runner.runPrompts<WidgetEvaluation>(inputs);

    for (let i = 0; i < llmResults.length; i++) {
      const result = llmResults[i];
      const candidate = ambiguousCandidates[i];

      if (!result.success || !result.data) {
        // Fallback: mark as needs_review
        results.push({
          element_selector: candidate.selector,
          element_html: candidate.html,
          wcag_criterion: "4.1.2",
          detected_by: "claude_api",
          raw_result: {
            verdict: "needs_review",
            reasoning: result.error ?? "Claude evaluation failed",
            widget_type: candidate.type,
          },
          measured_values: {
            failure_type: null,
            widget_type: candidate.type,
            has_role: candidate.hasRole,
            has_tabindex: candidate.hasTabindex,
          },
        });
        continue;
      }

      const evaluation = result.data;

      if (evaluation.verdict === "fail" || evaluation.verdict === "needs_review") {
        results.push({
          element_selector: candidate.selector,
          element_html: candidate.html,
          wcag_criterion: "4.1.2",
          detected_by: "claude_api",
          raw_result: evaluation,
          measured_values: {
            failure_type: evaluation.failure_type,
            widget_type: candidate.type,
            has_role: candidate.hasRole,
            has_tabindex: candidate.hasTabindex,
            confidence: evaluation.confidence,
          },
          aria_attributes: {
            role: candidate.hasRole ? "present" : "",
            tabindex: candidate.hasTabindex ? "present" : "",
          },
        });
      }
    }
  }

  return results;
}
