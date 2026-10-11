import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Browser } from "playwright";
import type { Finding, Severity } from "../types.js";
import { openDatabase, getScanSession, listFindingsByScan, listPageSnapshots } from "../store/db.js";
import { queryFindings } from "../report/generator.js";
import { buildReportDataWithComparison } from "../report/pdf-renderer.js";
import { shouldFilterFromClientReport } from "../report/findings-dump.js";
import {
  clusterFindings,
  clusterLabel,
  elementSignature,
  partitionExclusions,
  type Cluster,
  type PagedFinding,
} from "../report/clustering.js";
import { findingPageUrls } from "../report/occurrences.js";
import { TOP_FIXES_LIMIT } from "../report/top-fixes-report.js";
import { renderHtmlReport } from "../report/templates/html-template.js";
import { renderVerifyMarkdown } from "../report/verify-report.js";
import { checkForFinding, withPrerequisites, tiersForChecks } from "./check-registry.js";
import type { ScanCoverage } from "./coverage.js";
import { scan } from "./scanner.js";
import type { ProgressReporter } from "./progress.js";
import type { PromptRunner } from "./prompt-runner.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PageVerdict = "fixed" | "still_broken" | "not_verified";

export interface VerifyPageResult {
  page_url: string;
  status: PageVerdict;
  /** Occurrences on this page in the baseline */
  before: number;
  /** Occurrences on this page in the rescan (0 when fixed or not verified) */
  after: number;
  /** Why the page could not be verified */
  reason?: string;
}

export interface VerifyClusterResult {
  cluster_id: string;
  signature: string;
  label: string;
  failure_type: string;
  wcag_criterion: string;
  severity: Severity;
  /** Representative element HTML from the baseline (for plain-language text) */
  example_html: string;
  checks: string[];
  /** still_broken if any page is; else not_verified if any page is; else fixed */
  status: PageVerdict;
  pages: VerifyPageResult[];
  before_occurrences: number;
  after_occurrences: number;
  /** Baseline pages known only by count (older scans), so not rescanned */
  unlisted_pages: number;
}

export interface NewIssue {
  cluster_id: string;
  signature: string;
  label: string;
  failure_type: string;
  wcag_criterion: string;
  severity: Severity;
  example_html: string;
  pages: string[];
  occurrences: number;
}

