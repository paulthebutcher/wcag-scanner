import type { Finding } from "../types.js";

// ---------------------------------------------------------------------------
// Which check produced a finding, and which tier each check belongs to.
//
// Check ids match the ones recorded in coverage.json. `wcag verify` uses
// this to rescan with only the checks that produced the clusters it checks.
// ---------------------------------------------------------------------------

export const CHECK_TIERS: Record<string, number> = {
  "axe-core": 1,
  "keyboard": 2,
  "focus-visible": 2,
  "focus-order": 2,
  "keyboard-trap": 2,
  "skip-nav": 2,
  "modal": 2,
  "alt-text": 3,
  "link-text": 3,
  "headings": 3,
  "landmark-labels": 3,
  "widget-aria": 3,
  "table-structure": 3,
  "duplicate-links": 3,
  "consistent-nav": 3,
  "form-discovery": 4,
  "high-risk-forms": 4,
  "form-submission": 4,
  "error-messages": 4,
  "input-purpose": 4,
  "on-input": 4,
  "error-quality": 4,
  "pause-stop-hide": 5,
  "three-flashes": 5,
  "multiple-ways": 5,
  "motion-actuation": 5,
};

/** Failure types reported by exactly one non-axe check. */
const CHECK_BY_FAILURE_TYPE: Record<string, string> = {
  unreachable_interactive_element: "keyboard",
  no_visible_focus_indicator: "focus-visible",
  focus_indicator_low_contrast: "focus-visible",
  focus_on_hidden_element: "focus-visible",
  focus_order_mismatch: "focus-order",
  keyboard_trap: "keyboard-trap",
  missing_skip_navigation: "skip-nav",
  broken_skip_navigation: "skip-nav",
  skip_nav_broken: "skip-nav",
  focus_not_moved: "modal",
  focus_not_trapped: "modal",
  focus_not_returned: "modal",
  escape_not_close: "modal",
  custom_interactive_no_role: "widget-aria",
  missing_aria_expanded: "widget-aria",
  missing_tab_role: "widget-aria",
  duplicate_link_text: "duplicate-links",
  duplicate_nav_landmark: "landmark-labels",
  unlabeled_nav_landmark: "landmark-labels",
  empty_heading: "headings",
  non_descriptive: "headings",
  heading_too_generic: "headings",
  style_not_structure: "headings",
  high_risk_form: "high-risk-forms",
  error_message: "error-messages",
  error_not_identified: "form-submission",
  error_not_associated: "form-submission",
  error_color_only: "form-submission",
  missing_autocomplete: "input-purpose",
  input_purpose: "input-purpose",
  on_input_navigation: "on-input",
  animated_content_no_pause: "pause-stop-hide",
  potential_flash_video: "three-flashes",
  insufficient_navigation_methods: "multiple-ways",
  motion_actuation_detected: "motion-actuation",
};

/** Remaining Claude API findings fall back to the check for their criterion. */
const CHECK_BY_CRITERION: Record<string, string> = {
  "1.1.1": "alt-text",
  "2.4.4": "link-text",
  "2.4.6": "headings",
  "4.1.2": "widget-aria",
  "3.2.3": "consistent-nav",
  "1.3.5": "input-purpose",
  "3.3.4": "high-risk-forms",
};

/** The check that produced a finding, or null when it cannot be told. */
export function checkForFinding(finding: Finding): string | null {
  if (finding.evidence.detected_by === "axe_core") return "axe-core";
  const ft = finding.evidence.measured_values?.failure_type;
  if (typeof ft === "string" && CHECK_BY_FAILURE_TYPE[ft]) return CHECK_BY_FAILURE_TYPE[ft];
  if (ft === "table_no_caption" || ft === "table_header_no_scope" || ft === "table_missing_headers" || ft === "layout_table") {
    return "table-structure";
  }
  if (finding.evidence.detected_by === "claude_api") return CHECK_BY_CRITERION[finding.wcag_criterion] ?? null;
  return null;
}

/**
 * Checks that must run for `checks` to run: focus visibility and focus
 * order are measured on the keyboard check's tab sequence, and every form
 * check starts from form discovery.
 */
export function withPrerequisites(checks: Iterable<string>): string[] {
  const set = new Set(checks);
  for (const c of Array.from(set)) {
    if (c === "focus-visible" || c === "focus-order") set.add("keyboard");
    if (CHECK_TIERS[c] === 4) set.add("form-discovery");
  }
  return Array.from(set).sort();
}

/** Tiers needed to run the given checks. */
export function tiersForChecks(checks: Iterable<string>): number[] {
  const tiers = new Set<number>();
  for (const c of checks) {
    const t = CHECK_TIERS[c];
    if (t) tiers.add(t);
  }
  return Array.from(tiers).sort();
}
