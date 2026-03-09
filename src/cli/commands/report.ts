import { Command } from "commander";
import path from "node:path";
import { openDatabase } from "../../store/db.js";
import {
  generatePdfReport,
  buildReportDataWithComparison,
  buildPageUrlMap,
} from "../../report/pdf-renderer.js";
import { renderHtmlReport } from "../../report/templates/html-template.js";
import { ScanProgressReporter, QuietProgressReporter } from "../../core/progress.js";
import type { Severity } from "../../types.js";

// ---------------------------------------------------------------------------
// Severity validation
// ---------------------------------------------------------------------------

const VALID_SEVERITIES: Severity[] = ["critical", "major", "minor", "advisory"];

function parseSeverities(raw: string): Severity[] | null {
  const parts = raw.split(",").map((s) => s.trim().toLowerCase());
  for (const p of parts) {
    if (!VALID_SEVERITIES.includes(p as Severity)) return null;
  }
  return parts as Severity[];
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

export function createReportCommand(): Command {
  const cmd = new Command("report")
    .description("Generate an accessibility report from a completed scan")
    .argument("<scan-id>", "Scan session ID")
    .option("--compare <scan-id>", "Compare against a previous scan (before/after)")
    .option(
      "--severity <levels>",
      "Comma-separated severity filter: critical,major,minor,advisory",
    )
    .option("--output <path>", "Output file path (default: ./wcag-data/report-<id>.pdf)")
    .option("--format <type>", "Output format: pdf or html", "pdf")
    .option("--data-dir <path>", "Data directory for results", "./wcag-data")
    .option("--quiet", "Suppress progress output")
    .action(async (scanId: string, opts: Record<string, string>) => {
      const dataDir = opts["dataDir"] ?? "./wcag-data";
      const format = opts["format"] ?? "pdf";
      const compareId = opts["compare"] as string | undefined;
      const quiet = "quiet" in opts;

      // Validate format
      if (!["pdf", "html"].includes(format)) {
        console.error('Error: --format must be "pdf" or "html"');
        process.exitCode = 1;
        return;
      }

      // Parse severity filter
      let severityFilter: Severity[] | undefined;
      if (opts["severity"]) {
        const parsed = parseSeverities(opts["severity"]);
        if (!parsed) {
          console.error(
            `Error: --severity must be comma-separated list of: ${VALID_SEVERITIES.join(", ")}`,
          );
          process.exitCode = 1;
          return;
        }
        severityFilter = parsed;
      }

      // Determine output path
      const ext = format === "html" ? ".html" : ".pdf";
      const defaultFilename = `report-${scanId.slice(0, 8)}${ext}`;
      const outputPath = opts["output"] ?? path.join(dataDir, defaultFilename);

      const reporter = quiet
        ? new QuietProgressReporter()
        : new ScanProgressReporter();

      try {
        // Open database
        const dbPath = path.join(dataDir, "wcag.db");
        const db = openDatabase(dbPath);

        if (format === "html") {
          reporter.update("report", "Building report data...");
          const data = buildReportDataWithComparison(
            db,
            scanId,
            compareId,
            severityFilter,
          );
          const pageUrlMap = buildPageUrlMap(db, scanId);

          reporter.update("report", "Rendering HTML...");
          const html = renderHtmlReport(data, { pageUrlMap, dataDir });

          const { writeFileSync } = await import("node:fs");
          writeFileSync(outputPath, html, "utf-8");
          reporter.complete("report", `HTML report saved to ${outputPath}`);
        } else {
          await generatePdfReport(db, scanId, {
            outputPath,
            comparisonScanId: compareId,
            severityFilter,
            reporter,
            dataDir,
          });
        }

        process.stdout.write(outputPath + "\n");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exitCode = 1;
      }
    });

  return cmd;
}
