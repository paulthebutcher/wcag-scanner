import { describe, it, expect } from "vitest";
import {
  detectCSSAnimations,
  detectCarousels,
  detectGIFs,
  detectVideos,
  findPauseMechanisms,
  checkPauseStopHide,
  checkThreeFlashes,
} from "../../src/checks/indicators/pause-stop-hide.js";
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
// detectCSSAnimations
// ---------------------------------------------------------------------------

describe("detectCSSAnimations", () => {
  it("detects inline animation styles", () => {
    const dom = '<div id="banner" style="animation: fadeIn 2s infinite"></div>';
    const results = detectCSSAnimations(dom);
    expect(results.length).toBe(1);
    expect(results[0].animationType).toBe("css_animation");
    expect(results[0].infinite).toBe(true);
    expect(results[0].duration).toBe(2000);
    expect(results[0].selector).toBe("#banner");
  });

  it("detects animation in style blocks", () => {
    const dom = `
      <style>
        .hero { animation: slide 3s ease-in-out infinite; }
      </style>
      <div class="hero">Hello</div>
    `;
    const results = detectCSSAnimations(dom);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.infinite)).toBe(true);
  });

  it("detects non-infinite animations", () => {
    const dom = '<div id="once" style="animation: fadeIn 1s ease"></div>';
    const results = detectCSSAnimations(dom);
    expect(results.length).toBe(1);
    expect(results[0].infinite).toBe(false);
    expect(results[0].duration).toBe(1000);
  });

  it("handles ms durations", () => {
    const dom = '<div id="fast" style="animation: blink 200ms infinite"></div>';
    const results = detectCSSAnimations(dom);
    expect(results.length).toBe(1);
    expect(results[0].duration).toBe(200);
  });

  it("returns empty for pages without animations", () => {
    const dom = "<div>No animations here</div>";
    expect(detectCSSAnimations(dom)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectCarousels
// ---------------------------------------------------------------------------

describe("detectCarousels", () => {
  it("detects carousel by class name", () => {
    const dom = '<div class="carousel"><div class="slide">A</div></div>';
    const results = detectCarousels(dom);
    expect(results.length).toBe(1);
    expect(results[0].animationType).toBe("carousel");
    expect(results[0].infinite).toBe(true);
  });

  it("detects slider class", () => {
    const dom = '<div class="hero-slider swiper"></div>';
    const results = detectCarousels(dom);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("detects autoplay data attribute", () => {
    const dom = '<div class="slides" data-autoplay="true"></div>';
    const results = detectCarousels(dom);
    expect(results.length).toBe(1);
  });

  it("detects marquee elements", () => {
    const dom = "<marquee>Scrolling text</marquee>";
    const results = detectCarousels(dom);
    expect(results.length).toBe(1);
    expect(results[0].animationType).toBe("auto_scroll");
  });

  it("returns empty for pages without carousels", () => {
    const dom = "<div>Static content</div>";
    expect(detectCarousels(dom)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectGIFs
// ---------------------------------------------------------------------------

describe("detectGIFs", () => {
  it("detects GIF images", () => {
    const dom = '<img src="/images/loading.gif" alt="Loading">';
    const results = detectGIFs(dom);
    expect(results.length).toBe(1);
    expect(results[0].animationType).toBe("gif");
  });

  it("detects GIFs with query strings", () => {
    const dom = '<img src="https://cdn.example.com/banner.gif?v=2" alt="">';
    const results = detectGIFs(dom);
    expect(results.length).toBe(1);
  });

  it("does not detect non-GIF images", () => {
    const dom = '<img src="/images/photo.jpg" alt="Photo">';
    expect(detectGIFs(dom)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectVideos
// ---------------------------------------------------------------------------

describe("detectVideos", () => {
  it("detects autoplay videos", () => {
    const dom = '<video autoplay loop muted><source src="bg.mp4"></video>';
    const results = detectVideos(dom);
    expect(results.length).toBe(1);
    expect(results[0].animationType).toBe("video");
    expect(results[0].infinite).toBe(true);
  });

  it("ignores videos without autoplay", () => {
    const dom = '<video controls><source src="tutorial.mp4"></video>';
    const results = detectVideos(dom);
    expect(results.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// findPauseMechanisms
// ---------------------------------------------------------------------------

describe("findPauseMechanisms", () => {
  it("detects pause button by aria-label", () => {
    const dom = '<button aria-label="Pause animation">||</button>';
    const results = findPauseMechanisms(dom);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].mechanismType).toBe("button");
  });

  it("detects pause button by text", () => {
    const dom = "<button>Pause</button>";
    const results = findPauseMechanisms(dom);
    expect(results.length).toBe(1);
  });

  it("detects prefers-reduced-motion media query", () => {
    const dom = `
      <style>
        @media (prefers-reduced-motion: reduce) { .animated { animation: none; } }
      </style>
    `;
    const results = findPauseMechanisms(dom);
    expect(results.length).toBe(1);
    expect(results[0].mechanismType).toBe("attribute");
    expect(results[0].selector).toBe("@media");
  });

  it("returns empty when no mechanisms found", () => {
    const dom = "<div>No controls</div>";
    expect(findPauseMechanisms(dom)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkPauseStopHide (2.2.2) — integration
// ---------------------------------------------------------------------------

describe("checkPauseStopHide", () => {
  it("auto-passes when no animated content found", () => {
    const snap = makeSnapshot("<div>Static page</div>");
    expect(checkPauseStopHide(snap)).toEqual([]);
  });

  it("flags infinite animation without pause mechanism", () => {
    const snap = makeSnapshot(
      '<div id="hero" style="animation: slide 3s infinite"></div>',
    );
    const results = checkPauseStopHide(snap);
    expect(results.length).toBe(1);
    expect(results[0].wcag_criterion).toBe("2.2.2");
    expect(results[0].measured_values?.pause_mechanism_found).toBe(false);
    expect(results[0].measured_values?.failure_type).toBe("animated_content_no_pause");
  });

  it("still flags with needs_review when pause mechanism exists", () => {
    const snap = makeSnapshot(`
      <div id="carousel" class="carousel"></div>
      <button aria-label="Pause animation">||</button>
    `);
    const results = checkPauseStopHide(snap);
    expect(results.length).toBe(1);
    expect(results[0].measured_values?.pause_mechanism_found).toBe(true);
    expect(results[0].measured_values?.failure_type).toBe("animated_content_needs_review");
  });

  it("detects both CSS animations and carousels", () => {
    const snap = makeSnapshot(`
      <div id="anim" style="animation: spin 2s infinite"></div>
      <div class="slider"></div>
    `);
    const results = checkPauseStopHide(snap);
    expect(results.length).toBe(2);
    expect(results.every((r) => r.wcag_criterion === "2.2.2")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkThreeFlashes (2.3.1) — integration
// ---------------------------------------------------------------------------

describe("checkThreeFlashes", () => {
  it("auto-passes when no flashing content found", () => {
    const snap = makeSnapshot("<div>Static page</div>");
    expect(checkThreeFlashes(snap)).toEqual([]);
  });

  it("flags GIF elements", () => {
    const snap = makeSnapshot('<img src="flash.gif" alt="Flash">');
    const results = checkThreeFlashes(snap);
    expect(results.length).toBe(1);
    expect(results[0].wcag_criterion).toBe("2.3.1");
    expect(results[0].measured_values?.content_type).toBe("gif");
  });

  it("flags autoplay videos", () => {
    const snap = makeSnapshot('<video autoplay loop muted src="bg.mp4"></video>');
    const results = checkThreeFlashes(snap);
    expect(results.length).toBe(1);
    expect(results[0].measured_values?.content_type).toBe("video");
  });

  it("flags short-duration CSS animations", () => {
    const snap = makeSnapshot(
      '<div id="blink" style="animation: blink 100ms infinite"></div>',
    );
    const results = checkThreeFlashes(snap);
    expect(results.length).toBe(1);
    expect(results[0].measured_values?.content_type).toBe("css_animation");
    expect(results[0].measured_values?.duration_ms).toBe(100);
  });

  it("does not flag long CSS animations", () => {
    const snap = makeSnapshot(
      '<div id="slow" style="animation: fade 5s infinite"></div>',
    );
    const results = checkThreeFlashes(snap);
    // 5s animation is not a flash risk
    expect(results.length).toBe(0);
  });

  it("all flagged results are needs_review", () => {
    const snap = makeSnapshot(`
      <img src="a.gif" alt="">
      <video autoplay src="v.mp4"></video>
    `);
    const results = checkThreeFlashes(snap);
    expect(results.length).toBe(2);
    for (const r of results) {
      expect((r.raw_result as Record<string, unknown>).verdict).toBe("needs_review");
    }
  });
});
