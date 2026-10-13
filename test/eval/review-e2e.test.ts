import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import sharp from "sharp";
import { chromium, type Browser, type Page } from "playwright";
import { startRun } from "../../src/eval/manifest.js";
import { evalPaths, type EvalPaths } from "../../src/eval/paths.js";
import { loadEvalConfig } from "../../src/eval/config.js";
import { hashTree, type SiteCapture } from "../../src/eval/corpus.js";
import { startReviewServer, type ReviewServer } from "../../src/eval/review/server.js";
import { createAudit } from "../../src/eval/review/audit.js";
import { LabelStore, CaseStore, foldLabels } from "../../src/eval/labels.js";
import { paceReport } from "../../src/eval/pace.js";
import { ancestorSignature } from "../../src/eval/review/model.js";
import { sha256, writeJson } from "../../src/eval/util.js";
import type { Prediction } from "../../src/eval/predictions.js";

const REPO = join(import.meta.dirname, "..", "..");
const ORIGIN = "https://www.example-tuning.test";
const NAV = `<nav class="main-nav"><a href="/">Home</a></nav>`;
const pageHtml = (body: string) => `<!doctype html><html><head><title>t</title></head><body><header><p>Header text</p>${NAV}</header><main>${body}</main></body></html>`;
const P1 = pageHtml(`<img class="hero" src="/hero.png" alt="IMG_1.png"><h2 class="empty"></h2><p>Fees <a class="tricky" href="/f">here</a></p><div class="x"><script>window.__pwned=1</script></div>`);
const P2 = pageHtml(`<p>About us. <a class="more" href="/more">More</a></p>`);

let tmp: string;
let paths: EvalPaths;
let runId: string;
let browser: Browser;
const config = loadEvalConfig(join(REPO, "eval", "config.json"));

function pred(page: string, selector: string, html: string, criterion: string, check: string, extra: Partial<Prediction> = {}): Prediction {
  return {
    prediction_key: sha256(`${page}|${selector}|${criterion}`).slice(0, 16), site: "t01", page, criterion, selector, element_html: html,
    html_sha256: sha256(html), failure_type: "ft", check, tier: 3, state: "load", severity: "major", confidence_tier: "high", confidence_score: 0.8,
    detected_by: "claude_api", reasoning: `Engine reasoning for ${selector} <b>not html</b>`, model_image: check === "alt-text", also_found_on: [],
    evidence: { element_screenshot: check === "landmark-labels" ? "scan/el.png" : null, context_screenshot: null, page_screenshot: null }, measured_values: {}, ...extra,
  };
}

