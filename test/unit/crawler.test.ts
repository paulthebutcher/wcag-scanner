import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
} from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser } from "playwright";
import {
  normalizeUrl,
  isSameOrigin,
  extractSitemapLocs,
  isSitemapIndex,
  parseRobotsTxt,
  isAllowedByRobots,
  getCollectionPrefix,
  detectCMSCollections,
  sampleCollectionUrls,
  crawl,
} from "../../src/core/crawler.js";
import { LocalFileStore } from "../../src/store/files.js";

// ---------------------------------------------------------------------------
// normalizeUrl — pure function tests
// ---------------------------------------------------------------------------

describe("normalizeUrl", () => {
  const base = "http://example.com/page";

  it("resolves relative links", () => {
    expect(normalizeUrl("/about", base)).toBe("http://example.com/about");
    expect(normalizeUrl("sub", base)).toBe("http://example.com/sub");
  });

  it("resolves absolute links", () => {
    expect(normalizeUrl("http://example.com/contact", base)).toBe(
      "http://example.com/contact",
    );
  });

  it("strips fragments", () => {
    expect(normalizeUrl("/page#section", base)).toBe(
      "http://example.com/page",
    );
  });

  it("strips trailing slash on non-root paths", () => {
    expect(normalizeUrl("/about/", base)).toBe("http://example.com/about");
  });

  it("preserves trailing slash on root path", () => {
    expect(normalizeUrl("/", base)).toBe("http://example.com/");
  });

  it("preserves query params", () => {
    expect(normalizeUrl("/search?q=test", base)).toBe(
      "http://example.com/search?q=test",
    );
  });

  it("returns null for mailto links", () => {
    expect(normalizeUrl("mailto:a@b.com", base)).toBeNull();
  });

  it("returns null for tel links", () => {
    expect(normalizeUrl("tel:+1234567890", base)).toBeNull();
  });

  it("returns null for javascript: hrefs", () => {
    expect(normalizeUrl("javascript:void(0)", base)).toBeNull();
  });

  it("returns null for data: URLs", () => {
    expect(normalizeUrl("data:text/html,hi", base)).toBeNull();
  });

  it("returns null for empty strings", () => {
    expect(normalizeUrl("", base)).toBeNull();
    expect(normalizeUrl("   ", base)).toBeNull();
  });

  it("returns null for blob: URLs", () => {
    expect(normalizeUrl("blob:http://example.com/abc", base)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isSameOrigin — pure function tests
// ---------------------------------------------------------------------------

describe("isSameOrigin", () => {
  it("returns true for same origin", () => {
    expect(
      isSameOrigin("http://example.com/about", "http://example.com"),
    ).toBe(true);
  });

  it("returns false for different host", () => {
    expect(
      isSameOrigin("http://other.com/about", "http://example.com"),
    ).toBe(false);
  });

  it("returns false for different protocol", () => {
    expect(
      isSameOrigin("https://example.com/about", "http://example.com"),
    ).toBe(false);
  });

  it("returns false for different port", () => {
    expect(
      isSameOrigin("http://example.com:8080/about", "http://example.com"),
    ).toBe(false);
  });

  it("returns false for invalid URLs", () => {
    expect(isSameOrigin("not-a-url", "http://example.com")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractSitemapLocs — pure function tests
// ---------------------------------------------------------------------------

describe("extractSitemapLocs", () => {
  it("extracts URLs from a regular sitemap", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://example.com/</loc></url>
  <url><loc>http://example.com/about</loc></url>
  <url><loc>http://example.com/contact</loc></url>
</urlset>`;
    expect(extractSitemapLocs(xml)).toEqual([
      "http://example.com/",
      "http://example.com/about",
      "http://example.com/contact",
    ]);
  });

  it("extracts URLs from a sitemap index", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>http://example.com/sitemap-pages.xml</loc></sitemap>
  <sitemap><loc>http://example.com/sitemap-blog.xml</loc></sitemap>
</sitemapindex>`;
    expect(extractSitemapLocs(xml)).toEqual([
      "http://example.com/sitemap-pages.xml",
      "http://example.com/sitemap-blog.xml",
    ]);
  });

  it("handles whitespace around loc values", () => {
    const xml = `<urlset><url><loc>
      http://example.com/page
    </loc></url></urlset>`;
    expect(extractSitemapLocs(xml)).toEqual(["http://example.com/page"]);
  });

  it("returns empty array for invalid XML", () => {
    expect(extractSitemapLocs("not xml at all")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isSitemapIndex — pure function tests
// ---------------------------------------------------------------------------

describe("isSitemapIndex", () => {
  it("returns true for sitemap index", () => {
    expect(isSitemapIndex('<sitemapindex xmlns="...">')).toBe(true);
  });

  it("returns true for sitemap index without attributes", () => {
    expect(isSitemapIndex("<sitemapindex>")).toBe(true);
  });

  it("returns false for regular sitemap", () => {
    expect(isSitemapIndex('<urlset xmlns="...">')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseRobotsTxt — pure function tests
// ---------------------------------------------------------------------------

describe("parseRobotsTxt", () => {
  it("parses disallow paths for wildcard user-agent", () => {
    const txt = `User-agent: *
Disallow: /admin/
Disallow: /private/
`;
    const rules = parseRobotsTxt(txt);
    expect(rules.disallowedPaths).toEqual(["/admin/", "/private/"]);
  });

  it("extracts Sitemap directives", () => {
    const txt = `User-agent: *
Disallow: /admin/
Sitemap: http://example.com/sitemap.xml
Sitemap: http://example.com/sitemap-blog.xml
`;
    const rules = parseRobotsTxt(txt);
    expect(rules.sitemapUrls).toEqual([
      "http://example.com/sitemap.xml",
      "http://example.com/sitemap-blog.xml",
    ]);
  });

  it("ignores Disallow for non-wildcard agents", () => {
    const txt = `User-agent: Googlebot
Disallow: /google-only/

User-agent: *
Disallow: /admin/
`;
    const rules = parseRobotsTxt(txt);
    expect(rules.disallowedPaths).toEqual(["/admin/"]);
  });

  it("handles empty disallow values", () => {
    const txt = `User-agent: *
Disallow:
`;
    const rules = parseRobotsTxt(txt);
    expect(rules.disallowedPaths).toEqual([]);
  });

  it("skips comment lines", () => {
    const txt = `# This is a comment
User-agent: *
# Another comment
Disallow: /secret/
`;
    const rules = parseRobotsTxt(txt);
    expect(rules.disallowedPaths).toEqual(["/secret/"]);
  });

  it("returns empty rules for empty content", () => {
    const rules = parseRobotsTxt("");
    expect(rules.disallowedPaths).toEqual([]);
    expect(rules.sitemapUrls).toEqual([]);
  });

  it("handles Sitemap URLs containing colons", () => {
    const txt = `Sitemap: https://example.com:8080/sitemap.xml`;
    const rules = parseRobotsTxt(txt);
    expect(rules.sitemapUrls).toEqual(["https://example.com:8080/sitemap.xml"]);
  });
});

// ---------------------------------------------------------------------------
// isAllowedByRobots — pure function tests
// ---------------------------------------------------------------------------

describe("isAllowedByRobots", () => {
  const disallowed = ["/admin/", "/private/", "/tmp"];

  it("allows paths not matching any disallow", () => {
    expect(isAllowedByRobots("/about", disallowed)).toBe(true);
    expect(isAllowedByRobots("/", disallowed)).toBe(true);
  });

  it("blocks paths starting with a disallowed prefix", () => {
    expect(isAllowedByRobots("/admin/", disallowed)).toBe(false);
    expect(isAllowedByRobots("/admin/settings", disallowed)).toBe(false);
    expect(isAllowedByRobots("/private/data", disallowed)).toBe(false);
  });

  it("blocks exact prefix matches", () => {
    expect(isAllowedByRobots("/tmp", disallowed)).toBe(false);
    expect(isAllowedByRobots("/tmpfile", disallowed)).toBe(false);
  });

  it("allows all when disallowed list is empty", () => {
    expect(isAllowedByRobots("/anything", [])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// crawl — integration test with fixture server (link-following)
// ---------------------------------------------------------------------------

const FIXTURE_PAGES: Record<string, string> = {
  "/": `<!DOCTYPE html><html><head><title>Home</title></head><body>
    <a href="/about">About</a>
    <a href="/contact">Contact</a>
    <a href="/blog">Blog</a>
    <a href="/services">Services</a>
    <a href="/team">Team</a>
    <a href="https://external-site.com">External</a>
    <a href="mailto:test@example.com">Email</a>
    <a href="tel:+15551234567">Phone</a>
    <a href="javascript:void(0)">JS link</a>
    <a href="#section-two">Fragment</a>
    <a href="/about/">Trailing slash dupe</a>
    <a href="/about#intro">Fragment dupe</a>
  </body></html>`,
  "/about": `<!DOCTYPE html><html><head><title>About</title></head><body>
    <h1>About</h1><a href="/">Home</a>
  </body></html>`,
  "/contact": `<!DOCTYPE html><html><head><title>Contact</title></head><body>
    <h1>Contact</h1><a href="/">Home</a>
  </body></html>`,
  "/blog": `<!DOCTYPE html><html><head><title>Blog</title></head><body>
    <h1>Blog</h1><a href="/">Home</a>
  </body></html>`,
  "/services": `<!DOCTYPE html><html><head><title>Services</title></head><body>
    <h1>Services</h1><a href="/about">About</a>
  </body></html>`,
  "/team": `<!DOCTYPE html><html><head><title>Team</title></head><body>
    <h1>Team</h1>
  </body></html>`,
};

describe("crawl (link-following)", () => {
  let server: Server;
  let port: number;
  let tmpDir: string;
  let browser: Browser;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const html = FIXTURE_PAGES[req.url ?? "/"];
      if (html) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    tmpDir = mkdtempSync(join(tmpdir(), "wcag-crawl-test-"));
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }, 15_000);

  it("discovers all 5 internal links from root page", async () => {
    const fileStore = new LocalFileStore(tmpDir);
    const snapshots = await crawl(
      `http://127.0.0.1:${port}/`,
      {
        scanSessionId: "test-scan",
        fileStore,
        maxPages: 50,
        timeoutMs: 10_000,
      },
      browser,
    );

    expect(snapshots).toHaveLength(6);
    const urls = snapshots.map((s) => new URL(s.url).pathname).sort();
    expect(urls).toEqual(["/", "/about", "/blog", "/contact", "/services", "/team"]);
  }, 30_000);

  it("respects maxPages limit", async () => {
    const fileStore = new LocalFileStore(tmpDir);
    const snapshots = await crawl(
      `http://127.0.0.1:${port}/`,
      {
        scanSessionId: "test-limit",
        fileStore,
        maxPages: 3,
        timeoutMs: 10_000,
      },
      browser,
    );

    expect(snapshots).toHaveLength(3);
  }, 30_000);

  it("deduplicates URLs with trailing slash and fragments", async () => {
    const fileStore = new LocalFileStore(tmpDir);
    const snapshots = await crawl(
      `http://127.0.0.1:${port}/`,
      {
        scanSessionId: "test-dedup",
        fileStore,
        maxPages: 50,
        timeoutMs: 10_000,
      },
      browser,
    );

    const aboutCount = snapshots.filter(
      (s) => new URL(s.url).pathname === "/about",
    ).length;
    expect(aboutCount).toBe(1);
  }, 30_000);

  it("captures title, DOM, screenshot, viewport for each page", async () => {
    const fileStore = new LocalFileStore(tmpDir);
    const snapshots = await crawl(
      `http://127.0.0.1:${port}/`,
      {
        scanSessionId: "test-capture",
        fileStore,
        maxPages: 2,
        timeoutMs: 10_000,
      },
      browser,
    );

    for (const snap of snapshots) {
      expect(snap.id).toBeTruthy();
      expect(snap.scan_session_id).toBe("test-capture");
      expect(snap.title).toBeTruthy();
      expect(snap.full_dom).toContain("</html>");
      expect(snap.screenshot).toBeTruthy();
      expect(snap.captured_at).toBeTruthy();
      expect(snap.viewport.width).toBe(1280);
      expect(snap.viewport.height).toBe(800);
    }
  }, 30_000);

  it("does not follow external links", async () => {
    const fileStore = new LocalFileStore(tmpDir);
    const snapshots = await crawl(
      `http://127.0.0.1:${port}/`,
      {
        scanSessionId: "test-external",
        fileStore,
        maxPages: 50,
        timeoutMs: 10_000,
      },
      browser,
    );

    const hosts = snapshots.map((s) => new URL(s.url).hostname);
    expect(hosts.every((h) => h === "127.0.0.1")).toBe(true);
  }, 30_000);

  it("skips pages that timeout with a warning", async () => {
    const slowServer = createServer((req, res) => {
      if (req.url === "/slow") {
        // Never respond — simulate a timeout
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html><html><head><title>Slow Root</title></head><body>
        <a href="/slow">Slow Page</a>
      </body></html>`);
    });
    await new Promise<void>((resolve) => {
      slowServer.listen(0, "127.0.0.1", resolve);
    });
    const slowAddr = slowServer.address();
    const slowPort = typeof slowAddr === "object" && slowAddr ? slowAddr.port : 0;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const fileStore = new LocalFileStore(tmpDir);
    const snapshots = await crawl(
      `http://127.0.0.1:${slowPort}/`,
      {
        scanSessionId: "test-timeout",
        fileStore,
        maxPages: 50,
        timeoutMs: 2_000,
      },
      browser,
    );

    expect(snapshots).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMsg).toContain("[crawler] Skipping");

    warnSpy.mockRestore();
    slowServer.close();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// crawl — integration test with sitemap + robots.txt
// ---------------------------------------------------------------------------

function buildSitemapFixtures(port: number) {
  const pageNames = Array.from({ length: 9 }, (_, i) => `/page-${i + 1}`);

  // Root only links to /page-1 — the other 8 are only reachable via sitemap
  const pages: Record<string, string> = {
    "/": `<!DOCTYPE html><html><head><title>Sitemap Root</title></head><body>
      <a href="/page-1">Page 1</a>
    </body></html>`,
  };
  for (const name of pageNames) {
    pages[name] = `<!DOCTYPE html><html><head><title>${name}</title></head><body>
      <h1>${name}</h1>
    </body></html>`;
  }

  // Sitemap with 10 URLs (root + 9 pages)
  const allUrls = ["/", ...pageNames];
  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${allUrls.map((p) => `  <url><loc>http://127.0.0.1:${port}${p}</loc></url>`).join("\n")}
</urlset>`;

  const robotsTxt = `User-agent: *
Disallow:

Sitemap: http://127.0.0.1:${port}/sitemap.xml
`;

  return { pages, sitemapXml, robotsTxt };
}

describe("crawl (sitemap)", () => {
  let server: Server;
  let port: number;
  let tmpDir: string;
  let browser: Browser;
  let fixtures: ReturnType<typeof buildSitemapFixtures>;

  beforeAll(async () => {
    // We need the port before building fixtures — use a two-step approach
    server = createServer(/* placeholder handler */);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    fixtures = buildSitemapFixtures(port);

    // Close placeholder and re-create with real handler
    server.close();
    server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/sitemap.xml") {
        res.writeHead(200, { "Content-Type": "application/xml" });
        res.end(fixtures.sitemapXml);
      } else if (url === "/robots.txt") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(fixtures.robotsTxt);
      } else if (fixtures.pages[url]) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(fixtures.pages[url]);
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(port, "127.0.0.1", resolve);
    });

    tmpDir = mkdtempSync(join(tmpdir(), "wcag-sitemap-test-"));
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }, 15_000);

  it("discovers all 10 sitemap URLs in crawl results", async () => {
    const fileStore = new LocalFileStore(tmpDir);
    const snapshots = await crawl(
      `http://127.0.0.1:${port}/`,
      {
        scanSessionId: "test-sitemap",
        fileStore,
        maxPages: 50,
        timeoutMs: 10_000,
      },
      browser,
    );

    // 10 URLs in sitemap: /, /page-1 ... /page-9
    expect(snapshots).toHaveLength(10);

    const paths = snapshots.map((s) => new URL(s.url).pathname).sort();
    expect(paths).toEqual([
      "/",
      "/page-1",
      "/page-2",
      "/page-3",
      "/page-4",
      "/page-5",
      "/page-6",
      "/page-7",
      "/page-8",
      "/page-9",
    ]);
  }, 30_000);

  it("does not visit pages disallowed by robots.txt", async () => {
    // Override robots.txt to disallow /page-5 and /page-6
    const origRobots = fixtures.robotsTxt;
    fixtures.robotsTxt = `User-agent: *
Disallow: /page-5
Disallow: /page-6
`;

    const fileStore = new LocalFileStore(tmpDir);
    const snapshots = await crawl(
      `http://127.0.0.1:${port}/`,
      {
        scanSessionId: "test-robots",
        fileStore,
        maxPages: 50,
        timeoutMs: 10_000,
      },
      browser,
    );

    const paths = snapshots.map((s) => new URL(s.url).pathname);
    expect(paths).not.toContain("/page-5");
    expect(paths).not.toContain("/page-6");
    expect(snapshots).toHaveLength(8);

    // Restore
    fixtures.robotsTxt = origRobots;
  }, 30_000);
});

// ---------------------------------------------------------------------------
// crawl — integration test with sitemap index
// ---------------------------------------------------------------------------

describe("crawl (sitemap index)", () => {
  let server: Server;
  let port: number;
  let tmpDir: string;
  let browser: Browser;

  beforeAll(async () => {
    server = createServer(/* placeholder */);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    const pages: Record<string, string> = {};
    for (let i = 1; i <= 4; i++) {
      pages[`/idx-${i}`] = `<!DOCTYPE html><html><head><title>Idx ${i}</title></head><body><h1>Idx ${i}</h1></body></html>`;
    }

    const childSitemap1 = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://127.0.0.1:${port}/idx-1</loc></url>
  <url><loc>http://127.0.0.1:${port}/idx-2</loc></url>
</urlset>`;

    const childSitemap2 = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://127.0.0.1:${port}/idx-3</loc></url>
  <url><loc>http://127.0.0.1:${port}/idx-4</loc></url>
</urlset>`;

    const sitemapIndex = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>http://127.0.0.1:${port}/sitemap-a.xml</loc></sitemap>
  <sitemap><loc>http://127.0.0.1:${port}/sitemap-b.xml</loc></sitemap>
</sitemapindex>`;

    server.close();
    server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/sitemap.xml") {
        res.writeHead(200, { "Content-Type": "application/xml" });
        res.end(sitemapIndex);
      } else if (url === "/sitemap-a.xml") {
        res.writeHead(200, { "Content-Type": "application/xml" });
        res.end(childSitemap1);
      } else if (url === "/sitemap-b.xml") {
        res.writeHead(200, { "Content-Type": "application/xml" });
        res.end(childSitemap2);
      } else if (url === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html><html><head><title>Index Root</title></head><body><h1>Root</h1></body></html>`);
      } else if (pages[url]) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(pages[url]);
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(port, "127.0.0.1", resolve);
    });

    tmpDir = mkdtempSync(join(tmpdir(), "wcag-sitemapidx-test-"));
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }, 15_000);

  it("follows sitemap index to child sitemaps and discovers all pages", async () => {
    const fileStore = new LocalFileStore(tmpDir);
    const snapshots = await crawl(
      `http://127.0.0.1:${port}/`,
      {
        scanSessionId: "test-idx",
        fileStore,
        maxPages: 50,
        timeoutMs: 10_000,
      },
      browser,
    );

    // root + 4 pages from two child sitemaps
    expect(snapshots).toHaveLength(5);
    const paths = snapshots.map((s) => new URL(s.url).pathname).sort();
    expect(paths).toEqual(["/", "/idx-1", "/idx-2", "/idx-3", "/idx-4"]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// getCollectionPrefix — pure function tests
// ---------------------------------------------------------------------------

describe("getCollectionPrefix", () => {
  it("returns prefix for 2-segment paths", () => {
    expect(getCollectionPrefix("http://example.com/blog/my-post")).toBe("/blog");
  });

  it("returns prefix for 3+ segment paths", () => {
    expect(getCollectionPrefix("http://example.com/team/engineering/alice")).toBe("/team");
  });

  it("returns null for root path", () => {
    expect(getCollectionPrefix("http://example.com/")).toBeNull();
  });

  it("returns null for single-segment paths", () => {
    expect(getCollectionPrefix("http://example.com/about")).toBeNull();
  });

  it("handles trailing slashes", () => {
    expect(getCollectionPrefix("http://example.com/blog/post/")).toBe("/blog");
  });

  it("returns null for invalid URLs", () => {
    expect(getCollectionPrefix("not a url")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectCMSCollections — pure function tests
// ---------------------------------------------------------------------------

describe("detectCMSCollections", () => {
  it("groups 50 /blog/* URLs into one collection", () => {
    const urls = Array.from({ length: 50 }, (_, i) =>
      `http://example.com/blog/post-${i + 1}`,
    );
    const collections = detectCMSCollections(urls);
    expect(collections).toHaveLength(1);
    expect(collections[0].prefix).toBe("/blog");
    expect(collections[0].urls).toHaveLength(50);
  });

  it("groups multiple collections separately", () => {
    const urls = [
      "http://example.com/blog/post-1",
      "http://example.com/blog/post-2",
      "http://example.com/blog/post-3",
      "http://example.com/team/alice",
      "http://example.com/team/bob",
      "http://example.com/team/charlie",
    ];
    const collections = detectCMSCollections(urls);
    expect(collections).toHaveLength(2);
    const prefixes = collections.map((c) => c.prefix).sort();
    expect(prefixes).toEqual(["/blog", "/team"]);
  });

  it("ignores single-segment paths (non-collection pages)", () => {
    const urls = [
      "http://example.com/about",
      "http://example.com/contact",
      "http://example.com/blog/post-1",
      "http://example.com/blog/post-2",
    ];
    const collections = detectCMSCollections(urls);
    expect(collections).toHaveLength(1);
    expect(collections[0].prefix).toBe("/blog");
  });

  it("requires minSize URLs to form a collection (default 2)", () => {
    const urls = [
      "http://example.com/blog/only-one-post",
    ];
    const collections = detectCMSCollections(urls);
    expect(collections).toHaveLength(0);
  });

  it("respects custom minSize", () => {
    const urls = [
      "http://example.com/blog/post-1",
      "http://example.com/blog/post-2",
    ];
    expect(detectCMSCollections(urls, null, 3)).toHaveLength(0);
    expect(detectCMSCollections(urls, null, 2)).toHaveLength(1);
  });

  it("filters by cmsPattern when provided", () => {
    const urls = [
      "http://example.com/blog/post-1",
      "http://example.com/blog/post-2",
      "http://example.com/team/alice",
      "http://example.com/team/bob",
    ];
    // Only match /blog/* paths
    const collections = detectCMSCollections(urls, /^\/blog\//);
    expect(collections).toHaveLength(1);
    expect(collections[0].prefix).toBe("/blog");
  });

  it("returns empty when cmsPattern matches no URLs", () => {
    const urls = [
      "http://example.com/blog/post-1",
      "http://example.com/blog/post-2",
    ];
    const collections = detectCMSCollections(urls, /^\/products\//);
    expect(collections).toHaveLength(0);
  });

  it("works with null cmsPattern (same as no pattern)", () => {
    const urls = [
      "http://example.com/blog/post-1",
      "http://example.com/blog/post-2",
    ];
    const collections = detectCMSCollections(urls, null);
    expect(collections).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// sampleCollectionUrls — pure function tests
// ---------------------------------------------------------------------------

describe("sampleCollectionUrls", () => {
  it("returns all URLs when count <= sampleSize", () => {
    const urls = ["http://example.com/blog/a", "http://example.com/blog/b"];
    const sampled = sampleCollectionUrls(urls, 5);
    expect(sampled).toHaveLength(2);
    expect(sampled).toEqual(urls);
  });

  it("returns exactly sampleSize URLs when collection is larger", () => {
    const urls = Array.from({ length: 50 }, (_, i) =>
      `http://example.com/blog/post-${i + 1}`,
    );
    const sampled = sampleCollectionUrls(urls, 5);
    expect(sampled).toHaveLength(5);
  });

  it("always includes the first URL as template", () => {
    const urls = Array.from({ length: 50 }, (_, i) =>
      `http://example.com/blog/post-${i + 1}`,
    );
    const sampled = sampleCollectionUrls(urls, 5);
    expect(sampled[0]).toBe("http://example.com/blog/post-1");
  });

  it("returns unique URLs (no duplicates)", () => {
    const urls = Array.from({ length: 50 }, (_, i) =>
      `http://example.com/blog/post-${i + 1}`,
    );
    const sampled = sampleCollectionUrls(urls, 5);
    const unique = new Set(sampled);
    expect(unique.size).toBe(5);
  });

  it("all sampled URLs come from the original set", () => {
    const urls = Array.from({ length: 50 }, (_, i) =>
      `http://example.com/blog/post-${i + 1}`,
    );
    const urlSet = new Set(urls);
    const sampled = sampleCollectionUrls(urls, 5);
    for (const s of sampled) {
      expect(urlSet.has(s)).toBe(true);
    }
  });

  it("returns exactly 1 URL when sampleSize is 1", () => {
    const urls = Array.from({ length: 10 }, (_, i) =>
      `http://example.com/blog/post-${i + 1}`,
    );
    const sampled = sampleCollectionUrls(urls, 1);
    expect(sampled).toHaveLength(1);
    expect(sampled[0]).toBe("http://example.com/blog/post-1");
  });
});

// ---------------------------------------------------------------------------
// crawl — integration test with CMS collection sampling
// ---------------------------------------------------------------------------

describe("crawl (CMS sampling)", () => {
  let server: Server;
  let port: number;
  let tmpDir: string;
  let browser: Browser;

  beforeAll(async () => {
    // Build fixture: root links to /about + 20 blog posts + 10 team pages
    const pages: Record<string, string> = {};

    const blogLinks = Array.from({ length: 20 }, (_, i) =>
      `<a href="/blog/post-${i + 1}">Post ${i + 1}</a>`,
    ).join("\n");
    const teamLinks = Array.from({ length: 10 }, (_, i) =>
      `<a href="/team/member-${i + 1}">Member ${i + 1}</a>`,
    ).join("\n");

    pages["/"] = `<!DOCTYPE html><html><head><title>CMS Root</title></head><body>
      <a href="/about">About</a>
      ${blogLinks}
      ${teamLinks}
    </body></html>`;
    pages["/about"] = `<!DOCTYPE html><html><head><title>About</title></head><body><h1>About</h1></body></html>`;

    for (let i = 1; i <= 20; i++) {
      pages[`/blog/post-${i}`] = `<!DOCTYPE html><html><head><title>Post ${i}</title></head><body><h1>Post ${i}</h1></body></html>`;
    }
    for (let i = 1; i <= 10; i++) {
      pages[`/team/member-${i}`] = `<!DOCTYPE html><html><head><title>Member ${i}</title></head><body><h1>Member ${i}</h1></body></html>`;
    }

    server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (pages[url]) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(pages[url]);
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    tmpDir = mkdtempSync(join(tmpdir(), "wcag-cms-test-"));
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }, 15_000);

  it("samples CMS collections, limiting per-collection page count", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const fileStore = new LocalFileStore(tmpDir);
    const snapshots = await crawl(
      `http://127.0.0.1:${port}/`,
      {
        scanSessionId: "test-cms-sample",
        fileStore,
        maxPages: 100,
        timeoutMs: 10_000,
        cmsSamples: 3,
      },
      browser,
    );

    // Should have: root + /about + 3 blog + 3 team = 8 max
    // (BFS-discovered collection URLs are also capped)
    const paths = snapshots.map((s) => new URL(s.url).pathname);
    const blogPages = paths.filter((p) => p.startsWith("/blog/"));
    const teamPages = paths.filter((p) => p.startsWith("/team/"));

    expect(blogPages.length).toBeLessThanOrEqual(3);
    expect(teamPages.length).toBeLessThanOrEqual(3);
    expect(paths).toContain("/");
    expect(paths).toContain("/about");

    // Verify logging output
    const logCalls = logSpy.mock.calls.map((c) => c[0] as string);
    const cmsLogs = logCalls.filter((msg) =>
      msg.includes("[crawler] Detected CMS collection"),
    );
    expect(cmsLogs.length).toBeGreaterThanOrEqual(1);

    logSpy.mockRestore();
  }, 30_000);

  it("crawls all CMS pages when fullCrawl is true", async () => {
    const fileStore = new LocalFileStore(tmpDir);
    const snapshots = await crawl(
      `http://127.0.0.1:${port}/`,
      {
        scanSessionId: "test-cms-full",
        fileStore,
        maxPages: 100,
        timeoutMs: 10_000,
        fullCrawl: true,
      },
      browser,
    );

    // With fullCrawl, all pages should be visited: root + about + 20 blog + 10 team = 32
    expect(snapshots).toHaveLength(32);
  }, 60_000);

  it("logs detection message with collection prefix and page count", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const fileStore = new LocalFileStore(tmpDir);
    await crawl(
      `http://127.0.0.1:${port}/`,
      {
        scanSessionId: "test-cms-log",
        fileStore,
        maxPages: 100,
        timeoutMs: 10_000,
        cmsSamples: 5,
      },
      browser,
    );

    const logCalls = logSpy.mock.calls.map((c) => c[0] as string);
    const blogLog = logCalls.find((msg) => msg.includes("/blog/"));
    expect(blogLog).toBeDefined();
    expect(blogLog).toMatch(/Detected CMS collection \/blog\//);
    expect(blogLog).toMatch(/sampling \d+/);

    logSpy.mockRestore();
  }, 30_000);
});
