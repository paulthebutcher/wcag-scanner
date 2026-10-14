import type { ScanCoverage, CheckCoverageRow } from "../core/coverage.js";
import { summarizeCoverage } from "../core/coverage.js";

// ---------------------------------------------------------------------------
// Coverage section: one row per check, pages ran / failed / skipped out of
// pages crawled, with failure messages and skip reasons grouped.
// ---------------------------------------------------------------------------

/** Display names for check ids recorded by the scanner. */
export const CHECK_LABELS: Record<string, string> = {
  "axe-core": "axe-core rules",
  "keyboard": "Keyboard reachability (2.1.1)",
  "focus-visible": "Focus visible (2.4.7)",
  "focus-order": "Focus order (2.4.3)",
  "keyboard-trap": "Keyboard traps (2.1.2)",
  "skip-nav": "Skip navigation (2.4.1)",
  "modal": "Modal focus management",
  "alt-text": "Alt text quality (1.1.1)",
  "link-text": "Link text quality (2.4.4)",
  "headings": "Heading structure (2.4.6, 1.3.1)",
  "landmark-labels": "Landmark labels (1.3.1)",
  "widget-aria": "Widget ARIA (4.1.2)",
  "table-structure": "Table structure (1.3.1)",
  "duplicate-links": "Duplicate link text (2.4.4)",
  "consistent-nav": "Consistent navigation (3.2.3)",
  "form-discovery": "Form discovery",
  "high-risk-forms": "High-risk forms (3.3.4)",
  "form-submission": "Form submission (3.3.1, 3.3.3)",
  "error-messages": "Error message quality (3.3.1, 3.3.3)",
  "input-purpose": "Input purpose (1.3.5)",
  "on-input": "On input (3.2.2)",
  "error-quality": "Error quality indicators",
  "pause-stop-hide": "Pause, stop, hide (2.2.2)",
  "three-flashes": "Three flashes (2.3.1)",
  "multiple-ways": "Multiple ways (2.4.5)",
  "motion-actuation": "Motion actuation (2.5.4)",
};

