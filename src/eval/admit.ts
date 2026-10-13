import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WebflowAdapter } from "../adapters/webflow.js";
import { detectCMSCollections, extractSitemapLocs, isSitemapIndex, normalizeUrl } from "../core/crawler.js";
import { decideRobots, isAllowed, type RobotsFetchOutcome } from "./robots.js";
import { Pacer } from "./transport/pacer.js";
import { loadSitesPrivate, saveSitesPrivate, type PrivateSite } from "./corpus.js";
import type { EvalPaths } from "./paths.js";
import type { EvalConfig } from "./config.js";
import { sha256, writeJson } from "./util.js";

// ---------------------------------------------------------------------------
// D1b municipal admission. From Paul's BuiltWith export: normalise and
// deduplicate domains, confirm Webflow with the adapter's detect() on the
// home page (robots first, eval user agent, paced), give each admitted site a
// pseudonymous id, group sites into families where evidence shows a shared
// agency or template, and assign families to splits by sha256(family id +
// salt): the first ceil(n/3) are holdout, the rest dev. Assignments are
// frozen in sites.private.json; re-running never reassigns. Rejects are
// recorded privately.
// ---------------------------------------------------------------------------

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; redirect?: "follow" }) => Promise<{ ok: boolean; status: number; url: string; text(): Promise<string> }>;

export interface AdmitCandidate {
  domain: string;
  /** Family or agency hint from the input file, if it has one */
  family_hint: string | null;
}

export interface AdmitDecision {
  domain: string;
  admitted: boolean;
  reason: string;
  site_id: string | null;
  family: string | null;
  family_evidence: string | null;
  webflow_site_id: string | null;
}

export interface AdmitResult {
  candidates: number;
  duplicates: number;
  decisions: AdmitDecision[];
  families: Array<{ family: string; split: "holdout" | "dev"; sites: string[] }>;
  newly_assigned: string[];
  enough_sites: boolean;
}