async function buildFixture(): Promise<void> {
  tmp = mkdtempSync(join(tmpdir(), "eval-review-e2e-"));
  const repo = join(tmp, "repo");
  mkdirSync(join(repo, "eval"), { recursive: true });
  copyFileSync(join(REPO, "eval", "config.json"), join(repo, "eval", "config.json"));
  paths = evalPaths(repo, join(tmp, "data"));
  const png = await sharp({ create: { width: 64, height: 32, channels: 3, background: { r: 200, g: 50, b: 50 } } }).png().toBuffer();

  // Corpus: one site, two pages
  const site = join(paths.corpusDir, "v-test", "tuning", "t01");
  const pages = [{ id: "p001", url: `${ORIGIN}/`, dom: P1 }, { id: "p002", url: `${ORIGIN}/about`, dom: P2 }];
  for (const p of pages) {
    const d = join(site, p.id);
    mkdirSync(join(d, "images"), { recursive: true });
    writeFileSync(join(d, "dom.html"), p.dom);
    writeFileSync(join(d, "screenshot.png"), png);
    writeJson(join(d, "capture.private.json"), { page_id: p.id });
    const entries = [{
      startedDateTime: "2026-10-12T00:00:00Z", request: { method: "GET", url: p.url },
      response: { status: 200, headers: [{ name: "content-type", value: "text/html" }], content: { text: p.dom, mimeType: "text/html" } },
    }];
    writeJson(join(d, "page.har"), { log: { version: "1.2", creator: { name: "t", version: "1" }, entries } });
    const imgEntries = p.id === "p001" ? [{
      artifact_id: "img-1", corpus_version: "v-test", site: "t01", page: "p001", check: "alt-text", call_site: "x", template: "alt_text_quality",
      identity: { kind: "source", url: `${ORIGIN}/hero.png` }, interaction_step: null, media_type: "image/png", state: "present", sha256: sha256(png), file: "images/img-1.png", error: null, raw: null,
    }] : [];
    if (imgEntries.length) writeFileSync(join(d, "images", "img-1.png"), png);
    writeJson(join(d, "images", "index.json"), { schema_version: 1, entries: imgEntries });
  }
  const capture: SiteCapture = {
    schema_version: 1, corpus_version: "v-test", split: "tuning", site_id: "t01", root_url: `${ORIGIN}/`, final_root_url: `${ORIGIN}/`, passive: false,
    capture_run_id: "capture-x", harness_sha: "a".repeat(40), started_at: "2026-10-12T00:00:00Z", finished_at: "2026-10-12T00:01:00Z",
    user_agent: "WCAGEngine-Eval/0.1 (+https://example.invalid)",
    contract: { viewport: { width: 1024, height: 700, deviceScaleFactor: 1 }, locale: "en-US", timezone: "America/Denver", userAgent: "WCAGEngine-Eval/0.1 (+https://example.invalid)" },
    robots: { source: "absent", sha256: null, group: "none", crawl_delay_seconds: null },
    pages: pages.map((p, i) => ({ page_id: p.id, order: i, url: p.url, final_url: p.url, title: "t", status: "captured" as const, error: null })),
    omissions: [], uncaptured_forms: [], pacing: { min_interval_ms: 3000, top_level_loads: 2, min_observed_gap_ms: {} }, containment: { contained_requests: 0, by_detail: {} }, file_hashes: {},
  };
  capture.file_hashes = hashTree(site, ["site.private.json"]);
  writeJson(join(site, "site.private.json"), capture);

  // A replay run with predictions
  const run = startRun({ command: "replay", argv: ["replay"], purpose: "diagnostic", root: REPO, runsDir: paths.runsDir, repo: { sha: "b".repeat(40), dirty: false, changed_paths: [] } });
  run.manifest.engine = { label: "head", sha: "b".repeat(40), bridge: null };
  run.manifest.corpus = { version: "v-test", split: "tuning", sites: ["t01"], page_set_sha256: "c".repeat(64), artifact_hashes: {}, exclusions: [], declared_exclusions_version: 1 };
  const m = run.finish("completed");
  runId = m.run_id;
  const out = join(run.dir, "sites", "t01-head");
  const engineData = join(run.dir, "engine-data", "t01-head");
  mkdirSync(join(engineData, "scan"), { recursive: true });
  writeFileSync(join(engineData, "scan", "el.png"), png);
  const predictions = [
    pred("p001", "img.hero", `<img class="hero" src="/hero.png" alt="IMG_1.png">`, "1.1.1", "alt-text"),
    pred("p001", "nav.main-nav", NAV, "1.3.1", "landmark-labels"),
    pred("p002", "nav.main-nav", NAV, "1.3.1", "landmark-labels"),
    pred("p002", "a.more", `<a class="more" href="/more">More</a>`, "2.4.4", "link-text"),
    pred("p001", "div.x", `<div class="x"><script>window.__pwned=1</script></div>`, "2.4.6", "headings"),
  ];
  writeJson(join(out, "predictions.json"), predictions);
  writeJson(join(out, "summary.json"), { site: "t01", engine: "head", tag: "head", engine_data_dir: engineData });
  writeJson(join(out, "coverage.json"), ["landmark-labels", "link-text", "headings", "alt-text", "axe-core"].flatMap((check) => ["p001", "p002"].map((page) => ({ check, page, status: "ran", message: null }))));
}

