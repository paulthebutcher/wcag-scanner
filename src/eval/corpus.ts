import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { canonicalJson, hashJson, readJson, sha256, sha256File, writeJson } from "./util.js";
import type { BrowserContract } from "./transport/browser.js";
import type { NodeFetchRecord } from "./transport/node-fetch.js";
import type { EvalPaths } from "./paths.js";
import { isServable, readHar } from "./transport/har.js";

// ---------------------------------------------------------------------------
// Frozen corpus layout (D1). Everything here is private.
//
//   <corpusDir>/<version>/<split>/<site>/site.private.json
//   <corpusDir>/<version>/<split>/<site>/site/robots.txt
//   <corpusDir>/<version>/<split>/<site>/site/node-fetch.json
//   <corpusDir>/<version>/<split>/<site>/site/bodies/<sha256>.bin
//   <corpusDir>/<version>/<split>/<site>/<page>/page.har
//   <corpusDir>/<version>/<split>/<site>/<page>/dom.html
//   <corpusDir>/<version>/<split>/<site>/<page>/screenshot.png
//   <corpusDir>/<version>/<split>/<site>/<page>/capture.private.json
//   <corpusDir>/<version>/<split>/<site>/<page>/images/index.json
//   <corpusDir>/<version>/<split>/<site>/<page>/images/<artifact>.png
//
// Site ids (m01, t01) and page ids (p001) are stable across versions and are
// kept in sites.private.json. A capture never overwrites anything: a refresh
// is a new corpus version.
// ---------------------------------------------------------------------------

export type Split = "tuning" | "dev" | "holdout" | "pilot";

export type ImageState = "present" | "absent_by_design" | "unavailable_at_capture";

export type ImageIdentity =
  | { kind: "source"; url: string }
  | { kind: "submission"; form_selector: string; form_fingerprint: string; scenario: string };

export interface ImageIndexEntry {
  artifact_id: string;
  corpus_version: string;
  site: string;
  page: string;
  check: "alt-text" | "error-messages";
  call_site: string;
  template: string;
  identity: ImageIdentity;
  interaction_step: string | null;
  media_type: string;
  state: ImageState;
  /** sha256 of the exact bytes the engine would send (present only) */
  sha256: string | null;
  file: string | null;
  error: string | null;
  /** Node fetch the bytes came from (alt text) */
  raw: { node_fetch_key: string; body_sha256: string | null; status: number | null } | null;
}

export interface ImageIndex {
  schema_version: 1;
  entries: ImageIndexEntry[];
}

export function identityKey(e: Pick<ImageIndexEntry, "check" | "identity">): string {
  const id = e.identity;
  return id.kind === "source"
    ? `${e.check}|source|${id.url}`
    : `${e.check}|submission|${id.form_selector}|${id.scenario}`;
}

export interface CorpusPage {
  page_id: string;
  order: number;
  url: string;
  final_url: string;
  title: string;
  /** excluded: captured, then left out of a derived corpus version (reason in `error`) */
  status: "captured" | "failed" | "excluded";
  error: string | null;
}

export interface SiteCapture {
  schema_version: 1;
  corpus_version: string;
  split: Split;
  site_id: string;
  root_url: string;
  final_root_url: string;
  passive: boolean;
  capture_run_id: string;
  harness_sha: string;
  started_at: string;
  finished_at: string;
  user_agent: string;
  contract: BrowserContract;
  robots: { source: "parsed" | "absent"; sha256: string | null; group: string; crawl_delay_seconds: number | null };
  /** The page cap applied and where it came from (absent in captures before 2026-10-14) */
  page_cap?: { max_pages_per_site: number; source: "default" | "site_override"; reason: string | null };
  pages: CorpusPage[];
  omissions: Array<{ url: string; reason: string }>;
  uncaptured_forms: Array<{ page_id: string; form_selector: string; reason: string }>;
  pacing: { min_interval_ms: number; top_level_loads: number; min_observed_gap_ms: Record<string, number> };
  containment: { contained_requests: number; by_detail: Record<string, number> };
  /** Every file under the site directory except this one → sha256 */
  file_hashes: Record<string, string>;
  /** Set on a corpus version derived from another (deriveCorpus) */
  derived_from?: { version: string; capture_run_id: string; derived_at: string; excluded: Array<{ page_id: string; reason: string }> };
}

