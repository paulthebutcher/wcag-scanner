import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { chromium, type Browser } from "playwright";
import { clusterFindings, type PagedFinding } from "../../src/report/clustering.js";
import {
  diffVerification,
  selectClusters,
  checksForClusters,
  runVerify,
} from "../../src/core/verify.js";
import { checkForFinding, withPrerequisites, tiersForChecks } from "../../src/core/check-registry.js";
import { CoverageRecorder } from "../../src/core/coverage.js";
import { renderVerifyMarkdown, clientSummaryLines } from "../../src/report/verify-report.js";
import { scan } from "../../src/core/scanner.js";
import { QuietProgressReporter } from "../../src/core/progress.js";
import { openDatabase, getScanSession } from "../../src/store/db.js";
import { makeTestFinding, contrastReasoning } from "./finding-factory.js";

const A = "https://s.test/a";
const B = "https://s.test/b";
const C = "https://s.test/c";

const contrast = (id: string, page: string) => ({
  finding: makeTestFinding({ id, criterion: "1.4.3", failureType: "color-contrast", html: '<a class="tos-footer-link">Privacy</a>', reasoning: contrastReasoning("#286140", "#17191e") }),
  pageUrl: page,
});
const modalButton = (id: string, page: string, wid = "ff1f") => ({
  finding: makeTestFinding({ id, criterion: "4.1.2", failureType: "custom_interactive_no_role", detectedBy: "playwright", selector: `div#${wid}`, html: `<div data-w-id="${wid}" class="btn modal full">` }),
  pageUrl: page,
});

function coverageWith(entries: Array<[string, string, "ran" | "failed" | "skipped", string?]>, pages = [A, B, C]) {
  const rec = new CoverageRecorder();
  for (const [check, page, status, msg] of entries) rec.record(check, 1, page, status, msg);
  return rec.toJSON("rescan-1", pages);
}

// ---------------------------------------------------------------------------
// Diff classification
// ---------------------------------------------------------------------------

