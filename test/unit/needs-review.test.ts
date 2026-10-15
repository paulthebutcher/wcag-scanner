import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chromium, type Browser } from "playwright";
import http from "node:http";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { NodeResult, Result as AxeResult } from "axe-core";
import { nodeToCheckResult } from "../../src/checks/automated/index.js";
import { scoreConfidence, isNeedsReview } from "../../src/core/confidence.js";
import { analyze } from "../../src/core/analyzer.js";
import { classifyTriage } from "../../src/report/findings-dump.js";
import { computeSummary, criterionStatusFromFindings, reconcileInMemory, scan } from "../../src/core/scanner.js";
import { partitionExclusions } from "../../src/report/clustering.js";
import { groupManualContrastChecks, contrastReasonLabel, renderExcludedHtml } from "../../src/report/top-fixes-report.js";
import type { CriterionResult, Finding } from "../../src/types.js";
import { makeTestFinding } from "./finding-factory.js";

const rule = { id: "color-contrast", impact: "serious", tags: ["wcag2aa", "wcag143"], help: "h", helpUrl: "u", description: "d", nodes: [] } as unknown as AxeResult;
const node = (summary: string) => ({ html: '<p class="c-green-h">Text</p>', target: [".c-green-h"], failureSummary: summary, impact: "serious", any: [], all: [], none: [] }) as unknown as NodeResult;
const UNDETERMINED = "Fix any of the following:\n  Element's background color could not be determined because element contains an image node";
const ONE_TO_ONE = "Fix any of the following:\n  Element has a 1:1 contrast ratio with the background";

/** A finding with the confidence the pipeline would give it. */
function scored(f: Finding): Finding {
  return { ...f, confidence: scoreConfidence(f) };
}
const confirmed = (criterion: string, failureType = "image-alt") => scored(makeTestFinding({ criterion, failureType, detectedBy: "axe_core" }));
const incomplete = (criterion: string, reasoning = UNDETERMINED, severity: Finding["severity"] = "major") =>
  scored(makeTestFinding({ criterion, failureType: "color-contrast", detectedBy: "axe_core", reasoning, severity, measured: { axe_incomplete: true } }));
const cr = (criterion: string, status: CriterionResult["status"]): CriterionResult => ({
  scan_session_id: "s", wcag_criterion: criterion, status, tested_by: "axe_core", evidence_summary: "stored", finding_ids: [],
});

