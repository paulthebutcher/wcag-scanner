import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";
import type { PageSnapshot } from "../types.js";
import { normalizeUrl } from "../core/crawler.js";
import { createPromptRunner, type PromptRunner } from "../core/prompt-runner.js";
import { runAxeChecks } from "../checks/automated/index.js";
import { runKeyboardChecks, runTrapChecks } from "../checks/behavioral/keyboard.js";
import { runFocusVisibleChecks } from "../checks/behavioral/focus-visible.js";
import { runSkipNavChecks } from "../checks/behavioral/skip-nav.js";
import { runModalChecks } from "../checks/behavioral/modal.js";
import { discoverForms, formFingerprint } from "../checks/forms/discovery.js";
import { countVisibleFields, testFormSubmission } from "../checks/forms/submission.js";
import { evaluateErrorMessages, evaluateInputPurpose } from "../checks/forms/error-evaluation.js";
import { evaluateHighRiskForms } from "../checks/forms/high-risk.js";
import { checkOnInput } from "../checks/indicators/on-input.js";
import { runAltTextChecks } from "../checks/semantic/alt-text.js";
import { createImageFetcher } from "../checks/semantic/image-fetch.js";
import { launchControlledBrowser, type BrowserContract, type ControlledBrowser, type TransportEvent } from "./transport/browser.js";
import { createCaptureFetch, fetchKey, installFetch, type NodeFetchRecord } from "./transport/node-fetch.js";
import { Pacer } from "./transport/pacer.js";
import { decideRobots, isAllowed as robotsAllow, type RobotsFetchOutcome, type RobotsPolicy } from "./robots.js";
import { EvalAnthropicClient, type CollectedRequest } from "./model/client.js";
import { buildEvalRunner } from "./model/runner.js";
import {
  hashTree, identityKey, registerSite, siteDir,
  type CorpusPage, type ImageIndexEntry, type SiteCapture, type Split,
} from "./corpus.js";
import type { EvalPaths } from "./paths.js";
import type { EvalConfig } from "./config.js";
import { sha256, writeJson, writeOnce } from "./util.js";

// ---------------------------------------------------------------------------
// D1 capture. Per page, in a recording context of its own:
//   1. load (load event, capped network idle, settle), DOM and screenshot
//   2. (not holdout) HEAD's own interaction paths under submission
//      containment: axe, the behavioral checks on a fresh load, and each
//      unique form's submission and on-input tests, so the HAR holds what
//      those interactions request
//   3. (not holdout) the model-input candidate paths with request collection
//      on and model calls off: alt-text images through the production
//      fetcher, error-message screenshots from the submission states
// Results of these checks are thrown away; only artifacts are kept.
// ---------------------------------------------------------------------------

export interface CaptureSiteOptions {
  paths: EvalPaths;
  config: EvalConfig;
  version: string;
  split: Split;
  siteId: string;
  rootUrl: string;
  urls: string[];
  contactUrl: string;
  runId: string;
  harnessSha: string;
  /** Override the configured pacing (pilot and tests only) */
  paceSeconds?: number;
  /** Pilot only: map fixture hostnames to the local server */
  hostMap?: Record<string, string>;
  launchArgs?: string[];
  log?: (message: string) => void;
}

export interface CaptureResult {
  skipped: string | null;
  capture: SiteCapture | null;
  nodeFetches: number;
  collected: { alt_text_with_image: number; alt_text_without_image: number; error_message_with_image: number; high_risk_without_image: number; total: number };
  events: TransportEvent[];
  egressAttempts: number;
}

interface InteractionLog {
  step: string;
  started_at: string;
  ms: number;
  outcome: "ok" | "error" | "skipped";
  detail?: string;
}

const ALT_TEXT_CALL_SITE = "checks/semantic/image-fetch.ts createImageFetcher";
const SUBMISSION_CALL_SITE = "checks/forms/submission.ts testFormSubmission screenshotAfter";

export function userAgentFor(config: EvalConfig, contactUrl: string): string {
  if (!/^https?:\/\/\S+$/.test(contactUrl)) throw new Error("EVAL_CONTACT_URL must be an http(s) URL");
  return config.capture.user_agent_template.replace("{EVAL_CONTACT_URL}", contactUrl);
}

export function contractFor(config: EvalConfig, userAgent: string): BrowserContract {
  return { viewport: config.replay.viewport, locale: config.replay.locale, timezone: config.replay.timezone, userAgent };
}

