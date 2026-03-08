import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extractNavData,
  isMatchingNav,
  groupNavsAcrossPages,
  runConsistentNavChecks,
  type PageNavData,
  type ConsistentNavEvaluation,
} from "../../src/checks/semantic/consistent-nav.js";
import { PromptRunner } from "../../src/core/prompt-runner.js";
import type { PageSnapshot } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helper to create mock PageSnapshot
// ---------------------------------------------------------------------------

function mockSnapshot(url: string, dom: string): PageSnapshot {
  return {
    id: `snap-${url}`,
    scan_session_id: "scan-1",
    url,
    title: `Page: ${url}`,
    captured_at: new Date().toISOString(),
    full_dom: dom,
    screenshot: "",
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
  };
}

// ---------------------------------------------------------------------------
// Test HTML — consistent navigation across pages
// ---------------------------------------------------------------------------

const PAGE1_HTML = `
<html>
<body>
  <nav id="main-nav" aria-label="Main">
    <a href="/">Home</a>
    <a href="/about">About</a>
    <a href="/services">Services</a>
    <a href="/contact">Contact</a>
  </nav>
  <main><h1>Home Page</h1></main>
  <nav id="footer-nav" aria-label="Footer">
    <a href="/privacy">Privacy</a>
    <a href="/terms">Terms</a>
  </nav>
</body>
</html>
`;

const PAGE2_HTML = `
<html>
<body>
  <nav id="main-nav" aria-label="Main">
    <a href="/">Home</a>
    <a href="/about">About</a>
    <a href="/services">Services</a>
    <a href="/contact">Contact</a>
  </nav>
  <main><h1>About Page</h1></main>
  <nav id="footer-nav" aria-label="Footer">
    <a href="/privacy">Privacy</a>
    <a href="/terms">Terms</a>
  </nav>
</body>
</html>
`;

const PAGE3_INCONSISTENT_HTML = `
<html>
<body>
  <nav id="main-nav" aria-label="Main">
    <a href="/">Home</a>
    <a href="/services">Services</a>
    <a href="/about">About</a>
    <a href="/contact">Contact</a>
  </nav>
  <main><h1>Services Page</h1></main>
  <nav id="footer-nav" aria-label="Footer">
    <a href="/privacy">Privacy</a>
    <a href="/terms">Terms</a>
  </nav>
</body>
</html>
`;

const PAGE_WITH_SUBNAV_HTML = `
<html>
<body>
  <nav id="main-nav" aria-label="Main">
    <a href="/">Home</a>
    <a href="/about">About</a>
    <a href="/services">Services</a>
    <a href="/contact">Contact</a>
  </nav>
  <nav id="sub-nav" aria-label="Services submenu">
    <a href="/services/design">Design</a>
    <a href="/services/dev">Development</a>
  </nav>
  <main><h1>Services Page</h1></main>
</body>
</html>
`;

