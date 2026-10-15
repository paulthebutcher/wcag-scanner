import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitSites, normalizeDomain, parseCandidates, familyEvidence, selectPages, type FetchLike } from "../../src/eval/admit.js";
import { evalPaths, type EvalPaths } from "../../src/eval/paths.js";
import { loadEvalConfig } from "../../src/eval/config.js";
import { loadSitesPrivate } from "../../src/eval/corpus.js";
import { Pacer } from "../../src/eval/transport/pacer.js";

const REPO = join(import.meta.dirname, "..", "..");
const config = loadEvalConfig(join(REPO, "eval", "config.json"));
const SALT = "test-salt-0123456789abcdef";

const webflow = (extra = "", wf = "site-x") => `<html data-wf-site="${wf}" data-wf-page="p"><head><meta name="generator" content="Webflow"></head><body class="w-nav">${extra}</body></html>`;
const sites: Record<string, { robots?: string | number; home?: string | number; sitemap?: string }> = {
  "alpha.example": { robots: "User-agent: *\nDisallow:", home: webflow("<footer>Website by Civic Studio</footer>", "a1") },
  "beta.example": { robots: 404, home: webflow("<footer>Designed by Civic Studio</footer>", "b1") },
  "gamma.example": { robots: 503, home: webflow() },
  "delta.example": { robots: "User-agent: *\nDisallow: /", home: webflow() },
  "epsilon.example": { robots: 404, home: "<html><body>WordPress site</body></html>" },
  "zeta.example": { robots: 404, home: webflow("", "z1") },
  "eta.example": { robots: 404, home: webflow("", "z1") },
  "theta.example": { robots: 404, home: webflow("", "t1"), sitemap: "<urlset><url><loc>https://theta.example/pay-your-bill</loc></url><url><loc>https://theta.example/news/a</loc></url><url><loc>https://theta.example/news/b</loc></url><url><loc>https://theta.example/about</loc></url><url><loc>https://theta.example/private/x</loc></url></urlset>" },
};
const calls: string[] = [];
const fakeFetch: FetchLike = async (url, init) => {
  calls.push(`${url} ${init?.headers?.["user-agent"] ?? ""}`);
  const u = new URL(url);
  const s = sites[u.hostname];
  const respond = (v: string | number | undefined) => ({ ok: typeof v === "string", status: typeof v === "number" ? v : v === undefined ? 404 : 200, url, text: async () => (typeof v === "string" ? v : "") });
  if (!s) throw new Error("ENOTFOUND");
  if (u.pathname === "/robots.txt") return respond(u.hostname === "theta.example" ? "User-agent: *\nDisallow: /private\nSitemap: https://theta.example/sitemap.xml" : s.robots);
  if (u.pathname === "/sitemap.xml") return respond(s.sitemap);
  return respond(s.home);
};

let tmp: string;
let paths: EvalPaths;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "eval-admit-"));
  mkdirSync(join(tmp, "repo", "eval"), { recursive: true });
  copyFileSync(join(REPO, "eval", "config.json"), join(tmp, "repo", "eval", "config.json"));
  paths = evalPaths(join(tmp, "repo"), join(tmp, "data"));
  calls.length = 0;
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("admission (D1b)", () => {
  it("normalises and deduplicates domains and reads a family column", () => {
    expect(normalizeDomain("HTTPS://www.City.Example/path?x=1")).toBe("city.example");
    expect(normalizeDomain("not a domain")).toBeNull();
    const { candidates, duplicates } = parseCandidates("Domain,Agency\nwww.a.example,Civic Studio\nhttps://a.example/,x\nb.example,\n");
    expect(candidates).toEqual([{ domain: "a.example", family_hint: "civic studio" }, { domain: "b.example", family_hint: null }]);
    expect(duplicates).toBe(1);
  });

  it("reads agency credits and Webflow site ids as family evidence", () => {
    expect(familyEvidence(webflow("<p>Website by <a href='#'>Civic Studio</a></p>", "w9"))).toEqual({ agency: "civic studio", webflowSite: "w9" });
  });

  it("confirms Webflow under etiquette, rejects with reasons, groups families and freezes salted splits", async () => {
    const csv = Object.keys(sites).join("\n");
    const ua = "WCAGEngine-Eval/0.1 (+https://example.invalid)";
    const r = await admitSites({ paths, config, csv, salt: SALT, userAgent: ua, fetchImpl: fakeFetch, paceMs: 0 });
    const reason = (d: string) => r.decisions.find((x) => x.domain === d)?.reason;
    expect(reason("gamma.example")).toContain("HTTP 503");
    expect(reason("delta.example")).toBe("home page disallowed by robots.txt");
    expect(reason("epsilon.example")).toBe("not detected as Webflow");
    expect([reason("zeta.example"), reason("eta.example")].filter((x) => x?.startsWith("same Webflow site"))).toHaveLength(1);
    expect(calls.every((c) => c.endsWith(ua))).toBe(true);
    // robots is fetched before the home page for every site
    expect(calls.indexOf("https://alpha.example/robots.txt " + ua)).toBeLessThan(calls.indexOf("https://alpha.example/ " + ua));

    const registry = loadSitesPrivate(paths).sites;
    const alpha = registry.find((s) => s.domain === "alpha.example")!;
    const beta = registry.find((s) => s.domain === "beta.example")!;
    expect(alpha.family).toBe("agency:civic studio");
    expect(beta.family).toBe(alpha.family);
    expect(beta.split).toBe(alpha.split); // a family stays in one split
    const families = r.families.length;
    expect(r.families.filter((f) => f.split === "holdout")).toHaveLength(Math.ceil(families / 3));
    expect(registry.every((s) => /^m\d{2}$/.test(s.site_id))).toBe(true);
    expect(r.enough_sites).toBe(false);

    // Re-running never reassigns
    const before = JSON.stringify(loadSitesPrivate(paths));
    const again = await admitSites({ paths, config, csv, salt: SALT, userAgent: ua, fetchImpl: fakeFetch, paceMs: 0 });
    expect(again.newly_assigned).toEqual([]);
    expect(JSON.stringify(loadSitesPrivate(paths))).toBe(before);
    await expect(admitSites({ paths, config, csv, salt: "short", userAgent: ua, fetchImpl: fakeFetch, paceMs: 0 })).rejects.toThrow(/salt/);
  });

  it("selects pages before scoring: home, key tasks, one per collection, robots respected, capped", async () => {
    const site = { site_id: "m01", domain: "theta.example", root_url: "https://theta.example/", family: null, split: "dev" as const, pages: [] };
    const sel = await selectPages(site, { fetchImpl: fakeFetch, userAgent: "ua", maxPages: 4, pacer: new Pacer(0) });
    expect(sel.pages[0]).toBe("https://theta.example/");
    expect(sel.pages).toEqual(expect.arrayContaining(["https://theta.example/pay-your-bill", "https://theta.example/news/a"]));
    expect(sel.pages).not.toContain("https://theta.example/private/x");
    expect(sel.pages).toHaveLength(4);
    expect(sel.omitted.map((o) => o.reason)).toEqual(expect.arrayContaining(["disallowed by robots.txt", "over the 4-page cap"]));
  });
});
