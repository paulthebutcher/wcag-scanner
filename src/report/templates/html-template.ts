import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  Finding,
  CriterionResult,
  ScanSummary,
  Severity,
} from "../../types.js";
import type { ReportData, FindingGroup, ScanDiff } from "../generator.js";
import { getEffortHours } from "../generator.js";

// ---------------------------------------------------------------------------
// WCAG criterion names
// ---------------------------------------------------------------------------

const CRITERION_NAMES: Record<string, string> = {
  "1.1.1": "Non-text Content",
  "1.2.1": "Audio-only and Video-only (Prerecorded)",
  "1.2.2": "Captions (Prerecorded)",
  "1.2.3": "Audio Description or Media Alternative (Prerecorded)",
  "1.2.4": "Captions (Live)",
  "1.2.5": "Audio Description (Prerecorded)",
  "1.3.1": "Info and Relationships",
  "1.3.2": "Meaningful Sequence",
  "1.3.3": "Sensory Characteristics",
  "1.3.4": "Orientation",
  "1.3.5": "Identify Input Purpose",
  "1.3.6": "Identify Purpose",
  "1.4.1": "Use of Color",
  "1.4.2": "Audio Control",
  "1.4.3": "Contrast (Minimum)",
  "1.4.4": "Resize Text",
  "1.4.5": "Images of Text",
  "1.4.10": "Reflow",
  "1.4.11": "Non-text Contrast",
  "1.4.12": "Text Spacing",
  "1.4.13": "Content on Hover or Focus",
  "2.1.1": "Keyboard",
  "2.1.2": "No Keyboard Trap",
  "2.1.4": "Character Key Shortcuts",
  "2.2.1": "Timing Adjustable",
  "2.2.2": "Pause, Stop, Hide",
  "2.3.1": "Three Flashes or Below Threshold",
  "2.4.1": "Bypass Blocks",
  "2.4.2": "Page Titled",
  "2.4.3": "Focus Order",
  "2.4.4": "Link Purpose (In Context)",
  "2.4.5": "Multiple Ways",
  "2.4.6": "Headings and Labels",
  "2.4.7": "Focus Visible",
  "2.5.1": "Pointer Gestures",
  "2.5.2": "Pointer Cancellation",
  "2.5.3": "Label in Name",
  "2.5.4": "Motion Actuation",
  "3.1.1": "Language of Page",
  "3.1.2": "Language of Parts",
  "3.2.1": "On Focus",
  "3.2.2": "On Input",
  "3.2.3": "Consistent Navigation",
  "3.2.4": "Consistent Identification",
  "3.3.1": "Error Identification",
  "3.3.2": "Labels or Instructions",
  "3.3.3": "Error Suggestion",
  "3.3.4": "Error Prevention (Legal, Financial, Data)",
  "4.1.1": "Parsing",
  "4.1.2": "Name, Role, Value",
  "4.1.3": "Status Messages",
};

const ALL_CRITERIA = [
  "1.1.1", "1.2.1", "1.2.2", "1.2.3", "1.2.4", "1.2.5",
  "1.3.1", "1.3.2", "1.3.3", "1.3.4", "1.3.5", "1.3.6",
  "1.4.1", "1.4.2", "1.4.3", "1.4.4", "1.4.5", "1.4.10", "1.4.11", "1.4.12", "1.4.13",
  "2.1.1", "2.1.2", "2.1.4",
  "2.2.1", "2.2.2",
  "2.3.1",
  "2.4.1", "2.4.2", "2.4.3", "2.4.4", "2.4.5", "2.4.6", "2.4.7",
  "2.5.1", "2.5.2", "2.5.3", "2.5.4",
  "3.1.1", "3.1.2",
  "3.2.1", "3.2.2", "3.2.3", "3.2.4",
  "3.3.1", "3.3.2", "3.3.3", "3.3.4",
  "4.1.1", "4.1.2", "4.1.3",
];

