import type { PromptTemplate, ModelRoute } from "../core/prompt-runner.js";

// ---------------------------------------------------------------------------
// Shared base system prompt for Element Evaluation family (Prompts 1-8)
// ---------------------------------------------------------------------------

export const ELEMENT_EVAL_BASE_SYSTEM = `You are a WCAG 2.1 AA accessibility expert evaluating web page elements.
You analyze DOM snippets, screenshots, and ARIA attributes to identify accessibility violations.

Rules:
- Apply WCAG 2.1 Level A and AA success criteria only.
- Base your verdict on objective evidence: DOM attributes, computed styles, visible text, and screenshots.
- "pass": the element meets the criterion. If your reasoning concludes the element is acceptable or needs no change, the verdict is "pass", even if you would like a person to double-check it (set "requires_human_verification": true for that).
- "needs_review": only when the evidence you have cannot settle pass or fail, for example when the verdict depends on content you cannot see.
- When uncertain, set "requires_human_verification": true rather than guessing.
- Return your response as a single JSON object (no markdown code fences).
- Do not include explanations outside the JSON.

Output format:
{
  "verdict": "pass" | "fail" | "needs_review",
  "confidence": 0.0 to 1.0,
  "reasoning": "plain English explanation",
  "wcag_criterion": "X.Y.Z",
  "failure_type": "string or null if pass",
  "suggestion": "how to fix, or null if pass",
  "affected_users": ["screen_reader", "keyboard_only", "low_vision", "cognitive", etc.],
  "requires_human_verification": true or false
}`;

// ---------------------------------------------------------------------------
// Shared output schema
// ---------------------------------------------------------------------------

export const ELEMENT_EVAL_OUTPUT_SCHEMA: Record<string, unknown> = {
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
  },
};

// ---------------------------------------------------------------------------
// Failure mode enums per prompt
// ---------------------------------------------------------------------------

export const ALT_TEXT_FAILURE_MODES = [
  "missing_alt",
  "empty_alt_on_informative",
  "decorative_not_marked",
  "filename_as_alt",
  "placeholder_alt",
  "alt_too_long",
  "alt_not_descriptive",
  "redundant_alt",
] as const;

export const LINK_TEXT_FAILURE_MODES = [
  "generic_link_text",
  "url_as_link_text",
  "ambiguous_without_context",
  "empty_link",
  "image_link_no_alt",
] as const;

export const HEADING_FAILURE_MODES = [
  "skipped_level",
  "multiple_h1",
  "style_not_structure",
  "empty_heading",
  "heading_too_long",
  "missing_heading",
] as const;

export const COLOR_FAILURE_MODES = [
  "color_only_indicator",
  "link_color_only",
  "chart_color_only",
  "status_color_only",
  "form_error_color_only",
] as const;

export const CONSISTENT_NAV_FAILURE_MODES = [
  "order_changed",
  "items_missing",
  "items_added",
  "structure_changed",
] as const;

export const CONSISTENT_ID_FAILURE_MODES = [
  "different_labels",
  "different_icons",
  "different_roles",
  "inconsistent_patterns",
] as const;

export const LABELS_FAILURE_MODES = [
  "missing_label",
  "label_not_descriptive",
  "instructions_missing",
  "required_not_indicated",
  "format_not_specified",
] as const;

export const HOVER_FOCUS_FAILURE_MODES = [
  "not_dismissable",
  "not_hoverable",
  "not_persistent",
  "content_obscures",
] as const;

// ---------------------------------------------------------------------------
// Prompt 1: Alt Text Quality (1.1.1)
// ---------------------------------------------------------------------------

