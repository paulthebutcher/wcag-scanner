import type { Cluster, ExcludedFinding } from "./clustering.js";
import { clusterLabel } from "./clustering.js";
import { pageOccurrences } from "./occurrences.js";

// ---------------------------------------------------------------------------
// "Top fixes", "Needs manual check" and "Third-party" sections for the HTML
// report and findings.md.
// ---------------------------------------------------------------------------

export const TOP_FIXES_LIMIT = 10;

function htmlEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function mdCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function pagesText(cluster: Cluster): string {
  return `${cluster.page_count}${cluster.pages_complete ? "" : "*"}`;
}

/** Excluded findings grouped by detail, most occurrences first. */
export function groupExcluded(excluded: ExcludedFinding[]): Array<{
  reason: ExcludedFinding["reason"];
  detail: string;
  occurrences: number;
  pages: string[];
  criteria: string[];
  example: { selector: string; html: string; page_url: string };
}> {
  const groups = new Map<string, ExcludedFinding[]>();
  for (const ex of excluded) {
    const key = `${ex.reason}\u0000${ex.detail}`;
    const list = groups.get(key) ?? [];
    list.push(ex);
    groups.set(key, list);
  }
  return Array.from(groups.values())
    .map((list) => ({
      reason: list[0].reason,
      detail: list[0].detail,
      occurrences: list.reduce((n, ex) => n + pageOccurrences(ex.finding), 0),
      pages: Array.from(new Set(list.map((ex) => ex.pageUrl))).sort(),
      criteria: Array.from(new Set(list.map((ex) => ex.finding.wcag_criterion))).sort(),
      example: {
        selector: list[0].finding.evidence.element_selector,
        html: list[0].finding.evidence.element_html,
        page_url: list[0].pageUrl,
      },
    }))
    .sort((a, b) => b.occurrences - a.occurrences || a.detail.localeCompare(b.detail));
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

export function renderTopFixesMarkdown(clusters: Cluster[], limit = TOP_FIXES_LIMIT): string {
  const top = clusters.slice(0, limit);
  const lines = [
    "## Top fixes",
    "",
    "Each row is one fix. Occurrences counts every page the problem appears on, so the list is ordered by how much each single change clears.",
    "",
    "| # | Fix | WCAG | Severity | Occurrences | Pages | Example element | Cluster |",
    "|---|---|---|---|---|---|---|---|",
  ];
  top.forEach((c, i) => {
    lines.push(`| ${i + 1} | ${mdCell(clusterLabel(c))} | ${c.wcag_criterion} | ${c.severity} | ${c.occurrence_count} | ${pagesText(c)} | \`${mdCell(c.representative.selector)}\` | \`${c.cluster_id}\` |`);
  });
  if (top.some((c) => !c.pages_complete)) {
    lines.push("", "\\* Page count includes pages known only by count (scan recorded before page lists were kept).");
  }
  lines.push("");
  top.forEach((c, i) => {
    lines.push(`### ${i + 1}. ${clusterLabel(c)}`);
    lines.push(`- ${c.remediation.summary}`);
    if (c.remediation.designer_path) lines.push(`- Where: ${c.remediation.designer_path}`);
    c.remediation.steps.forEach((s, j) => lines.push(`  ${j + 1}. ${s}`));
    lines.push(`- Example: ${pathOf(c.representative.page_url)} \`${mdCell(c.representative.html.slice(0, 160))}\``);
    lines.push("");
  });
  return lines.join("\n");
}

export function renderExcludedMarkdown(excluded: ExcludedFinding[]): string {
  const groups = groupExcluded(excluded);
  const lines: string[] = [];
  const sections: Array<[ExcludedFinding["reason"], string, string]> = [
    ["needs_manual_check", "Needs manual check", "axe could not measure the colour behind this text, so contrast has to be checked by eye. These are not counted as failures."],
    ["third_party", "Third-party", "Elements inside third-party embeds. The site owner cannot change them directly; raise them with the provider. These are not counted as failures."],
  ];
  for (const [reason, title, intro] of sections) {
    const rows = groups.filter((g) => g.reason === reason);
    if (rows.length === 0) continue;
    const total = rows.reduce((n, r) => n + r.occurrences, 0);
    lines.push(`## ${title} (${total})`, "", intro, "", "| Reason | Occurrences | Pages | Criteria | Example |", "|---|---|---|---|---|");
    for (const r of rows) {
      lines.push(`| ${mdCell(r.detail)} | ${r.occurrences} | ${r.pages.length} | ${r.criteria.join(", ")} | ${pathOf(r.example.page_url)} \`${mdCell(r.example.selector)}\` |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

export function renderTopFixesHtml(clusters: Cluster[], limit = TOP_FIXES_LIMIT): string {
  if (clusters.length === 0) return "";
  const top = clusters.slice(0, limit);
  const rows = top.map((c, i) => `
      <tr>
        <td>${i + 1}</td>
        <td><strong>${htmlEsc(clusterLabel(c))}</strong><div class="topfix-summary">${htmlEsc(c.remediation.summary)}</div></td>
        <td>${htmlEsc(c.wcag_criterion)}</td>
        <td>${htmlEsc(c.severity)}</td>
        <td>${c.occurrence_count}</td>
        <td>${pagesText(c)}</td>
      </tr>`).join("");
  const details = top.map((c, i) => `
      <details class="topfix-detail">
        <summary>${i + 1}. ${htmlEsc(clusterLabel(c))}</summary>
        ${c.remediation.designer_path ? `<p class="designer-path"><strong>Where:</strong> ${htmlEsc(c.remediation.designer_path)}</p>` : ""}
        ${c.remediation.steps.length > 0 ? `<ol>${c.remediation.steps.map((s) => `<li>${htmlEsc(s)}</li>`).join("")}</ol>` : ""}
        ${c.remediation.code_fix ? `<div class="code-block"><pre><code>${htmlEsc(c.remediation.code_fix)}</code></pre></div>` : ""}
        <p class="topfix-example">Example on <code>${htmlEsc(pathOf(c.representative.page_url))}</code>:</p>
        <div class="code-block"><pre><code>${htmlEsc(c.representative.html)}</code></pre></div>
      </details>`).join("");
  return `
    <section class="top-fixes" id="top-fixes">
      <h2>Top Fixes</h2>
      <p class="section-intro">The ${top.length} changes that clear the most problems. Each row is one fix; occurrences counts every page the problem appears on.</p>
      <table class="topfix-table">
        <thead><tr><th>#</th><th>Fix</th><th>WCAG</th><th>Severity</th><th>Occurrences</th><th>Pages</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${top.some((c) => !c.pages_complete) ? `<p class="topfix-note">* Includes pages known only by count (scan recorded before page lists were kept).</p>` : ""}
      ${details}
    </section>`;
}

export function renderExcludedHtml(excluded: ExcludedFinding[]): string {
  const groups = groupExcluded(excluded);
  const sections: Array<[ExcludedFinding["reason"], string, string, string]> = [
    ["needs_manual_check", "needs-manual-check", "Needs Manual Check", "axe could not measure the colour behind this text (an image, gradient or overlapping element), so contrast has to be checked by eye. Not counted as failures."],
    ["third_party", "third-party", "Third-Party Content", "Elements inside third-party embeds. The site owner cannot change them directly; raise them with the provider. Not counted as failures."],
  ];
  return sections.map(([reason, id, title, intro]) => {
    const rows = groups.filter((g) => g.reason === reason);
    if (rows.length === 0) return "";
    const total = rows.reduce((n, r) => n + r.occurrences, 0);
    return `
    <section class="excluded" id="${id}">
      <h2>${title} (${total})</h2>
      <p class="section-intro">${intro}</p>
      <table class="topfix-table">
        <thead><tr><th>Reason</th><th>Occurrences</th><th>Pages</th><th>Criteria</th><th>Example</th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr><td>${htmlEsc(r.detail)}</td><td>${r.occurrences}</td><td>${r.pages.length}</td><td>${htmlEsc(r.criteria.join(", "))}</td><td><code>${htmlEsc(pathOf(r.example.page_url))}</code> <code>${htmlEsc(r.example.selector)}</code></td></tr>`).join("")}
        </tbody>
      </table>
    </section>`;
  }).join("");
}

export const TOP_FIXES_CSS = `
.topfix-table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
.topfix-table th, .topfix-table td { border-bottom: 1px solid #e5e5e5; padding: 6px 8px; text-align: left; vertical-align: top; }
.topfix-summary { color: #444; margin-top: 4px; font-size: 12px; }
.topfix-detail { margin: 8px 0; font-size: 13px; }
.topfix-detail summary { cursor: pointer; font-weight: 600; }
.topfix-note, .topfix-example { color: #666; font-size: 12px; }
`;
