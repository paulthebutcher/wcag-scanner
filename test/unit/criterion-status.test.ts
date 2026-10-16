import { describe, it, expect } from "vitest";
import { withholdPassesOnFailedChecks, completeCriterionRows, settleCriterionResults, notTestedRows, NO_CHECK_REASON } from "../../src/core/criterion-status.js";
import { aggregateAxeCriteria, type AxeRuleOutcome } from "../../src/checks/automated/index.js";
import { reconcileInMemory } from "../../src/core/scanner.js";
import { WCAG_AA_CRITERIA, WCAG_AA_CRITERION_IDS } from "../../src/core/wcag-criteria.js";
import { CHECK_CRITERIA, checksForCriterion } from "../../src/core/check-registry.js";
import type { CoverageEntry } from "../../src/core/coverage.js";
import type { CriterionResult } from "../../src/types.js";
import { chromium } from "playwright";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { scan } from "../../src/core/scanner.js";
import { renderHtmlReport } from "../../src/report/templates/html-template.js";
import { queryFindings } from "../../src/report/generator.js";
import { openDatabase } from "../../src/store/db.js";

const cr = (criterion: string, status: CriterionResult["status"], extra: Partial<CriterionResult> = {}): CriterionResult =>
  ({ scan_session_id: "s", wcag_criterion: criterion, status, tested_by: "claude_api", evidence_summary: `${status} by a check`, finding_ids: [], ...extra });
const cov = (check: string, page: string, status: CoverageEntry["status"], message?: string): CoverageEntry => ({ check, tier: 3, page_url: page, status, message });

describe("criterion status integrity (P2-010, P2-004, P2-032, P2-033, stored gap)", () => {
  it("a check that threw withholds the pass of every criterion it addresses, with the reason (P2-010)", () => {
    const results = [cr("1.1.1", "passed"), cr("2.4.4", "passed"), cr("1.3.5", "not_applicable"), cr("2.4.7", "passed"), cr("1.4.3", "failed", { finding_ids: ["f1"] })];
    const coverage = [cov("alt-text", "https://x.test/", "failed", "synthetic check failure\n  at stack"), cov("alt-text", "https://x.test/b", "ran"), cov("input-purpose", "https://x.test/", "failed", "boom"), cov("focus-visible", "https://x.test/", "ran")];
    const out = withholdPassesOnFailedChecks(results, coverage);
    const by = Object.fromEntries(out.map((r) => [r.wcag_criterion, r]));
    expect(by["1.1.1"].status).toBe("not_tested");
    expect(by["1.1.1"].evidence_summary).toBe("Not established: alt-text failed on 1 page(s): synthetic check failure (was: passed by a check)");
    expect(by["1.3.5"].status).toBe("not_tested");
    expect(by["2.4.4"].status).toBe("passed"); // link-text and duplicate-links ran
    expect(by["2.4.7"].status).toBe("passed");
    expect(by["1.4.3"].status).toBe("failed"); // findings stand
    expect(withholdPassesOnFailedChecks(results, [cov("alt-text", "https://x.test/", "skipped", "no key")])).toEqual(results);
  });

  it("every one of the 50 A/AA criteria gets a stored row; 1.3.6 is out of scope; uncovered criteria are not_tested / no_check (P2-032, stored gap)", () => {
    const out = completeCriterionRows("s", [cr("1.1.1", "passed"), cr("1.3.6", "not_tested"), cr("4.1.2", "failed")]);
    expect(out.map((r) => r.wcag_criterion)).toEqual([...WCAG_AA_CRITERION_IDS]);
    expect(out).toHaveLength(50);
    expect(WCAG_AA_CRITERIA.find((c) => c.id === "1.3.6")).toBeUndefined();
    const gap = out.find((r) => r.wcag_criterion === "4.1.3")!;
    expect(gap).toMatchObject({ status: "not_tested", tested_by: "manual" });
    expect(gap.evidence_summary).toBe(`${NO_CHECK_REASON}: Status Messages is not covered by any automated check; needs a manual check`);
    for (const id of ["2.5.3", "4.1.1", "4.1.3", "1.2.1", "1.2.3", "1.2.4", "1.2.5"]) {
      expect(out.find((r) => r.wcag_criterion === id)?.evidence_summary).toMatch(/^no_check:/);
      expect(checksForCriterion(id)).toEqual([]);
    }
    expect(notTestedRows(out).map((r) => r.criterion)).toContain("4.1.3");
    expect(notTestedRows(out)[0].reason).toMatch(/no_check|not covered/);
  });

  it("settleCriterionResults applies both rules in order", () => {
    const out = settleCriterionResults({ scanId: "s", results: [cr("1.1.1", "passed")], coverage: [cov("alt-text", "u", "failed", "x")] });
    expect(out).toHaveLength(50);
    expect(out.find((r) => r.wcag_criterion === "1.1.1")?.status).toBe("not_tested");
  });

  it("the client view never turns a failed criterion into a pass by filtering its findings (P2-033)", () => {
    const [r] = reconcileInMemory("s", [], [cr("4.1.2", "failed", { finding_ids: ["a", "b"] })]);
    expect(r.status).toBe("needs_review");
    expect(r.evidence_summary).toBe("2 finding(s) filtered from this view as possibly noisy; needs a manual check");
    expect(r.finding_ids).toEqual([]);
    expect(reconcileInMemory("s", [], [cr("2.4.1", "passed")])[0].status).toBe("passed");
  });

  it("the check→criteria map covers every check in the registry's tiers and names only A/AA criteria", () => {
    for (const [check, criteria] of Object.entries(CHECK_CRITERIA)) {
      for (const c of criteria) expect(WCAG_AA_CRITERION_IDS, `${check} → ${c}`).toContain(c);
    }
    expect(checksForCriterion("1.1.1").sort()).toEqual(["alt-text", "axe-core"]);
    expect(checksForCriterion("3.3.1").sort()).toEqual(["error-messages", "error-quality", "form-submission"]);
  });
});