export interface SiteRef {
  version: string;
  split: Split;
  siteId: string;
}

export function siteDir(paths: EvalPaths, ref: SiteRef): string {
  return join(paths.corpusDir, ref.version, ref.split, ref.siteId);
}

export function loadSiteCapture(paths: EvalPaths, ref: SiteRef): SiteCapture {
  const path = join(siteDir(paths, ref), "site.private.json");
  if (!existsSync(path)) throw new Error(`No capture for ${ref.siteId} in ${ref.version}/${ref.split}`);
  return readJson<SiteCapture>(path);
}

export function listSites(paths: EvalPaths, version: string, split: Split): string[] {
  const dir = join(paths.corpusDir, version, split);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => /^[a-z]\d{2}$/.test(d) && existsSync(join(dir, d, "site.private.json"))).sort();
}

export function loadNodeFetchRecords(dir: string): NodeFetchRecord[] {
  const path = join(dir, "site", "node-fetch.json");
  return existsSync(path) ? readJson<NodeFetchRecord[]>(path) : [];
}

export function loadImageIndex(pageDir: string): ImageIndex {
  const path = join(pageDir, "images", "index.json");
  return existsSync(path) ? readJson<ImageIndex>(path) : { schema_version: 1, entries: [] };
}

/** Hash every file below `dir`, keyed by path relative to it. */
export function hashTree(dir: string, exclude: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const rel = relative(dir, full);
      if (exclude.includes(rel)) continue;
      if (statSync(full).isDirectory()) walk(full);
      else out[rel] = sha256File(full);
    }
  };
  walk(dir);
  return out;
}

/** Stable digest of a page set (site ids, page ids and URLs, in order). */
export function pageSetHash(sites: Array<{ siteId: string; pages: Array<{ page_id: string; url: string }> }>): string {
  return hashJson(sites.map((s) => ({ site: s.siteId, pages: s.pages.map((p) => [p.page_id, p.url]) })));
}

/** sha256 over every page's image index for a site (pinned in run manifests). */
export function imageIndexHash(dir: string, pages: CorpusPage[]): string {
  const indexes = pages.map((p) => ({ page: p.page_id, index: loadImageIndex(join(dir, p.page_id)) }));
  return sha256(canonicalJson(indexes));
}

// ---------------------------------------------------------------------------
// Stable ids
// ---------------------------------------------------------------------------

export interface PrivateSite {
  site_id: string;
  domain: string;
  root_url: string;
  family: string | null;
  split: Split;
  pages: Array<{ page_id: string; url: string }>;
  notes?: string;
  /** Webflow data-wf-site id seen at admission (one site per Webflow site) */
  webflow_site_id?: string | null;
}

export interface SitesPrivate {
  schema_version: 1;
  sites: PrivateSite[];
}

export function loadSitesPrivate(paths: EvalPaths): SitesPrivate {
  return existsSync(paths.sitesPrivate) ? readJson<SitesPrivate>(paths.sitesPrivate) : { schema_version: 1, sites: [] };
}

export function saveSitesPrivate(paths: EvalPaths, data: SitesPrivate): void {
  writeJson(paths.sitesPrivate, data);
}

/**
 * Register a site and its pages, returning page ids. Existing ids are kept
 * (stable across versions); a split, once assigned, never changes.
 */