beforeAll(async () => {
  await buildFixture();
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function openUi(server: ReviewServer): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("dialog", (d) => void d.accept());
  await page.goto(server.url);
  return page;
}

const labels = () => new LabelStore(paths.labels).events();
const fold = () => foldLabels(labels());

describe("review screen (D9)", () => {
  it("T, S, F, U, N and Z write the right append-only events and fold correctly", async () => {
    const server = await startReviewServer({ paths, config, mode: "review", reviewer: "paul", runId, batch: "queue", headedReplay: false });
    try {
      const page = await openUi(server);
      await page.waitForSelector("[data-testid=reasoning]");
      expect(await page.textContent("h2")).toContain("1.1.1");
      await page.waitForTimeout(2200);
      await page.keyboard.press("t");
      await page.waitForFunction(() => document.querySelector("h2")?.textContent?.includes("1.3.1"));
      await page.keyboard.press("s");
      await page.keyboard.press("3");
      await page.waitForFunction(() => document.querySelector("h2")?.textContent?.includes("p002") && document.querySelector("h2")?.textContent?.includes("1.3.1"));
      await page.keyboard.press("f");
      await page.waitForFunction(() => document.querySelector("h2")?.textContent?.includes("2.4.4"));
      await page.keyboard.press("u");
      await page.waitForFunction(() => document.querySelector("h2")?.textContent?.includes("2.4.6"));
      const before = labels().length;
      await page.keyboard.press("n");
      await page.waitForTimeout(400);
      expect(labels().length).toBe(before);
      await page.keyboard.press("z");
      await page.waitForTimeout(600);

      const ev = labels();
      expect(ev.map((e) => [e.kind, e.verdict, e.severity_correction])).toEqual([
        ["judgment", "violation", null], ["judgment", "violation", "minor"], ["judgment", "no_violation", null], ["judgment", "unsure", null], ["undo", null, null],
      ]);
      expect(ev[0].prediction_ref?.run_id).toBe(runId);
      expect(ev[0].active_seconds).toBeGreaterThanOrEqual(1);
      expect(ev[4].undoes).toBe(ev[3].label_id);
      const f = fold();
      expect(Array.from(f.values()).map((j) => j.verdict).sort()).toEqual(["no_violation", "violation", "violation"]);
      // Captured HTML is shown as text and never executed
      await page.click("nav button:has-text('p001 · headings')");
      await page.waitForFunction(() => document.querySelector("h2")?.textContent?.includes("2.4.6"));
      expect(await page.textContent("[data-testid=html] mark")).toContain("<script>window.__pwned=1</script>");
      expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
      expect(await page.textContent("[data-testid=reasoning]")).toContain("<b>not html</b>");
    } finally {
      await server.close();
    }
  }, 90_000);

  it("adds ground truth with no finding, requiring a criterion", async () => {
    const server = await startReviewServer({ paths, config, mode: "review", reviewer: "paul", runId, batch: "adhoc", headedReplay: false });
    try {
      const page = await openUi(server);
      await page.waitForSelector("[data-testid=reasoning]");
      await page.click("details.addcase summary");
      const form = page.locator("[data-testid=addcase]");
      await form.locator("[name=page]").fill("p002");
      await form.locator("[name=html]").fill(`<p>About us.`);
      await form.locator("[name=issue]").fill("Paragraph used as a heading");
      await form.locator("[name=criterion]").fill("");
      await form.locator("button[type=submit]").click();
      await page.waitForTimeout(300);
      const casesBefore = new CaseStore(paths.cases).records().length;
      await form.locator("[name=criterion]").fill("1.3.1");
      await form.locator("button[type=submit]").click();
      await page.waitForTimeout(600);
      const cases = new CaseStore(paths.cases).records();
      expect(cases.length).toBe(casesBefore + 1);
      const c = cases[cases.length - 1];
      expect(c.origin).toBe("review");
      expect(c.assertions[0].criterion).toBe("1.3.1");
      expect(labels().at(-1)?.case_id).toBe(c.case_id);
    } finally {
      await server.close();
    }
  }, 60_000);

  it("propagates a structural judgment only after every instance is shown; undo restores the group", async () => {
    const server = await startReviewServer({ paths, config, mode: "review", reviewer: "paul", runId, batch: "adhoc", criterion: "1.3.1", headedReplay: false });
    try {
      const page = await openUi(server);
      await page.waitForSelector("[data-testid=reasoning]");
      await page.click("button:has-text('Propagate')");
      await page.waitForSelector("[data-instance]");
      expect(await page.locator("[data-instance]").count()).toBe(1);
      await page.check("[data-instance]");
      await page.click("button:has-text('Confirm: violation on all checked')");
      await page.waitForTimeout(700);
      const ev = labels().filter((e) => e.propagation_group);
      expect(ev).toHaveLength(2);
      expect(new Set(ev.map((e) => e.propagation_group)).size).toBe(1);
      expect(ev[1].propagation_source).toBeTruthy();
      expect(ev[1].active_seconds).toBe(0);
      await page.keyboard.press("z");
      await page.waitForTimeout(600);
      const group = ev[0].propagation_group!;
      expect(Array.from(fold().values()).some((j) => j.propagation_group === group)).toBe(false);
      // Alt text never propagates, even on identical HTML
      const altItem = `t01:${sha256("p001|img.hero|1.1.1").slice(0, 16)}`;
      const res = await fetch(`${server.url}/api/propagate/propose`, {
        method: "POST", headers: { "content-type": "application/json", "x-eval-token": server.token, origin: server.url }, body: JSON.stringify({ item_id: altItem }),
      });
      expect(((await res.json()) as { eligible: boolean }).eligible).toBe(false);
    } finally {
      await server.close();
    }
  }, 60_000);

  it("opens the target through the offline controlled browser with a toggleable outline", async () => {
    const server = await startReviewServer({ paths, config, mode: "review", reviewer: "paul", runId, batch: "adhoc", criterion: "1.3.1", headedReplay: false });
    try {
      const page = await openUi(server);
      await page.waitForSelector("[data-testid=reasoning]");
      await page.click("button:has-text('Open in replay')");
      await page.waitForFunction(() => document.getElementById("toast")?.textContent?.includes("Opened offline replay"), undefined, { timeout: 20_000 });
      const rp = server.replayPage()!;
      expect(rp.url()).toBe(`${ORIGIN}/`);
      expect(await rp.locator("#__wcag_eval_outline__").isVisible()).toBe(true);
      await page.click("button:has-text('Toggle outline')");
      await page.waitForTimeout(400);
      expect(await rp.locator("#__wcag_eval_outline__").isVisible()).toBe(false);
    } finally {
      await server.close();
    }
  }, 60_000);

  it("protects mutating endpoints: token, origin, host and fetch-site", async () => {
    const server = await startReviewServer({ paths, config, mode: "review", reviewer: "paul", runId, batch: "adhoc", headedReplay: false });
    const port = new URL(server.url).port;
    const post = (headers: Record<string, string>) => new Promise<number>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/api/undo", method: "POST", headers: { "content-type": "application/json", ...headers } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.end("{}");
    });
    try {
      expect(await post({ origin: server.url })).toBe(403);
      expect(await post({ origin: "http://evil.test", "x-eval-token": server.token })).toBe(403);
      expect(await post({ origin: server.url, "x-eval-token": server.token, "sec-fetch-site": "cross-site" })).toBe(403);
      expect(await post({ origin: server.url, "x-eval-token": server.token, host: `localhost:${port}` })).toBe(421);
      expect(await post({ origin: server.url, "x-eval-token": server.token })).toBe(409); // valid, nothing to undo
      const res = await fetch(server.url);
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await server.close();
    }
  }, 30_000);

  it("calibration batches never expose a judge verdict", async () => {
    const server = await startReviewServer({ paths, config, mode: "review", reviewer: "paul", runId, batch: "calibration", headedReplay: false });
    try {
      const state = await (await fetch(`${server.url}/api/state`)).json() as { judge_visible: boolean; items: Array<{ item_id: string }> };
      expect(state.judge_visible).toBe(false);
      const item = await (await fetch(`${server.url}/api/item/${encodeURIComponent(state.items[0].item_id)}`)).json() as Record<string, unknown>;
      expect("judge" in item).toBe(false);
    } finally {
      await server.close();
    }
  }, 30_000);

  it("measures active time: paused while hidden, capped by the 120 s idle rule", async () => {
    const server = await startReviewServer({ paths, config, mode: "review", reviewer: "paul", runId, batch: "adhoc", headedReplay: false });
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.clock.install();
      await page.goto(server.url);
      await page.waitForSelector("[data-testid=reasoning]");
      await page.mouse.move(10, 10);
      await page.clock.runFor(5_000);
      const visible = await page.evaluate(() => (window as unknown as { __evalActiveSeconds: () => number }).__evalActiveSeconds());
      expect(visible).toBeGreaterThanOrEqual(4);
      await page.evaluate(() => Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }));
      await page.clock.runFor(10_000);
      expect(await page.evaluate(() => (window as unknown as { __evalActiveSeconds: () => number }).__evalActiveSeconds())).toBe(visible);
      await page.evaluate(() => Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }));
      await page.clock.runFor(300_000);
      const idleCapped = await page.evaluate(() => (window as unknown as { __evalActiveSeconds: () => number }).__evalActiveSeconds());
      expect(idleCapped).toBeLessThanOrEqual(visible + 121);
      expect(idleCapped).toBeGreaterThan(visible);
      await ctx.close();
    } finally {
      await server.close();
    }
  }, 60_000);
});

