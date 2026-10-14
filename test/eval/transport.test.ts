import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { classifyRequest, PendingSubmissions, submissionKey } from "../../src/eval/transport/containment.js";
import { Pacer } from "../../src/eval/transport/pacer.js";
import { decideRobots, isAllowed, parseRobots } from "../../src/eval/robots.js";
import { FuzzyIndex, mergeHars, normalizeCacheBusters, type Har, type HarEntry } from "../../src/eval/transport/har.js";
import { createCaptureFetch, createReplayFetch, installFetch, fetchKey, type NodeFetchRecord } from "../../src/eval/transport/node-fetch.js";
import { EgressLog, installNodeEgressDenial, startDenyProxy } from "../../src/eval/transport/egress.js";
import { isDeclaredConnect, launchControlledBrowser, matchesDeclaredExclusion } from "../../src/eval/transport/browser.js";
import { loadEvalConfig } from "../../src/eval/config.js";
import { evalPaths } from "../../src/eval/paths.js";
import { setupRequestInterception } from "../../src/checks/forms/submission.js";
import { sha256 } from "../../src/eval/util.js";

const CONTRACT = { viewport: { width: 1024, height: 700, deviceScaleFactor: 1 }, locale: "en-US", timezone: "America/Denver", userAgent: "WCAGEngine-Eval/0.1 (+https://example.invalid)" };

describe("containment classification", () => {
  it("contains unsafe methods and announced form navigations only", () => {
    expect(classifyRequest({ method: "POST", isNavigation: true, url: "x" }, false)).toBe("contain-navigation");
    expect(classifyRequest({ method: "POST", isNavigation: false, url: "x" }, false)).toBe("contain-abort");
    expect(classifyRequest({ method: "put", isNavigation: false, url: "x" }, false)).toBe("contain-abort");
    expect(classifyRequest({ method: "GET", isNavigation: true, url: "x" }, true)).toBe("contain-navigation");
    expect(classifyRequest({ method: "GET", isNavigation: true, url: "x" }, false)).toBe("pass");
    expect(classifyRequest({ method: "GET", isNavigation: false, url: "x" }, true)).toBe("pass");
  });

  it("matches CDP and network URLs that differ by a trailing '?' and expires stale entries", () => {
    let now = 0;
    const p = new PendingSubmissions(1000, () => now);
    expect(submissionKey("http://a.test/self?")).toBe("http://a.test/self");
    p.add("http://a.test/self?");
    expect(p.take("http://a.test/self")).toBe(true);
    expect(p.take("http://a.test/self")).toBe(false);
    p.add("http://a.test/s?q=1");
    now = 5000;
    expect(p.take("http://a.test/s?q=1")).toBe(false);
  });
});

describe("pacing", () => {
  it("spaces top-level loads per host and lets a larger crawl-delay win", async () => {
    let now = 0;
    const waits: number[] = [];
    const pacer = new Pacer(3000, () => now, async (ms) => { waits.push(ms); now += ms; });
    await pacer.beforeTopLevel("https://a.test/1");
    now += 1000;
    await pacer.beforeTopLevel("https://a.test/2");
    await pacer.beforeTopLevel("https://b.test/1");
    pacer.setCrawlDelay("a.test", 10);
    await pacer.beforeTopLevel("https://a.test/3");
    expect(waits).toEqual([2000, 10000]);
    expect(pacer.minObservedGapMs()["a.test"]).toBeGreaterThanOrEqual(0);
  });
});

