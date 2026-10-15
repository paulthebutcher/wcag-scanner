import { join } from "node:path";
import { canonicalJson, hashJson, sha256, writeJson } from "./util.js";
import { listSites, loadSiteCapture, pageSetHash, type Split } from "./corpus.js";
import { replaySite, type ReplayClientOptions, type SiteReplay } from "./replay.js";
import { isBehavioral, type EvalConfig } from "./config.js";
import type { EvalPaths } from "./paths.js";
import type { EngineHandle } from "./engine/types.js";
import type { RunHandle } from "./manifest.js";
import type { FindingKey, CoverageRow, CriterionStatusRow } from "./normalize.js";
import { appendDefect } from "./defects.js";

// ---------------------------------------------------------------------------
// D2/D3 run orchestration: replay (or record) every site of a corpus split
// with one engine, optionally several times, pin everything the run used in
// its manifest, and report repeatability.
// ---------------------------------------------------------------------------

export interface ReplayRunOptions {
  paths: EvalPaths;
  config: EvalConfig;
  run: RunHandle;
  engine: EngineHandle;
  corpusVersion: string;
  split: Split;
  sites?: string[];
  /** Page-id subset (diagnostic only) */
  pages?: string[];
  client: ReplayClientOptions & { namespace: string | null };
  repeat: number;
  /** Append flaky or unstable checks to eval/phase2-defects.jsonl */
  logDefects: boolean;
  allowEgress?: string[];
  log: (message: string) => void;
}

export interface CheckFlake {
  check: string;
  behavioral: boolean;
  tested_pairs: number;
  varying_pairs: number;
  flake_rate: number | null;
}

export interface RepeatabilityReport {
  repeats: number;
  valid_repeats: number;
  invalid_repeats: Array<{ repeat: number; reasons: string[] }>;
  non_behavioral_identical: boolean;
  checks: CheckFlake[];
  criterion_statuses_identical: boolean;
  coverage_identical: boolean;
  differing_pairs: Array<{ site: string; page: string; check: string; behavioral: boolean }>;
}

export interface ReplayRunResult {
  replays: SiteReplay[][];
  repeatability: RepeatabilityReport | null;
}

