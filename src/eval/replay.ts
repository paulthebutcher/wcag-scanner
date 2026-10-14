import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadImageIndex, loadNodeFetchRecords, loadSiteCapture, siteDir, imageIndexHash,
  type SiteCapture, type SiteRef,
} from "./corpus.js";
import { isDeclaredConnect, launchControlledBrowser, type ControlledBrowser, type TransportCounters } from "./transport/browser.js";
import { EgressLog, installNodeEgressDenial } from "./transport/egress.js";
import { createReplayFetch, fetchKey, installFetch, type FetchEvent, type SyntheticResponse } from "./transport/node-fetch.js";
import { FuzzyIndex, mergeHars, readHar, writeHar, type MergeStats } from "./transport/har.js";
import { EvalAnthropicClient, type ClientMode, type ClientStats, type Injector, type LiveMessages } from "./model/client.js";
import { buildEvalRunner } from "./model/runner.js";
import type { ResponseCache } from "./model/cache.js";
import { parseRobots } from "./robots.js";
import type { EngineHandle, EngineRunResult, SubmissionStatesHook } from "./engine/types.js";
import type { EvalConfig } from "./config.js";
import type { EvalPaths } from "./paths.js";
import { coverageRows, criterionStatuses, findingKeys, fullFindings, type CoverageRow, type CriterionStatusRow, type FindingKey, type FullFinding } from "./normalize.js";
import { writeJson } from "./util.js";
import { buildPredictions, type Prediction } from "./predictions.js";
import { CHECK_TIERS } from "../core/check-registry.js";

// ---------------------------------------------------------------------------
// D2 offline replay of one corpus site with one engine. No site or model
// network access, from the browser or from Node: browser requests are served
// from the merged HAR, Node fetches from the capture's record, model calls
// from the response cache (or injected responses), and model images from the
// image store. Every miss and every egress attempt is counted; the run
// manifest turns any of them into an invalid run.
// ---------------------------------------------------------------------------

export interface ReplayClientOptions {
  mode: Exclude<ClientMode, "collect">;
  cache?: ResponseCache;
  injector?: Injector;
  live?: LiveMessages;
  maxCostUsd?: number;
}

export interface ReplaySiteOptions {
  paths: EvalPaths;
  config: EvalConfig;
  corpus: SiteRef;
  engine: EngineHandle;
  client: ReplayClientOptions;
  runId: string;
  runDir: string;
  declaredExclusions: string[];
  /** Resource types whose misses are declared (e.g. media) */
  declaredResourceTypes?: string[];
  /** Restrict to these page ids (pilot trap tests); default: every captured page */
  pages?: string[];
  /** Distinguishes several replays of one site and engine in a run */
  tag?: string;
  /** record mode only: Node targets ("host:port") the live model client may reach */
  allowEgress?: string[];
  log?: (message: string) => void;
}

export interface SiteReplayTotals {
  pages: number;
  har_misses: number;
  node_fetch_misses: number;
  /** Includes declared_connects */
  declared_exclusion_hits: number;
  /** Denied CONNECTs to declared hosts (requests that bypassed page routing) */
  declared_connects: number;
  fuzzy_matches: number;
  contained_submissions: number;
  websockets_refused: number;
  attempted_egress: number;
  image_misses: number;
  submission_images_substituted: number;
  submission_images_absent: number;
  submission_image_misses: number;
  cache_misses: number;
  tooling_errors: number;
}

export interface SiteReplay {
  site: string;
  engine: string;
  tag: string;
  capture: Pick<SiteCapture, "corpus_version" | "split" | "site_id" | "capture_run_id">;
  page_ids: string[];
  page_order_observed: string[];
  result: EngineRunResult;
  totals: SiteReplayTotals;
  transport: TransportCounters;
  har_merge: MergeStats;
  node_fetch: { served: number; synthetic: number; misses: string[] };
  egress: Array<{ source: string; kind: string; target: string }>;
  miss_urls: string[];
  client: ClientStats;
  image_index_sha256: string;
  engine_data_dir: string;
  predictions: Prediction[];
  normalized: {
    findings: FullFinding[];
    keys: FindingKey[];
    criteria: CriterionStatusRow[];
    coverage: CoverageRow[] | null;
  };
}

/** Image store lookups for a site: allowed model-input bytes and submission images. */
function loadImages(dir: string, capture: SiteCapture): { allowed: Set<string>; submissions: Map<string, { state: string; bytes: Buffer | null }> } {
  const allowed = new Set<string>();
  const submissions = new Map<string, { state: string; bytes: Buffer | null }>();
  for (const page of capture.pages.filter((p) => p.status === "captured")) {
    const pageDir = join(dir, page.page_id);
    for (const e of loadImageIndex(pageDir).entries) {
      if (e.state === "present" && e.sha256) allowed.add(e.sha256);
      if (e.identity.kind === "submission") {
        const bytes = e.state === "present" && e.file ? readFileSync(join(pageDir, e.file)) : null;
        submissions.set(`${page.url}|${e.identity.form_selector}|${e.identity.scenario}`, { state: e.state, bytes });
      }
    }
  }
  return { allowed, submissions };
}