export function registerSite(paths: EvalPaths, input: { siteId: string; rootUrl: string; split: Split; family?: string | null; urls: string[] }): PrivateSite {
  const data = loadSitesPrivate(paths);
  const domain = new URL(input.rootUrl).hostname.replace(/^www\./, "");
  let site = data.sites.find((s) => s.site_id === input.siteId);
  const clash = data.sites.find((s) => s.domain === domain && s.site_id !== input.siteId);
  if (clash) throw new Error(`Domain is already registered as ${clash.site_id}`);
  if (!site) {
    site = { site_id: input.siteId, domain, root_url: input.rootUrl, family: input.family ?? null, split: input.split, pages: [] };
    data.sites.push(site);
  } else if (site.split !== input.split) {
    throw new Error(`Site ${input.siteId} is frozen in split "${site.split}"; refusing to capture it as "${input.split}"`);
  } else if (site.domain !== domain) {
    throw new Error(`Site ${input.siteId} is registered for a different domain`);
  }
  for (const url of input.urls) {
    if (!site.pages.some((p) => p.url === url)) {
      const next = site.pages.reduce((m, p) => Math.max(m, Number(p.page_id.slice(1))), 0) + 1;
      site.pages.push({ page_id: `p${String(next).padStart(3, "0")}`, url });
    }
  }
  data.sites.sort((a, b) => a.site_id.localeCompare(b.site_id));
  saveSitesPrivate(paths, data);
  return site;
}

// ---------------------------------------------------------------------------
// Derived versions
// ---------------------------------------------------------------------------

function linkTree(src: string, dst: string): void {
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dst, name);
    if (statSync(from).isDirectory()) {
      mkdirSync(to, { recursive: true });
      linkTree(from, to);
    } else {
      linkSync(from, to);
    }
  }
}

/**
 * A new corpus version that leaves pages out of an existing one, with a
 * reason for each. Artifacts are hard links to the source version (both are
 * immutable); only site.private.json is new. The source is never modified.
 */
