import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type {
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
import { openDatabase } from "../store/db.js";
import {
  insertScanSession,
  updateScanSession,
  insertPageSnapshot,
  upsertScanSummary,
  upsertCriterionResult,
  updateFinding,
} from "../store/db.js";
import { LocalFileStore } from "../store/files.js";
import { crawl } from "./crawler.js";
import { runAxeChecks } from "../checks/automated/index.js";
import { createImageFetcher } from "../checks/semantic/image-fetch.js";
import { createFindings } from "./evidence.js";
import { analyze } from "./analyzer.js";
import { scoreConfidence } from "./confidence.js";
import { WebflowAdapter, getRemediationTemplate } from "../adapters/webflow.js";
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
import { evaluateHighRiskForms } from "../checks/forms/high-risk.js";
// Indicator checks (Tier 5)
import { checkPauseStopHide, checkThreeFlashes } from "../checks/indicators/pause-stop-hide.js";
import { checkMultipleWays, checkMotionActuation } from "../checks/indicators/multiple-ways.js";
import { checkOnInput, surfaceErrorQualityFindings } from "../checks/indicators/on-input.js";
import { dumpFindings } from "../report/findings-dump.js";

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
}

export interface ScanResult {
  scanSession: ScanSession;
  summary: ScanSummary;
  findings: Finding[];
  criterionResults: CriterionResult[];
  pageSnapshots: PageSnapshot[];
  /** Pages skipped because they're hidden from SERPs (meta robots / X-Robots-Tag). */
  excludedByNoindex: Array<{ url: string; source: string }>;
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
// Summary computation
// ---------------------------------------------------------------------------

/**
 * Compute a ScanSummary from a set of findings and criterion results.
 */
export function computeSummary(
  scanSessionId: string,
  findings: Finding[],
  criterionResults: CriterionResult[],
): ScanSummary {
  const bySeverity: SeverityCounts = { critical: 0, major: 0, minor: 0, advisory: 0 };
  const byConfidence: ConfidenceCounts = { definitive: 0, high: 0, moderate: 0, needs_review: 0 };
  const byCategory: CategoryCounts = {
    contrast: 0, semantics: 0, keyboard: 0, forms: 0, images: 0, aria: 0, structure: 0,
  };

  for (const f of findings) {
    bySeverity[f.severity]++;
    byConfidence[f.confidence.tier]++;
    byCategory[f.category]++;
  }

  const criteriaFailed = [...new Set(
    findings.map((f) => f.wcag_criterion),
  )].sort();

  const criteriaPassed = criterionResults
    .filter((cr) => cr.status === "passed")
    .map((cr) => cr.wcag_criterion)
    .filter((c) => !criteriaFailed.includes(c));
  const criteriaPassedUnique = [...new Set(criteriaPassed)].sort();

  return {
    scan_session_id: scanSessionId,
    total_findings: findings.length,
    by_severity: bySeverity,
    by_confidence: byConfidence,
    by_category: byCategory,
    human_reviewed_pct: 0,
    estimated_total_effort: estimateEffort(findings),
    wcag_criteria_failed: criteriaFailed,
    wcag_criteria_passed: criteriaPassedUnique,
  };
}

function estimateEffort(findings: Finding[]): string {
  const total = findings.reduce((sum, f) => {
    switch (f.remediation.estimated_effort) {
      case "trivial": return sum + 0.25;
      case "minor": return sum + 0.5;
      case "moderate": return sum + 2;
      case "significant": return sum + 4;
      default: return sum + 1;
    }
  }, 0);

  if (total <= 2) return "< 2 hours";
  if (total <= 8) return `~${Math.round(total)} hours`;
  if (total <= 40) return `~${Math.round(total)} hours (~${Math.round(total / 8)} days)`;
  return `~${Math.round(total)} hours (~${Math.round(total / 8)} days)`;
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
          finding.remediation = {
            generic_fix: finding.remediation.generic_fix || cached.steps[0] || "",
            platform_fix: cached,
            code_fix: finding.remediation.code_fix,
            estimated_effort: finding.remediation.estimated_effort,
            fix_verified: false,
          };
          updateFinding(options.db, finding.id, { remediation: finding.remediation });
          continue;
        }
        try {
          const platformFix = adapter.getRemediationSteps(finding);
          // Look up template for generic_fix and code_fix
          const templateKey = `${finding.wcag_criterion}:${(finding.evidence.measured_values?.failure_type as string) ?? ""}`;
          const template = getRemediationTemplate(templateKey);
          finding.remediation = {
            generic_fix: template?.generic_fix ?? platformFix.steps[0] ?? "",
            platform_fix: platformFix,
            code_fix: template?.code_fix ?? null,
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
  status: "passed" | "failed" | "not_applicable" | "not_tested",
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
export function reconcileInMemory(
  scanId: string,
  findings: Finding[],
  criterionResults: CriterionResult[],
): CriterionResult[] {
  // Build map of criterion → finding IDs from the filtered set
  const findingsByCriterion = new Map<string, string[]>();
  for (const f of findings) {
    const existing = findingsByCriterion.get(f.wcag_criterion) ?? [];
    existing.push(f.id);
    findingsByCriterion.set(f.wcag_criterion, existing);
  }

  // Clone every input CriterionResult — we don't mutate input.
  const results = criterionResults.map((cr) => ({ ...cr, finding_ids: [...cr.finding_ids] }));

  for (const cr of results) {
    const criterion = cr.wcag_criterion;
    const filteredFindingIds = findingsByCriterion.get(criterion);

    if (filteredFindingIds && filteredFindingIds.length > 0) {
      // Criterion still has violations after filtering → must be "failed".
      const firstFinding = findings.find((f) => f.wcag_criterion === criterion);
      cr.status = "failed";
      cr.tested_by = firstFinding?.evidence.detected_by ?? cr.tested_by;
      cr.finding_ids = filteredFindingIds;
      cr.evidence_summary = `${filteredFindingIds.length} violation(s) found`;
    } else if (cr.status === "failed") {
      // Criterion was failed but all its findings were filtered out.
      // Flip to "passed": no remaining violations. Keep tested_by.
      cr.status = "passed";
      cr.finding_ids = [];
      cr.evidence_summary = "No issues detected";
    }
    // else: already pass / not_applicable / not_tested — leave alone.
  }

  return results;
}

function reconcileCriterionResults(
  scanId: string,
  findings: Finding[],
  criterionResults: CriterionResult[],
  db: ReturnType<typeof openDatabase>,
): CriterionResult[] {
  // Build map of criterion → finding IDs
  const findingsByCriterion = new Map<string, string[]>();
  for (const f of findings) {
    const existing = findingsByCriterion.get(f.wcag_criterion) ?? [];
    existing.push(f.id);
    findingsByCriterion.set(f.wcag_criterion, existing);
  }

  // Build map of existing CriterionResults by criterion
  const crByCriterion = new Map<string, CriterionResult>();
  for (const cr of criterionResults) {
    // Keep the latest entry (later tiers override earlier ones)
    crByCriterion.set(cr.wcag_criterion, cr);
  }

  const updatedResults: CriterionResult[] = [];

  // For each criterion with findings, ensure it's marked as "failed"
  for (const [criterion, findingIds] of findingsByCriterion) {
    const existing = crByCriterion.get(criterion);
    if (existing) {
      // Infer tested_by from the actual finding that detected the violation
      const firstFinding = findings.find((f) => f.wcag_criterion === criterion);
      const actualTestedBy = firstFinding?.evidence.detected_by ?? existing.tested_by;

      if (existing.status !== "failed") {
        // Overwrite: was passed/not_applicable but has violations
        existing.status = "failed";
        existing.tested_by = actualTestedBy;
        existing.finding_ids = findingIds;
        upsertCriterionResult(db, existing);
      } else {
        // Already failed — ensure finding IDs and tested_by are accurate
        existing.tested_by = actualTestedBy;
        existing.finding_ids = findingIds;
        upsertCriterionResult(db, existing);
      }
    } else {
      // No CriterionResult yet — create a "failed" one
      // Infer tested_by from the first finding's evidence
      const firstFinding = findings.find((f) => f.wcag_criterion === criterion);
      const testedBy = firstFinding?.evidence.detected_by ?? "axe_core";
      const cr = makeCriterionResult(
        scanId, criterion, "failed", testedBy,
        `${findingIds.length} violation(s) found`, findingIds,
      );
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
      ["1.3.6", "Identify Purpose"],
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
    scan_type: "initial",
    detection_manifest: buildDetectionManifest(tiers, options),
    excluded_pages: null,
  };
  insertScanSession(db, scanSession);

  const allFindings: Finding[] = [];
  const allCriterionResults: CriterionResult[] = [];
  let pageSnapshots: PageSnapshot[] = [];
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
      maxPages: options.maxPages ?? 50,
      cmsSamples: options.cmsSamples ?? 5,
      viewport,
      reporter,
      includeNoindex: options.includeNoindex ?? false,
      concurrency: pageConcurrency,
      onPage: tiers.includes(1)
        ? async (page, snapshot, screenshot) => {
            const endAxe = startPhase("axe_in_crawl");
            try {
              const output = await runAxeChecks(page, scanId);
              axeByPage.set(snapshot.id, { output, screenshot });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              reporter.warn("axe", `Failed for ${snapshot.url}: ${msg}`);
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
    pageSnapshots = crawlResult.snapshots;
    excludedByNoindex = crawlResult.excludedByNoindex;

    // Persist excluded-page list on the scan session so the report can
    // surface it after the scan completes.
    scanSession.excluded_pages = excludedByNoindex.length > 0 ? excludedByNoindex : null;
    updateScanSession(db, scanId, { excluded_pages: scanSession.excluded_pages });

    const excludedMsg = excludedByNoindex.length > 0
      ? ` (${excludedByNoindex.length} noindex page(s) excluded)`
      : "";
    reporter.complete("crawl", `Discovered ${pageSnapshots.length} page(s)${excludedMsg}`);

    // Persist page snapshots
    for (const snapshot of pageSnapshots) {
      insertPageSnapshot(db, snapshot);
    }

    // --- Phase 2: Platform detection ------------------------------------------
    if (pageSnapshots.length > 0) {
      const { platform, detected_via } = detectPlatform(pageSnapshots[0].full_dom);
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

            // Store pass criterion results
            for (const cr of axeOutput.passes) {
              upsertCriterionResult(db, cr);
              allCriterionResults.push(cr);
            }

            // Store inapplicable criterion results
            for (const cr of axeOutput.inapplicable) {
              upsertCriterionResult(db, cr);
              allCriterionResults.push(cr);
            }

            reporter.update(
              "axe",
              `${snapshot.url}: ${axeOutput.violations.length} violation(s), ${axeOutput.incomplete.length} incomplete, ${axeOutput.passes.length} passed`,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            reporter.warn("axe", `Failed for ${snapshot.url}: ${msg}`);
          }
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
            snapshot: PageSnapshot,
            criterion: string,
            run: () => Promise<CheckResult[]> | CheckResult[],
          ): Promise<CheckResult[]> => {
            try {
              const results = await run();
              if (results.length > 0) semanticViolationCriteria.add(criterion);
              return results;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              reporter.warn("semantic", `${label} failed for ${snapshot.url}: ${msg}`);
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
              guarded("Alt text checks", snapshot, "1.1.1", () => runAltTextChecks(dom, runner, {
                axeFlaggedSelectors: axeFlagged,
                imageProvider: (img) => imageFetcher(img.src, snapshot.url),
              })),
              // 3b: Link text quality
              guarded("Link text checks", snapshot, "2.4.4", () => runLinkTextChecks(dom, runner)),
              // 3c: Heading structure
              guarded("Heading checks", snapshot, "1.3.1", () => runHeadingChecks(dom, snapshot.title, runner)),
              // 3d: Landmark labels (structural, no Claude needed)
              guarded("Landmark label checks", snapshot, "1.3.1", () => runLandmarkLabelChecks(dom)),
              // 3e: Widget ARIA roles
              guarded("Widget ARIA checks", snapshot, "4.1.2", () => runWidgetAriaChecks(dom, runner)),
              // 3f: Table structure (structural, no Claude needed)
              guarded("Table structure checks", snapshot, "1.3.1", () => runTableStructureChecks(dom)),
              // 3g: Duplicate link text (structural, no Claude needed)
              guarded("Duplicate link checks", snapshot, "2.4.4", () => runDuplicateLinkChecks(dom, snapshot.url)),
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
          // also_found_on_pages, same as behavioral dedup.
          const SEMANTIC_DEDUP = new Set(["1.1.1", "2.4.4"]);
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
          if (pageSnapshots.length > 1) {
            try {
              const navResults = await runConsistentNavChecks(pageSnapshots, runner);
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
            await page.goto(snapshot.url, { waitUntil: "load", timeout: 30_000 });
            const fullScreenshot = await page.screenshot({ fullPage: true });

            const pageResults: CheckResult[] = [];

            // 2a: Keyboard reachability + trap checks
            try {
              const { results: keyboardResults, tabSequence } = await runKeyboardChecks(page);
              pageResults.push(...keyboardResults);

              // 2b: Focus visible (needs tab sequence from keyboard check)
              try {
                const focusResults = await runFocusVisibleChecks(page, tabSequence);
                pageResults.push(...focusResults);
                if (focusResults.length === 0) {
                  const passCr = makeCriterionResult(scanId, "2.4.7", "passed", "playwright",
                    "All focused elements have visible focus indicators");
                  upsertCriterionResult(db, passCr);
                  allCriterionResults.push(passCr);
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                reporter.warn("behavioral", `Focus visible failed for ${snapshot.url}: ${msg}`);
              }

              // 2c: Focus order (needs tab sequence)
              try {
                const orderResults = runFocusOrderChecks(tabSequence);
                pageResults.push(...orderResults);
                if (orderResults.length === 0) {
                  const passCr = makeCriterionResult(scanId, "2.4.3", "passed", "playwright",
                    "Focus order follows visual layout sequence");
                  upsertCriterionResult(db, passCr);
                  allCriterionResults.push(passCr);
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                reporter.warn("behavioral", `Focus order failed for ${snapshot.url}: ${msg}`);
              }

              // Create passing criterion results for keyboard if no violations
              if (keyboardResults.length === 0) {
                const passCr = makeCriterionResult(scanId, "2.1.1", "passed", "playwright",
                  `All ${tabSequence.focusStops.length} interactive elements reachable via keyboard`);
                upsertCriterionResult(db, passCr);
                allCriterionResults.push(passCr);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              reporter.warn("behavioral", `Keyboard checks failed for ${snapshot.url}: ${msg}`);
            }

            // 2d: Keyboard traps
            try {
              const trapResults = await runTrapChecks(page);
              pageResults.push(...trapResults);
              if (trapResults.length === 0) {
                const passCr = makeCriterionResult(scanId, "2.1.2", "passed", "playwright",
                  "No keyboard traps detected");
                upsertCriterionResult(db, passCr);
                allCriterionResults.push(passCr);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              reporter.warn("behavioral", `Trap checks failed for ${snapshot.url}: ${msg}`);
            }

            // 2e: Skip navigation
            try {
              const skipResults = await runSkipNavChecks(page);
              pageResults.push(...skipResults);
              if (skipResults.length === 0) {
                const passCr = makeCriterionResult(scanId, "2.4.1", "passed", "playwright",
                  "Working skip navigation link found");
                upsertCriterionResult(db, passCr);
                allCriterionResults.push(passCr);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              reporter.warn("behavioral", `Skip nav checks failed for ${snapshot.url}: ${msg}`);
            }

            // 2f: Modal focus management
            try {
              const { results: modalResults } = await runModalChecks(page);
              pageResults.push(...modalResults);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              reporter.warn("behavioral", `Modal checks failed for ${snapshot.url}: ${msg}`);
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

            if (forms.length === 0) continue;
            reporter.update("forms", `${snapshot.url}: testing ${forms.length} form(s)`);

            // 4b: High-risk form evaluation (LLM)
            if (formRunner) {
              try {
                const highRiskResults = (await evaluateHighRiskForms(forms, formRunner)).flatMap((r) => {
                  const form = forms.find((f) => f.selector === r.element_selector);
                  return form ? annotateShared([r], form) : [r];
                });
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
              }
            }

            // 4c: Form submission + error evaluation (needs browser)
            if (context) {
              for (const form of forms) {
                const page = await context.newPage();
                // The page is already loaded when fields are filled; anything
                // not actionable within 5s won't become actionable at 30s.
                page.setDefaultTimeout(5_000);
                try {
                  await page.goto(snapshot.url, { waitUntil: "load", timeout: 30_000 });
                  const fullScreenshot = await page.screenshot({ fullPage: true });

                  // Forms hidden at load (closed modal, unopened embed) can't be
                  // exercised; skip the browser tests so their criteria are
                  // reported as not tested instead of silently passing.
                  const interactive = (await countVisibleFields(page, form)) > 0;
                  if (interactive) {
                    formsExercised++;
                  } else {
                    reporter.warn("forms", `${snapshot.url}: ${form.selector} has no visible fields at page load — submission and on-input tests skipped`);
                  }

                  // Test form submission
                  const { states, results: rawSubmissionResults } = interactive
                    ? await testFormSubmission(page, form)
                    : { states: [], results: [] };
                  const submissionResults = annotateShared(rawSubmissionResults, form);
                  allSubmissionStates.push(...states);

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
                  if (formRunner && states.length > 0) {
                    try {
                      const errorResults = annotateShared(await evaluateErrorMessages(states, formRunner), form);
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
                    }
                  }

                  // Input purpose evaluation (LLM)
                  if (formRunner) {
                    try {
                      const purposeResults = annotateShared(await evaluateInputPurpose(form, formRunner), form);
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
                    }
                  }

                  // On-input state changes (3.2.2)
                  if (interactive) try {
                    const onInputResults = annotateShared((await checkOnInput(page, form)).results, form);
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
                  }
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  reporter.warn("forms", `Form submission failed for ${snapshot.url}: ${msg}`);
                } finally {
                  await page.close();
                }
              }
            }

            reporter.update("forms", `${snapshot.url}: ${formCount} finding(s) so far`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            reporter.warn("forms", `Form discovery failed for ${snapshot.url}: ${msg}`);
          }
        }

        // Error quality indicators from submission states (Tier 5 cross-reference)
        if (allSubmissionStates.length > 0) {
          try {
            const qualityResults = surfaceErrorQualityFindings(allSubmissionStates);
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
          try {
            const pshResults = checkPauseStopHide(snapshot);
            pageResults.push(...pshResults);
            if (pshResults.length > 0) indicatorViolationCriteria.add("2.2.2");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            reporter.warn("indicators", `Pause/stop/hide failed for ${snapshot.url}: ${msg}`);
          }

          // 5b: Three flashes (2.3.1)
          try {
            const flashResults = checkThreeFlashes(snapshot);
            pageResults.push(...flashResults);
            if (flashResults.length > 0) indicatorViolationCriteria.add("2.3.1");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            reporter.warn("indicators", `Three flashes check failed for ${snapshot.url}: ${msg}`);
          }

          // 5c: Multiple ways (2.4.5)
          try {
            const mwResults = checkMultipleWays(snapshot);
            pageResults.push(...mwResults);
            if (mwResults.length > 0) indicatorViolationCriteria.add("2.4.5");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            reporter.warn("indicators", `Multiple ways check failed for ${snapshot.url}: ${msg}`);
          }

          // 5d: Motion actuation (2.5.4)
          try {
            const motionResults = checkMotionActuation(snapshot);
            pageResults.push(...motionResults);
            if (motionResults.length > 0) indicatorViolationCriteria.add("2.5.4");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            reporter.warn("indicators", `Motion actuation check failed for ${snapshot.url}: ${msg}`);
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
        const dom = snap.full_dom.toLowerCase();
        return /<(audio|video)\b/.test(dom) || /<source\b[^>]+type\s*=\s*["'](audio|video)\//i.test(snap.full_dom);
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
    const reconciledResults = reconcileCriterionResults(scanId, allFindings, allCriterionResults, db);

    // --- Phase 9: Compute summary ---------------------------------------------
    const summary = computeSummary(scanId, allFindings, reconciledResults);
    upsertScanSummary(db, summary);

    // --- Finalize scan session -------------------------------------------------
    scanSession.completed_at = new Date().toISOString();
    updateScanSession(db, scanId, { completed_at: scanSession.completed_at });

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
        pages: pageSnapshots.length,
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

    reporter.complete("scan", `Complete: ${allFindings.length} finding(s)`);

    return {
      scanSession,
      summary,
      findings: allFindings,
      criterionResults: reconciledResults,
      pageSnapshots,
      excludedByNoindex,
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
    } catch {
      // If even partial save fails, just continue to rethrow
    }
    throw err;
  } finally {
    db.close();
  }
}
