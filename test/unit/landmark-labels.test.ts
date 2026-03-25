import { describe, it, expect } from "vitest";
import {
  extractNavElements,
  runLandmarkLabelChecks,
} from "../../src/checks/semantic/landmark-labels.js";

// ---------------------------------------------------------------------------
// extractNavElements
// ---------------------------------------------------------------------------

describe("extractNavElements", () => {
  it("extracts <nav> elements", () => {
    const dom = `<html><body>
      <nav class="w-nav" aria-label="Main">Links</nav>
      <nav class="footer-nav">Footer links</nav>
    </body></html>`;
    const navs = extractNavElements(dom);
    expect(navs.length).toBe(2);
    expect(navs[0].ariaLabel).toBe("Main");
    expect(navs[1].ariaLabel).toBeNull();
  });

  it("extracts role=navigation elements that are not <nav>", () => {
    const dom = `<html><body>
      <div role="navigation" aria-label="Sidebar">Links</div>
    </body></html>`;
    const navs = extractNavElements(dom);
    expect(navs.length).toBe(1);
    expect(navs[0].tagName).toBe("div");
    expect(navs[0].role).toBe("navigation");
    expect(navs[0].ariaLabel).toBe("Sidebar");
  });

  it("extracts aria-labelledby", () => {
    const dom = `<nav aria-labelledby="nav-heading">Links</nav>`;
    const navs = extractNavElements(dom);
    expect(navs[0].ariaLabelledby).toBe("nav-heading");
  });

  it("returns empty array for no navs", () => {
    const dom = `<html><body><div>No nav here</div></body></html>`;
    expect(extractNavElements(dom).length).toBe(0);
  });

  it("truncates long HTML", () => {
    const longContent = "a".repeat(300);
    const dom = `<nav>${longContent}</nav>`;
    const navs = extractNavElements(dom);
    expect(navs[0].html.length).toBeLessThanOrEqual(203); // 200 + "..."
  });
});

// ---------------------------------------------------------------------------
// runLandmarkLabelChecks
// ---------------------------------------------------------------------------

describe("runLandmarkLabelChecks", () => {
  it("returns empty for no nav elements", () => {
    const dom = `<html><body><div>content</div></body></html>`;
    expect(runLandmarkLabelChecks(dom)).toEqual([]);
  });

  it("returns empty for single nav with label", () => {
    const dom = `<nav aria-label="Main navigation">Links</nav>`;
    expect(runLandmarkLabelChecks(dom)).toEqual([]);
  });

  it("returns empty for multiple navs all with unique labels", () => {
    const dom = `
      <nav aria-label="Main navigation">Main</nav>
      <nav aria-label="Footer navigation">Footer</nav>
    `;
    expect(runLandmarkLabelChecks(dom)).toEqual([]);
  });

  it("flags single unlabeled nav", () => {
    const dom = `<nav class="w-nav">Main links</nav>`;
    const results = runLandmarkLabelChecks(dom);
    expect(results.length).toBe(1);
    expect(results[0].wcag_criterion).toBe("1.3.1");
    expect(results[0].measured_values?.failure_type).toBe("unlabeled_nav_landmark");
  });

  it("flags multiple navs where some lack labels", () => {
    const dom = `
      <nav aria-label="Main">Main</nav>
      <nav class="mobile-nav">Mobile</nav>
      <nav class="footer-nav">Footer</nav>
    `;
    const results = runLandmarkLabelChecks(dom);
    expect(results.length).toBe(2); // two unlabeled
    expect(results.every(r => r.measured_values?.failure_type === "duplicate_nav_landmark")).toBe(true);
    expect(results[0].raw_result.total_navs).toBe(3);
  });

  it("flags navs with duplicate labels", () => {
    const dom = `
      <nav aria-label="Navigation">Nav 1</nav>
      <nav aria-label="Navigation">Nav 2</nav>
    `;
    const results = runLandmarkLabelChecks(dom);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.measured_values?.failure_type === "duplicate_nav_landmark")).toBe(true);
  });

  it("detects role=navigation elements without labels", () => {
    const dom = `
      <nav aria-label="Main">Main</nav>
      <div role="navigation">Sidebar</div>
    `;
    const results = runLandmarkLabelChecks(dom);
    expect(results.length).toBe(1);
    expect(results[0].measured_values?.failure_type).toBe("duplicate_nav_landmark");
  });

  it("aria-labelledby counts as a valid label", () => {
    const dom = `
      <h2 id="nav-label">Main Navigation</h2>
      <nav aria-labelledby="nav-label">Main</nav>
      <nav aria-label="Footer">Footer</nav>
    `;
    expect(runLandmarkLabelChecks(dom)).toEqual([]);
  });

  it("includes aria attributes in results", () => {
    const dom = `<nav>Unlabeled</nav>`;
    const results = runLandmarkLabelChecks(dom);
    expect(results[0].aria_attributes).toBeDefined();
    expect(results[0].aria_attributes?.["aria-label"]).toBe("");
  });

  it("uses detected_by playwright", () => {
    const dom = `<nav>Unlabeled</nav>`;
    const results = runLandmarkLabelChecks(dom);
    expect(results[0].detected_by).toBe("playwright");
  });
});
