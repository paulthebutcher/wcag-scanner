import { describe, it, expect } from "vitest";
import {
  normalizeSelector,
  stripVolatileAttributes,
  rootClassList,
  dataWId,
  elementSignature,
  clusterId,
  clusterFindings,
  rankClusters,
  exclusionFor,
  isGrowSurfElement,
  partitionExclusions,
  type Cluster,
} from "../../src/report/clustering.js";
import { renderTopFixesMarkdown, renderExcludedMarkdown } from "../../src/report/top-fixes-report.js";
import { queryFindings } from "../../src/report/generator.js";
import { openDatabase, insertScanSession, insertPageSnapshot, insertFinding } from "../../src/store/db.js";
import { makeTestFinding, contrastReasoning } from "./finding-factory.js";

// ---------------------------------------------------------------------------
// Signature normalization
// ---------------------------------------------------------------------------

describe("signature normalization", () => {
  it("strips positional pseudo-classes from selectors", () => {
    expect(normalizeSelector("body > section:nth-of-type(11) > div > div:nth-child(2) > a:nth-last-child(1)"))
      .toBe("body > section > div > div > a");
    expect(normalizeSelector(".tos-footer-link:nth-child(1)")).toBe(".tos-footer-link");
  });

  it("drops src, href, srcset and style values but keeps other attributes and text", () => {
    const html = `<a href="https://x.test/p?_gl=1*abc" class="btn" style="opacity: 0; transform: none" data-x="1"><img src="a.png" srcset="a.png 1x, b.png 2x" alt="Logo">Go</a>`;
    expect(stripVolatileAttributes(html)).toBe(`<a href class="btn" style data-x="1"><img src srcset alt="Logo">Go</a>`);
  });

  it("reads the root element's sorted class list and data-w-id", () => {
    const html = '<div data-w-id="ff1f" class="btn modal full"><span class="inner"></span></div>';
    expect(rootClassList(html)).toEqual(["btn", "full", "modal"]);
    expect(dataWId(html)).toBe("ff1f");
    expect(dataWId("<div></div>")).toBeNull();
  });

  it("gives the same signature to the same component on different pages", () => {
    const a = makeTestFinding({ failureType: "custom_interactive_no_role", selector: "body > section:nth-of-type(3) > div.btn", html: '<div class="btn modal" style="transform: translate(0, 4px)" data-w-id="w1">Request</div>' });
    const b = makeTestFinding({ failureType: "custom_interactive_no_role", selector: "body > section:nth-of-type(7) > div.btn", html: '<div class="btn modal" style="opacity: 1" data-w-id="w1">Request</div>' });
    expect(elementSignature(a)).toBe(elementSignature(b));
    expect(clusterId(elementSignature(a))).toMatch(/^[0-9a-f]{12}$/);
  });

  it("separates different components and different failure types", () => {
    const base = { failureType: "custom_interactive_no_role", selector: "div.btn", html: '<div class="btn">A</div>' };
    expect(elementSignature(makeTestFinding(base))).not.toBe(elementSignature(makeTestFinding({ ...base, html: '<div class="btn other">A</div>' })));
    expect(elementSignature(makeTestFinding(base))).not.toBe(elementSignature(makeTestFinding({ ...base, failureType: "no_visible_focus_indicator" })));
  });

  it("keys measured colour contrast by foreground colour", () => {
    const footer = makeTestFinding({ criterion: "1.4.3", failureType: "color-contrast", selector: ".tos-footer-link:nth-child(1)", html: '<a class="tos-footer-link">Privacy</a>', reasoning: contrastReasoning("#286140", "#17191e") });
    const cookie = makeTestFinding({ criterion: "1.4.3", failureType: "color-contrast", selector: ".cookie-consent > div > a", html: "<a>here</a>", reasoning: contrastReasoning("#286140", "#1e252b", 2.1) });
    expect(elementSignature(footer)).toBe(elementSignature(cookie));
    expect(elementSignature(footer)).toBe("1.4.3|color-contrast|fg:#286140");
  });

  it("leaves text out of the signature for structural failures (one FAQ fix, one cluster)", () => {
    const faq = (text: string, n: number) => makeTestFinding({
      criterion: "2.4.7", failureType: "focus_on_hidden_element", detectedBy: "playwright",
      selector: `body > section:nth-of-type(${n}) > div > div > p:nth-of-type(${n}) > a`,
      html: `<a href="https://www.popfly.com/post/${n}">${text}</a>`,
    });
    const sigs = new Set([
      faq("how to launch an affiliate program", 1),
      faq("<strong>ambassador program</strong>", 2),
      faq("Sign-up for an onboarding call", 3),
    ].map(elementSignature));
    expect(sigs.size).toBe(1);

    const footer = (text: string) => makeTestFinding({ criterion: "2.4.7", failureType: "no_visible_focus_indicator", detectedBy: "playwright", selector: "footer a", html: `<a href="/x" class="footer-link-l2">${text}</a>` });
    expect(elementSignature(footer("Centralize"))).toBe(elementSignature(footer("Ambassadorship")));
  });

  it("keeps text in the signature where the wording is the problem", () => {
    const link = (text: string) => makeTestFinding({ criterion: "2.4.4", failureType: "generic_link_text", detectedBy: "claude_api", selector: "main a", html: `<a href="/x" class="c-btn">${text}</a>` });
    expect(elementSignature(link("Learn more"))).not.toBe(elementSignature(link("Read more")));
    const alt = (a: string) => makeTestFinding({ criterion: "1.1.1", failureType: "placeholder_alt", html: `<img src="x.png" alt="${a}">`, selector: "img" });
    expect(elementSignature(alt("image"))).not.toBe(elementSignature(alt("photo")));
    const semanticAlt = (a: string) => makeTestFinding({ criterion: "1.1.1", failureType: "semantic", html: `<img src="x.png" alt="${a}">`, selector: "img" });
    expect(elementSignature(semanticAlt("1"))).not.toBe(elementSignature(semanticAlt("2")));
  });

  it("is deterministic across calls", () => {
    const f = makeTestFinding({ failureType: "aria-prohibited-attr", html: '<div aria-label="Next" class="swiper-button-next"></div>' });
    expect(elementSignature(f)).toBe(elementSignature(structuredClone(f)));
  });
});

