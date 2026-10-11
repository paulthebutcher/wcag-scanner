import type { Effort, Finding } from "../types.js";
import {
  elementSignature,
  failureTypeOf,
  normalizeSelector,
  partitionExclusions,
  rootClassList,
  stripVolatileAttributes,
} from "./clustering.js";

// ---------------------------------------------------------------------------
// Remediation estimate from fix units
//
// A fix unit is one change in the site builder: one class style, one
// component's attributes, one piece of copy, one page's markup, or one
// site-wide addition. Findings that one change clears (the same footer link
// on 50 pages, every link using the same colour) collapse into one unit, so
// the estimate tracks work, not instances.
//
// All hours are in EFFORT_MODEL. They are judgement for Webflow work, meant
// to be retuned against real timesheets (findings.md lists every unit).
// ---------------------------------------------------------------------------

export type FixKind = "site" | "class-style" | "component" | "content" | "page" | "structural";

type Range = [low: number, high: number];

export const EFFORT_MODEL = {
  /** Hours per fix unit, by kind */
  kinds: {
    "site": [0.5, 1],
    "class-style": [0.15, 0.3],
    "component": [0.25, 0.5],
    "content": [0.05, 0.1],
    "page": [0.1, 0.2],
    "structural": [0.5, 1],
  } as Record<FixKind, Range>,
  /** Per-failure-type hours where the kind default is wrong */
  overrides: {
    insufficient_navigation_methods: [2, 4],
    "video-caption": [0.5, 2],
    potential_flash_video: [0.25, 0.75],
    animated_content_no_pause: [0.5, 1],
  } as Record<string, Range>,
  /** Unknown failure types: by the finding's stored effort */
  byStoredEffort: {
    trivial: [0.1, 0.25],
    minor: [0.25, 0.5],
    moderate: [0.5, 1.5],
    significant: [2, 4],
  } as Record<Effort, Range>,
  /** Keyboard handler for div buttons, added once when any is fixed */
  keyboardSnippet: [1, 1] as Range,
  /** QA / re-test: share of fix hours plus a verify run and report */
  qaShare: 0.2,
  qaFixed: 1,
  /** Manual review: unmeasurable contrast per component (class), advisory per unit */
  manualCheckPerElement: [3 / 60, 6 / 60] as Range,
  reviewPerAdvisoryUnit: [5 / 60, 15 / 60] as Range,
  reviewCap: 5,
  /** Client coordination: share of fix hours plus copy sign-off per content unit */
  coordinationShare: 0.1,
  coordinationPerContentUnit: 0.05,
  coordinationCap: 4,
};

/** Form error-handling problems: one rework of a form covers all of them. */
const FORM_ERROR_TYPES = new Set(["error_message", "error_not_identified", "error_not_associated", "error_color_only"]);

