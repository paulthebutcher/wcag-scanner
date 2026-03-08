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
  status: "passed" | "not_tested",
  testedBy: DetectedBy,
  summary: string,
): CriterionResult {
  return {
    scan_session_id: scanId,
    wcag_criterion: criterion,
    status,
    tested_by: testedBy,
    evidence_summary: summary,
    finding_ids: [],
  };
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
    const needsBrowser = tiers.includes(1) || tiers.includes(2);
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
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                reporter.warn("behavioral", `Focus visible failed for ${snapshot.url}: ${msg}`);
              }

              // 2c: Focus order (needs tab sequence)
              try {
                const orderResults = runFocusOrderChecks(tabSequence);
                pageResults.push(...orderResults);
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
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              reporter.warn("semantic", `Alt text checks failed for ${snapshot.url}: ${msg}`);
            }

            // 3b: Link text quality
            try {
              const linkResults = await runLinkTextChecks(dom, runner);
              pageResults.push(...linkResults);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              reporter.warn("semantic", `Link text checks failed for ${snapshot.url}: ${msg}`);
            }

            // 3c: Heading structure
            try {
              const headingResults = await runHeadingChecks(dom, snapshot.title, runner);
              pageResults.push(...headingResults);
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
    } finally {
      if (context) await context.close();
      if (ownBrowser && browser) await browser.close();
    }

    // --- Phase 6: Compute summary ---------------------------------------------
    const summary = computeSummary(scanId, allFindings, allCriterionResults);
    upsertScanSummary(db, summary);

    // --- Finalize scan session -------------------------------------------------
    scanSession.completed_at = new Date().toISOString();
    updateScanSession(db, scanId, { completed_at: scanSession.completed_at });

    reporter.complete("scan", `Complete: ${allFindings.length} finding(s)`);

    return {
      scanSession,
      summary,
      findings: allFindings,
      criterionResults: allCriterionResults,
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
