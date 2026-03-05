import { Command } from "commander";
import { scan } from "../../core/scanner.js";
import { ScanProgressReporter, QuietProgressReporter } from "../../core/progress.js";
import type { ScanSummary } from "../../types.js";

// ---------------------------------------------------------------------------
// Output formatters
// ---------------------------------------------------------------------------

function formatTable(summary: ScanSummary, scanId: string): string {
  const lines: string[] = [];

  lines.push("┌──────────────────────────────────────────────┐");
  lines.push("│              WCAG Scan Summary               │");
  lines.push("├──────────────────────────────────────────────┤");
  lines.push(`│  Scan ID: ${scanId.slice(0, 8)}...                       │`);
  lines.push(`│  Total findings: ${String(summary.total_findings).padEnd(28)}│`);
  lines.push("├──────────────────────────────────────────────┤");
  lines.push("│  By Severity:                                │");
  lines.push(`│    Critical: ${String(summary.by_severity.critical).padEnd(32)}│`);
  lines.push(`│    Major:    ${String(summary.by_severity.major).padEnd(32)}│`);
  lines.push(`│    Minor:    ${String(summary.by_severity.minor).padEnd(32)}│`);
  lines.push(`│    Advisory: ${String(summary.by_severity.advisory).padEnd(32)}│`);
  lines.push("├──────────────────────────────────────────────┤");
  lines.push("│  By Confidence:                              │");
  lines.push(`│    Definitive:  ${String(summary.by_confidence.definitive).padEnd(29)}│`);
  lines.push(`│    High:        ${String(summary.by_confidence.high).padEnd(29)}│`);
  lines.push(`│    Moderate:    ${String(summary.by_confidence.moderate).padEnd(29)}│`);
  lines.push(`│    Needs Review:${String(summary.by_confidence.needs_review).padEnd(29)}│`);
  lines.push("├──────────────────────────────────────────────┤");

  if (summary.wcag_criteria_failed.length > 0) {
    lines.push(`│  Failed criteria: ${summary.wcag_criteria_failed.join(", ").slice(0, 26).padEnd(26)}│`);
  }
  if (summary.wcag_criteria_passed.length > 0) {
    lines.push(`│  Passed criteria: ${summary.wcag_criteria_passed.join(", ").slice(0, 26).padEnd(26)}│`);
  }

  lines.push(`│  Estimated effort: ${summary.estimated_total_effort.padEnd(25)}│`);
  lines.push("└──────────────────────────────────────────────┘");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

export function createScanCommand(): Command {
  const cmd = new Command("scan")
    .description("Crawl and scan a URL for WCAG AA violations")
    .argument("<url>", "URL to scan")
    .option("--max-pages <n>", "Maximum pages to crawl", "50")
    .option("--output <format>", "Output format: json or table", "table")
    .option("--tiers <list>", "Comma-separated check tiers to run", "1")
    .option("--cms-samples <n>", "CMS collection pages to sample per collection", "5")
    .option("--data-dir <path>", "Data directory for results", "./wcag-data")
    .option("--quiet", "Suppress progress output, only print results")
    .action(async (url: string, opts: Record<string, string>) => {
      const maxPages = parseInt(opts["maxPages"], 10);
      const cmsSamples = parseInt(opts["cmsSamples"], 10);
      const outputFormat = opts["output"] as "json" | "table";
      const tiers = opts["tiers"].split(",").map((t) => parseInt(t.trim(), 10));
      const dataDir = opts["dataDir"];
      const quiet = "quiet" in opts;

      if (isNaN(maxPages) || maxPages <= 0) {
        console.error("Error: --max-pages must be a positive integer");
        process.exitCode = 1;
        return;
      }
      if (isNaN(cmsSamples) || cmsSamples <= 0) {
        console.error("Error: --cms-samples must be a positive integer");
        process.exitCode = 1;
        return;
      }
      if (!["json", "table"].includes(outputFormat)) {
        console.error('Error: --output must be "json" or "table"');
        process.exitCode = 1;
        return;
      }

      const reporter = quiet
        ? new QuietProgressReporter()
        : new ScanProgressReporter();

      try {
        const result = await scan({
          url,
          dataDir,
          maxPages,
          cmsSamples,
          tiers,
          reporter,
        });

        // Results go to stdout (allows piping)
        // Always output scan ID first
        process.stdout.write(result.scanSession.id + "\n");

        if (outputFormat === "json") {
          process.stdout.write(JSON.stringify(result.summary, null, 2) + "\n");
        } else {
          process.stdout.write(formatTable(result.summary, result.scanSession.id) + "\n");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Fatal error: ${msg}`);
        process.exitCode = 1;
      }
    });

  return cmd;
}
