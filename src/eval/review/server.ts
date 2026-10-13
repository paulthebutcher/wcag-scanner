import http from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Page } from "playwright";
import { CaseStore, LabelStore, foldLabels, type Batch, type CaseRecord, type LabelInput, type LabelVerdict, type Severity } from "../labels.js";
import { matchCases, coverageMap } from "../matcher.js";
import { launchControlledBrowser, type ControlledBrowser } from "../transport/browser.js";
import { mergeHars, readHar, writeHar, FuzzyIndex } from "../transport/har.js";
import { loadSiteCapture, siteDir, type Split } from "../corpus.js";
import type { EvalConfig } from "../config.js";
import type { EvalPaths } from "../paths.js";
import type { Prediction } from "../predictions.js";
import { readJson, sha256 } from "../util.js";
import { batchItems, caseFor, historyFor, judgeVisible, loadRunReview, contextHash, type ReviewItem, type RunReviewData } from "./model.js";
import { cellKey, loadAudit, saveAudit, type AuditCellStatus, type AuditSession } from "./audit.js";
import { renderApp } from "./app.js";

// ---------------------------------------------------------------------------
// Local review and audit server (D9). Bound to 127.0.0.1; requests must name
// that host (no DNS rebinding); mutating endpoints need the per-session
// token and a same-origin Origin; responses carry a strict CSP and no CORS
// headers; captured HTML is only ever returned as data and rendered as text.
// "Open in replay" drives the controlled browser offline.
// ---------------------------------------------------------------------------

export interface ReviewServerOptions {
  paths: EvalPaths;
  config: EvalConfig;
  mode: "review" | "audit";
  reviewer: string;
  runId?: string;
  batch?: Batch;
  criterion?: string;
  auditId?: string;
  /** Show the replay browser window (false in tests) */
  headedReplay: boolean;
  port?: number;
  log?: (m: string) => void;
}

export interface ReviewServer {
  url: string;
  token: string;
  close(): Promise<void>;
  /** Test hook: the page currently shown in the replay browser */
  replayPage(): Page | null;
}

