import { describe, it, expect } from "vitest";
import {
  detectNavMenu,
  detectSearch,
  detectSitemapLink,
  detectTableOfContents,
  detectBreadcrumbs,
  detectNavigationMethods,
  detectMotionListeners,
  checkMultipleWays,
  checkMotionActuation,
} from "../../src/checks/indicators/multiple-ways.js";
import type { PageSnapshot } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(dom: string): PageSnapshot {
  return {
    id: "snap-1",
    scan_session_id: "scan-1",
    url: "https://example.com",
    title: "Test",
    captured_at: new Date().toISOString(),
    full_dom: dom,
    screenshot: "",
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
  };
}

// ---------------------------------------------------------------------------
// detectNavMenu
// ---------------------------------------------------------------------------

describe("detectNavMenu", () => {
  it("detects <nav> elements", () => {
    const dom = '<nav id="main-nav"><ul><li>Home</li></ul></nav>';
    const results = detectNavMenu(dom);
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("nav_menu");
    expect(results[0].selector).toBe("#main-nav");
  });

  it("detects role=navigation", () => {
    const dom = '<div role="navigation" class="sidebar-nav"><a href="/">Home</a></div>';
    const results = detectNavMenu(dom);
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("nav_menu");
  });

  it("returns empty when no nav found", () => {
    const dom = "<div>No navigation here</div>";
    expect(detectNavMenu(dom)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectSearch
// ---------------------------------------------------------------------------

describe("detectSearch", () => {
  it("detects input type=search", () => {
    const dom = '<input type="search" name="q" placeholder="Search...">';
    const results = detectSearch(dom);
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("search");
  });

  it("detects role=search", () => {
    const dom = '<form role="search"><input name="q"></form>';
    const results = detectSearch(dom);
    expect(results.length).toBe(1);
  });

  it("detects search class on form", () => {
    const dom = '<form class="search-form"><input name="q"></form>';
    const results = detectSearch(dom);
    expect(results.length).toBe(1);
  });

  it("detects search in input name/placeholder", () => {
    const dom = '<input name="search" placeholder="Search the site">';
    const results = detectSearch(dom);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty when no search found", () => {
    const dom = '<form><input name="email"><button>Submit</button></form>';
    expect(detectSearch(dom)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectSitemapLink
// ---------------------------------------------------------------------------

describe("detectSitemapLink", () => {
  it("detects sitemap link by text", () => {
    const dom = '<a href="/sitemap">Sitemap</a>';
    const results = detectSitemapLink(dom);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].type).toBe("sitemap_link");
  });

  it("detects sitemap link by href", () => {
    const dom = '<a href="/sitemap.html">Site Map</a>';
    const results = detectSitemapLink(dom);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty when no sitemap link", () => {
    const dom = '<a href="/about">About</a>';
    expect(detectSitemapLink(dom)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectTableOfContents
// ---------------------------------------------------------------------------

describe("detectTableOfContents", () => {
  it("detects TOC by class", () => {
    const dom = '<div class="toc"><ul><li>Section 1</li></ul></div>';
    const results = detectTableOfContents(dom);
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("table_of_contents");
  });

  it("detects TOC by id", () => {
    const dom = '<nav id="table-of-contents"><ul><li>Intro</li></ul></nav>';
    const results = detectTableOfContents(dom);
    expect(results.length).toBe(1);
  });

  it("detects TOC by aria-label", () => {
    const dom = '<nav aria-label="Table of Contents"><ol><li>Ch 1</li></ol></nav>';
    const results = detectTableOfContents(dom);
    expect(results.length).toBe(1);
  });

  it("returns empty when no TOC found", () => {
    const dom = "<div>Regular content</div>";
    expect(detectTableOfContents(dom)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectBreadcrumbs
// ---------------------------------------------------------------------------

describe("detectBreadcrumbs", () => {
  it("detects breadcrumbs by class", () => {
    const dom = '<ol class="breadcrumb"><li>Home</li><li>Page</li></ol>';
    const results = detectBreadcrumbs(dom);
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("breadcrumbs");
  });

  it("detects breadcrumbs by aria-label", () => {
    const dom = '<nav aria-label="Breadcrumb"><ol><li>Home</li></ol></nav>';
    const results = detectBreadcrumbs(dom);
    expect(results.length).toBe(1);
  });

  it("returns empty when no breadcrumbs found", () => {
    const dom = "<div>No breadcrumbs</div>";
    expect(detectBreadcrumbs(dom)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkMultipleWays (2.4.5) — integration
// ---------------------------------------------------------------------------

describe("checkMultipleWays", () => {
  it("auto-passes when 2+ navigation types detected", () => {
    const snap = makeSnapshot(`
      <nav id="main-nav"><ul><li>Home</li></ul></nav>
      <form role="search"><input type="search" name="q"></form>
    `);
    expect(checkMultipleWays(snap)).toEqual([]);
  });

  it("auto-passes with nav + breadcrumbs", () => {
    const snap = makeSnapshot(`
      <nav><ul><li>Home</li></ul></nav>
      <ol class="breadcrumb"><li>Home</li><li>Page</li></ol>
    `);
    expect(checkMultipleWays(snap)).toEqual([]);
  });

  it("auto-passes with nav + sitemap + search (3 types)", () => {
    const snap = makeSnapshot(`
      <nav><ul><li>Home</li></ul></nav>
      <a href="/sitemap">Sitemap</a>
      <input type="search" name="q">
    `);
    expect(checkMultipleWays(snap)).toEqual([]);
  });

  it("flags when only 1 navigation type found", () => {
    const snap = makeSnapshot('<nav id="main"><ul><li>Home</li></ul></nav>');
    const results = checkMultipleWays(snap);
    expect(results.length).toBe(1);
    expect(results[0].wcag_criterion).toBe("2.4.5");
    expect(results[0].measured_values?.distinct_navigation_types).toBe(1);
    expect(results[0].measured_values?.failure_type).toBe("insufficient_navigation_methods");
  });

  it("flags when no navigation methods found", () => {
    const snap = makeSnapshot("<div>Page with no navigation</div>");
    const results = checkMultipleWays(snap);
    expect(results.length).toBe(1);
    expect(results[0].measured_values?.distinct_navigation_types).toBe(0);
  });

  it("reports detected types in measured_values", () => {
    const snap = makeSnapshot(`
      <nav><ul><li>Home</li></ul></nav>
    `);
    const results = checkMultipleWays(snap);
    expect(results[0].measured_values?.detected_types).toEqual(["nav_menu"]);
  });
});

// ---------------------------------------------------------------------------
// detectMotionListeners
// ---------------------------------------------------------------------------

describe("detectMotionListeners", () => {
  it("detects devicemotion addEventListener", () => {
    const dom = '<script>window.addEventListener("devicemotion", handler);</script>';
    const results = detectMotionListeners(dom);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].pattern).toContain("devicemotion");
  });

  it("detects deviceorientation addEventListener", () => {
    const dom = "<script>window.addEventListener('deviceorientation', fn);</script>";
    const results = detectMotionListeners(dom);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("detects DeviceMotionEvent reference", () => {
    const dom = "<script>if (window.DeviceMotionEvent) { /* ... */ }</script>";
    const results = detectMotionListeners(dom);
    expect(results.length).toBe(1);
    expect(results[0].pattern).toBe("DeviceMotionEvent");
  });

  it("returns empty when no motion listeners", () => {
    const dom = '<script>window.addEventListener("click", handler);</script>';
    expect(detectMotionListeners(dom)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkMotionActuation (2.5.4) — integration
// ---------------------------------------------------------------------------

describe("checkMotionActuation", () => {
  it("auto-passes when no motion listeners found", () => {
    const snap = makeSnapshot("<div>Normal page</div>");
    expect(checkMotionActuation(snap)).toEqual([]);
  });

  it("auto-passes for non-motion event listeners", () => {
    const snap = makeSnapshot(
      '<script>window.addEventListener("scroll", handler);</script>',
    );
    expect(checkMotionActuation(snap)).toEqual([]);
  });

  it("flags when devicemotion listener found", () => {
    const snap = makeSnapshot(
      '<script>window.addEventListener("devicemotion", handleMotion);</script>',
    );
    const results = checkMotionActuation(snap);
    expect(results.length).toBe(1);
    expect(results[0].wcag_criterion).toBe("2.5.4");
    expect(results[0].measured_values?.motion_listeners_found).toBeGreaterThanOrEqual(1);
    expect(results[0].measured_values?.failure_type).toBe("motion_actuation_detected");
  });

  it("flags when deviceorientation listener found", () => {
    const snap = makeSnapshot(
      "<script>window.addEventListener('deviceorientation', handleOrientation);</script>",
    );
    const results = checkMotionActuation(snap);
    expect(results.length).toBe(1);
    expect(results[0].wcag_criterion).toBe("2.5.4");
  });

  it("result verdict is needs_review", () => {
    const snap = makeSnapshot(
      '<script>window.addEventListener("devicemotion", fn);</script>',
    );
    const results = checkMotionActuation(snap);
    expect((results[0].raw_result as Record<string, unknown>).verdict).toBe("needs_review");
  });
});
