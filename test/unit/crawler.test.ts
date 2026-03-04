import {
  describe,
  it,
  expect,
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