export async function executeReplayRun(options: ReplayRunOptions): Promise<ReplayRunResult> {
  const { paths, config, run, engine, log } = options;
  const sites = options.sites ?? listSites(paths, options.corpusVersion, options.split);
  if (sites.length === 0) throw new Error(`No sites in corpus ${options.corpusVersion}/${options.split}`);
  const captures = sites.map((siteId) => loadSiteCapture(paths, { version: options.corpusVersion, split: options.split, siteId }));

  const m = run.manifest;
  m.engine = { label: engine.label, sha: engine.sha, bridge: engine.bridge };
  if (options.pages && m.purpose !== "diagnostic") throw new Error("A page subset is only allowed in diagnostic runs");
  const keep = (pageId: string) => !options.pages || options.pages.includes(pageId);
  const first = captures[0];
  m.scan_contract = {
    tiers: config.replay.tiers,
    checks: null,
    viewport: config.replay.viewport,
    locale: first.contract.locale,
    timezone: first.contract.timezone,
    user_agent: first.contract.userAgent,
    page_order: captures.flatMap((c) => c.pages.filter((p) => p.status === "captured" && keep(p.page_id)).sort((a, b) => a.order - b.order).map((p) => `${c.site_id}/${p.page_id}`)),
    page_concurrency: config.replay.page_concurrency,
    llm_concurrency: config.replay.llm_concurrency,
    service_workers: "block",
  };
  const artifactHashes: Record<string, string> = {};
  const exclusions: Array<{ page: string; reason: string }> = [];
  for (const c of captures) {
    for (const p of c.pages.filter((x) => keep(x.page_id))) {
      if (p.status !== "captured") {
        exclusions.push({ page: `${c.site_id}/${p.page_id}`, reason: p.status === "excluded" ? `excluded: ${p.error ?? "no reason"}` : `capture failed: ${p.error ?? "unknown"}` });
        continue;
      }
      const files = Object.entries(c.file_hashes).filter(([rel]) => rel.startsWith(`${p.page_id}/`));
      artifactHashes[`${c.site_id}/${p.page_id}`] = hashJson(Object.fromEntries(files));
    }
  }
  m.corpus = {
    version: options.corpusVersion,
    split: options.split,
    sites,
    page_set_sha256: pageSetHash(captures.map((c) => ({ siteId: c.site_id, pages: c.pages.filter((p) => p.status === "captured" && keep(p.page_id)).map((p) => ({ page_id: p.page_id, url: p.url })) }))),
    artifact_hashes: artifactHashes,
    exclusions,
    declared_exclusions_version: config.declared_exclusions.version,
  };
  run.save();

  const replays: SiteReplay[][] = [];
  for (let r = 1; r <= options.repeat; r++) {
    const rep: SiteReplay[] = [];
    for (const siteId of sites) {
      log(`[run] repeat ${r}/${options.repeat}: ${siteId}`);
      rep.push(await replaySite({
        paths, config, corpus: { version: options.corpusVersion, split: options.split, siteId }, engine,
        client: options.client, runId: m.run_id, runDir: run.dir, declaredExclusions: config.declared_exclusions.host_suffixes, declaredResourceTypes: config.declared_exclusions.resource_types ?? [],
        tag: options.repeat > 1 ? `${engine.label}-r${r}` : engine.label, allowEgress: options.allowEgress, pages: options.pages, log,
      }));
    }
    replays.push(rep);
  }

  // --- manifest: model and totals ------------------------------------------
  const all = replays.flat();
  const sum = (f: (r: SiteReplay) => number) => all.reduce((n, r) => n + f(r), 0);
  const attempts = Array.from(new Set(all.flatMap((r) => r.client.attempts_used))).sort();
  const templateHashes: Record<string, string> = {};
  const systemHashes: Record<string, string> = {};
  for (const r of all) {
    Object.assign(templateHashes, r.client.template_hashes);
    Object.assign(systemHashes, r.client.system_prompt_hashes);
  }
  m.model = {
    cache_namespace: options.client.namespace,
    mode: options.client.mode,
    entries_read: sum((r) => r.client.entries_read),
    entries_created: sum((r) => r.client.entries_created),
    model_ids: Array.from(new Set(all.flatMap((r) => r.client.model_ids))).sort(),
    template_hashes: templateHashes,
    system_prompt_hashes: systemHashes,
    parameters: { max_tokens: 4096, temperature: 0 },
    image_index_sha256: sha256(canonicalJson(replays[0].map((r) => [r.site, r.image_index_sha256]))),
    shared_responses: sum((r) => r.client.shared_responses),
    entries_sha256: attempts.length > 0 ? sha256(attempts.join("\n")) : null,
    cost_usd_estimate: sum((r) => r.client.cost_usd),
  };
  const t = m.totals;
  t.pages = replays[0].reduce((n, r) => n + r.totals.pages, 0);
  t.har_misses = sum((r) => r.totals.har_misses + r.totals.node_fetch_misses);
  t.image_misses = sum((r) => r.totals.image_misses);
  t.cache_misses = sum((r) => r.totals.cache_misses);
  t.attempted_egress = sum((r) => r.totals.attempted_egress);
  t.contained_submissions = sum((r) => r.totals.contained_submissions);
  t.declared_exclusion_hits = sum((r) => r.totals.declared_exclusion_hits);
  t.tooling_errors = sum((r) => r.totals.tooling_errors);
  const coverage: Record<string, number> = {};
  for (const r of replays[0]) for (const row of r.normalized.coverage ?? []) coverage[row.status] = (coverage[row.status] ?? 0) + 1;
  t.coverage = coverage;
  if (sum((r) => r.client.budget_refusals) > 0) run.invalidate("record budget exhausted before every call was made (incomplete record)");
  for (const c of captures) {
    const captured = c.pages.filter((p) => p.status === "captured").length;
    const excluded = c.pages.length - captured + c.omissions.length;
    const total = c.pages.length + c.omissions.length;
    if (options.split === "tuning" && total > 0 && excluded / total > config.gate.max_excluded_page_fraction_per_tuning_site) {
      run.invalidate(`${c.site_id}: ${excluded}/${total} pages excluded (over ${config.gate.max_excluded_page_fraction_per_tuning_site * 100}%)`);
    }
  }

  const repeatability = options.repeat > 1 ? analyzeRepeatability(config, replays, engine.checks) : null;
  if (repeatability) {
    if (repeatability.invalid_repeats.length > 0) run.invalidate(`${repeatability.invalid_repeats.length} repeat(s) invalid (cache, HAR or image misses)`);
    if (!repeatability.non_behavioral_identical) run.invalidate("non-behavioral checks did not replay identically");
    if (options.logDefects && options.split !== "pilot") {
      for (const c of repeatability.checks.filter((x) => x.varying_pairs > 0)) {
        appendDefect(paths, {
          found_in: m.run_id,
          component: `check:${c.check}`,
          summary: c.behavioral
            ? `Behavioral check ${c.check} varied on ${c.varying_pairs} of ${c.tested_pairs} (page, check) pairs across ${repeatability.repeats} identical replays (flake rate ${(c.flake_rate ?? 0).toFixed(3)}).`
            : `Non-behavioral check ${c.check} varied on ${c.varying_pairs} of ${c.tested_pairs} pairs across ${repeatability.repeats} identical replays; harness causes ruled out first.`,
          affects: [],
          evidence: `run ${m.run_id}, corpus ${options.corpusVersion}/${options.split}`,
        });
      }
    }
  }
  m.extra = {
    ...m.extra,
    repeatability,
    per_site: replays.map((rep, i) => rep.map((r) => ({ repeat: i + 1, site: r.site, totals: r.totals, findings: r.result.findings.length, model_requests: r.client.requests, har_merge: r.har_merge }))),
  };
  writeJson(join(run.dir, "repeatability.json"), repeatability);
  return { replays, repeatability };
}

