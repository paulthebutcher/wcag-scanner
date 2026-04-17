import { chromium } from "playwright";
import type Database from "better-sqlite3";
import type { ProgressReporter } from "../core/progress.js";
import { renderHtmlReport, type RenderOptions } from "./templates/html-template.js";
import {
  queryFindings,
  groupFindingsByHash,
  computeDiff,
  type ReportData,
  type ScanDiff,
} from "./generator.js";
import { shouldFilterFromClientReport } from "./findings-dump.js";
import {
  getScanSession,
  listFindingsByScan,
  listPageSnapshots,
} from "../store/db.js";
import type { Severity } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PdfOptions {
  /** Path for the output PDF */
  outputPath: string;
  /** Optional comparison scan ID for before/after report */
  comparisonScanId?: string;
  /** Optional severity filter */
  severityFilter?: Severity[];
  /** Page URL map (page_snapshot_id → URL) */
  pageUrlMap?: Map<string, string>;
  /** Impact descriptions by finding_type_hash */
  impactDescriptions?: Map<string, string>;
  /** Executive summary HTML */
  executiveSummaryHtml?: string;
  /** Progress reporter */
  reporter?: ProgressReporter;
  /** Data directory for resolving screenshot files */
  dataDir?: string;
}

// ---------------------------------------------------------------------------
// Build report data with optional comparison
// ---------------------------------------------------------------------------

/**
 * Build ReportData with an optional comparison scan for diff.
 * If comparisonScanId is provided, computes resolved/new/persistent diffs.
 */
export function buildReportDataWithComparison(
  db: Database.Database,
  scanId: string,
  comparisonScanId?: string,
  severityFilter?: Severity[],
): ReportData {
  const data = queryFindings(db, scanId);

  // Apply severity filter if provided
  if (severityFilter && severityFilter.length > 0) {
    const allowedSet = new Set(severityFilter);
    data.groups = data.groups.filter(g => allowedSet.has(g.severity));
    for (const group of data.groups) {
      group.findings = group.findings.filter(f => allowedSet.has(f.severity));
      group.instanceCount = group.findings.length;
    }
    data.groups = data.groups.filter(g => g.instanceCount > 0);
  }

  // Compute diff against comparison scan if provided. Apply the same
  // client-report filter to the comparison side so we don't report noisy
  // findings as phantom "resolved" issues.
  if (comparisonScanId) {
    const comparisonSession = getScanSession(db, comparisonScanId);
    if (!comparisonSession) {
      throw new Error(`Comparison scan not found: ${comparisonScanId}`);
    }

    const rawComparisonFindings = listFindingsByScan(db, comparisonScanId);
    const comparisonFindings = rawComparisonFindings.filter(
      (f) => !shouldFilterFromClientReport(f),
    );
    const comparisonGroups = groupFindingsByHash(comparisonFindings);

    const diff: ScanDiff = computeDiff(data.groups, comparisonGroups);
    data.diff = diff;

    // Update the session to reflect comparison info
    data.scanSession = {
      ...data.scanSession,
      comparison_scan_id: comparisonScanId,
    };
  }

  return data;
}

// ---------------------------------------------------------------------------
// Build page URL map
// ---------------------------------------------------------------------------

/**
 * Build a map of page_snapshot_id → URL from the database.
 */
export function buildPageUrlMap(
  db: Database.Database,
  scanId: string,
): Map<string, string> {
  const snapshots = listPageSnapshots(db, scanId);
  const map = new Map<string, string>();
  for (const snap of snapshots) {
    map.set(snap.id, snap.url);
  }
  return map;
}

// ---------------------------------------------------------------------------
// HTML to PDF via Playwright
// ---------------------------------------------------------------------------

/**
 * Render an HTML string to a PDF file using Playwright's Chromium.
 * Returns the output path.
 */
export async function htmlToPdf(
  html: string,
  outputPath: string,
  reporter?: ProgressReporter,
): Promise<string> {
  reporter?.update("pdf", "Launching browser...");

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });

    reporter?.update("pdf", "Rendering PDF...");

    await page.pdf({
      path: outputPath,
      format: "A4",
      margin: { top: "1cm", right: "1cm", bottom: "1cm", left: "1cm" },
      printBackground: true,
    });

    reporter?.complete("pdf", `PDF saved to ${outputPath}`);
    return outputPath;
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Full pipeline: query → render HTML → convert to PDF
// ---------------------------------------------------------------------------

/**
 * Generate a PDF report from a scan.
 *
 * 1. Queries findings from the database
 * 2. Optionally computes diff against a comparison scan
 * 3. Renders HTML report with evidence chains
 * 4. Converts HTML to PDF via Playwright
 */
export async function generatePdfReport(
  db: Database.Database,
  scanId: string,
  options: PdfOptions,
): Promise<string> {
  const { reporter } = options;

  reporter?.update("report", "Querying findings...");

  // Build report data
  const data = buildReportDataWithComparison(
    db,
    scanId,
    options.comparisonScanId,
    options.severityFilter,
  );

  // Build page URL map if not provided
  const pageUrlMap = options.pageUrlMap ?? buildPageUrlMap(db, scanId);

  reporter?.update("report", "Rendering HTML...");

  // Render HTML
  const renderOpts: RenderOptions = {
    pageUrlMap,
    impactDescriptions: options.impactDescriptions,
    executiveSummaryHtml: options.executiveSummaryHtml,
    dataDir: options.dataDir,
  };
  const html = renderHtmlReport(data, renderOpts);

  // Convert to PDF
  return htmlToPdf(html, options.outputPath, reporter);
}
