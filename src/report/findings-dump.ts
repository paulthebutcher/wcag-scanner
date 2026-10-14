import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Finding, ConfidenceTier, FalsePositiveRisk, Severity, DetectedBy } from "../types.js";
import { listFindingsByScan, getScanSession, getPageSnapshot } from "../store/db.js";
import { loadCoverage, type ScanCoverage } from "../core/coverage.js";
import { renderCoverageMarkdown } from "./coverage-report.js";
import { isDeduplicated, pageOccurrences, findingPageUrls } from "./occurrences.js";
import { clusterFindings, partitionExclusions, type Cluster, type ExcludedFinding } from "./clustering.js";
import { renderTopFixesMarkdown, renderPageLevelMarkdown, renderExcludedMarkdown } from "./top-fixes-report.js";
import { estimateRemediation, formatEstimate, formatHours, unitHoursFor, type RemediationEstimate } from "./effort.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TriageBucket = "fix_now" | "verify_manually" | "possibly_noisy" | "advisory";

export interface TriagedFinding {
  finding: Finding;
  bucket: TriageBucket;
  pageUrl: string;
}

// ---------------------------------------------------------------------------
// Triage classification
// ---------------------------------------------------------------------------

/**
 * Classify a finding into a triage bucket based on its sub-entity data.
 *
 * Buckets (evaluated in priority order):
 *   advisory        — severity === "advisory"
 *   fix_now         — axe/playwright with high confidence and critical/major severity
 *   possibly_noisy  — claude_api with high FP risk or needs_review tier
 *   verify_manually — anything requiring human review or moderate-confidence
 */
export function classifyTriage(finding: Finding): TriageBucket {
  const severity: Severity = finding.severity;
  const detectedBy: DetectedBy = finding.evidence.detected_by;
  const tier: ConfidenceTier = finding.confidence.tier;
  const fpRisk: FalsePositiveRisk = finding.confidence.false_positive_risk;
  const requiresHuman = finding.confidence.requires_human;

  if (severity === "advisory") return "advisory";

  if (
    detectedBy === "claude_api" &&
    (fpRisk === "high" || tier === "needs_review")
  ) {
    return "possibly_noisy";
  }

  if (
    (detectedBy === "axe_core" || detectedBy === "playwright") &&
    (tier === "definitive" || tier === "high") &&
    (severity === "critical" || severity === "major")
  ) {
    return "fix_now";
  }

  if (
    requiresHuman ||
    fpRisk === "medium" ||
    tier === "moderate"
  ) {
    return "verify_manually";
  }

  // Catch-all: anything that didn't match a bucket defaults to verify_manually.
  return "verify_manually";
}

/** Should this finding be filtered from the client-facing report? */
export function shouldFilterFromClientReport(finding: Finding): boolean {
  return classifyTriage(finding) === "possibly_noisy";
}

// ---------------------------------------------------------------------------
// Severity ordering for within-bucket sort
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  advisory: 3,
};

const BUCKET_ORDER: Record<TriageBucket, number> = {
  fix_now: 0,
  verify_manually: 1,
  possibly_noisy: 2,
  advisory: 3,
};

const BUCKET_LABELS: Record<TriageBucket, string> = {
  fix_now: "Fix now",
  verify_manually: "Verify manually",
  possibly_noisy: "Possibly noisy",
  advisory: "Advisory",
};

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