// ---------------------------------------------------------------------------
// Clustering + ranking
// ---------------------------------------------------------------------------

describe("clusterFindings", () => {
  it("expands deduplicated findings to every page and counts occurrences", () => {
    const footer = makeTestFinding({
      criterion: "2.4.7", failureType: "no_visible_focus_indicator", detectedBy: "playwright",
      selector: "footer a.link", html: '<a class="link">Home</a>',
      measured: { also_found_on_pages: 2, also_found_on_urls: ["https://s.test/b", "https://s.test/c"] },
    });
    const axe = makeTestFinding({ failureType: "aria-prohibited-attr", html: '<div aria-label="x" class="y"></div>' });
    const clusters = clusterFindings([
      { finding: footer, pageUrl: "https://s.test/" },
      { finding: axe, pageUrl: "https://s.test/" },
      { finding: { ...axe, id: "axe-2", page_snapshot_id: "snap-2" }, pageUrl: "https://s.test/b" },
    ]);
    const focus = clusters.find((c) => c.failure_type === "no_visible_focus_indicator")!;
    expect(focus.page_urls).toEqual(["https://s.test/", "https://s.test/b", "https://s.test/c"]);
    expect(focus.occurrence_count).toBe(3);
    expect(focus.pages_complete).toBe(true);
    const aria = clusters.find((c) => c.failure_type === "aria-prohibited-attr")!;
    expect(aria.occurrence_count).toBe(2);
    expect(aria.page_count).toBe(2);
    expect(aria.finding_ids).toHaveLength(2);
  });

  it("uses the folded count when page URLs were not recorded (older scans)", () => {
    const legacy = makeTestFinding({ criterion: "2.4.1", failureType: "missing_skip_navigation", detectedBy: "playwright", html: "<html>", measured: { also_found_on_pages: 49 } });
    const [c] = clusterFindings([{ finding: legacy, pageUrl: "https://s.test/" }]);
    expect(c.occurrence_count).toBe(50);
    expect(c.page_count).toBe(50);
    expect(c.pages_complete).toBe(false);
  });

  it("ranks by occurrences cleared per fix, then pages, then severity", () => {
    const mk = (id: string, occ: number, pages: number, severity: Cluster["severity"]): Cluster => ({
      cluster_id: id, signature: id, failure_type: "x", wcag_criterion: "1.1.1", severity,
      page_urls: [], page_count: pages, occurrence_count: occ, pages_complete: true,
      representative: { selector: "", html: "", page_url: "" },
      remediation: { summary: "", steps: [], designer_path: "", code_fix: null }, finding_ids: [], findings: [],
    });
    const ranked = rankClusters([mk("a", 10, 5, "minor"), mk("b", 50, 2, "minor"), mk("c", 10, 9, "minor"), mk("d", 10, 5, "critical")]);
    expect(ranked.map((c) => c.cluster_id)).toEqual(["b", "c", "d", "a"]);
  });

  it("builds one remediation per cluster with the measured colours", () => {
    const fs = [
      makeTestFinding({ criterion: "1.4.3", failureType: "color-contrast", reasoning: contrastReasoning("#286140", "#17191e") }),
      makeTestFinding({ criterion: "1.4.3", failureType: "color-contrast", reasoning: contrastReasoning("#286140", "#1e252b", 2.2) }),
    ];
    const [c] = clusterFindings(fs.map((finding) => ({ finding, pageUrl: "https://s.test/" })));
    expect(c.remediation.summary).toContain("#286140");
    expect(c.remediation.summary).toContain("#17191e");
    expect(c.remediation.summary).toContain("#1e252b");
  });
});

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

