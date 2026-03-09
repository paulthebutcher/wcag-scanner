import { randomUUID } from "node:crypto";
import { join } from "node:path";
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
import { createFindings } from "./evidence.js";
import { analyze } from "./analyzer.js";
import { scoreConfidence } from "./confidence.js";
import { WebflowAdapter } from "../adapters/webflow.js";
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
import { createPromptRunner, type PromptRunner } from "./prompt-runner.js";
// Form checks (Tier 4)
import { discoverForms } from "../checks/forms/discovery.js";
import { testFormSubmission } from "../checks/forms/submission.js";
import type { SubmissionState } from "../checks/forms/submission.js";
import { evaluateErrorMessages, evaluateInputPurpose } from "../checks/forms/error-evaluation.js";
import { evaluateHighRiskForms } from "../checks/forms/high-risk.js";
// Indicator checks (Tier 5)
import { checkPauseStopHide, checkThreeFlashes } from "../checks/indicators/pause-stop-hide.js";
import { checkMultipleWays, checkMotionActuation } from "../checks/indicators/multiple-ways.js";
import { checkOnInput, surfaceErrorQualityFindings } from "../checks/indicators/on-input.js";

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
  /** Prompt runner concurrency (default: 5) */
  concurrency?: number;
  /** Inject a PromptRunner for testing */
  promptRunner?: PromptRunner;
}

