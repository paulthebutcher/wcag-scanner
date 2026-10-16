import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser } from "playwright";
import type { AddressInfo } from "node:net";
import { crawl } from "../../src/core/crawler.js";
import { LocalFileStore } from "../../src/store/files.js";
import { Pacer } from "../../src/core/pacer.js";
import { productUserAgent } from "../../src/core/etiquette.js";
import { setupRequestInterception } from "../../src/checks/forms/submission.js";

interface Hit { path: string; ua: string | undefined; at: number; method: string }

describe("production scan etiquette in the crawler (P2-007) and GET containment (P2-006)", () => {
  let server: Server;
  let browser: Browser;
  let origin = "";
  let tmpDir = "";
  let robots: { status: number; body: string } = { status: 404, body: "" };
  const hits: Hit[] = [];
  const lines: string[] = [];
  const reporter = { update: () => {}, complete: (_p: string, m: string) => { lines.push(m); }, warn: (_p: string, m: string) => { lines.push(m); } };

  const page = (name: string) => `<!DOCTYPE html><html lang="en"><head><title>${name}</title></head><body><h1>${name}</h1>
    <a href="/public">public</a> <a href="/private/secret">private</a>
    <form id="get-form" method="get" action="/search"><label for="q">Query</label><input id="q" name="q" required><button type="submit">Go</button></form>
    <form id="post-form" method="post" action="/send"><label for="e">Email</label><input id="e" name="e" type="email" required><button type="submit">Send</button></form>
    </body></html>`;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
      const path = req.url ?? "/";
      hits.push({ path, ua: req.headers["user-agent"], at: Date.now(), method: req.method ?? "" });
      if (path === "/robots.txt") { res.statusCode = robots.status; res.setHeader("Content-Type", "text/plain"); res.end(robots.body); return; }
      if (path === "/favicon.ico") { res.statusCode = 404; res.end(); return; }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(page(path));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true });
    tmpDir = mkdtempSync(join(tmpdir(), "wcag-etiquette-"));
  });
  afterAll(async () => {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(tmpDir, { recursive: true, force: true });
  });
  beforeEach(() => { hits.length = 0; lines.length = 0; });

  const options = () => ({ scanSessionId: "s", fileStore: new LocalFileStore(tmpDir), timeoutMs: 10_000, idleTimeoutMs: 500, reporter, robots: "strict" as const });

  it("a fixed URL list is filtered by robots.txt: disallowed URLs are skipped and logged", async () => {
    robots = { status: 200, body: "User-agent: *\nDisallow: /private/\n" };
    const result = await crawl(`${origin}/`, { ...options(), urlList: [`${origin}/public`, `${origin}/private/secret`] }, browser);
    expect(result.snapshots.map((s) => new URL(s.url).pathname)).toEqual(["/public"]);
    expect(result.excludedByRobots).toEqual([`${origin}/private/secret`]);
    expect(result.robots).toMatchObject({ source: "parsed", status: 200, group: "wildcard", rules: 1, crawl_delay_seconds: null });
    expect(lines).toContain(`Skipped by robots.txt: ${origin}/private/secret`);
    expect(lines.some((l) => l.startsWith("robots.txt: 1 rule(s) for the wildcard group"))).toBe(true);
    expect(hits.some((h) => h.path === "/private/secret")).toBe(false);
  }, 30_000);

  it("a robots.txt server error refuses the scan; a 404 means no restrictions", async () => {
    robots = { status: 503, body: "" };
    await expect(crawl(`${origin}/`, { ...options(), urlList: [`${origin}/public`] }, browser)).rejects.toThrow(/robots\.txt returned HTTP 503.*Refusing to scan/);
    // Only the root redirect probe and robots.txt were requested; no page was loaded
    expect(hits.map((h) => h.path).sort()).toEqual(["/", "/robots.txt"]);
    robots = { status: 404, body: "" };
    const result = await crawl(`${origin}/`, { ...options(), urlList: [`${origin}/private/secret`] }, browser);
    expect(result.snapshots).toHaveLength(1);
    expect(result.robots).toMatchObject({ source: "absent", status: 404 });
  }, 30_000);

  it("sends the identifying user agent on robots.txt and page loads, and paces top-level loads per host (crawl-delay wins)", async () => {
    robots = { status: 200, body: "User-agent: *\nCrawl-delay: 1\n" };
    const ua = productUserAgent("https://example.test/scanner");
    const pacer = new Pacer(300);
    const result = await crawl(`${origin}/`, { ...options(), userAgent: ua, pacer, urlList: [`${origin}/a`, `${origin}/b`, `${origin}/c`], concurrency: 3 }, browser);
    expect(result.snapshots).toHaveLength(3);
    expect(hits.find((h) => h.path === "/robots.txt")?.ua).toBe(ua);
    expect(hits.find((h) => h.path === "/")?.ua).toBe(ua); // the root redirect probe
    for (const h of hits.filter((h) => ["/a", "/b", "/c"].includes(h.path))) expect(h.ua).toBe(ua);
    // Crawl-delay 1 s beats the 300 ms minimum
    expect(pacer.intervalFor(new URL(origin).host)).toBe(1000);
    const docLoads = hits.filter((h) => ["/a", "/b", "/c"].includes(h.path)).map((h) => h.at).sort((x, y) => x - y);
    expect(docLoads).toHaveLength(3);
    for (let i = 1; i < docLoads.length; i++) expect(docLoads[i] - docLoads[i - 1]).toBeGreaterThanOrEqual(950);
    expect(pacer.log).toHaveLength(3);
    expect(lines.some((l) => l.includes("crawl-delay 1s") && l.includes("paced 1000 ms apart"))).toBe(true);
  }, 30_000);

  it("the submission interceptor contains a GET form's navigation and still blocks POST", async () => {
    robots = { status: 404, body: "" };
    const context = await browser.newContext();
    const p = await context.newPage();
    try {
      await p.goto(`${origin}/form`, { waitUntil: "load" });
      const { interceptedRequests, cleanup } = await setupRequestInterception(p);
      try {
        await p.fill("#q", "hello");
        await p.click("#get-form button");
        await p.waitForTimeout(400);
        expect(p.url()).toBe(`${origin}/form`);
        expect(interceptedRequests.map((r) => [r.method, new URL(r.url).pathname])).toEqual([["GET", "/search"]]);
        expect(hits.some((h) => h.path.startsWith("/search"))).toBe(false);
        await p.fill("#e", "a@b.test");
        await p.click("#post-form button");
        await p.waitForTimeout(400);
        expect(p.url()).toBe(`${origin}/form`);
        expect(interceptedRequests.map((r) => [r.method, new URL(r.url).pathname])).toEqual([["GET", "/search"], ["POST", "/send"]]);
        expect(hits.some((h) => h.path === "/send")).toBe(false);
      } finally {
        await cleanup();
      }
      // After cleanup, navigation works again
      await p.goto(`${origin}/public`, { waitUntil: "load" });
      expect(p.url()).toBe(`${origin}/public`);
    } finally {
      await context.close();
    }
  }, 30_000);
});