describe("axe incomplete results are marked and routed to needs_review (P2-030)", () => {
  it("marks an incomplete node and leaves a violation node unchanged", () => {
    const inc = nodeToCheckResult(node(UNDETERMINED), rule, "axe_core", { incomplete: true });
    expect(inc.measured_values).toEqual({ axe_incomplete: true });
    const vio = nodeToCheckResult(node("Fix any of the following:\n  Element has insufficient color contrast of 2.1"), rule, "axe_core");
    expect(vio.measured_values).toBeUndefined();
    expect(Object.keys(vio).sort()).toEqual(Object.keys(nodeToCheckResult(node("x"), rule)).sort());
  });

  it("an incomplete finding is needs_review, requires a human and lands in verify_manually; severity keeps axe's impact", () => {
    const f = incomplete("1.4.3");
    expect(f.confidence.tier).toBe("needs_review");
    expect(f.confidence.score).toBe(0.5);
    expect(f.confidence.requires_human).toBe(true);
    expect(classifyTriage(f)).toBe("verify_manually");
    expect(f.severity).toBe("major");
    expect(isNeedsReview(f)).toBe(true);
    // A confirmed axe violation is unchanged
    const v = confirmed("1.1.1");
    expect(v.confidence.tier).toBe("definitive");
    expect(classifyTriage(v)).toBe("fix_now");
  });

  it("the 1:1 incomplete case stays needs_review (axe did not confirm it)", () => {
    expect(incomplete("1.4.3", ONE_TO_ONE).confidence.tier).toBe("needs_review");
  });

  it("the reasoning says axe could not decide and keeps axe's own message", () => {
    const check = nodeToCheckResult(node(UNDETERMINED), rule, "axe_core", { incomplete: true });
    const analysis = analyze(check);
    expect(analysis.reasoning).toMatch(/^axe-core could not decide this check \(incomplete result/);
    expect(analysis.reasoning).toContain("background color could not be determined because element contains an image node");
  });
});

describe("criterion status with needs-review findings (P2-030, P2-019)", () => {
  it("failed with one confirmed and one needs-review finding", () => {
    expect(criterionStatusFromFindings([confirmed("1.4.3", "color-contrast"), incomplete("1.4.3")]).status).toBe("failed");
  });

  it("needs_review with needs-review findings only", () => {
    expect(criterionStatusFromFindings([incomplete("1.4.3"), incomplete("1.4.3", ONE_TO_ONE)])).toEqual({
      status: "needs_review", summary: "2 finding(s) need a manual check; none confirmed",
    });
  });

  it("a truncated tab sweep (needs_review) leaves 2.1.1 needs_review, not failed", () => {
    const sweep = scored(makeTestFinding({ criterion: "2.1.1", failureType: "truncated_tab_sweep", detectedBy: "playwright", selector: "html", html: "<html>" }));
    expect(sweep.confidence.tier).toBe("needs_review");
    const [r] = reconcileInMemory("s", [sweep], [cr("2.1.1", "failed")]);
    expect(r.status).toBe("needs_review");
  });

  it("no pass when needs-review findings exist; an existing pass without findings is unchanged", () => {
    const out = reconcileInMemory("s", [incomplete("1.4.3")], [cr("1.4.3", "passed"), cr("2.4.1", "passed"), cr("3.1.1", "not_applicable")]);
    expect(out.map((r) => [r.wcag_criterion, r.status])).toEqual([["1.4.3", "needs_review"], ["2.4.1", "passed"], ["3.1.1", "not_applicable"]]);
  });

  it("a stored needs_review criterion is never turned into a pass when its findings are filtered from the client view", () => {
    const [r] = reconcileInMemory("s", [], [cr("4.1.2", "needs_review")]);
    expect(r.status).toBe("needs_review");
    // the existing rule for a failed criterion whose findings were all filtered is unchanged
    expect(reconcileInMemory("s", [], [cr("4.1.2", "failed")])[0].status).toBe("passed");
  });
});

describe("summary counts confirmed and needs-review findings separately", () => {
  it("severity counts include confirmed findings only; criteria split by status", () => {
    const findings = [confirmed("1.1.1"), incomplete("1.4.3"), incomplete("1.4.3"), incomplete("1.2.2", UNDETERMINED, "critical")];
    const s = computeSummary("s", findings, [cr("2.4.1", "passed"), cr("1.4.3", "passed")]);
    expect(s.total_findings).toBe(4);
    expect(s.by_severity).toEqual({ critical: 0, major: 1, minor: 0, advisory: 0 });
    expect(s.needs_review_findings).toBe(3);
    expect(s.needs_review_by_severity).toEqual({ critical: 1, major: 2, minor: 0, advisory: 0 });
    expect(s.by_confidence.needs_review).toBe(3);
    expect(s.wcag_criteria_failed).toEqual(["1.1.1"]);
    expect(s.wcag_criteria_needs_review).toEqual(["1.2.2", "1.4.3"]);
    expect(s.wcag_criteria_passed).toEqual(["2.4.1"]);
  });
});

describe("needs manual contrast check grouping", () => {
  it("groups per page and reason with the element list behind each entry", () => {
    const reasons: Array<[string, string, string]> = [
      ["/", "element contains an image node", ".a"],
      ["/", "element contains an image node", ".b"],
      ["/", "a background gradient", ".c"],
      ["/for-agencies", "element contains an image node", ".d"],
      ["/for-agencies", "it is overlapped by another element", ".e"],
      ["/for-agencies", "it partially overlaps other elements", ".f"],
      ["/local", "a background image", ".g"],
    ];
    const paged = reasons.map(([page, why, sel]) => ({
      finding: incomplete("1.4.3", `Fix any of the following:\n  Element's background color could not be determined because ${why}`),
      pageUrl: `https://x.test${page}`,
    })).map((p, i) => ({ ...p, finding: { ...p.finding, evidence: { ...p.finding.evidence, element_selector: reasons[i][2] } } }));
    paged.push({ finding: incomplete("1.4.3", ONE_TO_ONE), pageUrl: "https://x.test/local" }); // not an undetermined background: stays out
    const { excluded, kept } = partitionExclusions(paged);
    expect(kept).toHaveLength(1);
    const groups = groupManualContrastChecks(excluded);
    expect(groups.map((g) => [new URL(g.page_url).pathname, g.reason, g.elements.map((e) => e.selector)])).toEqual([
      ["/", "image node", [".a", ".b"]],
      ["/", "gradient", [".c"]],
      ["/for-agencies", "image node", [".d"]],
      ["/for-agencies", "overlap", [".e"]],
      ["/for-agencies", "partial overlap", [".f"]],
      ["/local", "background image", [".g"]],
    ]);
    expect(groups.reduce((n, g) => n + g.elements.length, 0)).toBe(7);
    const html = renderExcludedHtml(excluded);
    expect(html).toContain("Needs Manual Contrast Check (7 elements)");
    expect(html).toContain("<summary>2 elements</summary>");
    expect(contrastReasonLabel("background colour could not be determined: something else")).toBe("something else");
  });
});

describe("scan: text over an image is a needs-review finding and 1.4.3 needs review", () => {
  let browser: Browser;
  let server: http.Server;
  let baseUrl = "";
  let tmpDir = "";
  const PAGE = `<!DOCTYPE html><html lang="en"><head><title>Hero</title></head><body><main>
    <h1>Hero</h1>
    <div style="background-image:url(data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=);background-color:#111"><p style="color:#222">Text over a background image</p></div>
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
  </main></body></html>`;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `wcag-nr-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    browser = await chromium.launch();
    server = http.createServer((_req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(PAGE); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      if (a && typeof a === "object") baseUrl = `http://127.0.0.1:${a.port}`;
      resolve();
    }));
  });
  afterEach(async () => {
    await browser.close();
    server.close();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("routes the incomplete contrast result to needs_review and does not fail 1.4.3", async () => {
    const r = await scan({ url: baseUrl, dataDir: tmpDir, maxPages: 1, tiers: [1] }, browser);
    const contrast = r.findings.filter((f) => f.evidence.measured_values?.failure_type === "color-contrast");
    expect(contrast.length).toBeGreaterThan(0);
    expect(contrast.every((f) => f.evidence.measured_values?.axe_incomplete === true && f.confidence.tier === "needs_review")).toBe(true);
    expect(r.criterionResults.find((c) => c.wcag_criterion === "1.4.3")?.status).toBe("needs_review");
    // A confirmed axe violation on the same page still fails its criterion
    expect(r.criterionResults.find((c) => c.wcag_criterion === "1.1.1")?.status).toBe("failed");
    expect(r.summary.needs_review_findings).toBe(contrast.length);
    expect(r.summary.wcag_criteria_needs_review).toContain("1.4.3");
    expect(r.summary.wcag_criteria_failed).not.toContain("1.4.3");
  }, 60_000);
});
