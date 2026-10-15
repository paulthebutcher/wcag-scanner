import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRun, loadManifest, OfficialRunRefused, RUN_MANIFEST_SCHEMA } from "../../src/eval/manifest.js";
import { validate, obj, str, int, arr, oneOf } from "../../src/eval/schema.js";
import { loadEvalConfig, configProblems } from "../../src/eval/config.js";
import { canonicalJson, hashJson, writeOnce, newRunId, dirtyingPath } from "../../src/eval/util.js";
import { evalPaths } from "../../src/eval/paths.js";
import { scanText, assertExportSafe, scanCommittedExports, knownPrivateHosts, isExportPath, scanStagedExports } from "../../src/eval/privacy.js";

const REPO = join(import.meta.dirname, "..", "..");
const CLEAN = { sha: "a".repeat(40), dirty: false, changed_paths: [] };
const DIRTY = { sha: "a".repeat(40), dirty: true, changed_paths: ["src/core/scanner.ts"] };

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "eval-foundation-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("canonical JSON", () => {
  it("is independent of key order and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }))
      .toBe('{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
    expect(hashJson({ x: 1, y: 2 })).toBe(hashJson({ y: 2, x: 1 }));
  });

  it("writeOnce refuses to change an existing file but tolerates identical bytes", () => {
    const p = join(tmp, "a.txt");
    writeOnce(p, "one");
    writeOnce(p, "one");
    expect(() => writeOnce(p, "two")).toThrow(/immutable/);
    expect(readFileSync(p, "utf8")).toBe("one");
  });

  it("only changes that can affect execution make the tree dirty", () => {
    expect(dirtyingPath(" M", "docs/x.md")).toBe(true);
    expect(dirtyingPath("??", "docs/x.md")).toBe(false);
    expect(dirtyingPath("??", "src/eval/new.ts")).toBe(true);
    expect(dirtyingPath("??", "eval/config.json")).toBe(true);
    expect(dirtyingPath("??", "eval/runs/r1/static.json")).toBe(false);
    expect(dirtyingPath(" M", "eval/runs/r1/static.json")).toBe(true);
  });

  it("run ids are sortable and explicit", () => {
    expect(newRunId("replay")).toMatch(/^replay-\d{8}T\d{6}Z-[0-9a-f]{6}$/);
  });
});

describe("schema validator", () => {
  const schema = obj({ id: str({ pattern: /^L-\d{6}$/ }), n: int({ min: 0 }), tags: arr(oneOf(["a", "b"])) });
  it("accepts a valid record", () => {
    expect(validate(schema, { id: "L-000001", n: 0, tags: ["a"] })).toEqual([]);
  });
  it("reports every violation with a path", () => {
    const errors = validate(schema, { id: "x", n: -1, tags: ["c"], extra: true });
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("$.id"),
      expect.stringContaining("$.n"),
      expect.stringContaining("$.tags[0]"),
      expect.stringContaining("$.extra: unexpected field"),
    ]));
  });
});

describe("run manifest (D8)", () => {
  it("writes a schema-valid manifest with environment and harness state", () => {
    const run = startRun({ command: "pilot", argv: ["pilot"], purpose: "diagnostic", root: REPO, runsDir: tmp, repo: CLEAN });
    run.manifest.totals.pages = 3;
    const m = run.finish("completed");
    expect(validate(RUN_MANIFEST_SCHEMA, m)).toEqual([]);
    expect(m.validity.valid).toBe(true);
    expect(m.environment.node).toBe(process.version);
    expect(m.environment.lockfile_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.environment.playwright).toBeTruthy();
    expect(loadManifest(tmp, m.run_id).run_id).toBe(m.run_id);
  });

  it("refuses official purposes on a dirty tree but records dirty diagnostic runs", () => {
    expect(() => startRun({ command: "metrics", argv: [], purpose: "official-accuracy", root: REPO, runsDir: tmp, repo: DIRTY }))
      .toThrow(OfficialRunRefused);
    const run = startRun({ command: "metrics", argv: [], purpose: "diagnostic", root: REPO, runsDir: tmp, repo: DIRTY });
    const m = run.finish("completed");
    expect(m.harness.dirty).toBe(true);
    expect(m.validity.official).toBe(false);
    expect(m.validity.valid).toBe(true);
  });

  it("invalidates runs with misses, egress or incomplete completion", () => {
    const run = startRun({ command: "replay", argv: [], purpose: "diagnostic", root: REPO, runsDir: tmp, repo: CLEAN });
    run.manifest.totals.har_misses = 2;
    run.manifest.totals.attempted_egress = 1;
    run.manifest.totals.cache_misses = 1;
    run.manifest.totals.image_misses = 1;
    const m = run.finish("completed");
    expect(m.validity.valid).toBe(false);
    expect(m.validity.reasons).toEqual(expect.arrayContaining([
      "1 attempted network egress", "2 unexpected HAR miss(es)", "1 image store miss(es)", "1 response cache miss(es)",
    ]));
    const failed = startRun({ command: "replay", argv: [], purpose: "diagnostic", root: REPO, runsDir: tmp, repo: CLEAN }).finish("failed");
    expect(failed.validity.valid).toBe(false);
  });

  it("command detail may hold nulls, and a schema problem still writes an invalid manifest", () => {
    const run = startRun({ command: "replay", argv: [], purpose: "diagnostic", root: REPO, runsDir: tmp, repo: CLEAN });
    run.manifest.extra = { repeatability: null };
    expect(run.finish("completed").validity.valid).toBe(true);
    const bad = startRun({ command: "replay", argv: [], purpose: "diagnostic", root: REPO, runsDir: tmp, repo: CLEAN });
    (bad.manifest.totals as unknown as Record<string, unknown>).pages = -1;
    expect(() => bad.finish("completed")).toThrow(/Invalid run manifest/);
    const written = JSON.parse(readFileSync(bad.path, "utf8"));
    expect(written.completion).toBe("completed");
    expect(written.validity.valid).toBe(false);
  });

  it("consumers never accept 'latest'", () => {
    expect(() => loadManifest(tmp, "latest")).toThrow(/explicit run id/);
  });
});

