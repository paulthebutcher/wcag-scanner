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
import { withoutRawTextContent } from "../../core/markup.js";

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
  /** role attribute value, if any */
  role: string | null;
  /** tabindex attribute value, if any */
  tabindex: string | null;
  /** Accessible name: aria-label, aria-labelledby target text, or visible text */
  accessibleName: string;
  /** Looks like it opens a modal dialog (aria-haspopup="dialog", modal/popup/lightbox classes) */
  opensModal: boolean;
}

interface WidgetEvaluation {
  /** "uncertain" is requested; older-style "needs_review" is read as uncertain */
  verdict: "pass" | "fail" | "uncertain" | "needs_review";
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

For this evaluation the "verdict" field must be exactly one of "fail", "pass" or "uncertain":
- "fail": you can point to a specific failure in the evidence given.
- "pass": the element meets 4.1.2. An element with a valid role, a tabindex of 0 (or native focusability) and a non-empty accessible name meets the Name, Role and focusability requirements; never report those for it.
- "uncertain": the evidence cannot settle it. Do not express doubt through the failure type (no "possible_" or "potentially_" prefixes).

aria-expanded applies only to controls that show or hide content in place (disclosure, accordion, dropdown or navigation menu). A button that opens a modal dialog does not need aria-expanded; do not report missing_aria_expanded for it.

The accessible name is given to you (from aria-label, aria-labelledby or the element's visible text); the HTML shown may be only the opening tag.

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
// Accessible name, role and focusability (deterministic pre-check)
// ---------------------------------------------------------------------------

/** Roles that make a non-native element an interactive control. */
const VALID_WIDGET_ROLES = new Set([
  "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox",
  "menuitemradio", "option", "combobox", "slider", "spinbutton", "textbox", "treeitem", "gridcell",
]);

function stripTags(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Inner HTML of the element whose opening tag starts at `openIndex`,
 * found by balancing tags of the same name. Empty if it cannot be closed.
 */
export function innerHtmlAt(dom: string, openIndex: number, tagName: string): string {
  const openEnd = dom.indexOf(">", openIndex);
  if (openEnd === -1) return "";
  const re = new RegExp(`<(/?)${tagName}\\b[^>]*>`, "gi");
  re.lastIndex = openEnd + 1;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(dom)) !== null) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return dom.slice(openEnd + 1, m.index);
  }
  return "";
}

/** Accessible name from aria-label, aria-labelledby targets, or visible text. */
export function accessibleNameOf(dom: string, attrStr: string, innerHtml: string): string {
  const label = getAttr(attrStr, "aria-label");
  if (label && label.trim()) return label.trim();
  const labelledBy = getAttr(attrStr, "aria-labelledby");
  if (labelledBy) {
    const parts = labelledBy.split(/\s+/).filter(Boolean).map((id) => {
      const m = dom.match(new RegExp(`<([a-zA-Z0-9-]+)\\b[^>]*\\bid\\s*=\\s*["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`));
      return m ? stripTags(innerHtmlAt(dom, m.index!, m[1])) : "";
    }).filter(Boolean);
    if (parts.length > 0) return parts.join(" ");
  }
  return stripTags(innerHtml);
}