/** How each failure type's findings collapse into changes. */
const KIND_BY_FAILURE_TYPE: Record<string, FixKind> = {
  // One addition for the whole site
  missing_skip_navigation: "site",
  broken_skip_navigation: "site",
  skip_nav_broken: "site",
  missing_skip_link: "site",
  insufficient_navigation_methods: "site",
  "html-has-lang": "site",
  "html-lang-valid": "site",
  // One style edit per class (or colour)
  "color-contrast": "class-style",
  insufficient_contrast: "class-style",
  "link-in-text-block": "class-style",
  no_visible_focus_indicator: "class-style",
  focus_indicator_low_contrast: "class-style",
  no_focus_indicator: "class-style",
  // One attribute/settings change per component
  custom_interactive_no_role: "component",
  missing_aria_expanded: "component",
  missing_tab_role: "component",
  "aria-prohibited-attr": "component",
  "aria-allowed-attr": "component",
  "aria-required-attr": "component",
  "aria-required-children": "component",
  "aria-required-parent": "component",
  "aria-valid-attr-value": "component",
  "aria-hidden-focus": "component",
  "button-name": "component",
  label: "component",
  "form-field-multiple-labels": "component",
  "nested-interactive": "component",
  "scrollable-region-focusable": "component",
  "duplicate-id-aria": "component",
  focus_on_hidden_element: "component",
  unreachable_interactive_element: "component",
  keyboard_trap: "component",
  focus_not_moved: "component",
  focus_not_trapped: "component",
  focus_not_returned: "component",
  escape_not_close: "component",
  duplicate_nav_landmark: "component",
  unlabeled_nav_landmark: "component",
  list: "component",
  listitem: "component",
  // Copy or alt-text edits, per unique element
  "image-alt": "content",
  missing_alt: "content",
  alt_not_descriptive: "content",
  empty_alt_on_informative: "content",
  decorative_with_alt: "content",
  semantic: "content",
  "link-name": "content",
  generic_link_text: "content",
  empty_link: "content",
  image_link_no_alt: "content",
  ambiguous_without_context: "content",
  url_as_link_text: "content",
  duplicate_link_text: "content",
  empty_heading: "content",
  "empty-heading": "content",
  non_descriptive: "content",
  heading_too_generic: "content",
  style_not_structure: "content",
  missing_autocomplete: "content",
  input_purpose: "content",
  "frame-title": "content",
  "document-title": "content",
  // Per page
  focus_order_mismatch: "page",
  skipped_level: "page",
  missing_heading: "page",
  // Rebuilds and behaviour changes per component
  error_message: "structural",
  error_not_identified: "structural",
  error_not_associated: "structural",
  error_color_only: "structural",
  high_risk_form: "structural",
  on_input_navigation: "structural",
  "video-caption": "structural",
  potential_flash_video: "structural",
  animated_content_no_pause: "structural",
  motion_actuation_detected: "structural",
  table_no_caption: "structural",
  table_header_no_scope: "structural",
  table_missing_headers: "structural",
  layout_table: "structural",
};

export interface FixUnit {
  key: string;
  kind: FixKind;
  failure_type: string;
  wcag_criterion: string;
  label: string;
  /** Findings in the unit */
  findings: number;
  low: number;
  high: number;
  /** Advisory (needs human judgement): an add-on, not in the headline */
  advisory: boolean;
}

export interface LineItem {
  label: string;
  low: number;
  high: number;
}