// Sitewide threshold: an issue appearing on this many+ pages is sitewide
const SITEWIDE_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function resolveScreenshot(screenshotPath: string, dataDir?: string): string | null {
  if (!screenshotPath || !dataDir) return null;
  try {
    const fullPath = join(dataDir, screenshotPath);
    if (!existsSync(fullPath)) return null;
    const buf = readFileSync(fullPath);
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  advisory: 3,
};

function severityColor(severity: Severity): string {
  switch (severity) {
    case "critical": return "#dc2626";
    case "major": return "#ea580c";
    case "minor": return "#ca8a04";
    case "advisory": return "#6b7280";
  }
}

function severityBadge(severity: Severity): string {
  return `<span class="badge" style="background:${severityColor(severity)}">${esc(severity)}</span>`;
}

function statusBadge(status: string): string {
  const colors: Record<string, string> = {
    passed: "#16a34a",
    failed: "#dc2626",
    not_applicable: "#6b7280",
    not_tested: "#9ca3af",
  };
  // Display "no issues detected" instead of "passed" — avoids implying certification
  const labels: Record<string, string> = {
    passed: "no issues detected",
    failed: "failed",
    not_applicable: "not applicable",
    not_tested: "not tested",
  };
  const color = colors[status] ?? "#6b7280";
  const label = labels[status] ?? status.replace(/_/g, " ");
  return `<span class="badge" style="background:${color}">${esc(label)}</span>`;
}

function diffBadge(type: "fixed" | "new"): string {
  if (type === "fixed") {
    return '<span class="badge" style="background:#16a34a">Fixed</span>';
  }
  return '<span class="badge" style="background:#dc2626">New</span>';
}

/** Humanize a failure_type code into readable text */
function humanizeFailureType(ft: string): string {
  return ft.replace(/[_-]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Plain-language descriptions keyed by criterion code or criterion:failure_type.
 * Used for the executive summary fallback when LLM synthesis is not available.
 * Written for a non-technical reader — no JSON, no measurement values.
 */
const PLAIN_DESCRIPTIONS: Record<string, (count: number, pages: number) => string> = {
  "2.4.7:focus_indicator_low_contrast": (n, p) =>
    `${n} interactive element${n !== 1 ? "s" : ""} across ${p} page${p !== 1 ? "s" : ""} lack${n === 1 ? "s" : ""} visible focus indicators, making keyboard navigation difficult for users who don't use a mouse.`,
  "2.4.7:no_visible_focus_indicator": (n, p) =>
    `${n} interactive element${n !== 1 ? "s" : ""} across ${p} page${p !== 1 ? "s" : ""} ha${n === 1 ? "s" : "ve"} no visible focus indicator, preventing keyboard users from seeing which element is selected.`,
  "2.4.4:link-name": (n, p) =>
    `${n} links across ${p} pages have no accessible name, so screen reader users cannot tell where these links go.`,
  "2.4.4:image_link_no_alt": (n, p) =>
    `${n} image links across ${p} pages are missing alt text, leaving screen reader users unable to understand the link's purpose.`,
  "1.1.1:semantic": (n, p) =>
    `${n} images across ${p} pages are missing descriptive alt text, which means screen reader users cannot understand the image content.`,
  "1.1.1:empty_alt_on_informative": (n, p) =>
    `${n} informative images across ${p} pages have empty alt text, hiding meaningful content from screen reader users.`,
  "2.1.1:unreachable_interactive_element": (n, p) =>
    `${n} interactive elements across ${p} pages cannot be reached using a keyboard, blocking users who rely on keyboard navigation.`,
  "1.4.3:color-contrast": (n, p) =>
    `${n} text elements across ${p} pages have insufficient color contrast, making them difficult to read for users with low vision.`,
  "2.4.1:missing_skip_navigation": (n, p) =>
    `${n} page${n !== 1 ? "s" : ""} lack${n === 1 ? "s" : ""} a skip navigation link, forcing keyboard users to tab through every navigation item to reach the main content.`,
  "2.4.3:focus_order_mismatch": (n, p) =>
    `${n} elements across ${p} pages have a tab order that doesn't match the visual layout, creating a confusing navigation experience for keyboard users.`,
  "2.4.5:insufficient_navigation_methods": (n, p) =>
    `${n} page${n !== 1 ? "s" : ""} offer${n === 1 ? "s" : ""} only one way to find content (e.g. navigation links), without a sitemap or search — a barrier for users who navigate differently.`,
  "2.4.6:missing_heading": (n, p) =>
    `${n} page section${n !== 1 ? "s" : ""} across ${p} page${p !== 1 ? "s" : ""} lack${n === 1 ? "s" : ""} heading elements, making it harder for screen reader users to scan and navigate the page structure.`,
  "2.4.6:skipped_level": (n, p) =>
    `${n} headings across ${p} pages skip hierarchy levels (e.g. H2 to H4), confusing screen reader users who rely on heading structure to navigate.`,
  "1.3.5:missing_autocomplete": (n, p) =>
    `${n} form fields across ${p} pages are missing the autocomplete attribute, preventing browsers and assistive tools from auto-filling known user information.`,
  "3.3.4:high_risk_form": (n, p) =>
    `${n} form${n !== 1 ? "s" : ""} handling legal or financial data lack${n === 1 ? "s" : ""} a confirmation step, increasing the risk of accidental submission.`,
  // New checks
  "1.3.1:duplicate_nav_landmark": (n, p) =>
    `${n} navigation landmarks across ${p} pages are missing unique labels, so screen readers announce them identically with no way to distinguish between them.`,
  "1.3.1:unlabeled_nav_landmark": (n, p) =>
    `${n} navigation landmark${n !== 1 ? "s" : ""} across ${p} pages lack${n === 1 ? "s" : ""} an aria-label, making it unnamed in screen reader landmark navigation.`,
  "4.1.2:missing_aria_expanded": (n, p) =>
    `${n} accordion or disclosure widget${n !== 1 ? "s" : ""} across ${p} page${p !== 1 ? "s" : ""} lack${n === 1 ? "s" : ""} aria-expanded, so screen readers cannot tell whether content sections are open or closed.`,
  "4.1.2:missing_tab_role": (n, p) =>
    `${n} tab interface${n !== 1 ? "s" : ""} across ${p} page${p !== 1 ? "s" : ""} lack${n === 1 ? "s" : ""} proper ARIA tab roles, making the tab pattern invisible to screen reader users.`,
  "4.1.2:custom_interactive_no_role": (n, p) =>
    `${n} custom interactive element${n !== 1 ? "s" : ""} across ${p} pages have no ARIA role or keyboard support, making them invisible and unusable for assistive technology users.`,
  "1.3.1:table_no_caption": (n, p) =>
    `${n} data table${n !== 1 ? "s" : ""} across ${p} page${p !== 1 ? "s" : ""} lack${n === 1 ? "s" : ""} a caption or aria-label, so screen reader users cannot identify the table's purpose.`,
  "1.3.1:table_header_no_scope": (n, p) =>
    `${n} table header cell${n !== 1 ? "s" : ""} across ${p} page${p !== 1 ? "s" : ""} lack${n === 1 ? "s" : ""} scope attributes, preventing screen readers from associating headers with data cells.`,
  "1.3.1:table_missing_headers": (n, p) =>
    `${n} data table${n !== 1 ? "s" : ""} across ${p} pages have no header cells, making it impossible for screen readers to describe the data structure.`,
  "2.4.4:duplicate_link_text": (n, p) =>
    `${n} group${n !== 1 ? "s" : ""} of links across ${p} pages share identical text but point to different destinations, so screen reader users cannot tell them apart.`,
};

/** Build a plain-English description for a finding group (no raw evidence). */
function plainDescription(group: FindingGroup): string {
  const pages = distinctPageCount(group);
  const key = `${group.criterion}:${group.failureType}`;
  const fn = PLAIN_DESCRIPTIONS[key];
  if (fn) return fn(group.instanceCount, pages);

  // Generic fallback from criterion name + failure type — still no raw evidence
  const name = CRITERION_NAMES[group.criterion] ?? group.criterion;
  const ft = humanizeFailureType(group.failureType);
  return `${group.instanceCount} instance${group.instanceCount !== 1 ? "s" : ""} of "${ft}" across ${pages} page${pages !== 1 ? "s" : ""} violate WCAG ${group.criterion} (${name}).`;
}

/** Count distinct pages a finding group spans */
function distinctPageCount(group: FindingGroup): number {
  return new Set(group.findings.map(f => f.page_snapshot_id)).size;
}

// Effort hours are computed via getEffortHours() from generator.ts

// ---------------------------------------------------------------------------
// Failure type → human-readable category label (Fix 1)
// ---------------------------------------------------------------------------

const FAILURE_TYPE_CATEGORIES: Record<string, string> = {
  "link-name": "Link Purpose",
  "image_link_no_alt": "Link Purpose",
  "empty_link": "Link Purpose",
  "non_descriptive_link": "Link Purpose",
  "duplicate_link_text": "Link Purpose",
  "ambiguous_without_context": "Link Purpose",
  "generic_link_text": "Link Purpose",
  "url_as_link_text": "Link Purpose",
  "color-contrast": "Color Contrast",
  "insufficient_contrast": "Color Contrast",
  "color_alone": "Color Contrast",
  "focus_indicator_low_contrast": "Focus Visibility",
  "no_visible_focus_indicator": "Focus Visibility",
  "no_focus_indicator": "Focus Visibility",
  "unreachable_interactive_element": "Keyboard Access",
  "not_keyboard_accessible": "Keyboard Access",
  "tabs_keyboard": "Keyboard Access",
  "dropdown_keyboard": "Keyboard Access",
  "missing_alt": "Images & Alt Text",
  "semantic": "Images & Alt Text",
  "empty_alt_on_informative": "Images & Alt Text",
  "decorative_with_alt": "Images & Alt Text",
  "missing_skip_navigation": "Navigation",
  "missing_skip_link": "Navigation",
  "insufficient_navigation_methods": "Navigation",
  "duplicate_nav_landmark": "Navigation",
  "unlabeled_nav_landmark": "Navigation",
  "focus_order_mismatch": "Focus Order",
  "skipped_level": "Heading Structure",
  "missing_heading": "Heading Structure",
  "heading_hierarchy": "Heading Structure",
  "missing_form_label": "Forms",
  "missing_required_indication": "Forms",
  "error_not_announced": "Forms",
  "high_risk_form": "Forms",
  "missing_autocomplete": "Forms",
  "input_purpose": "Forms",
  "missing_lang": "Language",
  "missing_title": "Page Title",
  "missing_aria_expanded": "Widget ARIA",
  "missing_tab_role": "Widget ARIA",
  "custom_interactive_no_role": "Widget ARIA",
  "table_no_caption": "Tables",
  "table_header_no_scope": "Tables",
  "table_missing_headers": "Tables",
  "layout_table": "Tables",
  "modal_focus_trap": "Focus Management",
};

/** Get a human-readable category label for a failure type. */
function categoryLabel(failureType: string): string {
  return FAILURE_TYPE_CATEGORIES[failureType] ?? humanizeFailureType(failureType);
}

// ---------------------------------------------------------------------------
// Template-aware unique fix counting (Fix 2)
// ---------------------------------------------------------------------------

/**
 * Failure types whose remediation is a single global fix (e.g., one CSS rule
 * or one JS snippet) regardless of how many elements are affected.
 */
const GLOBAL_FIX_TYPES = new Set([
  "focus_indicator_low_contrast",
  "no_visible_focus_indicator",
  "no_focus_indicator",
  "missing_skip_navigation",
  "missing_skip_link",
  "insufficient_navigation_methods",
]);

/**
 * Count unique fixes needed within a finding group by deduplicating
 * on element_html. The same nav link appearing on 15 pages = 1 fix.
 *
 * Special case: failure types that resolve with a single global fix
 * (e.g., a CSS :focus-visible rule) always count as 1 fix.
 */
function countUniqueFixes(group: FindingGroup): number {
  // Global fixes: one CSS rule or one embed resolves all instances
  if (GLOBAL_FIX_TYPES.has(group.failureType)) return 1;

  // Also detect global fixes from the remediation content: if the fix
  // is a <style> block or site-wide JS snippet, it's 1 fix.
  const codeFix = group.findings[0]?.remediation.code_fix ?? "";
  if (codeFix.includes("<style>") || codeFix.includes("document.querySelector")) return 1;

  const seen = new Set<string>();
  for (const f of group.findings) {
    const key = f.evidence.element_html.trim();
    if (key) seen.add(key);
  }
  return Math.max(seen.size, 1);
}

// ---------------------------------------------------------------------------
// Platform name formatting (Fix 7)
// ---------------------------------------------------------------------------

const PLATFORM_DISPLAY: Record<string, string> = {
  webflow: "Webflow",
  squarespace: "Squarespace",
  shopify: "Shopify",
  wordpress: "WordPress",
  framer: "Framer",
  unknown: "Unknown",
};

function formatPlatform(platform: string): string {
  return PLATFORM_DISPLAY[platform] ?? platform;
}

// ---------------------------------------------------------------------------
// Subtype labeling for duplicate criteria
// ---------------------------------------------------------------------------

/**
 * Build a display-name lookup for finding groups. When multiple groups share
 * the same WCAG criterion, append " — <subtype>" derived from the failure
 * type to disambiguate them for the reader.
 */
function buildGroupDisplayNames(groups: FindingGroup[]): Map<string, string> {
  // Count how many groups share each criterion
  const criterionCounts = new Map<string, number>();
  for (const g of groups) {
    criterionCounts.set(g.criterion, (criterionCounts.get(g.criterion) ?? 0) + 1);
  }

  const names = new Map<string, string>();
  for (const g of groups) {
    const baseName = CRITERION_NAMES[g.criterion] ?? g.criterion;
    if ((criterionCounts.get(g.criterion) ?? 0) > 1) {
      // Append humanized failure type as subtype label
      const subtype = humanizeFailureType(g.failureType).toLowerCase();
      names.set(g.hash, `${baseName} — ${subtype}`);
    } else {
      names.set(g.hash, baseName);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Element snippet filtering (Fix 2 & 3)
// ---------------------------------------------------------------------------

/** Returns true if the element_html is a synthetic/internal artifact that should be filtered out. */
function isSyntheticElement(html: string): boolean {
  if (!html) return true;
  const trimmed = html.trim();
  // Playwright focus-order-summary artifact
  if (trimmed.startsWith("<focus-order-summary")) return true;
  return false;
}

/** Returns true if the element references the document root rather than a specific element. */
function isDocumentRoot(html: string): boolean {
  if (!html) return false;
  const trimmed = html.trim();
  // Bare <html> or <html> with only page metadata
  if (/^<html\s*>/.test(trimmed)) return true;
  if (/^<html>\s*\(page:/.test(trimmed)) return true;
  return false;
}

/** Returns true if a finding's element should be excluded from snippet rendering. */
function shouldFilterSnippet(f: Finding): boolean {
  return isSyntheticElement(f.evidence.element_html);
}

/** Returns true if a finding's element is the document root and should be replaced with a page-level note. */
function isPageLevelFinding(f: Finding): boolean {
  return isDocumentRoot(f.evidence.element_html);
}

// ---------------------------------------------------------------------------
// 1. Cover page
// ---------------------------------------------------------------------------

function renderCover(data: ReportData, executiveSummaryHtml?: string): string {
  const session = data.scanSession;
  const scanDate = new Date(session.initiated_at).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });

  // Try to extract grade from executive summary HTML if available
  let gradeHtml = "";
  if (executiveSummaryHtml) {
    // Look for the grade card rendered by synthesis.ts formatExecutiveSummaryHtml
    const gradeMatch = executiveSummaryHtml.match(/font-size:3rem[^>]*>([A-F])</);
    if (gradeMatch) {
      const grade = gradeMatch[1];
      const gradeColors: Record<string, string> = { A: "#16a34a", B: "#65a30d", C: "#ca8a04", D: "#ea580c", F: "#dc2626" };
      const color = gradeColors[grade] ?? "#6b7280";
      gradeHtml = `
        <div class="cover-grade">
          <div class="grade-circle" style="border-color:${color};color:${color}">${esc(grade)}</div>
          <div class="grade-label">Compliance Grade</div>
        </div>`;
    }
  }

  const summary = data.summary;
  const statsHtml = summary ? `
    <div class="cover-stats">
      <div class="cover-stat"><span class="cover-stat-num">${data.groups.length}</span><span class="cover-stat-label">Issue Types</span></div>
      <div class="cover-stat"><span class="cover-stat-num">${summary.total_findings}</span><span class="cover-stat-label">Total Instances</span></div>
      <div class="cover-stat"><span class="cover-stat-num" style="color:#dc2626">${summary.by_severity.critical}</span><span class="cover-stat-label">Critical</span></div>
      <div class="cover-stat"><span class="cover-stat-num" style="color:#ea580c">${summary.by_severity.major}</span><span class="cover-stat-label">Major</span></div>
      <div class="cover-stat"><span class="cover-stat-num" style="color:#ca8a04">${summary.by_severity.minor}</span><span class="cover-stat-label">Minor</span></div>
      <div class="cover-stat"><span class="cover-stat-num" style="color:#6b7280">${summary.by_severity.advisory}</span><span class="cover-stat-label">Advisory</span></div>
    </div>` : "";

  return `
    <section class="cover-page">
      <div class="cover-title">
        <h1>WCAG 2.1 AA<br>Accessibility Assessment</h1>
      </div>
      ${gradeHtml}
      <div class="cover-info">
        <table class="cover-meta">
          <tr><td class="cover-meta-label">Site</td><td>${esc(session.url)}</td></tr>
          <tr><td class="cover-meta-label">Scan Date</td><td>${scanDate}</td></tr>
          <tr><td class="cover-meta-label">Platform</td><td>${esc(formatPlatform(session.platform))}</td></tr>
        </table>
      </div>
      ${statsHtml}
    </section>`;
}

// ---------------------------------------------------------------------------
// 2. Executive Summary
// ---------------------------------------------------------------------------

function renderExecutiveSummary(data: ReportData, executiveSummaryHtml?: string): string {
  if (executiveSummaryHtml) {
    return `
    <section class="executive-summary" id="executive-summary">
      <h2>Executive Summary</h2>
      ${executiveSummaryHtml}
    </section>`;
  }

  // Fallback: generate plain-language summary from raw findings
  return renderFallbackExecutiveSummary(data);
}

function renderFallbackExecutiveSummary(data: ReportData): string {
  const summary = data.summary;
  const groups = data.groups;
  const criterionResults = data.criterionResults;

  const totalInstances = summary?.total_findings ?? groups.reduce((s, g) => s + g.instanceCount, 0);
  const failedCriteria = summary?.wcag_criteria_failed ?? [...new Set(groups.map(g => g.criterion))];
  const passedCriteria = summary?.wcag_criteria_passed ?? [];
  const totalFailed = failedCriteria.length;
  const totalPassed = passedCriteria.length;
  // "Tested" = criteria with a definitive pass/fail result (not N/A or not-tested)
  const totalTested = totalPassed + totalFailed;
  // Count N/A and not-tested from ALL_CRITERIA, not just DB rows.
  // Criteria missing from the DB entirely are also "not tested".
  const crResultMap = new Map(criterionResults.map(r => [r.wcag_criterion, r]));
  let totalNA = 0;
  let totalNotTested = 0;
  for (const c of ALL_CRITERIA) {
    const status = crResultMap.get(c)?.status;
    if (status === "not_applicable") totalNA++;
    else if (status === "not_tested" || status === undefined) totalNotTested++;
  }

  // Determine posture
  const critical = summary?.by_severity.critical ?? groups.filter(g => g.severity === "critical").reduce((s, g) => s + g.instanceCount, 0);
  const major = summary?.by_severity.major ?? groups.filter(g => g.severity === "major").reduce((s, g) => s + g.instanceCount, 0);

  let posture: string;
  if (critical > 0) {
    posture = `This site <strong>does not meet WCAG 2.1 AA compliance</strong>. The audit identified ${totalFailed} failed criteria with ${critical} critical issue${critical !== 1 ? "s" : ""} that prevent some users from accessing core functionality.`;
  } else if (major > 0) {
    posture = `This site has <strong>significant accessibility gaps</strong>. While no critical barriers were found, ${totalFailed} criteria failed with ${major} major issue${major !== 1 ? "s" : ""} that create substantial difficulty for users with disabilities.`;
  } else if (totalFailed > 0) {
    posture = `This site has <strong>minor accessibility issues</strong>. ${totalFailed} criteria did not pass, though no critical or major barriers were identified.`;
  } else {
    posture = `<strong>No issues were detected</strong> across the tested criteria in the scanned sample. This does not constitute a certification of full WCAG 2.1 AA compliance.`;
  }

  // Top 3 finding types by severity then count
  const top3 = groups
    .sort((a, b) => {
      const sd = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      return sd !== 0 ? sd : b.instanceCount - a.instanceCount;
    })
    .slice(0, 3);

  const top3Html = top3.length > 0
    ? `<h3>Top Issues</h3>
       <ol class="top-issues">
         ${top3.map(g => {
           const name = CRITERION_NAMES[g.criterion] ?? g.criterion;
           const desc = plainDescription(g);
           return `<li>${severityBadge(g.severity)} <strong>${esc(g.criterion)} ${esc(name)}</strong><br><span class="top-issue-desc">${esc(desc)}</span></li>`;
         }).join("")}
       </ol>`
    : "";

  // Summary stats grid — "Criteria Tested" = passed + failed only
  const notTestedCard = totalNotTested > 0
    ? `<div class="summary-card">
        <div class="summary-number" style="color:#9ca3af">${totalNotTested}</div>
        <div class="summary-label">Not Tested</div>
      </div>`
    : "";

  const statsHtml = `
    <div class="summary-grid">
      <div class="summary-card">
        <div class="summary-number">${totalTested}</div>
        <div class="summary-label">Criteria Tested</div>
      </div>
      <div class="summary-card" style="border-color:#16a34a">
        <div class="summary-number" style="color:#16a34a">${totalPassed}</div>
        <div class="summary-label">Passed</div>
      </div>
      <div class="summary-card" style="border-color:#dc2626">
        <div class="summary-number" style="color:#dc2626">${totalFailed}</div>
        <div class="summary-label">Failed</div>
      </div>
      <div class="summary-card">
        <div class="summary-number" style="color:#6b7280">${totalNA}</div>
        <div class="summary-label">Not Applicable</div>
      </div>
      ${notTestedCard}
      <div class="summary-card">
        <div class="summary-number">${data.groups.length}</div>
        <div class="summary-label">Issue Types</div>
        <div class="summary-detail">${totalInstances} total instances</div>
      </div>
    </div>`;

  const effortHtml = summary?.estimated_total_effort
    ? `<p><strong>Estimated Remediation Effort:</strong> ${esc(summary.estimated_total_effort)}</p>`
    : "";

  return `
    <section class="executive-summary" id="executive-summary">
      <h2>Executive Summary</h2>
      <p>${posture}</p>
      ${statsHtml}
      ${top3Html}
      ${effortHtml}
    </section>`;
}

// ---------------------------------------------------------------------------
// 3. Compliance Scorecard (criterion matrix)
// ---------------------------------------------------------------------------

function renderComplianceScorecard(criterionResults: CriterionResult[]): string {
  const resultMap = new Map(criterionResults.map(r => [r.wcag_criterion, r]));

  // Count statuses for the header
  let passed = 0, failed = 0, na = 0, nt = 0;
  for (const c of ALL_CRITERIA) {
    const status = resultMap.get(c)?.status ?? "not_tested";
    if (status === "passed") passed++;
    else if (status === "failed") failed++;
    else if (status === "not_applicable") na++;
    else nt++;
  }

  const rows = ALL_CRITERIA.map(criterion => {
    const result = resultMap.get(criterion);
    const name = CRITERION_NAMES[criterion] ?? criterion;
    const status = result?.status ?? "not_tested";
    const testedBy = result?.tested_by ?? "-";

    return `
      <tr>
        <td>${esc(criterion)}</td>
        <td>${esc(name)}</td>
        <td>${statusBadge(status)}</td>
        <td>${esc(testedBy)}</td>
      </tr>`;
  });

  return `
    <section class="scorecard" id="compliance-scorecard">
      <h2>Compliance Scorecard</h2>
      <p class="scorecard-summary">
        <span class="scorecard-stat" style="color:#16a34a"><strong>${passed}</strong> no issues detected</span> &bull;
        <span class="scorecard-stat" style="color:#dc2626"><strong>${failed}</strong> failed</span> &bull;
        <span class="scorecard-stat" style="color:#6b7280"><strong>${na}</strong> not applicable</span> &bull;
        <span class="scorecard-stat" style="color:#9ca3af"><strong>${nt}</strong> not tested</span>
      </p>
      <table class="scorecard-table">
        <thead>
          <tr>
            <th>Criterion</th>
            <th>Name</th>
            <th>Status</th>
            <th>Tested By</th>
          </tr>
        </thead>
        <tbody>
          ${rows.join("")}
        </tbody>
      </table>
    </section>`;
}

// ---------------------------------------------------------------------------
// 4. Findings by Type (cards with inline snippets)
// ---------------------------------------------------------------------------

function renderFindingTypeCard(
  group: FindingGroup,
  pageUrlMap: Map<string, string>,
  impactDescriptions?: Map<string, string>,
  badgeType?: "fixed" | "new",
  dataDir?: string,
  displayNames?: Map<string, string>,
): string {
  const criterionName = displayNames?.get(group.hash) ?? CRITERION_NAMES[group.criterion] ?? group.criterion;
  const pages = distinctPageCount(group);
  const isSitewide = pages >= SITEWIDE_THRESHOLD;
  const uniqueFixes = countUniqueFixes(group);
  const cat = categoryLabel(group.failureType);

  const badge = badgeType ? ` ${diffBadge(badgeType)}` : "";

  // "What's wrong" — plain-language description
  const impactText = impactDescriptions?.get(group.hash);
  const description = impactText ?? plainDescription(group);
  const whatWrongHtml = `<div class="card-what-wrong"><h4>What&rsquo;s Wrong</h4><p>${esc(description)}</p></div>`;

  // Sitewide / template-aware callout
  let sitewideHtml = "";
  if (isSitewide) {
    const fixNote = uniqueFixes < group.instanceCount
      ? ` Estimated <strong>${uniqueFixes} unique fix${uniqueFixes !== 1 ? "es" : ""}</strong> needed &mdash; the remaining instances share the same template element.`
      : "";
    sitewideHtml = `<div class="sitewide-callout">This issue appears across ${pages} of ${pageUrlMap.size || pages} pages and likely requires a template-level fix.${fixNote}</div>`;
  }

  // Affected page paths list
  let affectedPagesHtml = "";
  if (pages > 1) {
    const uniquePages = new Map<string, string>();
    for (const f of group.findings) {
      if (uniquePages.has(f.page_snapshot_id)) continue;
      const url = pageUrlMap.get(f.page_snapshot_id) ?? "";
      let pathname = "";
      try { pathname = url ? new URL(url).pathname : ""; } catch { pathname = url; }
      if (pathname) uniquePages.set(f.page_snapshot_id, pathname);
    }
    const allPaths = Array.from(uniquePages.values()).sort();
    const VISIBLE_LIMIT = 8;
    const visiblePaths = allPaths.slice(0, VISIBLE_LIMIT);
    const hiddenCount = allPaths.length - visiblePaths.length;
    const pathItems = visiblePaths.map(p => `<code>${esc(p)}</code>`).join(", ");
    if (hiddenCount > 0) {
      const hiddenItems = allPaths.slice(VISIBLE_LIMIT).map(p => `<code>${esc(p)}</code>`).join(", ");
      affectedPagesHtml = `<div class="affected-pages"><strong>Affected pages:</strong> ${pathItems} <details class="affected-pages-more"><summary>and ${hiddenCount} more</summary>${hiddenItems}</details></div>`;
    } else {
      affectedPagesHtml = `<div class="affected-pages"><strong>Affected pages:</strong> ${pathItems}</div>`;
    }
  }

  // Remediation: "How to fix" with platform-specific steps + example
  const groupRemediation = group.findings.find(f => f.remediation.platform_fix.steps.length > 0)?.remediation;
  const platformName = formatPlatform(group.findings[0]?.remediation.platform_fix.platform ?? "webflow");
  let remediationHtml = "";
  if (groupRemediation && groupRemediation.generic_fix) {
    remediationHtml = `
      <div class="card-remediation">
        <h4>How to Fix in ${esc(platformName)}</h4>
        <p>${esc(groupRemediation.generic_fix)}</p>
        ${groupRemediation.platform_fix.designer_path
          ? `<p class="designer-path"><strong>${esc(platformName)}:</strong> ${esc(groupRemediation.platform_fix.designer_path)}</p>`
          : ""}
        ${groupRemediation.platform_fix.steps.length > 0
          ? `<ol class="remediation-steps-list">${groupRemediation.platform_fix.steps.map(s => `<li>${esc(s)}</li>`).join("")}</ol>`
          : ""}
        ${groupRemediation.code_fix
          ? `<h5>Example Fix</h5><div class="code-block"><pre><code>${esc(groupRemediation.code_fix)}</code></pre></div>`
          : ""}
      </div>`;
  }

  // Top 3 affected element snippets inline — filter out synthetics,
  // replace document-root references with a page-level note.
  // Pull from later in the list if early entries are filtered.
  const renderedSnippets: string[] = [];
  let hasPageLevelNote = false;

  for (const f of group.findings) {
    if (renderedSnippets.length >= 3) break;

    // Skip internal Playwright artifacts entirely
    if (shouldFilterSnippet(f)) continue;

    // Replace document-root references with a plain-language note
    if (isPageLevelFinding(f)) {
      if (!hasPageLevelNote) {
        renderedSnippets.push(`
          <div class="snippet snippet-page-level">
            <em>Affects the entire page &mdash; no specific element.</em>
          </div>`);
        hasPageLevelNote = true;
      }
      continue;
    }

    const url = pageUrlMap.get(f.page_snapshot_id) ?? "";
    let urlShort = "";
    try { urlShort = url ? new URL(url).pathname : ""; } catch { urlShort = url; }

    let screenshotHtml = "";
    if (f.evidence.element_screenshot) {
      const dataUri = resolveScreenshot(f.evidence.element_screenshot, dataDir);
      if (dataUri) {
        screenshotHtml = `<img class="snippet-screenshot" src="${dataUri}" alt="Element screenshot">`;
      }
    }

    const htmlSnippet = f.evidence.element_html
      ? `<div class="code-block snippet-code"><pre><code>${esc(f.evidence.element_html)}</code></pre></div>`
      : "";

    renderedSnippets.push(`
      <div class="snippet">
        ${urlShort ? `<span class="snippet-url">${esc(urlShort)}</span>` : ""}
        ${screenshotHtml}
        ${htmlSnippet}
      </div>`);
  }

  const snippetsHtml = renderedSnippets.join("");

  // Only show "more" count based on non-filtered instances
  const realInstanceCount = group.findings.filter(f => !shouldFilterSnippet(f)).length;
  const shownCount = renderedSnippets.length;
  const moreCount = realInstanceCount - shownCount;
  const moreHtml = moreCount > 0
    ? `<p class="snippet-more">&hellip; and ${moreCount} more instance${moreCount !== 1 ? "s" : ""} across ${pages} page${pages !== 1 ? "s" : ""}</p>`
    : "";

  // Omit the Affected Elements section entirely if no snippets remain
  const snippetsSectionHtml = renderedSnippets.length > 0
    ? `<div class="card-snippets">
        <h4>Affected Elements</h4>
        ${snippetsHtml}
        ${moreHtml}
      </div>`
    : "";

  return `
    <div class="finding-card">
      <div class="card-header">
        <h3>
          ${severityBadge(group.severity)}${badge}
          ${esc(group.criterion)} &mdash; ${esc(criterionName)}
        </h3>
        <p class="card-meta">
          ${group.instanceCount} instance${group.instanceCount !== 1 ? "s" : ""} across ${pages} page${pages !== 1 ? "s" : ""}
          ${uniqueFixes < group.instanceCount ? ` &mdash; ${uniqueFixes} unique fix${uniqueFixes !== 1 ? "es" : ""}` : ""}
          &bull; ${esc(cat)}
        </p>
      </div>
      ${sitewideHtml}
      ${affectedPagesHtml}
      ${whatWrongHtml}
      ${remediationHtml}
      ${snippetsSectionHtml}
    </div>`;
}

function renderFindingsByType(
  data: ReportData,
  pageUrlMap: Map<string, string>,
  impactDescriptions?: Map<string, string>,
  dataDir?: string,
): string {
  if (data.diff) {
    return renderDiffFindings(data, pageUrlMap, impactDescriptions, dataDir);
  }

  if (data.groups.length === 0) {
    return `
    <section class="findings-by-type" id="findings-by-type">
      <h2>Findings by Type</h2>
      <p>No accessibility violations detected.</p>
    </section>`;
  }

  const displayNames = buildGroupDisplayNames(data.groups);

  return `
    <section class="findings-by-type" id="findings-by-type">
      <h2>Findings by Type</h2>
      <p class="section-intro">${data.groups.length} unique issue type${data.groups.length !== 1 ? "s" : ""} identified. Each card represents a single type of fix, regardless of how many pages it appears on.</p>
      ${data.groups.map(g => renderFindingTypeCard(g, pageUrlMap, impactDescriptions, undefined, dataDir, displayNames)).join("")}
    </section>`;
}

function renderDiffFindings(
  data: ReportData,
  pageUrlMap: Map<string, string>,
  impactDescriptions?: Map<string, string>,
  dataDir?: string,
): string {
  const diff = data.diff!;
  const allDiffGroups = [...diff.resolved, ...diff.newFindings, ...diff.persistent];
  const displayNames = buildGroupDisplayNames(allDiffGroups);
  const sections: string[] = [];

  if (diff.resolved.length > 0) {
    sections.push(`
      <h3 class="diff-section-title">Resolved Issues</h3>
      ${diff.resolved.map(g => renderFindingTypeCard(g, pageUrlMap, impactDescriptions, "fixed", dataDir, displayNames)).join("")}`);
  }
  if (diff.newFindings.length > 0) {
    sections.push(`
      <h3 class="diff-section-title">New Issues</h3>
      ${diff.newFindings.map(g => renderFindingTypeCard(g, pageUrlMap, impactDescriptions, "new", dataDir, displayNames)).join("")}`);
  }
  if (diff.persistent.length > 0) {
    sections.push(`
      <h3 class="diff-section-title">Persistent Issues</h3>
      ${diff.persistent.map(g => renderFindingTypeCard(g, pageUrlMap, impactDescriptions, undefined, dataDir, displayNames)).join("")}`);
  }

  return `
    <section class="findings-by-type" id="findings-by-type">
      <h2>Findings</h2>
      ${sections.join("")}
    </section>`;
}

// ---------------------------------------------------------------------------
// 5. Appendix: Findings by Page (condensed)
// ---------------------------------------------------------------------------

interface PageGroup {
  url: string;
  snapshotId: string;
  findings: Finding[];
}

function groupFindingsByPage(
  groups: FindingGroup[],
  pageUrlMap: Map<string, string>,
): PageGroup[] {
  const pageMap = new Map<string, Finding[]>();
  for (const group of groups) {
    for (const finding of group.findings) {
      const existing = pageMap.get(finding.page_snapshot_id);
      if (existing) {
        existing.push(finding);
      } else {
        pageMap.set(finding.page_snapshot_id, [finding]);
      }
    }
  }

  const pageGroups: PageGroup[] = [];
  for (const [snapshotId, findings] of pageMap) {
    const url = pageUrlMap.get(snapshotId) ?? snapshotId;
    pageGroups.push({ url, snapshotId, findings });
  }
  pageGroups.sort((a, b) => b.findings.length - a.findings.length);
  return pageGroups;
}

function renderAppendixByPage(
  data: ReportData,
  pageUrlMap: Map<string, string>,
): string {
  if (data.groups.length === 0) return "";

  // Build a consolidated summary table: one row per finding type showing
  // which pages are affected, instead of repeating per-page breakdowns.
  const summaryRows = data.groups
    .sort((a, b) => {
      const sd = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      return sd !== 0 ? sd : b.instanceCount - a.instanceCount;
    })
    .map(g => {
      const name = CRITERION_NAMES[g.criterion] ?? g.criterion;
      const pages = distinctPageCount(g);
      const fixes = countUniqueFixes(g);
      const cat = categoryLabel(g.failureType);
      return `<tr>
        <td>${severityBadge(g.severity)}</td>
        <td>${esc(g.criterion)} ${esc(name)}</td>
        <td>${esc(cat)}</td>
        <td>${pages}</td>
        <td>${g.instanceCount}</td>
        <td>${fixes}</td>
      </tr>`;
    }).join("");

  // Also show per-page breakdown only for pages with DIFFERENT violation
  // profiles (i.e., pages that have violations not shared by the majority).
  // Find the "baseline" pattern — violation types that appear on most pages.
  const pageGroups = groupFindingsByPage(data.groups, pageUrlMap);
  const totalPages = pageGroups.length;

  // Build per-page violation signature to find outliers
  const signatures = new Map<string, PageGroup[]>();
  for (const pg of pageGroups) {
    const sig = [...new Set(pg.findings.map(f => f.wcag_criterion))].sort().join(",");
    const existing = signatures.get(sig);
    if (existing) existing.push(pg);
    else signatures.set(sig, [pg]);
  }

  // Find the most common signature and treat pages with different signatures as outliers
  let majoritySignature = "";
  let majorityCount = 0;
  for (const [sig, pgs] of signatures) {
    if (pgs.length > majorityCount) {
      majorityCount = pgs.length;
      majoritySignature = sig;
    }
  }

  const majoritySet = new Set(majoritySignature.split(",").filter(Boolean));
  const outlierPages = pageGroups.filter(pg => {
    const sig = [...new Set(pg.findings.map(f => f.wcag_criterion))].sort().join(",");
    return sig !== majoritySignature;
  });

  let outlierHtml = "";
  if (outlierPages.length > 0 && outlierPages.length < totalPages) {
    const outlierRows = outlierPages.map(pg => {
      const criteria = [...new Set(pg.findings.map(f => f.wcag_criterion))];
      // Show criteria that differ from the majority: extra ones this page has,
      // plus ones the majority has that this page is missing.
      const extra = criteria.filter(c => !majoritySet.has(c));
      const missing = [...majoritySet].filter(c => !criteria.includes(c));

      const parts: string[] = [];
      if (extra.length > 0) {
        parts.push(extra.map(c => `${c} ${CRITERION_NAMES[c] ?? ""}`.trim()).join(", "));
      }
      if (missing.length > 0) {
        parts.push(`missing: ${missing.map(c => `${c}`.trim()).join(", ")}`);
      }
      // If somehow both are empty (shouldn't happen), show all criteria for this page
      const label = parts.length > 0
        ? parts.join("; ")
        : criteria.map(c => `${c} ${CRITERION_NAMES[c] ?? ""}`.trim()).join(", ");

      let urlPath = pg.url;
      try { urlPath = new URL(pg.url).pathname; } catch { /* keep full url */ }

      return `<tr>
        <td><a href="${esc(pg.url)}">${esc(urlPath)}</a></td>
        <td>${pg.findings.length}</td>
        <td>${esc(label)}</td>
      </tr>`;
    }).join("");

    outlierHtml = `
      <h3>Pages with Additional Issues</h3>
      <p class="section-intro">These pages have violations beyond the sitewide pattern:</p>
      <table class="appendix-table">
        <thead><tr><th>Page</th><th>Issues</th><th>Differs From Baseline</th></tr></thead>
        <tbody>${outlierRows}</tbody>
      </table>`;
  }

  return `
    <section class="appendix-by-page" id="appendix-by-page">
      <h2>Appendix: Findings by Page</h2>
      <p class="section-intro">Consolidated view — see "Findings by Type" for full remediation guidance.</p>
      <table class="appendix-table">
        <thead><tr><th>Sev.</th><th>Criterion</th><th>Category</th><th>Pages</th><th>Instances</th><th>Unique Fixes</th></tr></thead>
        <tbody>${summaryRows}</tbody>
      </table>
      ${outlierHtml}
    </section>`;
}

// ---------------------------------------------------------------------------
// 6. Methodology + Effort Estimate
// ---------------------------------------------------------------------------

function renderMethodology(): string {
  return `
    <section class="methodology" id="methodology">
      <h2>Methodology</h2>
      <p>This accessibility audit was conducted using a five-tier automated testing approach:</p>
      <table>
        <thead>
          <tr><th>Tier</th><th>Method</th><th>Confidence</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>1</td>
            <td>axe-core Rules</td>
            <td>Definitive</td>
            <td>Automated WCAG rule engine against rendered DOM.</td>
          </tr>
          <tr>
            <td>2</td>
            <td>Playwright Behavioral</td>
            <td>High</td>
            <td>Browser-based keyboard navigation, focus management, and interaction testing.</td>
          </tr>
          <tr>
            <td>3</td>
            <td>Claude API Semantic</td>
            <td>High to Moderate</td>
            <td>AI-powered semantic evaluation of alt text quality, link text clarity, heading structure.</td>
          </tr>
          <tr>
            <td>4</td>
            <td>Form Testing</td>
            <td>High to Moderate</td>
            <td>Automated form submission with error evaluation.</td>
          </tr>
          <tr>
            <td>5</td>
            <td>Human Judgment Indicators</td>
            <td>Needs Review</td>
            <td>Detection of patterns requiring human judgment: animations, motion, pause mechanisms.</td>
          </tr>
        </tbody>
      </table>
      <h3>Confidence Tiers</h3>
      <ul>
        <li><strong>Definitive</strong> (0.95+): Binary rule-based checks with no ambiguity.</li>
        <li><strong>High</strong> (0.80&ndash;0.94): Behavioral or structural checks with reliable evidence.</li>
        <li><strong>Moderate</strong> (0.50&ndash;0.79): Semantic evaluation where context matters.</li>
        <li><strong>Needs Review</strong> (0.30&ndash;0.49): Indicators flagged for human expert verification.</li>
      </ul>
    </section>`;
}

function renderEffortEstimate(data: ReportData): string {
  const summary = data.summary;
  if (!summary) return "";

  // Build per-type effort table with subtype labels, categories, and unique fix counts
  const displayNames = buildGroupDisplayNames(data.groups);
  const typeRows = data.groups
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .map(g => {
      const name = displayNames.get(g.hash) ?? CRITERION_NAMES[g.criterion] ?? g.criterion;
      const hours = getEffortHours(g);
      const pages = distinctPageCount(g);
      const fixes = countUniqueFixes(g);
      const cat = categoryLabel(g.failureType);
      return `<tr>
        <td>${severityBadge(g.severity)}</td>
        <td>${esc(g.criterion)} ${esc(name)}</td>
        <td>${esc(cat)}</td>
        <td>${fixes}</td>
        <td>${hours}h</td>
        <td>${g.instanceCount} (${pages} pg${pages !== 1 ? "s" : ""})</td>
      </tr>`;
    }).join("");

  return `
    <section class="effort-estimate" id="effort-estimate">
      <h2>Estimated Remediation Effort</h2>
      <p><strong>Total estimated effort:</strong> ${esc(summary.estimated_total_effort)}</p>
      <p class="effort-note">Effort is estimated per unique fix, not per instance. On template-based platforms like ${esc(formatPlatform(data.scanSession.platform))}, fixing a shared component (e.g., a navigation link) propagates the fix to all pages using that template. Instance counts show recurrence across pages; unique fixes show the actual work required.</p>
      <table class="effort-table">
        <thead>
          <tr><th>Sev.</th><th>Issue Type</th><th>Category</th><th>Unique Fixes</th><th>Hours</th><th>Instances (Pages)</th></tr>
        </thead>
        <tbody>${typeRows}</tbody>
      </table>
    </section>`;
}

// ---------------------------------------------------------------------------
// Diff summary (only when comparing scans)
// ---------------------------------------------------------------------------

function renderDiffSummary(diff: ScanDiff): string {
  return `
    <section class="diff-summary" id="diff-summary">
      <h2>Changes Since Previous Scan</h2>
      <div class="summary-grid">
        <div class="summary-card" style="border-color:#16a34a">
          <div class="summary-number" style="color:#16a34a">${diff.resolved.length}</div>
          <div class="summary-label">Resolved</div>
        </div>
        <div class="summary-card" style="border-color:#dc2626">
          <div class="summary-number" style="color:#dc2626">${diff.newFindings.length}</div>
          <div class="summary-label">New Issues</div>
        </div>
        <div class="summary-card">
          <div class="summary-number">${diff.persistent.length}</div>
          <div class="summary-label">Persistent</div>
        </div>
      </div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Disclaimer
// ---------------------------------------------------------------------------

function renderDisclaimer(): string {
  return `
    <section class="disclaimer">
      <p><strong>Important:</strong> This report presents the results of automated and AI-assisted accessibility testing on a sampled subset of pages. It is not a certification of WCAG compliance, a legal determination, or a substitute for expert manual review. Criteria marked &ldquo;no issues detected&rdquo; mean no violations were found by the tools used &mdash; not that the criterion is fully satisfied. This report does not cover: PDF documents, native mobile applications, authenticated or login-protected pages, third-party embedded content (iframes, widgets), or pages not included in the crawl sample.</p>
    </section>`;
}

// ---------------------------------------------------------------------------
// Scan Scope
// ---------------------------------------------------------------------------

function renderScanScope(data: ReportData, pageUrlMap: Map<string, string>): string {
  const pageCount = pageUrlMap.size;
  const urls = Array.from(pageUrlMap.values()).sort();
  const pageListHtml = urls.length > 0
    ? `<ol class="scope-page-list">${urls.map(u => `<li><code>${esc(u)}</code></li>`).join("")}</ol>`
    : `<p>No page list available.</p>`;

  return `
    <section class="scan-scope" id="scan-scope">
      <h2>Scan Scope</h2>
      <p><strong>${pageCount} page${pageCount !== 1 ? "s" : ""}</strong> were scanned for this assessment.</p>
      ${pageListHtml}
      <h3>Not Covered</h3>
      <p>The following are outside the scope of this automated assessment and require separate evaluation:</p>
      <ul>
        <li>PDF documents and downloadable files</li>
        <li>Native mobile applications</li>
        <li>Authenticated or login-protected pages</li>
        <li>Third-party embedded content (iframes, payment processors, chat widgets)</li>
        <li>Pages not included in the crawl sample above</li>
        <li>Dynamic content loaded after user interaction beyond what automated tools can trigger</li>
      </ul>
    </section>`;
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const REPORT_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif;
    line-height: 1.6;
    color: #1a1a1a;
    max-width: 1100px;
    margin: 0 auto;
    padding: 2rem;
    background: #fff;
  }
  h1 { font-size: 1.75rem; margin-bottom: 0.5rem; }
  h2 { font-size: 1.4rem; margin: 2rem 0 1rem; padding-bottom: 0.5rem; border-bottom: 2px solid #e5e7eb; }
  h3 { font-size: 1.15rem; margin: 1rem 0 0.5rem; }
  h4 { font-size: 1rem; margin: 0.75rem 0 0.25rem; }
  h5 { font-size: 0.95rem; margin: 0.5rem 0 0.25rem; }
  p { margin: 0.5rem 0; }
  a { color: #2563eb; }
  code { background: #f3f4f6; padding: 0.15rem 0.35rem; border-radius: 3px; font-size: 0.88rem; }
  pre { margin: 0; }
  pre code { display: block; padding: 0.75rem; overflow-x: auto; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; white-space: pre-wrap; word-break: break-word; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border: 1px solid #e5e7eb; }
  th { background: #f9fafb; font-weight: 600; }
  tr:nth-child(even) { background: #fafafa; }

  .badge {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    border-radius: 3px;
    color: #fff;
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    vertical-align: middle;
  }

  /* Cover page */
  .cover-page { text-align: center; padding: 3rem 1rem 2rem; page-break-after: always; }
  .cover-title h1 { font-size: 2.2rem; color: #111827; line-height: 1.3; margin-bottom: 1.5rem; }
  .cover-grade { margin: 1.5rem 0; }
  .grade-circle {
    display: inline-flex; align-items: center; justify-content: center;
    width: 80px; height: 80px; border: 4px solid; border-radius: 50%;
    font-size: 2.5rem; font-weight: 800;
  }
  .grade-label { font-size: 0.85rem; color: #6b7280; margin-top: 0.25rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .cover-info { margin: 1.5rem auto; max-width: 500px; text-align: left; }
  .cover-meta { margin: 0 auto; font-size: 0.9rem; }
  .cover-meta td { border: none; padding: 0.3rem 0.75rem; }
  .cover-meta-label { font-weight: 600; color: #6b7280; width: 100px; }
  .cover-stats { display: flex; justify-content: center; gap: 2rem; margin-top: 2rem; }
  .cover-stat { text-align: center; }
  .cover-stat-num { display: block; font-size: 2rem; font-weight: 700; }
  .cover-stat-label { font-size: 0.78rem; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; }

  /* Executive Summary */
  .executive-summary { page-break-after: always; }
  .executive-summary .summary-grid {
    grid-template-columns: repeat(3, 1fr);
  }
  .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 1rem;
    margin: 1rem 0;
  }
  .summary-card {
    text-align: center;
    padding: 1rem;
    border: 2px solid #e5e7eb;
    border-radius: 8px;
  }
  .summary-number { font-size: 2rem; font-weight: 700; }
  .summary-label { font-size: 0.85rem; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; }
  .summary-detail { font-size: 0.8rem; color: #6b7280; margin-top: 0.25rem; }
  .top-issues { margin: 0.75rem 0; padding-left: 1.5rem; }
  .top-issues li { margin: 0.75rem 0; }
  .top-issue-desc { font-size: 0.9rem; color: #4b5563; }

  /* Scorecard */
  .scorecard { page-break-after: always; }
  .scorecard-summary { font-size: 0.95rem; margin-bottom: 0.5rem; }
  .scorecard-stat { font-size: 0.95rem; }
  .scorecard-table { font-size: 0.85rem; }
  .scorecard-table th:first-child, .scorecard-table td:first-child { width: 5rem; }

  /* Finding cards */
  .findings-by-type .section-intro { font-size: 0.92rem; color: #4b5563; margin-bottom: 1rem; }
  .finding-card { margin: 1.5rem 0; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; page-break-inside: avoid; }
  .card-header { padding: 1rem; background: #f9fafb; }
  .card-meta { font-size: 0.88rem; color: #6b7280; margin-top: 0.25rem; }
  .card-impact { font-size: 0.92rem; padding: 0 1rem; margin-top: 0.5rem; font-style: italic; color: #4b5563; }

  .sitewide-callout {
    margin: 0.5rem 1rem;
    padding: 0.5rem 0.75rem;
    background: #eff6ff;
    border-left: 3px solid #3b82f6;
    font-size: 0.88rem;
    color: #1e40af;
  }

  .affected-pages {
    margin: 0.4rem 1rem 0.25rem;
    font-size: 0.85rem;
    color: #475569;
    line-height: 1.5;
  }
  .affected-pages code {
    background: #f1f5f9;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    font-size: 0.82rem;
  }
  .affected-pages-more {
    display: inline;
  }
  .affected-pages-more summary {
    display: inline;
    cursor: pointer;
    color: #3b82f6;
    list-style: none;
  }
  .affected-pages-more summary:hover {
    text-decoration: underline;
  }
  .affected-pages-more summary::-webkit-details-marker { display: none; }
  @media print {
    .affected-pages-more { display: inline !important; }
    .affected-pages-more summary { display: none !important; }
  }

  .card-remediation { margin: 0.75rem 1rem; padding: 0.75rem; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 4px; }
  .card-remediation h4 { font-size: 0.95rem; margin: 0 0 0.25rem; }
  .designer-path { font-size: 0.88rem; color: #166534; }
  .remediation-steps-list { margin: 0.5rem 0; padding-left: 1.5rem; font-size: 0.88rem; }
  .remediation-steps-list li { margin: 0.25rem 0; }

  .card-snippets { padding: 0.75rem 1rem; border-top: 1px solid #f3f4f6; }
  .card-snippets h4 { font-size: 0.9rem; color: #6b7280; margin-bottom: 0.5rem; }
  .snippet { margin: 0.5rem 0; padding: 0.5rem; background: #fafafa; border-radius: 4px; }
  .snippet-url { font-size: 0.78rem; color: #6b7280; display: block; margin-bottom: 0.25rem; }
  .snippet-screenshot { max-width: 100%; max-height: 120px; border: 1px solid #e2e8f0; border-radius: 4px; }
  .snippet-code { margin: 0.25rem 0; }
  .snippet-code pre code { font-size: 0.8rem; max-height: 4rem; overflow: hidden; }
  .snippet-more { font-size: 0.85rem; color: #6b7280; font-style: italic; margin-top: 0.5rem; }

  /* Appendix by page */
  .appendix-by-page .section-intro { font-size: 0.92rem; color: #4b5563; }
  .appendix-page { margin: 1rem 0; }
  .appendix-page h4 { font-size: 0.95rem; }
  .appendix-count { font-weight: normal; color: #6b7280; }
  .appendix-table { font-size: 0.82rem; margin: 0.25rem 0 1rem; }
  .appendix-table th:first-child { width: 60px; }

  /* Effort */
  .effort-note { font-size: 0.88rem; color: #4b5563; font-style: italic; }
  .effort-table { font-size: 0.85rem; }
  .effort-table th:first-child { width: 60px; }

  /* Methodology */
  .methodology ul { margin: 0.5rem 0; padding-left: 1.5rem; }
  .methodology li { margin: 0.25rem 0; }

  /* Diff */
  .diff-section-title { margin-top: 1.5rem; padding-bottom: 0.25rem; border-bottom: 1px solid #e5e7eb; }

  /* Disclaimer */
  .disclaimer {
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 1rem 1.25rem;
    margin: 1.5rem 0;
    font-size: 0.85rem;
    color: #4b5563;
    font-style: italic;
    line-height: 1.5;
    page-break-after: auto;
  }

  /* Scan scope */
  .scan-scope .scope-page-list { font-size: 0.85rem; margin: 0.5rem 0 1rem; padding-left: 1.5rem; }
  .scan-scope .scope-page-list li { margin: 0.15rem 0; }
  .scan-scope ul { margin: 0.5rem 0; padding-left: 1.5rem; font-size: 0.9rem; }
  .scan-scope li { margin: 0.25rem 0; }

  .card-what-wrong { padding: 0.5rem 1rem; }
  .card-what-wrong h4 { font-size: 0.95rem; color: #1e40af; margin: 0 0 0.25rem; }
  .card-what-wrong p { font-size: 0.92rem; }

  .report-footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #e5e7eb; font-size: 0.85rem; color: #6b7280; text-align: center; }
  .footer-disclaimer { font-style: italic; margin-top: 0.25rem; }
  .footer-meta { font-size: 0.75rem; color: #9ca3af; margin-top: 0.25rem; }

  @media print {
    body { max-width: none; padding: 1rem; }
    .cover-page { page-break-after: always; }
    .executive-summary { page-break-after: always; }
    .scorecard { page-break-after: always; }
    .finding-card { page-break-inside: avoid; }
    .appendix-page { page-break-inside: avoid; }
  }
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** Page URL lookup by page_snapshot_id */
  pageUrlMap?: Map<string, string>;
  /** Impact descriptions by finding_type_hash (from Prompt 14) */
  impactDescriptions?: Map<string, string>;
  /** Executive summary HTML block (from Prompt 15) */
  executiveSummaryHtml?: string;
  /** Data directory path for resolving screenshot files to base64 data URIs */
  dataDir?: string;
}

/**
 * Render a complete HTML report from ReportData.
 *
 * Structure:
 * 1. Cover — site info, grade, key stats
 * 2. Disclaimer — scope and limitations
 * 3. Executive Summary — synthesis or plain-language fallback
 * 4. Compliance Scorecard — criterion pass/fail matrix
 * 5. Findings by Type — cards with remediation + inline snippets
 * 6. Appendix: Findings by Page — condensed per-page tables
 * 7. Scan Scope + Methodology + Effort Estimate
 */
export function renderHtmlReport(data: ReportData, options: RenderOptions = {}): string {
  const { pageUrlMap = new Map(), impactDescriptions, executiveSummaryHtml, dataDir } = options;

  const sections = [
    renderCover(data, executiveSummaryHtml),
    renderDisclaimer(),
    renderExecutiveSummary(data, executiveSummaryHtml),
    data.diff ? renderDiffSummary(data.diff) : "",
    renderComplianceScorecard(data.criterionResults),
    renderFindingsByType(data, pageUrlMap, impactDescriptions, dataDir),
    renderAppendixByPage(data, pageUrlMap),
    renderScanScope(data, pageUrlMap),
    renderMethodology(),
    renderEffortEstimate(data),
  ].filter(Boolean);

  const generatedAt = new Date().toISOString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WCAG 2.1 AA Assessment — ${esc(data.scanSession.url)}</title>
  <style>${REPORT_CSS}</style>
</head>
<body>
  ${sections.join("\n")}
  <footer class="report-footer">
    <p>Generated by WCAG Engine on ${generatedAt}</p>
    <p class="footer-disclaimer">Automated assessment — not a certification. Requires expert review before use in compliance determinations.</p>
    <p class="footer-meta">Scan ID: ${esc(data.scanSession.id)}</p>
  </footer>
</body>
</html>`;
}

// Re-export for testing
export { CRITERION_NAMES, ALL_CRITERIA, esc, severityBadge, statusBadge, diffBadge };
