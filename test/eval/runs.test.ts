import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeRepeatability, variationLog } from "../../src/eval/runs.js";
import { loadEvalConfig } from "../../src/eval/config.js";
import { evalPaths } from "../../src/eval/paths.js";
import { guardSplit, HoldoutSealed } from "../../src/eval/holdout.js";
import { appendDefect } from "../../src/eval/defects.js";
import type { SiteReplay } from "../../src/eval/replay.js";
import type { FindingKey, CoverageRow } from "../../src/eval/normalize.js";

const REPO = join(import.meta.dirname, "..", "..");
const config = loadEvalConfig(evalPaths(REPO).config);

function key(page: string, check: string, locator: string, severity = "major"): FindingKey {
  return { page, criterion: "1.1.1", locator, html_sha256: "h", failure_type: "f", check, severity, confidence: "high", detected_by: "axe_core", also_found_on: [] };
}

function replay(keys: FindingKey[], coverage: CoverageRow[], extra: Partial<SiteReplay["totals"]> = {}): SiteReplay {
  return {
    site: "t01", engine: "head", tag: "head", page_ids: ["p001", "p002"],
    totals: { pages: 2, har_misses: 0, node_fetch_misses: 0, declared_exclusion_hits: 0, fuzzy_matches: 0, contained_submissions: 0, websockets_refused: 0, attempted_egress: 0, image_misses: 0, submission_images_substituted: 0, submission_images_absent: 0, submission_image_misses: 0, cache_misses: 0, tooling_errors: 0, ...extra },
    normalized: { findings: [], keys, criteria: [{ criterion: "1.1.1", status: "failed", tested_by: "axe_core", evidence_summary: "" }], coverage },
  } as unknown as SiteReplay;
}

const cov = (status = "ran"): CoverageRow[] => [
  { check: "axe-core", page: "p001", status, message: null },
  { check: "axe-core", page: "p002", status: "ran", message: null },
  { check: "keyboard", page: "p001", status: "ran", message: null },
  { check: "keyboard", page: "p002", status: "ran", message: null },
];

describe("repeatability (D3)", () => {
  it("identical repeats: no flake, non-behavioral identical", () => {
    const k = [key("p001", "axe-core", "img.a"), key("p002", "keyboard", "a.b")];
    const r = analyzeRepeatability(config, [[replay(k, cov())], [replay(k, cov())], [replay(k, cov())]], []);
    expect(r.non_behavioral_identical).toBe(true);
    expect(r.checks.every((c) => c.varying_pairs === 0)).toBe(true);
    expect(r.checks.find((c) => c.check === "keyboard")?.tested_pairs).toBe(2);
  });

  it("a behavioral difference is a flake rate; a non-behavioral one breaks identity", () => {
    const base = [key("p001", "axe-core", "img.a"), key("p002", "keyboard", "a.b")];
    const flaky = [key("p001", "axe-core", "img.a"), key("p002", "keyboard", "a.c")];
    const r1 = analyzeRepeatability(config, [[replay(base, cov())], [replay(flaky, cov())]], []);
    expect(r1.non_behavioral_identical).toBe(true);
    const kb = r1.checks.find((c) => c.check === "keyboard")!;
    expect(kb.varying_pairs).toBe(1);
    expect(kb.flake_rate).toBe(0.5);
    const nb = [key("p001", "axe-core", "img.a", "minor"), key("p002", "keyboard", "a.b")];
    const r2 = analyzeRepeatability(config, [[replay(base, cov())], [replay(nb, cov())]], []);
    expect(r2.non_behavioral_identical).toBe(false);
    expect(r2.differing_pairs).toEqual([{ site: "t01", page: "p001", check: "axe-core", behavioral: false }]);
  });

  it("variation goes to a per-run log line per varying check, never to the committed defect file", () => {
    const base = [key("p001", "axe-core", "img.a"), key("p002", "keyboard", "a.b")];
    const varied = [key("p001", "axe-core", "img.a", "minor"), key("p002", "keyboard", "a.c")];
    const r = analyzeRepeatability(config, [[replay(base, cov())], [replay(varied, cov())]], []);
    const lines = variationLog(r, "replay-x", "tuning-v3/tuning").map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.check, l.behavioral, l.pages]).sort()).toEqual([["axe-core", false, ["t01/p001"]], ["keyboard", true, ["t01/p002"]]]);
    expect(lines.every((l) => l.run_id === "replay-x" && l.corpus === "tuning-v3/tuning" && !("id" in l))).toBe(true);
  });

  it("a coverage change counts as variation and a cache miss invalidates that repeat", () => {
    const k = [key("p001", "axe-core", "img.a")];
    const r = analyzeRepeatability(config, [[replay(k, cov())], [replay(k, cov("failed"), { cache_misses: 2 })]], []);
    expect(r.coverage_identical).toBe(false);
    expect(r.non_behavioral_identical).toBe(false);
    expect(r.invalid_repeats).toEqual([{ repeat: 2, reasons: ["t01: 2 cache miss(es)"] }]);
  });
});

describe("holdout seal and defect log", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "eval-runs-"));
    mkdirSync(join(tmp, "eval"), { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("refuses holdout without a reason and logs an unsealed access", () => {
    const paths = { ...evalPaths(REPO, join(tmp, "data")), holdoutAccessLog: join(tmp, "eval", "holdout-access.log") };
    expect(() => guardSplit(paths, "holdout", undefined, "replay")).toThrow(HoldoutSealed);
    expect(() => guardSplit(paths, "dev", undefined, "replay")).not.toThrow();
    guardSplit(paths, "holdout", "final accuracy report for Phase 3", "replay --split holdout");
    const line = readFileSync(paths.holdoutAccessLog, "utf8").trim().split("\t");
    expect(line).toHaveLength(4);
    expect(line[3]).toBe("final accuracy report for Phase 3");
  });

  it("appends numbered defects and refuses private content", () => {
    copyFileSync(join(REPO, "eval", "seed-labels.jsonl"), join(tmp, "eval", "seed-labels.jsonl"));
    writeFileSync(join(tmp, "eval", "phase2-defects.jsonl"), JSON.stringify({ id: "P2-007", status: "open" }) + "\n");
    const paths = evalPaths(tmp, join(tmp, "data"));
    const d = appendDefect(paths, { found_in: "replay-x", component: "check:keyboard", summary: "flaky", affects: [], evidence: "run replay-x" });
    expect(d.id).toBe("P2-008");
    expect(() => appendDefect(paths, { found_in: "r", component: "c", summary: "see https://example.gov/x", affects: [], evidence: "" })).toThrow(/Refusing/);
    expect(readFileSync(paths.phase2Defects, "utf8").trim().split("\n")).toHaveLength(2);
  });
});
