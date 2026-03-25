import { describe, it, expect } from "vitest";
import {
  collectLinksForDuplication,
  runDuplicateLinkChecks,
  type LinkInfo,
} from "../../src/checks/semantic/duplicate-links.js";

// ---------------------------------------------------------------------------
// Test HTML
// ---------------------------------------------------------------------------

const DOWNLOAD_REPORT_HTML = `
<html><body>
  <a href="/reports/q1.pdf" class="dl-link">Download Report</a>
  <a href="/reports/q2.pdf" class="dl-link">Download Report</a>
  <a href="/reports/q3.pdf" class="dl-link">Download Report</a>
</body></html>
`;

const ARIA_LABEL_DUPLICATES_HTML = `
<html><body>
  <a href="/page-a" aria-label="Learn more" class="cta">Details A</a>
  <a href="/page-b" aria-label="Learn more" class="cta">Details B</a>
</body></html>
`;

const SAME_TEXT_SAME_URL_HTML = `
<html><body>
  <a href="/about" class="nav">About</a>
  <a href="/about" class="footer-nav">About</a>
</body></html>
`;

const UNIQUE_LINKS_HTML = `
<html><body>
  <a href="/home">Home</a>
  <a href="/about">About</a>
  <a href="/contact">Contact</a>
</body></html>
`;

const MIXED_HTML = `
<html><body>
  <a href="/a" class="link">Read More</a>
  <a href="/b" class="link">Read More</a>
  <a href="/c" class="link">Unique Link</a>
  <a href="/about">About</a>
  <a href="/about">About</a>
</body></html>
`;

const EMPTY_LINKS_HTML = `
<html><body>
  <a href="#">Skip</a>
  <a href="">Nothing</a>
  <a href="/page"></a>
</body></html>
`;

const CASE_INSENSITIVE_HTML = `
<html><body>
  <a href="/x" class="a1">Read More</a>
  <a href="/y" class="a2">read more</a>
  <a href="/z" class="a3">READ MORE</a>
</body></html>
`;

// ---------------------------------------------------------------------------
// collectLinksForDuplication
// ---------------------------------------------------------------------------

describe("collectLinksForDuplication", () => {
  it("extracts links with href and text", () => {
    const links = collectLinksForDuplication(UNIQUE_LINKS_HTML);
    expect(links).toHaveLength(3);
    expect(links[0].href).toBe("/home");
    expect(links[0].accessibleName).toBe("Home");
    expect(links[0].visibleText).toBe("Home");
  });

  it("uses aria-label as accessible name when present", () => {
    const links = collectLinksForDuplication(ARIA_LABEL_DUPLICATES_HTML);
    expect(links).toHaveLength(2);
    expect(links[0].accessibleName).toBe("Learn more");
    expect(links[0].visibleText).toBe("Details A");
  });

  it("strips HTML tags from visible text", () => {
    const dom = `<html><body><a href="/page"><strong>Bold</strong> text</a></body></html>`;
    const links = collectLinksForDuplication(dom);
    expect(links).toHaveLength(1);
    expect(links[0].visibleText).toBe("Bold text");
  });

  it("skips href='#' links", () => {
    const links = collectLinksForDuplication(EMPTY_LINKS_HTML);
    // href="#" is skipped, href="" is skipped, empty text link is skipped
    expect(links).toHaveLength(0);
  });

  it("skips links with no accessible name", () => {
    const dom = `<html><body><a href="/page"></a></body></html>`;
    const links = collectLinksForDuplication(dom);
    expect(links).toHaveLength(0);
  });

  it("returns empty for no links", () => {
    const links = collectLinksForDuplication(`<html><body><p>No links</p></body></html>`);
    expect(links).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runDuplicateLinkChecks
// ---------------------------------------------------------------------------

describe("runDuplicateLinkChecks", () => {
  it("flags 'Download Report' pattern (same text, different URLs)", () => {
    const results = runDuplicateLinkChecks(DOWNLOAD_REPORT_HTML);
    expect(results).toHaveLength(1);
    expect(results[0].measured_values?.failure_type).toBe("duplicate_link_text");
    expect(results[0].measured_values?.duplicate_count).toBe(3);
    expect(results[0].measured_values?.distinct_urls).toBe(3);
    expect(results[0].measured_values?.accessible_name).toBe("Download Report");
  });

  it("flags aria-label duplicates pointing to different URLs", () => {
    const results = runDuplicateLinkChecks(ARIA_LABEL_DUPLICATES_HTML);
    expect(results).toHaveLength(1);
    expect(results[0].measured_values?.duplicate_count).toBe(2);
    expect(results[0].measured_values?.accessible_name).toBe("Learn more");
  });

  it("does NOT flag links with same text AND same URL", () => {
    const results = runDuplicateLinkChecks(SAME_TEXT_SAME_URL_HTML);
    expect(results).toHaveLength(0);
  });

  it("does NOT flag unique link text", () => {
    const results = runDuplicateLinkChecks(UNIQUE_LINKS_HTML);
    expect(results).toHaveLength(0);
  });

  it("returns one CheckResult per duplicate group, not per link", () => {
    // MIXED_HTML has "Read More" x2 (different URLs) and "About" x2 (same URL)
    const results = runDuplicateLinkChecks(MIXED_HTML);
    // Only "Read More" group should produce a result
    expect(results).toHaveLength(1);
    expect(results[0].measured_values?.accessible_name).toBe("Read More");
  });

  it("sets correct wcag_criterion '2.4.4'", () => {
    const results = runDuplicateLinkChecks(DOWNLOAD_REPORT_HTML);
    expect(results[0].wcag_criterion).toBe("2.4.4");
  });

  it("sets correct failure_type 'duplicate_link_text'", () => {
    const results = runDuplicateLinkChecks(DOWNLOAD_REPORT_HTML);
    expect(results[0].measured_values?.failure_type).toBe("duplicate_link_text");
  });

  it("measured_values includes duplicate_count and distinct_urls", () => {
    const results = runDuplicateLinkChecks(DOWNLOAD_REPORT_HTML);
    const mv = results[0].measured_values!;
    expect(mv).toHaveProperty("duplicate_count");
    expect(mv).toHaveProperty("distinct_urls");
    expect(mv).toHaveProperty("sample_urls");
    expect((mv.sample_urls as string[]).length).toBeLessThanOrEqual(3);
  });

  it("returns empty for no links", () => {
    const results = runDuplicateLinkChecks(`<html><body><p>No links</p></body></html>`);
    expect(results).toHaveLength(0);
  });

  it("case-insensitive name matching", () => {
    const results = runDuplicateLinkChecks(CASE_INSENSITIVE_HTML);
    expect(results).toHaveLength(1);
    expect(results[0].measured_values?.duplicate_count).toBe(3);
    expect(results[0].measured_values?.distinct_urls).toBe(3);
  });
});