describe("exclusions", () => {
  it("sends unmeasurable axe contrast to Needs manual check", () => {
    for (const reason of [
      "because element contains an image node",
      "due to a background gradient",
      "because it is overlapped by another element",
      "because it partially overlaps other elements",
    ]) {
      const f = makeTestFinding({ criterion: "1.4.3", failureType: "color-contrast", reasoning: `Fix any of the following:\n  Element's background color could not be determined ${reason}` });
      const ex = exclusionFor(f)!;
      expect(ex.reason).toBe("needs_manual_check");
      expect(ex.detail).toContain("could not be determined");
    }
  });

  it("keeps measured contrast failures", () => {
    expect(exclusionFor(makeTestFinding({ criterion: "1.4.3", failureType: "color-contrast", reasoning: contrastReasoning("#286140", "#17191e") }))).toBeNull();
  });

  it("sends GrowSurf elements to Third-party by id, class or selector", () => {
    const byId = makeTestFinding({ failureType: "empty_link", html: '<a id="grsf-referred-experience" href="/x"></a>' });
    const byClass = makeTestFinding({ failureType: "animated_content_no_pause", html: '<div class="grsf-window-slider-chrome">' });
    const bySelector = makeTestFinding({ failureType: "missing_autocomplete", selector: ".grsf-form-control:nth-child(2)", html: '<input name="email">' });
    for (const f of [byId, byClass, bySelector]) expect(exclusionFor(f)).toEqual({ reason: "third_party", detail: "GrowSurf" });
    expect(exclusionFor(makeTestFinding({ failureType: "x", html: '<div class="mygrsf-thing">' }))).toBeNull();
  });

  it("recognises GrowSurf content in one function: data-grsf-*, grsf- on element or ancestor, growsurf URLs", () => {
    // The landing-page images that ranked #4-6 in Top fixes on 0b7d5e28
    const image = makeTestFinding({
      criterion: "1.1.1", failureType: "alt_not_descriptive", detectedBy: "claude_api",
      selector: 'img[src="https://res.cloudinary.com/growsurf-prod/image/upload/v1763678699/landing_pages/"]',
      html: '<img src="https://res.cloudinary.com/growsurf-prod/image/upload/v1763678699/landing_pages/bbpflr0mijggzpm1fn9i.png" alt="1" loading="lazy" decoding="async" fetchpriority="low" data-grsf-lazy-applied="true">',
    });
    expect(isGrowSurfElement(image)).toBe(true);
    expect(exclusionFor(image)).toEqual({ reason: "third_party", detail: "GrowSurf" });

    const cases: Array<[string, string, boolean]> = [
      ['<span data-grsf-campaign="x">Refer</span>', "span", true],                       // data-grsf-* on the element
      ['<div class="grsf-window-slider-chrome">', "div", true],                         // grsf- class on the element
      ["<a>here</a>", "#grsf-share-modal > div > a", true],                             // grsf- id on an ancestor
      ["<p>Copy</p>", ".grsf-window .content > p", true],                                // grsf- class on an ancestor
      ['<a href="https://growsurf.com/referral">Join</a>', "a", true],                  // growsurf href
      ['<img src="/hero.png" alt="">', "img", false],
      ['<div class="mygrsf-thing">', "div", false],                                      // not a prefix
      ['<a href="/surf-trip">Growing your surf brand</a>', "a", false],
    ];
    for (const [html, selector, expected] of cases) {
      expect(isGrowSurfElement(makeTestFinding({ failureType: "x", html, selector })), html).toBe(expected);
    }
  });

  it("partitions findings and renders separate sections", () => {
    const kept = makeTestFinding({ failureType: "aria-prohibited-attr" });
    const manual = makeTestFinding({ criterion: "1.4.3", failureType: "color-contrast", selector: "h1", reasoning: "Element's background color could not be determined due to a background gradient" });
    const third = makeTestFinding({ failureType: "empty_link", html: '<a id="grsf-x"></a>' });
    const { kept: k, excluded } = partitionExclusions([kept, manual, third].map((finding) => ({ finding, pageUrl: "https://s.test/p" })));
    expect(k.map((p) => p.finding.id)).toEqual([kept.id]);
    const md = renderExcludedMarkdown(excluded);
    expect(md).toContain("## Needs manual check (1)");
    expect(md).toContain("background colour could not be determined: a background gradient");
    expect(md).toContain("## Third-party (1)");
  });

  it("leaves excluded findings out of report groups and counts, without changing criterion status", () => {
    const db = openDatabase(":memory:");
    try {
      insertScanSession(db, { id: "scan-1", url: "https://s.test", platform: "webflow", platform_detected_via: "x", initiated_at: "2024-01-01T00:00:00Z", completed_at: "2024-01-01T00:01:00Z", comparison_scan_id: null, scan_type: "initial" });
      insertPageSnapshot(db, { id: "snap-1", scan_session_id: "scan-1", url: "https://s.test/", title: "t", captured_at: "2024-01-01T00:00:10Z", full_dom: "<html></html>", screenshot: "s.png", viewport: { width: 1280, height: 800, deviceScaleFactor: 1 } });
      insertFinding(db, makeTestFinding({ id: "kept", criterion: "1.4.3", failureType: "color-contrast", reasoning: contrastReasoning("#286140", "#17191e") }));
      insertFinding(db, makeTestFinding({ id: "manual", criterion: "1.4.3", failureType: "color-contrast", reasoning: "Element's background color could not be determined because element contains an image node" }));
      insertFinding(db, makeTestFinding({ id: "third", criterion: "2.2.2", failureType: "animated_content_no_pause", html: '<div class="grsf-window">' }));

      const data = queryFindings(db, "scan-1");
      expect(data.groups.flatMap((g) => g.findings.map((f) => f.id))).toEqual(["kept"]);
      expect(data.summary?.total_findings).toBe(1);
      expect(data.excluded?.map((e) => [e.finding.id, e.reason]).sort()).toEqual([["manual", "needs_manual_check"], ["third", "third_party"]]);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Top fixes section
// ---------------------------------------------------------------------------

describe("Top fixes markdown", () => {
  it("lists at most ten clusters with occurrences and pages", () => {
    const findings = Array.from({ length: 12 }, (_, i) =>
      makeTestFinding({ failureType: "aria-prohibited-attr", html: `<div class="c${i}" aria-label="x"></div>` }));
    const md = renderTopFixesMarkdown(clusterFindings(findings.map((finding) => ({ finding, pageUrl: "https://s.test/" }))));
    expect(md).toContain("## Top fixes");
    expect(md.match(/^\| \d+ \|/gm)).toHaveLength(10);
  });
});
