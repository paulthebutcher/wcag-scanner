import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type {
  CriterionStatus,
  ScanSession,
  ScanSummary,
  Finding,
  CheckResult,
  CriterionResult,
  PageSnapshot,
  Platform,
  Viewport,
  SeverityCounts,
  ConfidenceCounts,
  CategoryCounts,
  PlatformAdapter,
  DetectedBy,
  DetectionManifest,
} from "../types.js";
import {
  getPageSnapshot, openDatabase } from "../store/db.js";
import {
  insertScanSession,
  updateScanSession,
  insertPageSnapshot,
  upsertScanSummary,
  upsertCriterionResult,
  deleteCriterionResult,
  updateFinding,
} from "../store/db.js";
import { LocalFileStore } from "../store/files.js";
import { crawl } from "./crawler.js";
import { runAxeChecks, aggregateAxeCriteria, type AxeRuleOutcome } from "../checks/automated/index.js";
import { pacedGoto, setActivePacer, type ScanEtiquette } from "./etiquette.js";
import { CoverageRecorder, writeCoverage, type ScanCoverage } from "./coverage.js";
import { CHECK_TIERS } from "./check-registry.js";
import { settleCriterionResults } from "./criterion-status.js";
import { WCAG_AA_CRITERION_IDS } from "./wcag-criteria.js";
import { withoutRawTextContent } from "./markup.js";
import { containersOf, isThirdPartyFinding, loadThirdPartyConfig, tagCheckResults, thirdPartyTagOf, writeThirdPartyReport, type EmbedSweepStop } from "./third-party.js";
import { createImageFetcher } from "../checks/semantic/image-fetch.js";
import { createFindings } from "./evidence.js";
import { analyze } from "./analyzer.js";
import { isNeedsReview, scoreConfidence } from "./confidence.js";
export { isNeedsReview } from "./confidence.js";
import { WebflowAdapter, getRemediationTemplate, buildSpecificRemediation } from "../adapters/webflow.js";
import type { ProgressReporter } from "./progress.js";
import { ScanProgressReporter } from "./progress.js";
// Behavioral checks (Tier 2)
import { runKeyboardChecks, runTrapChecks } from "../checks/behavioral/keyboard.js";
import { runFocusVisibleChecks } from "../checks/behavioral/focus-visible.js";
import { runSkipNavChecks } from "../checks/behavioral/skip-nav.js";
import { runFocusOrderChecks } from "../checks/behavioral/focus-order.js";
import { runModalChecks } from "../checks/behavioral/modal.js";
// Semantic checks (Tier 3)
import { runAltTextChecks } from "../checks/semantic/alt-text.js";
import { runLinkTextChecks } from "../checks/semantic/link-text.js";
import { runHeadingChecks } from "../checks/semantic/headings.js";
import { runConsistentNavChecks } from "../checks/semantic/consistent-nav.js";
import { runLandmarkLabelChecks } from "../checks/semantic/landmark-labels.js";
import { runWidgetAriaChecks } from "../checks/semantic/widget-aria.js";
import { runTableStructureChecks } from "../checks/semantic/table-structure.js";
import { runDuplicateLinkChecks } from "../checks/semantic/duplicate-links.js";
import { createPromptRunner, type PromptRunner } from "./prompt-runner.js";
// Form checks (Tier 4)
import { discoverForms, formFingerprint } from "../checks/forms/discovery.js";
import type { FormInfo } from "../checks/forms/discovery.js";
import { testFormSubmission, countVisibleFields } from "../checks/forms/submission.js";
import type { SubmissionState } from "../checks/forms/submission.js";
import { evaluateErrorMessages, evaluateInputPurpose } from "../checks/forms/error-evaluation.js";
import { evaluateHighRiskForms, classifyFormRisk } from "../checks/forms/high-risk.js";
// Indicator checks (Tier 5)
import { checkPauseStopHide, checkThreeFlashes } from "../checks/indicators/pause-stop-hide.js";
import { checkMultipleWays, checkMotionActuation } from "../checks/indicators/multiple-ways.js";
import { checkOnInput, surfaceErrorQualityFindings } from "../checks/indicators/on-input.js";
import { dumpFindings, shouldFilterFromClientReport } from "../report/findings-dump.js";
import { estimateRemediation, formatEstimate, type PageUrlOf } from "../report/effort.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScanOptions {
  url: string;
  dataDir: string;
  maxPages?: number;
  cmsSamples?: number;
  /** Which check tiers to run (default: [1]) */
  tiers?: number[];
  viewport?: Viewport;
  /** Progress reporter for CLI output. Defaults to ScanProgressReporter (stderr). */
  reporter?: ProgressReporter;
  /** Anthropic API key (required for Tier 3 semantic checks) */
  apiKey?: string;
  /** Prompt runner concurrency (default: WCAG_CONCURRENCY or 5) */
  concurrency?: number;
  /** Pages loaded and tested in parallel in the browser (default: 4) */
  pageConcurrency?: number;
  /** Inject a PromptRunner for testing */
  promptRunner?: PromptRunner;
  /**
   * Include pages marked noindex (meta robots / X-Robots-Tag). Default false.
   * When false, SERP-hidden pages are fetched once, recorded in
   * ScanResult.excludedByNoindex, and excluded from the scan.
   */
  includeNoindex?: boolean;
  /**
   * Rescan exactly these page URLs instead of crawling (no discovery, no
   * link following). Used by `wcag verify`.
   */
  urls?: string[];
  /** Run only these check ids (see check-registry.ts); default: every check in `tiers` */
  checks?: string[];
  /** For a verification rescan: the scan whose fixes this one checks */
  baselineScanId?: string;
  /** Eval harness only (see src/eval). Unset in every production path. */
  evalHooks?: EvalScanHooks;
  /**
   * Production etiquette (P2-007): identifying user agent and paced loads.
   * The CLI sets it for every production scan; tests and the eval harness
   * (whose transport identifies and paces itself) leave it unset.
   */
  etiquette?: ScanEtiquette;
}

/**
 * Transport hooks for the offline eval harness. They may replace inputs with
 * recorded ones but never change candidates, verdicts, severity, confidence
 * or remediation.
 */
export interface EvalScanHooks {
  /**
   * Called with a form's submission states before error-message evaluation;
   * returns the states to evaluate, with each `screenshotAfter` (the model's
   * image input) replaced by the bytes recorded at capture time, or "" for a
   * recorded no-image state. A screenshot rendered during replay must never
   * reach the model.
   */
  submissionStates?: (pageUrl: string, form: FormInfo, states: SubmissionState[]) => SubmissionState[];
}

export interface ScanEtiquetteReport {
  user_agent: string;
  min_delay_ms: number;
  /** Top-level loads the pacer saw (crawl, checks, reloads) */
  top_level_loads: number;
  /** Smallest gap between consecutive loads per host, ms */
  min_gap_ms: Record<string, number>;
}