export interface VerifyResult {
  baseline_scan_id: string;
  rescan_scan_id: string;
  site: string;
  baseline_date: string;
  verified_at: string;
  pages_rescanned: string[];
  checks_run: string[];
  clusters: VerifyClusterResult[];
  new_issues: NewIssue[];
  summary: {
    issues_checked: number;
    fixed_issues: number;
    fixed_pages: number;
    remaining_issues: number;
    not_verified_issues: number;
    new_issues: number;
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Clusters to verify: the ones named (by id or unique id prefix), all of
 * them, or by default the baseline's Top fixes.
 */
export function selectClusters(clusters: Cluster[], options: { clusterIds?: string[]; all?: boolean }): Cluster[] {
  if (options.clusterIds && options.clusterIds.length > 0) {
    return options.clusterIds.map((id) => {
      const matches = clusters.filter((c) => c.cluster_id === id || c.cluster_id.startsWith(id));
      if (matches.length === 0) throw new Error(`No cluster ${id} in the baseline scan`);
      if (matches.length > 1) throw new Error(`Cluster id ${id} is ambiguous (${matches.length} matches)`);
      return matches[0];
    });
  }
  return options.all ? clusters : clusters.slice(0, TOP_FIXES_LIMIT);
}

/** Checks that produced the clusters' findings (with prerequisites). */
export function checksForClusters(clusters: Cluster[]): string[] {
  const checks = new Set<string>();
  for (const c of clusters) {
    for (const f of c.findings) {
      const check = checkForFinding(f);
      if (check) checks.add(check);
    }
  }
  return withPrerequisites(checks);
}

// ---------------------------------------------------------------------------
// Diff (pure)
// ---------------------------------------------------------------------------

/** signature → page URL → occurrences, plus signatures with pages known only by count. */
export interface FindingIndex {
  pages: Map<string, Map<string, number>>;
  incomplete: Set<string>;
}

export function indexFindings(findings: PagedFinding[]): FindingIndex {
  const pages = new Map<string, Map<string, number>>();
  const incomplete = new Set<string>();
  for (const { finding, pageUrl } of findings) {
    const sig = elementSignature(finding);
    const { urls, complete } = findingPageUrls(finding, pageUrl);
    if (!complete) incomplete.add(sig);
    const byPage = pages.get(sig) ?? new Map<string, number>();
    for (const u of urls) byPage.set(u, (byPage.get(u) ?? 0) + 1);
    pages.set(sig, byPage);
  }
  return { pages, incomplete };
}

export interface DiffInput {
  baselineScanId: string;
  rescanScanId: string;
  site: string;
  baselineDate: string;
  selected: Cluster[];
  /** Every baseline finding that counts (client view, exclusions removed) */
  baseline: PagedFinding[];
  /** Every rescan finding that counts, filtered the same way */
  rescan: PagedFinding[];
  coverage: ScanCoverage | null;
  checksRun: string[];
  platform?: string;
}

function checksFor(cluster: Cluster): string[] {
  return Array.from(new Set(cluster.findings.map(checkForFinding).filter((c): c is string => c !== null))).sort();
}

/** Why `page` cannot count as verified for these checks, or null if every check ran there. */
function unverifiedReason(coverage: ScanCoverage | null, page: string, checks: string[]): string | null {
  if (checks.length === 0) return "no check is known to produce this issue";
  if (!coverage) return "coverage was not recorded for the rescan";
  if (!coverage.page_urls.includes(page)) {
    const failure = coverage.crawl_failures.find((f) => f.url === page);
    return failure ? `page could not be loaded: ${failure.error}` : "page was not captured by the rescan";
  }
  for (const check of checks) {
    const entry = coverage.entries.find((e) => e.check === check && e.page_url === page);
    if (!entry) return `${check} was not recorded on this page`;
    if (entry.status === "failed") return `${check} failed: ${entry.message ?? "unknown error"}`;
    if (entry.status === "skipped") return `${check} skipped: ${entry.message ?? "no reason given"}`;
  }
  return null;
}

/**
 * Compare a rescan with its baseline, cluster by cluster and page by page.
 * A page where a needed check failed or was skipped is "not verified" and
 * never counted as fixed.
 */
export function diffVerification(input: DiffInput): VerifyResult {
  const baselineIndex = indexFindings(input.baseline);
  const rescanIndex = indexFindings(input.rescan);

  const clusters: VerifyClusterResult[] = input.selected.map((cluster) => {
    const checks = checksFor(cluster);
    const pages: VerifyPageResult[] = cluster.page_urls.map((page) => {
      const before = baselineIndex.pages.get(cluster.signature)?.get(page) ?? 0;
      const reason = unverifiedReason(input.coverage, page, checks);
      if (reason) return { page_url: page, status: "not_verified", before, after: 0, reason };
      const after = rescanIndex.pages.get(cluster.signature)?.get(page) ?? 0;
      return { page_url: page, status: after > 0 ? "still_broken" : "fixed", before, after };
    });
    const status: PageVerdict = pages.some((p) => p.status === "still_broken")
      ? "still_broken"
      : pages.some((p) => p.status === "not_verified") || pages.length === 0
        ? "not_verified"
        : "fixed";
    return {
      cluster_id: cluster.cluster_id,
      signature: cluster.signature,
      label: clusterLabel(cluster),
      failure_type: cluster.failure_type,
      wcag_criterion: cluster.wcag_criterion,
      severity: cluster.severity,
      example_html: cluster.representative.html,
      checks,
      status,
      pages,
      before_occurrences: pages.reduce((n, p) => n + p.before, 0),
      after_occurrences: pages.reduce((n, p) => n + p.after, 0),
      unlisted_pages: Math.max(0, cluster.page_count - cluster.page_urls.length),
    };
  });

  // Newly broken: rescan occurrences on pages where the baseline did not
  // have that signature. Signatures whose baseline pages are known only by
  // count are not treated as new (the page may simply be unlisted).
  const new_issues: NewIssue[] = [];
  for (const cluster of clusterFindings(input.rescan, { platform: input.platform })) {
    const baselinePages = baselineIndex.pages.get(cluster.signature);
    if (baselinePages && baselineIndex.incomplete.has(cluster.signature)) continue;
    const byPage = rescanIndex.pages.get(cluster.signature) ?? new Map<string, number>();
    const newPages = cluster.page_urls.filter((p) => !baselinePages?.has(p));
    if (newPages.length === 0) continue;
    new_issues.push({
      cluster_id: cluster.cluster_id,
      signature: cluster.signature,
      label: clusterLabel(cluster),
      failure_type: cluster.failure_type,
      wcag_criterion: cluster.wcag_criterion,
      severity: cluster.severity,
      example_html: cluster.representative.html,
      pages: newPages,
      occurrences: newPages.reduce((n, p) => n + (byPage.get(p) ?? 1), 0),
    });
  }

  const fixed = clusters.filter((c) => c.status === "fixed");
  const fixedPages = new Set(fixed.flatMap((c) => c.pages.map((p) => p.page_url)));
  return {
    baseline_scan_id: input.baselineScanId,
    rescan_scan_id: input.rescanScanId,
    site: input.site,
    baseline_date: input.baselineDate,
    verified_at: new Date().toISOString(),
    pages_rescanned: input.coverage?.page_urls ?? [],
    checks_run: input.checksRun,
    clusters,
    new_issues,
    summary: {
      issues_checked: clusters.length,
      fixed_issues: fixed.length,
      fixed_pages: fixedPages.size,
      remaining_issues: clusters.filter((c) => c.status === "still_broken").length,
      not_verified_issues: clusters.filter((c) => c.status === "not_verified").length,
      new_issues: new_issues.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Findings as the client report counts them: noisy ones filtered, exclusions removed. */
function countedFindings(findings: Finding[], pageUrls: Map<string, string>): PagedFinding[] {
  const paged = findings
    .filter((f) => !shouldFilterFromClientReport(f))
    .map((f) => ({ finding: f, pageUrl: pageUrls.get(f.page_snapshot_id) ?? "" }));
  return partitionExclusions(paged).kept;
}

export interface VerifyOptions {
  dataDir: string;
  baselineScanId: string;
  clusterIds?: string[];
  all?: boolean;
  reporter?: ProgressReporter;
  pageConcurrency?: number;
  apiKey?: string;
  promptRunner?: PromptRunner;
}

export interface VerifyRun {
  result: VerifyResult;
  files: { json: string; markdown: string; html: string };
}

/**
 * Rescan the pages of the selected baseline clusters with only the checks
 * that produced them, then diff by cluster signature. Writes verify.json,
 * verify.md and report.html into the rescan's data folder.
 */
export async function runVerify(options: VerifyOptions, browser?: Browser): Promise<VerifyRun> {
  const dbPath = join(options.dataDir, "wcag.db");
  let db = openDatabase(dbPath);
  let selected: Cluster[];
  let site: string;
  let baselineDate: string;
  let platform: string;
  try {
    const baseline = getScanSession(db, options.baselineScanId);
    if (!baseline) throw new Error(`Baseline scan not found: ${options.baselineScanId}`);
    site = baseline.url;
    baselineDate = baseline.initiated_at;
    platform = baseline.platform;
    const data = queryFindings(db, options.baselineScanId);
    const pageUrls = new Map(listPageSnapshots(db, options.baselineScanId).map((p) => [p.id, p.url]));
    const clusters = clusterFindings(
      data.groups.flatMap((g) => g.findings).map((f) => ({ finding: f, pageUrl: pageUrls.get(f.page_snapshot_id) ?? "" })),
      { platform },
    );
    selected = selectClusters(clusters, { clusterIds: options.clusterIds, all: options.all });
  } finally {
    db.close();
  }
  if (selected.length === 0) throw new Error("No clusters to verify in the baseline scan");

  const checks = checksForClusters(selected);
  const pages = Array.from(new Set(selected.flatMap((c) => c.page_urls))).sort();
  options.reporter?.complete(
    "verify",
    `Verifying ${selected.length} issue(s) on ${pages.length} page(s) with ${checks.join(", ") || "no checks"}`,
  );

  const rescan = await scan({
    url: site,
    dataDir: options.dataDir,
    urls: pages,
    checks,
    tiers: tiersForChecks(checks),
    baselineScanId: options.baselineScanId,
    reporter: options.reporter,
    pageConcurrency: options.pageConcurrency,
    apiKey: options.apiKey,
    promptRunner: options.promptRunner,
  }, browser);
  const rescanId = rescan.scanSession.id;

  db = openDatabase(dbPath);
  try {
    const baselineUrls = new Map(listPageSnapshots(db, options.baselineScanId).map((p) => [p.id, p.url]));
    const rescanUrls = new Map(listPageSnapshots(db, rescanId).map((p) => [p.id, p.url]));
    const result = diffVerification({
      baselineScanId: options.baselineScanId,
      rescanScanId: rescanId,
      site,
      baselineDate,
      selected,
      baseline: countedFindings(listFindingsByScan(db, options.baselineScanId), baselineUrls),
      rescan: countedFindings(listFindingsByScan(db, rescanId), rescanUrls),
      coverage: rescan.coverage,
      checksRun: checks,
      platform,
    });

    const dir = join(options.dataDir, rescanId);
    mkdirSync(dir, { recursive: true });
    const json = join(dir, "verify.json");
    const markdown = join(dir, "verify.md");
    const html = join(dir, "report.html");
    writeFileSync(json, JSON.stringify(result, null, 2), "utf8");
    writeFileSync(markdown, renderVerifyMarkdown(result), "utf8");
    const data = buildReportDataWithComparison(db, rescanId);
    writeFileSync(html, renderHtmlReport(data, {
      pageUrlMap: rescanUrls,
      dataDir: options.dataDir,
      coverage: rescan.coverage,
      verification: result,
    }), "utf8");
    return { result, files: { json, markdown, html } };
  } finally {
    db.close();
  }
}