describe("robots (capture etiquette)", () => {
  const txt = [
    "User-agent: *", "Disallow: /private", "Allow: /private/ok", "Crawl-delay: 5", "",
    "User-agent: OtherBot", "Disallow: /", "", "Sitemap: https://a.test/sitemap.xml",
  ].join("\n");
  it("uses the wildcard group when our token has none, with longest-match precedence", () => {
    const p = parseRobots(txt);
    expect(p.group).toBe("wildcard");
    expect(p.crawlDelaySeconds).toBe(5);
    expect(isAllowed(p, "https://a.test/private/x")).toBe(false);
    expect(isAllowed(p, "https://a.test/private/ok/1")).toBe(true);
    expect(isAllowed(p, "https://a.test/public")).toBe(true);
    expect(p.sitemaps).toEqual(["https://a.test/sitemap.xml"]);
  });
  it("prefers a group naming our product token", () => {
    const p = parseRobots("User-agent: *\nDisallow:\n\nUser-agent: WCAGEngine-Eval\nDisallow: /fees$\nDisallow: /*.pdf\n");
    expect(p.group).toBe("product");
    expect(isAllowed(p, "https://a.test/fees")).toBe(false);
    expect(isAllowed(p, "https://a.test/fees/2026")).toBe(true);
    expect(isAllowed(p, "https://a.test/docs/a.pdf")).toBe(false);
  });
  it("skips the site on network errors and 5xx, allows on 4xx", () => {
    expect(decideRobots({ kind: "network-error", error: "ECONNRESET" }).usable).toBe(false);
    expect(decideRobots({ kind: "http-error", status: 503 }).usable).toBe(false);
    const absent = decideRobots({ kind: "http-error", status: 404 });
    expect(absent.usable && absent.policy.source).toBe("absent");
  });
});

function entry(url: string, body: string, status = 200, method = "GET"): HarEntry {
  return {
    startedDateTime: "2026-10-12T00:00:00Z",
    request: { method, url },
    response: { status, headers: [{ name: "content-type", value: "text/plain" }], content: { text: body, mimeType: "text/plain" } },
  };
}
function har(entries: HarEntry[]): Har {
  return { log: { version: "1.2", creator: { name: "t", version: "1" }, entries } };
}

describe("HAR merge and fuzzy matching", () => {
  it("merges deterministically, drops unservable entries and counts conflicts", () => {
    const failed = entry("https://a.test/post", "", 0, "POST");
    failed.response._failureText = "net::ERR_BLOCKED_BY_CLIENT";
    const { har: merged, stats } = mergeHars([
      { pageId: "p002", har: har([entry("https://a.test/app.js", "v2"), entry("https://a.test/b", "b")]) },
      { pageId: "p001", har: har([entry("https://a.test/app.js", "v1"), failed]) },
    ]);
    expect(merged.log.entries.map((e) => e.request.url)).toEqual(["https://a.test/app.js", "https://a.test/b"]);
    expect(merged.log.entries[0].response.content.text).toBe("v1");
    expect(stats.dropped_unservable).toBe(1);
    expect(stats.duplicates_conflicting).toBe(1);
  });

  it("matches cache-busted URLs only when exactly one recording fits", () => {
    expect(normalizeCacheBusters("https://a.test/x?_=1791847688586&id=3")).toBe("https://a.test/x?id=3");
    expect(normalizeCacheBusters("https://a.test/x?id=3")).toBeNull();
    const idx = new FuzzyIndex([entry("https://a.test/api?_=1700000000000", "one")]);
    expect(idx.lookup("GET", "https://a.test/api?_=1800000000000")?.response.content.text).toBe("one");
    const amb = new FuzzyIndex([entry("https://a.test/api?_=1700000000000", "one"), entry("https://a.test/api?_=1700000000001", "two")]);
    expect(amb.lookup("GET", "https://a.test/api?_=1800000000000")).toBeNull();
    expect(idx.lookup("POST", "https://a.test/api?_=1800000000000")).toBeNull();
  });

  it("declared exclusions match host suffixes and optional path prefixes", () => {
    expect(matchesDeclaredExclusion("https://www.google-analytics.com/g/collect", ["google-analytics.com"])).toBe(true);
    expect(matchesDeclaredExclusion("https://www.google.com/pagead/x", ["google.com/pagead"])).toBe(true);
    expect(matchesDeclaredExclusion("https://www.google.com/maps", ["google.com/pagead"])).toBe(false);
    expect(matchesDeclaredExclusion("https://notgoogle-analytics.com/", ["google-analytics.com"])).toBe(false);
  });
});

