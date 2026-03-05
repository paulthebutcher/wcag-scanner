import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
import type {
  ScanSession,
  ScanSummary,
  Finding,
  CriterionResult,
  PageSnapshot,
  Platform,
  Viewport,
  SeverityCounts,
  ConfidenceCounts,
  CategoryCounts,
  PlatformAdapter,
} from "../types.js";
import { openDatabase } from "../store/db.js";
import {
  insertScanSession,
  updateScanSession,
  insertPageSnapshot,
  upsertScanSummary,
  upsertCriterionResult,
} from "../store/db.js";
import { LocalFileStore } from "../store/files.js";
import { crawl } from "./crawler.js";
import { runAxeChecks } from "../checks/automated/index.js";
import { createFindings } from "./evidence.js";
import { WebflowAdapter } from "../adapters/webflow.js";
import type { ProgressReporter } from "./progress.js";
import { ScanProgressReporter } from "./progress.js";

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
// Main scan function
// ---------------------------------------------------------------------------

/**
 * Run the full Cycle 1 scan pipeline:
 * 1. Crawl pages
 * 2. Detect platform
 * 3. Run axe-core (Tier 1) on each page
 * 4. Create Findings from violations
 * 5. Store CriterionResults from passes
 * 6. Compute and store ScanSummary
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

    // --- Phase 3: Tier 1 — axe-core checks ------------------------------------
    if (tiers.includes(1)) {
      reporter.update("axe", "Running axe-core checks...");

      const ownBrowser = !browser;
      if (!browser) {
        browser = await chromium.launch({ headless: true });
      }

      let context: BrowserContext | undefined;
      try {
        context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: viewport.deviceScaleFactor,
        });

        for (const snapshot of pageSnapshots) {
          const page = await context.newPage();
          try {
            await page.goto(snapshot.url, { waitUntil: "load", timeout: 30_000 });

            const axeOutput = await runAxeChecks(page, scanId);

            // Take full-page screenshot for evidence cropping
            const fullScreenshot = await page.screenshot({ fullPage: true });

            // Create findings from violations
            if (axeOutput.violations.length > 0) {
              const findings = await createFindings(axeOutput.violations, {
                scanSessionId: scanId,
                pageSnapshotId: snapshot.id,
                interactionStateId: null,
                platform: scanSession.platform,
                failureType: "axe_violation",
                fullPageScreenshot: fullScreenshot,
                boundingBox: null, // axe doesn't provide bounding boxes
                db,
                fileStore,
              });
              allFindings.push(...findings);
            }

            // Create findings from incomplete (needs_review)
            if (axeOutput.incomplete.length > 0) {
              const incompleteFindings = await createFindings(axeOutput.incomplete, {
                scanSessionId: scanId,
                pageSnapshotId: snapshot.id,
                interactionStateId: null,
                platform: scanSession.platform,
                failureType: "axe_incomplete",
                fullPageScreenshot: fullScreenshot,
                boundingBox: null,
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
      } finally {
        if (context) await context.close();
        if (ownBrowser && browser) await browser.close();
      }

      reporter.complete("axe", `Checked ${pageSnapshots.length} page(s), ${allFindings.length} finding(s)`);
    }

    // --- Phase 4: Compute summary ---------------------------------------------
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