export interface ScanResult {
  scanSession: ScanSession;
  summary: ScanSummary;
  findings: Finding[];
  criterionResults: CriterionResult[];
  pageSnapshots: PageSnapshot[];
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
      if (existing.status !== "failed") {
        // Overwrite: was passed/not_applicable but has violations
        existing.status = "failed";
        existing.finding_ids = findingIds;
        upsertCriterionResult(db, existing);
      } else {
        // Already failed — ensure finding IDs are populated
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
// Main scan function
// ---------------------------------------------------------------------------

/**
 * Run the full scan pipeline:
 * 1. Crawl pages → PageSnapshot[]
 * 2. Detect platform
 * 3. Tier 1: axe-core automated checks
 * 4. Tier 2: Playwright behavioral checks (keyboard, focus, skip nav, modals)
 * 5. Tier 3: Claude API semantic checks (alt text, link text, headings, consistent nav)
 * 6. Analyze and score all findings
 * 7. Compute and store ScanSummary
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
  };
  insertScanSession(db, scanSession);

  const allFindings: Finding[] = [];
  const allCriterionResults: CriterionResult[] = [];
  let pageSnapshots: PageSnapshot[] = [];

  try {
    // --- Phase 1: Crawl -------------------------------------------------------
    reporter.update("crawl", `Discovering pages at ${options.url}...`);
    pageSnapshots = await crawl(options.url, {
      scanSessionId: scanId,
      fileStore,
      maxPages: options.maxPages ?? 50,
      cmsSamples: options.cmsSamples ?? 5,
      viewport,
      reporter,
    });

    reporter.complete("crawl", `Discovered ${pageSnapshots.length} page(s)`);

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

    // --- Browser setup (shared by Tier 1 and Tier 2) --------------------------
    const needsBrowser = tiers.includes(1) || tiers.includes(2) || tiers.includes(4);
    const ownBrowser = needsBrowser && !browser;
    if (needsBrowser && !browser) {
      browser = await chromium.launch({ headless: true });
    }

    let context: BrowserContext | undefined;
    try {
      if (needsBrowser && browser) {
        context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: viewport.deviceScaleFactor,
        });
      }

      // Collect axe-flagged selectors per page for Tier 3 deduplication
      const axeFlaggedByPage = new Map<string, Set<string>>();

      // --- Phase 3: Tier 1 — axe-core checks ----------------------------------
      if (tiers.includes(1) && context) {
        reporter.update("axe", "Running axe-core checks...");

        for (const snapshot of pageSnapshots) {
          const page = await context.newPage();
          try {
            await page.goto(snapshot.url, { waitUntil: "load", timeout: 30_000 });

            const axeOutput = await runAxeChecks(page, scanId);

            // Take full-page screenshot for evidence cropping
            const fullScreenshot = await page.screenshot({ fullPage: true });

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
          } finally {
            await page.close();
          }
        }

        reporter.complete("axe", `Checked ${pageSnapshots.length} page(s), ${allFindings.length} finding(s)`);
      }

      // --- Phase 4: Tier 2 — Behavioral checks --------------------------------
      if (tiers.includes(2) && context) {
        reporter.update("behavioral", "Running behavioral checks...");
        let behavioralCount = 0;

        for (const snapshot of pageSnapshots) {
          const page = await context.newPage();
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

            // Process all behavioral results through evidence → analyzer → confidence
            if (pageResults.length > 0) {
              const findings = await processCheckResults(pageResults, {
                scanId,
                pageSnapshotId: snapshot.id,
                platform: scanSession.platform,
                failureType: "behavioral",
                fullPageScreenshot: fullScreenshot,
                db,
                fileStore,
              });
              allFindings.push(...findings);
              behavioralCount += findings.length;
            }

            reporter.update("behavioral", `${snapshot.url}: ${pageResults.length} issue(s) found`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            reporter.warn("behavioral", `Failed for ${snapshot.url}: ${msg}`);
          } finally {
            await page.close();
          }
        }

        reporter.complete("behavioral", `Behavioral checks complete: ${behavioralCount} finding(s)`);
      }

      // --- Phase 5: Tier 3 — Semantic checks -----------------------------------
      if (tiers.includes(3)) {
        reporter.update("semantic", "Running semantic checks...");
        let semanticCount = 0;

        // Create or use injected PromptRunner
        const runner = options.promptRunner ?? (() => {
          const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
          if (!apiKey) {
            reporter.warn("semantic", "Skipping Tier 3: no ANTHROPIC_API_KEY available");
            return null;
          }
          return createPromptRunner(apiKey, { concurrency: options.concurrency ?? 5 });
        })();

        if (runner) {
          // Track which semantic criteria had violations
          const semanticViolationCriteria = new Set<string>();

          for (const snapshot of pageSnapshots) {
            const dom = snapshot.full_dom;
            const pageResults: CheckResult[] = [];

            // 3a: Alt text quality
            try {
              const axeFlagged = axeFlaggedByPage.get(snapshot.id) ?? new Set();
              const altResults = await runAltTextChecks(dom, runner, {
                axeFlaggedSelectors: axeFlagged,
              });
              pageResults.push(...altResults);
              if (altResults.length > 0) semanticViolationCriteria.add("1.1.1");
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              reporter.warn("semantic", `Alt text checks failed for ${snapshot.url}: ${msg}`);
            }

            // 3b: Link text quality
            try {
              const linkResults = await runLinkTextChecks(dom, runner);
              pageResults.push(...linkResults);
              if (linkResults.length > 0) semanticViolationCriteria.add("2.4.4");
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              reporter.warn("semantic", `Link text checks failed for ${snapshot.url}: ${msg}`);
            }

            // 3c: Heading structure
            try {
              const headingResults = await runHeadingChecks(dom, snapshot.title, runner);
              pageResults.push(...headingResults);
              if (headingResults.length > 0) semanticViolationCriteria.add("1.3.1");
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              reporter.warn("semantic", `Heading checks failed for ${snapshot.url}: ${msg}`);
            }

            // Process semantic results
            if (pageResults.length > 0) {
              const findings = await processCheckResults(pageResults, {
                scanId,
                pageSnapshotId: snapshot.id,
                platform: scanSession.platform,
                failureType: "semantic",
                fullPageScreenshot: null,
                db,
                fileStore,
              });
              allFindings.push(...findings);
              semanticCount += findings.length;
            }

            reporter.update("semantic", `${snapshot.url}: ${pageResults.length} issue(s) found`);
          }

          // Create pass CriterionResults for semantic criteria with no violations
          const semanticCriteriaChecked: Array<[string, string]> = [
            ["1.1.1", "Alt text quality evaluated across all pages"],
            ["2.4.4", "Link text quality evaluated across all pages"],
            ["1.3.1", "Heading structure evaluated across all pages"],
          ];
          for (const [criterion, summary] of semanticCriteriaChecked) {
            if (!semanticViolationCriteria.has(criterion)) {
              const passCr = makeCriterionResult(scanId, criterion, "passed", "claude_api", summary);
              upsertCriterionResult(db, passCr);
              allCriterionResults.push(passCr);
            }
          }

          // 3d: Consistent navigation (cross-page comparison)
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
      }

      // --- Phase 6: Tier 4 — Form checks ----------------------------------------
      if (tiers.includes(4)) {
        reporter.update("forms", "Running form checks...");
        let formCount = 0;

        // Tier 4 needs a PromptRunner for error evaluation + input purpose
        const formRunner = options.promptRunner ?? (() => {
          const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
          if (!apiKey) {
            reporter.warn("forms", "Skipping Tier 4 LLM checks: no ANTHROPIC_API_KEY available");
            return null;
          }
          return createPromptRunner(apiKey, { concurrency: options.concurrency ?? 5 });
        })();

        // Collect all submission states for Tier 5 error quality indicators
        const allSubmissionStates: SubmissionState[] = [];
        // Track form criteria violations and whether any forms exist
        const formViolationCriteria = new Set<string>();
        let totalFormsFound = 0;

        for (const snapshot of pageSnapshots) {
          try {
            // 4a: Discover forms from DOM
            const forms = discoverForms(snapshot);
            totalFormsFound += forms.length;
            reporter.update("forms", `${snapshot.url}: discovered ${forms.length} form(s)`);

            if (forms.length === 0) continue;

            // 4b: High-risk form evaluation (LLM)
            if (formRunner) {
              try {
                const highRiskResults = await evaluateHighRiskForms(forms, formRunner);
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
                try {
                  await page.goto(snapshot.url, { waitUntil: "load", timeout: 30_000 });
                  const fullScreenshot = await page.screenshot({ fullPage: true });

                  // Test form submission
                  const { states, results: submissionResults } = await testFormSubmission(page, form);
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
                      const errorResults = await evaluateErrorMessages(states, formRunner);
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
                      const purposeResults = await evaluateInputPurpose(form, formRunner);
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
                  try {
                    const { results: onInputResults } = await checkOnInput(page, form);
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
        for (const [criterion, desc] of formCriteria) {
          if (!formViolationCriteria.has(criterion)) {
            const status = totalFormsFound === 0 ? "not_applicable" : "passed";
            const summary = totalFormsFound === 0
              ? `${desc}: no forms found on scanned pages`
              : `${desc}: no violations found across ${totalFormsFound} form(s)`;
            const cr = makeCriterionResult(scanId, criterion, status, "playwright", summary);
            upsertCriterionResult(db, cr);
            allCriterionResults.push(cr);
          }
        }

        reporter.complete("forms", `Form checks complete: ${formCount} finding(s)`);
      }

      // --- Phase 7: Tier 5 — Indicator checks -----------------------------------
      if (tiers.includes(5)) {
        reporter.update("indicators", "Running indicator checks...");
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

        reporter.complete("indicators", `Indicator checks complete: ${indicatorCount} finding(s)`);
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
        ];
        for (const [criterion, name] of mediaCriteria) {
          const cr = makeCriterionResult(scanId, criterion, "not_applicable", "playwright",
            `${name}: no audio or video elements found on scanned pages`);
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

    reporter.complete("scan", `Complete: ${allFindings.length} finding(s)`);

    return {
      scanSession,
      summary,
      findings: allFindings,
      criterionResults: reconciledResults,
      pageSnapshots,
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
