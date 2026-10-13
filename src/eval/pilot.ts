import http from "node:http";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Page } from "playwright";
import { setupRequestInterception } from "../checks/forms/submission.js";
import { startFixtureServer, PILOT_TELEMETRY_HOST, type FixtureServer } from "./pilot/fixture-server.js";
import { captureSite, contractFor, userAgentFor, type CaptureResult } from "./capture.js";
import { verifySite, loadSiteCapture, siteDir } from "./corpus.js";
import { launchControlledBrowser, type ControlledBrowser } from "./transport/browser.js";
import { EgressLog, installNodeEgressDenial } from "./transport/egress.js";
import { originalFetch } from "./transport/node-fetch.js";
import { mergeHars, readHar, writeHar, FuzzyIndex } from "./transport/har.js";
import { replaySite, type SiteReplay } from "./replay.js";
import { headEngine } from "./engine/head.js";
import { legacyEngine, BASELINE_SHA, baselineCompatibleOrder } from "./engine/legacy.js";
import type { EngineHandle } from "./engine/types.js";
import { deterministicInjector } from "./model/injector.js";
import { EvalAnthropicClient } from "./model/client.js";
import { buildEvalRunner } from "./model/runner.js";
import { ResponseCache } from "./model/cache.js";
import { multisetDiff, fullFindings, criterionStatuses, coverageRows } from "./normalize.js";
import type { EvalConfig } from "./config.js";
import { evalPaths, type EvalPaths } from "./paths.js";
import type { RunHandle } from "./manifest.js";
import { writeJson } from "./util.js";

// ---------------------------------------------------------------------------
// D0 pilot: everything is local (fixture server, injected model responses).
// It proves, for HEAD and for the baseline through the bridge, that every
// context, page, reload, popup, Node fetch and model call goes through the
// transport boundary; that nothing escapes offline replay; that submissions
// are contained; that misses and egress are detected; and that the default
// path is unchanged (invariant 2).
// ---------------------------------------------------------------------------

export const PILOT_SITE = "x01";
export const PRE_HARNESS_SHA = "5d7a46777178ef67dd715e4bf2dd249f4c9fc182";

export interface PilotOptions {
  paths: EvalPaths;
  config: EvalConfig;
  run: RunHandle;
  fixtureDir: string;
  /** Skip the slow parts (baseline build, equivalence) */
  include: { baseline: boolean; equivalence: boolean };
  log: (message: string) => void;
}

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

const CLEAN_PAGES = ["p001", "p002", "p003"];
const TRAP_PAGE = "p004";

