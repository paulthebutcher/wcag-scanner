import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadManifest, type RunManifest } from "../manifest.js";
import { loadImageIndex, loadSiteCapture, siteDir, type ImageIndexEntry, type SiteCapture, type Split } from "../corpus.js";
import type { Prediction } from "../predictions.js";
import type { EvalPaths } from "../paths.js";
import type { CaseRecord, FoldedJudgment, LabelEvent, Batch } from "../labels.js";
import { readJson, sha256 } from "../util.js";

// ---------------------------------------------------------------------------
// Review data: a run's predictions joined with the frozen corpus (captured
// DOM, screenshots, model-input images) and the current labels. Everything
// here is private and only ever served to the local review screen.
// ---------------------------------------------------------------------------

export type AssetKind = "model_input" | "element_crop" | "context_crop" | "page_capture";

export interface Asset {
  kind: AssetKind;
  label: string;
  path: string;
}

export interface ReviewItem {
  item_id: string;
  site: string;
  page: string;
  page_url: string;
  criterion: string;
  prediction: Prediction;
  assets: Asset[];
  html_context: { before: string; element: string; after: string; found: boolean };
  context_sha256: string | null;
}

export interface RunReviewData {
  manifest: RunManifest;
  runDir: string;
  version: string;
  split: Split;
  sites: Map<string, { capture: SiteCapture; dir: string; engineData: string; replayDir: string }>;
  items: ReviewItem[];
}

const CONTEXT_CHARS = 700;

