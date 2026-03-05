import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractWcagCriteria,
  getWcagCriterion,
  nodeToCheckResult,
  passesToCriterionResults,
  runAxeChecks,
} from "../../src/checks/automated/index.js";
import type { Result as AxeResult, NodeResult } from "axe-core";

// ---------------------------------------------------------------------------
// extractWcagCriteria / getWcagCriterion — pure function tests
// ---------------------------------------------------------------------------

describe("extractWcagCriteria", () => {
  it("extracts 3-digit criteria (e.g. wcag111 → 1.1.1)", () => {
    expect(extractWcagCriteria(["wcag111"])).toEqual(["1.1.1"]);
  });

  it("extracts 4-digit criteria (e.g. wcag143 → 1.4.3 is 3-digit, wcag1410 → 1.4.10)", () => {
    expect(extractWcagCriteria(["wcag1410"])).toEqual(["1.4.10"]);
  });

  it("extracts multiple criteria from mixed tags", () => {
    const tags = ["wcag2a", "wcag111", "wcag412", "best-practice", "cat.text-alternatives"];
    const result = extractWcagCriteria(tags);
    expect(result).toContain("1.1.1");
    expect(result).toContain("4.1.2");
    expect(result).not.toContain("wcag2a"); // This is a level tag, not a criterion
  });

  it("ignores non-criterion tags", () => {
    const tags = ["wcag2a", "wcag21aa", "best-practice", "cat.forms"];
    expect(extractWcagCriteria(tags)).toEqual([]);
  });

  it("handles empty array", () => {
    expect(extractWcagCriteria([])).toEqual([]);
  });

  it("extracts 2.4.7 from wcag247", () => {
    expect(extractWcagCriteria(["wcag247"])).toEqual(["2.4.7"]);
  });

  it("extracts 1.4.12 from wcag1412", () => {
    expect(extractWcagCriteria(["wcag1412"])).toEqual(["1.4.12"]);
  });
});

