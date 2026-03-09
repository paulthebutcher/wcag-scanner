import { describe, it, expect } from "vitest";
import {
  deduplicateBehavioralResults,
  DEDUP_CRITERIA,
  type BehavioralPageEntry,
} from "../../src/core/scanner.js";
import type { CheckResult } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    element_selector: "nav a.link",
    element_html: '<a class="link" href="/">Home</a>',
    wcag_criterion: "2.4.7",
    detected_by: "playwright",
    raw_result: { type: "no_focus_indicator" },
    ...overrides,
  };
}

function makePage(
  snapshotId: string,
  url: string,
  results: CheckResult[],
): BehavioralPageEntry {
  return {
    snapshotId,
    snapshotUrl: url,
    results,
    fullScreenshot: Buffer.from("fake-screenshot"),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deduplicateBehavioralResults", () => {
  it("returns pages unchanged when there are no duplicates", () => {
    const pages = [
      makePage("snap-1", "https://example.com/", [
        makeResult({ element_selector: ".unique-1" }),
      ]),
      makePage("snap-2", "https://example.com/about", [
        makeResult({ element_selector: ".unique-2" }),
      ]),
    ];

    const result = deduplicateBehavioralResults(pages);

    expect(result).toHaveLength(2);
    expect(result[0].results).toHaveLength(1);
    expect(result[1].results).toHaveLength(1);
  });

  it("removes duplicate findings on secondary pages", () => {
    // Same navbar link found on 3 pages
    const navResult = makeResult({
      element_selector: "nav a.home",
      element_html: '<a class="home" href="/">Home</a>',
      wcag_criterion: "2.4.7",
    });

    const pages = [
      makePage("snap-1", "https://example.com/", [navResult]),
      makePage("snap-2", "https://example.com/about", [navResult]),
      makePage("snap-3", "https://example.com/contact", [navResult]),
    ];

    const result = deduplicateBehavioralResults(pages);

    // Only the first page should have the finding
    expect(result).toHaveLength(1);
    expect(result[0].snapshotId).toBe("snap-1");
    expect(result[0].results).toHaveLength(1);
  });

  it("annotates primary finding with count of other pages", () => {
    const navResult = makeResult({
      element_selector: "nav a.home",
      element_html: '<a class="home" href="/">Home</a>',
    });

    const pages = [
      makePage("snap-1", "https://example.com/", [navResult]),
      makePage("snap-2", "https://example.com/about", [navResult]),
      makePage("snap-3", "https://example.com/contact", [navResult]),
    ];

    const result = deduplicateBehavioralResults(pages);
    const primary = result[0].results[0];

    expect(primary.measured_values?.also_found_on_pages).toBe(2);
    expect(primary.measured_values?.dedup_note).toBe(
      "Also found on 2 other pages",
    );
  });

  it("uses singular 'page' when found on exactly 1 other page", () => {
    const navResult = makeResult();

    const pages = [
      makePage("snap-1", "https://example.com/", [navResult]),
      makePage("snap-2", "https://example.com/about", [navResult]),
    ];

    const result = deduplicateBehavioralResults(pages);
    const primary = result[0].results[0];

    expect(primary.measured_values?.dedup_note).toBe(
      "Also found on 1 other page",
    );
  });

  it("does NOT deduplicate criteria outside of DEDUP_CRITERIA", () => {
    // Modal focus management (2.4.11 equivalent or 2.1.2) is NOT in dedup set
    const modalResult = makeResult({
      wcag_criterion: "2.1.2",
      element_selector: ".modal-trigger",
      element_html: '<button class="modal-trigger">Open</button>',
    });

    // Verify 2.1.2 is not in the dedup criteria
    expect(DEDUP_CRITERIA.has("2.1.2")).toBe(false);

    const pages = [
      makePage("snap-1", "https://example.com/", [modalResult]),
      makePage("snap-2", "https://example.com/about", [modalResult]),
    ];

    const result = deduplicateBehavioralResults(pages);

    // Both pages should keep their findings
    expect(result).toHaveLength(2);
    expect(result[0].results).toHaveLength(1);
    expect(result[1].results).toHaveLength(1);
  });

  it("deduplicates all four eligible criteria", () => {
    // Each criterion in DEDUP_CRITERIA should be deduplicated
    for (const criterion of DEDUP_CRITERIA) {
      const shared = makeResult({
        wcag_criterion: criterion,
        element_selector: "nav a.shared",
        element_html: '<a class="shared">Link</a>',
      });

      const pages = [
        makePage("snap-1", "https://example.com/", [shared]),
        makePage("snap-2", "https://example.com/about", [shared]),
      ];

      const result = deduplicateBehavioralResults(pages);
      const totalResults = result.reduce((s, p) => s + p.results.length, 0);
      expect(totalResults).toBe(1);
    }
  });

  it("keeps unique findings per page alongside deduplicated ones", () => {
    const sharedNav = makeResult({
      element_selector: "nav a.home",
      element_html: '<a class="home">Home</a>',
      wcag_criterion: "2.4.7",
    });
    const uniqueOnPage1 = makeResult({
      element_selector: ".hero-btn",
      element_html: '<button class="hero-btn">Go</button>',
      wcag_criterion: "2.4.7",
    });
    const uniqueOnPage2 = makeResult({
      element_selector: ".sidebar-link",
      element_html: '<a class="sidebar-link">Info</a>',
      wcag_criterion: "2.4.7",
    });

    const pages = [
      makePage("snap-1", "https://example.com/", [sharedNav, uniqueOnPage1]),
      makePage("snap-2", "https://example.com/about", [sharedNav, uniqueOnPage2]),
    ];

    const result = deduplicateBehavioralResults(pages);

    // Page 1 keeps: sharedNav (primary) + uniqueOnPage1
    // Page 2 keeps: uniqueOnPage2 (sharedNav is deduplicated away)
    expect(result).toHaveLength(2);
    expect(result[0].results).toHaveLength(2);
    expect(result[1].results).toHaveLength(1);
    expect(result[1].results[0].element_selector).toBe(".sidebar-link");
  });

  it("omits pages with zero remaining results after deduplication", () => {
    const shared = makeResult({
      element_selector: "nav a.home",
      element_html: '<a class="home">Home</a>',
    });

    // Page 2 only has the shared finding
    const pages = [
      makePage("snap-1", "https://example.com/", [
        shared,
        makeResult({ element_selector: ".unique" }),
      ]),
      makePage("snap-2", "https://example.com/about", [shared]),
    ];

    const result = deduplicateBehavioralResults(pages);

    // Page 2 has nothing left after dedup, should be omitted
    expect(result).toHaveLength(1);
    expect(result[0].snapshotId).toBe("snap-1");
  });

  it("preserves existing measured_values when annotating", () => {
    const resultWithValues = makeResult({
      measured_values: { contrast_ratio: 3.5, focus_visible: false },
    });

    const pages = [
      makePage("snap-1", "https://example.com/", [resultWithValues]),
      makePage("snap-2", "https://example.com/about", [resultWithValues]),
    ];

    const result = deduplicateBehavioralResults(pages);
    const primary = result[0].results[0];

    expect(primary.measured_values?.contrast_ratio).toBe(3.5);
    expect(primary.measured_values?.focus_visible).toBe(false);
    expect(primary.measured_values?.also_found_on_pages).toBe(1);
  });

  it("handles mixed criteria with some deduped and some not", () => {
    const shared247 = makeResult({
      wcag_criterion: "2.4.7",
      element_selector: "nav a",
      element_html: "<a>Nav</a>",
    });
    const shared211 = makeResult({
      wcag_criterion: "2.1.1",
      element_selector: ".widget",
      element_html: '<div class="widget"></div>',
    });
    // 2.1.2 is NOT in DEDUP_CRITERIA
    const nonDedup = makeResult({
      wcag_criterion: "2.1.2",
      element_selector: ".trap",
      element_html: '<div class="trap"></div>',
    });

    const pages = [
      makePage("snap-1", "https://example.com/", [shared247, shared211, nonDedup]),
      makePage("snap-2", "https://example.com/about", [shared247, shared211, nonDedup]),
    ];

    const result = deduplicateBehavioralResults(pages);

    // Page 1: shared247(primary) + shared211(primary) + nonDedup = 3
    // Page 2: nonDedup only = 1 (shared ones removed)
    expect(result).toHaveLength(2);
    expect(result[0].results).toHaveLength(3);
    expect(result[1].results).toHaveLength(1);
    expect(result[1].results[0].wcag_criterion).toBe("2.1.2");
  });

  it("deduplicates by criterion+selector+html, not just selector", () => {
    // Same selector, different HTML → different elements → NOT deduplicated
    const navLink1 = makeResult({
      element_selector: "nav a",
      element_html: '<a href="/">Home</a>',
      wcag_criterion: "2.4.7",
    });
    const navLink2 = makeResult({
      element_selector: "nav a",
      element_html: '<a href="/about">About</a>',
      wcag_criterion: "2.4.7",
    });

    const pages = [
      makePage("snap-1", "https://example.com/", [navLink1]),
      makePage("snap-2", "https://example.com/about", [navLink2]),
    ];

    const result = deduplicateBehavioralResults(pages);

    // Different element_html means these are distinct findings
    expect(result).toHaveLength(2);
    expect(result[0].results).toHaveLength(1);
    expect(result[1].results).toHaveLength(1);
  });

  it("handles empty input", () => {
    const result = deduplicateBehavioralResults([]);
    expect(result).toEqual([]);
  });

  it("handles single page with no dedup-eligible results", () => {
    const pages = [
      makePage("snap-1", "https://example.com/", [
        makeResult({ wcag_criterion: "2.1.2" }),
      ]),
    ];

    const result = deduplicateBehavioralResults(pages);
    expect(result).toHaveLength(1);
    expect(result[0].results).toHaveLength(1);
  });

  it("keeps snapshotId and fullScreenshot from original page entries", () => {
    const pages = [
      makePage("snap-abc", "https://example.com/", [
        makeResult({ element_selector: ".unique" }),
      ]),
    ];

    const result = deduplicateBehavioralResults(pages);
    expect(result[0].snapshotId).toBe("snap-abc");
    expect(result[0].fullScreenshot).toEqual(Buffer.from("fake-screenshot"));
  });
});

describe("DEDUP_CRITERIA", () => {
  it("contains exactly the 4 expected criteria", () => {
    expect(DEDUP_CRITERIA.size).toBe(4);
    expect(DEDUP_CRITERIA.has("2.4.7")).toBe(true); // focus visible
    expect(DEDUP_CRITERIA.has("2.4.3")).toBe(true); // focus order
    expect(DEDUP_CRITERIA.has("2.1.1")).toBe(true); // keyboard reachability
    expect(DEDUP_CRITERIA.has("2.4.1")).toBe(true); // skip nav
  });

  it("does NOT include modal/trap criteria", () => {
    expect(DEDUP_CRITERIA.has("2.1.2")).toBe(false); // keyboard trap
    expect(DEDUP_CRITERIA.has("2.4.11")).toBe(false);
  });
});
