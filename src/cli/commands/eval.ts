import { Command } from "commander";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { evalPaths } from "../../eval/paths.js";
import { loadEvalConfig } from "../../eval/config.js";
import { startRun, OfficialRunRefused, PURPOSES, type Purpose, type RunHandle } from "../../eval/manifest.js";
import { repoRoot } from "../../eval/util.js";
import { runPilot } from "../../eval/pilot.js";
import { captureSite } from "../../eval/capture.js";
import { verifyCorpus, type Split } from "../../eval/corpus.js";
import { knownPrivateHosts, writeExport } from "../../eval/privacy.js";

// ---------------------------------------------------------------------------
// `wcag eval` — thin wiring over src/eval. Every producing command prints its
// run id and manifest path; consuming commands take explicit ids.
// ---------------------------------------------------------------------------

function context() {
  const paths = evalPaths(repoRoot());
  const config = loadEvalConfig(paths.config);
  return { paths, config };
}

function begin(command: string, argv: string[], purpose: Purpose): RunHandle {
  const { paths } = context();
  try {
    const run = startRun({ command, argv, purpose, root: paths.repo, runsDir: paths.runsDir });
    process.stdout.write(`run ${run.manifest.run_id}\nmanifest ${run.path}\n`);
    return run;
  } catch (err) {
    if (err instanceof OfficialRunRefused) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

function parsePurpose(value: string): Purpose {
  if (!(PURPOSES as readonly string[]).includes(value)) throw new Error(`--purpose must be one of ${PURPOSES.join(", ")}`);
  return value as Purpose;
}

export function createEvalCommand(): Command {
  const cmd = new Command("eval").description("Frozen evaluation harness (Phase 1)");

  cmd.command("pilot")
    .description("D0: local fixture capture, offline replay at HEAD and the baseline, containment, egress and equivalence proofs")
    .option("--skip-baseline", "Do not build or replay the baseline engine")
    .option("--skip-equivalence", "Do not run the default-path equivalence check")
    .action(async (opts: { skipBaseline?: boolean; skipEquivalence?: boolean }) => {
      const { paths, config } = context();
      const run = begin("pilot", ["pilot", ...process.argv.slice(4)], "diagnostic");
      try {
        const { checks, evidence } = await runPilot({
          paths, config, run, fixtureDir: join(paths.repo, "test", "fixtures", "eval-pilot"),
          include: { baseline: !opts.skipBaseline, equivalence: !opts.skipEquivalence }, log,
        });
        run.manifest.extra = { checks, evidence };
        run.manifest.engine = { label: "head", sha: run.manifest.harness.sha, bridge: null };
        for (const c of checks.filter((x) => !x.pass)) run.invalidate(`pilot check failed: ${c.name}`);
        const m = run.finish("completed");
        // Committed aggregate export (synthetic fixture; privacy-checked)
        const exportPath = join(paths.committedRunsDir, m.run_id, "pilot.json");
        writeExport(exportPath, {
          run_id: m.run_id, purpose: m.purpose, harness: { sha: m.harness.sha, dirty: m.harness.dirty }, environment: m.environment,
          validity: m.validity, checks,
          engines: (evidence as { replays?: Record<string, unknown> }).replays ?? {},
          equivalence: (evidence as { equivalence?: unknown }).equivalence ?? null,
        }, knownPrivateHosts(paths));
        process.stdout.write(`export ${exportPath}\n`);
        process.stdout.write(`${checks.filter((c) => c.pass).length}/${checks.length} checks passed; valid=${m.validity.valid}\n`);
        process.exitCode = m.validity.valid ? 0 : 1;
      } catch (err) {
        run.invalidate(`pilot error: ${err instanceof Error ? err.message : String(err)}`);
        run.finish("failed");
        console.error(err);
        process.exitCode = 2;
      }
    });

  cmd.command("capture")
    .description("D1: capture a site into a frozen corpus version (site access under capture etiquette; no model calls)")
    .requiredOption("--site <id>", "Pseudonymous site id, e.g. t01 or m01")
    .requiredOption("--split <split>", "tuning | dev | holdout")
    .requiredOption("--urls <file>", "Private file: first line the root URL, then one page URL per line (frozen order)")
    .requiredOption("--version <id>", "Corpus version id")
    .action(async (opts: { site: string; split: string; urls: string; version: string }) => {
      const { paths, config } = context();
      const contactUrl = process.env.EVAL_CONTACT_URL;
      if (!contactUrl) {
        console.error("EVAL_CONTACT_URL is required for capture (it goes in the user agent).");
        process.exit(2);
      }
      if (!["tuning", "dev", "holdout"].includes(opts.split)) {
        console.error("--split must be tuning, dev or holdout");
        process.exit(2);
      }
      if (!/^[a-z]\d{2}$/.test(opts.site)) {
        console.error("--site must look like m01 or t01");
        process.exit(2);
      }
      const lines = readFileSync(opts.urls, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      const [rootUrl, ...urls] = lines;
      const run = begin("capture", ["capture", "--site", opts.site, "--split", opts.split, "--version", opts.version], "diagnostic");
      try {
        const result = await captureSite({
          paths, config, version: opts.version, split: opts.split as Split, siteId: opts.site, rootUrl, urls: urls.length ? urls : [rootUrl],
          contactUrl: contactUrl!, runId: run.manifest.run_id, harnessSha: run.manifest.harness.sha, log,
        });
        run.manifest.extra = {
          site: opts.site, split: opts.split, version: opts.version, skipped: result.skipped,
          pages: result.capture?.pages.map((p) => ({ page: p.page_id, status: p.status })) ?? [],
          omissions: result.capture?.omissions.length ?? 0, uncaptured_forms: result.capture?.uncaptured_forms.length ?? 0,
          pacing: result.capture?.pacing ?? null, containment: result.capture?.containment ?? null, collected: result.collected,
          node_fetches: result.nodeFetches,
        };
        run.manifest.totals.pages = result.capture?.pages.filter((p) => p.status === "captured").length ?? 0;
        run.manifest.totals.contained_submissions = result.capture?.containment.contained_requests ?? 0;
        if (result.skipped) run.unavailable("capture", result.skipped);
        run.finish("completed");
        process.stdout.write(result.skipped ? `skipped: ${result.skipped}\n` : `captured ${run.manifest.totals.pages} page(s)\n`);
      } catch (err) {
        run.invalidate(`capture error: ${err instanceof Error ? err.message : String(err)}`);
        run.finish("failed");
        console.error(err instanceof Error ? err.message : err);
        process.exitCode = 2;
      }
    });

  cmd.command("verify-corpus")
    .description("Recompute and check every checksum and artifact in a corpus version")
    .requiredOption("--version <id>", "Corpus version id")
    .action((opts: { version: string }) => {
      const { paths } = context();
      const result = verifyCorpus(paths, opts.version);
      for (const s of result.sites) process.stdout.write(`${s.split}/${s.site}: ${s.pages} page(s), ${s.files} file(s), ${s.image_entries} image entr(y/ies)\n`);
      for (const p of result.problems) process.stdout.write(`PROBLEM ${p.site}${p.page ? `/${p.page}` : ""}: ${p.problem}\n`);
      process.stdout.write(result.problems.length === 0 ? "corpus verified\n" : `${result.problems.length} problem(s)\n`);
      process.exitCode = result.problems.length === 0 ? 0 : 1;
    });

  return cmd;
}

export { parsePurpose };