const PAGE_NO_NAV_HTML = `
<html>
<body>
  <main><h1>No Nav Page</h1></main>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// extractNavData
// ---------------------------------------------------------------------------

describe("extractNavData", () => {
  it("extracts nav elements from DOM", () => {
    const navs = extractNavData(PAGE1_HTML, "https://example.com/");
    expect(navs.length).toBe(2);
  });

  it("extracts nav item labels in order", () => {
    const navs = extractNavData(PAGE1_HTML, "https://example.com/");
    const mainNav = navs.find((n) => n.navSelector.includes("main-nav"));
    expect(mainNav).toBeDefined();
    expect(mainNav!.navItems).toEqual(["Home", "About", "Services", "Contact"]);
  });

  it("extracts footer nav", () => {
    const navs = extractNavData(PAGE1_HTML, "https://example.com/");
    const footerNav = navs.find((n) => n.navSelector.includes("footer-nav"));
    expect(footerNav).toBeDefined();
    expect(footerNav!.navItems).toEqual(["Privacy", "Terms"]);
  });

  it("stores page URL", () => {
    const navs = extractNavData(PAGE1_HTML, "https://example.com/");
    expect(navs[0].url).toBe("https://example.com/");
  });

  it("returns empty for pages without nav", () => {
    const navs = extractNavData(PAGE_NO_NAV_HTML, "https://example.com/no-nav");
    expect(navs).toEqual([]);
  });

  it("builds selector with id when available", () => {
    const navs = extractNavData(PAGE1_HTML, "https://example.com/");
    const mainNav = navs.find((n) => n.navItems.includes("Home"));
    expect(mainNav!.navSelector).toBe("nav#main-nav");
  });

  it("builds selector with aria-label when no id", () => {
    const html = '<html><body><nav aria-label="Primary"><a href="/">Home</a></nav></body></html>';
    const navs = extractNavData(html, "https://example.com/");
    expect(navs[0].navSelector).toContain("Primary");
  });

  it("handles contextual sub-navigation", () => {
    const navs = extractNavData(PAGE_WITH_SUBNAV_HTML, "https://example.com/services");
    expect(navs.length).toBe(2);
    const subNav = navs.find((n) => n.navItems.includes("Design"));
    expect(subNav).toBeDefined();
    expect(subNav!.navItems).toEqual(["Design", "Development"]);
  });
});

// ---------------------------------------------------------------------------
// isMatchingNav
// ---------------------------------------------------------------------------

describe("isMatchingNav", () => {
  it("matches identical nav items", () => {
    expect(isMatchingNav(
      ["Home", "About", "Contact"],
      ["Home", "About", "Contact"],
    )).toBe(true);
  });

  it("matches with different casing", () => {
    expect(isMatchingNav(
      ["home", "about"],
      ["Home", "About"],
    )).toBe(true);
  });

  it("matches with minor differences (current page styling)", () => {
    // 3 of 4 shared = 75% > 50% threshold
    expect(isMatchingNav(
      ["Home", "About", "Services", "Contact"],
      ["About", "Services", "Contact", "Blog"],
    )).toBe(true);
  });

  it("does not match completely different navs", () => {
    expect(isMatchingNav(
      ["Home", "About"],
      ["Privacy", "Terms"],
    )).toBe(false);
  });

  it("does not match empty arrays", () => {
    expect(isMatchingNav([], ["Home"])).toBe(false);
    expect(isMatchingNav(["Home"], [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// groupNavsAcrossPages
// ---------------------------------------------------------------------------

describe("groupNavsAcrossPages", () => {
  it("groups matching navs from different pages", () => {
    const navs: PageNavData[] = [
      { url: "https://a.com/", navItems: ["Home", "About", "Contact"], navHtml: "<nav>...</nav>", navSelector: "nav#main" },
      { url: "https://a.com/about", navItems: ["Home", "About", "Contact"], navHtml: "<nav>...</nav>", navSelector: "nav#main" },
      { url: "https://a.com/", navItems: ["Privacy", "Terms"], navHtml: "<nav>...</nav>", navSelector: "nav#footer" },
      { url: "https://a.com/about", navItems: ["Privacy", "Terms"], navHtml: "<nav>...</nav>", navSelector: "nav#footer" },
    ];

    const groups = groupNavsAcrossPages(navs);
    expect(groups.length).toBe(2);
    expect(groups[0].length).toBe(2);
    expect(groups[1].length).toBe(2);
  });

  it("does not group navs from the same page", () => {
    const navs: PageNavData[] = [
      { url: "https://a.com/", navItems: ["Home", "About"], navHtml: "<nav>...</nav>", navSelector: "nav#1" },
      { url: "https://a.com/", navItems: ["Home", "About"], navHtml: "<nav>...</nav>", navSelector: "nav#2" },
    ];

    const groups = groupNavsAcrossPages(navs);
    // Same page, so no multi-page group formed
    expect(groups.length).toBe(0);
  });

  it("does not include single-page navs (contextual sub-navigation)", () => {
    const navs: PageNavData[] = [
      { url: "https://a.com/", navItems: ["Home", "About"], navHtml: "<nav>...</nav>", navSelector: "nav#main" },
      { url: "https://a.com/about", navItems: ["Home", "About"], navHtml: "<nav>...</nav>", navSelector: "nav#main" },
      { url: "https://a.com/services", navItems: ["Design", "Dev"], navHtml: "<nav>...</nav>", navSelector: "nav#sub" },
    ];

    const groups = groupNavsAcrossPages(navs);
    // Only main nav group (appears on 2 pages), sub-nav only on 1 page
    expect(groups.length).toBe(1);
    expect(groups[0].length).toBe(2);
  });

  it("returns empty for no navs", () => {
    expect(groupNavsAcrossPages([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runConsistentNavChecks — mocked PromptRunner
// ---------------------------------------------------------------------------

describe("runConsistentNavChecks", () => {
  let mockRunner: PromptRunner;
  let runPromptSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRunner = new PromptRunner("test-key", { max_retries: 0 });
    runPromptSpy = vi.fn();
    mockRunner.runPrompt = runPromptSpy;
  });

  it("runs once per scan (not per page)", async () => {
    runPromptSpy.mockResolvedValue({
      success: true,
      data: {
        verdict: "pass",
        confidence: 0.95,
        reasoning: "Navigation is consistent",
        wcag_criterion: "3.2.3",
        failure_type: null,
        suggestion: null,
        affected_users: [],
        requires_human_verification: false,
      },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    });

    const snapshots = [
      mockSnapshot("https://a.com/", PAGE1_HTML),
      mockSnapshot("https://a.com/about", PAGE2_HTML),
    ];

    await runConsistentNavChecks(snapshots, mockRunner);

    // Called once per nav group (main nav + footer nav = 2 groups)
    expect(runPromptSpy).toHaveBeenCalledTimes(2);
  });

  it("requires at least 2 pages", async () => {
    const snapshots = [mockSnapshot("https://a.com/", PAGE1_HTML)];
    const results = await runConsistentNavChecks(snapshots, mockRunner);
    expect(results).toEqual([]);
    expect(runPromptSpy).not.toHaveBeenCalled();
  });

  it("returns empty for consistent navigation", async () => {
    runPromptSpy.mockResolvedValue({
      success: true,
      data: {
        verdict: "pass",
        confidence: 0.95,
        reasoning: "Navigation is consistent",
        wcag_criterion: "3.2.3",
        failure_type: null,
        suggestion: null,
        affected_users: [],
        requires_human_verification: false,
      },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    });

    const snapshots = [
      mockSnapshot("https://a.com/", PAGE1_HTML),
      mockSnapshot("https://a.com/about", PAGE2_HTML),
    ];

    const results = await runConsistentNavChecks(snapshots, mockRunner);
    expect(results.length).toBe(0);
  });

  it("detects order_changed failure", async () => {
    runPromptSpy.mockResolvedValue({
      success: true,
      data: {
        verdict: "fail",
        confidence: 0.95,
        reasoning: "Navigation order differs between pages",
        wcag_criterion: "3.2.3",
        failure_type: "order_changed",
        suggestion: "Maintain consistent navigation order",
        affected_users: ["screen_reader", "cognitive"],
        requires_human_verification: false,
      },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    });

    const snapshots = [
      mockSnapshot("https://a.com/", PAGE1_HTML),
      mockSnapshot("https://a.com/services", PAGE3_INCONSISTENT_HTML),
    ];

    const results = await runConsistentNavChecks(snapshots, mockRunner);
    // At least one of the nav groups should fail
    const failures = results.filter((r) =>
      (r.raw_result as ConsistentNavEvaluation).failure_type === "order_changed"
    );
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].wcag_criterion).toBe("3.2.3");
    expect(failures[0].detected_by).toBe("claude_api");
  });

  it("detects items_missing failure", async () => {
    runPromptSpy.mockResolvedValue({
      success: true,
      data: {
        verdict: "fail",
        confidence: 0.85,
        reasoning: "Items missing from navigation on some pages",
        wcag_criterion: "3.2.3",
        failure_type: "items_missing",
        suggestion: "Include all nav items on all pages",
        affected_users: ["screen_reader", "cognitive"],
        requires_human_verification: false,
      },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    });

    const snapshots = [
      mockSnapshot("https://a.com/", PAGE1_HTML),
      mockSnapshot("https://a.com/about", PAGE2_HTML),
    ];

    const results = await runConsistentNavChecks(snapshots, mockRunner);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].measured_values?.failure_type).toBe("items_missing");
  });

  it("detects labels_inconsistent failure", async () => {
    runPromptSpy.mockResolvedValue({
      success: true,
      data: {
        verdict: "fail",
        confidence: 0.8,
        reasoning: "Nav labels differ across pages",
        wcag_criterion: "3.2.3",
        failure_type: "labels_inconsistent",
        suggestion: "Use consistent labels",
        affected_users: ["screen_reader", "cognitive"],
        requires_human_verification: true,
      },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    });

    const snapshots = [
      mockSnapshot("https://a.com/", PAGE1_HTML),
      mockSnapshot("https://a.com/about", PAGE2_HTML),
    ];

    const results = await runConsistentNavChecks(snapshots, mockRunner);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].measured_values?.failure_type).toBe("labels_inconsistent");
  });

  it("detects nav_structure_changed failure", async () => {
    runPromptSpy.mockResolvedValue({
      success: true,
      data: {
        verdict: "fail",
        confidence: 0.75,
        reasoning: "Navigation structure differs",
        wcag_criterion: "3.2.3",
        failure_type: "nav_structure_changed",
        suggestion: "Keep nav structure consistent",
        affected_users: ["screen_reader", "cognitive"],
        requires_human_verification: true,
      },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    });

    const snapshots = [
      mockSnapshot("https://a.com/", PAGE1_HTML),
      mockSnapshot("https://a.com/about", PAGE2_HTML),
    ];

    const results = await runConsistentNavChecks(snapshots, mockRunner);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].measured_values?.failure_type).toBe("nav_structure_changed");
  });

  it("correctly handles current page styled differently", async () => {
    // The nav matching uses similarity threshold — a current page might have
    // different styling but same items. This test verifies the navs still match.
    const page1 = `<html><body><nav><a href="/" class="current">Home</a><a href="/about">About</a></nav></body></html>`;
    const page2 = `<html><body><nav><a href="/">Home</a><a href="/about" class="current">About</a></nav></body></html>`;

    runPromptSpy.mockResolvedValue({
      success: true,
      data: {
        verdict: "pass",
        confidence: 0.95,
        reasoning: "Same nav, different current page",
        wcag_criterion: "3.2.3",
        failure_type: null,
        suggestion: null,
        affected_users: [],
        requires_human_verification: false,
      },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    });

    const snapshots = [
      mockSnapshot("https://a.com/", page1),
      mockSnapshot("https://a.com/about", page2),
    ];

    const results = await runConsistentNavChecks(snapshots, mockRunner);
    expect(results.length).toBe(0);
    // Prompt was called — navs were matched across pages
    expect(runPromptSpy).toHaveBeenCalledTimes(1);
  });

  it("correctly handles contextual sub-navigation", async () => {
    // Sub-nav only appears on services page — should not be compared
    runPromptSpy.mockResolvedValue({
      success: true,
      data: {
        verdict: "pass",
        confidence: 0.95,
        reasoning: "Consistent",
        wcag_criterion: "3.2.3",
        failure_type: null,
        suggestion: null,
        affected_users: [],
        requires_human_verification: false,
      },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    });

    const snapshots = [
      mockSnapshot("https://a.com/", PAGE1_HTML),
      mockSnapshot("https://a.com/services", PAGE_WITH_SUBNAV_HTML),
    ];

    await runConsistentNavChecks(snapshots, mockRunner);

    // Should only send the main nav group, not the sub-nav
    // (sub-nav only appears on services page, not grouped)
    expect(runPromptSpy).toHaveBeenCalled();
    const input = runPromptSpy.mock.calls[0][0];
    expect(input.userMessage).toContain("Home");
    expect(input.userMessage).not.toContain("Design");
  });

  it("includes nav items per page in measured_values", async () => {
    runPromptSpy.mockResolvedValue({
      success: true,
      data: {
        verdict: "fail",
        confidence: 0.9,
        reasoning: "Inconsistent",
        wcag_criterion: "3.2.3",
        failure_type: "order_changed",
        suggestion: "Fix",
        affected_users: ["screen_reader"],
        requires_human_verification: false,
      },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    });

    const snapshots = [
      mockSnapshot("https://a.com/", PAGE1_HTML),
      mockSnapshot("https://a.com/about", PAGE2_HTML),
    ];

    const results = await runConsistentNavChecks(snapshots, mockRunner);
    expect(results[0].measured_values?.pages_compared).toBe(2);
    expect(results[0].measured_values?.page_urls).toContain("https://a.com/");
    expect(results[0].measured_values?.nav_items_per_page).toBeDefined();
  });

  it("sends correct prompt template", async () => {
    runPromptSpy.mockResolvedValue({
      success: true,
      data: {
        verdict: "pass",
        confidence: 0.95,
        reasoning: "Consistent",
        wcag_criterion: "3.2.3",
        failure_type: null,
        suggestion: null,
        affected_users: [],
        requires_human_verification: false,
      },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    });

    const snapshots = [
      mockSnapshot("https://a.com/", PAGE1_HTML),
      mockSnapshot("https://a.com/about", PAGE2_HTML),
    ];

    await runConsistentNavChecks(snapshots, mockRunner);

    const input = runPromptSpy.mock.calls[0][0];
    expect(input.template.name).toBe("consistent_navigation");
    expect(input.template.vision).toBe(false);
    expect(input.userMessage).toContain("3.2.3");
  });

  it("returns needs_review for API failures", async () => {
    runPromptSpy.mockResolvedValue({
      success: false,
      data: null,
      rawResponse: "",
      model: "claude-sonnet-4-6",
      tokensUsed: 0,
      latencyMs: 0,
      retries: 2,
      error: "API error",
    });

    const snapshots = [
      mockSnapshot("https://a.com/", PAGE1_HTML),
      mockSnapshot("https://a.com/about", PAGE2_HTML),
    ];

    const results = await runConsistentNavChecks(snapshots, mockRunner);
    expect(results.length).toBeGreaterThan(0);
    const raw = results[0].raw_result as ConsistentNavEvaluation;
    expect(raw.verdict).toBe("needs_review");
  });

  it("handles pages without navigation", async () => {
    const snapshots = [
      mockSnapshot("https://a.com/", PAGE_NO_NAV_HTML),
      mockSnapshot("https://a.com/about", PAGE_NO_NAV_HTML),
    ];

    const results = await runConsistentNavChecks(snapshots, mockRunner);
    expect(results).toEqual([]);
    expect(runPromptSpy).not.toHaveBeenCalled();
  });
});