export async function runPilot(options: PilotOptions): Promise<{ checks: Check[]; evidence: Record<string, unknown> }> {
  const { config, run, log } = options;
  // The pilot's corpus and site registry live inside its run directory: the
  // fixture's port changes every run, and synthetic pages must never enter
  // the real site registry. Engines still come from the shared worktrees.
  const paths = evalPaths(options.paths.repo, join(run.dir, "pilot-data"));
  const checks: Check[] = [];
  const evidence: Record<string, unknown> = {};
  const check = (name: string, pass: boolean, detail: string) => {
    checks.push({ name, pass, detail });
    log(`[pilot] ${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };
  const version = `pilot-${run.manifest.run_id.split("-").slice(-2).join("-")}`;
  const contactUrl = "https://example.invalid/wcag-eval-pilot";
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY; // the collect and replay paths must not depend on a key

  let fixture: FixtureServer | null = await startFixtureServer(options.fixtureDir);
  try {
    // --- 1. capture under containment -------------------------------------
    const urls = ["/", "/contact", "/about", "/trap"].map((p) => `${fixture!.siteOrigin}${p === "/" ? "/" : p}`);
    const ordered = baselineCompatibleOrder(urls, `${fixture.siteOrigin}/`);
    const capture: CaptureResult = await captureSite({
      paths, config, version, split: "pilot", siteId: PILOT_SITE, rootUrl: `${fixture.siteOrigin}/`, urls: ordered,
      contactUrl, runId: run.manifest.run_id, harnessSha: run.manifest.harness.sha, paceSeconds: 0.5,
      hostMap: fixture.hostMap, launchArgs: [fixture.hostResolverArg], log,
    });
    if (!capture.capture) throw new Error(`pilot capture skipped: ${capture.skipped}`);
    const ref = { version, split: "pilot" as const, siteId: PILOT_SITE };
    evidence.capture = {
      version, pages: capture.capture.pages.map((p) => ({ id: p.page_id, status: p.status })),
      containment: capture.capture.containment, pacing: capture.capture.pacing, collected: capture.collected,
      uncaptured_forms: capture.capture.uncaptured_forms.length, node_fetches: capture.nodeFetches,
    };
    check("capture: all pilot pages captured", capture.capture.pages.every((p) => p.status === "captured"), capture.capture.pages.map((p) => `${p.page_id}:${p.status}`).join(" "));
    check("capture: no submission endpoint reached during capture", fixture.submissionHits().length === 0, `${fixture.submissionHits().length} hit(s) ${fixture.submissionHits().map((h) => `${h.method} ${h.path}`).join(", ")}`);
    const gaps = Object.values(capture.capture.pacing.min_observed_gap_ms);
    check("capture: top-level loads paced", gaps.every((g) => g >= 480 || !Number.isFinite(g)), `min gap ${Math.min(...gaps)} ms over ${capture.capture.pacing.top_level_loads} loads (interval 500 ms)`);
    check("capture: robots.txt fetched and applied before the URL list", capture.capture.robots.source === "parsed", `group ${capture.capture.robots.group}`);
    check("request collection reaches the alt-text image provider without model calls", capture.collected.alt_text_with_image > 0, `${capture.collected.alt_text_with_image} alt-text request(s) with image, ${capture.collected.alt_text_without_image} without; no API key set`);
    check("request collection reaches submission images without model calls", capture.collected.error_message_with_image > 0, `${capture.collected.error_message_with_image} error-message request(s) with screenshot`);
    const verify = verifySite(paths, ref);
    check("verify-corpus: checksums and artifacts", verify.problems.length === 0, `${verify.files} files, ${verify.images} image entries, ${verify.problems.length} problem(s)`);

    // --- 2. containment probe, live fixture ---------------------------------
    const contract = contractFor(config, userAgentFor(config, contactUrl));
    const liveProbe = await containmentProbe(await launchControlledBrowser({ mode: "capture", contract, launchArgs: [fixture.hostResolverArg] }), fixture.siteOrigin);
    evidence.containment_live = liveProbe;
    check("containment (live): GET form navigation, POST navigation, fetch, XHR and beacon blocked", liveProbe.allContained && fixture.submissionHits().length === 0, `${JSON.stringify(liveProbe.byPath)}; server submission hits ${fixture.submissionHits().length}`);
    check("containment (live): normal page loads still work", liveProbe.normalLoadOk, `about page status ${liveProbe.normalLoadStatus}`);

    // The fixture goes away: everything below is offline
    await fixture.close();
    fixture = null;

    // --- 3. replay-mode boundary probes -----------------------------------
    const dir = siteDir(paths, ref);
    const site = loadSiteCapture(paths, ref);
    const cleanPages = site.pages.filter((p) => CLEAN_PAGES.includes(p.page_id));
    const merged = mergeHars(cleanPages.map((p) => ({ pageId: p.page_id, har: readHar(join(dir, p.page_id, "page.har")) })));
    const probeDir = join(run.dir, "probe");
    const probeHar = join(probeDir, "probe.har");
    writeHar(probeHar, merged.har);
    const replayBrowser = await launchControlledBrowser({ mode: "replay", contract: site.contract, harPath: probeHar, fuzzy: new FuzzyIndex(merged.har.log.entries), declaredExclusions: [] });
    const offline = await offlineProbe(replayBrowser, site.root_url);
    evidence.replay_probe = offline;
    check("replay: submissions contained against the HAR", offline.containment.allContained, JSON.stringify(offline.containment.byPath));
    check("replay: engine interceptor's route.continue() falls back to the HAR, not the network", offline.wrappedContinue.servedFromHar && offline.wrappedContinue.egress === 0, JSON.stringify(offline.wrappedContinue));
    check("replay: an unwrapped route.continue() is caught by the deny proxy", offline.rawContinue.egress > 0, JSON.stringify(offline.rawContinue));
    check("replay: a context created outside the boundary is caught by the deny proxy", offline.rawContext.egress > 0, JSON.stringify(offline.rawContext));
    check("replay: reloads and popups go through the boundary", offline.reloadOk && offline.popupServed, `reload ${offline.reloadOk}, popup ${offline.popupServed}`);
    check("replay: service workers blocked in eval contexts", /fail|unavailable/.test(offline.serviceWorker), offline.serviceWorker);
    check("replay: WebSockets refused", offline.websocketRefused > 0, `${offline.websocketRefused} refused`);

    // Node egress, including a swallowed error
    const nodeLog = new EgressLog();
    const release = installNodeEgressDenial(nodeLog);
    try {
      await new Promise<void>((resolve) => {
        const req = http.get("http://127.0.0.1:9/should-not-connect", () => resolve());
        req.on("error", () => resolve());
      });
      await originalFetch()("http://198.51.100.7/also-denied").catch(() => {});
    } finally {
      release();
    }
    evidence.node_egress = nodeLog.attempts;
    check("Node egress denied and recorded even when the caller swallows the error", nodeLog.count() >= 2, nodeLog.attempts.map((a) => `${a.kind} ${a.target}`).join(", "));

    // --- 4. engines --------------------------------------------------------
    const engines: EngineHandle[] = [headEngine(run.manifest.harness.sha)];
    if (options.include.baseline) {
      engines.push(await legacyEngine({ paths: options.paths, sha: BASELINE_SHA, label: "baseline", patchPath: join(options.paths.baselineBridgeDir, "ffdcd30.patch"), supportsUrlList: false, log }));
    }
    const pilotExclusions = [PILOT_TELEMETRY_HOST];
    const replays: Record<string, SiteReplay> = {};
    for (const engine of engines) {
      const clean = await replaySite({ paths, config, corpus: ref, engine, client: { mode: "inject", injector: deterministicInjector }, runId: run.manifest.run_id, runDir: run.dir, declaredExclusions: pilotExclusions, pages: CLEAN_PAGES, tag: `${engine.label}-clean`, log });
      replays[`${engine.label}-clean`] = clean;
      const t = clean.totals;
      check(`${engine.label}: clean replay is offline and complete`, t.har_misses === 0 && t.node_fetch_misses === 0 && t.attempted_egress === 0 && t.image_misses === 0 && t.cache_misses === 0,
        `pages ${t.pages}, HAR misses ${t.har_misses}, Node fetch misses ${t.node_fetch_misses}, egress ${t.attempted_egress}, image misses ${t.image_misses}, findings ${clean.result.findings.length}, model requests ${clean.client.requests}`);
      check(`${engine.label}: page order matches the frozen order`, JSON.stringify(clean.page_order_observed) === JSON.stringify(clean.page_ids), `${clean.page_order_observed.join(",")} vs ${clean.page_ids.join(",")}`);
      check(`${engine.label}: every context and page went through the boundary`, clean.transport.contexts > 0 && clean.transport.pages > 0 && clean.transport.cdp_failed === 0,
        `contexts ${clean.transport.contexts}, pages ${clean.transport.pages}, popups ${clean.transport.popups}, CDP attached ${clean.transport.cdp_attached}`);
      check(`${engine.label}: model calls went through the eval client`, clean.client.requests > 0, `${clean.client.requests} requests (${clean.client.vision_requests} with image, ${clean.client.no_image_requests} without): ${JSON.stringify(clean.client.by_template)}`);

      const trap = await replaySite({ paths, config, corpus: ref, engine, client: { mode: "inject", injector: deterministicInjector }, runId: run.manifest.run_id, runDir: run.dir, declaredExclusions: pilotExclusions, pages: [TRAP_PAGE], tag: `${engine.label}-trap`, log });
      replays[`${engine.label}-trap`] = trap;
      check(`${engine.label}: trap page misses are detected`, trap.totals.har_misses > 0, `HAR misses ${trap.totals.har_misses} (${trap.miss_urls.slice(0, 3).map((u) => new URL(u).pathname).join(", ")})`);
      check(`${engine.label}: declared exclusion counted separately from misses`, trap.totals.declared_exclusion_hits > 0, `declared ${trap.totals.declared_exclusion_hits}`);
      check(`${engine.label}: trap WebSocket refused without egress`, trap.totals.websockets_refused > 0 && trap.totals.attempted_egress === 0, `refused ${trap.totals.websockets_refused}, egress ${trap.totals.attempted_egress}`);
      if (engine.label === "head") {
        check("head: unrecorded Node image fetch on the trap page is a miss", trap.totals.node_fetch_misses > 0, `Node fetch misses ${trap.totals.node_fetch_misses}`);
      }
    }

    // Images: HEAD sends recorded production inputs; the baseline sends none for alt text
    const headClean = replays["head-clean"];
    check("head: submission images come from the image store", headClean.totals.submission_images_substituted > 0 && headClean.totals.submission_image_misses === 0,
      `substituted ${headClean.totals.submission_images_substituted}, absent ${headClean.totals.submission_images_absent}, misses ${headClean.totals.submission_image_misses}`);
    if (replays["baseline-clean"]) {
      const b = replays["baseline-clean"];
      check("baseline: alt-text requests stay no-image (never given HEAD images)", (b.client.vision_by_template.alt_text_quality ?? 0) === 0 && (b.client.by_template.alt_text_quality ?? 0) > 0,
        `baseline alt-text requests ${b.client.by_template.alt_text_quality ?? 0}, with image ${b.client.vision_by_template.alt_text_quality ?? 0}; HEAD alt-text with image ${headClean.client.vision_by_template.alt_text_quality ?? 0}`);
      const shared = Object.keys(b.client.template_hashes).filter((t) => headClean.client.template_hashes[t] === b.client.template_hashes[t]);
      evidence.template_hashes = { head: headClean.client.template_hashes, baseline: b.client.template_hashes, identical: shared };
    }

    // Replay-rendered screenshots never reach the model: hook off → image misses
    const noHook: EngineHandle = { ...engines[0], label: "head-nohook", run: (o) => engines[0].run({ ...o, submissionStates: undefined }) };
    const unsafe = await replaySite({ paths, config, corpus: ref, engine: noHook, client: { mode: "inject", injector: deterministicInjector }, runId: run.manifest.run_id, runDir: run.dir, declaredExclusions: pilotExclusions, pages: ["p002"], tag: "head-nohook", log });
    check("a replay-rendered screenshot is refused at the model boundary", unsafe.totals.image_misses > 0, `image misses ${unsafe.totals.image_misses}`);

    // Cache: replay never falls back to live; a miss is counted
    const emptyCache = new ResponseCache(mkdtempSync(join(tmpdir(), "eval-pilot-cache-")), "empty");
    const cacheMiss = await replaySite({ paths, config, corpus: ref, engine: engines[0], client: { mode: "replay", cache: emptyCache }, runId: run.manifest.run_id, runDir: run.dir, declaredExclusions: pilotExclusions, pages: ["p003"], tag: "head-cachemiss", log });
    check("replay: a missing cached response is a counted miss, not a live call", cacheMiss.totals.cache_misses > 0, `cache misses ${cacheMiss.totals.cache_misses}`);
    rmSync(emptyCache.dir, { recursive: true, force: true });

    evidence.replays = Object.fromEntries(Object.entries(replays).map(([k, r]) => [k, { totals: r.totals, transport: r.transport, client: { requests: r.client.requests, by_template: r.client.by_template, vision: r.client.vision_requests }, findings: r.result.findings.length }]));

    // --- 5. default-path equivalence (invariant 2) --------------------------
    if (options.include.equivalence) {
      const eq = await defaultPathEquivalence(options);
      evidence.equivalence = eq.summary;
      check("default path unchanged: findings, criterion statuses and coverage identical (pre-harness vs current, eval off)", eq.identical, eq.detail);
    }
  } finally {
    if (fixture) await fixture.close();
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
  }
  writeJson(join(run.dir, "pilot-checks.json"), { checks, evidence });
  return { checks, evidence };
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

interface ContainmentProbe {
  byPath: Record<string, number>;
  allContained: boolean;
  normalLoadOk: boolean;
  normalLoadStatus: number | null;
}

async function containmentProbe(controlled: ControlledBrowser, origin: string): Promise<ContainmentProbe> {
  try {
    const ctx = await controlled.browser.newContext();
    const page = await ctx.newPage();
    const count = () => controlled.events.filter((e) => e.decision === "contained-submission").length;
    const byPath: Record<string, number> = {};
    const attempt = async (name: string, fn: () => Promise<unknown>) => {
      const before = count();
      await fn().catch(() => {});
      await page.waitForTimeout(400);
      byPath[name] = count() - before;
    };
    await page.goto(`${origin}/`, { waitUntil: "load" });
    await attempt("get-form-click", async () => { await page.fill("#q", "trail"); await page.click("#search button"); });
    await page.goto(`${origin}/`, { waitUntil: "load" });
    await attempt("get-form-submit()", () => page.evaluate(() => (document.getElementById("search") as HTMLFormElement).submit()));
    await page.goto(`${origin}/contact`, { waitUntil: "load" });
    await attempt("post-form-navigation", async () => { await page.fill("#addr", "1 Main St"); await page.click("#legacy button"); });
    await page.goto(`${origin}/contact`, { waitUntil: "load" });
    await attempt("fetch-and-xhr", async () => { await page.fill("#nl-email", "a@b.test"); await page.click("#newsletter button"); });
    await attempt("beacon", () => page.evaluate(() => navigator.sendBeacon("/api/beacon", "x")));
    const res = await page.goto(`${origin}/about`, { waitUntil: "load" }).catch(() => null);
    await ctx.close();
    return {
      byPath,
      allContained: byPath["get-form-click"] >= 1 && byPath["get-form-submit()"] >= 1 && byPath["post-form-navigation"] >= 1 && byPath["fetch-and-xhr"] >= 2 && byPath["beacon"] >= 1,
      normalLoadOk: res?.status() === 200,
      normalLoadStatus: res?.status() ?? null,
    };
  } finally {
    await controlled.close();
  }
}

async function offlineProbe(controlled: ControlledBrowser, root: string) {
  try {
    const origin = new URL(root).origin;
    const containment = await (async () => {
      const ctx = await controlled.browser.newContext();
      const page = await ctx.newPage();
      const count = () => controlled.events.filter((e) => e.decision === "contained-submission").length;
      const byPath: Record<string, number> = {};
      const attempt = async (name: string, fn: () => Promise<unknown>) => {
        const before = count();
        await fn().catch(() => {});
        await page.waitForTimeout(400);
        byPath[name] = count() - before;
      };
      await page.goto(`${origin}/`, { waitUntil: "load" });
      await attempt("get-form-click", async () => { await page.fill("#q", "trail"); await page.click("#search button"); });
      await page.goto(`${origin}/contact`, { waitUntil: "load" });
      await attempt("post-form-navigation", async () => { await page.fill("#addr", "1 Main St"); await page.click("#legacy button"); });
      await page.goto(`${origin}/contact`, { waitUntil: "load" });
      await attempt("fetch-and-xhr", async () => { await page.fill("#nl-email", "a@b.test"); await page.click("#newsletter button"); });
      await ctx.close();
      return { byPath, allContained: byPath["get-form-click"] >= 1 && byPath["post-form-navigation"] >= 1 && byPath["fetch-and-xhr"] >= 2 };
    })();

    // The engine's own interceptor on a wrapped page: continue() → HAR
    const wrappedContinue = await (async () => {
      const ctx = await controlled.browser.newContext();
      const page = await ctx.newPage();
      const egressBefore = controlled.egress.count();
      const harBefore = controlled.counters.by_decision.har;
      await setupRequestInterception(page);
      const res = await page.goto(`${origin}/about`, { waitUntil: "load" }).catch(() => null);
      await page.waitForTimeout(300);
      await ctx.close();
      return { status: res?.status() ?? null, servedFromHar: (res?.status() ?? 0) === 200 && controlled.counters.by_decision.har > harBefore, egress: controlled.egress.count() - egressBefore };
    })();

    // Negative control: the same interceptor on the raw page bypasses routing
    const rawContinue = await (async () => {
      const ctx = await controlled.browser.newContext();
      const wrapped = await ctx.newPage();
      const raw = await rawOf(wrapped);
      const egressBefore = controlled.egress.count();
      await raw.route("**/*", (route) => route.continue());
      await raw.goto(`${origin}/about`, { waitUntil: "load", timeout: 5_000 }).catch(() => null);
      await ctx.close();
      return { egress: controlled.egress.count() - egressBefore };
    })();

    // A context created outside the boundary (no routes at all)
    const rawContext = await (async () => {
      const ctx = await controlled.raw.newContext();
      const page = await ctx.newPage();
      const egressBefore = controlled.egress.count();
      await page.goto(`${origin}/`, { timeout: 5_000 }).catch(() => null);
      await page.evaluate((o) => { try { new WebSocket(o.replace("http", "ws") + "/ws"); } catch { /* refused */ } }, origin).catch(() => {});
      await page.waitForTimeout(500);
      await ctx.close();
      return { egress: controlled.egress.count() - egressBefore };
    })();

    // Reload, popup, service worker, WebSocket through the boundary
    const ctx = await controlled.browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${origin}/`, { waitUntil: "load" });
    const reload = await page.reload({ waitUntil: "load" }).catch(() => null);
    const popupPromise = ctx.waitForEvent("page", { timeout: 5_000 }).catch(() => null);
    await page.evaluate(() => { window.open("/about", "_blank"); });
    const popup = await popupPromise;
    let popupServed = false;
    if (popup) {
      await popup.waitForLoadState("load").catch(() => {});
      popupServed = (await popup.content()).includes("About the department");
    }
    await page.waitForTimeout(500);
    const serviceWorker = String(await page.evaluate(() => (window as unknown as { __swState?: string }).__swState ?? "unknown"));
    const wsBefore = controlled.counters.by_decision["websocket-blocked"];
    await page.evaluate((o) => { try { new WebSocket(o.replace("http", "ws") + "/socket"); } catch { /* refused */ } }, origin);
    await page.waitForTimeout(300);
    const websocketRefused = controlled.counters.by_decision["websocket-blocked"] - wsBefore;
    await ctx.close();
    return { containment, wrappedContinue, rawContinue, rawContext, reloadOk: reload?.status() === 200, popupServed, serviceWorker, websocketRefused };
  } finally {
    await controlled.close();
  }
}