export const altTextQuality: PromptTemplate = {
  name: "alt_text_quality",
  family: "element_evaluation",
  model: "sonnet" as ModelRoute,
  vision: true,
  systemPrompt: `${ELEMENT_EVAL_BASE_SYSTEM}

You are evaluating alt text quality for images. WCAG 1.1.1 requires:
- Informative images must have alt text that conveys the same information.
- Decorative images must have alt="" or role="presentation".
- Functional images (inside links/buttons) must describe the function, not the image.

Common failure types: ${ALT_TEXT_FAILURE_MODES.join(", ")}

You will receive: the <img> element HTML, its alt attribute value, surrounding context, and (when it could be retrieved) the image itself.`,
  outputSchema: ELEMENT_EVAL_OUTPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Prompt 2: Link Text Quality (2.4.4)
// ---------------------------------------------------------------------------

export const linkTextQuality: PromptTemplate = {
  name: "link_text_quality",
  family: "element_evaluation",
  model: "sonnet" as ModelRoute,
  vision: false,
  systemPrompt: `${ELEMENT_EVAL_BASE_SYSTEM}

You are evaluating link text quality. WCAG 2.4.4 requires:
- Link text must describe the purpose of the link.
- "Click here", "Read more", "Learn more" alone are failures unless context makes the purpose clear.
- URLs as link text are failures (screen readers read them character by character).
- Image links must have alt text describing the link destination.

Common failure types: ${LINK_TEXT_FAILURE_MODES.join(", ")}

You will receive: the <a> element HTML, visible link text, and surrounding paragraph context.`,
  outputSchema: ELEMENT_EVAL_OUTPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Prompt 3: Heading Structure (2.4.6, 1.3.1)
// ---------------------------------------------------------------------------

export const headingStructure: PromptTemplate = {
  name: "heading_structure",
  family: "element_evaluation",
  model: "sonnet" as ModelRoute,
  vision: false,
  systemPrompt: `${ELEMENT_EVAL_BASE_SYSTEM}

You are evaluating a page's headings.

These are WCAG failures:
- empty_heading (2.4.6): a heading element with no text.
- non_descriptive (2.4.6): a heading that does not describe the content it introduces, such as "Section 1" or "Untitled".
- style_not_structure (1.3.1): a heading element that holds body text, such as a full paragraph or a caption, rather than a heading.

These are best practice, not WCAG failures. List them in "best_practice_issues" and do not fail the page for them:
- skipped_level (for example h1 followed by h3)
- multiple_h1
- heading_too_long (a long but genuine heading)
- missing_heading (a page with few or no headings)

Set "verdict" to "fail" only when at least one WCAG failure is present. Set "failure_type" to the single most serious WCAG failure (empty_heading first, then style_not_structure, then non_descriptive) and "wcag_criterion" to its criterion. Set "failing_heading" to the exact text of the heading that shows that failure ("" for an empty heading).

Add these fields to the JSON object:
  "failing_heading": "heading text or null",
  "best_practice_issues": ["skipped_level", ...]

You will receive: all headings on the page with their levels, text content, and nesting context.`,
  outputSchema: ELEMENT_EVAL_OUTPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Prompt 4: Use of Color (1.4.1)
// ---------------------------------------------------------------------------

export const useOfColor: PromptTemplate = {
  name: "use_of_color",
  family: "element_evaluation",
  model: "sonnet" as ModelRoute,
  vision: true,
  systemPrompt: `${ELEMENT_EVAL_BASE_SYSTEM}

You are evaluating use of color. WCAG 1.4.1 requires:
- Color must not be the only visual means of conveying information.
- Links must be distinguishable from surrounding text by more than color alone (underline, bold, icon, etc.).
- Status indicators, error messages, and charts must use more than color.

Common failure types: ${COLOR_FAILURE_MODES.join(", ")}

You will receive: the element HTML, computed styles, and a screenshot showing the element in context.`,
  outputSchema: ELEMENT_EVAL_OUTPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Prompt 5: Consistent Navigation (3.2.3)
// ---------------------------------------------------------------------------

export const consistentNavigation: PromptTemplate = {
  name: "consistent_navigation",
  family: "element_evaluation",
  model: "sonnet" as ModelRoute,
  vision: false,
  systemPrompt: `${ELEMENT_EVAL_BASE_SYSTEM}

You are evaluating navigation consistency. WCAG 3.2.3 requires:
- Navigation mechanisms that appear on multiple pages must be in the same relative order.
- Items may be added or removed, but the order of shared items must stay consistent.

Common failure types: ${CONSISTENT_NAV_FAILURE_MODES.join(", ")}

You will receive: navigation HTML from multiple pages, with item labels and order listed.`,
  outputSchema: ELEMENT_EVAL_OUTPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Prompt 6: Consistent Identification (3.2.4)
// ---------------------------------------------------------------------------

export const consistentIdentification: PromptTemplate = {
  name: "consistent_identification",
  family: "element_evaluation",
  model: "sonnet" as ModelRoute,
  vision: true,
  systemPrompt: `${ELEMENT_EVAL_BASE_SYSTEM}

You are evaluating consistent identification. WCAG 3.2.4 requires:
- Components with the same functionality must be identified consistently across pages.
- Same search box should have same label. Same icon should mean the same thing.
- Buttons performing the same action should use the same text/icon.

Common failure types: ${CONSISTENT_ID_FAILURE_MODES.join(", ")}

You will receive: component HTML from multiple pages with labels, roles, and screenshots.`,
  outputSchema: ELEMENT_EVAL_OUTPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Prompt 7: Labels or Instructions (3.3.2)
// ---------------------------------------------------------------------------

export const labelsOrInstructions: PromptTemplate = {
  name: "labels_or_instructions",
  family: "element_evaluation",
  model: "sonnet" as ModelRoute,
  vision: true,
  systemPrompt: `${ELEMENT_EVAL_BASE_SYSTEM}

You are evaluating form labels and instructions. WCAG 3.3.2 requires:
- Every form input must have a visible label or instruction.
- Required fields must be indicated (asterisk, "required" text, etc.).
- Expected formats must be specified (e.g., "MM/DD/YYYY" for dates).
- Labels must be programmatically associated (for/id, aria-label, aria-labelledby).

Common failure types: ${LABELS_FAILURE_MODES.join(", ")}

You will receive: form element HTML, associated labels, placeholder text, and a screenshot.`,
  outputSchema: ELEMENT_EVAL_OUTPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Prompt 8: Content on Hover or Focus (1.4.13)
// ---------------------------------------------------------------------------

export const contentOnHoverFocus: PromptTemplate = {
  name: "content_on_hover_focus",
  family: "element_evaluation",
  model: "sonnet" as ModelRoute,
  vision: true,
  systemPrompt: `${ELEMENT_EVAL_BASE_SYSTEM}

You are evaluating content that appears on hover or focus. WCAG 1.4.13 requires:
- Hover/focus content must be dismissable (Escape or moving pointer away).
- Hover content must be hoverable (user can move pointer over it without it disappearing).
- Content must persist until user dismisses it, removes hover/focus, or it's no longer valid.
- Content must not obscure the trigger or other content.

Common failure types: ${HOVER_FOCUS_FAILURE_MODES.join(", ")}

You will receive: trigger element HTML, popup/tooltip HTML, interaction state, and before/after screenshots.`,
  outputSchema: ELEMENT_EVAL_OUTPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// User prompt template functions
// ---------------------------------------------------------------------------

export function buildAltTextUserPrompt(params: {
  elementHtml: string;
  altText: string;
  surroundingContext: string;
  /** Whether the image itself accompanies the prompt */
  imageAttached?: boolean;
}): string {
  const imageNote = params.imageAttached === undefined
    ? ""
    : params.imageAttached
      ? "\n\nThe image is attached. Compare the alt text with what the image shows."
      : "\n\nNo image is attached. Judge from the HTML and context only; if the verdict depends on what the image shows, return needs_review instead of fail.";
  return `Evaluate this image's alt text for WCAG 1.1.1 compliance.

Element HTML:
${params.elementHtml}

Alt text: "${params.altText}"

Surrounding context:
${params.surroundingContext}${imageNote}`;
}

export function buildLinkTextUserPrompt(params: {
  elementHtml: string;
  linkText: string;
  surroundingContext: string;
}): string {
  return `Evaluate this link's text for WCAG 2.4.4 compliance.

Element HTML:
${params.elementHtml}

Visible link text: "${params.linkText}"

Surrounding context:
${params.surroundingContext}`;
}

export function buildHeadingStructureUserPrompt(params: {
  headings: Array<{ level: number; text: string }>;
  pageTitle: string;
}): string {
  const headingList = params.headings
    .map((h) => `  h${h.level}: "${h.text}"`)
    .join("\n");

  return `Evaluate the heading structure on this page for WCAG 2.4.6 compliance.

Page title: "${params.pageTitle}"

Headings (in document order):
${headingList}`;
}

export function buildUseOfColorUserPrompt(params: {
  elementHtml: string;
  computedStyles: Record<string, string>;
  context: string;
}): string {
  const styles = Object.entries(params.computedStyles)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");

  return `Evaluate whether this element uses color as the sole means of conveying information (WCAG 1.4.1).

Element HTML:
${params.elementHtml}

Computed styles:
${styles}

Context:
${params.context}`;
}

export function buildConsistentNavUserPrompt(params: {
  pages: Array<{ url: string; navItems: string[] }>;
}): string {
  const pageList = params.pages
    .map((p) => `  ${p.url}: [${p.navItems.map((i) => `"${i}"`).join(", ")}]`)
    .join("\n");

  return `Evaluate navigation consistency across pages for WCAG 3.2.3 compliance.

Navigation items per page (in order):
${pageList}`;
}

export function buildConsistentIdUserPrompt(params: {
  components: Array<{ page: string; label: string; role: string; html: string }>;
}): string {
  const compList = params.components
    .map((c) => `  Page: ${c.page}, Label: "${c.label}", Role: ${c.role}\n    HTML: ${c.html}`)
    .join("\n");

  return `Evaluate component identification consistency across pages for WCAG 3.2.4 compliance.

Components with similar functionality:
${compList}`;
}

export function buildLabelsUserPrompt(params: {
  elementHtml: string;
  labelText: string;
  placeholderText: string;
  ariaAttributes: Record<string, string>;
}): string {
  const ariaList = Object.entries(params.ariaAttributes)
    .map(([k, v]) => `  ${k}: "${v}"`)
    .join("\n");

  return `Evaluate this form input's label and instructions for WCAG 3.3.2 compliance.

Element HTML:
${params.elementHtml}

Visible label: "${params.labelText}"
Placeholder: "${params.placeholderText}"

ARIA attributes:
${ariaList || "  (none)"}`;
}

export function buildHoverFocusUserPrompt(params: {
  triggerHtml: string;
  popupHtml: string;
  interactionType: "hover" | "focus";
  dismissable: boolean;
}): string {
  return `Evaluate this hover/focus content for WCAG 1.4.13 compliance.

Trigger element:
${params.triggerHtml}

Popup/tooltip content:
${params.popupHtml}

Interaction type: ${params.interactionType}
Dismissable by Escape: ${params.dismissable}`;
}

// ---------------------------------------------------------------------------
// Confidence calibration rules
// ---------------------------------------------------------------------------

export interface ConfidenceCalibration {
  failureType: string;
  minConfidence: number;
  maxConfidence: number;
  requiresHuman: boolean;
  falsePositiveRisk: "low" | "medium" | "high";
}

export const ALT_TEXT_CALIBRATION: ConfidenceCalibration[] = [
  { failureType: "filename_as_alt", minConfidence: 0.85, maxConfidence: 0.95, requiresHuman: false, falsePositiveRisk: "low" },
  { failureType: "missing_alt", minConfidence: 0.95, maxConfidence: 1.0, requiresHuman: false, falsePositiveRisk: "low" },
  { failureType: "empty_alt_on_informative", minConfidence: 0.50, maxConfidence: 0.80, requiresHuman: true, falsePositiveRisk: "medium" },
  { failureType: "decorative_not_marked", minConfidence: 0.50, maxConfidence: 0.64, requiresHuman: true, falsePositiveRisk: "high" },
  { failureType: "placeholder_alt", minConfidence: 0.80, maxConfidence: 0.90, requiresHuman: false, falsePositiveRisk: "low" },
  { failureType: "alt_not_descriptive", minConfidence: 0.50, maxConfidence: 0.75, requiresHuman: true, falsePositiveRisk: "medium" },
];

export const LINK_TEXT_CALIBRATION: ConfidenceCalibration[] = [
  { failureType: "generic_link_text", minConfidence: 0.90, maxConfidence: 0.98, requiresHuman: false, falsePositiveRisk: "low" },
  { failureType: "url_as_link_text", minConfidence: 0.90, maxConfidence: 0.98, requiresHuman: false, falsePositiveRisk: "low" },
  { failureType: "ambiguous_without_context", minConfidence: 0.65, maxConfidence: 0.84, requiresHuman: true, falsePositiveRisk: "medium" },
  { failureType: "empty_link", minConfidence: 0.95, maxConfidence: 1.0, requiresHuman: false, falsePositiveRisk: "low" },
  { failureType: "image_link_no_alt", minConfidence: 0.90, maxConfidence: 0.98, requiresHuman: false, falsePositiveRisk: "low" },
];

export const HEADING_CALIBRATION: ConfidenceCalibration[] = [
  { failureType: "skipped_level", minConfidence: 0.95, maxConfidence: 1.0, requiresHuman: false, falsePositiveRisk: "low" },
  { failureType: "multiple_h1", minConfidence: 0.90, maxConfidence: 0.95, requiresHuman: false, falsePositiveRisk: "low" },
  { failureType: "style_not_structure", minConfidence: 0.50, maxConfidence: 0.64, requiresHuman: true, falsePositiveRisk: "high" },
  { failureType: "empty_heading", minConfidence: 0.95, maxConfidence: 1.0, requiresHuman: false, falsePositiveRisk: "low" },
];

export const COLOR_CALIBRATION: ConfidenceCalibration[] = [
  { failureType: "link_color_only", minConfidence: 0.85, maxConfidence: 0.95, requiresHuman: false, falsePositiveRisk: "low" },
  { failureType: "chart_color_only", minConfidence: 0.30, maxConfidence: 0.60, requiresHuman: true, falsePositiveRisk: "high" },
  { failureType: "status_color_only", minConfidence: 0.65, maxConfidence: 0.85, requiresHuman: true, falsePositiveRisk: "medium" },
  { failureType: "form_error_color_only", minConfidence: 0.75, maxConfidence: 0.90, requiresHuman: false, falsePositiveRisk: "medium" },
];

export const CONSISTENT_NAV_CALIBRATION: ConfidenceCalibration[] = [
  { failureType: "order_changed", minConfidence: 0.95, maxConfidence: 1.0, requiresHuman: false, falsePositiveRisk: "low" },
  { failureType: "items_missing", minConfidence: 0.80, maxConfidence: 0.95, requiresHuman: false, falsePositiveRisk: "low" },
  { failureType: "structure_changed", minConfidence: 0.70, maxConfidence: 0.90, requiresHuman: true, falsePositiveRisk: "medium" },
];

export const CONSISTENT_ID_CALIBRATION: ConfidenceCalibration[] = [
  { failureType: "different_labels", minConfidence: 0.70, maxConfidence: 0.84, requiresHuman: true, falsePositiveRisk: "medium" },
  { failureType: "inconsistent_patterns", minConfidence: 0.70, maxConfidence: 0.90, requiresHuman: true, falsePositiveRisk: "medium" },
];

export const LABELS_CALIBRATION: ConfidenceCalibration[] = [
  { failureType: "missing_label", minConfidence: 0.90, maxConfidence: 0.98, requiresHuman: false, falsePositiveRisk: "low" },
  { failureType: "label_not_descriptive", minConfidence: 0.60, maxConfidence: 0.80, requiresHuman: true, falsePositiveRisk: "medium" },
  { failureType: "required_not_indicated", minConfidence: 0.80, maxConfidence: 0.95, requiresHuman: false, falsePositiveRisk: "low" },
];

export const HOVER_FOCUS_CALIBRATION: ConfidenceCalibration[] = [
  { failureType: "not_dismissable", minConfidence: 0.85, maxConfidence: 0.95, requiresHuman: false, falsePositiveRisk: "low" },
  { failureType: "not_hoverable", minConfidence: 0.80, maxConfidence: 0.95, requiresHuman: false, falsePositiveRisk: "low" },
  { failureType: "not_persistent", minConfidence: 0.70, maxConfidence: 0.90, requiresHuman: true, falsePositiveRisk: "medium" },
];

// ---------------------------------------------------------------------------
// Prompt registry for Element Evaluation family
// ---------------------------------------------------------------------------

export const ELEMENT_EVAL_PROMPTS: Record<string, PromptTemplate> = {
  alt_text_quality: altTextQuality,
  link_text_quality: linkTextQuality,
  heading_structure: headingStructure,
  use_of_color: useOfColor,
  consistent_navigation: consistentNavigation,
  consistent_identification: consistentIdentification,
  labels_or_instructions: labelsOrInstructions,
  content_on_hover_focus: contentOnHoverFocus,
};

export const ELEMENT_EVAL_CALIBRATIONS: Record<string, ConfidenceCalibration[]> = {
  alt_text_quality: ALT_TEXT_CALIBRATION,
  link_text_quality: LINK_TEXT_CALIBRATION,
  heading_structure: HEADING_CALIBRATION,
  use_of_color: COLOR_CALIBRATION,
  consistent_navigation: CONSISTENT_NAV_CALIBRATION,
  consistent_identification: CONSISTENT_ID_CALIBRATION,
  labels_or_instructions: LABELS_CALIBRATION,
  content_on_hover_focus: HOVER_FOCUS_CALIBRATION,
};
