import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  Finding,
  CriterionResult,
  ScanSummary,
  Severity,
} from "../../types.js";
import type { ReportData, FindingGroup, ScanDiff } from "../generator.js";

// ---------------------------------------------------------------------------
// WCAG criterion names (for the criterion table)
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

// All 50 WCAG 2.1 AA criteria in order
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

/**
 * Resolve a screenshot path to an inline base64 data URI.
 * Returns the data URI string, or null if the file is missing.
 */
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
  const color = colors[status] ?? "#6b7280";
  return `<span class="badge" style="background:${color}">${esc(status.replace(/_/g, " "))}</span>`;
}

function diffBadge(type: "fixed" | "new"): string {
  if (type === "fixed") {
    return '<span class="badge" style="background:#16a34a">Fixed</span>';
  }
  return '<span class="badge" style="background:#dc2626">New</span>';
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderHeader(data: ReportData): string {
  const session = data.scanSession;
  const scanDate = new Date(session.initiated_at).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });

  let comparisonInfo = "";
  if (data.diff) {
    comparisonInfo = `
      <p class="comparison-info">Compared against scan from ${esc(session.comparison_scan_id ?? "unknown")}</p>`;
  }

  return `
    <header class="report-header">
      <h1>WCAG 2.1 AA Accessibility Audit</h1>
      <div class="site-info">
        <p><strong>Site:</strong> ${esc(session.url)}</p>
        <p><strong>Scan Date:</strong> ${scanDate}</p>
        <p><strong>Platform:</strong> ${esc(session.platform)} (detected via ${esc(session.platform_detected_via)})</p>
        <p><strong>Scan ID:</strong> <code>${esc(session.id)}</code></p>
      </div>
      ${comparisonInfo}
    </header>`;
}

function renderExecutiveSummary(data: ReportData, executiveSummaryHtml?: string): string {
  if (executiveSummaryHtml) {
    return `
    <section class="executive-summary" id="executive-summary">
      <h2>Executive Summary</h2>
      ${executiveSummaryHtml}
    </section>`;
  }

  const summary = data.summary;
  if (!summary) {
    return `
    <section class="executive-summary" id="executive-summary">
      <h2>Executive Summary</h2>
      <p>No summary data available.</p>
    </section>`;
  }

  return `
    <section class="executive-summary" id="executive-summary">
      <h2>Executive Summary</h2>
      <div class="summary-grid">
        <div class="summary-card">
          <div class="summary-number">${summary.total_findings}</div>
          <div class="summary-label">Total Findings</div>
        </div>
        <div class="summary-card" style="border-color:#dc2626">
          <div class="summary-number" style="color:#dc2626">${summary.by_severity.critical}</div>
          <div class="summary-label">Critical</div>
        </div>
        <div class="summary-card" style="border-color:#ea580c">
          <div class="summary-number" style="color:#ea580c">${summary.by_severity.major}</div>
          <div class="summary-label">Major</div>
        </div>
        <div class="summary-card" style="border-color:#ca8a04">
          <div class="summary-number" style="color:#ca8a04">${summary.by_severity.minor}</div>
          <div class="summary-label">Minor</div>
        </div>
      </div>
      <p><strong>Estimated Remediation Effort:</strong> ${esc(summary.estimated_total_effort)}</p>
    </section>`;
}

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