describe("diffVerification", () => {
  const baseline: PagedFinding[] = [
    contrast("c-a", A), contrast("c-b", B), contrast("c-c", C),
    modalButton("m-a", A), modalButton("m-b", B),
  ];
  const clusters = clusterFindings(baseline);
  const contrastCluster = clusters.find((c) => c.failure_type === "color-contrast")!;
  const modalCluster = clusters.find((c) => c.failure_type === "custom_interactive_no_role")!;

  it("classifies pages as fixed, still broken and not verified, and finds newly broken issues", () => {
    const result = diffVerification({
      baselineScanId: "base", rescanScanId: "re", site: "https://s.test", baselineDate: "2026-10-04T00:00:00Z",
      selected: [contrastCluster, modalCluster],
      baseline,
      rescan: [
        contrast("r-c-b", B), // still broken on B
        modalButton("r-new", A, "zz99"), // a different element: newly broken
      ],
      coverage: coverageWith([
        ["axe-core", A, "ran"], ["axe-core", B, "ran"], ["axe-core", C, "failed", "page.goto: Timeout 30000ms exceeded."],
        ["widget-aria", A, "ran"], ["widget-aria", B, "ran"],
      ]),
      checksRun: ["axe-core", "widget-aria"],
    });

    const c = result.clusters.find((x) => x.cluster_id === contrastCluster.cluster_id)!;
    expect(c.pages.map((p) => [p.page_url, p.status])).toEqual([[A, "fixed"], [B, "still_broken"], [C, "not_verified"]]);
    expect(c.pages.find((p) => p.page_url === C)!.reason).toContain("axe-core failed: page.goto: Timeout");
    expect(c.status).toBe("still_broken");
    expect([c.before_occurrences, c.after_occurrences]).toEqual([3, 1]);

    const m = result.clusters.find((x) => x.cluster_id === modalCluster.cluster_id)!;
    expect(m.status).toBe("fixed");

    expect(result.new_issues).toHaveLength(1);
    expect(result.new_issues[0].pages).toEqual([A]);
    expect(result.summary).toMatchObject({ issues_checked: 2, fixed_issues: 1, fixed_pages: 2, remaining_issues: 1, not_verified_issues: 0, new_issues: 1 });
  });

  it("never counts a page as fixed when its check was skipped or the page was not captured", () => {
    const result = diffVerification({
      baselineScanId: "base", rescanScanId: "re", site: "https://s.test", baselineDate: "2026-10-04T00:00:00Z",
      selected: [contrastCluster],
      baseline,
      rescan: [],
      coverage: { ...coverageWith([["axe-core", A, "ran"], ["axe-core", B, "skipped", "no ANTHROPIC_API_KEY"]], [A, B]), crawl_failures: [{ url: C, error: "net::ERR_CONNECTION_RESET" }] },
      checksRun: ["axe-core"],
    });
    const c = result.clusters[0];
    expect(c.pages.map((p) => p.status)).toEqual(["fixed", "not_verified", "not_verified"]);
    expect(c.pages[2].reason).toContain("page could not be loaded");
    expect(c.status).toBe("not_verified");
    expect(result.summary.fixed_issues).toBe(0);
    expect(result.summary.not_verified_issues).toBe(1);
  });

  it("does not report occurrences on pages the baseline knew only by count as new", () => {
    const legacy = { finding: makeTestFinding({ id: "skip", criterion: "2.4.1", failureType: "missing_skip_navigation", detectedBy: "playwright", html: "<html>", measured: { also_found_on_pages: 2 } }), pageUrl: A };
    const rescanned = { finding: makeTestFinding({ id: "skip-r", criterion: "2.4.1", failureType: "missing_skip_navigation", detectedBy: "playwright", html: "<html>", measured: { also_found_on_pages: 1, also_found_on_urls: [B] } }), pageUrl: A };
    const result = diffVerification({
      baselineScanId: "base", rescanScanId: "re", site: "https://s.test", baselineDate: "2026-10-04T00:00:00Z",
      selected: clusterFindings([legacy]),
      baseline: [legacy],
      rescan: [rescanned],
      coverage: coverageWith([["skip-nav", A, "ran"], ["skip-nav", B, "ran"]]),
      checksRun: ["skip-nav"],
    });
    expect(result.new_issues).toHaveLength(0);
    expect(result.clusters[0].status).toBe("still_broken");
    expect(result.clusters[0].unlisted_pages).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Selection, checks, output
// ---------------------------------------------------------------------------

describe("verification setup", () => {
  const clusters = clusterFindings(Array.from({ length: 12 }, (_, i) => ({
    finding: makeTestFinding({ failureType: "aria-prohibited-attr", html: `<div class="c${i}" aria-label="x"></div>` }),
    pageUrl: A,
  })));

  it("selects named clusters (full id or prefix), all, or the Top fixes by default", () => {
    expect(selectClusters(clusters, {})).toHaveLength(10);
    expect(selectClusters(clusters, { all: true })).toHaveLength(12);
    const id = clusters[3].cluster_id;
    expect(selectClusters(clusters, { clusterIds: [id, clusters[5].cluster_id.slice(0, 8)] }).map((c) => c.cluster_id))
      .toEqual([id, clusters[5].cluster_id]);
    expect(() => selectClusters(clusters, { clusterIds: ["nope"] })).toThrow("No cluster nope");
  });

  it("maps findings to the checks that produce them, with prerequisites and tiers", () => {
    expect(checkForFinding(makeTestFinding({ failureType: "color-contrast", detectedBy: "axe_core" }))).toBe("axe-core");
    expect(checkForFinding(makeTestFinding({ failureType: "no_visible_focus_indicator", detectedBy: "playwright" }))).toBe("focus-visible");
    expect(checkForFinding(makeTestFinding({ failureType: "custom_interactive_no_role", detectedBy: "playwright" }))).toBe("widget-aria");
    expect(withPrerequisites(["focus-visible", "input-purpose"])).toEqual(["focus-visible", "form-discovery", "input-purpose", "keyboard"]);
    expect(tiersForChecks(["axe-core", "widget-aria"])).toEqual([1, 3]);
    const focus = clusterFindings([{ finding: makeTestFinding({ criterion: "2.4.7", failureType: "no_visible_focus_indicator", detectedBy: "playwright" }), pageUrl: A }]);
    expect(checksForClusters(focus)).toEqual(["focus-visible", "keyboard"]);
  });

  it("writes a client summary in plain language without internal ids", () => {
    const baseline = [contrast("c-a", A), contrast("c-b", B)];
    const result = diffVerification({
      baselineScanId: "base-scan-id", rescanScanId: "rescan-id", site: "https://s.test", baselineDate: "2026-10-04T12:00:00Z",
      selected: clusterFindings(baseline), baseline, rescan: [contrast("r", B)],
      coverage: coverageWith([["axe-core", A, "ran"], ["axe-core", B, "ran"]], [A, B]),
      checksRun: ["axe-core"],
    });
    const summary = clientSummaryLines(result).join("\n");
    expect(summary).toContain("We re-checked 2 pages on https://s.test");
    expect(summary).toContain("low-contrast text in colour #286140 (fixed on 1, still present on 1 page), 2 → 1 occurrences");
    expect(summary).not.toContain(result.clusters[0].cluster_id);
    expect(summary).not.toContain("base-scan-id");

    const md = renderVerifyMarkdown(result);
    const [summarySection, details] = md.split("## Details");
    expect(summarySection).not.toContain(result.clusters[0].cluster_id);
    expect(details).toContain(result.clusters[0].cluster_id);
    expect(details).toContain("still broken: /b (1 → 1)");
  });
});

// ---------------------------------------------------------------------------
// End to end: baseline scan, a page gets fixed, `runVerify`
// ---------------------------------------------------------------------------

describe("runVerify (local site)", () => {
  let browser: Browser;
  let server: http.Server;
  let baseUrl: string;
  let dataDir: string;
  let fixedPaths = new Set<string>();

  const page = (path: string, title: string) => {
    const color = fixedPaths.has(path) ? "#d9f2e3" : "#286140";
    return `<!DOCTYPE html><html lang="en"><head><title>${title}</title><style>body{background:#17191e;color:#fff;font-size:14px} .tos{color:${color}}</style></head>
      <body><main><h1>${title}</h1><p>Body text.</p><a class="tos" href="/">Home</a> <a class="tos" href="/a">Page A</a></main></body></html>`;
  };

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    dataDir = mkdtempSync(join(tmpdir(), "wcag-verify-"));
    server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (req.url === "/") res.end(page("/", "Home"));
      else if (req.url === "/a") res.end(page("/a", "Page A"));
      else { res.statusCode = 404; res.end("not found"); }
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

  it("rescans only the cluster's pages and checks, and reports the fixed page", async () => {
    const reporter = new QuietProgressReporter();
    const baseline = await scan({ url: baseUrl + "/", dataDir, maxPages: 5, tiers: [1], reporter }, browser);
    expect(baseline.pageSnapshots).toHaveLength(2);

    fixedPaths = new Set(["/a"]);
    const { result, files } = await runVerify({ dataDir, baselineScanId: baseline.scanSession.id, reporter }, browser);

    const contrastResult = result.clusters.find((c) => c.failure_type === "color-contrast")!;
    expect(contrastResult).toBeDefined();
    const byPath = Object.fromEntries(contrastResult.pages.map((p) => [new URL(p.page_url).pathname, p.status]));
    expect(byPath).toEqual({ "/": "still_broken", "/a": "fixed" });
    expect(result.checks_run).toEqual(["axe-core"]);
    expect(result.pages_rescanned.map((u) => new URL(u).pathname).sort()).toEqual(["/", "/a"]);

    for (const path of Object.values(files)) expect(existsSync(path)).toBe(true);
    expect(readFileSync(files.markdown, "utf8")).toContain("low-contrast text in colour #286140");
    expect(readFileSync(files.html, "utf8")).toContain('id="verification"');

    const db = openDatabase(join(dataDir, "wcag.db"));
    try {
      const rescan = getScanSession(db, result.rescan_scan_id)!;
      expect(rescan.baseline_scan_id).toBe(baseline.scanSession.id);
      expect(rescan.scan_type).toBe("rescan");
      expect(rescan.comparison_scan_id).toBeNull();
    } finally {
      db.close();
    }
    const coverage = JSON.parse(readFileSync(join(dataDir, result.rescan_scan_id, "coverage.json"), "utf8"));
    expect(new Set(coverage.entries.map((e: { check: string }) => e.check))).toEqual(new Set(["axe-core"]));
  }, 120_000);
});