/** Lower-case host without scheme, www., path, port or trailing dot. */
export function normalizeDomain(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  if (!s || s.startsWith("#")) return null;
  if (!/^[a-z]+:\/\//.test(s)) s = `https://${s}`;
  try {
    const host = new URL(s).hostname.replace(/\.$/, "").replace(/^www\./, "");
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** Parse a BuiltWith-style CSV (domain column by name, else the first column). */
export function parseCandidates(csv: string): { candidates: AdmitCandidate[]; duplicates: number } {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return { candidates: [], duplicates: 0 };
  const split = (line: string) => line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"').trim()) ?? [];
  const header = split(lines[0]).map((h) => h.toLowerCase());
  const hasHeader = header.some((h) => ["domain", "url", "website", "site"].includes(h));
  const col = hasHeader ? header.findIndex((h) => ["domain", "url", "website", "site"].includes(h)) : 0;
  const famCol = hasHeader ? header.findIndex((h) => ["family", "agency", "vendor", "template"].includes(h)) : -1;
  const seen = new Set<string>();
  const candidates: AdmitCandidate[] = [];
  let duplicates = 0;
  for (const line of lines.slice(hasHeader ? 1 : 0)) {
    const cells = split(line);
    const domain = normalizeDomain(cells[col] ?? "");
    if (!domain) continue;
    if (seen.has(domain)) { duplicates++; continue; }
    seen.add(domain);
    candidates.push({ domain, family_hint: famCol >= 0 && cells[famCol] ? cells[famCol].toLowerCase().replace(/\s+/g, " ").trim() : null });
  }
  return { candidates, duplicates };
}

const CREDIT_RE = /(?:website|site|designed|built|developed|powered)\s+(?:and\s+\w+\s+)?by\s*(?:<[^>]+>\s*)*([A-Z][\w&.\- ]{2,40})/i;

/** Agency or template evidence from a home page (credit line, Webflow site id). */
export function familyEvidence(html: string): { agency: string | null; webflowSite: string | null } {
  const credit = html.replace(/\s+/g, " ").match(CREDIT_RE);
  const agency = credit ? credit[1].trim().toLowerCase().replace(/[.\s]+$/, "") : null;
  const wf = html.match(/<html\b[^>]*\bdata-wf-site\s*=\s*["']([^"']+)["']/i);
  return { agency: agency && agency.length >= 3 ? agency : null, webflowSite: wf ? wf[1] : null };
}

export async function admitSites(options: {
  paths: EvalPaths;
  config: EvalConfig;
  csv: string;
  salt: string;
  userAgent: string;
  fetchImpl: FetchLike;
  paceMs?: number;
  log?: (m: string) => void;
}): Promise<AdmitResult> {
  const log = options.log ?? (() => {});
  if (options.salt.length < 16) throw new Error("The split salt must be at least 16 characters");
  const { candidates, duplicates } = parseCandidates(options.csv);
  const registry = loadSitesPrivate(options.paths);
  const known = new Map(registry.sites.map((s) => [s.domain, s]));
  const pacer = new Pacer(options.paceMs ?? options.config.capture.min_seconds_between_top_level_loads * 1000);
  const headers = { "user-agent": options.userAgent };
  const decisions: AdmitDecision[] = [];
  const admittedNew: Array<{ domain: string; root: string; family: string; evidence: string; wfSite: string | null }> = [];

  for (const cand of candidates) {
    const prior = known.get(cand.domain);
    if (prior) {
      decisions.push({ domain: cand.domain, admitted: true, reason: "already admitted (frozen)", site_id: prior.site_id, family: prior.family, family_evidence: null, webflow_site_id: null });
      continue;
    }
    const root = `https://${cand.domain}/`;
    // robots.txt first: a fetch error or 5xx means the site is skipped
    let outcome: RobotsFetchOutcome;
    try {
      await pacer.beforeTopLevel(root);
      const res = await options.fetchImpl(`https://${cand.domain}/robots.txt`, { headers, redirect: "follow" });
      outcome = res.ok ? { kind: "ok", status: res.status, body: await res.text() } : { kind: "http-error", status: res.status };
    } catch (err) {
      outcome = { kind: "network-error", error: err instanceof Error ? err.message : String(err) };
    }
    const robots = decideRobots(outcome);
    if (!robots.usable) { decisions.push(reject(cand.domain, robots.reason)); continue; }
    if (!isAllowed(robots.policy, root)) { decisions.push(reject(cand.domain, "home page disallowed by robots.txt")); continue; }
    let html: string;
    let finalUrl = root;
    try {
      await pacer.beforeTopLevel(root);
      const res = await options.fetchImpl(root, { headers, redirect: "follow" });
      if (!res.ok) { decisions.push(reject(cand.domain, `home page HTTP ${res.status}`)); continue; }
      html = await res.text();
      finalUrl = res.url || root;
    } catch (err) {
      decisions.push(reject(cand.domain, `home page fetch failed: ${err instanceof Error ? err.message : String(err)}`));
      continue;
    }
    if (!new WebflowAdapter().detect(html)) { decisions.push(reject(cand.domain, "not detected as Webflow")); continue; }
    const ev = familyEvidence(html);
    const family = cand.family_hint ? `hint:${cand.family_hint}` : ev.agency ? `agency:${ev.agency}` : `site:${cand.domain}`;
    const evidence = cand.family_hint ? "input file family column" : ev.agency ? "credit line on the home page" : "no shared-family evidence (own family)";
    admittedNew.push({ domain: cand.domain, root: normalizeUrl(finalUrl, finalUrl) ?? root, family, evidence, wfSite: ev.webflowSite });
    log(`[admit] ${cand.domain}: Webflow (${family})`);
  }

  // Two domains on one Webflow site are one site: keep the first (registered
  // sites first), reject the rest
  const byWf = new Map<string, string>(registry.sites.filter((s) => s.webflow_site_id).map((s) => [s.webflow_site_id!, s.domain]));
  for (const a of [...admittedNew]) {
    if (!a.wfSite) continue;
    const first = byWf.get(a.wfSite);
    if (first) {
      admittedNew.splice(admittedNew.indexOf(a), 1);
      decisions.push(reject(a.domain, `same Webflow site as ${first}`));
    } else {
      byWf.set(a.wfSite, a.domain);
    }
  }

  // Pseudonymous ids in salted order (so ids reveal nothing about the input order)
  const nextId = () => {
    const used = registry.sites.filter((s) => s.site_id.startsWith("m")).map((s) => Number(s.site_id.slice(1)));
    return `m${String((used.length ? Math.max(...used) : 0) + 1).padStart(2, "0")}`;
  };
  // Families already split keep their split; new families are split together
  const familySplit = new Map<string, "holdout" | "dev">();
  for (const s of registry.sites) if (s.family && (s.split === "holdout" || s.split === "dev")) familySplit.set(s.family, s.split);
  const newFamilies = Array.from(new Set(admittedNew.map((a) => a.family))).filter((f) => !familySplit.has(f))
    .sort((a, b) => sha256(a + options.salt).localeCompare(sha256(b + options.salt)));
  const holdoutCount = Math.ceil(newFamilies.length / 3);
  newFamilies.forEach((f, i) => familySplit.set(f, i < holdoutCount ? "holdout" : "dev"));

  const newly: string[] = [];
  for (const a of admittedNew.sort((x, y) => sha256(x.domain + options.salt).localeCompare(sha256(y.domain + options.salt)))) {
    const site: PrivateSite = { site_id: nextId(), domain: a.domain, root_url: a.root, family: a.family, split: familySplit.get(a.family)!, pages: [], notes: a.evidence, webflow_site_id: a.wfSite };
    registry.sites.push(site);
    newly.push(site.site_id);
    decisions.push({ domain: a.domain, admitted: true, reason: "Webflow confirmed", site_id: site.site_id, family: a.family, family_evidence: a.evidence, webflow_site_id: a.wfSite });
  }
  registry.sites.sort((x, y) => x.site_id.localeCompare(y.site_id));
  saveSitesPrivate(options.paths, registry);

  const municipal = registry.sites.filter((s) => s.site_id.startsWith("m"));
  const families = Array.from(new Set(municipal.map((s) => s.family ?? s.site_id))).map((family) => ({
    family, split: (municipal.find((s) => (s.family ?? s.site_id) === family)!.split as "holdout" | "dev"), sites: municipal.filter((s) => (s.family ?? s.site_id) === family).map((s) => s.site_id),
  }));
  const result: AdmitResult = { candidates: candidates.length, duplicates, decisions, families, newly_assigned: newly, enough_sites: municipal.length >= 15 };
  writeJson(join(options.paths.corpusDir, "admission.private.json"), { at: new Date().toISOString(), ...result });
  return result;
}

function reject(domain: string, reason: string): AdmitDecision {
  return { domain, admitted: false, reason, site_id: null, family: null, family_evidence: null, webflow_site_id: null };
}

// ---------------------------------------------------------------------------
// Page selection (before any scoring): home, key public tasks, one page per
// CMS-style collection, then fill in sitemap order, up to the per-site cap.
// ---------------------------------------------------------------------------

const TASK_RE = /(pay|payment|bill|permit|licen[cs]e|apply|application|court|contact|form|meeting|agenda|minutes|council|service|department|job|employment|career|news|event|calendar|trash|recycling|water|utilit|tax|police|fire|park|library|vote|election|report|request|complaint)/i;

export interface PageSelection {
  site_id: string;
  pages: string[];
  omitted: Array<{ url: string; reason: string }>;
}

export async function selectPages(site: PrivateSite, options: { fetchImpl: FetchLike; userAgent: string; maxPages: number; pacer: Pacer }): Promise<PageSelection> {
  const headers = { "user-agent": options.userAgent };
  const robotsRes = await options.fetchImpl(new URL("/robots.txt", site.root_url).href, { headers }).catch(() => null);
  const robots = decideRobots(robotsRes ? (robotsRes.ok ? { kind: "ok", status: robotsRes.status, body: await robotsRes.text() } : { kind: "http-error", status: robotsRes.status }) : { kind: "network-error", error: "fetch failed" });
  if (!robots.usable) return { site_id: site.site_id, pages: [], omitted: [{ url: site.root_url, reason: robots.reason }] };
  const sitemapUrls = robots.policy.sitemaps.length ? robots.policy.sitemaps : [new URL("/sitemap.xml", site.root_url).href];
  const locs: string[] = [];
  for (const sm of sitemapUrls.slice(0, 5)) {
    await options.pacer.beforeTopLevel(sm);
    const res = await options.fetchImpl(sm, { headers }).catch(() => null);
    if (!res?.ok) continue;
    const xml = await res.text();
    if (isSitemapIndex(xml)) {
      for (const child of extractSitemapLocs(xml).slice(0, 10)) {
        await options.pacer.beforeTopLevel(child);
        const c = await options.fetchImpl(child, { headers }).catch(() => null);
        if (c?.ok) locs.push(...extractSitemapLocs(await c.text()));
      }
    } else {
      locs.push(...extractSitemapLocs(xml));
    }
  }
  const origin = new URL(site.root_url).origin;
  const all = Array.from(new Set(locs.map((u) => normalizeUrl(u, origin)).filter((u): u is string => !!u && new URL(u).origin === origin))).sort();
  const omitted: PageSelection["omitted"] = [];
  const allowed = all.filter((u) => (isAllowed(robots.policy, u) ? true : (omitted.push({ url: u, reason: "disallowed by robots.txt" }), false)));
  const chosen: string[] = [normalizeUrl(site.root_url, site.root_url)!];
  const add = (u: string) => { if (!chosen.includes(u) && chosen.length < options.maxPages) chosen.push(u); };
  for (const u of allowed.filter((x) => TASK_RE.test(new URL(x).pathname))) add(u);
  for (const col of detectCMSCollections(allowed, null)) add(col.urls[0]);
  for (const u of allowed) add(u);
  for (const u of allowed) if (!chosen.includes(u)) omitted.push({ url: u, reason: `over the ${options.maxPages}-page cap` });
  return { site_id: site.site_id, pages: chosen, omitted };
}

/** Read a candidate file (Paul's input). */
export function readCandidateFile(path: string): string {
  if (!existsSync(path)) throw new Error(`No admission input at ${path}`);
  return readFileSync(path, "utf8");
}