function renderFindingInstance(finding: Finding, pageUrl?: string, dataDir?: string): string {
  const evidence = finding.evidence;
  const analysis = finding.analysis;
  const remediation = finding.remediation;

  let screenshotHtml = "";
  if (evidence.element_screenshot) {
    const dataUri = resolveScreenshot(evidence.element_screenshot, dataDir);
    if (dataUri) {
      screenshotHtml = `<div class="instance-screenshot"><img src="${dataUri}" alt="Element screenshot"></div>`;
    } else {
      screenshotHtml = `<div class="instance-screenshot"><div class="screenshot-placeholder">Screenshot not available</div></div>`;
    }
  }

  const htmlSnippet = evidence.element_html
    ? `<div class="code-block"><pre><code>${esc(evidence.element_html)}</code></pre></div>`
    : "";

  const remediationHtml = remediation.generic_fix
    ? `<div class="remediation">
        <h5>Remediation</h5>
        <p>${esc(remediation.generic_fix)}</p>
        ${remediation.platform_fix.steps.length > 0
          ? `<ol>${remediation.platform_fix.steps.map(s => `<li>${esc(s)}</li>`).join("")}</ol>`
          : ""}
        ${remediation.code_fix ? `<div class="code-block"><pre><code>${esc(remediation.code_fix)}</code></pre></div>` : ""}
      </div>`
    : "";

  const url = pageUrl ?? "";

  return `
    <div class="finding-instance">
      ${url ? `<p class="instance-url"><strong>Page:</strong> <a href="${esc(url)}">${esc(url)}</a></p>` : ""}
      ${screenshotHtml}
      ${htmlSnippet}
      <div class="instance-analysis">
        <h5>Analysis</h5>
        <p>${esc(analysis.reasoning)}</p>
        ${analysis.impact_description ? `<p class="impact"><strong>Impact:</strong> ${esc(analysis.impact_description)}</p>` : ""}
        ${analysis.affected_users.length > 0 ? `<p class="affected-users"><strong>Affected Users:</strong> ${analysis.affected_users.map(u => esc(u)).join(", ")}</p>` : ""}
      </div>
      ${remediationHtml}
    </div>`;
}

function renderFindingGroup(
  group: FindingGroup,
  pageUrlMap: Map<string, string>,
  impactDescriptions?: Map<string, string>,
  badgeType?: "fixed" | "new",
  dataDir?: string,
): string {
  const criterionName = CRITERION_NAMES[group.criterion] ?? group.criterion;
  const impactHtml = impactDescriptions?.get(group.hash)
    ? `<p class="group-impact">${esc(impactDescriptions.get(group.hash)!)}</p>`
    : "";

  const badge = badgeType ? ` ${diffBadge(badgeType)}` : "";

  return `
    <div class="finding-group">
      <div class="group-header">
        <h3>
          ${severityBadge(group.severity)}${badge}
          ${esc(group.criterion)} — ${esc(criterionName)}
        </h3>
        <p class="group-meta">
          Failure type: <code>${esc(group.failureType)}</code> |
          ${group.instanceCount} instance${group.instanceCount !== 1 ? "s" : ""}
        </p>
        ${impactHtml}
      </div>
      <details class="instances-detail">
        <summary>Show ${group.instanceCount} instance${group.instanceCount !== 1 ? "s" : ""}</summary>
        <div class="instances">
          ${group.findings.map(f => renderFindingInstance(f, pageUrlMap.get(f.page_snapshot_id), dataDir)).join("")}
        </div>
      </details>
    </div>`;
}

