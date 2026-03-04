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
import { normalizeUrl, isSameOrigin, crawl } from "../../src/core/crawler.js";
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
// crawl — integration test with fixture server
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

describe("crawl", () => {
  let server: Server;
  let port: number;
  let tmpDir: string;
  let browser: Browser;

  beforeAll(async () => {
    // Fixture HTTP server
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

    expect(snapshots).toHaveLength(6); // root + 5 linked pages
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

    // /about, /about/, /about#intro should all collapse into one visit
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
    // Create a server that hangs on /slow
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
        timeoutMs: 2_000, // short timeout
      },
      browser,
    );

    // Root page should succeed, /slow should be skipped
    expect(snapshots).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMsg).toContain("[crawler] Skipping");

    warnSpy.mockRestore();
    slowServer.close();
  }, 30_000);
});