export function deriveCorpus(paths: EvalPaths, input: { from: string; to: string; split: Split; siteId: string; exclude: Array<{ page_id: string; reason: string }> }): SiteCapture {
  const src = siteDir(paths, { version: input.from, split: input.split, siteId: input.siteId });
  const dst = siteDir(paths, { version: input.to, split: input.split, siteId: input.siteId });
  if (existsSync(dst)) throw new Error(`Corpus ${input.to}/${input.split}/${input.siteId} already exists; versions are immutable`);
  const capture = loadSiteCapture(paths, { version: input.from, split: input.split, siteId: input.siteId });
  for (const e of input.exclude) {
    const page = capture.pages.find((p) => p.page_id === e.page_id);
    if (!page) throw new Error(`No page ${e.page_id} in ${input.from}/${input.siteId}`);
    if (page.status !== "captured") throw new Error(`${e.page_id} is not a captured page (${page.status})`);
    if (!e.reason.trim()) throw new Error(`An exclusion needs a reason (${e.page_id})`);
  }
  mkdirSync(dst, { recursive: true });
  linkTree(src, dst);
  // Replace the link, never write through it into the source version
  unlinkSync(join(dst, "site.private.json"));
  const reasons = new Map(input.exclude.map((e) => [e.page_id, e.reason]));
  const derived: SiteCapture = {
    ...capture,
    corpus_version: input.to,
    pages: capture.pages.map((p) => (reasons.has(p.page_id) ? { ...p, status: "excluded", error: reasons.get(p.page_id)! } : p)),
    derived_from: { version: input.from, capture_run_id: capture.capture_run_id, derived_at: new Date().toISOString(), excluded: input.exclude.map((e) => ({ ...e })) },
  };
  mkdirSync(dirname(join(dst, "site.private.json")), { recursive: true });
  writeJson(join(dst, "site.private.json"), derived);
  return derived;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface CorpusProblem {
  site: string;
  page: string | null;
  problem: string;
}

export interface CorpusVerification {
  version: string;
  sites: Array<{ split: Split; site: string; pages: number; files: number; image_entries: number }>;
  problems: CorpusProblem[];
}

export function verifySite(paths: EvalPaths, ref: SiteRef): { files: number; images: number; problems: CorpusProblem[] } {
  const dir = siteDir(paths, ref);
  const capture = loadSiteCapture(paths, ref);
  const problems: CorpusProblem[] = [];
  const actual = hashTree(dir, ["site.private.json"]);
  for (const [rel, sha] of Object.entries(capture.file_hashes)) {
    if (!(rel in actual)) problems.push({ site: ref.siteId, page: rel.split("/")[0], problem: `missing file ${rel}` });
    else if (actual[rel] !== sha) problems.push({ site: ref.siteId, page: rel.split("/")[0], problem: `checksum mismatch ${rel}` });
  }
  for (const rel of Object.keys(actual)) {
    if (!(rel in capture.file_hashes)) problems.push({ site: ref.siteId, page: rel.split("/")[0], problem: `unexpected file ${rel}` });
  }
  let images = 0;
  for (const page of capture.pages.filter((p) => p.status === "captured")) {
    const pageDir = join(dir, page.page_id);
    for (const f of ["page.har", "dom.html", "screenshot.png", "capture.private.json"]) {
      if (!existsSync(join(pageDir, f))) problems.push({ site: ref.siteId, page: page.page_id, problem: `missing ${f}` });
    }
    if (existsSync(join(pageDir, "page.har"))) {
      try {
        const har = readHar(join(pageDir, "page.har"));
        const doc = har.log.entries.find((e) => e.request.url === page.final_url || e.request.url === page.url);
        if (!doc) problems.push({ site: ref.siteId, page: page.page_id, problem: "HAR has no entry for the page URL" });
        else if (!isServable(doc)) problems.push({ site: ref.siteId, page: page.page_id, problem: "page document in HAR is not a servable response" });
      } catch (err) {
        problems.push({ site: ref.siteId, page: page.page_id, problem: `HAR unreadable: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    const index = loadImageIndex(pageDir);
    const seen = new Set<string>();
    for (const e of index.entries) {
      images++;
      const key = identityKey(e);
      if (seen.has(key)) problems.push({ site: ref.siteId, page: page.page_id, problem: `duplicate image identity ${e.check} ${e.identity.kind}` });
      seen.add(key);
      if (e.state === "present") {
        if (!e.file || !e.sha256) problems.push({ site: ref.siteId, page: page.page_id, problem: `present image ${e.artifact_id} has no file` });
        else if (!existsSync(join(pageDir, e.file)) || sha256(readFileSync(join(pageDir, e.file))) !== e.sha256) {
          problems.push({ site: ref.siteId, page: page.page_id, problem: `image ${e.artifact_id} bytes do not match` });
        }
      }
    }
  }
  for (const rec of loadNodeFetchRecords(dir)) {
    if (rec.body_sha256) {
      const body = join(dir, "site", "bodies", `${rec.body_sha256}.bin`);
      if (!existsSync(body)) problems.push({ site: ref.siteId, page: null, problem: `Node fetch body missing for ${rec.purpose}` });
    }
  }
  return { files: Object.keys(actual).length, images, problems };
}

export function verifyCorpus(paths: EvalPaths, version: string): CorpusVerification {
  const result: CorpusVerification = { version, sites: [], problems: [] };
  for (const split of ["tuning", "dev", "holdout", "pilot"] as Split[]) {
    for (const site of listSites(paths, version, split)) {
      const r = verifySite(paths, { version, split, siteId: site });
      const capture = loadSiteCapture(paths, { version, split, siteId: site });
      result.sites.push({ split, site, pages: capture.pages.filter((p) => p.status === "captured").length, files: r.files, image_entries: r.images });
      result.problems.push(...r.problems);
    }
  }
  return result;
}
