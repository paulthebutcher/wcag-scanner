import { Command } from "commander";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { evalPaths } from "../../eval/paths.js";
import { loadEvalConfig } from "../../eval/config.js";
import { startRun, OfficialRunRefused, PURPOSES, type Purpose, type RunHandle } from "../../eval/manifest.js";
import { repoRoot } from "../../eval/util.js";
import { runPilot } from "../../eval/pilot.js";
import { captureSite } from "../../eval/capture.js";
import { deriveCorpus, verifyCorpus, type Split } from "../../eval/corpus.js";
import { knownPrivateHosts, writeExport } from "../../eval/privacy.js";
import Anthropic from "@anthropic-ai/sdk";
import { resolveEngine } from "../../eval/engine/resolve.js";
import { executeReplayRun } from "../../eval/runs.js";
import { ResponseCache } from "../../eval/model/cache.js";
import { deterministicInjector } from "../../eval/model/injector.js";
import { guardSplit, HoldoutSealed } from "../../eval/holdout.js";
import { startReviewServer } from "../../eval/review/server.js";
import { createAudit } from "../../eval/review/audit.js";
import { paceReport, formatPace } from "../../eval/pace.js";
import { computeMetrics, loadRunInputs, loadLabelInputs, aggregateExport } from "../../eval/metrics.js";
import { loadManifest, inputHash } from "../../eval/manifest.js";
import { readJson, writeJson } from "../../eval/util.js";
import { resolveStatic, writeResolution, runStatic, staticRunsMatch, MODEL_API_EGRESS, type StaticRunResult } from "../../eval/static.js";
import { CHECK_TIERS } from "../../core/check-registry.js";
import { compareRuns, labelSnapshotSha } from "../../eval/compare.js";
import { capabilityMap, historicalContext, referenceExport } from "../../eval/reference.js";
import { BASELINE_CHECKS } from "../../eval/engine/legacy.js";
import { LabelStore } from "../../eval/labels.js";
import { verifySite, type Split as CorpusSplit } from "../../eval/corpus.js";
import type { StaticFile, StaticCaseOutcome } from "../../eval/static.js";
import { admitSites, readCandidateFile, selectPages, type FetchLike } from "../../eval/admit.js";
import { loadSitesPrivate, registerSite } from "../../eval/corpus.js";
import { userAgentFor } from "../../eval/capture.js";
import { Pacer } from "../../eval/transport/pacer.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { existsSync } from "node:fs";
import type { Batch } from "../../eval/labels.js";

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
          site: opts.site, split: opts.split, version: opts.version, skipped: result.skipped, page_cap: result.capture?.page_cap ?? null,
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

  cmd.command("derive-corpus")
    .description("New corpus version that leaves pages out of an existing one, each with a reason (artifacts are hard links)")
    .requiredOption("--from <version>", "Source corpus version")
    .requiredOption("--to <version>", "New corpus version")
    .requiredOption("--split <split>", "tuning | dev | holdout")
    .requiredOption("--site <id>", "Site id")
    .requiredOption("--exclude <page=reason...>", "Pages to leave out, e.g. p047=\"Instagram embed render varies (P2-017)\"")
    .action((opts: { from: string; to: string; split: string; site: string; exclude: string[] }) => {
      const { paths } = context();
      const exclude = opts.exclude.map((e) => {
        const i = e.indexOf("=");
        if (i < 1) { console.error(`--exclude needs page=reason, got "${e}"`); process.exit(2); }
        return { page_id: e.slice(0, i), reason: e.slice(i + 1) };
      });
      const run = begin("derive-corpus", ["derive-corpus", "--from", opts.from, "--to", opts.to, "--split", opts.split, "--site", opts.site], "diagnostic");
      try {
        const derived = deriveCorpus(paths, { from: opts.from, to: opts.to, split: opts.split as Split, siteId: opts.site, exclude });
        const problems = verifySite(paths, { version: opts.to, split: opts.split as CorpusSplit, siteId: opts.site }).problems;
        for (const p of problems) run.invalidate(`verify: ${p.site}${p.page ? `/${p.page}` : ""} ${p.problem}`);
        const captured = derived.pages.filter((p) => p.status === "captured").length;
        run.manifest.extra = { from: opts.from, to: opts.to, site: opts.site, excluded: exclude, captured, problems: problems.length };
        run.finish("completed");
        process.stdout.write(`${opts.to}/${opts.split}/${opts.site}: ${captured} page(s) kept, ${exclude.length} excluded; ${problems.length === 0 ? "verified" : `${problems.length} problem(s)`}\n`);
      } catch (err) {
        run.invalidate(`derive error: ${err instanceof Error ? err.message : String(err)}`);
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

  const replayLike = (name: "replay" | "record") => {
    const c = cmd.command(name)
      .requiredOption("--engine <sha>", "head | baseline | pre-harness | <sha>")
      .requiredOption("--corpus <version>", "Corpus version")
      .requiredOption("--split <split>", "tuning | dev | holdout | pilot")
      .option("--cache <namespace>", "Response cache namespace")
      .option("--sites <ids>", "Comma-separated site ids (default: every site in the split)")
      .option("--pages <ids>", "Comma-separated page ids (diagnostic runs only)")
      .option("--purpose <purpose>", "diagnostic | official-regression | official-accuracy", "diagnostic")
      .option("--unseal <reason>", "Required (and logged) for the holdout split")
      .option("--data-dir <path>", "Private data root (default wcag-data)");
    if (name === "replay") {
      c.description("D2/D3: offline replay of a frozen corpus (no site or model access)")
        .option("--repeat <n>", "Replay N times and report repeatability", "1")
        .option("--inject", "Use deterministic injected responses instead of a cache (diagnostic, pilot corpora only)")
        .option("--no-defects", "Do not append flaky checks to eval/phase2-defects.jsonl");
    } else {
      c.description("D3: replay with live model calls for missing cache entries only, within a budget (no site access)")
        .requiredOption("--max-cost-usd <amount>", "Stop starting model calls once this much is spent");
    }
    c.action(async (opts: Record<string, string | boolean | undefined>) => {
      if (opts.dataDir) process.env.WCAG_EVAL_DATA_DIR = String(opts.dataDir);
      const { paths, config } = context();
      const split = String(opts.split) as Split;
      try {
        guardSplit(paths, split, opts.unseal as string | undefined, `${name} --corpus ${opts.corpus} --split ${split}`);
      } catch (err) {
        if (err instanceof HoldoutSealed) { console.error(err.message); process.exit(2); }
        throw err;
      }
      const inject = name === "replay" && Boolean(opts.inject);
      if (inject && (split !== "pilot" || opts.purpose !== "diagnostic")) {
        console.error("--inject is only for diagnostic runs on pilot corpora");
        process.exit(2);
      }
      if (!inject && !opts.cache) {
        console.error("--cache <namespace> is required");
        process.exit(2);
      }
      const purpose = parsePurpose(String(opts.purpose));
      if (name === "record" && purpose !== "diagnostic") {
        console.error("record runs are diagnostic; official runs replay a completed record");
        process.exit(2);
      }
      const run = begin(name, [name, ...process.argv.slice(4)], purpose);
      try {
        const engine = await resolveEngine(paths, String(opts.engine), run.manifest.harness.sha, log);
        const cache = opts.cache ? new ResponseCache(paths.cacheDir, String(opts.cache)) : undefined;
        let client;
        if (inject) client = { mode: "inject" as const, injector: deterministicInjector, namespace: null };
        else if (name === "replay") client = { mode: "replay" as const, cache, namespace: String(opts.cache) };
        else {
          const budget = Number(opts.maxCostUsd);
          if (!Number.isFinite(budget) || budget <= 0) throw new Error("--max-cost-usd must be a positive number");
          if (!process.env.ANTHROPIC_API_KEY) throw new Error("record needs ANTHROPIC_API_KEY");
          const live = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
          client = { mode: "record" as const, cache, live: live.messages as never, maxCostUsd: budget, namespace: String(opts.cache) };
        }
        const result = await executeReplayRun({
          paths, config, run, engine, corpusVersion: String(opts.corpus), split,
          sites: opts.sites ? String(opts.sites).split(",") : undefined,
          pages: opts.pages ? String(opts.pages).split(",") : undefined,
          client, repeat: name === "replay" ? Math.max(1, parseInt(String(opts.repeat ?? "1"), 10)) : 1,
          logDefects: name === "replay" && opts.defects !== false,
          allowEgress: name === "record" ? [MODEL_API_EGRESS] : [], log,
        });
        const m = run.finish("completed");
        const rep = result.repeatability;
        process.stdout.write(`pages ${m.totals.pages}, HAR/Node misses ${m.totals.har_misses}, image misses ${m.totals.image_misses}, cache misses ${m.totals.cache_misses}, egress ${m.totals.attempted_egress}\n`);
        if (m.model) process.stdout.write(`model: ${m.model.entries_read} read, ${m.model.entries_created} recorded, ~$${(m.model.cost_usd_estimate ?? 0).toFixed(2)}\n`);
        if (rep) process.stdout.write(`repeatability: non-behavioral identical=${rep.non_behavioral_identical}; flaky checks: ${rep.checks.filter((c) => c.varying_pairs > 0).map((c) => `${c.check} ${c.varying_pairs}/${c.tested_pairs}`).join(", ") || "none"}\n`);
        process.stdout.write(`valid=${m.validity.valid}${m.validity.reasons.length ? ` (${m.validity.reasons.join("; ")})` : ""}\n`);
        process.exitCode = m.validity.valid ? 0 : 1;
      } catch (err) {
        run.invalidate(`${name} error: ${err instanceof Error ? err.message : String(err)}`);
        run.finish("failed");
        console.error(err instanceof Error ? err.message : err);
        process.exitCode = 2;
      }
    });
  };
  replayLike("replay");
  replayLike("record");

  const serveUntilInterrupted = async (server: { url: string; close(): Promise<void> }) => {
    process.stdout.write(`review screen ${server.url}  (127.0.0.1 only; Ctrl-C to stop)\n`);
    await new Promise<void>((resolve) => process.once("SIGINT", () => resolve()));
    await server.close();
  };

  cmd.command("review")
    .description("D9: local review screen for a run's findings (T/F/S/U/N/Z)")
    .requiredOption("--run <id>", "Replay run id")
    .option("--batch <batch>", "calibration | queue | anchor | adhoc", "queue")
    .option("--criterion <id>", "Only this criterion")
    .option("--reviewer <name>", "Recorded with every label", "paul")
    .option("--port <n>", "Port (default: any free port)")
    .option("--data-dir <path>", "Private data root (default wcag-data)")
    .action(async (opts: { run: string; batch: string; criterion?: string; reviewer: string; port?: string; dataDir?: string }) => {
      if (opts.dataDir) process.env.WCAG_EVAL_DATA_DIR = opts.dataDir;
      if (!["calibration", "queue", "anchor", "adhoc"].includes(opts.batch)) {
        console.error("--batch must be calibration, queue, anchor or adhoc");
        process.exit(2);
      }
      const { paths, config } = context();
      const server = await startReviewServer({
        paths, config, mode: "review", reviewer: opts.reviewer, runId: opts.run, batch: opts.batch as Batch,
        criterion: opts.criterion, headedReplay: true, port: opts.port ? Number(opts.port) : undefined, log,
      });
      await serveUntilInterrupted(server);
    });

  cmd.command("audit")
    .description("D9: independent audit of declared pages and criteria, blind to engine output until frozen")
    .option("--corpus <version>", "Corpus version (new audit)")
    .option("--split <split>", "tuning | dev (new audit)", "tuning")
    .option("--pages <ids>", "Comma-separated site/page ids, e.g. t01/p001,t01/p004 (new audit)")
    .option("--criteria <ids>", "Comma-separated criteria (new audit)")
    .option("--resume <auditId>", "Resume an existing audit (AU-0001)")
    .option("--reviewer <name>", "Recorded with every label", "paul")
    .option("--port <n>", "Port (default: any free port)")
    .option("--data-dir <path>", "Private data root (default wcag-data)")
    .action(async (opts: Record<string, string | undefined>) => {
      if (opts.dataDir) process.env.WCAG_EVAL_DATA_DIR = opts.dataDir;
      const { paths, config } = context();
      let auditId = opts.resume;
      if (!auditId) {
        if (!opts.corpus || !opts.pages || !opts.criteria) {
          console.error("A new audit needs --corpus, --pages and --criteria (or --resume <id>)");
          process.exit(2);
        }
        if (!["tuning", "dev"].includes(String(opts.split))) {
          console.error("Audits run on tuning or dev; holdout is sealed");
          process.exit(2);
        }
        const audit = createAudit(paths, { corpusVersion: opts.corpus, split: opts.split as "tuning" | "dev", pages: opts.pages.split(","), criteria: opts.criteria.split(",") });
        auditId = audit.audit_id;
        process.stdout.write(`audit ${auditId}\n`);
      }
      const server = await startReviewServer({ paths, config, mode: "audit", reviewer: String(opts.reviewer), auditId, headedReplay: true, port: opts.port ? Number(opts.port) : undefined, log });
      await serveUntilInterrupted(server);
    });

  cmd.command("metrics")
    .description("D5: metrics for a replay run against a pinned label snapshot")
    .requiredOption("--run <id>", "Replay run id")
    .option("--labels-through <seq>", "Fold labels through this sequence number (required for official runs)")
    .option("--purpose <purpose>", "diagnostic | official-accuracy", "diagnostic")
    .option("--unseal <reason>", "Required (and logged) for holdout runs")
    .option("--data-dir <path>", "Private data root (default wcag-data)")
    .action((opts: { run: string; labelsThrough?: string; purpose: string; unseal?: string; dataDir?: string }) => {
      if (opts.dataDir) process.env.WCAG_EVAL_DATA_DIR = opts.dataDir;
      const { paths, config } = context();
      const purpose = parsePurpose(opts.purpose);
      if (purpose === "official-accuracy" && opts.labelsThrough === undefined) {
        console.error("official-accuracy needs an explicit --labels-through <seq>");
        process.exit(2);
      }
      const replay = loadManifest(paths.runsDir, opts.run);
      if (!replay.corpus) { console.error(`${opts.run} is not a replay run`); process.exit(2); }
      try { guardSplit(paths, replay.corpus.split, opts.unseal, `metrics --run ${opts.run}`); } catch (err) {
        if (err instanceof HoldoutSealed) { console.error(err.message); process.exit(2); }
        throw err;
      }
      const run = begin("metrics", ["metrics", ...process.argv.slice(4)], purpose);
      try {
        const labelInputs = loadLabelInputs(paths, opts.labelsThrough !== undefined ? Number(opts.labelsThrough) : null);
        run.manifest.consumes = [opts.run];
        run.manifest.engine = replay.engine;
        run.manifest.corpus = replay.corpus;
        run.manifest.inputs = {
          labels: inputHash(paths.labels, { through_sequence: labelInputs.labelsThrough }),
          cases: inputHash(paths.cases, { count: labelInputs.cases.length }),
          seed_resolutions: inputHash(paths.seedResolutions),
          overrides: inputHash(paths.labelOverrides),
          config: inputHash(paths.config),
        };
        if (!replay.validity.valid) run.invalidate(`consumed replay ${opts.run} is invalid: ${replay.validity.reasons.join("; ")}`);
        if (purpose !== "diagnostic" && !replay.validity.official) run.invalidate(`consumed replay ${opts.run} was not an official run`);
        const report = computeMetrics(config, loadRunInputs(paths, replay), labelInputs);
        writeJson(join(run.dir, "metrics.json"), report);
        run.manifest.totals.pages = replay.totals.pages;
        run.manifest.totals.tooling_errors = report.criteria.reduce((n, c) => n + c.counts.tooling_errors, 0);
        run.manifest.totals.ambiguities = report.criteria.reduce((n, c) => n + c.counts.ambiguous, 0);
        run.manifest.extra = {
          labels_through: report.labels_through, false_passes: report.false_passes.length, unlabeled_predictions: report.unlabeled_predictions,
          labelled_criteria: report.criteria.filter((c) => c.counts.labeled_instances > 0).map((c) => c.criterion),
        };
        for (const c of report.criteria) {
          for (const [origin, m] of Object.entries(c.views.confirmed.by_origin)) {
            if (m.precision.unavailable && m.recall.unavailable) continue;
            if (m.precision.insufficient || m.recall.insufficient) run.unavailable(`${c.criterion}/${origin}`, "insufficient evidence (n below 30)");
          }
        }
        const m = run.finish("completed");
        for (const c of report.criteria.filter((x) => x.counts.labeled_instances > 0)) {
          const o = c.views.confirmed.by_origin;
          const fmt = (r: { value: number | null; n: number; lower: number | null; upper: number | null; unavailable: string | null }) => r.unavailable ? `unavailable (n=${r.n})` : `${r.value} [${r.lower}, ${r.upper}] n=${r.n}`;
          process.stdout.write(`${c.criterion}: queue precision ${fmt(o.queue.precision)}; random-audit precision ${fmt(o.random.precision)}; audit recall ${fmt(o.audit.recall)}; known-defect recall ${fmt(o.seed.recall)}\n`);
        }
        process.stdout.write(`false passes ${report.false_passes.length}; unlabeled predictions ${report.unlabeled_predictions}; valid=${m.validity.valid}\n`);
        process.exitCode = m.validity.valid ? 0 : 1;
      } catch (err) {
        run.invalidate(`metrics error: ${err instanceof Error ? err.message : String(err)}`);
        run.finish("failed");
        console.error(err instanceof Error ? err.message : err);
        process.exitCode = 2;
      }
    });

  cmd.command("export")
    .description("Write a run's committed aggregate export (privacy-checked)")
    .requiredOption("--run <id>", "Metrics run id")
    .requiredOption("--aggregates-only", "Only aggregate results are ever exported")
    .action((opts: { run: string }) => {
      const { paths } = context();
      const manifest = loadManifest(paths.runsDir, opts.run);
      const metricsPath = join(paths.runsDir, opts.run, "metrics.json");
      if (!existsSync(metricsPath)) { console.error(`${opts.run} has no metrics.json (is it a metrics run?)`); process.exit(2); }
      const report = readJson<Parameters<typeof aggregateExport>[0]>(metricsPath);
      const out = join(paths.committedRunsDir, opts.run, "metrics.json");
      writeExport(out, {
        ...aggregateExport(report, manifest),
        manifest: { run_id: manifest.run_id, purpose: manifest.purpose, harness: { sha: manifest.harness.sha, dirty: manifest.harness.dirty }, consumes: manifest.consumes, inputs: Object.fromEntries(Object.entries(manifest.inputs).map(([k, v]) => [k, { sha256: v.sha256, through_sequence: v.through_sequence ?? null, count: v.count ?? null }])), validity: manifest.validity },
      }, knownPrivateHosts(paths));
      process.stdout.write(`export ${out}\n`);
    });

  cmd.command("static")
    .description("D10: Lakewood static regression set (resolve seeds; run DOM-only checks per engine offline)")
    .option("--resolve", "Resolve the seeds against wcag-old.db and write eval/lakewood-static.json (no model, no network)")
    .option("--engine <sha>", "head | baseline | <sha>")
    .option("--cache <namespace>", "Static response cache namespace (separate from corpus caches)", "static-v1")
    .option("--record", "Make live model calls for missing static cache entries")
    .option("--max-cost-usd <amount>", "Budget for --record")
    .option("--repeat <n>", "Run N times; runs must match", "2")
    .option("--synthetic", "Also run the scan-level synthetic fixtures (SL-001, SL-016)")
    .option("--purpose <purpose>", "diagnostic | official-regression", "diagnostic")
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      const { paths, config } = context();
      if (opts.resolve) {
        const run = begin("static-resolve", ["static", "--resolve"], "diagnostic");
        const engines = { head: Object.keys(CHECK_TIERS), baseline: Object.keys(CHECK_TIERS) };
        const r = resolveStatic(paths, config, engines);
        writeResolution(paths, r);
        run.manifest.inputs = { seeds: inputHash(paths.seedLabels), overrides: inputHash(paths.labelOverrides), static_expectations: inputHash(paths.lakewoodStatic), seed_resolutions: inputHash(paths.seedResolutions) };
        run.manifest.extra = { cases: r.file.cases.length, by_status: r.file.cases.reduce<Record<string, number>>((m, c) => ({ ...m, [c.status]: (m[c.status] ?? 0) + 1 }), {}), new_resolutions: r.resolutions.length, problems: r.problems };
        for (const p of r.problems) run.invalidate(p);
        const m = run.finish("completed");
        process.stdout.write(`${r.file.cases.length} static case(s); ${r.resolutions.length} new seed resolution record(s); problems: ${r.problems.length ? r.problems.join("; ") : "none"}; valid=${m.validity.valid}\n`);
        return;
      }
      if (!opts.engine) { console.error("--engine is required (or --resolve)"); process.exit(2); }
      const purpose = parsePurpose(String(opts.purpose));
      const run = begin("static", ["static", ...process.argv.slice(4)], purpose);
      try {
        const engine = await resolveEngine(paths, String(opts.engine), run.manifest.harness.sha, log);
        const cache = new ResponseCache(paths.cacheDir, String(opts.cache));
        let client: Parameters<typeof runStatic>[0]["client"] = { mode: "replay", cache };
        if (opts.record) {
          const budget = Number(opts.maxCostUsd);
          if (!Number.isFinite(budget) || budget <= 0) throw new Error("--record needs --max-cost-usd");
          if (!process.env.ANTHROPIC_API_KEY) throw new Error("--record needs ANTHROPIC_API_KEY");
          client = { mode: "record", cache, live: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }).messages as never, maxCostUsd: budget };
        }
        run.manifest.engine = { label: engine.label, sha: engine.sha, bridge: engine.bridge };
        run.manifest.inputs = { static_expectations: inputHash(paths.lakewoodStatic), seed_resolutions: inputHash(paths.seedResolutions) };
        const repeat = opts.record ? 1 : Math.max(1, parseInt(String(opts.repeat), 10));
        const results: StaticRunResult[] = [];
        for (let i = 0; i < repeat; i++) {
          results.push(await runStatic({ paths, config, engine, client, runId: run.manifest.run_id, includeSynthetic: Boolean(opts.synthetic) && i === 0, log }));
        }
        const r0 = results[0];
        writeJson(join(run.dir, "static-results.json"), results.map((r) => ({ engine: r.engine, outcomes: r.outcomes, model: { ...r.model, attempts_used: r.model.attempts_used.length }, egress: r.egress, static_resources_refused: r.static_resources_refused, synthetic: r.synthetic })));
        const attempts = Array.from(new Set(results.flatMap((r) => r.model.attempts_used))).sort();
        run.manifest.model = {
          cache_namespace: String(opts.cache), mode: client.mode, entries_read: r0.model.entries_read, entries_created: r0.model.entries_created,
          model_ids: [], template_hashes: {}, system_prompt_hashes: {}, parameters: { max_tokens: 4096, temperature: 0 }, image_index_sha256: null,
          shared_responses: 0, entries_sha256: attempts.length ? (await import("../../eval/util.js")).sha256(attempts.join("\n")) : null, cost_usd_estimate: r0.model.cost_usd,
        };
        run.manifest.totals.attempted_egress = results.reduce((n, r) => n + r.egress, 0);
        if (repeat > 1) {
          const cmp = staticRunsMatch(results[0], results[1]);
          if (!cmp.identical) run.invalidate(`static replays differ: ${cmp.differences.join(", ")}`);
          run.manifest.extra.replays_identical = cmp.identical;
        }
        const counts = r0.outcomes.reduce<Record<string, number>>((m, o) => ({ ...m, [o.outcome]: (m[o.outcome] ?? 0) + 1 }), {});
        run.manifest.extra = { ...run.manifest.extra, outcomes: counts, synthetic: r0.synthetic, cache_misses: r0.model.cache_misses };
        if (r0.model.cache_misses > 0) run.unavailable("model-dependent static cases", `${r0.model.cache_misses} request(s) not recorded in ${String(opts.cache)}`);
        const m = run.finish("completed");
        // Committed aggregate: case ids, outcomes and reasons only
        writeExport(join(paths.committedRunsDir, m.run_id, "static.json"), {
          run_id: m.run_id, engine: { label: engine.label, sha: engine.sha, bridge: engine.bridge }, harness: { sha: m.harness.sha, dirty: m.harness.dirty },
          cache_namespace: String(opts.cache), validity: m.validity, replays_identical: run.manifest.extra.replays_identical ?? null,
          outcomes: r0.outcomes.map((o) => ({ case_id: o.case_id, outcome: o.outcome, reason: o.reason, severity_ok: o.severity_ok })),
          counts, synthetic: r0.synthetic, cache_misses: r0.model.cache_misses, egress: run.manifest.totals.attempted_egress,
        }, knownPrivateHosts(paths));
        for (const o of r0.outcomes.filter((x) => x.outcome !== "not_run")) process.stdout.write(`${o.case_id} ${o.outcome}: ${o.reason}\n`);
        if (r0.synthetic) process.stdout.write(`SL-001 ${r0.synthetic.sl001.outcome}: ${r0.synthetic.sl001.detail}\nSL-016 ${r0.synthetic.sl016.outcome}: ${r0.synthetic.sl016.detail}\n`);
        process.stdout.write(`${JSON.stringify(counts)}; cache misses ${r0.model.cache_misses}; egress ${run.manifest.totals.attempted_egress}; valid=${m.validity.valid}\n`);
      } catch (err) {
        run.invalidate(`static error: ${err instanceof Error ? err.message : String(err)}`);
        run.finish("failed");
        console.error(err instanceof Error ? err.stack : err);
        process.exitCode = 2;
      }
    });

  const runCompare = (opts: Record<string, string | undefined>, command: "compare" | "reference") => {
    if (opts.dataDir) process.env.WCAG_EVAL_DATA_DIR = opts.dataDir;
    const { paths, config } = context();
    const baseM = loadManifest(paths.runsDir, String(opts.base));
    const headM = loadManifest(paths.runsDir, String(opts.head));
    const purpose = parsePurpose(String(opts.purpose ?? "diagnostic"));
    const run = begin(command, [command, ...process.argv.slice(4)], purpose);
    const labels = loadLabelInputs(paths, opts.labelsThrough !== undefined ? Number(opts.labelsThrough) : null);
    const snapshot = labelSnapshotSha(new LabelStore(paths.labels).events(), labels.labelsThrough);
    // Re-verify the frozen artifacts both runs used
    const corpusProblems: string[] = [];
    if (headM.corpus) {
      for (const site of headM.corpus.sites) {
        try {
          for (const p of verifySite(paths, { version: headM.corpus.version, split: headM.corpus.split as CorpusSplit, siteId: site }).problems) corpusProblems.push(`${p.site}${p.page ? `/${p.page}` : ""}: ${p.problem}`);
        } catch (err) {
          corpusProblems.push(`${site}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    const staticOutcomes = (id?: string): StaticCaseOutcome[] | undefined => {
      if (!id) return undefined;
      return readJson<Array<{ outcomes: StaticCaseOutcome[] }>>(join(paths.runsDir, id, "static-results.json"))[0].outcomes;
    };
    const settled = existsSync(paths.lakewoodStatic) ? new Set(readJson<StaticFile>(paths.lakewoodStatic).cases.filter((c) => c.adjudication === "settled").map((c) => c.case_id)) : undefined;
    const result = compareRuns({
      config, base: loadRunInputs(paths, baseM), head: loadRunInputs(paths, headM), labels, labelSnapshotSha: snapshot,
      expectedLabelSnapshotSha: opts.labelsSha, staticBase: staticOutcomes(opts.staticBase), staticHead: staticOutcomes(opts.staticHead), staticSettled: settled, corpusProblems,
    });
    run.manifest.consumes = [baseM.run_id, headM.run_id, ...(opts.staticBase ? [opts.staticBase] : []), ...(opts.staticHead ? [opts.staticHead] : [])];
    run.manifest.corpus = headM.corpus;
    run.manifest.inputs = {
      labels: inputHash(paths.labels, { through_sequence: labels.labelsThrough }), cases: inputHash(paths.cases, { count: labels.cases.length }),
      overrides: inputHash(paths.labelOverrides), static_expectations: inputHash(paths.lakewoodStatic), config: inputHash(paths.config),
    };
    run.manifest.extra = { exit: result.exit, label_snapshot_sha256: snapshot, regressions: result.regressions.length, existing_blockers: result.existing_blockers.length, invalid: result.invalid };
    for (const reason of result.invalid) run.invalidate(`comparison: ${reason}`);
    writeJson(join(run.dir, "compare.json"), result);
    const m = run.finish("completed");
    const hosts = knownPrivateHosts(paths);
    const summary = { run_id: m.run_id, base: baseM.run_id, head: headM.run_id, exit: result.exit, invalid: result.invalid, regressions: result.regressions, existing_blockers: result.existing_blockers, report: result.report, label_snapshot_sha256: snapshot };
    if (purpose !== "diagnostic" || command === "reference") writeExport(join(paths.committedRunsDir, m.run_id, "compare.json"), summary, hosts);
    if (command === "reference" && headM.corpus && headM.corpus.split !== "pilot") {
      const exportBody = referenceExport({ base: baseM, head: headM, compare: result, capability: capabilityMap(BASELINE_CHECKS, Object.keys(CHECK_TIERS)), history: historicalContext(paths), compareRunId: m.run_id });
      writeExport(join(paths.committedBaselinesDir, "2026-10-04", `reference-${headM.corpus.split}.json`), exportBody, hosts);
    }
    process.stdout.write(`compare ${baseM.engine.label} → ${headM.engine.label}: exit ${result.exit}\n`);
    for (const r of result.invalid) process.stdout.write(`INVALID ${r}\n`);
    for (const r of result.regressions) process.stdout.write(`REGRESSION ${r.kind}: ${r.detail}\n`);
    for (const r of result.existing_blockers) process.stdout.write(`existing blocker ${r.kind}: ${r.detail}\n`);
    process.stdout.write(`shared pages ${result.report.shared_pages}; added ${JSON.stringify(result.report.findings_added)}; removed ${JSON.stringify(result.report.findings_removed)}\n`);
    process.stdout.write(`criterion transitions ${result.report.criterion_transitions.length}; case changes ${result.report.case_changes.length}; coverage changes ${result.report.coverage_changes.length} (${result.report.coverage_comparison}); unlabeled ${result.report.unlabeled.base} → ${result.report.unlabeled.head}; tooling errors ${result.report.tooling_errors.base} → ${result.report.tooling_errors.head}\n`);
    process.exitCode = result.exit;
  };

  for (const name of ["compare", "reference"] as const) {
    cmd.command(name)
      .description(name === "compare" ? "D7: compare two pinned replay runs (exit 0 no regression, 1 regression, 2 invalid)" : "D6: baseline vs HEAD reference comparison and the eval/baselines export")
      .requiredOption("--base <id>", "Base replay run id")
      .requiredOption("--head <id>", "Head replay run id")
      .option("--labels-through <seq>", "Score both against labels through this sequence (default: all)")
      .option("--labels-sha <sha256>", "Refuse if the label snapshot differs from this pinned hash")
      .option("--static-base <id>", "Static run of the base engine")
      .option("--static-head <id>", "Static run of the head engine")
      .option("--purpose <purpose>", "diagnostic | official-regression", "diagnostic")
      .option("--data-dir <path>", "Private data root (default wcag-data)")
      .action((opts: Record<string, string | undefined>) => {
        try {
          runCompare(opts, name);
        } catch (err) {
          console.error(err instanceof Error ? err.message : err);
          process.exitCode = 2;
        }
      });
  }

  cmd.command("admit")
    .description("D1b: admit municipal Webflow sites from the BuiltWith list (site access under capture etiquette; no model calls)")
    .requiredOption("--input <file>", "Paul's candidate file (e.g. wcag-data/eval-corpus/builtwith.csv)")
    .requiredOption("--salt-env <name>", "Environment variable holding the split salt")
    .option("--select-pages", "Also choose up to the per-site cap of pages for newly admitted sites")
    .action(async (opts: { input: string; saltEnv: string; selectPages?: boolean }) => {
      const { paths, config } = context();
      const contactUrl = process.env.EVAL_CONTACT_URL;
      const salt = process.env[opts.saltEnv];
      if (!contactUrl) { console.error("EVAL_CONTACT_URL is required (it goes in the user agent)."); process.exit(2); }
      if (!salt) { console.error(`Set ${opts.saltEnv} to the split salt.`); process.exit(2); }
      const run = begin("admit", ["admit", "--salt-env", opts.saltEnv], "diagnostic");
      try {
        const ua = userAgentFor(config, contactUrl!);
        const fetchImpl: FetchLike = (url, init) => fetch(url, { headers: init?.headers, redirect: "follow" }) as never;
        const result = await admitSites({ paths, config, csv: readCandidateFile(opts.input), salt: salt!, userAgent: ua, fetchImpl, log });
        if (opts.selectPages) {
          const pacer = new Pacer(config.capture.min_seconds_between_top_level_loads * 1000);
          for (const id of result.newly_assigned) {
            const site = loadSitesPrivate(paths).sites.find((s) => s.site_id === id)!;
            const sel = await selectPages(site, { fetchImpl, userAgent: ua, maxPages: config.capture.max_pages_per_site, pacer });
            if (sel.pages.length === 0) continue;
            registerSite(paths, { siteId: id, rootUrl: site.root_url, split: site.split, urls: sel.pages });
            const urlsDir = join(paths.corpusDir, "urls");
            mkdirSync(urlsDir, { recursive: true });
            writeFileSync(join(urlsDir, `${id}.txt`), [site.root_url, ...sel.pages].join("\n") + "\n");
            writeJson(join(urlsDir, `${id}.omissions.private.json`), sel.omitted);
          }
        }
        run.manifest.extra = {
          candidates: result.candidates, duplicates: result.duplicates, admitted: result.decisions.filter((d) => d.admitted).length,
          rejected: result.decisions.filter((d) => !d.admitted).length, families: result.families.length,
          by_split: result.families.reduce<Record<string, number>>((m, f) => ({ ...m, [f.split]: (m[f.split] ?? 0) + f.sites.length }), {}),
          newly_assigned: result.newly_assigned, enough_sites: result.enough_sites,
        };
        if (!result.enough_sites) run.unavailable("dev capture", "fewer than 15 admitted sites: ask Paul before capturing");
        run.finish("completed");
        process.stdout.write(`${result.candidates} candidate(s), ${result.duplicates} duplicate(s); admitted ${result.decisions.filter((d) => d.admitted).length}, rejected ${result.decisions.filter((d) => !d.admitted).length}; ${result.families.length} famil(y/ies)\n`);
        if (!result.enough_sites) process.stdout.write("Fewer than 15 sites: admission results are ready; ask Paul before capturing dev.\n");
      } catch (err) {
        run.invalidate(`admit error: ${err instanceof Error ? err.message : String(err)}`);
        run.finish("failed");
        console.error(err instanceof Error ? err.message : err);
        process.exitCode = 2;
      }
    });

  cmd.command("pace")
    .description("D9: labelling pace by criterion and batch")
    .option("--data-dir <path>", "Private data root (default wcag-data)")
    .action((opts: { dataDir?: string }) => {
      if (opts.dataDir) process.env.WCAG_EVAL_DATA_DIR = opts.dataDir;
      const { paths } = context();
      process.stdout.write(formatPace(paceReport(paths)) + "\n");
    });

  return cmd;
}

export { parsePurpose };