export async function replaySite(options: ReplaySiteOptions): Promise<SiteReplay> {
  const log = options.log ?? (() => {});
  const dir = siteDir(options.paths, options.corpus);
  const capture = loadSiteCapture(options.paths, options.corpus);
  let pages = capture.pages.filter((p) => p.status === "captured").sort((a, b) => a.order - b.order);
  if (options.pages) pages = pages.filter((p) => options.pages!.includes(p.page_id));
  if (pages.length === 0) throw new Error(`No captured pages to replay for ${capture.site_id}`);
  const pageUrls = pages.map((p) => p.url);
  const pageIdByUrl = new Map<string, string>();
  for (const p of capture.pages) {
    pageIdByUrl.set(p.url, p.page_id);
    pageIdByUrl.set(p.final_url, p.page_id);
  }
  const pageIdOf = (url: string) => pageIdByUrl.get(url) ?? `(other:${url.length})`;

  // --- merged HAR -------------------------------------------------------------
  const merged = mergeHars(pages.map((p) => ({ pageId: p.page_id, har: readHar(join(dir, p.page_id, "page.har")) })));
  const harDir = join(options.runDir, "har");
  mkdirSync(harDir, { recursive: true });
  const tag = options.tag ?? options.engine.label;
  const harPath = join(harDir, `${capture.site_id}-${tag}.har`);
  writeHar(harPath, merged.har);
  const fuzzy = new FuzzyIndex(merged.har.log.entries);

  // --- Node fetch record (+ bridge synthetics) --------------------------------
  const records = loadNodeFetchRecords(dir);
  const synthetic = new Map<string, SyntheticResponse>(options.engine.syntheticFetches(capture.root_url, pageUrls));
  if (!options.engine.supportsUrlList) {
    const robotsPath = join(dir, "site", "robots.txt");
    if (existsSync(robotsPath)) {
      const sitemapBody = synthetic.get(fetchKey("GET", `${new URL(capture.root_url).origin}/sitemap.xml`));
      for (const sm of parseRobots(readFileSync(robotsPath, "utf8")).sitemaps) {
        if (sitemapBody) synthetic.set(fetchKey("GET", sm), sitemapBody);
      }
    }
  }
  const fetchEvents: FetchEvent[] = [];
  const fetchMisses: string[] = [];
  const nodeEgress = new EgressLog();
  const images = loadImages(dir, capture);

  const uninstallDenial = installNodeEgressDenial(nodeEgress, options.allowEgress ?? []);
  const uninstallFetch = installFetch(createReplayFetch({
    records,
    loadBody: (sha) => readFileSync(join(dir, "site", "bodies", `${sha}.bin`)),
    synthetic,
    onEvent: (e) => fetchEvents.push(e),
    onMiss: (method, url) => fetchMisses.push(`${method} ${url}`),
  }));

  let controlled: ControlledBrowser | null = null;
  const subs = { substituted: 0, absent: 0, misses: 0 };
  try {
    controlled = await launchControlledBrowser({
      mode: "replay",
      contract: capture.contract,
      harPath,
      fuzzy,
      declaredExclusions: options.declaredExclusions,
      declaredResourceTypes: options.declaredResourceTypes ?? [],
    });

    const client = new EvalAnthropicClient({
      mode: options.client.mode,
      errors: options.engine.errors,
      engineLabel: options.engine.label,
      runId: options.runId,
      cache: options.client.cache,
      injector: options.client.injector,
      live: options.client.live,
      maxCostUsd: options.client.maxCostUsd,
      images: { allowed: images.allowed },
    });
    const runner = buildEvalRunner(options.engine.promptModule, client, options.config.replay.llm_concurrency);

    const submissionStates: SubmissionStatesHook = (pageUrl, form, states) => states.map((state) => {
      const rec = images.submissions.get(`${pageUrl}|${form.selector}|${state.scenario.name}`);
      if (!rec) {
        subs.misses++;
        return { ...state, screenshotAfter: "" };
      }
      if (rec.state === "present" && rec.bytes) {
        subs.substituted++;
        return { ...state, screenshotAfter: rec.bytes.toString("base64") };
      }
      subs.absent++;
      return { ...state, screenshotAfter: "" };
    });

    const engineData = join(options.runDir, "engine-data", `${capture.site_id}-${tag}`);
    // An engine with a page list resolves the recorded site root; one that
    // discovers pages from a sitemap starts its crawl at the first page.
    const rootUrl = options.engine.supportsUrlList ? capture.root_url : pageUrls[0];
    log(`[replay] ${capture.site_id} with ${options.engine.label}: ${pages.length} page(s)`);
    const result = await options.engine.run({
      rootUrl,
      pageUrls,
      dataDir: engineData,
      browser: controlled.browser,
      runner,
      tiers: options.config.replay.tiers,
      pageConcurrency: options.config.replay.page_concurrency,
      llmConcurrency: options.config.replay.llm_concurrency,
      viewport: options.config.replay.viewport,
      submissionStates,
    });

    const failedChecks = (result.coverage?.entries ?? []).filter((e) => e.status === "failed").length;
    const by = controlled.counters.by_decision;
    // Denied CONNECTs to declared hosts (requests that bypassed routing) are declared, not egress
    const declaredConnects = controlled.egress.attempts.filter((a) => a.source === "browser" && a.kind === "connect" && isDeclaredConnect(a.target, options.declaredExclusions)).length;
    const totals: SiteReplayTotals = {
      pages: pages.length,
      har_misses: by.miss,
      node_fetch_misses: fetchMisses.length,
      declared_exclusion_hits: by["declared-exclusion"] + declaredConnects,
      declared_connects: declaredConnects,
      fuzzy_matches: by.fuzzy,
      contained_submissions: by["contained-submission"],
      websockets_refused: by["websocket-blocked"],
      attempted_egress: controlled.egress.count() - declaredConnects + nodeEgress.count(),
      image_misses: client.stats.image_misses + subs.misses,
      submission_images_substituted: subs.substituted,
      submission_images_absent: subs.absent,
      submission_image_misses: subs.misses,
      cache_misses: client.stats.cache_misses,
      tooling_errors: failedChecks + (result.coverage?.crawl_failures.length ?? 0),
    };
    const replay: SiteReplay = {
      site: capture.site_id,
      engine: options.engine.label,
      tag,
      capture: { corpus_version: capture.corpus_version, split: capture.split, site_id: capture.site_id, capture_run_id: capture.capture_run_id },
      page_ids: pages.map((p) => p.page_id),
      page_order_observed: result.pageSnapshots.map((s) => pageIdOf(s.url)),
      result,
      totals,
      transport: controlled.counters,
      har_merge: merged.stats,
      node_fetch: {
        served: fetchEvents.filter((e) => e.decision === "served").length,
        synthetic: fetchEvents.filter((e) => e.decision === "synthetic").length,
        misses: fetchMisses,
      },
      egress: [...controlled.egress.attempts, ...nodeEgress.attempts].map((a) => ({ source: a.source, kind: a.kind, target: a.target })),
      miss_urls: controlled.events.filter((e) => e.decision === "miss").map((e) => e.url),
      client: client.stats,
      image_index_sha256: imageIndexHash(dir, pages),
      engine_data_dir: engineData,
      predictions: buildPredictions(capture.site_id, result.findings, result.pageSnapshots, pageIdOf, CHECK_TIERS),
      normalized: {
        findings: fullFindings(result.findings, result.pageSnapshots, pageIdOf),
        keys: findingKeys(result.findings, result.pageSnapshots, pageIdOf),
        criteria: criterionStatuses(result.criterionResults),
        coverage: coverageRows(result.coverage, pageIdOf),
      },
    };
    writeSiteReplay(options.runDir, replay, controlled);
    return replay;
  } finally {
    uninstallFetch();
    uninstallDenial();
    if (controlled) await controlled.close();
  }
}