describe("Node fetch boundary", () => {
  let server: http.Server;
  let base: string;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/redir") { res.writeHead(302, { location: "/final" }); res.end(); return; }
      res.writeHead(200, { "content-type": "text/plain", "x-ua": String(req.headers["user-agent"]) });
      res.end(`body:${req.url}`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("records with the eval user agent, then replays the same response offline", async () => {
    const bodies = new Map<string, Buffer>();
    const records: NodeFetchRecord[] = [];
    const release = installFetch(createCaptureFetch({
      userAgent: "WCAGEngine-Eval/0.1 (+https://example.invalid)",
      storeBody: (b) => { const s = sha256(b); bodies.set(s, b); return s; },
      onRecord: (r) => records.push(r),
    }));
    try {
      const res = await fetch(`${base}/redir`);
      expect(await res.text()).toBe("body:/final");
      expect(res.headers.get("x-ua")).toContain("WCAGEngine-Eval");
      await expect(fetch(`${base}/x`, { method: "POST" })).rejects.toThrow(/refused/);
    } finally {
      release();
    }
    expect(records.map((r) => r.outcome)).toEqual(["response", "error"]);
    const misses: string[] = [];
    const release2 = installFetch(createReplayFetch({ records, loadBody: (s) => bodies.get(s)!, onEvent: () => {}, onMiss: (m, u) => misses.push(`${m} ${u}`) }));
    try {
      const res = await fetch(`${base}/redir`, { redirect: "follow" });
      expect(res.url).toBe(`${base}/final`);
      expect(res.redirected).toBe(true);
      expect(await res.text()).toBe("body:/final");
      await expect(fetch(`${base}/never-recorded`)).rejects.toThrow(/no recorded response/);
    } finally {
      release2();
    }
    expect(misses).toEqual([`GET ${base}/never-recorded`]);
    expect(fetchKey("get", `${base}/a#frag`)).toBe(`GET ${base}/a`);
  });

  it("socket denial records attempts even when the caller swallows the error", async () => {
    const log = new EgressLog();
    const release = installNodeEgressDenial(log);
    try {
      await new Promise<void>((resolve) => {
        const req = http.get(`${base}/denied`, () => resolve());
        req.on("error", () => resolve());
      });
    } finally {
      release();
    }
    expect(log.attempts).toHaveLength(1);
    expect(log.attempts[0].target).toContain("127.0.0.1");
    // Released: the server is reachable again
    const ok = await fetch(`${base}/after`).then((r) => r.status);
    expect(ok).toBe(200);
  });
});

describe("controlled browser (integration)", () => {
  let server: http.Server;
  let origin: string;
  let hits: string[];
  let dir: string;
  beforeAll(async () => {
    hits = [];
    dir = mkdtempSync(join(tmpdir(), "eval-transport-"));
    server = http.createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body><form id="g" action="/search" method="get"><input name="q" value="x"><button>Go</button></form>
        <form id="p" action="/post" method="post"><button id="pb">P</button></form>
        <script>window.ping=()=>fetch('/api',{method:'POST',body:'1'}).catch(()=>{});</script><p>page ${req.url}</p></body></html>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("captures under containment, then replays offline with misses and egress detected", async () => {
    const harPath = join(dir, "page.har");
    const cap = await launchControlledBrowser({ mode: "capture", contract: CONTRACT });
    try {
      const ctx = await cap.browser.newContext({ recordHar: { path: harPath, content: "embed", mode: "full" } });
      const page = await ctx.newPage();
      expect(cap.isTracked(page)).toBe(true);
      await page.goto(`${origin}/`);
      await page.click("#g button");
      await page.waitForTimeout(300);
      expect(page.url()).toBe(`${origin}/`);
      await page.evaluate(() => (window as unknown as { ping: () => void }).ping());
      await page.waitForTimeout(200);
      await page.goto(`${origin}/about`);
      await ctx.close();
    } finally {
      await cap.close();
    }
    expect(hits.filter((h) => h.startsWith("POST") || h.includes("/search"))).toEqual([]);
    expect(cap.counters.by_decision["contained-submission"]).toBeGreaterThanOrEqual(2);

    const rep = await launchControlledBrowser({ mode: "replay", contract: CONTRACT, harPath, declaredExclusions: [] });
    try {
      const ctx = await rep.browser.newContext();
      const page = await ctx.newPage();
      // The engine's interceptor continues GET documents; replay serves them
      await setupRequestInterception(page);
      const res = await page.goto(`${origin}/about`);
      expect(res?.status()).toBe(200);
      expect(await page.textContent("p")).toBe("page /about");
      // Math.random is seeded per document: every replay load draws the same sequence
      const draws = () => page.evaluate(() => [Math.random(), Math.random(), Math.random()]);
      const first = await draws();
      await page.goto(`${origin}/about`);
      expect(await draws()).toEqual(first);
      expect(new Set(first).size).toBe(3);
      await page.goto(`${origin}/not-captured`).catch(() => null);
      await ctx.close();
      // A context created around the boundary is caught by the deny proxy
      const raw = await rep.raw.newContext();
      const rp = await raw.newPage();
      await rp.goto(`${origin}/escape`, { timeout: 5000 }).catch(() => null);
      await raw.close();
    } finally {
      await rep.close();
    }
    expect(rep.counters.by_decision.miss).toBeGreaterThanOrEqual(1);
    expect(rep.egress.count()).toBeGreaterThanOrEqual(1);
    expect(hits.some((h) => h.includes("not-captured") || h.includes("escape"))).toBe(false);
  }, 60_000);
});

describe("fixture files exist for the pilot", () => {
  it("has the pilot pages", () => {
    const fx = join(import.meta.dirname, "..", "fixtures", "eval-pilot");
    for (const f of ["home.html", "contact.html", "about.html", "trap.html", "site.js", "site.css"]) {
      expect(readFileSync(join(fx, f), "utf8").length).toBeGreaterThan(0);
    }
  });
});

describe("declared exclusions v2 (first real-site replay)", () => {
  const config = loadEvalConfig(evalPaths(join(import.meta.dirname, "..", "..")).config);
  const patterns = config.declared_exclusions.host_suffixes;

  it("declares the per-load beacons and embed internals seen on tuning-v1, and media streams", () => {
    expect(config.declared_exclusions.version).toBe(2);
    expect(matchesDeclaredExclusion("https://www.google.com/ccm/collect?rnd=1", patterns)).toBe(true);
    expect(matchesDeclaredExclusion("https://www.google.com/rmkt/collect/1/?random=2", patterns)).toBe(true);
    expect(matchesDeclaredExclusion("https://www.instagram.com/ajax/bootloader-endpoint/", patterns)).toBe(true);
    expect(matchesDeclaredExclusion("https://scontent-phx1-1.cdninstagram.com/v/x.jpg", patterns)).toBe(true);
    expect(matchesDeclaredExclusion("https://www.google.com/recaptcha/api.js", patterns)).toBe(false);
    expect(matchesDeclaredExclusion("https://cdn.prod.website-files.com/site/css/site.css", patterns)).toBe(false);
    expect(config.declared_exclusions.resource_types).toEqual(["media"]);
  });

  it("a CONNECT counts as declared only when its host matches a declared pattern's host", () => {
    expect(isDeclaredConnect("www.instagram.com:443", patterns)).toBe(true);
    expect(isDeclaredConnect("analytics.google.com:443", patterns)).toBe(true);
    expect(isDeclaredConnect("www.google.com:443", patterns)).toBe(true);
    expect(isDeclaredConnect("cdn.prod.website-files.com:443", patterns)).toBe(false);
    expect(isDeclaredConnect("evil.example:443", patterns)).toBe(false);
    expect(isDeclaredConnect("notinstagram.com:443", patterns)).toBe(false);
  });
});

describe("deny proxy resilience", () => {
  it("survives a client that resets its CONNECT socket", async () => {
    const log = new EgressLog();
    const proxy = await startDenyProxy(log);
    const net = await import("node:net");
    await new Promise<void>((resolve) => {
      const sock = net.connect(proxy.port, "127.0.0.1", () => {
        sock.write("CONNECT www.instagram.com:443 HTTP/1.1\r\nHost: www.instagram.com:443\r\n\r\n");
        sock.resetAndDestroy();
        setTimeout(resolve, 100);
      });
      sock.on("error", () => {});
    });
    // The proxy still answers
    const status = await new Promise<number>((resolve) => {
      http.get({ host: "127.0.0.1", port: proxy.port, path: "http://example.test/" }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on("error", () => resolve(-1));
    });
    expect(status).toBe(403);
    await proxy.close();
  });
});