export async function captureSite(options: CaptureSiteOptions): Promise<CaptureResult> {
  const log = options.log ?? (() => {});
  const passive = options.split === "holdout";
  const urls = Array.from(new Set(options.urls.map((u) => normalizeUrl(u, u)).filter((u): u is string => u !== null)));
  if (urls.length > options.config.capture.max_pages_per_site) {
    throw new Error(`${urls.length} pages requested; the limit is ${options.config.capture.max_pages_per_site} per site`);
  }
  const rootUrl = normalizeUrl(options.rootUrl, options.rootUrl);
  if (!rootUrl) throw new Error(`Invalid root URL`);
  const site = registerSite(options.paths, { siteId: options.siteId, rootUrl, split: options.split, urls });
  const pageIds = new Map(site.pages.map((p) => [p.url, p.page_id]));

  const finalDir = siteDir(options.paths, { version: options.version, split: options.split, siteId: options.siteId });
  if (existsSync(finalDir)) throw new Error(`Corpus ${options.version}/${options.split}/${options.siteId} already exists; captures are immutable (use a new version)`);
  const staging = `${finalDir}.staging-${options.runId}`;
  mkdirSync(join(staging, "site", "bodies"), { recursive: true });

  const userAgent = userAgentFor(options.config, options.contactUrl);
  const contract = contractFor(options.config, userAgent);
  const paceMs = (options.paceSeconds ?? options.config.capture.min_seconds_between_top_level_loads) * 1000;
  const pacer = new Pacer(paceMs);
  const siteHost = new URL(rootUrl).host;
  const startedAt = new Date().toISOString();

  // --- Node fetch boundary --------------------------------------------------
  const fetchRecords: NodeFetchRecord[] = [];
  let purpose = "other";
  const uninstallFetch = installFetch(createCaptureFetch({
    userAgent,
    beforeTopLevel: (url) => pacer.beforeTopLevel(url),
    isTopLevel: () => purpose === "robots" || purpose === "root-redirect",
    hostMap: options.hostMap,
    storeBody: (body) => {
      const sha = sha256(body);
      writeOnce(join(staging, "site", "bodies", `${sha}.bin`), body);
      return sha;
    },
    onRecord: (r) => fetchRecords.push(r),
    purposeOf: () => purpose,
    allowed: (url) => (robotsPolicy && new URL(url).host === siteHost ? robotsAllow(robotsPolicy, url) : true),
  }));

  let robotsPolicy: RobotsPolicy | null = null;
  let controlled: ControlledBrowser | null = null;
  const collected: CaptureResult["collected"] = { alt_text_with_image: 0, alt_text_without_image: 0, error_message_with_image: 0, high_risk_without_image: 0, total: 0 };

  try {
    // --- robots.txt (URL lists do not bypass it) -----------------------------
    purpose = "robots";
    const robotsUrl = `${new URL(rootUrl).origin}/robots.txt`;
    let outcome: RobotsFetchOutcome;
    let robotsText: string | null = null;
    try {
      const res = await fetch(robotsUrl);
      robotsText = await res.text();
      outcome = res.ok ? { kind: "ok", status: res.status, body: robotsText } : { kind: "http-error", status: res.status };
    } catch (err) {
      outcome = { kind: "network-error", error: err instanceof Error ? err.message : String(err) };
    }
    const decision = decideRobots(outcome);
    if (!decision.usable) {
      log(`[capture] ${options.siteId}: skipped — ${decision.reason}`);
      rmSync(staging, { recursive: true, force: true });
      return { skipped: decision.reason, capture: null, nodeFetches: fetchRecords.length, collected, events: [], egressAttempts: 0 };
    }
    robotsPolicy = decision.policy;
    if (robotsText !== null && outcome.kind === "ok") writeFileSync(join(staging, "site", "robots.txt"), robotsText);
    if (robotsPolicy.crawlDelaySeconds) pacer.setCrawlDelay(siteHost, robotsPolicy.crawlDelaySeconds);

    // --- root redirect (the HEAD crawler resolves it with Node fetch) --------
    purpose = "root-redirect";
    let finalRoot = rootUrl;
    try {
      const res = await fetch(rootUrl, { redirect: "follow" });
      await res.arrayBuffer().catch(() => {});
      finalRoot = res.url || rootUrl;
    } catch {
      // recorded as an error; replay reproduces it
    }
    purpose = "other";

    controlled = await launchControlledBrowser({
      mode: "capture",
      contract,
      pacer,
      isAllowed: (url) => {
        try {
          return new URL(url).host !== siteHost || robotsAllow(robotsPolicy!, url);
        } catch {
          return true;
        }
      },
      launchArgs: options.launchArgs,
    });

    const collectClient = new EvalAnthropicClient({
      mode: "collect",
      errors: Anthropic,
      engineLabel: "head-capture",
      runId: options.runId,
      onCollect: (req: CollectedRequest) => {
        collected.total++;
        if (req.template === "alt_text_quality") {
          if (req.image_sha256) collected.alt_text_with_image++;
          else collected.alt_text_without_image++;
        }
        if (req.template === "error_message_quality" && req.image_sha256) collected.error_message_with_image++;
        if (req.template === "high_risk_form_detection" && !req.image_sha256) collected.high_risk_without_image++;
      },
    });
    const collectRunner = buildEvalRunner<PromptRunner>({ createPromptRunner }, collectClient, options.config.replay.llm_concurrency);

    const pages: CorpusPage[] = [];
    const omissions: SiteCapture["omissions"] = [];
    const uncapturedForms: SiteCapture["uncaptured_forms"] = [];
    const testedForms = new Set<string>();

    for (const [order, url] of urls.entries()) {
      const pageId = pageIds.get(url)!;
      if (!robotsAllow(robotsPolicy, url)) {
        omissions.push({ url, reason: "disallowed by robots.txt" });
        log(`[capture] ${options.siteId}/${pageId}: omitted (robots)`);
        continue;
      }
      log(`[capture] ${options.siteId}/${pageId} (${order + 1}/${urls.length})`);
      const page = await capturePage({
        controlled, pageId, url, order, dir: join(staging, pageId), passive, options, collectRunner,
        testedForms, uncapturedForms, fetchRecords, setPurpose: (p) => { purpose = p; },
      });
      pages.push(page);
    }

    writeJson(join(staging, "site", "node-fetch.json"), fetchRecords);
    const contained = controlled.events.filter((e) => e.decision === "contained-submission");
    const byDetail: Record<string, number> = {};
    for (const e of contained) byDetail[e.detail ?? "unknown"] = (byDetail[e.detail ?? "unknown"] ?? 0) + 1;

    const capture: SiteCapture = {
      schema_version: 1,
      corpus_version: options.version,
      split: options.split,
      site_id: options.siteId,
      root_url: rootUrl,
      final_root_url: normalizeUrl(finalRoot, finalRoot) ?? rootUrl,
      passive,
      capture_run_id: options.runId,
      harness_sha: options.harnessSha,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      user_agent: userAgent,
      contract,
      robots: {
        source: robotsPolicy.source,
        sha256: robotsText !== null && outcome.kind === "ok" ? sha256(robotsText) : null,
        group: robotsPolicy.group,
        crawl_delay_seconds: robotsPolicy.crawlDelaySeconds,
      },
      pages,
      omissions,
      uncaptured_forms: uncapturedForms,
      pacing: { min_interval_ms: pacer.intervalFor(siteHost), top_level_loads: pacer.log.length, min_observed_gap_ms: pacer.minObservedGapMs() },
      containment: { contained_requests: contained.length, by_detail: byDetail },
      file_hashes: {},
    };
    const events = controlled.events.slice();
    const egressAttempts = controlled.egress.count();
    await controlled.close();
    controlled = null;

    capture.file_hashes = hashTree(staging, ["site.private.json"]);
    writeJson(join(staging, "site.private.json"), capture);
    mkdirSync(join(finalDir, ".."), { recursive: true });
    renameSync(staging, finalDir);
    return { skipped: null, capture, nodeFetches: fetchRecords.length, collected, events, egressAttempts };
  } finally {
    uninstallFetch();
    if (controlled) await controlled.close();
  }
}