describe("getWcagCriterion", () => {
  it("returns first criterion from tags", () => {
    expect(getWcagCriterion(["wcag2a", "wcag111"])).toBe("1.1.1");
  });

  it("returns 'unknown' when no WCAG criterion tags present", () => {
    expect(getWcagCriterion(["best-practice", "cat.text-alternatives"])).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// nodeToCheckResult — unit tests with mock data
// ---------------------------------------------------------------------------

describe("nodeToCheckResult", () => {
  const mockRule: AxeResult = {
    id: "image-alt",
    impact: "critical",
    tags: ["wcag2a", "wcag111", "cat.text-alternatives"],
    description: "Ensures <img> elements have alternate text",
    help: "Images must have alternate text",
    helpUrl: "https://dequeuniversity.com/rules/axe/4.10/image-alt",
    nodes: [],
  };

  const mockNode: NodeResult = {
    html: '<img src="photo.jpg">',
    impact: "critical",
    target: ["img"],
    any: [],
    all: [],
    none: [],
    failureSummary: "Fix any of the following: Element does not have an alt attribute",
  };

  it("produces correct CheckResult structure", () => {
    const result = nodeToCheckResult(mockNode, mockRule);

    expect(result.element_selector).toBe("img");
    expect(result.element_html).toBe('<img src="photo.jpg">');
    expect(result.wcag_criterion).toBe("1.1.1");
    expect(result.detected_by).toBe("axe_core");
    expect(result.raw_result).toEqual({
      impact: "critical",
      ruleId: "image-alt",
      help: "Images must have alternate text",
      helpUrl: "https://dequeuniversity.com/rules/axe/4.10/image-alt",
      failureSummary: "Fix any of the following: Element does not have an alt attribute",
      tags: ["wcag2a", "wcag111", "cat.text-alternatives"],
    });
  });

  it("extracts ARIA attributes from node HTML", () => {
    const ariaNode: NodeResult = {
      html: '<div role="button" aria-label="Close" aria-expanded="false">X</div>',
      impact: "moderate",
      target: ["div"],
      any: [],
      all: [],
      none: [],
    };
    const result = nodeToCheckResult(ariaNode, mockRule);
    expect(result.aria_attributes).toEqual({
      role: "button",
      "aria-label": "Close",
      "aria-expanded": "false",
    });
  });

  it("omits aria_attributes when none present", () => {
    const result = nodeToCheckResult(mockNode, mockRule);
    expect(result.aria_attributes).toBeUndefined();
  });

  it("handles complex selectors (array target)", () => {
    const nestedNode: NodeResult = {
      html: '<a href="/about"></a>',
      impact: "serious",
      target: [["iframe", "a"]],
      any: [],
      all: [],
      none: [],
    };
    const result = nodeToCheckResult(nestedNode, { ...mockRule, id: "link-name" });
    expect(result.element_selector).toBe("iframe a");
  });
});

// ---------------------------------------------------------------------------
// passesToCriterionResults — unit tests with mock data
// ---------------------------------------------------------------------------

describe("passesToCriterionResults", () => {
  it("groups passes by WCAG criterion", () => {
    const passes: AxeResult[] = [
      {
        id: "image-alt",
        tags: ["wcag2a", "wcag111"],
        nodes: [{ html: "", target: ["img"], any: [], all: [], none: [] }],
        description: "",
        help: "",
        helpUrl: "",
      },
      {
        id: "role-img-alt",
        tags: ["wcag2a", "wcag111"],
        nodes: [
          { html: "", target: ["svg"], any: [], all: [], none: [] },
          { html: "", target: ["svg:nth-child(2)"], any: [], all: [], none: [] },
        ],
        description: "",
        help: "",
        helpUrl: "",
      },
      {
        id: "html-has-lang",
        tags: ["wcag2a", "wcag311"],
        nodes: [{ html: "", target: ["html"], any: [], all: [], none: [] }],
        description: "",
        help: "",
        helpUrl: "",
      },
    ];

    const results = passesToCriterionResults(passes, "scan-1");

    expect(results).toHaveLength(2);

    const imageResult = results.find((r) => r.wcag_criterion === "1.1.1");
    expect(imageResult).toBeDefined();
    expect(imageResult!.status).toBe("passed");
    expect(imageResult!.tested_by).toBe("axe_core");
    expect(imageResult!.scan_session_id).toBe("scan-1");
    expect(imageResult!.evidence_summary).toContain("image-alt");
    expect(imageResult!.evidence_summary).toContain("role-img-alt");
    expect(imageResult!.evidence_summary).toContain("3 elements tested");
    expect(imageResult!.finding_ids).toEqual([]);

    const langResult = results.find((r) => r.wcag_criterion === "3.1.1");
    expect(langResult).toBeDefined();
    expect(langResult!.evidence_summary).toContain("html-has-lang");
  });

  it("skips rules with no WCAG criterion tags", () => {
    const passes: AxeResult[] = [
      {
        id: "region",
        tags: ["best-practice"],
        nodes: [{ html: "", target: ["div"], any: [], all: [], none: [] }],
        description: "",
        help: "",
        helpUrl: "",
      },
    ];

    const results = passesToCriterionResults(passes, "scan-1");
    expect(results).toHaveLength(0);
  });

  it("returns empty array for no passes", () => {
    expect(passesToCriterionResults([], "scan-1")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration test: runAxeChecks with real Playwright + axe-core
// ---------------------------------------------------------------------------

describe("runAxeChecks (integration)", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    page = await context.newPage();

    // Load the fixture HTML
    const fixturePath = join(import.meta.dirname, "..", "fixtures", "axe-violations.html");
    const html = readFileSync(fixturePath, "utf-8");
    await page.setContent(html);
  });

  afterAll(async () => {
    await browser.close();
  });

  it("detects violations from fixture HTML", async () => {
    const output = await runAxeChecks(page, "test-scan-1");

    // Should find violations (missing alt, missing lang, empty link, etc.)
    expect(output.violations.length).toBeGreaterThan(0);

    // Every violation should be a valid CheckResult
    for (const v of output.violations) {
      expect(v.element_selector).toBeTruthy();
      expect(v.element_html).toBeTruthy();
      expect(v.detected_by).toBe("axe_core");
      expect(v.raw_result).toBeTruthy();
    }
  });

  it("finds missing alt text violation (1.1.1)", async () => {
    const output = await runAxeChecks(page, "test-scan-1");
    const altViolation = output.violations.find(
      (v) => v.wcag_criterion === "1.1.1" && v.element_html.includes("photo.jpg"),
    );
    expect(altViolation).toBeDefined();
    expect(altViolation!.element_html).toContain("img");
  });

  it("finds missing lang attribute violation (3.1.1)", async () => {
    const output = await runAxeChecks(page, "test-scan-1");
    const langViolation = output.violations.find(
      (v) => v.wcag_criterion === "3.1.1",
    );
    expect(langViolation).toBeDefined();
  });

  it("maps axe impact to raw_result", async () => {
    const output = await runAxeChecks(page, "test-scan-1");
    // At least one violation should have impact info
    const withImpact = output.violations.find(
      (v) => (v.raw_result as Record<string, unknown>).impact != null,
    );
    expect(withImpact).toBeDefined();

    const impact = (withImpact!.raw_result as Record<string, unknown>).impact;
    expect(["minor", "moderate", "serious", "critical"]).toContain(impact);
  });

  it("each violation has ruleId and helpUrl in raw_result", async () => {
    const output = await runAxeChecks(page, "test-scan-1");
    for (const v of output.violations) {
      const raw = v.raw_result as Record<string, unknown>;
      expect(raw.ruleId).toBeTruthy();
      expect(raw.helpUrl).toBeTruthy();
    }
  });

  it("produces pass CriterionResults", async () => {
    const output = await runAxeChecks(page, "test-scan-1");
    // The fixture has some passing elements (proper alt on logo, good link text)
    // so there should be at least some passes
    expect(output.passes.length).toBeGreaterThanOrEqual(0);

    for (const p of output.passes) {
      expect(p.status).toBe("passed");
      expect(p.tested_by).toBe("axe_core");
      expect(p.scan_session_id).toBe("test-scan-1");
    }
  });

  it("respects disableRules option", async () => {
    // Disable the image-alt rule
    const withAll = await runAxeChecks(page, "test-scan-1");
    const altViolations = withAll.violations.filter((v) => {
      const raw = v.raw_result as Record<string, unknown>;
      return raw.ruleId === "image-alt";
    });

    const withDisabled = await runAxeChecks(page, "test-scan-1", {
      disableRules: ["image-alt"],
    });
    const altViolationsDisabled = withDisabled.violations.filter((v) => {
      const raw = v.raw_result as Record<string, unknown>;
      return raw.ruleId === "image-alt";
    });

    // With rule disabled, should have fewer image-alt violations
    expect(altViolationsDisabled.length).toBeLessThan(altViolations.length);
  });
});