export interface ScanResult {
  scanSession: ScanSession;
  summary: ScanSummary;
  findings: Finding[];
  criterionResults: CriterionResult[];
  pageSnapshots: PageSnapshot[];
  /** Pages skipped because they're hidden from SERPs (meta robots / X-Robots-Tag). */
  excludedByNoindex: Array<{ url: string; source: string }>;
  /** URLs of a fixed list that robots.txt disallows (P2-007) */
  excludedByRobots: string[];
  /** What the scan sent and how it paced itself (null without etiquette) */
  etiquette: ScanEtiquetteReport | null;
  /** Per-check, per-page outcome (also written to <dataDir>/<scanId>/coverage.json) */
  coverage: ScanCoverage;
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

const ADAPTERS: PlatformAdapter[] = [
  new WebflowAdapter(),
];

/**
 * Detect the platform from the first page's DOM.
 * Returns the platform name and detection method.
 */
export function detectPlatform(dom: string): { platform: Platform; detected_via: string } {
  for (const adapter of ADAPTERS) {
    if (adapter.detect(dom)) {
      const info = adapter.getPlatformInfo();
      return { platform: info.platform, detected_via: info.detected_via };
    }
  }
  return { platform: "unknown", detected_via: "no_match" };
}

// ---------------------------------------------------------------------------
// Render failures (P2-011)
// ---------------------------------------------------------------------------

/** The loud line printed (and reported) when pages rendered broken. */
export function renderFailedAlert(failed: number, crawled: number): string {
  return `ALERT: ${failed} of ${crawled} page(s) rendered broken or blank and were not checked. `
    + "Findings and passes cover the other pages only; fix the site (often an unclosed <style> in custom code) and rescan.";
}

/**
 * A page that rendered broken was not tested, so no criterion can pass for
 * the scan, nor be called not applicable from the pages that were checked:
 * "passed" and "not_applicable" results become "not_tested". Returns the
 * results it changed (mutated in place).
 */
export function blockPassesOnRenderFailure(results: CriterionResult[], renderFailedPages: number): CriterionResult[] {
  if (renderFailedPages <= 0) return [];
  const changed: CriterionResult[] = [];
  for (const cr of results) {
    if (cr.status !== "passed" && cr.status !== "not_applicable") continue;
    cr.status = "not_tested";
    cr.evidence_summary = `Cannot pass: ${renderFailedPages} page(s) rendered broken and were not checked (was: ${cr.evidence_summary})`;
    changed.push(cr);
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Summary computation
// ---------------------------------------------------------------------------

/**
 * Compute a ScanSummary from a set of findings and criterion results.
 */
export function computeSummary(
  scanSessionId: string,
  findings: Finding[],
  criterionResults: CriterionResult[],
  pageUrlOf?: PageUrlOf,
): ScanSummary {
  // Confirmed findings and needs-review findings are counted separately
  // (P2-030): needs-review findings never count as failures
  const bySeverity: SeverityCounts = { critical: 0, major: 0, minor: 0, advisory: 0 };
  const needsReviewBySeverity: SeverityCounts = { critical: 0, major: 0, minor: 0, advisory: 0 };
  const byConfidence: ConfidenceCounts = { definitive: 0, high: 0, moderate: 0, needs_review: 0 };
  const byCategory: CategoryCounts = {
    contrast: 0, semantics: 0, keyboard: 0, forms: 0, images: 0, aria: 0, structure: 0,
  };

  let needsReview = 0;
  // Third-party embed findings are listed separately (P2-017)
  let thirdParty = 0;
  const thirdPartyByVendor: Record<string, number> = {};
  for (const f of findings) {
    const tp = thirdPartyTagOf(f);
    if (tp) {
      thirdParty++;
      thirdPartyByVendor[tp.vendor_name] = (thirdPartyByVendor[tp.vendor_name] ?? 0) + 1;
      continue;
    }
    if (isNeedsReview(f)) {
      needsReviewBySeverity[f.severity]++;
      needsReview++;
    } else {
      bySeverity[f.severity]++;
    }
    byConfidence[f.confidence.tier]++;
    byCategory[f.category]++;
  }

  const own = findings.filter((f) => !isThirdPartyFinding(f));
  const criteriaFailed = [...new Set(
    own.filter((f) => !isNeedsReview(f)).map((f) => f.wcag_criterion),
  )].sort();
  const criteriaNeedsReview = [...new Set(
    own.filter(isNeedsReview).map((f) => f.wcag_criterion),
  )].filter((c) => !criteriaFailed.includes(c)).sort();

  const criteriaPassed = criterionResults
    .filter((cr) => cr.status === "passed")
    .map((cr) => cr.wcag_criterion)
    .filter((c) => !criteriaFailed.includes(c) && !criteriaNeedsReview.includes(c));
  const criteriaPassedUnique = [...new Set(criteriaPassed)].sort();

  return {
    scan_session_id: scanSessionId,
    // The main findings: third-party embed findings are counted apart
    total_findings: findings.length - thirdParty,
    by_severity: bySeverity,
    needs_review_findings: needsReview,
    needs_review_by_severity: needsReviewBySeverity,
    third_party_findings: thirdParty,
    third_party_by_vendor: thirdPartyByVendor,
    by_confidence: byConfidence,
    by_category: byCategory,
    human_reviewed_pct: 0,
    // Fix units in the client view (see report/effort.ts), not per instance
    estimated_total_effort: formatEstimate(
      estimateRemediation(findings.filter((f) => !shouldFilterFromClientReport(f)), pageUrlOf),
    ),
    wcag_criteria_failed: criteriaFailed,
    wcag_criteria_needs_review: criteriaNeedsReview,
    wcag_criteria_passed: criteriaPassedUnique,
  };
}

// ---------------------------------------------------------------------------
// Behavioral deduplication
// ---------------------------------------------------------------------------

/** Behavioral check result with its page context for deduplication. */
export interface BehavioralPageEntry {
  snapshotId: string;
  snapshotUrl: string;
  results: CheckResult[];
  fullScreenshot: Buffer;
}

/** Deduplicated results ready for processing. */
export interface DedupedPageEntry {
  snapshotId: string;
  results: CheckResult[];
  fullScreenshot: Buffer;
}

/** Tier 2 check ids, as recorded in coverage. */
export const BEHAVIORAL_CHECKS = ["keyboard", "focus-visible", "focus-order", "keyboard-trap", "skip-nav", "modal"] as const;

/** Tier 4 per-page check ids (form discovery is recorded separately). */
export const FORM_PAGE_CHECKS = ["high-risk-forms", "form-submission", "error-messages", "input-purpose", "on-input"] as const;

/** Criteria eligible for cross-page deduplication. */
export const DEDUP_CRITERIA = new Set(["2.4.7", "2.4.3", "2.1.1", "2.4.1"]);

/**
 * Deduplicate behavioral findings across pages.
 *
 * Shared elements (navbar, footer) produce identical findings on every page.
 * This groups results by (selector + element_html + wcag_criterion) and keeps
 * only the first occurrence, annotating it with the number of other pages.
 *
 * Only deduplicates criteria in DEDUP_CRITERIA (focus visible, focus order,
 * keyboard reachability, skip nav). Modal/trap checks are NOT deduplicated
 * since they may behave differently per page.
 */
export function deduplicateBehavioralResults(
  pages: BehavioralPageEntry[],
): DedupedPageEntry[] {
  // Track seen elements: key → { primaryPageIndex, otherPageUrls[] }
  const seen = new Map<string, { pageIndex: number; otherUrls: string[] }>();

  // Build dedup key for a check result
  function dedupKey(cr: CheckResult): string {
    return `${cr.wcag_criterion}|${cr.element_selector}|${cr.element_html}`;
  }

  // First pass: identify duplicates
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    for (const result of page.results) {
      if (!DEDUP_CRITERIA.has(result.wcag_criterion)) continue;
      const key = dedupKey(result);
      const existing = seen.get(key);
      if (existing) {
        existing.otherUrls.push(page.snapshotUrl);
      } else {
        seen.set(key, { pageIndex: i, otherUrls: [] });
      }
    }
  }

  // Second pass: filter results, keeping only primary occurrences
  const dedupedPages: DedupedPageEntry[] = [];

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const filteredResults: CheckResult[] = [];

    for (const result of page.results) {
      if (!DEDUP_CRITERIA.has(result.wcag_criterion)) {
        // Non-dedup criteria pass through unchanged
        filteredResults.push(result);
        continue;
      }

      const key = dedupKey(result);
      const entry = seen.get(key)!;

      if (entry.pageIndex !== i) {
        // This is a duplicate on a secondary page — skip it
        continue;
      }

      // This is the primary occurrence — annotate if seen on other pages
      if (entry.otherUrls.length > 0) {
        const annotatedResult: CheckResult = {
          ...result,
          measured_values: {
            ...(result.measured_values ?? {}),
            also_found_on_pages: entry.otherUrls.length,
            also_found_on_urls: [...entry.otherUrls],
            dedup_note: `Also found on ${entry.otherUrls.length} other page${entry.otherUrls.length !== 1 ? "s" : ""}`,
          },
        };
        filteredResults.push(annotatedResult);
      } else {
        filteredResults.push(result);
      }
    }

    if (filteredResults.length > 0) {
      dedupedPages.push({
        snapshotId: page.snapshotId,
        results: filteredResults,
        fullScreenshot: page.fullScreenshot,
      });
    }
  }

  return dedupedPages;
}

// ---------------------------------------------------------------------------
// Analyze + score a batch of findings
// ---------------------------------------------------------------------------

/**
 * Run the analysis and confidence scoring pipeline on check results,
 * creating findings with populated Analysis and Confidence sub-entities.
 */
async function processCheckResults(
  checkResults: CheckResult[],
  options: {
    scanId: string;
    pageSnapshotId: string;
    platform: Platform;
    failureType: string;
    fullPageScreenshot: Buffer | null;
    db: ReturnType<typeof openDatabase>;
    fileStore: LocalFileStore;
  },
): Promise<Finding[]> {
  if (checkResults.length === 0) return [];

  // Results on third-party embed contents are tagged (P2-017). axe results
  // are tagged at axe time from the live page; DOM-string checks here, from
  // the stored snapshot.
  if (checkResults.some((r) => !r.measured_values?.third_party)) {
    const dom = getPageSnapshot(options.db, options.pageSnapshotId)?.full_dom;
    if (dom) tagCheckResults(checkResults, dom);
  }

  // 1. Create findings with stub analysis/confidence
  const findings = await createFindings(checkResults, {
    scanSessionId: options.scanId,
    pageSnapshotId: options.pageSnapshotId,
    interactionStateId: null,
    platform: options.platform,
    failureType: options.failureType,
    fullPageScreenshot: options.fullPageScreenshot,
    boundingBox: null,
    db: options.db,
    fileStore: options.fileStore,
  });

  // 2. Populate Analysis and Confidence for each finding
  for (let i = 0; i < findings.length; i++) {
    const finding = findings[i];
    const checkResult = checkResults[i];

    try {
      // Run analyzer
      const analysis = analyze(checkResult);
      finding.analysis = analysis;

      // Run confidence scoring (needs populated analysis)
      const confidence = scoreConfidence(finding);
      finding.confidence = confidence;

      // Persist updated analysis + confidence
      updateFinding(options.db, finding.id, { analysis, confidence });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[scanner] Analysis/scoring failed for ${finding.id}: ${msg}`);
      // Leave stub analysis/confidence in place — finding still valid
    }
  }

  // 3. Generate platform-specific remediation (per unique finding_type_hash)
  if (options.platform !== "unknown") {
    const adapter = ADAPTERS.find(a => a.getPlatformInfo().platform === options.platform);
    if (adapter) {
      const processedHashes = new Set<string>();
      for (const finding of findings) {
        if (processedHashes.has(finding.finding_type_hash)) {
          // Reuse cached remediation from adapter
          const cached = adapter.getRemediationSteps(finding);
          const specificFix = buildSpecificRemediation(finding);
          finding.remediation = {
            generic_fix: specificFix?.generic_fix ?? (finding.remediation.generic_fix || cached.steps[0] || ""),
            platform_fix: cached,
            code_fix: specificFix?.code_fix ?? finding.remediation.code_fix,
            estimated_effort: finding.remediation.estimated_effort,
            fix_verified: false,
          };
          updateFinding(options.db, finding.id, { remediation: finding.remediation });
          continue;
        }
        try {
          const platformFix = adapter.getRemediationSteps(finding);
          // Look up template for generic_fix and code_fix; finding-specific
          // remediation (colours, classes) takes precedence where it exists.
          const templateKey = `${finding.wcag_criterion}:${(finding.evidence.measured_values?.failure_type as string) ?? ""}`;
          const template = getRemediationTemplate(templateKey);
          const specific = buildSpecificRemediation(finding);
          finding.remediation = {
            generic_fix: specific?.generic_fix ?? template?.generic_fix ?? platformFix.steps[0] ?? "",
            platform_fix: platformFix,
            code_fix: specific?.code_fix ?? template?.code_fix ?? null,
            estimated_effort: template?.estimated_effort ?? finding.remediation.estimated_effort,
            fix_verified: false,
          };
          updateFinding(options.db, finding.id, { remediation: finding.remediation });
          processedHashes.add(finding.finding_type_hash);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[scanner] Remediation generation failed for ${finding.id}: ${msg}`);
        }
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// CriterionResult helpers
// ---------------------------------------------------------------------------

function makeCriterionResult(
  scanId: string,
  criterion: string,
  status: CriterionStatus,
  testedBy: DetectedBy,
  summary: string,
  findingIds: string[] = [],
): CriterionResult {
  return {
    scan_session_id: scanId,
    wcag_criterion: criterion,
    status,
    tested_by: testedBy,
    evidence_summary: summary,
    finding_ids: findingIds,
  };
}

/**
 * Reconcile CriterionResults against actual findings.
 * If a criterion was marked "passed" but findings exist for it,
 * update it to "failed" with finding IDs populated.
 * Also creates "failed" CriterionResults for criteria that have findings
 * but no existing CriterionResult entry.
 */
/**
 * Pure, DB-free variant of reconcileCriterionResults — used by the report
 * pipeline after filtering findings client-side. Given the already-stored
 * CriterionResult[] and a (possibly filtered) subset of findings, returns
 * what the CriterionResult[] *should* be. A criterion that was marked
 * "failed" but has no findings in the filtered set is flipped to "passed"
 * (since its only violations came from findings the caller removed).
 */
/**
 * Status of a criterion from its findings (P2-030): failed when at least
 * one finding is confirmed (tier above needs_review), needs_review when
 * every finding needs a manual check. A criterion with findings is never
 * passed. Null when every finding is on third-party embed content
 * (P2-017): those are listed separately and leave the status alone.
 */
export function criterionStatusFromFindings(findings: Finding[]): { status: "failed" | "needs_review"; summary: string } | null {
  // Third-party embed findings are listed for awareness and set no status
  const own = findings.filter((f) => !isThirdPartyFinding(f));
  if (own.length === 0) return null;
  const confirmed = own.filter((f) => !isNeedsReview(f)).length;
  const review = own.length - confirmed;
  if (confirmed > 0) {
    return { status: "failed", summary: `${confirmed} violation(s) found${review > 0 ? `, ${review} more need(s) review` : ""}` };
  }
  return { status: "needs_review", summary: `${review} finding(s) need a manual check; none confirmed` };
}

export function reconcileInMemory(
  scanId: string,
  findings: Finding[],
  criterionResults: CriterionResult[],
): CriterionResult[] {
  // Build map of criterion → findings from the filtered set
  const findingsByCriterion = new Map<string, Finding[]>();
  for (const f of findings) {
    const existing = findingsByCriterion.get(f.wcag_criterion) ?? [];
    existing.push(f);
    findingsByCriterion.set(f.wcag_criterion, existing);
  }

  // Clone every input CriterionResult — we don't mutate input.
  const results = criterionResults.map((cr) => ({ ...cr, finding_ids: [...cr.finding_ids] }));

  for (const cr of results) {
    const criterion = cr.wcag_criterion;
    const remaining = findingsByCriterion.get(criterion);

    const verdict = remaining && remaining.length > 0 ? criterionStatusFromFindings(remaining) : null;
    if (verdict) {
      // Findings remain after filtering: failed if any is confirmed, else needs_review
      const own = remaining!.filter((f) => !isThirdPartyFinding(f));
      cr.status = verdict.status;
      cr.tested_by = own[0].evidence.detected_by ?? cr.tested_by;
      cr.finding_ids = own.map((f) => f.id);
      cr.evidence_summary = verdict.summary;
    } else if (remaining && remaining.length > 0) {
      // Only third-party embed findings remain: no evidence either way, so
      // the stored status stays (never a pass from them)
    } else if (cr.status === "failed") {
      // Every finding behind the stored failure was filtered from this view
      // (possibly noisy). Nothing showed the criterion passes, so it needs a
      // manual check, never a pass (P2-033).
      const filtered = cr.finding_ids.length;
      cr.status = "needs_review";
      cr.finding_ids = [];
      cr.evidence_summary = `${filtered} finding(s) filtered from this view as possibly noisy; needs a manual check`;
    }
    // else: already pass / needs_review / not_applicable / not_tested —
    // leave alone. A needs_review criterion is never turned into a pass.
  }

  return results;
}

function reconcileCriterionResults(
  scanId: string,
  findings: Finding[],
  criterionResults: CriterionResult[],
  db: ReturnType<typeof openDatabase>,
): CriterionResult[] {
  // Build map of criterion → findings
  const findingsByCriterion = new Map<string, Finding[]>();
  for (const f of findings) {
    const existing = findingsByCriterion.get(f.wcag_criterion) ?? [];
    existing.push(f);
    findingsByCriterion.set(f.wcag_criterion, existing);
  }

  // Build map of existing CriterionResults by criterion
  const crByCriterion = new Map<string, CriterionResult>();
  for (const cr of criterionResults) {
    // Keep the latest entry (later tiers override earlier ones)
    crByCriterion.set(cr.wcag_criterion, cr);
  }

  const updatedResults: CriterionResult[] = [];

  // For each criterion with findings: failed if any finding is confirmed,
  // needs_review if every finding needs a manual check (P2-030). Either way
  // it is no longer passed or not_applicable.
  for (const [criterion, critFindings] of findingsByCriterion) {
    const existing = crByCriterion.get(criterion);
    const verdict = criterionStatusFromFindings(critFindings);
    if (!verdict) continue; // only third-party embed findings: they set no status (P2-017)
    const { status, summary } = verdict;
    const own = critFindings.filter((f) => !isThirdPartyFinding(f));
    const findingIds = own.map((f) => f.id);
    // Infer tested_by from the actual finding that detected the issue
    const testedBy = own[0].evidence.detected_by ?? existing?.tested_by ?? "axe_core";
    if (existing) {
      existing.status = status;
      existing.tested_by = testedBy;
      existing.finding_ids = findingIds;
      existing.evidence_summary = summary;
      upsertCriterionResult(db, existing);
    } else {
      const cr = makeCriterionResult(scanId, criterion, status, testedBy, summary, findingIds);
      upsertCriterionResult(db, cr);
      crByCriterion.set(criterion, cr);
    }
  }

  // Return the full deduplicated list
  for (const cr of crByCriterion.values()) {
    updatedResults.push(cr);
  }
  // Also include any results not in the map (shouldn't happen, but be safe)
  for (const cr of criterionResults) {
    if (!crByCriterion.has(cr.wcag_criterion)) {
      updatedResults.push(cr);
    }
  }

  return updatedResults;
}

// ---------------------------------------------------------------------------
// Detection manifest — audit trail for scan reproducibility
// ---------------------------------------------------------------------------

const TIER3_SEMANTIC_CHECKS = [
  "alt-text", "link-text", "headings", "landmark-labels",
  "widget-aria", "table-structure", "duplicate-links", "consistent-nav",
];

function buildDetectionManifest(tiers: number[], options: ScanOptions): DetectionManifest {
  // Read axe-core version from installed package
  let axeCoreVersion = "unknown";
  try {
    // ESM-compatible: resolve from node_modules relative to project root
    const axePkgPath = join(process.cwd(), "node_modules", "axe-core", "package.json");
    const axePkg = JSON.parse(readFileSync(axePkgPath, "utf8"));
    axeCoreVersion = axePkg.version ?? "unknown";
  } catch {
    // If we can't read it, leave as "unknown"
  }

  // Read our own engine version
  let engineVersion = "unknown";
  try {
    const pkgPath = join(process.cwd(), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    engineVersion = pkg.version ?? "unknown";
  } catch {
    // Fallback
  }

  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;

  return {
    engine_version: engineVersion,
    axe_core_version: axeCoreVersion,
    axe_disabled_rules: [],
    active_tiers: tiers,
    api_key_present: !!apiKey,
    semantic_checks: tiers.includes(3) ? TIER3_SEMANTIC_CHECKS : [],
  };
}

// ---------------------------------------------------------------------------
// Concurrency + timing helpers
// ---------------------------------------------------------------------------

/** Run `fn` over `items` with at most `limit` in flight. Never rejects early: `fn` must handle its own errors. */
async function runPool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

type AxeOutput = Awaited<ReturnType<typeof runAxeChecks>>;

/**
 * Criteria that no check in this engine exercises. They are reported as
 * not_tested (unless a finding or another check covered them) so the report
 * never claims a pass that nothing verified.
 */
const UNTESTED_BY_TIER: Array<{ tier: number; testedBy: DetectedBy; criteria: Array<[string, string]> }> = [
  {
    tier: 1,
    testedBy: "axe_core",
    criteria: [
      ["1.3.2", "Meaningful Sequence"],
      ["1.3.3", "Sensory Characteristics"],
      ["1.3.4", "Orientation"],
      ["1.4.5", "Images of Text"],
      ["1.4.10", "Reflow"],
      ["1.4.11", "Non-text Contrast"],
      ["1.4.12", "Text Spacing"],
      ["1.4.13", "Content on Hover or Focus"],
      ["3.1.2", "Language of Parts"],
    ],
  },
  {
    tier: 2,
    testedBy: "playwright",
    criteria: [
      ["2.1.4", "Character Key Shortcuts"],
      ["2.5.1", "Pointer Gestures"],
      ["2.5.2", "Pointer Cancellation"],
      ["3.2.1", "On Focus"],
    ],
  },
  {
    tier: 3,
    testedBy: "claude_api",
    criteria: [
      ["3.2.4", "Consistent Identification"],
      ["3.3.2", "Labels or Instructions"],
    ],
  },
  {
    tier: 5,
    testedBy: "playwright",
    criteria: [
      ["2.2.1", "Timing Adjustable"],
    ],
  },
];

// ---------------------------------------------------------------------------
// Main scan function
// ---------------------------------------------------------------------------

/**
 * Run the full scan pipeline:
 * 1. Crawl pages → PageSnapshot[] (Tier 1 axe-core runs on the same page load)
 * 2. Detect platform
 * 3. Tier 3: Claude API semantic checks start in the background (DOM only)
 * 4. Tier 2: Playwright behavioral checks, several pages at a time
 * 5. Tier 4 forms, Tier 5 indicators
 * 6. Analyze and score all findings
 * 7. Compute and store ScanSummary, timings and findings dump
 *
 * An external `browser` can be injected for testing.
 */
export async function scan(
  options: ScanOptions,
  browser?: Browser,
): Promise<ScanResult> {
  const scanId = randomUUID();
  const tiers = options.tiers ?? [1];
  const viewport = options.viewport ?? { width: 1280, height: 800, deviceScaleFactor: 1 };
  const reporter = options.reporter ?? new ScanProgressReporter();
  const pageConcurrency = Math.max(1, options.pageConcurrency ?? 4);
  // Production etiquette (P2-007): every top-level load in this process is paced
  setActivePacer(options.etiquette?.pacer ?? null);
  if (options.etiquette) reporter.complete("scan", `User agent: ${options.etiquette.userAgent}`);
  // Check subset (verification rescans); every check runs when unset
  const runs = (check: string): boolean => !options.checks || options.checks.includes(check);
  const envConcurrency = Number(process.env.WCAG_CONCURRENCY);
  const llmConcurrency = options.concurrency
    ?? (Number.isInteger(envConcurrency) && envConcurrency > 0 ? envConcurrency : 5);

  // Wall-clock time per phase. Phases that overlap (semantic runs alongside
  // behavioral/forms) each record their own elapsed time, so the parts can
  // sum to more than the total.
  const scanStart = Date.now();
  const phaseMs: Record<string, number> = {};
  const startPhase = (name: string): (() => void) => {
    const t0 = Date.now();
    return () => {
      phaseMs[name] = (phaseMs[name] ?? 0) + (Date.now() - t0);
    };
  };

  // One prompt runner for the whole scan so the concurrency limit and the
  // identical-input cache are shared by every LLM check.
  let sharedRunner: PromptRunner | null | undefined;
  const getRunner = (): PromptRunner | null => {
    if (sharedRunner === undefined) {
      const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
      sharedRunner = options.promptRunner
        ?? (apiKey ? createPromptRunner(apiKey, { concurrency: llmConcurrency }) : null);
    }
    return sharedRunner;
  };

  // --- Setup ----------------------------------------------------------------
  const dbPath = join(options.dataDir, "wcag.db");
  const db = openDatabase(dbPath);
  const fileStore = new LocalFileStore(options.dataDir);

  const scanSession: ScanSession = {
    id: scanId,
    url: options.url,
    platform: "unknown",
    platform_detected_via: "",
    initiated_at: new Date().toISOString(),
    completed_at: "",
    comparison_scan_id: null,
    scan_type: options.baselineScanId ? "rescan" : "initial",
    detection_manifest: buildDetectionManifest(tiers, options),
    excluded_pages: null,
    baseline_scan_id: options.baselineScanId ?? null,
  };
  insertScanSession(db, scanSession);

  const allFindings: Finding[] = [];
  const allCriterionResults: CriterionResult[] = [];
  /** Every page the crawl captured (persisted and reported) */
  let crawledSnapshots: PageSnapshot[] = [];
  /** Pages the checks run on: crawled pages that rendered healthy (P2-011) */
  let pageSnapshots: PageSnapshot[] = [];
  // Per-check, per-page outcomes: ran | failed (error) | skipped (reason)
  const coverage = new CoverageRecorder();
  // Third-party embeds the keyboard sweep stepped over, per page (P2-034)
  const embedSweeps = new Map<string, EmbedSweepStop[]>();
  let excludedByNoindex: Array<{ url: string; source: string }> = [];

  try {
    // --- Phase 1: Crawl -------------------------------------------------------
    reporter.update("crawl", `Discovering pages at ${options.url}...`);
    const ownBrowser = !browser;
    if (!browser) {
      browser = await chromium.launch({ headless: true });
    }

    // Tier 1 runs on the crawl's own page load. Results are held until the
    // platform is known (findings are hashed and remediated per platform).
    const axeByPage = new Map<string, { output: AxeOutput; screenshot: Buffer }>();
    const endCrawl = startPhase("crawl");
    const crawlResult = await crawl(options.url, {
      scanSessionId: scanId,
      fileStore,
      userAgent: options.etiquette?.userAgent,
      pacer: options.etiquette?.pacer,
      // Production: robots.txt applies in every mode and must be readable.
      // Otherwise a pinned list is loaded as given (the offline eval harness
      // and verification tests enforce robots themselves).
      robots: options.etiquette ? "strict" : options.urls ? "skip" : "lenient",
      maxPages: options.maxPages ?? 50,
      cmsSamples: options.cmsSamples ?? 5,
      viewport,
      reporter,
      includeNoindex: options.includeNoindex ?? false,
      concurrency: pageConcurrency,
      urlList: options.urls,
      onPage: tiers.includes(1) && runs("axe-core")
        ? async (page, snapshot, screenshot) => {
            // No check runs on a page that rendered broken (P2-011)
            if (snapshot.render_health?.status === "render_failed") return;
            const endAxe = startPhase("axe_in_crawl");
            try {
              const output = await runAxeChecks(page, scanId);
              axeByPage.set(snapshot.id, { output, screenshot });
              coverage.ran("axe-core", 1, snapshot.url);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              reporter.warn("axe", `Failed for ${snapshot.url}: ${msg}`);
              coverage.failed("axe-core", 1, snapshot.url, err);
            } finally {
              endAxe();
            }
          }
        : undefined,
    }, browser).catch(async (err) => {
      if (ownBrowser && browser) await browser.close().catch(() => {});
      throw err;
    });
    endCrawl();
    crawledSnapshots = crawlResult.snapshots;
    excludedByNoindex = crawlResult.excludedByNoindex;
    for (const f of crawlResult.failedPages) coverage.crawlFailure(f.url, f.error);

    // Render health (P2-011): a page that rendered broken or blank is not
    // checked. Every check that would have run is recorded as failed on it,
    // and no criterion can pass (Phase 8b), so a broken site never reads as
    // fewer findings.
    const renderFailed = crawledSnapshots.filter((p) => p.render_health?.status === "render_failed");
    pageSnapshots = crawledSnapshots.filter((p) => p.render_health?.status !== "render_failed");
    const scanChecks = Object.entries(CHECK_TIERS)
      .filter(([check, tier]) => tiers.includes(tier) && runs(check))
      .map(([check, tier]) => ({ check, tier }));
    for (const p of renderFailed) coverage.renderFailure(p.url, p.render_health!.reasons, scanChecks);
    if (renderFailed.length > 0) {
      reporter.warn("render", renderFailedAlert(renderFailed.length, crawledSnapshots.length));
      for (const p of renderFailed) reporter.warn("render", `  ${p.url}: ${p.render_health!.reasons.join("; ")}`);
    }

    // Persist excluded-page list on the scan session so the report can
    // surface it after the scan completes.
    scanSession.excluded_pages = excludedByNoindex.length > 0 ? excludedByNoindex : null;
    updateScanSession(db, scanId, { excluded_pages: scanSession.excluded_pages });

    const excludedMsg = excludedByNoindex.length > 0
      ? ` (${excludedByNoindex.length} noindex page(s) excluded)`
      : "";
    reporter.complete("crawl", `Discovered ${crawledSnapshots.length} page(s)${excludedMsg}`);

    // Persist page snapshots (broken renders too: the evidence of what was seen)
    for (const snapshot of crawledSnapshots) {
      insertPageSnapshot(db, snapshot);
    }

    // --- Phase 2: Platform detection ------------------------------------------
    if (crawledSnapshots.length > 0) {
      const { platform, detected_via } = detectPlatform(crawledSnapshots[0].full_dom);
      scanSession.platform = platform;
      scanSession.platform_detected_via = detected_via;
      updateScanSession(db, scanId, { platform, platform_detected_via: detected_via });
      reporter.complete("platform", `Detected: ${platform} (via ${detected_via})`);
    }

    // --- Browser context (Tier 2 and Tier 4) -----------------------------------
    const needsBrowser = tiers.includes(2) || tiers.includes(4);

    let context: BrowserContext | undefined;
    try {
      if (needsBrowser && browser) {
        context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: viewport.deviceScaleFactor,
          ...(options.etiquette ? { userAgent: options.etiquette.userAgent } : {}),
        });
        // tsx/esbuild (keepNames) wraps named functions in a `__name(fn, "name")`
        // helper. Callbacks passed to page.evaluate are serialized into the
        // browser, where that helper doesn't exist — define a no-op so they run.
        await context.addInitScript({ content: "globalThis.__name = globalThis.__name || ((fn) => fn);" });
      }

      // Collect axe-flagged selectors per page for Tier 3 deduplication
      const axeFlaggedByPage = new Map<string, Set<string>>();

      // --- Phase 3: Tier 1 — axe-core checks ----------------------------------
      if (tiers.includes(1)) {
        reporter.update("axe", "Processing axe-core results...");
        const endAxeProcess = startPhase("axe_process");
        // Rule outcomes per page; criterion statuses are settled over all
        // pages at once, never per page (P2-004)
        const axePages: Array<{ url: string; outcomes: AxeRuleOutcome[] }> = [];

        for (const snapshot of pageSnapshots) {
          const stash = axeByPage.get(snapshot.id);
          if (!stash) continue; // hook failed; already warned
          const axeOutput = stash.output;
          const fullScreenshot = stash.screenshot;
          axeByPage.delete(snapshot.id);
          try {
            // Track axe-flagged selectors for this page
            const flagged = new Set<string>();
            for (const cr of axeOutput.violations) {
              flagged.add(cr.element_selector);
            }
            axeFlaggedByPage.set(snapshot.id, flagged);

            // Create findings from violations
            if (axeOutput.violations.length > 0) {
              const findings = await processCheckResults(axeOutput.violations, {
                scanId,
                pageSnapshotId: snapshot.id,
                platform: scanSession.platform,
                failureType: "axe_violation",
                fullPageScreenshot: fullScreenshot,
                db,
                fileStore,
              });
              allFindings.push(...findings);
            }

            // Create findings from incomplete (needs_review)
            if (axeOutput.incomplete.length > 0) {
              const incompleteFindings = await processCheckResults(axeOutput.incomplete, {
                scanId,
                pageSnapshotId: snapshot.id,
                platform: scanSession.platform,
                failureType: "axe_incomplete",
                fullPageScreenshot: fullScreenshot,
                db,
                fileStore,
              });
              allFindings.push(...incompleteFindings);
            }

            axePages.push({ url: snapshot.url, outcomes: axeOutput.ruleOutcomes });

            reporter.update(
              "axe",
              `${snapshot.url}: ${axeOutput.violations.length} violation(s), ${axeOutput.incomplete.length} incomplete, ${axeOutput.passes.length} passed`,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            reporter.warn("axe", `Failed for ${snapshot.url}: ${msg}`);
            coverage.failed("axe-core", 1, snapshot.url, err);
          }
        }
        for (const cr of aggregateAxeCriteria(axePages, scanId)) {
          upsertCriterionResult(db, cr);
          allCriterionResults.push(cr);
        }
        endAxeProcess();

        reporter.complete("axe", `Checked ${pageSnapshots.length} page(s), ${allFindings.length} finding(s)`);
      }

      // --- Tier 3 — Semantic checks (runs in the background) -------------------
      // Needs only the captured DOM and the axe-flagged selectors, so it
      // overlaps the browser-bound tiers below and is awaited after them.
      const runSemanticTier = async (): Promise<void> => {
        const endSemantic = startPhase("semantic");
        try {
        reporter.update("semantic", "Running semantic checks...");
        let semanticCount = 0;

        // Track which semantic criteria were attempted (regardless of outcome)
        // and which had violations.  At the end, criteria in attempted but NOT
        // in violations are "passed"; criteria NOT in attempted are "not_tested".
        const semanticAttemptedCriteria = new Set<string>();
        const semanticViolationCriteria = new Set<string>();

        const runner = getRunner();
        if (!runner) {
          reporter.warn("semantic", "Skipping Tier 3: no ANTHROPIC_API_KEY available");
          const allUrls = pageSnapshots.map((p) => p.url);
          for (const check of TIER3_SEMANTIC_CHECKS) {
            coverage.recordAll(check, 3, allUrls, "skipped", "no ANTHROPIC_API_KEY");
          }
        }

        if (runner) {
          // Collect per-page semantic results before processing so we can
          // dedup shared-element findings (e.g. footer links, template icons)
          // across pages before they become Findings.
          const semanticPageEntries: Array<{
            snapshotId: string;
            snapshotUrl: string;
            results: CheckResult[];
          }> = [];

          const imageFetcher = createImageFetcher();

          // Every page and every check is started at once; the shared
          // runner's semaphore bounds the number of API calls in flight.
          const guarded = async (
            label: string,
            check: string,
            snapshot: PageSnapshot,
            criterion: string,
            run: () => Promise<CheckResult[]> | CheckResult[],
          ): Promise<CheckResult[]> => {
            if (!runs(check)) return [];
            try {
              const results = await run();
              if (results.length > 0) semanticViolationCriteria.add(criterion);
              coverage.ran(check, 3, snapshot.url);
              return results;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              reporter.warn("semantic", `${label} failed for ${snapshot.url}: ${msg}`);
              coverage.failed(check, 3, snapshot.url, err);
              return [];
            }
          };

          semanticAttemptedCriteria.add("1.1.1");
          semanticAttemptedCriteria.add("2.4.4");
          semanticAttemptedCriteria.add("1.3.1");
          semanticAttemptedCriteria.add("4.1.2");

          let pagesDone = 0;
          const perPage = await Promise.all(pageSnapshots.map(async (snapshot) => {
            const dom = snapshot.full_dom;
            const axeFlagged = axeFlaggedByPage.get(snapshot.id) ?? new Set<string>();

            const groups = await Promise.all([
              // 3a: Alt text quality (the image itself is sent when it can be fetched)
              guarded("Alt text checks", "alt-text", snapshot, "1.1.1", () => runAltTextChecks(dom, runner, {
                axeFlaggedSelectors: axeFlagged,
                imageProvider: (img) => imageFetcher(img.src, snapshot.url),
              })),
              // 3b: Link text quality
              guarded("Link text checks", "link-text", snapshot, "2.4.4", () => runLinkTextChecks(dom, runner)),
              // 3c: Heading structure
              guarded("Heading checks", "headings", snapshot, "1.3.1", () => runHeadingChecks(dom, snapshot.title, runner)),
              // 3d: Landmark labels (structural, no Claude needed)
              guarded("Landmark label checks", "landmark-labels", snapshot, "1.3.1", () => runLandmarkLabelChecks(dom)),
              // 3e: Widget ARIA roles
              guarded("Widget ARIA checks", "widget-aria", snapshot, "4.1.2", () => runWidgetAriaChecks(dom, runner)),
              // 3f: Table structure (structural, no Claude needed)
              guarded("Table structure checks", "table-structure", snapshot, "1.3.1", () => runTableStructureChecks(dom)),
              // 3g: Duplicate link text (structural, no Claude needed)
              guarded("Duplicate link checks", "duplicate-links", snapshot, "2.4.4", () => runDuplicateLinkChecks(dom, snapshot.url)),
            ]);

            const pageResults = groups.flat();
            pagesDone++;
            reporter.update("semantic", `${pagesDone}/${pageSnapshots.length} pages evaluated (${snapshot.url}: ${pageResults.length} issue(s))`);
            return { snapshotId: snapshot.id, snapshotUrl: snapshot.url, results: pageResults };
          }));
          semanticPageEntries.push(...perPage);

          // Cross-page dedup for semantic findings.
          // Same element in a shared template (footer, nav) produces one finding
          // per crawled page — collapse to one canonical finding annotated with
          // also_found_on_pages, same as behavioral dedup. Matching is on the
          // exact element HTML, so per-page content (a page's own heading)
          // is never merged.
          const SEMANTIC_DEDUP = new Set(["1.1.1", "2.4.4", "1.3.1", "2.4.6", "4.1.2"]);
          const semSeen = new Map<string, { snapshotId: string; otherUrls: string[] }>();

          // First pass: identify canonical (first) occurrence per unique element+criterion
          for (const entry of semanticPageEntries) {
            for (const result of entry.results) {
              if (!SEMANTIC_DEDUP.has(result.wcag_criterion)) continue;
              const key = `${result.wcag_criterion}|${result.element_selector}|${result.element_html}`;
              if (!semSeen.has(key)) {
                semSeen.set(key, { snapshotId: entry.snapshotId, otherUrls: [] });
              } else {
                semSeen.get(key)!.otherUrls.push(entry.snapshotUrl);
              }
            }
          }

          // Second pass: annotate canonical results and remove duplicates
          for (const entry of semanticPageEntries) {
            const kept: CheckResult[] = [];
            for (const result of entry.results) {
              if (!SEMANTIC_DEDUP.has(result.wcag_criterion)) {
                kept.push(result);
                continue;
              }
              const key = `${result.wcag_criterion}|${result.element_selector}|${result.element_html}`;
              const info = semSeen.get(key)!;
              if (info.snapshotId !== entry.snapshotId) continue; // duplicate page — skip
              if (info.otherUrls.length > 0) {
                result.measured_values = {
                  ...result.measured_values,
                  also_found_on_pages: info.otherUrls.length,
                  also_found_on_urls: [...info.otherUrls],
                  dedup_note: `Also found on ${info.otherUrls.length} other page${info.otherUrls.length !== 1 ? "s" : ""}`,
                };
              }
              kept.push(result);
            }
            entry.results = kept;
          }

          // Process deduplicated semantic results
          for (const entry of semanticPageEntries) {
            if (entry.results.length > 0) {
              const findings = await processCheckResults(entry.results, {
                scanId,
                pageSnapshotId: entry.snapshotId,
                platform: scanSession.platform,
                failureType: "semantic",
                fullPageScreenshot: null,
                db,
                fileStore,
              });
              allFindings.push(...findings);
              semanticCount += findings.length;
            }
          }

          // Create pass CriterionResults for semantic criteria that were
          // attempted with no violations.  Criteria not attempted stay
          // un-covered and will be marked "not_tested" below.
          const semanticCriteriaDescriptions: Record<string, string> = {
            "1.1.1": "Alt text quality evaluated across all pages",
            "2.4.4": "Link text quality and duplicate link detection evaluated across all pages",
            "1.3.1": "Heading structure, landmark labels, and table structure evaluated across all pages",
            "4.1.2": "Widget ARIA roles and states evaluated across all pages",
          };
          for (const [criterion, summary] of Object.entries(semanticCriteriaDescriptions)) {
            if (semanticAttemptedCriteria.has(criterion) && !semanticViolationCriteria.has(criterion)) {
              const passCr = makeCriterionResult(scanId, criterion, "passed", "claude_api", summary);
              upsertCriterionResult(db, passCr);
              allCriterionResults.push(passCr);
            }
          }

          // 3d: Consistent navigation (cross-page comparison)
          semanticAttemptedCriteria.add("3.2.3");
          const navUrls = pageSnapshots.map((p) => p.url);
          if (pageSnapshots.length <= 1) {
            coverage.recordAll("consistent-nav", 3, navUrls, "skipped", "needs 2 or more pages to compare");
          }
          if (runs("consistent-nav") && pageSnapshots.length > 1) {
            try {
              const navResults = await runConsistentNavChecks(pageSnapshots, runner);
              coverage.recordAll("consistent-nav", 3, navUrls, "ran");
              if (navResults.length > 0) {
                const findings = await processCheckResults(navResults, {
                  scanId,
                  pageSnapshotId: pageSnapshots[0].id,
                  platform: scanSession.platform,
                  failureType: "semantic",
                  fullPageScreenshot: null,
                  db,
                  fileStore,
                });
                allFindings.push(...findings);
                semanticCount += findings.length;
              } else {
                const passCr = makeCriterionResult(scanId, "3.2.3", "passed", "claude_api",
                  "Navigation is consistent across all tested pages");
                upsertCriterionResult(db, passCr);
                allCriterionResults.push(passCr);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              reporter.warn("semantic", `Consistent nav checks failed: ${msg}`);
              coverage.recordAll("consistent-nav", 3, navUrls, "failed", msg);
            }
          }

          reporter.complete("semantic", `Semantic checks complete: ${semanticCount} finding(s)`);
        }

        // Mark all Tier 3 criteria that were NOT attempted as "not_tested".
        // This covers both the "no API key" case (runner is null → nothing
        // attempted) and partial failures where individual checks threw.
        const TIER3_CRITERIA = ["1.1.1", "2.4.4", "1.3.1", "4.1.2", "3.2.3"];
        for (const criterion of TIER3_CRITERIA) {
          if (!semanticAttemptedCriteria.has(criterion)) {
            const cr = makeCriterionResult(
              scanId,
              criterion,
              "not_tested",
              "claude_api",
              "Tier 3 semantic evaluation was unavailable or failed",
            );
            upsertCriterionResult(db, cr);
            allCriterionResults.push(cr);
          }
        }
        } finally {
          endSemantic();
        }
      };
      let semanticError: unknown;
      const semanticDone: Promise<void> = tiers.includes(3)
        ? runSemanticTier().catch((err) => { semanticError = err; })
        : Promise.resolve();

      // --- Phase 4: Tier 2 — Behavioral checks --------------------------------
      if (tiers.includes(2) && context) {
        reporter.update("behavioral", "Running behavioral checks...");
        let behavioralCount = 0;
        let rawBehavioralCount = 0;

        // Collect all behavioral results per page before deduplication.
        // Indexed by page order so dedup keeps the first page's occurrence
        // regardless of which page finishes first.
        const behavioralByIndex: Array<BehavioralPageEntry | undefined> = [];
        const endBehavioral = startPhase("behavioral");
        const behavioralContext = context;

        await runPool(pageSnapshots, pageConcurrency, async (snapshot, index) => {
          const page = await behavioralContext.newPage();
          try {
            await pacedGoto(page, snapshot.url, { waitUntil: "load", timeout: 30_000 });
            const fullScreenshot = await page.screenshot({ fullPage: true });

            const pageResults: CheckResult[] = [];

            // 2a: Keyboard reachability + trap checks (focus visible and
            // focus order need its tab sequence)
            if (runs("keyboard") || runs("focus-visible") || runs("focus-order")) try {
              const { results: keyboardResults, tabSequence, partialReason, sweepSummary } = await runKeyboardChecks(page);
              embedSweeps.set(snapshot.url, tabSequence.embeds);
              if (runs("keyboard")) pageResults.push(...keyboardResults);
              if (partialReason) coverage.record("keyboard", 2, snapshot.url, "partial", partialReason);
              else coverage.record("keyboard", 2, snapshot.url, "ran", sweepSummary);

              // 2b: Focus visible (needs tab sequence from keyboard check)
              if (runs("focus-visible")) try {
                const focusResults = await runFocusVisibleChecks(page, tabSequence);
                pageResults.push(...focusResults);
                coverage.ran("focus-visible", 2, snapshot.url);
                if (focusResults.length === 0) {
                  const passCr = makeCriterionResult(scanId, "2.4.7", "passed", "playwright",
                    "All focused elements have visible focus indicators");
                  upsertCriterionResult(db, passCr);
                  allCriterionResults.push(passCr);
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                reporter.warn("behavioral", `Focus visible failed for ${snapshot.url}: ${msg}`);
                coverage.failed("focus-visible", 2, snapshot.url, err);
              }

              // 2c: Focus order (needs tab sequence)
              if (runs("focus-order")) try {
                const orderResults = runFocusOrderChecks(tabSequence);
                pageResults.push(...orderResults);
                coverage.ran("focus-order", 2, snapshot.url);
                if (orderResults.length === 0) {
                  const passCr = makeCriterionResult(scanId, "2.4.3", "passed", "playwright",
                    "Focus order follows visual layout sequence");
                  upsertCriterionResult(db, passCr);
                  allCriterionResults.push(passCr);
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                reporter.warn("behavioral", `Focus order failed for ${snapshot.url}: ${msg}`);
                coverage.failed("focus-order", 2, snapshot.url, err);
              }

              // Create passing criterion results for keyboard if no violations
              if (runs("keyboard") && keyboardResults.length === 0) {
                const passCr = makeCriterionResult(scanId, "2.1.1", "passed", "playwright",
                  `All ${tabSequence.focusStops.length} interactive elements reachable via keyboard`);
                upsertCriterionResult(db, passCr);
                allCriterionResults.push(passCr);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              reporter.warn("behavioral", `Keyboard checks failed for ${snapshot.url}: ${msg}`);
              coverage.failed("keyboard", 2, snapshot.url, err);
              // Focus visibility and order are measured on the tab sequence
              coverage.skipped("focus-visible", 2, snapshot.url, "keyboard check failed (no tab sequence)");
              coverage.skipped("focus-order", 2, snapshot.url, "keyboard check failed (no tab sequence)");
            }

            // 2d: Keyboard traps
            if (runs("keyboard-trap")) try {
              const trapResults = await runTrapChecks(page);
              pageResults.push(...trapResults);
              coverage.ran("keyboard-trap", 2, snapshot.url);
              if (trapResults.length === 0) {
                const passCr = makeCriterionResult(scanId, "2.1.2", "passed", "playwright",
                  "No keyboard traps detected");
                upsertCriterionResult(db, passCr);
                allCriterionResults.push(passCr);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              reporter.warn("behavioral", `Trap checks failed for ${snapshot.url}: ${msg}`);
              coverage.failed("keyboard-trap", 2, snapshot.url, err);
            }

            // 2e: Skip navigation
            if (runs("skip-nav")) try {
              const skipResults = await runSkipNavChecks(page);
              pageResults.push(...skipResults);
              coverage.ran("skip-nav", 2, snapshot.url);
              if (skipResults.length === 0) {
                const passCr = makeCriterionResult(scanId, "2.4.1", "passed", "playwright",
                  "Working skip navigation link found");
                upsertCriterionResult(db, passCr);
                allCriterionResults.push(passCr);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              reporter.warn("behavioral", `Skip nav checks failed for ${snapshot.url}: ${msg}`);
              coverage.failed("skip-nav", 2, snapshot.url, err);
            }

            // 2f: Modal focus management
            if (runs("modal")) try {
              const { results: modalResults } = await runModalChecks(page);
              pageResults.push(...modalResults);
              coverage.ran("modal", 2, snapshot.url);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              reporter.warn("behavioral", `Modal checks failed for ${snapshot.url}: ${msg}`);
              coverage.failed("modal", 2, snapshot.url, err);
            }

            rawBehavioralCount += pageResults.length;
            reporter.update("behavioral", `${snapshot.url}: ${pageResults.length} issue(s) found`);

            // Collect results for deduplication (don't process yet)
            if (pageResults.length > 0) {
              behavioralByIndex[index] = {
                snapshotId: snapshot.id,
                snapshotUrl: snapshot.url,
                results: pageResults,
                fullScreenshot: fullScreenshot,
              };
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            reporter.warn("behavioral", `Failed for ${snapshot.url}: ${msg}`);
            // The page itself failed (load or screenshot): no behavioral check ran
            for (const check of BEHAVIORAL_CHECKS) {
              coverage.failed(check, 2, snapshot.url, `page load failed: ${msg}`);
            }
          } finally {
            await page.close().catch(() => {});
          }
        });
        const behavioralPages = behavioralByIndex.filter((e): e is BehavioralPageEntry => e !== undefined);

        // Deduplicate shared elements across pages, then process findings
        const dedupedPages = deduplicateBehavioralResults(behavioralPages);
        const dedupedCount = dedupedPages.reduce((s, p) => s + p.results.length, 0);
        if (rawBehavioralCount > dedupedCount) {
          reporter.update("behavioral",
            `Deduplicated: ${rawBehavioralCount} → ${dedupedCount} (${rawBehavioralCount - dedupedCount} shared-element duplicates removed)`);
        }

        for (const entry of dedupedPages) {
          const findings = await processCheckResults(entry.results, {
            scanId,
            pageSnapshotId: entry.snapshotId,
            platform: scanSession.platform,
            failureType: "behavioral",
            fullPageScreenshot: entry.fullScreenshot,
            db,
            fileStore,
          });
          allFindings.push(...findings);
          behavioralCount += findings.length;
        }

        endBehavioral();
        reporter.complete("behavioral", `Behavioral checks complete: ${behavioralCount} finding(s)`);
      }

      // --- Phase 6: Tier 4 — Form checks ----------------------------------------
      if (tiers.includes(4)) {
        reporter.update("forms", "Running form checks...");
        let formCount = 0;

        // Tier 4 needs a PromptRunner for error evaluation + input purpose
        const formRunner = getRunner();
        if (!formRunner) {
          reporter.warn("forms", "Skipping Tier 4 LLM checks: no ANTHROPIC_API_KEY available");
        }
        const endForms = startPhase("forms");

        // Collect all submission states for Tier 5 error quality indicators
        const allSubmissionStates: SubmissionState[] = [];
        // Track form criteria violations and whether any forms exist
        const formViolationCriteria = new Set<string>();
        let totalFormsFound = 0;
        // Forms whose fields were visible and actually exercised in the browser
        let formsExercised = 0;
        // Forms the high-risk classifier handed to the model (3.3.4 is not applicable without one)
        let highRiskCandidates = 0;

        // 4a: Discover forms on every page up front. The same form repeated
        // across pages (site-wide signup, footer contact form, CMS template)
        // behaves identically, so it's tested once on the first page it
        // appears and the results are annotated with the other pages —
        // mirroring deduplicateBehavioralResults.
        const formsByPage = new Map<string, FormInfo[]>();
        const formGroups = new Map<string, { snapshotId: string; otherUrls: string[] }>();
        for (const snapshot of pageSnapshots) {
          try {
            const forms = discoverForms(snapshot);
            formsByPage.set(snapshot.id, forms);
            coverage.ran("form-discovery", 4, snapshot.url);
            totalFormsFound += forms.length;
            for (const form of forms) {
              const fp = formFingerprint(form);
              const group = formGroups.get(fp);
              if (!group) formGroups.set(fp, { snapshotId: snapshot.id, otherUrls: [] });
              else if (group.snapshotId !== snapshot.id && !group.otherUrls.includes(snapshot.url)) {
                group.otherUrls.push(snapshot.url);
              }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            reporter.warn("forms", `Form discovery failed for ${snapshot.url}: ${msg}`);
            coverage.failed("form-discovery", 4, snapshot.url, err);
          }
        }
        if (totalFormsFound > 0) {
          reporter.update("forms", `Discovered ${totalFormsFound} form instance(s), ${formGroups.size} unique`);
        }

        const annotateShared = (results: CheckResult[], form: FormInfo): CheckResult[] => {
          const otherUrls = formGroups.get(formFingerprint(form))?.otherUrls ?? [];
          if (otherUrls.length === 0) return results;
          return results.map((r) => ({
            ...r,
            measured_values: {
              ...(r.measured_values ?? {}),
              also_found_on_pages: otherUrls.length,
              also_found_on_urls: [...otherUrls],
              dedup_note: `Same form also found on ${otherUrls.length} other page${otherUrls.length !== 1 ? "s" : ""}`,
            },
          }));
        };

        for (const snapshot of pageSnapshots) {
          try {
            // Only test forms whose first occurrence is on this page
            const seenOnPage = new Set<string>();
            const forms = (formsByPage.get(snapshot.id) ?? []).filter((form) => {
              const fp = formFingerprint(form);
              if (seenOnPage.has(fp) || formGroups.get(fp)?.snapshotId !== snapshot.id) return false;
              seenOnPage.add(fp);
              return true;
            });

            if (forms.length === 0) {
              const pageForms = formsByPage.get(snapshot.id);
              const reason = pageForms === undefined
                ? "form discovery failed"
                : pageForms.length === 0
                  ? "no forms on page"
                  : "same form already tested on another page";
              for (const check of FORM_PAGE_CHECKS) coverage.skipped(check, 4, snapshot.url, reason);
              continue;
            }
            reporter.update("forms", `${snapshot.url}: testing ${forms.length} form(s)`);

            // 4b: High-risk form evaluation (LLM)
            if (!formRunner) {
              for (const check of ["high-risk-forms", "error-messages", "input-purpose"]) {
                coverage.skipped(check, 4, snapshot.url, "no ANTHROPIC_API_KEY");
              }
            }
            if (formRunner && runs("high-risk-forms")) {
              try {
                highRiskCandidates += forms.filter((f) => classifyFormRisk(f).riskCategory !== "none").length;
                const highRiskResults = (await evaluateHighRiskForms(forms, formRunner)).flatMap((r) => {
                  const form = forms.find((f) => f.selector === r.element_selector);
                  return form ? annotateShared([r], form) : [r];
                });
                coverage.ran("high-risk-forms", 4, snapshot.url);
                if (highRiskResults.length > 0) {
                  formViolationCriteria.add("3.3.4");
                  const findings = await processCheckResults(highRiskResults, {
                    scanId,
                    pageSnapshotId: snapshot.id,
                    platform: scanSession.platform,
                    failureType: "high_risk_form",
                    fullPageScreenshot: null,
                    db,
                    fileStore,
                  });
                  allFindings.push(...findings);
                  formCount += findings.length;
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                reporter.warn("forms", `High-risk evaluation failed for ${snapshot.url}: ${msg}`);
                coverage.failed("high-risk-forms", 4, snapshot.url, err);
              }
            }

            // 4c: Form submission + error evaluation (needs browser)
            const browserFormChecks = ["form-submission", "error-messages", "input-purpose", "on-input"];
            if (context && browserFormChecks.some(runs)) {
              for (const form of forms) {
                const page = await context.newPage();
                // The page is already loaded when fields are filled; anything
                // not actionable within 5s won't become actionable at 30s.
                page.setDefaultTimeout(5_000);
                try {
                  await pacedGoto(page, snapshot.url, { waitUntil: "load", timeout: 30_000 });
                  const fullScreenshot = await page.screenshot({ fullPage: true });

                  // Forms hidden at load (closed modal, unopened embed) can't be
                  // exercised; skip the browser tests so their criteria are
                  // reported as not tested instead of silently passing.
                  const interactive = (await countVisibleFields(page, form)) > 0;
                  if (interactive) {
                    formsExercised++;
                  } else {
                    reporter.warn("forms", `${snapshot.url}: ${form.selector} has no visible fields at page load — submission and on-input tests skipped`);
                    for (const check of ["form-submission", "on-input", "error-messages"]) {
                      coverage.skipped(check, 4, snapshot.url, "no visible fields at page load");
                    }
                  }

                  // Test form submission
                  // Error-message evaluation needs the submission's error states
                  const { states, results: rawSubmissionResults } = interactive && (runs("form-submission") || runs("error-messages"))
                    ? await testFormSubmission(page, form)
                    : { states: [], results: [] };
                  const submissionResults = runs("form-submission") ? annotateShared(rawSubmissionResults, form) : [];
                  allSubmissionStates.push(...states);
                  if (interactive && runs("form-submission")) coverage.ran("form-submission", 4, snapshot.url);
                  if (interactive && formRunner && states.length === 0) {
                    coverage.skipped("error-messages", 4, snapshot.url, "submission produced no error states");
                  }

                  if (submissionResults.length > 0) {
                    for (const sr of submissionResults) formViolationCriteria.add(sr.wcag_criterion);
                    const findings = await processCheckResults(submissionResults, {
                      scanId,
                      pageSnapshotId: snapshot.id,
                      platform: scanSession.platform,
                      failureType: "form_submission",
                      fullPageScreenshot: fullScreenshot,
                      db,
                      fileStore,
                    });
                    allFindings.push(...findings);
                    formCount += findings.length;
                  }

                  // Error message evaluation (LLM)
                  if (formRunner && states.length > 0 && runs("error-messages")) {
                    try {
                      const evalStates = options.evalHooks?.submissionStates?.(snapshot.url, form, states) ?? states;
                      const errorResults = annotateShared(await evaluateErrorMessages(evalStates, formRunner), form);
                      coverage.ran("error-messages", 4, snapshot.url);
                      if (errorResults.length > 0) {
                        for (const er of errorResults) formViolationCriteria.add(er.wcag_criterion);
                        const findings = await processCheckResults(errorResults, {
                          scanId,
                          pageSnapshotId: snapshot.id,
                          platform: scanSession.platform,
                          failureType: "error_message",
                          fullPageScreenshot: fullScreenshot,
                          db,
                          fileStore,
                        });
                        allFindings.push(...findings);
                        formCount += findings.length;
                      }
                    } catch (err) {
                      const msg = err instanceof Error ? err.message : String(err);
                      reporter.warn("forms", `Error evaluation failed for ${snapshot.url}: ${msg}`);
                      coverage.failed("error-messages", 4, snapshot.url, err);
                    }
                  }

                  // Input purpose evaluation (LLM)
                  if (formRunner && runs("input-purpose")) {
                    try {
                      const purposeResults = annotateShared(await evaluateInputPurpose(form, formRunner), form);
                      coverage.ran("input-purpose", 4, snapshot.url);
                      if (purposeResults.length > 0) {
                        formViolationCriteria.add("1.3.5");
                        const findings = await processCheckResults(purposeResults, {
                          scanId,
                          pageSnapshotId: snapshot.id,
                          platform: scanSession.platform,
                          failureType: "input_purpose",
                          fullPageScreenshot: fullScreenshot,
                          db,
                          fileStore,
                        });
                        allFindings.push(...findings);
                        formCount += findings.length;
                      }
                    } catch (err) {
                      const msg = err instanceof Error ? err.message : String(err);
                      reporter.warn("forms", `Input purpose check failed for ${snapshot.url}: ${msg}`);
                      coverage.failed("input-purpose", 4, snapshot.url, err);
                    }
                  }

                  // On-input state changes (3.2.2)
                  if (interactive && runs("on-input")) try {
                    const onInputResults = annotateShared((await checkOnInput(page, form)).results, form);
                    coverage.ran("on-input", 4, snapshot.url);
                    if (onInputResults.length > 0) {
                      formViolationCriteria.add("3.2.2");
                      const findings = await processCheckResults(onInputResults, {
                        scanId,
                        pageSnapshotId: snapshot.id,
                        platform: scanSession.platform,
                        failureType: "on_input",
                        fullPageScreenshot: fullScreenshot,
                        db,
                        fileStore,
                      });
                      allFindings.push(...findings);
                      formCount += findings.length;
                    }
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    reporter.warn("forms", `On-input check failed for ${snapshot.url}: ${msg}`);
                    coverage.failed("on-input", 4, snapshot.url, err);
                  }
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  reporter.warn("forms", `Form submission failed for ${snapshot.url}: ${msg}`);
                  coverage.failed("form-submission", 4, snapshot.url, err);
                } finally {
                  await page.close();
                }
              }
            }

            reporter.update("forms", `${snapshot.url}: ${formCount} finding(s) so far`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            reporter.warn("forms", `Form discovery failed for ${snapshot.url}: ${msg}`);
            coverage.failed("form-submission", 4, snapshot.url, err);
          }
        }

        // Error quality indicators from submission states (Tier 5 cross-reference)
        const allPageUrls = pageSnapshots.map((p) => p.url);
        if (allSubmissionStates.length === 0) {
          coverage.recordAll("error-quality", 4, allPageUrls, "skipped", "no form submission states on any page");
        }
        if (allSubmissionStates.length > 0 && runs("error-quality")) {
          try {
            const qualityResults = surfaceErrorQualityFindings(allSubmissionStates);
            coverage.recordAll("error-quality", 4, allPageUrls, "ran");
            if (qualityResults.length > 0) {
              const findings = await processCheckResults(qualityResults, {
                scanId,
                pageSnapshotId: pageSnapshots[0].id,
                platform: scanSession.platform,
                failureType: "error_quality",
                fullPageScreenshot: null,
                db,
                fileStore,
              });
              allFindings.push(...findings);
              formCount += findings.length;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            reporter.warn("forms", `Error quality check failed: ${msg}`);
            coverage.recordAll("error-quality", 4, allPageUrls, "failed", msg);
          }
        }

        // Create pass/not_applicable CriterionResults for form criteria
        const formCriteria: Array<[string, string]> = [
          ["3.3.1", "Error identification"],
          ["3.3.3", "Error suggestion"],
          ["1.3.5", "Input purpose identification"],
          ["3.3.4", "Error prevention (legal, financial, data)"],
          ["3.2.2", "On input — no unexpected context changes"],
        ];
        // These criteria are only evidenced by interacting with a visible form
        const interactionCriteria = new Set(["3.3.1", "3.3.3", "3.2.2"]);
        const formCountDesc = `${totalFormsFound} form instance(s), ${formGroups.size} unique`;
        for (const [criterion, desc] of formCriteria) {
          if (!formViolationCriteria.has(criterion)) {
            let status: "not_applicable" | "passed" | "not_tested";
            let summary: string;
            if (totalFormsFound === 0) {
              status = "not_applicable";
              summary = `${desc}: no forms found on scanned pages`;
            } else if (criterion === "3.3.4" && highRiskCandidates === 0) {
              // Nothing to evaluate: no legal, financial or data-changing form
              status = "not_applicable";
              summary = `${desc}: none of ${formCountDesc} is a legal, financial or data-changing form`;
            } else if (interactionCriteria.has(criterion) && formsExercised === 0) {
              status = "not_tested";
              summary = `${desc}: ${formCountDesc} found, but none had visible fields to test at page load`;
            } else {
              status = "passed";
              summary = `${desc}: no violations found across ${formCountDesc}`;
            }
            const cr = makeCriterionResult(scanId, criterion, status, "playwright", summary);
            upsertCriterionResult(db, cr);
            allCriterionResults.push(cr);
          }
        }

        endForms();
        reporter.complete("forms", `Form checks complete: ${formCount} finding(s)`);
      }

      // --- Phase 7: Tier 5 — Indicator checks -----------------------------------
      if (tiers.includes(5)) {
        reporter.update("indicators", "Running indicator checks...");
        const endIndicators = startPhase("indicators");
        let indicatorCount = 0;
        const indicatorViolationCriteria = new Set<string>();

        for (const snapshot of pageSnapshots) {
          const pageResults: CheckResult[] = [];

          // 5a: Pause, stop, hide (2.2.2)
          if (runs("pause-stop-hide")) try {
            const pshResults = checkPauseStopHide(snapshot);
            coverage.ran("pause-stop-hide", 5, snapshot.url);
            pageResults.push(...pshResults);
            if (pshResults.length > 0) indicatorViolationCriteria.add("2.2.2");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            reporter.warn("indicators", `Pause/stop/hide failed for ${snapshot.url}: ${msg}`);
            coverage.failed("pause-stop-hide", 5, snapshot.url, err);
          }

          // 5b: Three flashes (2.3.1)
          if (runs("three-flashes")) try {
            const flashResults = checkThreeFlashes(snapshot);
            coverage.ran("three-flashes", 5, snapshot.url);
            pageResults.push(...flashResults);
            if (flashResults.length > 0) indicatorViolationCriteria.add("2.3.1");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            reporter.warn("indicators", `Three flashes check failed for ${snapshot.url}: ${msg}`);
            coverage.failed("three-flashes", 5, snapshot.url, err);
          }

          // 5c: Multiple ways (2.4.5)
          if (runs("multiple-ways")) try {
            const mwResults = checkMultipleWays(snapshot);
            coverage.ran("multiple-ways", 5, snapshot.url);
            pageResults.push(...mwResults);
            if (mwResults.length > 0) indicatorViolationCriteria.add("2.4.5");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            reporter.warn("indicators", `Multiple ways check failed for ${snapshot.url}: ${msg}`);
            coverage.failed("multiple-ways", 5, snapshot.url, err);
          }

          // 5d: Motion actuation (2.5.4)
          if (runs("motion-actuation")) try {
            const motionResults = checkMotionActuation(snapshot);
            coverage.ran("motion-actuation", 5, snapshot.url);
            pageResults.push(...motionResults);
            if (motionResults.length > 0) indicatorViolationCriteria.add("2.5.4");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            reporter.warn("indicators", `Motion actuation check failed for ${snapshot.url}: ${msg}`);
            coverage.failed("motion-actuation", 5, snapshot.url, err);
          }

          // Process indicator results
          if (pageResults.length > 0) {
            const findings = await processCheckResults(pageResults, {
              scanId,
              pageSnapshotId: snapshot.id,
              platform: scanSession.platform,
              failureType: "indicator",
              fullPageScreenshot: null,
              db,
              fileStore,
            });
            allFindings.push(...findings);
            indicatorCount += findings.length;
          }

          reporter.update("indicators", `${snapshot.url}: ${pageResults.length} issue(s) found`);
        }

        // Create pass/not_applicable CriterionResults for indicator criteria
        // 2.2.2 and 2.3.1: not_applicable when no animated/flash content found
        // 2.4.5: passed when navigation methods are sufficient
        // 2.5.4: not_applicable when no motion listeners detected
        const indicatorAutoResults: Array<[string, "passed" | "not_applicable", string]> = [
          ["2.2.2", "not_applicable", "No auto-playing animations, carousels, or videos detected"],
          ["2.3.1", "not_applicable", "No content with potential flash patterns detected"],
          ["2.4.5", "passed", "Multiple navigation methods available (nav, search, sitemap, etc.)"],
          ["2.5.4", "not_applicable", "No motion-actuated functionality detected"],
        ];
        for (const [criterion, defaultStatus, summary] of indicatorAutoResults) {
          if (!indicatorViolationCriteria.has(criterion)) {
            const cr = makeCriterionResult(scanId, criterion, defaultStatus, "playwright", summary);
            upsertCriterionResult(db, cr);
            allCriterionResults.push(cr);
          }
        }

        endIndicators();
        reporter.complete("indicators", `Indicator checks complete: ${indicatorCount} finding(s)`);
      }

      // Tier 3 has been running alongside the browser-bound tiers.
      await semanticDone;
      if (semanticError) {
        const msg = semanticError instanceof Error ? semanticError.message : String(semanticError);
        reporter.warn("semantic", `Semantic tier failed: ${msg}`);
      }
    } finally {
      if (context) await context.close();
      if (ownBrowser && browser) await browser.close();
    }

    // --- Phase 7.5: Time-based media criteria (1.2.x) ----------------------------
    // Check if any page has audio/video elements. If not, mark 1.2.1-1.2.5 as not_applicable.
    {
      const hasMedia = pageSnapshots.some((snap) => {
        // Rendered markup only (P2-012)
        const markup = withoutRawTextContent(snap.full_dom);
        return /<(audio|video)\b/i.test(markup) || /<source\b[^>]+type\s*=\s*["'](audio|video)\//i.test(markup);
      });
      if (!hasMedia) {
        const mediaCriteria: Array<[string, string]> = [
          ["1.2.1", "Audio-only and Video-only (Prerecorded)"],
          ["1.2.2", "Captions (Prerecorded)"],
          ["1.2.3", "Audio Description or Media Alternative (Prerecorded)"],
          ["1.2.4", "Captions (Live)"],
          ["1.2.5", "Audio Description (Prerecorded)"],
          ["1.4.2", "Audio Control"],
        ];
        for (const [criterion, name] of mediaCriteria) {
          const cr = makeCriterionResult(scanId, criterion, "not_applicable", "playwright",
            `${name}: no audio or video elements found on scanned pages`);
          upsertCriterionResult(db, cr);
          allCriterionResults.push(cr);
        }
      }
    }

    // --- Phase 7.6: Criteria no check exercises --------------------------------
    {
      const covered = new Set(allCriterionResults.map((cr) => cr.wcag_criterion));
      const failed = new Set(allFindings.map((f) => f.wcag_criterion));
      for (const group of UNTESTED_BY_TIER) {
        if (!tiers.includes(group.tier)) continue;
        for (const [criterion, name] of group.criteria) {
          if (covered.has(criterion) || failed.has(criterion)) continue;
          const cr = makeCriterionResult(scanId, criterion, "not_tested", group.testedBy,
            `${name}: not covered by the automated checks that ran; needs a manual check`);
          upsertCriterionResult(db, cr);
          allCriterionResults.push(cr);
        }
      }
    }

    // --- Phase 8: Reconcile CriterionResults ------------------------------------
    // Ensure no criterion is both "passed" and has findings.
    // Later tiers may add violations for criteria that earlier tiers marked passed.
    const reconciled = reconcileCriterionResults(scanId, allFindings, allCriterionResults, db);

    // --- Phase 8a: Settle statuses (P2-010, P2-004, P2-032, stored gap) ------
    // A pass is withheld (not_tested, with the reason) when a check addressing
    // the criterion failed on any page; every A/AA criterion gets one row, a
    // criterion no check covers as not_tested / no_check; out-of-scope rows go.
    const reconciledResults = settleCriterionResults({ scanId, results: reconciled, coverage: coverage.entries() });
    for (const cr of reconciledResults) upsertCriterionResult(db, cr);
    for (const cr of reconciled) {
      if (!WCAG_AA_CRITERION_IDS.includes(cr.wcag_criterion)) deleteCriterionResult(db, scanId, cr.wcag_criterion);
    }

    // --- Phase 8b: No criterion passes while a page rendered broken (P2-011) --
    const renderFailedCount = crawledSnapshots.length - pageSnapshots.length;
    for (const cr of blockPassesOnRenderFailure(reconciledResults, renderFailedCount)) upsertCriterionResult(db, cr);

    // --- Phase 9: Compute summary ---------------------------------------------
    const pageUrlById = new Map(crawledSnapshots.map((p) => [p.id, p.url]));
    const summary = computeSummary(scanId, allFindings, reconciledResults, (id) => pageUrlById.get(id) ?? id);
    upsertScanSummary(db, summary);

    // --- Finalize scan session -------------------------------------------------
    scanSession.completed_at = new Date().toISOString();
    updateScanSession(db, scanId, { completed_at: scanSession.completed_at });

    // --- Phase 10b: Coverage ----------------------------------------------------
    const coverageData = coverage.toJSON(scanId, crawledSnapshots.map((p) => p.url));
    // A check-subset scan records only the checks it was asked to run
    coverageData.entries = coverageData.entries.filter((e) => runs(e.check));
    try {
      writeCoverage(options.dataDir, coverageData);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reporter.warn("coverage", `Could not write coverage: ${msg}`);
    }

    // --- Phase 10c: Third-party content record (P2-017) -------------------------
    try {
      writeThirdPartyReport(options.dataDir, {
        scan_id: scanId,
        config_version: loadThirdPartyConfig().version,
        pages: crawledSnapshots.map((p) => ({
          page_url: p.url,
          containers: containersOf(p.full_dom),
          sweep: embedSweeps.has(p.url) ? { embeds_entered: embedSweeps.get(p.url)! } : null,
        })),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reporter.warn("third-party", `Could not write third-party.json: ${msg}`);
    }

    // --- Phase 10: Verbose findings dump --------------------------------------
    // Always-on working file: per-finding markdown + aggregate + JSONL.
    // This includes ALL findings (no filtering) so the user can audit what
    // the client report dropped.
    try {
      const { dir, count } = dumpFindings(db, scanId, options.dataDir);
      reporter.complete("dump", `Wrote ${count} finding(s) to ${dir}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reporter.warn("dump", `Findings dump failed: ${msg}`);
    }

    // --- Phase 11: Timings ----------------------------------------------------
    try {
      const totalMs = Date.now() - scanStart;
      const prompts = sharedRunner?.getStats?.() ?? {};
      const scanDir = join(options.dataDir, scanId);
      mkdirSync(scanDir, { recursive: true });
      writeFileSync(join(scanDir, "timings.json"), JSON.stringify({
        scan_id: scanId,
        total_ms: totalMs,
        pages: crawledSnapshots.length,
        page_concurrency: pageConcurrency,
        llm_concurrency: llmConcurrency,
        // Overlapping phases each record their own elapsed time; axe_in_crawl
        // is summed across parallel pages and is contained in crawl.
        phases_ms: phaseMs,
        prompts,
      }, null, 2), "utf8");

      const phaseSummary = Object.entries(phaseMs)
        .map(([name, ms]) => `${name} ${formatDuration(ms)}`)
        .join(", ");
      reporter.complete("timing", `Total ${formatDuration(totalMs)} (${phaseSummary})`);
      const promptEntries = Object.entries(prompts);
      if (promptEntries.length > 0) {
        const calls = promptEntries.reduce((n, [, p]) => n + p.calls, 0);
        const hits = promptEntries.reduce((n, [, p]) => n + p.cacheHits, 0);
        const failures = promptEntries.reduce((n, [, p]) => n + p.failures, 0);
        reporter.complete("timing", `LLM: ${calls} API call(s), ${hits} served from cache, ${failures} failed attempt(s)`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reporter.warn("timing", `Could not write timings: ${msg}`);
    }

    if (renderFailedCount > 0) reporter.warn("render", renderFailedAlert(renderFailedCount, crawledSnapshots.length));
    reporter.complete("scan", `Complete: ${allFindings.length} finding(s)${renderFailedCount > 0 ? ` on ${pageSnapshots.length} of ${crawledSnapshots.length} page(s)` : ""}`);

    let etiquetteReport: ScanEtiquetteReport | null = null;
    if (options.etiquette) {
      const pacer = options.etiquette.pacer;
      const minGaps = pacer.minObservedGapMs();
      etiquetteReport = {
        user_agent: options.etiquette.userAgent,
        min_delay_ms: pacer.intervalFor(new URL(options.url).host),
        top_level_loads: pacer.log.length,
        min_gap_ms: minGaps,
      };
      const gaps = Object.entries(minGaps).map(([host, ms]) => `${host} ${Number.isFinite(ms) ? `${ms} ms` : "one load"}`).join(", ");
      reporter.complete("scan", `Pacing: ${pacer.log.length} top-level load(s), smallest gap ${gaps || "n/a"} (minimum ${etiquetteReport.min_delay_ms} ms)`);
    }

    return {
      scanSession,
      summary,
      findings: allFindings,
      criterionResults: reconciledResults,
      pageSnapshots: crawledSnapshots,
      excludedByNoindex,
      excludedByRobots: crawlResult.excludedByRobots,
      etiquette: etiquetteReport,
      coverage: coverageData,
    };
  } catch (err) {
    // Save partial results on non-fatal errors
    scanSession.completed_at = new Date().toISOString();
    try {
      updateScanSession(db, scanId, { completed_at: scanSession.completed_at });
      if (allFindings.length > 0 || allCriterionResults.length > 0) {
        const summary = computeSummary(scanId, allFindings, allCriterionResults);
        upsertScanSummary(db, summary);
      }
      writeCoverage(options.dataDir, coverage.toJSON(scanId, crawledSnapshots.map((p) => p.url)));
    } catch {
      // If even partial save fails, just continue to rethrow
    }
    throw err;
  } finally {
    setActivePacer(null);
    db.close();
  }
}