describe("independent audit (D9)", () => {
  it("hides engine output until frozen, then reveals matches and misses; post-reveal judgments are separate", async () => {
    const audit = createAudit(paths, { corpusVersion: "v-test", split: "tuning", pages: ["t01/p001", "t01/p002"], criteria: ["1.3.1", "2.4.4"] });
    const server = await startReviewServer({ paths, config, mode: "audit", reviewer: "paul", auditId: audit.audit_id, headedReplay: false });
    try {
      // Blind: no engine data before freezing
      const someItem = encodeURIComponent(`t01:${sha256("p002|a.more|2.4.4").slice(0, 16)}`);
      expect((await fetch(`${server.url}/api/item/${someItem}`)).status).toBe(403);
      const page = await openUi(server);
      await page.waitForSelector("[data-testid=blind]");
      expect(await page.content()).not.toContain("Engine reasoning");

      // Annotate: the nav issue on p002 (engine finds it), a link the engine misses on p001,
      // and a tested negative for 1.3.1 on p001 (the engine flags it: an FP)
      const addCase = async (cellLabel: string, html: string, selector: string, issue: string) => {
        await page.click(`nav button:has-text('${cellLabel}')`);
        await page.click("details.addcase summary");
        const form = page.locator("[data-testid=addcase]");
        await form.locator("[name=selector]").fill(selector);
        await form.locator("[name=html]").fill(html);
        await form.locator("[name=issue]").fill(issue);
        await form.locator("button[type=submit]").click();
        await page.waitForTimeout(500);
      };
      await addCase("t01/p002 · 1.3.1", NAV, "nav.main-nav", "Second navigation landmark has no label");
      await addCase("t01/p001 · 2.4.4", `<a class="tricky" href="/f">here</a>`, "a.tricky", "Link text 'here' gives no purpose");
      await page.click("nav button:has-text('t01/p001 · 1.3.1')");
      await page.click("[data-testid=negative]");
      await page.waitForTimeout(400);
      for (const label of ["t01/p001 · 1.3.1", "t01/p002 · 1.3.1", "t01/p001 · 2.4.4"]) {
        await page.click(`nav button:has-text('${label}')`);
        await page.click("[data-status=complete]");
        await page.waitForTimeout(250);
      }
      const pre = labels().filter((e) => e.phase === "pre_reveal");
      expect(pre.length).toBe(3);

      await page.click("[data-testid=freeze]");
      await page.waitForSelector("[data-testid=reveal]");
      await page.fill("#run", runId);
      await page.click("[data-testid=reveal]");
      await page.waitForSelector("[data-testid=misses]");
      const misses = await page.textContent("[data-testid=misses]");
      expect(misses).toContain("1 miss(es)");
      expect(misses).toContain("2.4.4 t01/p001");
      const outcomes = await page.locator("[data-testid=outcomes] td:nth-child(4)").allTextContents();
      expect(outcomes.sort()).toEqual(["FN", "FP", "TP"]);
      // Engine-only finding judged after reveal
      await page.locator("[data-testid=engine-only] button:has-text('F no violation')").first().click();
      await page.waitForTimeout(500);
      const post = labels().filter((e) => e.phase === "post_reveal");
      expect(post.length).toBe(1);
      expect(post[0].verdict).toBe("no_violation");
    } finally {
      await server.close();
    }
  }, 120_000);
});

describe("propagation context", () => {
  it("ancestor signatures ignore page-specific content around a repeated component", () => {
    const at1 = P1.indexOf(NAV);
    const at2 = P2.indexOf(NAV);
    expect(ancestorSignature(P1, at1)).toEqual(["html", "body", "header"]);
    expect(ancestorSignature(P1, at1)).toEqual(ancestorSignature(P2, at2));
    const nested = '<div id="a" class="y x"><img src=x><br/><!-- <p> --><script>"<div>"</script><section><p>t</p><span>';
    expect(ancestorSignature(nested, nested.length)).toEqual(["div#a.x.y", "section", "span"]);
  });
});

describe("pace", () => {
  it("reports counts, median and p90 by criterion and batch", () => {
    const r = paceReport(paths);
    expect(r.labels).toBeGreaterThan(0);
    expect(r.overall.timed).toBeGreaterThan(0);
    expect(Object.keys(r.by_batch)).toEqual(expect.arrayContaining(["queue", "audit"]));
    expect(r.fit_150_minutes).toBeNull(); // fewer than 14 days of labels
    const later = paceReport(paths, new Date(Date.now() + 15 * 86_400_000));
    expect(later.fit_150_minutes === null || later.fit_150_minutes > 0).toBe(true);
  });
});