// ---------------------------------------------------------------------------
// One page
// ---------------------------------------------------------------------------

interface CapturePageInput {
  controlled: ControlledBrowser;
  pageId: string;
  url: string;
  order: number;
  dir: string;
  passive: boolean;
  options: CaptureSiteOptions;
  collectRunner: PromptRunner;
  testedForms: Set<string>;
  uncapturedForms: SiteCapture["uncaptured_forms"];
  fetchRecords: NodeFetchRecord[];
  setPurpose: (purpose: string) => void;
}

async function capturePage(input: CapturePageInput): Promise<CorpusPage> {
  const { controlled, pageId, url, dir, options } = input;
  mkdirSync(join(dir, "images"), { recursive: true });
  const interactions: InteractionLog[] = [];
  const images: ImageIndexEntry[] = [];
  const imageKeys = new Set<string>();
  const readiness = options.config.capture.readiness;
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    const started = Date.now();
    const startedAt = new Date().toISOString();
    try {
      const value = await fn();
      interactions.push({ step: name, started_at: startedAt, ms: Date.now() - started, outcome: "ok" });
      return value;
    } catch (err) {
      interactions.push({ step: name, started_at: startedAt, ms: Date.now() - started, outcome: "error", detail: (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 300) });
      return undefined;
    }
  };
  const addImage = (entry: Omit<ImageIndexEntry, "artifact_id" | "corpus_version" | "site" | "page" | "file">, bytes: Buffer | null): void => {
    const key = identityKey(entry);
    if (imageKeys.has(key)) {
      // The same identity seen twice must have produced the same bytes
      const prior = images.find((i) => identityKey(i) === key)!;
      if (prior.sha256 !== entry.sha256 || prior.state !== entry.state) throw new Error(`conflicting image record for ${entry.check} ${entry.identity.kind}`);
      return;
    }
    imageKeys.add(key);
    const artifact = bytes ? `img-${sha256(bytes).slice(0, 16)}` : `none-${sha256(key).slice(0, 16)}`;
    const file = bytes ? join("images", `${artifact}.png`) : null;
    if (bytes && file) writeOnce(join(dir, file), bytes);
    images.push({ ...entry, artifact_id: artifact, corpus_version: options.version, site: options.siteId, page: pageId, file });
  };

  const ctx = await controlled.browser.newContext({ recordHar: { path: join(dir, "page.har"), content: "embed", mode: "full" } });
  // The same tooling shim the scanner adds to its own contexts: functions
  // serialised into page.evaluate may reference esbuild's __name helper.
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((fn) => fn);" });
  const ctxEventStart = controlled.events.length;
  const milestones: Record<string, unknown> = {};
  let finalUrl = url;
  let title = "";
  let dom = "";
  let status: CorpusPage["status"] = "captured";
  let error: string | null = null;

  try {
    // 1. load, snapshot
    const page = await ctx.newPage();
    const t0 = Date.now();
    await page.goto(url, { waitUntil: readiness.wait_until, timeout: 30_000 });
    milestones.load_ms = Date.now() - t0;
    milestones.network_idle = await page.waitForLoadState("networkidle", { timeout: readiness.network_idle_cap_ms }).then(() => "reached", () => "capped");
    milestones.idle_ms = Date.now() - t0;
    await page.waitForTimeout(readiness.settle_ms);
    milestones.ready_ms = Date.now() - t0;
    finalUrl = page.url();
    title = await page.title();
    dom = await page.content();
    writeFileSync(join(dir, "dom.html"), dom);
    writeFileSync(join(dir, "screenshot.png"), await page.screenshot({ fullPage: true }));

    if (!input.passive) {
      // 2a. axe (alt text skips images axe already flagged)
      const flagged = new Set<string>();
      await step("axe-core", async () => {
        const axe = await runAxeChecks(page, `capture-${options.runId}`);
        for (const v of axe.violations) flagged.add(v.element_selector);
      });
      await page.close().catch(() => {});

      // 2b. behavioral checks on a fresh load, as the scanner does
      await step("behavioral", async () => {
        const bpage = await ctx.newPage();
        try {
          await bpage.goto(url, { waitUntil: "load", timeout: 30_000 });
          await bpage.screenshot({ fullPage: true });
          const keyboard = await step("keyboard", () => runKeyboardChecks(bpage));
          if (keyboard) await step("focus-visible", () => runFocusVisibleChecks(bpage, keyboard.tabSequence));
          await step("keyboard-trap", () => runTrapChecks(bpage));
          await step("skip-nav", () => runSkipNavChecks(bpage));
          await step("modal", () => runModalChecks(bpage));
        } finally {
          await bpage.close().catch(() => {});
        }
      });

      // 2c. forms: each unique form once (first page it appears on)
      const snapshot: PageSnapshot = {
        id: pageId, scan_session_id: "capture", url, title, captured_at: new Date().toISOString(), full_dom: dom, screenshot: "",
        viewport: options.config.replay.viewport,
      };
      const forms = (await step("form-discovery", async () => discoverForms(snapshot))) ?? [];
      await step("high-risk-forms (collect)", () => evaluateHighRiskForms(forms, input.collectRunner));
      for (const form of forms) {
        const fp = formFingerprint(form);
        if (input.testedForms.has(fp)) continue;
        input.testedForms.add(fp);
        await step(`input-purpose (collect) ${form.selector}`, () => evaluateInputPurpose(form, input.collectRunner));
        await step(`form ${form.selector}`, async () => {
          const fpage: Page = await ctx.newPage();
          fpage.setDefaultTimeout(5_000);
          try {
            await fpage.goto(url, { waitUntil: "load", timeout: 30_000 });
            await fpage.screenshot({ fullPage: true });
            if (!controlled.isTracked(fpage)) {
              input.uncapturedForms.push({ page_id: pageId, form_selector: form.selector, reason: "submission navigations cannot be told apart on this page (no CDP session)" });
              return;
            }
            if ((await countVisibleFields(fpage, form)) === 0) {
              interactions.push({ step: `form ${form.selector}`, started_at: new Date().toISOString(), ms: 0, outcome: "skipped", detail: "no visible fields at page load" });
              return;
            }
            const { states } = await testFormSubmission(fpage, form);
            for (const state of states) {
              const bytes = state.screenshotAfter ? Buffer.from(state.screenshotAfter, "base64") : null;
              addImage({
                check: "error-messages",
                call_site: SUBMISSION_CALL_SITE,
                template: "error_message_quality",
                identity: { kind: "submission", form_selector: form.selector, form_fingerprint: fp, scenario: state.scenario.name },
                interaction_step: `form:${form.selector}/scenario:${state.scenario.name}`,
                media_type: "image/png",
                state: bytes ? "present" : "absent_by_design",
                sha256: bytes ? sha256(bytes) : null,
                error: null,
                raw: null,
              }, bytes);
            }
            await step(`error-messages (collect) ${form.selector}`, () => evaluateErrorMessages(states, input.collectRunner));
            await step(`on-input ${form.selector}`, () => checkOnInput(fpage, form));
          } finally {
            await fpage.close().catch(() => {});
          }
        });
      }

      // 3. alt-text images through the production fetcher
      input.setPurpose("image");
      const fetcher = createImageFetcher();
      await step("alt-text (collect)", () => runAltTextChecks(dom, input.collectRunner, {
        axeFlaggedSelectors: flagged,
        imageProvider: async (img) => {
          const before = input.fetchRecords.length;
          const b64 = await fetcher(img.src, url);
          let resolved = img.src;
          try { resolved = img.src.startsWith("data:") ? `data:sha256:${sha256(img.src)}` : new URL(img.src, url).href; } catch { /* keep raw */ }
          const fetchRec = input.fetchRecords.slice(before).find((r) => r.url === resolved) ?? input.fetchRecords.find((r) => r.url === resolved) ?? null;
          const bytes = b64 ? Buffer.from(b64, "base64") : null;
          addImage({
            check: "alt-text",
            call_site: ALT_TEXT_CALL_SITE,
            template: "alt_text_quality",
            identity: { kind: "source", url: resolved },
            interaction_step: null,
            media_type: "image/png",
            state: bytes ? "present" : (!img.src.trim() || (!fetchRec && !img.src.startsWith("data:")) ? "absent_by_design" : "unavailable_at_capture"),
            sha256: bytes ? sha256(bytes) : null,
            error: bytes ? null : (fetchRec?.error ?? (fetchRec ? `HTTP ${fetchRec.status} or undecodable image` : null)),
            raw: fetchRec ? { node_fetch_key: fetchKey(fetchRec.method, fetchRec.url), body_sha256: fetchRec.body_sha256, status: fetchRec.outcome === "response" ? fetchRec.status : null } : null,
          }, bytes);
          return b64;
        },
      }));
      input.setPurpose("other");
    }
  } catch (err) {
    status = "failed";
    error = (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 300);
  } finally {
    await ctx.close().catch(() => {});
  }

  const events = controlled.events.slice(ctxEventStart);
  writeJson(join(dir, "images", "index.json"), { schema_version: 1, entries: images });
  writeJson(join(dir, "capture.private.json"), {
    schema_version: 1,
    page_id: pageId,
    source_url: url,
    final_url: finalUrl,
    title,
    status,
    error,
    captured_at: new Date().toISOString(),
    versions: { harness_sha: options.harnessSha, browser: controlled.browserVersion },
    viewport: options.config.replay.viewport,
    locale: options.config.replay.locale,
    timezone: options.config.replay.timezone,
    readiness: { ...readiness, ...milestones },
    interactions,
    requests: events,
    contained_submissions: events.filter((e) => e.decision === "contained-submission").length,
  });
  return { page_id: pageId, order: input.order, url, final_url: normalizeUrl(finalUrl, finalUrl) ?? finalUrl, title, status, error };
}