function renderFindings(
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
    <section class="findings" id="findings">
      <h2>Findings</h2>
      <p>No accessibility violations detected.</p>
    </section>`;
  }

  return `
    <section class="findings" id="findings">
      <h2>Findings</h2>
      ${data.groups.map(g => renderFindingGroup(g, pageUrlMap, impactDescriptions, undefined, dataDir)).join("")}
    </section>`;
}

function renderDiffFindings(
  data: ReportData,
  pageUrlMap: Map<string, string>,
  impactDescriptions?: Map<string, string>,
  dataDir?: string,
): string {
  const diff = data.diff!;
  const sections: string[] = [];

  if (diff.resolved.length > 0) {
    sections.push(`
      <h3 class="diff-section-title">Resolved Issues</h3>
      ${diff.resolved.map(g => renderFindingGroup(g, pageUrlMap, impactDescriptions, "fixed", dataDir)).join("")}`);
  }

  if (diff.newFindings.length > 0) {
    sections.push(`
      <h3 class="diff-section-title">New Issues</h3>
      ${diff.newFindings.map(g => renderFindingGroup(g, pageUrlMap, impactDescriptions, "new", dataDir)).join("")}`);
  }

  if (diff.persistent.length > 0) {
    sections.push(`
      <h3 class="diff-section-title">Persistent Issues</h3>
      ${diff.persistent.map(g => renderFindingGroup(g, pageUrlMap, impactDescriptions, undefined, dataDir)).join("")}`);
  }

  return `
    <section class="findings" id="findings">
      <h2>Findings</h2>
      ${sections.join("")}
    </section>`;
}

function renderCriterionTable(criterionResults: CriterionResult[]): string {
  const resultMap = new Map(criterionResults.map(r => [r.wcag_criterion, r]));

  const rows = ALL_CRITERIA.map(criterion => {
    const result = resultMap.get(criterion);
    const name = CRITERION_NAMES[criterion] ?? criterion;
    const status = result?.status ?? "not_tested";
    const testedBy = result?.tested_by ?? "-";
    const summary = result?.evidence_summary ?? "-";
    const findingCount = result?.finding_ids.length ?? 0;

    return `
      <tr>
        <td>${esc(criterion)}</td>
        <td>${esc(name)}</td>
        <td>${statusBadge(status)}</td>
        <td>${esc(testedBy)}</td>
        <td>${esc(summary)}</td>
        <td>${findingCount > 0 ? findingCount : "-"}</td>
      </tr>`;
  });

  return `
    <section class="criterion-table" id="criterion-results">
      <h2>WCAG 2.1 AA Criterion Results</h2>
      <table>
        <thead>
          <tr>
            <th>Criterion</th>
            <th>Name</th>
            <th>Status</th>
            <th>Tested By</th>
            <th>Evidence</th>
            <th>Findings</th>
          </tr>
        </thead>
        <tbody>
          ${rows.join("")}
        </tbody>
      </table>
    </section>`;
}

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
            <td>Automated WCAG rule engine against rendered DOM. Checks for missing attributes, contrast ratios, ARIA compliance, and structural requirements.</td>
          </tr>
          <tr>
            <td>2</td>
            <td>Playwright Behavioral</td>
            <td>High</td>
            <td>Browser-based keyboard navigation, focus management, and interaction testing. Verifies real-world keyboard accessibility.</td>
          </tr>
          <tr>
            <td>3</td>
            <td>Claude API Semantic</td>
            <td>High to Moderate</td>
            <td>AI-powered semantic evaluation of alt text quality, link text clarity, heading structure, and navigation consistency.</td>
          </tr>
          <tr>
            <td>4</td>
            <td>Form Testing</td>
            <td>High to Moderate</td>
            <td>Automated form submission with error evaluation. Checks error identification, suggestions, and high-risk form safeguards.</td>
          </tr>
          <tr>
            <td>5</td>
            <td>Human Judgment Indicators</td>
            <td>Needs Review</td>
            <td>Automated detection of patterns requiring human judgment: animations, motion actuation, pause mechanisms, and multiple navigation paths.</td>
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

function renderEffortEstimate(summary: ScanSummary | null): string {
  if (!summary) return "";

  return `
    <section class="effort-estimate" id="effort-estimate">
      <h2>Estimated Remediation Effort</h2>
      <p><strong>Total estimated effort:</strong> ${esc(summary.estimated_total_effort)}</p>
      <div class="effort-breakdown">
        <table>
          <thead>
            <tr><th>Category</th><th>Findings</th></tr>
          </thead>
          <tbody>
            ${Object.entries(summary.by_category)
              .filter(([, count]) => (count as number) > 0)
              .map(([cat, count]) => `<tr><td>${esc(cat)}</td><td>${count}</td></tr>`)
              .join("")}
          </tbody>
        </table>
      </div>
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

  .report-header { margin-bottom: 2rem; }
  .site-info { background: #f8fafc; padding: 1rem; border-radius: 6px; border: 1px solid #e2e8f0; }
  .comparison-info { margin-top: 0.5rem; font-style: italic; color: #6b7280; }

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

  .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
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

  .finding-group { margin: 1.5rem 0; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
  .group-header { padding: 1rem; background: #f9fafb; }
  .group-meta { font-size: 0.88rem; color: #6b7280; margin-top: 0.25rem; }
  .group-impact { font-size: 0.92rem; margin-top: 0.5rem; font-style: italic; }

  .instances-detail { border-top: 1px solid #e5e7eb; }
  .instances-detail summary {
    padding: 0.75rem 1rem;
    cursor: pointer;
    font-weight: 500;
    color: #2563eb;
    background: #f0f9ff;
  }
  .instances-detail summary:hover { background: #e0f2fe; }

  .finding-instance { padding: 1rem; border-top: 1px solid #f3f4f6; }
  .finding-instance:first-child { border-top: none; }
  .instance-url { font-size: 0.88rem; }
  .instance-screenshot { margin: 0.5rem 0; }
  .instance-screenshot img { max-width: 100%; height: auto; border: 1px solid #e2e8f0; border-radius: 4px; }
  .screenshot-placeholder { background: #e5e7eb; color: #6b7280; padding: 2rem; text-align: center; border-radius: 4px; font-size: 0.88rem; font-style: italic; }
  .instance-analysis { margin: 0.5rem 0; }
  .impact { color: #7c3aed; }
  .affected-users { font-size: 0.88rem; color: #6b7280; }

  .remediation { margin-top: 0.75rem; padding: 0.75rem; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 4px; }
  .remediation ol { margin: 0.5rem 0; padding-left: 1.5rem; }
  .remediation li { margin: 0.25rem 0; }

  .diff-section-title { margin-top: 1.5rem; padding-bottom: 0.25rem; border-bottom: 1px solid #e5e7eb; }

  .criterion-table table { font-size: 0.85rem; }
  .criterion-table th:first-child, .criterion-table td:first-child { width: 5rem; }

  .methodology ul { margin: 0.5rem 0; padding-left: 1.5rem; }
  .methodology li { margin: 0.25rem 0; }

  .effort-breakdown table { max-width: 400px; }

  .report-footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #e5e7eb; font-size: 0.85rem; color: #6b7280; text-align: center; }

  @media print {
    body { max-width: none; padding: 1rem; }
    .instances-detail[open] summary { display: none; }
    .instances-detail { border-top: none; }
    .instances-detail .instances { display: block !important; }
    details { break-inside: avoid; }
    .finding-group { break-inside: avoid; page-break-inside: avoid; }
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
 * Returns a self-contained HTML string with inline CSS, suitable
 * for rendering in Chrome and PDF conversion via page.pdf().
 */
export function renderHtmlReport(data: ReportData, options: RenderOptions = {}): string {
  const { pageUrlMap = new Map(), impactDescriptions, executiveSummaryHtml, dataDir } = options;

  const sections = [
    renderHeader(data),
    renderExecutiveSummary(data, executiveSummaryHtml),
    data.diff ? renderDiffSummary(data.diff) : "",
    renderFindings(data, pageUrlMap, impactDescriptions, dataDir),
    renderCriterionTable(data.criterionResults),
    renderMethodology(),
    renderEffortEstimate(data.summary),
  ].filter(Boolean);

  const generatedAt = new Date().toISOString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WCAG 2.1 AA Audit — ${esc(data.scanSession.url)}</title>
  <style>${REPORT_CSS}</style>
</head>
<body>
  ${sections.join("\n")}
  <footer class="report-footer">
    <p>Generated by WCAG Engine on ${generatedAt}</p>
  </footer>
</body>
</html>`;
}

// Re-export for testing
export { CRITERION_NAMES, ALL_CRITERIA, esc, severityBadge, statusBadge, diffBadge };