/** Render a single finding as a markdown document. */
export function renderFindingMarkdown(tf: TriagedFinding): string {
  const { finding, bucket, pageUrl } = tf;
  const ev = finding.evidence;
  const an = finding.analysis;
  const cf = finding.confidence;
  const rm = finding.remediation;

  const lines: string[] = [];
  lines.push(`# Finding ${finding.id}`);
  lines.push("");
  lines.push(`**WCAG ${finding.wcag_criterion}** (${finding.wcag_level}) — ${finding.category}`);
  lines.push(`**Severity:** ${finding.severity}  |  **Triage:** ${BUCKET_LABELS[bucket]}`);
  lines.push(`**Detection:** ${ev.detected_by}  |  **Confidence:** ${cf.tier} (${cf.score.toFixed(2)})  |  **FP risk:** ${cf.false_positive_risk}  |  **Requires human:** ${cf.requires_human}`);
  lines.push(`**Page:** ${pageUrl}`);
  lines.push("");

  lines.push("## Element");
  lines.push("```");
  lines.push(`selector: ${ev.element_selector}`);
  lines.push("```");
  const html = ev.element_html.length > 2000
    ? ev.element_html.slice(0, 2000) + "\n/* ... truncated */"
    : ev.element_html;
  lines.push("```html");
  lines.push(html);
  lines.push("```");
  lines.push("");

  if (Object.keys(ev.aria_attributes).length > 0) {
    lines.push("## ARIA attributes");
    lines.push("```json");
    lines.push(JSON.stringify(ev.aria_attributes, null, 2));
    lines.push("```");
    lines.push("");
  }

  if (ev.element_computed_styles && Object.keys(ev.element_computed_styles).length > 0) {
    lines.push("## Computed styles");
    lines.push("```json");
    lines.push(JSON.stringify(ev.element_computed_styles, null, 2));
    lines.push("```");
    lines.push("");
  }

  if (ev.measured_values && Object.keys(ev.measured_values).length > 0) {
    lines.push("## Measured values");
    lines.push("```json");
    lines.push(JSON.stringify(ev.measured_values, null, 2));
    lines.push("```");
    lines.push("");
  }

  if (ev.keyboard_sequence && ev.keyboard_sequence.length > 0) {
    lines.push("## Keyboard sequence");
    lines.push("```json");
    lines.push(JSON.stringify(ev.keyboard_sequence, null, 2));
    lines.push("```");
    lines.push("");
  }

  lines.push("## Analysis");
  lines.push(`**Method:** ${an.method}`);
  lines.push("");
  lines.push(`**Reasoning:** ${an.reasoning}`);
  lines.push("");
  lines.push(`**Impact:** ${an.impact_description}`);
  lines.push("");
  lines.push(`**Affected users:** ${an.affected_users.join(", ")}`);
  lines.push("");
  lines.push(`**Confidence basis:** ${cf.basis}`);
  lines.push("");

  if (an.llm_input) {
    lines.push("## LLM input");
    lines.push(`_Screenshot provided:_ ${an.llm_input.screenshot_provided}`);
    lines.push("");
    lines.push("```");
    lines.push(an.llm_input.prompt);
    lines.push("```");
    lines.push("");
  }

  if (an.llm_output) {
    lines.push("## LLM output");
    lines.push(`_Model:_ ${an.llm_output.model}  |  _Tokens:_ ${an.llm_output.tokens_used}`);
    lines.push("");
    lines.push("```");
    lines.push(an.llm_output.raw_response);
    lines.push("```");
    lines.push("");
  }

  lines.push("## Remediation");
  lines.push(`**Generic fix:** ${rm.generic_fix}`);
  lines.push("");
  if (rm.platform_fix?.steps?.length) {
    lines.push(`**Platform (${rm.platform_fix.platform}) steps:**`);
    for (const step of rm.platform_fix.steps) {
      lines.push(`- ${step}`);
    }
    lines.push("");
  }
  if (rm.code_fix) {
    lines.push("**Code fix:**");
    lines.push("```");
    lines.push(rm.code_fix);
    lines.push("```");
    lines.push("");
  }
  lines.push(`**Estimated effort:** ${rm.estimated_effort}`);
  lines.push("");

  // Reference screenshot paths (actual PNGs live next to the finding file)
  lines.push("## Screenshots");
  lines.push(`- element: \`${finding.id}-element.png\``);
  lines.push(`- context: \`${finding.id}-context.png\``);
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSONL line
// ---------------------------------------------------------------------------

function renderFindingJsonl(tf: TriagedFinding, exclusion: ExcludedFinding | undefined): string {
  const { finding, bucket, pageUrl } = tf;
  return JSON.stringify({
    id: finding.id,
    wcag_criterion: finding.wcag_criterion,
    wcag_level: finding.wcag_level,
    severity: finding.severity,
    category: finding.category,
    triage_bucket: bucket,
    detected_by: finding.evidence.detected_by,
    confidence_tier: finding.confidence.tier,
    confidence_score: finding.confidence.score,
    false_positive_risk: finding.confidence.false_positive_risk,
    requires_human: finding.confidence.requires_human,
    page_url: pageUrl,
    element_selector: finding.evidence.element_selector,
    element_html: finding.evidence.element_html,
    failure_type: finding.evidence.measured_values?.failure_type ?? null,
    page_occurrences: pageOccurrences(finding),
    excluded: exclusion ? { reason: exclusion.reason, detail: exclusion.detail } : null,
    also_found_on_urls: findingPageUrls(finding, pageUrl).urls.filter((u) => u !== pageUrl),
    reasoning: finding.analysis.reasoning,
    impact: finding.analysis.impact_description,
    llm_input: finding.analysis.llm_input,
    llm_output: finding.analysis.llm_output,
    generic_fix: finding.remediation.generic_fix,
    estimated_effort: finding.remediation.estimated_effort,
  });
}

// ---------------------------------------------------------------------------
// Aggregate markdown
// ---------------------------------------------------------------------------

/**
 * Effort estimate with every fix unit, so it can be compared line by line
 * with a timesheet and the hours in report/effort.ts retuned.
 */
function renderEffortMarkdown(estimate: RemediationEstimate): string {
  const lines = [
    "## Effort estimate",
    "",
    `Total: ${formatEstimate(estimate)} (fixes, QA, manual review, client coordination). Counted per change, not per instance.`,
    "",
    "| Line item | Hours |",
    "|---|---|",
  ];
  for (const li of [estimate.fixes, estimate.qa, estimate.review, estimate.coordination]) {
    lines.push(`| ${li.label} | ${formatHours(li.low, li.high)} |`);
  }
  lines.push(`| Not included: ${estimate.advisoryAddOn.label} | ${formatHours(estimate.advisoryAddOn.low, estimate.advisoryAddOn.high)} |`);
  lines.push("", "<details><summary>Every change</summary>", "", "| Kind | Change | WCAG | Findings | Hours |", "|---|---|---|---|---|");
  for (const u of estimate.units) {
    lines.push(`| ${u.advisory ? `${u.kind} (advisory)` : u.kind} | ${u.label.replace(/\|/g, "\\|")} | ${u.wcag_criterion} | ${u.findings} | ${formatHours(u.low, u.high)} |`);
  }
  lines.push("", "</details>", "");
  return lines.join("\n");
}

/**
 * Deduplicated findings (one stored element standing for several pages):
 * unique elements alongside page occurrences, per criterion and failure
 * type, so they can be compared with axe counts (one per page).
 */
function renderOccurrenceTable(triaged: TriagedFinding[]): string[] {
  const rows = new Map<string, { unique: number; occurrences: number }>();
  const deduped = new Set<string>();
  for (const tf of triaged) {
    const ft = (tf.finding.evidence.measured_values?.failure_type as string) ?? "(none)";
    const key = `${tf.finding.wcag_criterion} / ${ft}`;
    const row = rows.get(key) ?? { unique: 0, occurrences: 0 };
    row.unique += 1;
    row.occurrences += pageOccurrences(tf.finding);
    rows.set(key, row);
    if (isDeduplicated(tf.finding)) deduped.add(key);
  }
  if (deduped.size === 0) return [];
  const lines = [
    "## Deduplicated findings",
    "",
    "Shared elements (navigation, footer, template components) are stored once with the pages they also appear on. Page occurrences count every page, the way axe findings are counted.",
    "",
    "| Criterion / failure type | Unique elements | Page occurrences |",
    "|---|---|---|",
  ];
  for (const key of Array.from(deduped).sort()) {
    const r = rows.get(key)!;
    lines.push(`| ${key} | ${r.unique} | ${r.occurrences} |`);
  }
  lines.push("");
  return lines;
}

function renderAggregateMarkdown(
  scanId: string,
  scanUrl: string,
  allTriaged: TriagedFinding[],
  coverage: ScanCoverage | null = null,
  platform = "webflow",
): string {
  // Needs-manual-check and third-party findings are listed in their own
  // sections and left out of the buckets, totals and Top fixes.
  const { kept, excluded } = partitionExclusions(allTriaged.map((tf) => ({ finding: tf.finding, pageUrl: tf.pageUrl })));
  const keptIds = new Set(kept.map((k) => k.finding.id));
  const triaged = allTriaged.filter((tf) => keptIds.has(tf.finding.id));
  const clusters = clusterFindings(kept, { platform });
  // Estimate over the client view (noisy findings filtered), excluded ones included
  const pageUrlById = new Map(allTriaged.map((tf) => [tf.finding.page_snapshot_id, tf.pageUrl]));
  const pageUrlOf = (id: string) => pageUrlById.get(id) ?? id;
  const estimate = estimateRemediation(
    allTriaged.filter((tf) => !shouldFilterFromClientReport(tf.finding)).map((tf) => tf.finding),
    pageUrlOf,
  );

  const buckets = new Map<TriageBucket, TriagedFinding[]>();
  for (const tf of triaged) {
    if (!buckets.has(tf.bucket)) buckets.set(tf.bucket, []);
    buckets.get(tf.bucket)!.push(tf);
  }

  const lines: string[] = [];
  lines.push(`# Findings — ${scanUrl}`);
  lines.push("");
  lines.push(`Scan ID: \`${scanId}\``);
  lines.push(`Total findings: ${triaged.length}`);
  if (excluded.length > 0) {
    lines.push(`Excluded from counts: ${excluded.length} (see Needs manual check and Third-party below)`);
  }
  lines.push("");
  lines.push("| Bucket | Count |");
  lines.push("|---|---|");
  for (const bucket of ["fix_now", "verify_manually", "possibly_noisy", "advisory"] as TriageBucket[]) {
    lines.push(`| ${BUCKET_LABELS[bucket]} | ${buckets.get(bucket)?.length ?? 0} |`);
  }
  lines.push("");
  const hoursFor = (c: Cluster) => {
    const unit = unitHoursFor(estimate, c.findings[0], pageUrlOf);
    return unit ? formatHours(unit.low, unit.high) : "";
  };
  lines.push(renderTopFixesMarkdown(clusters, undefined, hoursFor));
  const perPage = renderPageLevelMarkdown(clusters, hoursFor);
  if (perPage) lines.push(perPage);
  lines.push(renderEffortMarkdown(estimate));
  lines.push(renderCoverageMarkdown(coverage));
  lines.push(...renderOccurrenceTable(triaged));

  for (const bucket of ["fix_now", "verify_manually", "possibly_noisy", "advisory"] as TriageBucket[]) {
    const items = buckets.get(bucket) ?? [];
    if (items.length === 0) continue;
    lines.push(`## ${BUCKET_LABELS[bucket]} (${items.length})`);
    lines.push("");
    for (const tf of items) {
      const m = tf.finding.evidence.measured_values ?? {};
      const ft = (m.failure_type as string) ?? "(none)";
      lines.push(`### ${tf.finding.id} — WCAG ${tf.finding.wcag_criterion} / ${ft}`);
      lines.push(`- page: ${tf.pageUrl}`);
      if (isDeduplicated(tf.finding)) {
        lines.push(`- page occurrences: ${pageOccurrences(tf.finding)} (stored once; same element on other pages)`);
      }
      lines.push(`- severity: ${tf.finding.severity}`);
      lines.push(`- detected_by: ${tf.finding.evidence.detected_by}, tier: ${tf.finding.confidence.tier}, fp: ${tf.finding.confidence.false_positive_risk}`);
      lines.push(`- selector: \`${tf.finding.evidence.element_selector}\``);
      lines.push(`- reasoning: ${tf.finding.analysis.reasoning}`);
      lines.push(`- see [\`findings/${tf.finding.id}.md\`](findings/${tf.finding.id}.md)`);
      lines.push("");
    }
  }

  lines.push(renderExcludedMarkdown(excluded));

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Dump all findings for a scan as per-finding markdown, an aggregate markdown,
 * and a JSONL file. Writes under `<outDir>/<scanId>/`.
 *
 * Returns the output directory.
 */
export function dumpFindings(
  db: Database.Database,
  scanId: string,
  dataDir: string,
): { dir: string; count: number } {
  const session = getScanSession(db, scanId);
  if (!session) throw new Error(`Scan session not found: ${scanId}`);

  const findings = listFindingsByScan(db, scanId);

  // Resolve page URLs from page_snapshot_id
  const pageUrlCache = new Map<string, string>();
  const triaged: TriagedFinding[] = findings.map((f) => {
    let pageUrl = pageUrlCache.get(f.page_snapshot_id);
    if (pageUrl === undefined) {
      const snap = getPageSnapshot(db, f.page_snapshot_id);
      pageUrl = snap?.url ?? "(unknown page)";
      pageUrlCache.set(f.page_snapshot_id, pageUrl);
    }
    return {
      finding: f,
      bucket: classifyTriage(f),
      pageUrl,
    };
  });

  // Sort by bucket, then severity, then criterion
  triaged.sort((a, b) => {
    const bucketCmp = BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket];
    if (bucketCmp !== 0) return bucketCmp;
    const sevCmp = SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity];
    if (sevCmp !== 0) return sevCmp;
    return a.finding.wcag_criterion.localeCompare(b.finding.wcag_criterion);
  });

  const scanDir = join(dataDir, scanId);
  const findingsDir = join(scanDir, "findings");
  mkdirSync(findingsDir, { recursive: true });

  // Per-finding markdown files
  for (const tf of triaged) {
    const path = join(findingsDir, `${tf.finding.id}.md`);
    writeFileSync(path, renderFindingMarkdown(tf), "utf8");
  }

  // Aggregate markdown
  const aggregatePath = join(scanDir, "findings.md");
  writeFileSync(aggregatePath, renderAggregateMarkdown(scanId, session.url, triaged, loadCoverage(dataDir, scanId), session.platform), "utf8");

  // JSONL (every finding; excluded ones are marked)
  const exclusions = new Map(
    partitionExclusions(triaged.map((tf) => ({ finding: tf.finding, pageUrl: tf.pageUrl }))).excluded.map((ex) => [ex.finding.id, ex]),
  );
  const jsonlPath = join(scanDir, "findings.jsonl");
  writeFileSync(jsonlPath, triaged.map((tf) => renderFindingJsonl(tf, exclusions.get(tf.finding.id))).join("\n") + "\n", "utf8");

  return { dir: scanDir, count: triaged.length };
}