/** The unwrapped page behind an engine-facing wrapper (negative controls only). */
async function rawOf(wrapped: Page): Promise<Page> {
  const ctxPages = wrapped.context().pages();
  return ctxPages[ctxPages.length - 1];
}

// ---------------------------------------------------------------------------
// Invariant 2: with eval off, the pre-harness SHA and the current code
// produce identical normalised output on the local fixture.
// ---------------------------------------------------------------------------

async function defaultPathEquivalence(options: PilotOptions): Promise<{ identical: boolean; detail: string; summary: Record<string, unknown> }> {
  const { paths, config, log } = options;
  const fixture = await startFixtureServer(options.fixtureDir);
  // Default path: real chromium.launch, live fixture, no controlled browser,
  // no eval hooks. The fixture hosts resolve through an HTTP-level host map
  // the default path cannot use, so this check serves the clean pages from
  // 127.0.0.1 (their {{CDN}} links point at a host that does not resolve,
  // identically for both engines).
  const origin = `http://127.0.0.1:${fixture.port}`;
  const urls = [`${origin}/`, `${origin}/contact`, `${origin}/about`];
  const pageIdOf = (u: string) => ({ [`${origin}/`]: "p001", [`${origin}/contact`]: "p002", [`${origin}/about`]: "p003" } as Record<string, string>)[u] ?? u;
  const tmp = mkdtempSync(join(tmpdir(), "eval-equivalence-"));
  try {
    const engines: EngineHandle[] = [
      await legacyEngine({ paths, sha: PRE_HARNESS_SHA, label: "pre-harness", patchPath: null, supportsUrlList: true, log }),
      headEngine(options.run.manifest.harness.sha, "current"),
    ];
    const outputs: Array<{ label: string; findings: unknown[]; criteria: unknown[]; coverage: unknown[] | null }> = [];
    for (const engine of engines) {
      const client = new EvalAnthropicClient({ mode: "inject", errors: engine.errors, engineLabel: engine.label, runId: options.run.manifest.run_id, injector: deterministicInjector });
      const runner = buildEvalRunner(engine.promptModule, client, config.replay.llm_concurrency);
      log(`[pilot] equivalence: ${engine.label}`);
      const result = await engine.run({
        rootUrl: urls[0], pageUrls: urls, dataDir: join(tmp, engine.label), runner,
        tiers: config.replay.tiers, pageConcurrency: 1, llmConcurrency: config.replay.llm_concurrency, viewport: config.replay.viewport,
      });
      outputs.push({
        label: engine.label,
        findings: fullFindings(result.findings, result.pageSnapshots, pageIdOf),
        criteria: criterionStatuses(result.criterionResults),
        coverage: coverageRows(result.coverage, pageIdOf),
      });
    }
    const [a, b] = outputs;
    const f = multisetDiff(a.findings, b.findings);
    const c = multisetDiff(a.criteria, b.criteria);
    const v = multisetDiff(a.coverage ?? [], b.coverage ?? []);
    const identical = f.onlyA.length + f.onlyB.length + c.onlyA.length + c.onlyB.length + v.onlyA.length + v.onlyB.length === 0;
    writeJson(join(options.run.dir, "equivalence.json"), { outputs, diff: { findings: f, criteria: c, coverage: v } });
    return {
      identical,
      detail: `findings ${a.findings.length} vs ${b.findings.length} (diff ${f.onlyA.length}/${f.onlyB.length}), criteria ${a.criteria.length} (diff ${c.onlyA.length}/${c.onlyB.length}), coverage ${a.coverage?.length ?? 0} (diff ${v.onlyA.length}/${v.onlyB.length})`,
      summary: { findings: a.findings.length, criteria: a.criteria.length, coverage: a.coverage?.length ?? 0, diff: { findings: [f.onlyA.length, f.onlyB.length], criteria: [c.onlyA.length, c.onlyB.length], coverage: [v.onlyA.length, v.onlyB.length] } },
    };
  } finally {
    await fixture.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}
