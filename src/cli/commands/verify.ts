import { Command } from "commander";
import { runVerify } from "../../core/verify.js";
import { ScanProgressReporter, QuietProgressReporter } from "../../core/progress.js";
import { clientSummaryLines } from "../../report/verify-report.js";

function collect(value: string, previous: string[]): string[] {
  return previous.concat(value.split(",").map((v) => v.trim()).filter(Boolean));
}

export function createVerifyCommand(): Command {
  return new Command("verify")
    .description("Rescan the pages behind a baseline scan's Top fixes and report what is fixed")
    .requiredOption("--baseline <scan-id>", "Scan whose fixes to verify")
    .option("--cluster <id>", "Cluster id from the baseline's Top fixes (repeatable or comma-separated)", collect, [] as string[])
    .option("--all", "Verify every cluster in the baseline, not just the Top fixes")
    .option("--data-dir <path>", "Data directory for results", "./wcag-data")
    .option("--page-concurrency <n>", "Pages loaded and tested in parallel", "4")
    .option("--quiet", "Suppress progress output")
    .action(async (opts: { baseline: string; cluster: string[]; all?: boolean; dataDir: string; pageConcurrency: string; quiet?: boolean }) => {
      const pageConcurrency = parseInt(opts.pageConcurrency, 10);
      if (isNaN(pageConcurrency) || pageConcurrency <= 0) {
        console.error("Error: --page-concurrency must be a positive integer");
        process.exitCode = 1;
        return;
      }
      if (opts.all && opts.cluster.length > 0) {
        console.error("Error: use either --cluster or --all, not both");
        process.exitCode = 1;
        return;
      }
      try {
        const { result, files } = await runVerify({
          dataDir: opts.dataDir,
          baselineScanId: opts.baseline,
          clusterIds: opts.cluster,
          all: opts.all,
          pageConcurrency,
          reporter: opts.quiet ? new QuietProgressReporter() : new ScanProgressReporter(),
        });
        process.stdout.write(result.rescan_scan_id + "\n");
        process.stdout.write(clientSummaryLines(result).map((l) => l.replace(/\*\*/g, "")).join("\n") + "\n");
        process.stdout.write(`\n${files.markdown}\n${files.html}\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exitCode = 1;
      }
    });
}