/** Opens a modal dialog rather than toggling content in place. */
function looksLikeModalOpener(attrStr: string): boolean {
  if (/aria-haspopup\s*=\s*["']dialog["']/i.test(attrStr)) return true;
  const cls = getAttr(attrStr, "class") ?? "";
  return /\b(modal|popup|pop-up|lightbox|dialog)\b/i.test(cls);
}

/**
 * Deterministic pre-check: a valid role, focusable, and a non-empty
 * accessible name. When it passes, name-, role- and focusability-related
 * failures are not reported for the element.
 */
export function passesNameRoleFocusPreCheck(candidate: Pick<WidgetCandidate, "role" | "tabindex" | "accessibleName" | "tagName">): boolean {
  const role = candidate.role?.trim().toLowerCase() ?? "";
  const nativeControl = candidate.tagName === "a" || candidate.tagName === "button";
  const validRole = VALID_WIDGET_ROLES.has(role) || (nativeControl && role === "");
  const tabindex = candidate.tabindex !== null ? parseInt(candidate.tabindex, 10) : NaN;
  const focusable = (!Number.isNaN(tabindex) && tabindex >= 0) || (nativeControl && Number.isNaN(tabindex));
  return validRole && focusable && candidate.accessibleName.trim().length > 0;
}

/** Failure types about the accessible name, the role or keyboard focusability. */
const NAME_ROLE_FOCUS_FAILURE = /name|label|role|focus|tabindex|keyboard|custom_interactive/i;

export type WidgetVerdict = "fail" | "pass" | "uncertain";

/**
 * Map the model's answer to a verdict. Only "fail" becomes a finding;
 * "uncertain" becomes a needs-review item. Hedged failure types
 * (possible_/potentially_) are uncertain. Name/role/focus failures on an
 * element that passes the pre-check, and missing_aria_expanded on a modal
 * opener, contradict the evidence and are dropped.
 */
export function mapWidgetVerdict(
  evaluation: Pick<WidgetEvaluation, "verdict" | "failure_type">,
  candidate: Pick<WidgetCandidate, "role" | "tabindex" | "accessibleName" | "tagName" | "opensModal">,
): WidgetVerdict {
  const ft = evaluation.failure_type ?? "";
  let verdict: WidgetVerdict = evaluation.verdict === "fail" ? "fail" : evaluation.verdict === "pass" ? "pass" : "uncertain";
  if (verdict === "fail" && /^(possible|possibly|potentially)_/i.test(ft)) verdict = "uncertain";
  if (verdict === "pass") return "pass";
  if (ft && NAME_ROLE_FOCUS_FAILURE.test(ft) && passesNameRoleFocusPreCheck(candidate)) return "pass";
  if (/aria_expanded/i.test(ft) && candidate.opensModal) return "pass";
  return verdict;
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
      role: getAttr(attrStr, "role"),
      tabindex: getAttr(attrStr, "tabindex"),
      accessibleName: accessibleNameOf(dom, attrStr, match[3]),
      opensModal: looksLikeModalOpener(attrStr),
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
      role: getAttr(attrStr, "role"),
      tabindex: getAttr(attrStr, "tabindex"),
      accessibleName: accessibleNameOf(dom, attrStr, match[3]),
      opensModal: looksLikeModalOpener(attrStr),
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
      role: getAttr(attrStr, "role"),
      tabindex: getAttr(attrStr, "tabindex"),
      // Only the opening tag is kept as the element HTML; the name comes
      // from the whole element (visible text such as "Request a Demo")
      accessibleName: accessibleNameOf(dom, attrStr, innerHtmlAt(dom, match.index, tagName)),
      opensModal: looksLikeModalOpener(attrStr),
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
  fullDom: string,
  runner: PromptRunner,
): Promise<CheckResult[]> {
  // Markup inside <style>/<script>/<noscript>/<template> is never rendered (P2-012)
  const dom = withoutRawTextContent(fullDom);
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
    } else if (passesNameRoleFocusPreCheck(candidate) && candidate.opensModal) {
      // A named, focusable control with a valid role that opens a modal:
      // nothing left for 4.1.2 to fail (aria-expanded does not apply)
      continue;
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
Has ARIA role: ${candidate.hasRole}${candidate.role ? ` (role="${candidate.role}")` : ""}
Has tabindex: ${candidate.hasTabindex}${candidate.tabindex !== null ? ` (tabindex="${candidate.tabindex}")` : ""}
Has aria-expanded: ${candidate.hasAriaExpanded}
Has role="tab": ${candidate.hasTabRole}
Accessible name: ${candidate.accessibleName ? `"${candidate.accessibleName.slice(0, 120)}"` : "(none found)"}
Appears to open a modal dialog: ${candidate.opensModal}`,
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
            verdict: "uncertain",
          },
        });
        continue;
      }

      const evaluation = result.data;
      const verdict = mapWidgetVerdict(evaluation, candidate);

      // Only "fail" is a finding; "uncertain" is kept for review (scored
      // needs_review, so it stays out of Top fixes and failure counts)
      if (verdict !== "pass") {
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
            verdict,
            accessible_name: candidate.accessibleName,
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
