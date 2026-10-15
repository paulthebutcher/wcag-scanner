import { describe, it, expect } from "vitest";
import { clusterFindings, isPageLevelSummary, SITE_LEVEL_FAILURE_TYPES } from "../../src/report/clustering.js";
import {
  renderTopFixesMarkdown, renderTopFixesHtml, renderPageLevelMarkdown, renderPageLevelHtml, topFixClusters,
} from "../../src/report/top-fixes-report.js";
import { makeTestFinding } from "./finding-factory.js";

// focus-order.ts reports a page's order mismatch on <html> with a summary node
const focusOrder = (page: string, html = `<focus-order-summary mismatches="3" sample="a.nav-link → a.btn"/>`) => ({
  finding: makeTestFinding({ criterion: "2.4.3", failureType: "focus_order_mismatch", selector: "html", html, detectedBy: "playwright", severity: "minor", pageSnapshotId: page }),
  pageUrl: `https://x.test${page}`,
});
const navMethods = (page: string) => ({
  finding: makeTestFinding({ criterion: "2.4.5", failureType: "insufficient_navigation_methods", selector: "html", html: `<html> (page: https://x.test${page})`, detectedBy: "playwright", severity: "advisory", pageSnapshotId: page }),
  pageUrl: `https://x.test${page}`,
});
const footerLink = (page: string) => ({
  finding: makeTestFinding({ criterion: "2.4.7", failureType: "no_visible_focus_indicator", selector: "a.footer-link", html: `<a class="footer-link" href="/x">X</a>`, detectedBy: "playwright", pageSnapshotId: page }),
  pageUrl: `https://x.test${page}`,
});

describe("page-level summary findings (P2-014)", () => {
  it("recognises page-level summaries and leaves site-level and element findings alone", () => {
    expect(isPageLevelSummary(focusOrder("/a").finding)).toBe(true);
    expect(isPageLevelSummary(navMethods("/a").finding)).toBe(false);
    expect(isPageLevelSummary(footerLink("/a").finding)).toBe(false);
    expect(isPageLevelSummary(makeTestFinding({ criterion: "2.4.1", failureType: "bypass", selector: "html", html: "<html lang=\"en\">" }))).toBe(false);
    expect(isPageLevelSummary(makeTestFinding({ criterion: "2.4.1", failureType: "missing_skip_navigation", selector: "html", html: "<html>" }))).toBe(false);
    expect(SITE_LEVEL_FAILURE_TYPES.has("insufficient_navigation_methods")).toBe(true);
  });

  it("clusters page-level summaries per page; site-level and component findings stay grouped", () => {
    const clusters = clusterFindings([
      focusOrder("/a"), focusOrder("/b"), focusOrder("/c"),
      navMethods("/a"), navMethods("/b"),
      footerLink("/a"), footerLink("/b"),
    ]);
    const fo = clusters.filter((c) => c.failure_type === "focus_order_mismatch");
    expect(fo).toHaveLength(3);
    expect(fo.every((c) => c.page_level && c.page_count === 1)).toBe(true);
    expect(new Set(fo.map((c) => c.cluster_id)).size).toBe(3);
    expect(clusters.filter((c) => c.failure_type === "insufficient_navigation_methods")).toHaveLength(1);
    expect(clusters.filter((c) => c.failure_type === "no_visible_focus_indicator").map((c) => c.page_count)).toEqual([2]);
  });

  it("keeps a deduplicated summary's other pages in its per-page row", () => {
    const shared = focusOrder("/a");
    shared.finding.evidence.measured_values = { ...shared.finding.evidence.measured_values, also_found_on_pages: 1, also_found_on_urls: ["https://x.test/b"] };
    const [c] = clusterFindings([shared]);
    expect(c.page_level).toBe(true);
    expect(c.page_urls).toEqual(["https://x.test/a", "https://x.test/b"]);
    expect(renderPageLevelMarkdown([c])).toContain("| /a | focus order mismatch | 2.4.3 | minor | /b |");
  });

  it("Top fixes has no row built from <html> summaries; the per-page section lists each page with its hours", () => {
    const clusters = clusterFindings([focusOrder("/a"), focusOrder("/b"), footerLink("/a"), footerLink("/b"), navMethods("/a")]);
    expect(topFixClusters(clusters).some((c) => c.page_level)).toBe(false);
    const md = renderTopFixesMarkdown(clusters, 10, () => "0.1–0.2 h");
    expect(md).not.toContain("focus order mismatch");
    expect(md).toContain("footer-link");
    expect(renderTopFixesHtml(clusters)).not.toContain("focus order mismatch");

    const perPage = renderPageLevelMarkdown(clusters, () => "0.1–0.25 h");
    expect(perPage).toContain("## Per-page fixes (2)");
    expect(perPage).toContain("| /a | focus order mismatch | 2.4.3 | minor | 0.1–0.25 h | — |");
    expect(perPage).toContain("| /b | focus order mismatch | 2.4.3 | minor | 0.1–0.25 h | — |");
    expect(renderPageLevelHtml(clusters)).toContain("Per-page fixes");
    expect(renderPageLevelMarkdown(clusterFindings([footerLink("/a")]))).toBe("");
  });
});