/** Structural judgments may propagate; never alt text or link purpose on identical HTML alone. */
const NON_PROPAGATING_CRITERIA = new Set(["1.1.1", "2.4.4"]);

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function startReviewServer(options: ReviewServerOptions): Promise<ReviewServer> {
  const { paths, config } = options;
  const log = options.log ?? (() => {});
  const token = randomBytes(24).toString("hex");
  const nonce = () => randomBytes(16).toString("base64");
  const cases = new CaseStore(paths.cases);
  const labels = new LabelStore(paths.labels);
  mkdirSync(paths.evalDir, { recursive: true });

  let audit: AuditSession | null = options.mode === "audit" ? loadAudit(paths, options.auditId!) : null;
  let data: RunReviewData | null = options.mode === "review" ? loadRunReview(paths, options.runId!) : null;
  const batch: Batch = options.mode === "audit" ? "audit" : options.batch ?? "queue";
  const undoStack: Array<{ labelIds: string[]; group: string | null }> = [];
  let replay: { browser: ControlledBrowser; site: string; page: Page | null; outline: boolean } | null = null;

  const judgments = () => foldLabels(labels.events());
  const currentCases = () => Array.from(cases.current().values());
  const items = (): ReviewItem[] => (data ? batchItems({ items: data.items, cases: currentCases(), judgments: judgments(), batch, criterion: options.criterion, seed: data.manifest.run_id }) : []);
  const itemById = (id: string): ReviewItem => {
    const item = data?.items.find((i) => i.item_id === id);
    if (!item) throw new HttpError(404, "no such item");
    return item;
  };

  // --- cases and labels -------------------------------------------------
  const ensureAssertion = (c: CaseRecord, criterion: string, issue: string): { c: CaseRecord; assertionId: string } => {
    const existing = c.assertions.find((a) => a.criterion === criterion);
    if (existing) return { c, assertionId: existing.assertion_id };
    const next = `A${c.assertions.length + 1}`;
    const revised = cases.revise(c.case_id, { assertions: [...c.assertions, { assertion_id: next, criterion, issue, failure_type: null }] }, `assertion for ${criterion} added during ${batch}`, options.reviewer);
    return { c: revised, assertionId: next };
  };

  const caseForItem = (item: ReviewItem, criterion: string): { c: CaseRecord; assertionId: string } => {
    const link = caseFor(item, currentCases());
    const issue = `${item.prediction.failure_type ?? "engine finding"} (${item.prediction.check ?? "unknown check"})`;
    if (link) return ensureAssertion(link.c, criterion, issue);
    const c = cases.create({
      created_by: options.reviewer, site: item.site, page: item.page, corpus_version: data!.version, unit: item.prediction.state === "load" ? "element" : "interaction",
      target: { selector: item.prediction.selector, html: item.prediction.element_html.slice(0, 4000), html_sha256: item.prediction.html_sha256, context_sha256: item.context_sha256, state: item.prediction.state },
      assertions: [{ assertion_id: "A1", criterion, issue, failure_type: item.prediction.failure_type }],
      origin: "review", propagation_group: null, evidence_refs: [`${data!.manifest.run_id}:${item.prediction.prediction_key}`], source_seed_id: null,
    });
    return { c, assertionId: "A1" };
  };

  const labelInput = (caseId: string, assertionId: string, verdict: LabelVerdict, extra: Partial<LabelInput>): LabelInput => ({
    kind: "judgment", case_id: caseId, assertion_id: assertionId, verdict, severity_correction: null, reviewer: options.reviewer, batch,
    phase: audit ? (audit.status === "annotating" ? "pre_reveal" : "post_reveal") : null,
    active_seconds: null, propagation_group: null, propagation_source: null, undoes: null, prediction_ref: null, note: null, ...extra,
  });

  // --- replay viewer --------------------------------------------------------
  const openReplay = async (site: string, pageId: string, selector: string | null): Promise<{ opened: boolean; found: boolean }> => {
    const version = data?.version ?? audit!.corpus_version;
    const split = (data?.split ?? audit!.split) as Split;
    const ref = { version, split, siteId: site };
    const capture = loadSiteCapture(paths, ref);
    const page = capture.pages.find((p) => p.page_id === pageId);
    if (!page) throw new HttpError(404, "page not in corpus");
    if (!replay || replay.site !== site) {
      if (replay) await replay.browser.close();
      const dir = siteDir(paths, ref);
      const pages = capture.pages.filter((p) => p.status === "captured");
      const merged = mergeHars(pages.map((p) => ({ pageId: p.page_id, har: readHar(join(dir, p.page_id, "page.har")) })));
      const harPath = join(paths.dataDir, "eval-review", `${site}-${version}.har`);
      mkdirSync(join(paths.dataDir, "eval-review"), { recursive: true });
      writeHar(harPath, merged.har);
      const browser = await launchControlledBrowser({
        mode: "replay", contract: capture.contract, harPath, fuzzy: new FuzzyIndex(merged.har.log.entries),
        declaredExclusions: config.declared_exclusions.host_suffixes, headless: !options.headedReplay,
      });
      replay = { browser, site, page: null, outline: true };
    }
    if (!replay.page || replay.page.isClosed()) {
      const ctx = await replay.browser.browser.newContext();
      await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((fn) => fn);" });
      replay.page = await ctx.newPage();
    }
    await replay.page.goto(page.url, { waitUntil: "load", timeout: 30_000 }).catch(() => null);
    const found = selector ? await replay.page.evaluate(OUTLINE_SCRIPT, { selector, show: replay.outline }).catch(() => false) : false;
    log(`[review] replay ${site}/${pageId}${selector ? ` → ${found ? "target outlined" : "target not found"}` : ""}`);
    return { opened: true, found: Boolean(found) };
  };

  // --- request handling -----------------------------------------------------
  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log(`[review] error: ${err instanceof Error ? err.stack : String(err)}`);
      send(res, status, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  const port = await new Promise<number>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
  const origin = `http://127.0.0.1:${port}`;

  async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 1_000_000) throw new HttpError(413, "body too large");
      chunks.push(chunk as Buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "invalid JSON");
    }
  }

  function guard(req: http.IncomingMessage, mutating: boolean): void {
    if (req.headers.host !== `127.0.0.1:${port}`) throw new HttpError(421, "unexpected host");
    if (!mutating) return;
    if (req.headers["x-eval-token"] !== token) throw new HttpError(403, "missing or invalid session token");
    if (req.headers.origin !== origin) throw new HttpError(403, "cross-origin request refused");
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin") throw new HttpError(403, "cross-site request refused");
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "JSON only");
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", origin);
    const method = req.method ?? "GET";
    const mutating = method !== "GET" && method !== "HEAD";
    guard(req, mutating);

    if (method === "GET" && url.pathname === "/") {
      const n = nonce();
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; img-src 'self'; script-src 'nonce-${n}'; style-src 'nonce-${n}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cache-control": "no-store",
      });
      res.end(renderApp({ token, nonce: n, mode: options.mode }));
      return;
    }

    if (method === "GET" && url.pathname === "/api/state") {
      if (audit) {
        send(res, 200, { mode: "audit", reviewer: options.reviewer, audit: auditView(), judge_visible: false });
        return;
      }
      const list = items();
      const j = judgments();
      const cs = currentCases();
      send(res, 200, {
        mode: "review", reviewer: options.reviewer, run_id: data!.manifest.run_id, batch, criterion: options.criterion ?? null,
        judge_visible: judgeVisible(batch),
        items: list.map((i) => {
          const link = caseFor(i, cs);
          const cur = link?.assertionId ? j.get(`${link.c.case_id}|${link.assertionId}`) : undefined;
          return { item_id: i.item_id, criterion: i.criterion, site: i.site, page: i.page, check: i.prediction.check, verdict: cur?.verdict ?? null };
        }),
      });
      return;
    }

    const itemMatch = url.pathname.match(/^\/api\/item\/([^/]+)$/);
    if (method === "GET" && itemMatch) {
      if (audit && audit.status === "annotating") throw new HttpError(403, "engine output is hidden until the audit is frozen");
      const item = itemById(decodeURIComponent(itemMatch[1]));
      const link = caseFor(item, currentCases());
      const events = labels.events();
      const cur = link?.assertionId ? judgments().get(`${link.c.case_id}|${link.assertionId}`) ?? null : null;
      const p = item.prediction;
      send(res, 200, {
        item_id: item.item_id, site: item.site, page: item.page, criterion: item.criterion,
        engine: {
          criterion: p.criterion, check: p.check, tier: p.tier, failure_type: p.failure_type, severity: p.severity,
          confidence: { tier: p.confidence_tier, score: p.confidence_score }, detected_by: p.detected_by, state: p.state,
          reasoning: p.reasoning, selector: p.selector, model_image: p.model_image, also_found_on: p.also_found_on,
        },
        judge: judgeVisible(batch) ? null : undefined,
        assets: item.assets.map((a) => ({ kind: a.kind, label: a.label, url: `/asset/${encodeURIComponent(item.item_id)}/${a.kind}` })),
        html_context: item.html_context,
        case: link ? { case_id: link.c.case_id, assertions: link.c.assertions, revision: link.c.revision } : null,
        current: cur ? { verdict: cur.verdict, severity: cur.severity_correction, label_id: cur.label_id } : null,
        history: link?.assertionId ? historyFor(events, link.c.case_id, link.assertionId) : [],
        propagation: { eligible: !NON_PROPAGATING_CRITERIA.has(item.criterion) && item.context_sha256 !== null },
      });
      return;
    }

    const assetMatch = url.pathname.match(/^\/asset\/([^/]+)\/([a-z_]+)$/);
    if (method === "GET" && assetMatch) {
      if (audit && audit.status === "annotating") throw new HttpError(403, "engine output is hidden until the audit is frozen");
      const item = itemById(decodeURIComponent(assetMatch[1]));
      const asset = item.assets.find((a) => a.kind === assetMatch[2]);
      if (!asset || !existsSync(asset.path)) throw new HttpError(404, "no such asset");
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      createReadStream(asset.path).pipe(res);
      return;
    }

    const pageShot = url.pathname.match(/^\/page-capture\/([a-z]\d{2})\/(p\d{3})$/);
    if (method === "GET" && pageShot) {
      const version = data?.version ?? audit!.corpus_version;
      const split = (data?.split ?? audit!.split) as Split;
      const file = join(siteDir(paths, { version, split, siteId: pageShot[1] }), pageShot[2], "screenshot.png");
      if (!existsSync(file)) throw new HttpError(404, "no capture");
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      createReadStream(file).pipe(res);
      return;
    }

    if (!mutating) throw new HttpError(404, "not found");
    const b = await body(req);
    const seconds = typeof b.active_seconds === "number" && b.active_seconds >= 0 ? Math.round(b.active_seconds * 10) / 10 : null;

    switch (url.pathname) {
      case "/api/judge": {
        if (audit && audit.status === "annotating") throw new HttpError(403, "engine output is hidden until the audit is frozen");
        const item = itemById(String(b.item_id));
        const verdict = String(b.verdict) as LabelVerdict;
        if (!["violation", "no_violation", "unsure"].includes(verdict)) throw new HttpError(400, "verdict must be violation, no_violation or unsure");
        const criterion = typeof b.criterion === "string" && b.criterion ? b.criterion : item.criterion;
        if (!/^\d\.\d\.\d{1,2}$/.test(criterion)) throw new HttpError(400, "a criterion is required");
        const severity = b.severity ? String(b.severity) as Severity : null;
        if (severity && verdict !== "violation") throw new HttpError(400, "a severity correction annotates a violation only");
        const { c, assertionId } = caseForItem(item, criterion);
        const [ev] = labels.append([labelInput(c.case_id, assertionId, verdict, {
          severity_correction: severity, active_seconds: seconds, prediction_ref: { run_id: data!.manifest.run_id, prediction_key: item.prediction.prediction_key },
        })]);
        undoStack.push({ labelIds: [ev.label_id], group: null });
        send(res, 200, { label_id: ev.label_id, case_id: c.case_id, assertion_id: assertionId });
        return;
      }
      case "/api/undo": {
        const op = undoStack.pop();
        if (!op) throw new HttpError(409, "nothing to undo in this session");
        const ev = labels.append([{ ...labelInput("C-000000", "A1", "unsure", {}), kind: "undo", case_id: null, assertion_id: null, verdict: null, phase: null, undoes: op.group ?? op.labelIds[0] }]);
        send(res, 200, { undone: op, label_id: ev[0].label_id });
        return;
      }
      case "/api/case": {
        // Ground truth with no finding (a defect the engine may have missed)
        const site = String(b.site ?? "");
        const page = String(b.page ?? "");
        const criterion = String(b.criterion ?? "");
        const issue = String(b.issue ?? "").trim();
        if (!/^[a-z]\d{2}$/.test(site) || !/^p\d{3}$/.test(page)) throw new HttpError(400, "site and page are required");
        if (!/^\d\.\d\.\d{1,2}$/.test(criterion)) throw new HttpError(400, "a criterion is required");
        if (!issue) throw new HttpError(400, "describe the issue");
        if (audit && !audit.pages.includes(`${site}/${page}`)) throw new HttpError(400, "page is not declared in this audit");
        const selector = typeof b.selector === "string" && b.selector.trim() ? b.selector.trim() : null;
        const html = typeof b.html === "string" && b.html.trim() ? b.html.trim().slice(0, 4000) : null;
        const verdict = (String(b.verdict ?? "violation")) as LabelVerdict;
        const ctxSha = html ? contextHash(pageDom(site, page), html) : null;
        const c = cases.create({
          created_by: options.reviewer, site, page, corpus_version: data?.version ?? audit!.corpus_version,
          unit: selector || html ? "element" : "page",
          target: { selector, html, html_sha256: html ? sha256(html) : null, context_sha256: ctxSha, state: typeof b.state === "string" && b.state ? b.state : null },
          assertions: [{ assertion_id: "A1", criterion, issue, failure_type: null }],
          origin: audit ? "independent_audit" : "review", propagation_group: null, evidence_refs: [], source_seed_id: null,
        });
        const [ev] = labels.append([labelInput(c.case_id, "A1", verdict, { active_seconds: seconds })]);
        undoStack.push({ labelIds: [ev.label_id], group: null });
        send(res, 200, { case_id: c.case_id, label_id: ev.label_id });
        return;
      }
      case "/api/propagate/propose": {
        const item = itemById(String(b.item_id));
        if (NON_PROPAGATING_CRITERIA.has(item.criterion) || !item.context_sha256) {
          send(res, 200, { eligible: false, reason: "alt text and link purpose never propagate on identical HTML alone; context must be known", instances: [] });
          return;
        }
        const instances = data!.items.filter((i) => i.item_id !== item.item_id && i.criterion === item.criterion &&
          i.prediction.selector === item.prediction.selector && i.prediction.html_sha256 === item.prediction.html_sha256 &&
          i.prediction.state === item.prediction.state && i.context_sha256 === item.context_sha256);
        send(res, 200, { eligible: true, instances: instances.map((i) => ({ item_id: i.item_id, site: i.site, page: i.page, html_context: i.html_context })) });
        return;
      }
      case "/api/propagate/confirm": {
        const item = itemById(String(b.item_id));
        const ids = Array.isArray(b.instance_ids) ? (b.instance_ids as unknown[]).map(String) : [];
        if (NON_PROPAGATING_CRITERIA.has(item.criterion) || !item.context_sha256) throw new HttpError(400, "this judgment cannot propagate");
        const verdict = String(b.verdict) as LabelVerdict;
        if (!["violation", "no_violation"].includes(verdict)) throw new HttpError(400, "only a definite verdict propagates");
        const instances = ids.map(itemById);
        for (const i of instances) {
          if (i.criterion !== item.criterion || i.prediction.selector !== item.prediction.selector || i.prediction.html_sha256 !== item.prediction.html_sha256 || i.context_sha256 !== item.context_sha256 || i.prediction.state !== item.prediction.state) {
            throw new HttpError(400, `instance ${i.item_id} is not equivalent`);
          }
        }
        const group = `G-${sha256(`${item.item_id}|${ids.join(",")}|${Date.now()}`).slice(0, 10)}`;
        const all = [item, ...instances];
        const inputs: LabelInput[] = [];
        for (const [n, i] of all.entries()) {
          const { c, assertionId } = caseForItem(i, item.criterion);
          if (c.propagation_group !== group) cases.revise(c.case_id, { propagation_group: group }, "propagation group confirmed after seeing every instance", options.reviewer);
          inputs.push(labelInput(c.case_id, assertionId, verdict, {
            severity_correction: verdict === "violation" && b.severity ? String(b.severity) as Severity : null,
            active_seconds: n === 0 ? seconds : 0, propagation_group: group, propagation_source: n === 0 ? null : item.item_id,
            prediction_ref: { run_id: data!.manifest.run_id, prediction_key: i.prediction.prediction_key },
          }));
        }
        const evs = labels.append(inputs);
        undoStack.push({ labelIds: evs.map((e) => e.label_id), group });
        send(res, 200, { group, labels: evs.map((e) => e.label_id) });
        return;
      }
      case "/api/replay/open": {
        if (audit && audit.status === "annotating") {
          const res2 = await openReplay(String(b.site), String(b.page), null);
          send(res, 200, res2);
          return;
        }
        if (b.item_id) {
          const item = itemById(String(b.item_id));
          send(res, 200, await openReplay(item.site, item.page, item.prediction.selector));
        } else {
          send(res, 200, await openReplay(String(b.site), String(b.page), typeof b.selector === "string" ? b.selector : null));
        }
        return;
      }
      case "/api/replay/outline": {
        if (!replay?.page) throw new HttpError(409, "no replay page open");
        replay.outline = Boolean(b.on);
        await replay.page.evaluate((show) => {
          const el = document.getElementById("__wcag_eval_outline__");
          if (el) el.style.display = show ? "block" : "none";
        }, replay.outline).catch(() => {});
        send(res, 200, { outline: replay.outline });
        return;
      }
      case "/api/audit/status": {
        if (!audit) throw new HttpError(400, "not an audit session");
        if (audit.status !== "annotating") throw new HttpError(409, "the annotation is frozen");
        const key = cellKey(String(b.page_ref), String(b.criterion));
        if (!(key in audit.cells)) throw new HttpError(400, "undeclared page or criterion");
        const status = String(b.status) as AuditCellStatus;
        if (!["complete", "partial", "unable"].includes(status)) throw new HttpError(400, "status must be complete, partial or unable");
        audit.cells[key] = status;
        saveAudit(paths, audit);
        send(res, 200, { cells: audit.cells });
        return;
      }
      case "/api/audit/negative": {
        // A tested negative: no violation of this criterion on this page
        if (!audit) throw new HttpError(400, "not an audit session");
        if (audit.status !== "annotating") throw new HttpError(409, "the annotation is frozen");
        const [site, page] = String(b.page_ref).split("/");
        const criterion = String(b.criterion);
        if (!(cellKey(`${site}/${page}`, criterion) in audit.cells)) throw new HttpError(400, "undeclared page or criterion");
        const c = cases.create({
          created_by: options.reviewer, site, page, corpus_version: audit.corpus_version, unit: "page",
          target: { selector: null, html: null, html_sha256: null, context_sha256: null, state: null },
          assertions: [{ assertion_id: "A1", criterion, issue: "tested negative: no violation found on this page", failure_type: null }],
          origin: "independent_audit", propagation_group: null, evidence_refs: [`audit:${audit.audit_id}`], source_seed_id: null,
        });
        const [ev] = labels.append([labelInput(c.case_id, "A1", "no_violation", { active_seconds: seconds })]);
        undoStack.push({ labelIds: [ev.label_id], group: null });
        send(res, 200, { case_id: c.case_id, label_id: ev.label_id });
        return;
      }
      case "/api/audit/freeze": {
        if (!audit) throw new HttpError(400, "not an audit session");
        if (audit.status !== "annotating") throw new HttpError(409, "already frozen");
        audit.status = "frozen";
        audit.frozen_at = new Date().toISOString();
        saveAudit(paths, audit);
        undoStack.length = 0; // pre-reveal judgments can no longer change
        send(res, 200, { audit: auditView() });
        return;
      }
      case "/api/audit/reveal": {
        if (!audit) throw new HttpError(400, "not an audit session");
        if (audit.status === "annotating") throw new HttpError(409, "freeze the annotation before revealing engine output");
        const runId = String(b.run_id ?? audit.revealed_run ?? "");
        const runData = loadRunReview(paths, runId);
        if (runData.version !== audit.corpus_version) throw new HttpError(400, "the run used a different corpus version");
        data = runData;
        audit.status = "revealed";
        audit.revealed_run = runId;
        audit.revealed_at = audit.revealed_at ?? new Date().toISOString();
        saveAudit(paths, audit);
        send(res, 200, revealView());
        return;
      }
      default:
        throw new HttpError(404, "not found");
    }
  }

  function pageDom(site: string, page: string): string {
    const version = data?.version ?? audit!.corpus_version;
    const split = (data?.split ?? audit!.split) as Split;
    const file = join(siteDir(paths, { version, split, siteId: site }), page, "dom.html");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  }

  function auditView() {
    const a = audit!;
    const cs = currentCases().filter((c) => c.origin === "independent_audit" && c.evidence_refs.length >= 0 && a.pages.includes(`${c.site}/${c.page}`) && c.corpus_version === a.corpus_version);
    const j = judgments();
    return {
      audit_id: a.audit_id, status: a.status, pages: a.pages, criteria: a.criteria, cells: a.cells, revealed_run: a.revealed_run,
      cases: cs.flatMap((c) => c.assertions.filter((x) => a.criteria.includes(x.criterion)).map((x) => ({
        case_id: c.case_id, page_ref: `${c.site}/${c.page}`, criterion: x.criterion, issue: x.issue, selector: c.target.selector, html: c.target.html,
        verdict: j.get(`${c.case_id}|${x.assertion_id}`)?.verdict ?? null,
      }))),
      reveal: a.status === "revealed" && data ? revealView() : null,
    };
  }

  function revealView() {
    const a = audit!;
    const d = data!;
    const declared = new Set(a.pages);
    const preds: Prediction[] = d.items.filter((i) => declared.has(`${i.site}/${i.page}`) && a.criteria.includes(i.criterion)).map((i) => i.prediction);
    const auditCases = currentCases().filter((c) => c.origin === "independent_audit" && declared.has(`${c.site}/${c.page}`) && c.corpus_version === a.corpus_version)
      .map((c) => ({ ...c, assertions: c.assertions.filter((x) => a.criteria.includes(x.criterion)) })).filter((c) => c.assertions.length > 0);
    // Pre-reveal judgments only: the audit's own ground truth
    const pre = foldLabels(labels.events().filter((e) => e.kind === "undo" || e.phase === "pre_reveal"));
    const covRows = new Map<string, string>();
    for (const [site, info] of d.sites) {
      const covFile = join(info.replayDir, "coverage.json");
      if (existsSync(covFile)) for (const [k, v] of coverageMap(site, readJson(covFile)) ?? []) covRows.set(k, v);
    }
    const result = matchCases({
      config, view: "confirmed", cases: auditCases, judgments: pre, overrides: [], predictions: preds,
      coverage: covRows.size > 0 ? covRows : null, corpusPages: declared, corpusVersion: a.corpus_version,
    });
    const itemOf = new Map(d.items.map((i) => [i.prediction.prediction_key, i.item_id]));
    return {
      run_id: d.manifest.run_id,
      outcomes: result.outcomes.map((o) => ({ case_id: o.case_id, criterion: o.criterion, page_ref: `${o.site}/${o.page}`, class: o.class, prediction_item: o.prediction_key ? itemOf.get(o.prediction_key) ?? null : null, verdict: o.verdict })),
      misses: result.outcomes.filter((o) => o.class === "FN").map((o) => ({ case_id: o.case_id, criterion: o.criterion, page_ref: `${o.site}/${o.page}` })),
      engine_only: result.unlabeled.map((p) => ({ item_id: itemOf.get(p.prediction_key) ?? null, criterion: p.criterion, page_ref: `${p.site}/${p.page}`, selector: p.selector })),
    };
  }

  return {
    url: origin,
    token,
    replayPage: () => replay?.page ?? null,
    close: async () => {
      if (replay) await replay.browser.close();
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

function send(res: http.ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(value));
}

/** Runs in the replayed page: scroll to the target and draw a labelled outline. */
const OUTLINE_SCRIPT = ({ selector, show }: { selector: string; show: boolean }): boolean => {
  let el: Element | null = null;
  try { el = document.querySelector(selector); } catch { el = null; }
  if (!el) return false;
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  document.getElementById("__wcag_eval_outline__")?.remove();
  const box = document.createElement("div");
  box.id = "__wcag_eval_outline__";
  box.setAttribute("aria-hidden", "true");
  Object.assign(box.style, {
    position: "absolute", left: `${r.left + window.scrollX - 4}px`, top: `${r.top + window.scrollY - 4}px`,
    width: `${r.width + 8}px`, height: `${r.height + 8}px`, outline: "3px dashed #d0021b", zIndex: "2147483647",
    pointerEvents: "none", display: show ? "block" : "none",
  });
  const tag = document.createElement("div");
  tag.textContent = "WCAG eval target (outline added by the review tool)";
  Object.assign(tag.style, { position: "absolute", top: "-22px", left: "0", background: "#d0021b", color: "#fff", font: "12px sans-serif", padding: "2px 6px", whiteSpace: "nowrap" });
  box.appendChild(tag);
  document.body.appendChild(box);
  return true;
};