// ---------------------------------------------------------------------------
// Repeatability (D3): compare repeats on the multiset of (criterion,
// locator, failure type, check, severity, confidence) per (page, check),
// plus criterion statuses and coverage. Only ids, timestamps and paths are
// normalised away.
// ---------------------------------------------------------------------------

export function analyzeRepeatability(config: EvalConfig, replays: SiteReplay[][], engineChecks: string[]): RepeatabilityReport {
  const invalid: RepeatabilityReport["invalid_repeats"] = [];
  replays.forEach((rep, i) => {
    const reasons: string[] = [];
    for (const r of rep) {
      if (r.totals.cache_misses > 0) reasons.push(`${r.site}: ${r.totals.cache_misses} cache miss(es)`);
      if (r.totals.har_misses + r.totals.node_fetch_misses > 0) reasons.push(`${r.site}: ${r.totals.har_misses + r.totals.node_fetch_misses} HAR/Node miss(es)`);
      if (r.totals.image_misses > 0) reasons.push(`${r.site}: ${r.totals.image_misses} image miss(es)`);
      if (r.totals.attempted_egress > 0) reasons.push(`${r.site}: egress`);
    }
    if (reasons.length > 0) invalid.push({ repeat: i + 1, reasons });
  });

  type PairKey = string;
  const pairFindings: Array<Map<PairKey, string[]>> = [];
  const pairCoverage: Array<Map<PairKey, string>> = [];
  const tested = new Set<PairKey>();
  const allPairs = new Set<PairKey>();
  for (const rep of replays) {
    const fmap = new Map<PairKey, string[]>();
    const cmap = new Map<PairKey, string>();
    for (const r of rep) {
      for (const k of r.normalized.keys) {
        const key = `${r.site}|${k.page}|${k.check ?? "unknown"}`;
        const list = fmap.get(key) ?? [];
        list.push(keyTuple(k));
        fmap.set(key, list);
        allPairs.add(key);
      }
      if (r.normalized.coverage) {
        for (const row of r.normalized.coverage) {
          const key = `${r.site}|${row.page}|${row.check}`;
          cmap.set(key, row.status);
          allPairs.add(key);
          if (row.status === "ran" || row.status === "partial") tested.add(key);
        }
      } else {
        // Engines without coverage: every page × check counts as tested
        for (const page of r.page_ids) for (const check of engineChecks) {
          const key = `${r.site}|${page}|${check}`;
          tested.add(key);
          allPairs.add(key);
        }
      }
    }
    for (const list of fmap.values()) list.sort();
    pairFindings.push(fmap);
    pairCoverage.push(cmap);
  }

  const varying = new Set<PairKey>();
  for (const key of allPairs) {
    const f0 = JSON.stringify(pairFindings[0].get(key) ?? []);
    const c0 = pairCoverage[0].get(key) ?? null;
    for (let i = 1; i < replays.length; i++) {
      if (JSON.stringify(pairFindings[i].get(key) ?? []) !== f0 || (pairCoverage[i].get(key) ?? null) !== c0) {
        varying.add(key);
        break;
      }
    }
  }

  const checks = new Map<string, CheckFlake>();
  for (const key of new Set([...tested, ...varying])) {
    const check = key.split("|")[2];
    const entry = checks.get(check) ?? { check, behavioral: isBehavioral(config, check), tested_pairs: 0, varying_pairs: 0, flake_rate: null };
    if (tested.has(key)) entry.tested_pairs++;
    if (varying.has(key)) entry.varying_pairs++;
    checks.set(check, entry);
  }
  for (const c of checks.values()) c.flake_rate = c.tested_pairs > 0 ? c.varying_pairs / c.tested_pairs : null;

  const critSame = replays.every((rep) => canonicalJson(rep.map((r) => statusesOf(r.normalized.criteria))) === canonicalJson(replays[0].map((r) => statusesOf(r.normalized.criteria))));
  const covSame = replays.every((rep) => canonicalJson(rep.map((r) => coverageOf(r.normalized.coverage))) === canonicalJson(replays[0].map((r) => coverageOf(r.normalized.coverage))));
  const differing = Array.from(varying).sort().map((key) => {
    const [site, page, check] = key.split("|");
    return { site, page, check, behavioral: isBehavioral(config, check) };
  });
  return {
    repeats: replays.length,
    valid_repeats: replays.length - invalid.length,
    invalid_repeats: invalid,
    non_behavioral_identical: differing.every((d) => d.behavioral),
    checks: Array.from(checks.values()).sort((a, b) => a.check.localeCompare(b.check)),
    criterion_statuses_identical: critSame,
    coverage_identical: covSame,
    differing_pairs: differing,
  };
}

function keyTuple(k: FindingKey): string {
  return canonicalJson([k.criterion, k.locator, k.html_sha256, k.failure_type, k.check, k.severity, k.confidence, k.also_found_on]);
}

function statusesOf(rows: CriterionStatusRow[]): Array<[string, string]> {
  return rows.map((r) => [r.criterion, r.status]);
}

function coverageOf(rows: CoverageRow[] | null): Array<[string, string, string]> | null {
  return rows ? rows.map((r) => [r.check, r.page, r.status]) : null;
}