/** Private per-site outputs under the run directory. */
function writeSiteReplay(runDir: string, replay: SiteReplay, controlled: ControlledBrowser): void {
  const out = join(runDir, "sites", `${replay.site}-${replay.tag}`);
  mkdirSync(out, { recursive: true });
  writeJson(join(out, "summary.json"), {
    site: replay.site, engine: replay.engine, tag: replay.tag, capture: replay.capture, page_ids: replay.page_ids,
    page_order_observed: replay.page_order_observed, totals: replay.totals, transport: replay.transport,
    har_merge: replay.har_merge, node_fetch: replay.node_fetch, egress: replay.egress, miss_urls: replay.miss_urls.slice(0, 500),
    client: replay.client, image_index_sha256: replay.image_index_sha256, scan_id: replay.result.scanId, warnings: replay.result.warnings,
    engine_data_dir: replay.engine_data_dir,
  });
  writeJson(join(out, "predictions.json"), replay.predictions);
  writeJson(join(out, "findings.full.json"), replay.normalized.findings);
  writeJson(join(out, "findings.keys.json"), replay.normalized.keys);
  writeJson(join(out, "criteria.json"), replay.normalized.criteria);
  writeJson(join(out, "coverage.json"), replay.normalized.coverage);
  writeFileSync(join(out, "transport-events.jsonl"), controlled.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}