export function checkLabel(check: string): string {
  return CHECK_LABELS[check] ?? check;
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function pageList(urls: string[], limit = 6): string {
  const paths = urls.map(pathOf);
  const shown = paths.slice(0, limit).join(", ");
  return paths.length > limit ? `${shown} and ${paths.length - limit} more` : shown;
}

function htmlEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function mdEsc(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

// ---------------------------------------------------------------------------
// Markdown (findings.md)
// ---------------------------------------------------------------------------

export function renderCoverageMarkdown(coverage: ScanCoverage | null): string {
  const lines: string[] = ["## Coverage", ""];
  if (!coverage) {
    lines.push("Coverage was not recorded for this scan (it predates per-check coverage recording).", "");
    return lines.join("\n");
  }
  const rows = summarizeCoverage(coverage);
  const withFailures = rows.filter((r) => r.failed > 0);
  const withPartials = rows.filter((r) => r.partial > 0);
  const renderFailed = coverage.render_failed ?? [];
  if (renderFailed.length > 0) {
    lines.push(`> **ALERT: ${renderFailed.length} of ${coverage.page_urls.length} page(s) rendered broken or blank and were not checked.** Findings and passes in this report cover the other pages only, and no criterion is reported as passed. Fewer findings here is not progress: fix the site (often an unclosed \`<style>\` in custom code) and rescan.`, "");
    for (const f of renderFailed) lines.push(`> - ${f.url}: ${mdEsc(f.reasons.join("; "))}`);
    lines.push("");
  }
  lines.push(`Pages crawled: ${coverage.page_urls.length}. Each row shows how many of those pages the check ran on, ran on only partly, failed on, or skipped.`);
  if (coverage.crawl_failures.length > 0) {
    lines.push("", `**Warning:** ${coverage.crawl_failures.length} page(s) could not be loaded by the crawl and were not checked at all:`);
    for (const f of coverage.crawl_failures) lines.push(`- ${f.url}: ${mdEsc(f.error)}`);
  }
  if (withFailures.length > 0) {
    lines.push("", `**Warning:** ${withFailures.length} check(s) failed on at least one page. Pages where a check failed were not tested for it.`);
  }
  if (withPartials.length > 0) {
    lines.push("", `**Warning:** ${withPartials.length} check(s) only partly ran on some pages. Part of those pages was not tested.`);
  }
  lines.push("", "| Check | Tier | Ran | Partial | Failed | Skipped | Not recorded |", "|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const failed = r.failed > 0 ? `**${r.failed}** ⚠` : "0";
    const partial = r.partial > 0 ? `**${r.partial}** ⚠` : "0";
    lines.push(`| ${checkLabel(r.check)} | ${r.tier} | ${r.ran}/${r.pages_crawled} | ${partial} | ${failed} | ${r.skipped} | ${r.not_recorded} |`);
  }
  for (const r of rows) {
    if (r.failures.length === 0 && r.skips.length === 0 && r.partials.length === 0) continue;
    lines.push("", `### ${checkLabel(r.check)}`);
    for (const f of r.failures) {
      lines.push(`- Failed on ${f.pages.length} page(s): ${mdEsc(f.message)} (${pageList(f.pages)})`);
    }
    for (const p of r.partials) {
      lines.push(`- Partial on ${p.pages.length} page(s): ${mdEsc(p.reason)} (${pageList(p.pages)})`);
    }
    for (const s of r.skips) {
      lines.push(`- Skipped on ${s.pages.length} page(s): ${mdEsc(s.reason)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HTML report
// ---------------------------------------------------------------------------

function rowHtml(r: CheckCoverageRow): string {
  const warn = r.failed > 0 || r.partial > 0 ? ` class="coverage-warn"` : "";
  return `<tr${warn}>
      <td>${htmlEsc(checkLabel(r.check))}${r.failed > 0 || r.partial > 0 ? ` <span class="coverage-flag" title="Failed or only partly ran on some pages">&#9888;</span>` : ""}</td>
      <td>${r.tier}</td>
      <td>${r.ran} / ${r.pages_crawled}</td>
      <td>${r.partial}</td>
      <td>${r.failed}</td>
      <td>${r.skipped}</td>
    </tr>`;
}

export function renderCoverageHtml(coverage: ScanCoverage | null): string {
  if (!coverage) {
    return `
    <section class="coverage" id="coverage">
      <h2>Coverage</h2>
      <p class="section-intro">Coverage was not recorded for this scan (it predates per-check coverage recording).</p>
    </section>`;
  }
  const rows = summarizeCoverage(coverage);
  const withFailures = rows.filter((r) => r.failed > 0);
  const withPartials = rows.filter((r) => r.partial > 0);

  const warnings: string[] = [];
  const renderFailed = coverage.render_failed ?? [];
  if (renderFailed.length > 0) {
    warnings.push(`<div class="coverage-warning coverage-alert"><strong>ALERT: ${renderFailed.length} of ${coverage.page_urls.length} page(s) rendered broken or blank and were not checked.</strong> Findings and passes cover the other pages only, and no criterion is reported as passed. Fewer findings is not progress: fix the site (often an unclosed &lt;style&gt; in custom code) and rescan. <span class="coverage-pages">(${htmlEsc(pageList(renderFailed.map((f) => f.url)))})</span></div>`);
  }
  if (coverage.crawl_failures.length > 0) {
    warnings.push(`<div class="coverage-warning"><strong>${coverage.crawl_failures.length} page(s) could not be loaded</strong> and were not checked: ${htmlEsc(pageList(coverage.crawl_failures.map((f) => f.url)))}.</div>`);
  }
  if (withPartials.length > 0) {
    warnings.push(`<div class="coverage-warning"><strong>${withPartials.length} check(s) only partly ran on some pages:</strong> ${withPartials.map((r) => `${htmlEsc(checkLabel(r.check))} (${r.partial})`).join(", ")}. Part of those pages was not tested.</div>`);
  }
  if (withFailures.length > 0) {
    warnings.push(`<div class="coverage-warning"><strong>${withFailures.length} check(s) failed on some pages:</strong> ${withFailures.map((r) => `${htmlEsc(checkLabel(r.check))} (${r.failed})`).join(", ")}. Those pages were not tested by those checks, so a missing finding there does not mean a pass.</div>`);
  }

  const details = rows
    .filter((r) => r.failures.length > 0 || r.skips.length > 0 || r.partials.length > 0)
    .map((r) => {
      const items = [
        ...r.failures.map((f) => `<li><strong>Failed on ${f.pages.length} page${f.pages.length !== 1 ? "s" : ""}:</strong> ${htmlEsc(f.message)} <span class="coverage-pages">(${htmlEsc(pageList(f.pages))})</span></li>`),
        ...r.partials.map((p) => `<li><strong>Partial on ${p.pages.length} page${p.pages.length !== 1 ? "s" : ""}:</strong> ${htmlEsc(p.reason)} <span class="coverage-pages">(${htmlEsc(pageList(p.pages))})</span></li>`),
        ...r.skips.map((s) => `<li>Skipped on ${s.pages.length} page${s.pages.length !== 1 ? "s" : ""}: ${htmlEsc(s.reason)}</li>`),
      ];
      return `<h4>${htmlEsc(checkLabel(r.check))}</h4><ul>${items.join("")}</ul>`;
    })
    .join("");

  return `
    <section class="coverage" id="coverage">
      <h2>Coverage</h2>
      <p class="section-intro">How many of the ${coverage.page_urls.length} crawled pages each check ran on. Skipped pages had nothing for the check to test (for example no forms); partial pages were only partly tested; failed pages were not tested.</p>
      ${warnings.join("")}
      <table class="coverage-table">
        <thead><tr><th>Check</th><th>Tier</th><th>Ran</th><th>Partial</th><th>Failed</th><th>Skipped</th></tr></thead>
        <tbody>${rows.map(rowHtml).join("")}</tbody>
      </table>
      ${details ? `<div class="coverage-details">${details}</div>` : ""}
    </section>`;
}

/** CSS for the coverage section, appended to the report stylesheet. */
export const COVERAGE_CSS = `
.coverage-table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
.coverage-table th, .coverage-table td { border-bottom: 1px solid #e5e5e5; padding: 6px 8px; text-align: left; }
.coverage-table tr.coverage-warn td { background: #fff4e5; }
.coverage-flag { color: #b45309; }
.coverage-warning { border-left: 4px solid #d97706; background: #fff7ed; padding: 10px 12px; margin: 10px 0; font-size: 13px; }
.coverage-details h4 { margin: 14px 0 4px; font-size: 14px; }
.coverage-details ul { margin: 0 0 8px 18px; font-size: 13px; }
.coverage-pages { color: #666; }
`;