export interface RemediationEstimate {
  units: FixUnit[];
  fixes: LineItem;
  qa: LineItem;
  review: LineItem;
  coordination: LineItem;
  /** Not in the headline: advisory fixes, if review confirms them */
  advisoryAddOn: LineItem;
  low: number;
  high: number;
  /** Unique elements that need a manual contrast check */
  manualCheckElements: number;
  /** Third-party findings (0 hours: raise with the vendor) */
  thirdParty: number;
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

function rootTag(html: string): string {
  return (html.match(/^\s*<([a-zA-Z][a-zA-Z0-9-]*)/)?.[1] ?? "").toLowerCase();
}

/** Designer classes: Webflow system classes (w-*) dropped when custom ones exist. */
function designerClasses(html: string): string[] {
  const all = rootClassList(html).filter((c) => c !== "w--current");
  const custom = all.filter((c) => !c.startsWith("w-"));
  return custom.length > 0 ? custom : all;
}

export function fixKindFor(finding: Finding): FixKind {
  return KIND_BY_FAILURE_TYPE[failureTypeOf(finding)] ?? "component";
}

/** Component identity: tag and designer classes, or the selector without :nth-*. */
function componentKey(finding: Finding): string {
  const html = finding.evidence.element_html ?? "";
  const classes = designerClasses(html);
  return classes.length > 0
    ? `${rootTag(html)}.${classes.join(".")}`
    : normalizeSelector(finding.evidence.element_selector ?? "") || rootTag(html);
}

/** Resolves a page_snapshot_id to its URL; identity when URLs are not at hand. */
export type PageUrlOf = (pageSnapshotId: string) => string;

/** Every page a finding occurs on (its own page plus folded pages). */
function pageKeys(finding: Finding, pageUrlOf: PageUrlOf): string[] {
  const others = finding.evidence.measured_values?.also_found_on_urls;
  return Array.from(new Set([pageUrlOf(finding.page_snapshot_id), ...(Array.isArray(others) ? others.map(String) : [])]));
}

/** The unit keys a finding belongs to (several for a page-kind finding on several pages). */
export function unitKeysFor(finding: Finding, pageUrlOf: PageUrlOf = (id) => id): string[] {
  const ft = failureTypeOf(finding);
  const kind = fixKindFor(finding);
  switch (kind) {
    case "site":
      return [`site|${ft}`];
    case "class-style":
      return ft === "color-contrast" && elementSignature(finding).includes("|fg:")
        ? [`class-style|${elementSignature(finding)}`]
        : [`class-style|${ft}|${componentKey(finding)}`];
    case "content":
      return [`content|${ft}|${stripVolatileAttributes(finding.evidence.element_html ?? "")}`];
    case "page":
      return pageKeys(finding, pageUrlOf).map((p) => `page|${ft}|${p}`);
    case "component":
    case "structural":
      if (FORM_ERROR_TYPES.has(ft)) return [`structural|form-errors|${componentKey(finding)}`];
      return [`${kind}|${finding.wcag_criterion}|${ft}|${componentKey(finding)}`];
  }
}

function hoursFor(finding: Finding, kind: FixKind): Range {
  const ft = failureTypeOf(finding);
  if (EFFORT_MODEL.overrides[ft]) return EFFORT_MODEL.overrides[ft];
  if (KIND_BY_FAILURE_TYPE[ft]) return EFFORT_MODEL.kinds[kind];
  return EFFORT_MODEL.byStoredEffort[finding.remediation.estimated_effort] ?? EFFORT_MODEL.kinds.component;
}

function unitLabel(finding: Finding, kind: FixKind): string {
  const ft = failureTypeOf(finding).replace(/[_-]/g, " ");
  if (failureTypeOf(finding) === "color-contrast") {
    const fg = elementSignature(finding).split("fg:")[1];
    if (fg) return `Text colour ${fg}: contrast`;
  }
  if (kind === "site") return `Site-wide: ${ft}`;
  if (FORM_ERROR_TYPES.has(failureTypeOf(finding))) return `${componentKey(finding)}: form error handling`;
  if (kind === "page") return `Per page: ${ft}`;
  if (kind === "content") {
    const text = (finding.evidence.element_html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
    return `${componentKey(finding)}${text ? ` "${text}"` : ""}: ${ft}`;
  }
  return `${componentKey(finding)}: ${ft}`;
}

/** Group findings into fix units. Findings should already be the client view (exclusions removed). */
export function fixUnits(findings: Finding[], pageUrlOf: PageUrlOf = (id) => id): FixUnit[] {
  const units = new Map<string, FixUnit>();
  for (const finding of findings) {
    const kind = fixKindFor(finding);
    const [low, high] = hoursFor(finding, kind);
    for (const key of unitKeysFor(finding, pageUrlOf)) {
      const existing = units.get(key);
      if (existing) {
        existing.findings += 1;
        // A unit is advisory only if every finding in it is
        existing.advisory &&= finding.severity === "advisory";
        continue;
      }
      units.set(key, {
        key,
        kind,
        failure_type: failureTypeOf(finding),
        wcag_criterion: finding.wcag_criterion,
        label: unitLabel(finding, kind),
        findings: 1,
        low,
        high,
        advisory: finding.severity === "advisory",
      });
    }
  }
  return Array.from(units.values()).sort((a, b) => b.high - a.high || a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// Estimate
// ---------------------------------------------------------------------------

const sum = (items: Array<{ low: number; high: number }>): Range =>
  [items.reduce((n, i) => n + i.low, 0), items.reduce((n, i) => n + i.high, 0)];

const capped = ([low, high]: Range, cap: number): Range => [Math.min(low, cap), Math.min(high, cap)];

/**
 * Estimate remediation for a scan. Pass the client view (noisy findings
 * filtered) including excluded findings: needs-manual-check findings add
 * review time and third-party findings add none.
 */
export function estimateRemediation(findings: Finding[], pageUrlOf: PageUrlOf = (id) => id): RemediationEstimate {
  const { kept, excluded } = partitionExclusions(findings.map((finding) => ({ finding, pageUrl: "" })));
  const units = fixUnits(kept.map((k) => k.finding), pageUrlOf);

  // One keyboard handler covers every div given role="button"
  if (units.some((u) => !u.advisory && u.failure_type === "custom_interactive_no_role")) {
    units.push({
      key: "site|keyboard-snippet",
      kind: "site",
      failure_type: "custom_interactive_no_role",
      wcag_criterion: "4.1.2",
      label: "Site-wide: Enter/Space handler for div buttons",
      findings: 0,
      low: EFFORT_MODEL.keyboardSnippet[0],
      high: EFFORT_MODEL.keyboardSnippet[1],
      advisory: false,
    });
  }

  const core = units.filter((u) => !u.advisory);
  const advisory = units.filter((u) => u.advisory);
  const [fixLow, fixHigh] = sum(core);

  // Contrast over images and gradients is checked by eye once per component
  const manualElements = new Set(
    excluded.filter((e) => e.reason === "needs_manual_check").map((e) => componentKey(e.finding)),
  ).size;
  const review = capped([
    manualElements * EFFORT_MODEL.manualCheckPerElement[0] + advisory.length * EFFORT_MODEL.reviewPerAdvisoryUnit[0],
    manualElements * EFFORT_MODEL.manualCheckPerElement[1] + advisory.length * EFFORT_MODEL.reviewPerAdvisoryUnit[1],
  ], EFFORT_MODEL.reviewCap);

  const contentUnits = core.filter((u) => u.kind === "content").length;
  const coordination = capped([
    fixLow * EFFORT_MODEL.coordinationShare + contentUnits * EFFORT_MODEL.coordinationPerContentUnit,
    fixHigh * EFFORT_MODEL.coordinationShare + contentUnits * EFFORT_MODEL.coordinationPerContentUnit,
  ], EFFORT_MODEL.coordinationCap);

  const hasWork = core.length > 0;
  const qa: Range = hasWork
    ? [fixLow * EFFORT_MODEL.qaShare + EFFORT_MODEL.qaFixed, fixHigh * EFFORT_MODEL.qaShare + EFFORT_MODEL.qaFixed]
    : [0, 0];
  const [advLow, advHigh] = sum(advisory);

  const items = {
    fixes: { label: `Fixes (${core.length} changes)`, low: fixLow, high: fixHigh },
    qa: { label: "QA and re-test (including a verify rescan)", low: qa[0], high: qa[1] },
    review: { label: `Manual review (${manualElements} components to check for contrast, ${advisory.length} advisory items)`, low: review[0], high: review[1] },
    coordination: { label: "Client coordination (approvals, copy and alt-text sign-off)", low: coordination[0], high: coordination[1] },
  };
  return {
    units,
    ...items,
    advisoryAddOn: { label: `Advisory fixes, if review confirms them (${advisory.length} changes)`, low: advLow, high: advHigh },
    low: items.fixes.low + items.qa.low + items.review.low + items.coordination.low,
    high: items.fixes.high + items.qa.high + items.review.high + items.coordination.high,
    manualCheckElements: manualElements,
    thirdParty: excluded.filter((e) => e.reason === "third_party").length,
  };
}

/** "~25–45 hours (≈ 3–6 days)" */
export function formatEstimate(estimate: Pick<RemediationEstimate, "low" | "high">): string {
  const low = Math.round(estimate.low);
  const high = Math.max(low, Math.round(estimate.high));
  if (high < 2) return "< 2 hours";
  const hours = low === high ? `~${high} hours` : `~${low}–${high} hours`;
  if (high < 8) return hours;
  const dLow = Math.max(1, Math.round(low / 8));
  const dHigh = Math.max(dLow, Math.round(high / 8));
  return `${hours} (≈ ${dLow === dHigh ? dHigh : `${dLow}–${dHigh}`} day${dHigh !== 1 ? "s" : ""})`;
}

export function formatHours(low: number, high: number): string {
  const r = (n: number) => (n < 1 ? n.toFixed(2).replace(/0$/, "") : n.toFixed(1).replace(/\.0$/, ""));
  return Math.abs(high - low) < 0.01 ? `${r(high)} h` : `${r(low)}–${r(high)} h`;
}

/** Hours of the unit a finding belongs to (first key). */
export function unitHoursFor(estimate: RemediationEstimate, finding: Finding, pageUrlOf: PageUrlOf = (id) => id): FixUnit | undefined {
  const key = unitKeysFor(finding, pageUrlOf)[0];
  return estimate.units.find((u) => u.key === key);
}