export function htmlContext(dom: string, elementHtml: string): ReviewItem["html_context"] {
  const at = elementHtml ? dom.indexOf(elementHtml) : -1;
  if (at === -1) return { before: "", element: elementHtml, after: "", found: false };
  return {
    before: dom.slice(Math.max(0, at - CONTEXT_CHARS), at),
    element: elementHtml,
    after: dom.slice(at + elementHtml.length, at + elementHtml.length + CONTEXT_CHARS),
    found: true,
  };
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

/**
 * The element's ancestor chain (tag, id and sorted classes of each open
 * element before it), read from the captured markup with a tolerant tag
 * stack. Two instances of a repeated component (a site-wide nav) share it;
 * page-specific content around them does not affect it.
 */
export function ancestorSignature(dom: string, index: number): string[] {
  const stack: string[] = [];
  const re = /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(dom)) !== null && m.index < index) {
    if (m[0].startsWith("<!--") || m[1]) continue;
    const tag = m[3].toLowerCase();
    if (m[2] === "/") {
      const at = stack.map((x) => x.split(/[.#]/)[0]).lastIndexOf(tag);
      if (at !== -1) stack.length = at;
      continue;
    }
    if (VOID.has(tag) || /\/\s*$/.test(m[4])) continue;
    const id = m[4].match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1];
    const cls = (m[4].match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1] ?? "").split(/\s+/).filter(Boolean).sort().join(".");
    stack.push(`${tag}${id ? `#${id}` : ""}${cls ? `.${cls}` : ""}`);
  }
  return stack;
}

/** Context identity for propagation: the element's ancestor chain in the captured DOM. */
export function contextHash(dom: string, elementHtml: string): string | null {
  const at = elementHtml ? dom.indexOf(elementHtml) : -1;
  if (at === -1) return null;
  return sha256(ancestorSignature(dom, at).join(" > "));
}

function srcOf(html: string): string | null {
  const m = html.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
  return m ? m[1] : null;
}

/** The recorded model-input image for a prediction, if it had one. */
export function modelInputFor(p: Prediction, pageUrl: string, index: ImageIndexEntry[]): ImageIndexEntry | null {
  if (p.check === "alt-text" || p.criterion === "1.1.1") {
    const src = srcOf(p.element_html);
    if (!src) return null;
    let resolved = src;
    try { resolved = new URL(src, pageUrl).href; } catch { /* keep */ }
    return index.find((e) => e.check === "alt-text" && e.identity.kind === "source" && e.identity.url === resolved && e.state === "present") ?? null;
  }
  if (p.check === "error-messages") {
    const scenario = typeof p.measured_values.scenario === "string" ? p.measured_values.scenario : null;
    return index.find((e) => e.check === "error-messages" && e.identity.kind === "submission" && e.state === "present" &&
      (scenario === null || e.identity.scenario === scenario) && (p.selector.includes(e.identity.form_selector) || e.identity.form_selector === p.selector)) ?? null;
  }
  return null;
}

/** The first replay of each site in a run (a repeat run's r1). */
function replayDirs(runDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const sitesDir = join(runDir, "sites");
  if (!existsSync(sitesDir)) return out;
  for (const name of readdirSync(sitesDir).sort()) {
    const summary = join(sitesDir, name, "summary.json");
    if (!existsSync(summary)) continue;
    const s = readJson<{ site: string; tag: string }>(summary);
    if (!out.has(s.site) || /-r1$/.test(s.tag)) out.set(s.site, join(sitesDir, name));
  }
  return out;
}

export function loadRunReview(paths: EvalPaths, runId: string): RunReviewData {
  const manifest = loadManifest(paths.runsDir, runId);
  if (!manifest.corpus) throw new Error(`Run ${runId} has no corpus (not a replay run)`);
  if (manifest.corpus.split === "holdout") throw new Error("Holdout runs are sealed and cannot be reviewed in Phase 1");
  const runDir = join(paths.runsDir, runId);
  const sites = new Map<string, { capture: SiteCapture; dir: string; engineData: string; replayDir: string }>();
  const items: ReviewItem[] = [];
  for (const [siteId, dir] of replayDirs(runDir)) {
    const ref = { version: manifest.corpus.version, split: manifest.corpus.split as Split, siteId };
    const capture = loadSiteCapture(paths, ref);
    const cdir = siteDir(paths, ref);
    const summary = readJson<{ engine_data_dir: string }>(join(dir, "summary.json"));
    sites.set(siteId, { capture, dir: cdir, engineData: summary.engine_data_dir, replayDir: dir });
    const predictions = readJson<Prediction[]>(join(dir, "predictions.json"));
    const pageById = new Map(capture.pages.map((p) => [p.page_id, p]));
    const domCache = new Map<string, string>();
    const indexCache = new Map<string, ImageIndexEntry[]>();
    for (const p of predictions) {
      const page = pageById.get(p.page);
      if (!page) continue;
      const pageDir = join(cdir, p.page);
      if (!domCache.has(p.page)) domCache.set(p.page, existsSync(join(pageDir, "dom.html")) ? readFileSync(join(pageDir, "dom.html"), "utf8") : "");
      if (!indexCache.has(p.page)) indexCache.set(p.page, loadImageIndex(pageDir).entries);
      const ctx = htmlContext(domCache.get(p.page)!, p.element_html);
      const assets: Asset[] = [];
      const mi = modelInputFor(p, page.url, indexCache.get(p.page)!);
      if (mi?.file) assets.push({ kind: "model_input", label: "Model input image (recorded at capture; the exact bytes the model received)", path: join(pageDir, mi.file) });
      if (p.evidence.element_screenshot) assets.push({ kind: "element_crop", label: "Element crop (rendered during replay)", path: join(summary.engine_data_dir, p.evidence.element_screenshot) });
      if (p.evidence.context_screenshot) assets.push({ kind: "context_crop", label: "Context crop (rendered during replay)", path: join(summary.engine_data_dir, p.evidence.context_screenshot) });
      assets.push({ kind: "page_capture", label: "Full-page screenshot (captured; target position not recorded, use Open in replay)", path: join(pageDir, "screenshot.png") });
      items.push({
        item_id: `${siteId}:${p.prediction_key}`,
        site: siteId, page: p.page, page_url: page.url, criterion: p.criterion, prediction: p,
        assets: assets.filter((a) => existsSync(a.path)), html_context: ctx, context_sha256: contextHash(domCache.get(p.page)!, p.element_html),
      });
    }
  }
  items.sort((a, b) => a.criterion.localeCompare(b.criterion, undefined, { numeric: true }) || a.site.localeCompare(b.site) || a.page.localeCompare(b.page) || a.prediction.selector.localeCompare(b.prediction.selector));
  return { manifest, runDir, version: manifest.corpus.version, split: manifest.corpus.split as Split, sites, items };
}

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

/** A judge verdict may be shown only outside calibration batches (no judge exists yet). */
export function judgeVisible(batch: Batch): boolean {
  return batch !== "calibration";
}

function seededOrder<T>(items: T[], seed: string, key: (t: T) => string): T[] {
  return [...items].sort((a, b) => sha256(`${seed}|${key(a)}`).localeCompare(sha256(`${seed}|${key(b)}`)));
}

export interface BatchContext {
  items: ReviewItem[];
  cases: CaseRecord[];
  judgments: Map<string, FoldedJudgment>;
  batch: Batch;
  criterion?: string;
  seed: string;
  calibrationSize?: number;
}

/** Find the case (and assertion) a prediction is about, if one exists. */
export function caseFor(item: ReviewItem, cases: CaseRecord[]): { c: CaseRecord; assertionId: string | null } | null {
  for (const c of cases) {
    if (c.site !== item.site || c.page !== item.page) continue;
    const t = c.target;
    if (t.state !== null && t.state !== item.prediction.state) continue;
    const sel = t.selector !== null && t.selector === item.prediction.selector;
    const html = t.html_sha256 !== null && t.html_sha256 === item.prediction.html_sha256;
    if (sel && (html || t.html_sha256 === null)) {
      const a = c.assertions.find((x) => x.criterion === item.criterion);
      return { c, assertionId: a?.assertion_id ?? null };
    }
  }
  return null;
}

export function batchItems(ctx: BatchContext): ReviewItem[] {
  let pool = ctx.criterion ? ctx.items.filter((i) => i.criterion === ctx.criterion) : ctx.items;
  const judged = (i: ReviewItem) => {
    const link = caseFor(i, ctx.cases);
    return Boolean(link?.assertionId && ctx.judgments.has(`${link.c.case_id}|${link.assertionId}`));
  };
  switch (ctx.batch) {
    case "queue":
      pool = pool.filter((i) => !judged(i));
      break;
    case "anchor":
      pool = pool.filter(judged);
      break;
    case "calibration": {
      // Stratified by criterion, deterministic for a seed
      const byCrit = new Map<string, ReviewItem[]>();
      for (const i of pool) byCrit.set(i.criterion, [...(byCrit.get(i.criterion) ?? []), i]);
      const per = Math.max(1, Math.ceil((ctx.calibrationSize ?? 20) / Math.max(1, byCrit.size)));
      pool = Array.from(byCrit.values()).flatMap((list) => seededOrder(list, ctx.seed, (i) => i.item_id).slice(0, per)).slice(0, ctx.calibrationSize ?? 20);
      break;
    }
    case "adhoc":
    case "audit":
      break;
  }
  // Items batch by criterion
  return pool.sort((a, b) => a.criterion.localeCompare(b.criterion, undefined, { numeric: true }) || a.item_id.localeCompare(b.item_id));
}

export function historyFor(events: LabelEvent[], caseId: string, assertionId: string): Array<{ label_id: string; kind: string; verdict: string | null; severity: string | null; reviewer: string; at: string; batch: string; phase: string | null }> {
  return events
    .filter((e) => (e.case_id === caseId && e.assertion_id === assertionId) || (e.kind === "undo"))
    .filter((e) => e.kind === "judgment" || events.some((x) => x.label_id === e.undoes && x.case_id === caseId && x.assertion_id === assertionId))
    .map((e) => ({ label_id: e.label_id, kind: e.kind, verdict: e.verdict, severity: e.severity_correction, reviewer: e.reviewer, at: e.timestamp, batch: e.batch, phase: e.phase }));
}
