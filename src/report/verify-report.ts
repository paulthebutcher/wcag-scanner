import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VerifyResult, VerifyClusterResult, NewIssue } from "../core/verify.js";

// ---------------------------------------------------------------------------
// `wcag verify` output: a plain-language summary for the client (no
// internal ids) and a per-cluster table for us. Rendered to verify.md and
// as a section of the rescan's HTML report.
// ---------------------------------------------------------------------------

type IssueLike = Pick<VerifyClusterResult, "failure_type" | "wcag_criterion" | "signature">;

/** What the issue is, in words a site owner understands. */
export function plainIssue(issue: IssueLike): string {
  if (issue.failure_type === "color-contrast") {
    const fg = issue.signature.split("fg:")[1];
    return fg ? `low-contrast text in colour ${fg}` : "low-contrast text";
  }
  const byType: Record<string, string> = {
    custom_interactive_no_role: "a clickable element styled as a button that keyboard and screen reader users cannot operate",
    no_visible_focus_indicator: "links or buttons that show no visible outline when reached with the keyboard",
    focus_indicator_low_contrast: "a keyboard focus outline that is too faint to see",
    focus_on_hidden_element: "hidden content that keyboard focus still lands on",
    unreachable_interactive_element: "controls that cannot be reached with the keyboard",
    missing_skip_navigation: 'no "skip to main content" link',
    "aria-prohibited-attr": "labels that screen readers ignore because the element has no role",
    "aria-allowed-attr": "accessibility attributes that are not allowed on their element",
    "button-name": "buttons with no name for screen readers",
    "link-name": "links with no name for screen readers",
    generic_link_text: 'links whose wording (such as "here" or "learn more") does not say where they go',
    empty_link: "links with no text",
    "image-alt": "images with no text description",
    alt_not_descriptive: "images whose text description does not describe them",
    empty_alt_on_informative: "meaningful images marked as decorative",
    animated_content_no_pause: "moving content with no way to pause it",
    style_not_structure: "body text marked up as headings",
    empty_heading: "empty headings",
    missing_autocomplete: "form fields that do not tell browsers what to autofill",
  };
  return byType[issue.failure_type] ?? `an accessibility problem under WCAG ${issue.wcag_criterion}`;
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

/** Simplify a not-verified reason for the client. */
function plainReason(reason: string): string {
  if (reason.startsWith("page could not be loaded")) return "the page could not be loaded";
  if (reason.includes("ANTHROPIC_API_KEY")) return "the AI-assisted check was not available";
  if (reason.includes("failed")) return "the check could not run on the page";
  if (reason.includes("skipped")) return "there was nothing for the check to test on the page";
  return "the page could not be checked";
}

function pageCounts(c: VerifyClusterResult) {
  return {
    fixed: c.pages.filter((p) => p.status === "fixed").length,
    broken: c.pages.filter((p) => p.status === "still_broken").length,
    unverified: c.pages.filter((p) => p.status === "not_verified").length,
  };
}

/** Client-ready summary lines: plain language, no internal ids. */
export function clientSummaryLines(result: VerifyResult): string[] {
  const s = result.summary;
  const lines: string[] = [];
  lines.push(`We re-checked ${plural(result.pages_rescanned.length, "page")} on ${result.site} for the ${plural(s.issues_checked, "issue")} selected from the ${formatDate(result.baseline_date)} scan.`);

  const fixed = result.clusters.filter((c) => c.status === "fixed");
  const broken = result.clusters.filter((c) => c.status === "still_broken");
  const unverified = result.clusters.filter((c) => c.status === "not_verified");

  lines.push(fixed.length > 0
    ? `**${plural(fixed.length, "issue")} fixed** across ${plural(s.fixed_pages, "page")}: ${fixed.map((c) => plainIssue(c)).join("; ")}.`
    : "**No issues are fully fixed yet.**");

  if (broken.length > 0) {
    lines.push(`**${plural(broken.length, "issue")} remaining:**`);
    for (const c of broken) {
      const n = pageCounts(c);
      const progress = n.fixed > 0 ? ` (fixed on ${n.fixed}, still present on ${plural(n.broken, "page")})` : ` (still present on ${plural(n.broken, "page")})`;
      lines.push(`- ${plainIssue(c)}${progress}, ${c.before_occurrences} → ${c.after_occurrences} occurrences`);
    }
  }
  if (unverified.length > 0) {
    lines.push(`**${plural(unverified.length, "issue")} could not be confirmed** on every page:`);
    for (const c of unverified) {
      const n = pageCounts(c);
      const reasons = Array.from(new Set(c.pages.filter((p) => p.reason).map((p) => plainReason(p.reason!))));
      lines.push(`- ${plainIssue(c)}: no longer found on ${plural(n.fixed, "page")}; not checked on ${plural(n.unverified, "page")} because ${reasons.join(" or ")}`);
    }
  }
  if (result.new_issues.length === 0) {
    lines.push("No new problems appeared on the re-checked pages.");
  } else {
    lines.push(`**${plural(result.new_issues.length, "new problem")}** appeared on the re-checked pages:`);
    for (const n of result.new_issues) lines.push(`- ${plainIssue(n)} on ${plural(n.pages.length, "page")}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Markdown (verify.md)
// ---------------------------------------------------------------------------

function newIssueRow(n: NewIssue): string {
  return `| \`${n.cluster_id}\` | ${n.label} | ${n.wcag_criterion} | ${n.occurrences} | ${n.pages.length} | ${n.pages.slice(0, 5).map(pathOf).join(", ")}${n.pages.length > 5 ? " …" : ""} |`;
}

export function renderVerifyMarkdown(result: VerifyResult): string {
  const lines: string[] = [];
  lines.push(`# Fix verification: ${result.site}`, "");
  lines.push("## Summary", "");
  for (const l of clientSummaryLines(result)) lines.push(l.startsWith("- ") ? l : `${l}\n`);
  lines.push("");
  lines.push("## Details", "");
  lines.push(`Baseline scan: \`${result.baseline_scan_id}\`  `);
  lines.push(`Rescan: \`${result.rescan_scan_id}\` (${result.verified_at})  `);
  lines.push(`Checks run: ${result.checks_run.join(", ")}  `);
  lines.push(`Pages rescanned: ${result.pages_rescanned.length}`, "");
  lines.push("| Cluster | Issue | WCAG | Status | Pages fixed / still broken / not verified | Occurrences before → after | Checks |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const c of result.clusters) {
    const n = pageCounts(c);
    lines.push(`| \`${c.cluster_id}\` | ${c.label} | ${c.wcag_criterion} | ${c.status.replace("_", " ")} | ${n.fixed} / ${n.broken} / ${n.unverified} | ${c.before_occurrences} → ${c.after_occurrences} | ${c.checks.join(", ")} |`);
  }
  for (const c of result.clusters) {
    const notFixed = c.pages.filter((p) => p.status !== "fixed");
    if (notFixed.length === 0 && c.unlisted_pages === 0) continue;
    lines.push("", `### ${c.label} (\`${c.cluster_id}\`)`);
    for (const p of notFixed) {
      lines.push(p.status === "still_broken"
        ? `- still broken: ${pathOf(p.page_url)} (${p.before} → ${p.after})`
        : `- not verified: ${pathOf(p.page_url)}: ${p.reason}`);
    }
    if (c.unlisted_pages > 0) {
      lines.push(`- ${c.unlisted_pages} more page(s) are known only by count in the baseline and were not rescanned`);
    }
  }
  lines.push("", "### Newly broken", "");
  if (result.new_issues.length === 0) {
    lines.push("None on the rescanned pages.");
  } else {
    lines.push("| Cluster | Issue | WCAG | Occurrences | Pages | Where |", "|---|---|---|---|---|---|");
    for (const n of result.new_issues) lines.push(newIssueRow(n));
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HTML section
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Minimal markdown-to-HTML for the summary lines (bold and list items). */
function summaryHtml(lines: string[]): string {
  const out: string[] = [];
  let inList = false;
  for (const l of lines) {
    const html = esc(l.replace(/^- /, "")).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    if (l.startsWith("- ")) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${html}</li>`);
    } else {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(`<p>${html}</p>`);
    }
  }
  if (inList) out.push("</ul>");
  return out.join("");
}

export function renderVerifyHtml(result: VerifyResult): string {
  const rows = result.clusters.map((c) => {
    const n = pageCounts(c);
    return `<tr><td><code>${esc(c.cluster_id)}</code></td><td>${esc(c.label)}</td><td>${esc(c.wcag_criterion)}</td><td>${esc(c.status.replace("_", " "))}</td><td>${n.fixed} / ${n.broken} / ${n.unverified}</td><td>${c.before_occurrences} &rarr; ${c.after_occurrences}</td></tr>`;
  }).join("");
  const newRows = result.new_issues.map((ni) =>
    `<tr><td><code>${esc(ni.cluster_id)}</code></td><td>${esc(ni.label)}</td><td>${esc(ni.wcag_criterion)}</td><td>${ni.occurrences}</td><td>${ni.pages.length}</td></tr>`).join("");
  return `
    <section class="verification" id="verification">
      <h2>Fix Verification</h2>
      <div class="verify-summary">${summaryHtml(clientSummaryLines(result))}</div>
      <h3>Per-issue results</h3>
      <table class="topfix-table">
        <thead><tr><th>Cluster</th><th>Issue</th><th>WCAG</th><th>Status</th><th>Pages fixed / still broken / not verified</th><th>Occurrences before &rarr; after</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <h3>Newly broken</h3>
      ${newRows
        ? `<table class="topfix-table"><thead><tr><th>Cluster</th><th>Issue</th><th>WCAG</th><th>Occurrences</th><th>Pages</th></tr></thead><tbody>${newRows}</tbody></table>`
        : "<p>None on the rescanned pages.</p>"}
      <p class="topfix-note">Baseline ${esc(result.baseline_scan_id)}, rescan ${esc(result.rescan_scan_id)}. Pages where a needed check failed or was skipped are listed as not verified and never counted as fixed.</p>
    </section>`;
}

/** Load verify.json from a rescan's data folder, or null. */
export function loadVerification(dataDir: string, scanId: string): VerifyResult | null {
  const path = join(dataDir, scanId, "verify.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as VerifyResult;
  } catch {
    return null;
  }
}