describe("eval/config.json", () => {
  const paths = evalPaths(REPO);
  it("loads, covers all 50 WCAG 2.1 A/AA criteria and classifies every check once", () => {
    const config = loadEvalConfig(paths.config);
    expect(config.criteria).toHaveLength(50);
    expect(config.criteria.filter((c) => c.level === "A")).toHaveLength(30);
    expect(config.criteria.filter((c) => c.level === "AA")).toHaveLength(20);
    expect(configProblems(config)).toEqual([]);
  });

  it("never claims full coverage and keeps unchecked criteria manual", () => {
    const config = loadEvalConfig(paths.config);
    expect(config.criteria.some((c) => c.coverage === "full")).toBe(false);
    for (const c of config.criteria.filter((x) => x.checks.length === 0)) expect(c.coverage).toBe("manual");
  });

  it("rejects an unknown or unclassified check", () => {
    const config = loadEvalConfig(paths.config);
    const broken = structuredClone(config);
    broken.check_classification.behavioral.push("made-up");
    broken.check_classification.non_behavioral = broken.check_classification.non_behavioral.filter((c) => c !== "alt-text");
    expect(configProblems(broken)).toEqual(expect.arrayContaining([
      'check_classification: unknown check "made-up"',
      'check_classification: check "alt-text" is not classified',
    ]));
  });
});

describe("privacy (invariant 5)", () => {
  it("flags URLs, HTML and private or public-sector hostnames", () => {
    const hosts = ["examplecityoh.gov"];
    expect(scanText('{"x":"https://a.b/c"}', "f", hosts).map((f) => f.kind)).toContain("url");
    expect(scanText('{"x":"<img src=x>"}', "f", hosts).map((f) => f.kind)).toContain("html");
    expect(scanText('{"x":"examplecityoh"}', "f", hosts).map((f) => f.kind)).toContain("hostname");
    expect(scanText('{"x":"springfield.gov"}', "f", []).map((f) => f.kind)).toContain("hostname");
    expect(scanText('{"criterion":"1.1.1","tp":3,"site":"m01"}', "f", hosts)).toEqual([]);
    expect(() => assertExportSafe({ site: "m01", html: "<div>" }, "export", hosts)).toThrow(/html/);
  });

  it("treats seed-label sites as private hostnames", () => {
    const paths = evalPaths(REPO, tmp);
    expect(knownPrivateHosts(paths).length).toBeGreaterThan(0);
  });

  it("committed eval exports contain no municipal hostnames, URLs or HTML", () => {
    const paths = evalPaths(REPO);
    expect(scanCommittedExports(paths)).toEqual([]);
  });

  it("the committed-export scan catches a leak planted in a temp eval tree", () => {
    const fakeRepo = join(tmp, "repo");
    mkdirSync(join(fakeRepo, "eval", "runs", "r1"), { recursive: true });
    writeFileSync(join(fakeRepo, "eval", "seed-labels.jsonl"), JSON.stringify({ site: "examplecityoh.gov" }) + "\n");
    writeFileSync(join(fakeRepo, "eval", "runs", "r1", "metrics.json"), JSON.stringify({ page: "https://www.examplecityoh.gov/fees" }));
    const findings = scanCommittedExports(evalPaths(fakeRepo, join(tmp, "data")));
    expect(findings.map((f) => f.kind)).toEqual(expect.arrayContaining(["url", "hostname"]));
  });
});

describe("pre-commit privacy check", () => {
  it("scans only staged export files, and finds markup, URLs and private hosts in them", () => {
    const paths = evalPaths(join(import.meta.dirname, "..", ".."));
    expect(isExportPath("eval/phase2-defects.jsonl")).toBe(true);
    expect(isExportPath("eval/runs/static-1/static.json")).toBe(true);
    expect(isExportPath("eval/config.json")).toBe(false);
    expect(isExportPath("docs/notes.md")).toBe(false);
    const findings = scanStagedExports(paths, [
      { path: "eval/phase2-defects.jsonl", text: '{"summary":"the <html> element"}' },
      { path: "eval/runs/x/static.json", text: '{"u":"https://lakewoodcourtoh.gov/a"}' },
      { path: "docs/free-text.md", text: "<div> https://example.org" },
    ]);
    expect(findings.map((f) => `${f.file}:${f.kind}`).sort()).toEqual([
      "eval/phase2-defects.jsonl:html", "eval/runs/x/static.json:hostname", "eval/runs/x/static.json:hostname", "eval/runs/x/static.json:url",
    ]);
  });
});