describe("axe criterion aggregation across pages (P2-004)", () => {
  const o = (rule: string, criteria: string[], outcome: AxeRuleOutcome["outcome"], nodes = 1): AxeRuleOutcome => ({ rule, criteria, outcome, nodes });

  it("passes only when every mapped rule passed or was inapplicable on every page, and at least one passed", () => {
    const out = aggregateAxeCriteria([
      { url: "https://x.test/", outcomes: [o("image-alt", ["1.1.1"], "passed"), o("page-has-heading-one", ["2.4.1"], "inapplicable", 0), o("html-has-lang", ["3.1.1"], "passed")] },
      { url: "https://x.test/b", outcomes: [o("image-alt", ["1.1.1"], "inapplicable", 0), o("page-has-heading-one", ["2.4.1"], "inapplicable", 0), o("html-has-lang", ["3.1.1"], "violation")] },
    ], "s");
    const by = Object.fromEntries(out.map((r) => [r.wcag_criterion, r]));
    expect(by["1.1.1"]).toMatchObject({ status: "passed", tested_by: "axe_core" });
    expect(by["1.1.1"].evidence_summary).toBe("Passed 1 axe-core rule(s) on 1 of 2 page(s), inapplicable elsewhere: image-alt");
    expect(by["2.4.1"].status).toBe("not_applicable");
    expect(by["3.1.1"]).toBeUndefined(); // a violation on page b: the findings decide, whatever the page order
  });

  it("page order does not matter and a rule's every WCAG tag counts; an incomplete result blocks a pass", () => {
    const pages = [
      { url: "a", outcomes: [o("label", ["1.3.1", "4.1.2"], "passed")] },
      { url: "b", outcomes: [o("label", ["1.3.1", "4.1.2"], "inapplicable", 0), o("color-contrast", ["1.4.3"], "incomplete")] },
    ];
    const forward = aggregateAxeCriteria(pages, "s"); const backward = aggregateAxeCriteria([...pages].reverse(), "s");
    expect(forward.map((r) => [r.wcag_criterion, r.status])).toEqual([["1.3.1", "passed"], ["4.1.2", "passed"]]);
    expect(backward.map((r) => [r.wcag_criterion, r.status])).toEqual(forward.map((r) => [r.wcag_criterion, r.status]));
    expect(forward.find((r) => r.wcag_criterion === "1.4.3")).toBeUndefined();
  });
});

describe("a scan stores exactly the 50 A/AA criteria and the report counts them", () => {
  it("stores 50 rows, none for 1.3.6, uncovered criteria as not_tested / no_check, and the scorecard lists them with reasons", async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Rows</title></head><body><main><h1>Rows</h1><p>Plain page with <a href="/x">one link</a>.</p></main></body></html>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const browser = await chromium.launch({ headless: true });
    const dataDir = mkdtempSync(join(tmpdir(), "wcag-rows-"));
    try {
      const r = await scan({ url: `${origin}/`, dataDir, maxPages: 1, tiers: [1, 2, 5] }, browser);
      expect(r.criterionResults.map((c) => c.wcag_criterion).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))).toEqual([...WCAG_AA_CRITERION_IDS].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
      const by = Object.fromEntries(r.criterionResults.map((c) => [c.wcag_criterion, c]));
      expect(by["4.1.3"]).toMatchObject({ status: "not_tested", tested_by: "manual" });
      expect(by["4.1.3"].evidence_summary).toMatch(/^no_check:/);
      expect(by["2.5.3"].status).toBe("not_tested");
      expect(by["1.1.1"].status).not.toBe("failed");
      // Stored rows match
      const db = openDatabase(join(dataDir, "wcag.db"));
      try {
        const stored = db.prepare("select wcag_criterion from criterion_results where scan_session_id = ?").all(r.scanSession.id) as Array<{ wcag_criterion: string }>;
        expect(stored).toHaveLength(50);
        expect(stored.some((x) => x.wcag_criterion === "1.3.6")).toBe(false);
        const data = queryFindings(db, r.scanSession.id, { dataDir });
        const html = renderHtmlReport(data);
        const m = html.match(/<strong>(\d+)<\/strong> no issues detected[\s\S]*?<strong>(\d+)<\/strong> failed[\s\S]*?<strong>(\d+)<\/strong> need review[\s\S]*?<strong>(\d+)<\/strong> not applicable[\s\S]*?<strong>(\d+)<\/strong> not tested/);
        expect(m).not.toBeNull();
        expect(m!.slice(1).map(Number).reduce((a, b) => a + b, 0)).toBe(50);
        expect(html).toMatch(/Not tested \(\d+\)/);
        expect(html).toContain("no_check: Status Messages is not covered by any automated check");
      } finally {
        db.close();
      }
    } finally {
      await browser.close();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 90_000);
});
