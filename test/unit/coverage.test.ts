import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { chromium, type Browser } from "playwright";
import {
  CoverageRecorder,
  summarizeCoverage,
  writeCoverage,
  loadCoverage,
  firstLine,
  type ScanCoverage,
} from "../../src/core/coverage.js";
import { renderCoverageMarkdown, renderCoverageHtml } from "../../src/report/coverage-report.js";
import { scan } from "../../src/core/scanner.js";
import { QuietProgressReporter } from "../../src/core/progress.js";

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

describe("CoverageRecorder", () => {
  it("keeps the most significant status per check and page: failed > ran > skipped", () => {
    const rec = new CoverageRecorder();
    rec.skipped("form-submission", 4, "https://a.test/", "no visible fields at page load");
    rec.ran("form-submission", 4, "https://a.test/");
    rec.failed("on-input", 4, "https://a.test/", new Error("boom"));
    rec.ran("on-input", 4, "https://a.test/");

    const entries = rec.entries();
    expect(entries.find((e) => e.check === "form-submission")?.status).toBe("ran");
    const onInput = entries.find((e) => e.check === "on-input")!;
    expect(onInput.status).toBe("failed");
    expect(onInput.message).toBe("boom");
  });

  it("ranks partial between failed and ran, and reports it in the summary and report", () => {
    const rec = new CoverageRecorder();
    rec.ran("keyboard", 2, "https://a.test/");
    rec.record("keyboard", 2, "https://a.test/", "partial", "tab sweep stopped early (body_focus) after 6 stops");
    rec.ran("keyboard", 2, "https://a.test/b");
    const cov = rec.toJSON("s", ["https://a.test/", "https://a.test/b"]);
    const [row] = summarizeCoverage(cov);
    expect(row).toMatchObject({ ran: 1, partial: 1, failed: 0 });
    expect(row.partials[0].reason).toContain("body_focus");
    const md = renderCoverageMarkdown(cov);
    expect(md).toContain("| Keyboard reachability (2.1.1) | 2 | 1/2 | **1** ⚠ | 0 | 0 | 0 |");
    expect(md).toContain("Partial on 1 page(s): tab sweep stopped early");
    expect(renderCoverageHtml(cov)).toContain("only partly ran");
  });

  it("keeps only the first line of multi-line errors", () => {
    expect(firstLine("page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating")).toBe("page.goto: Timeout 30000ms exceeded.");
  });

  it("records site-level outcomes for every page", () => {
    const rec = new CoverageRecorder();
    rec.recordAll("consistent-nav", 3, ["https://a.test/", "https://a.test/b"], "ran");
    expect(rec.entries()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Summary + persistence
// ---------------------------------------------------------------------------

function sampleCoverage(): ScanCoverage {
  const rec = new CoverageRecorder();
  const pages = ["https://a.test/", "https://a.test/b", "https://a.test/c"];
  for (const p of pages) rec.ran("axe-core", 1, p);
  rec.ran("keyboard", 2, pages[0]);
  rec.failed("keyboard", 2, pages[1], "page load failed: net::ERR_EMPTY_RESPONSE");
  rec.failed("keyboard", 2, pages[2], "page load failed: net::ERR_EMPTY_RESPONSE");
  rec.ran("form-submission", 4, pages[0]);
  rec.skipped("form-submission", 4, pages[1], "no forms on page");
  rec.skipped("form-submission", 4, pages[2], "no forms on page");
  rec.crawlFailure("https://a.test/timeout", "page.goto: Timeout 30000ms exceeded.");
  return rec.toJSON("scan-1", pages);
}

describe("summarizeCoverage", () => {
  it("counts ran / failed / skipped per check and groups messages", () => {
    const rows = summarizeCoverage(sampleCoverage());
    expect(rows.map((r) => r.check)).toEqual(["axe-core", "keyboard", "form-submission"]);

    const keyboard = rows.find((r) => r.check === "keyboard")!;
    expect(keyboard).toMatchObject({ pages_crawled: 3, ran: 1, failed: 2, skipped: 0, not_recorded: 0 });
    expect(keyboard.failures).toEqual([
      { message: "page load failed: net::ERR_EMPTY_RESPONSE", pages: ["https://a.test/b", "https://a.test/c"] },
    ]);

    const forms = rows.find((r) => r.check === "form-submission")!;
    expect(forms.skips).toEqual([{ reason: "no forms on page", pages: ["https://a.test/b", "https://a.test/c"] }]);
  });

  it("reports pages with no recorded outcome", () => {
    const rec = new CoverageRecorder();
    rec.ran("modal", 2, "https://a.test/");
    const rows = summarizeCoverage(rec.toJSON("s", ["https://a.test/", "https://a.test/b"]));
    expect(rows[0].not_recorded).toBe(1);
  });

  it("round-trips through coverage.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "wcag-coverage-"));
    try {
      const cov = sampleCoverage();
      writeCoverage(dir, cov);
      expect(loadCoverage(dir, "scan-1")).toEqual(cov);
      expect(loadCoverage(dir, "missing-scan")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Report sections
// ---------------------------------------------------------------------------

describe("coverage report sections", () => {
  it("markdown lists every check, warns on failures and crawl failures, groups messages", () => {
    const md = renderCoverageMarkdown(sampleCoverage());
    expect(md).toContain("## Coverage");
    expect(md).toContain("| Keyboard reachability (2.1.1) | 2 | 1/3 | 0 | **2** ⚠ | 0 | 0 |");
    expect(md).toContain("**Warning:** 1 check(s) failed");
    expect(md).toContain("could not be loaded by the crawl");
    expect(md).toContain("Failed on 2 page(s): page load failed: net::ERR_EMPTY_RESPONSE (/b, /c)");
    expect(md).toContain("Skipped on 2 page(s): no forms on page");
  });

  it("html shows a warning and highlights failed checks", () => {
    const html = renderCoverageHtml(sampleCoverage());
    expect(html).toContain('id="coverage"');
    expect(html).toContain("coverage-warning");
    expect(html).toContain('<tr class="coverage-warn">');
    expect(html).toContain("Keyboard reachability (2.1.1)");
  });

  it("says so when a scan predates coverage recording", () => {
    expect(renderCoverageMarkdown(null)).toContain("Coverage was not recorded");
    expect(renderCoverageHtml(null)).toContain("Coverage was not recorded");
  });
});

// ---------------------------------------------------------------------------
// Scanner integration: a page that loads for the crawl but fails afterwards
// ---------------------------------------------------------------------------

describe("scan() coverage recording", () => {
  let browser: Browser;
  let server: http.Server;
  let baseUrl: string;
  let dataDir: string;
  const hits = new Map<string, number>();

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    dataDir = mkdtempSync(join(tmpdir(), "wcag-coverage-scan-"));
    server = http.createServer((req, res) => {
      const url = req.url ?? "/";
      const n = (hits.get(url) ?? 0) + 1;
      hits.set(url, n);
      if (url === "/flaky" && n > 1) {
        // Loads for the crawl, then drops the connection: the behavioral
        // pass cannot load the page.
        req.socket.destroy();
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (url === "/") {
        res.end(`<!DOCTYPE html><html lang="en"><head><title>Home</title></head><body><main><h1>Home</h1><a href="/flaky">Flaky page</a></main></body></html>`);
      } else if (url === "/flaky") {
        res.end(`<!DOCTYPE html><html lang="en"><head><title>Flaky</title></head><body><main><h1>Flaky</h1><a href="/">Home</a></main></body></html>`);
      } else {
        res.statusCode = 404;
        res.end("not found");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("records a page failure for every behavioral check and writes coverage.json", async () => {
    const result = await scan(
      { url: baseUrl + "/", dataDir, maxPages: 5, tiers: [1, 2, 5], reporter: new QuietProgressReporter() },
      browser,
    );

    const flakyUrl = `${baseUrl}/flaky`;
    const homeUrl = `${baseUrl}/`;
    const byKey = new Map(result.coverage.entries.map((e) => [`${e.check} ${e.page_url}`, e]));

    expect(byKey.get(`axe-core ${flakyUrl}`)?.status).toBe("ran");
    for (const check of ["keyboard", "focus-visible", "focus-order", "keyboard-trap", "skip-nav", "modal"]) {
      expect(byKey.get(`${check} ${homeUrl}`)?.status, `${check} on home`).toBe("ran");
      const flaky = byKey.get(`${check} ${flakyUrl}`);
      expect(flaky?.status, `${check} on flaky`).toBe("failed");
      expect(flaky?.message).toContain("page load failed");
    }
    expect(byKey.get(`pause-stop-hide ${flakyUrl}`)?.status).toBe("ran");

    const path = join(dataDir, result.scanSession.id, "coverage.json");
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).page_urls).toHaveLength(2);

    const md = readFileSync(join(dataDir, result.scanSession.id, "findings.md"), "utf8");
    expect(md).toContain("## Coverage");
    expect(md).toContain("page load failed");
  }, 90_000);
});
