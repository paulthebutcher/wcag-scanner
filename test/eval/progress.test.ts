import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CollectingReporter } from "../../src/eval/engine/types.js";
import { progressSink } from "../../src/eval/replay.js";

describe("replay progress log", () => {
  it("the engine reporter forwards every progress line and still collects warnings", () => {
    const seen: string[] = [];
    const r = new CollectingReporter((kind, phase, message) => seen.push(`${kind}|${phase}|${message}`));
    r.update("behavioral", "https://x.test/a: 2 issue(s) found");
    r.complete("crawl", "Discovered 2 page(s)");
    r.warn("semantic", "failed for https://x.test/b: boom\nstack");
    expect(seen).toEqual(["update|behavioral|https://x.test/a: 2 issue(s) found", "complete|crawl|Discovered 2 page(s)", "warn|semantic|failed for https://x.test/b: boom\nstack"]);
    expect(r.warnings).toEqual(["[semantic] failed for https://x.test/b: boom"]);
    // Without a sink nothing is recorded but warnings
    const quiet = new CollectingReporter();
    quiet.update("crawl", "x");
    expect(quiet.warnings).toEqual([]);
  });

  it("writes one tagged JSON line per progress event to <run>/progress.log", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-progress-"));
    try {
      const sink = progressSink(dir, "head-r2");
      sink("update", "semantic", "18/46 pages evaluated (https://x.test/a: 0 issue(s))");
      sink("complete", "behavioral", "done\nsecond line");
      const lines = readFileSync(join(dir, "progress.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(lines.map((l) => [l.tag, l.kind, l.phase, l.message])).toEqual([
        ["head-r2", "update", "semantic", "18/46 pages evaluated (https://x.test/a: 0 issue(s))"],
        ["head-r2", "complete", "behavioral", "done"],
      ]);
      expect(typeof lines[0].at).toBe("string");
      // A missing run directory never throws
      expect(() => progressSink(join(dir, "missing", "deeper"), "t")("update", "p", "m")).not.toThrow();
      expect(existsSync(join(dir, "missing"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
