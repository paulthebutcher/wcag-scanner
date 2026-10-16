import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveCorpus, hashTree, loadSiteCapture, siteDir, supplementCorpus, verifySite, SUPPLEMENT_HAR, type SiteCapture } from "../../src/eval/corpus.js";
import { evalPaths } from "../../src/eval/paths.js";

function fakeCorpus() {
  const root = mkdtempSync(join(tmpdir(), "eval-derive-"));
  const paths = evalPaths(join(import.meta.dirname, "..", ".."), root);
  const dir = siteDir(paths, { version: "v1", split: "tuning", siteId: "t01" });
  const page = (id: string, url: string) => {
    mkdirSync(join(dir, id, "images"), { recursive: true });
    writeFileSync(join(dir, id, "dom.html"), `<html><body>${id}</body></html>`);
    writeFileSync(join(dir, id, "screenshot.png"), "png");
    writeFileSync(join(dir, id, "capture.private.json"), "{}");
    writeFileSync(join(dir, id, "page.har"), JSON.stringify({ log: { version: "1.2", creator: { name: "t", version: "1" }, entries: [{ request: { method: "GET", url, headers: [] }, response: { status: 200, headers: [], content: { mimeType: "text/html", text: "x" } } }] } }));
  };
  page("p001", "https://x.test/");
  page("p002", "https://x.test/b");
  const capture = {
    schema_version: 1, corpus_version: "v1", split: "tuning", site_id: "t01", root_url: "https://x.test/", final_root_url: "https://x.test/", passive: false,
    capture_run_id: "capture-1", harness_sha: "a".repeat(40), started_at: "2026-10-14T00:00:00Z", finished_at: "2026-10-14T00:01:00Z", user_agent: "ua",
    contract: { viewport: { width: 1280, height: 800, deviceScaleFactor: 1 }, locale: "en-US", timezone: "America/Denver", userAgent: "ua" },
    robots: { source: "absent", sha256: null, group: "*", crawl_delay_seconds: null },
    pages: [
      { page_id: "p001", order: 0, url: "https://x.test/", final_url: "https://x.test/", title: "a", status: "captured", error: null },
      { page_id: "p002", order: 1, url: "https://x.test/b", final_url: "https://x.test/b", title: "b", status: "captured", error: null },
    ],
    omissions: [], uncaptured_forms: [], pacing: { min_interval_ms: 3000, top_level_loads: 2, min_observed_gap_ms: {} }, containment: { contained_requests: 0, by_detail: {} },
    file_hashes: {} as Record<string, string>,
  } as unknown as SiteCapture;
  capture.file_hashes = hashTree(dir, ["site.private.json"]);
  writeFileSync(join(dir, "site.private.json"), JSON.stringify(capture));
  return { root, paths, dir };
}

describe("deriveCorpus", () => {
  it("writes a new version with the page excluded and its reason, linking artifacts and leaving the source untouched", () => {
    const { root, paths, dir } = fakeCorpus();
    try {
      const before = readFileSync(join(dir, "site.private.json"), "utf8");
      const d = deriveCorpus(paths, { from: "v1", to: "v2", split: "tuning", siteId: "t01", exclude: [{ page_id: "p002", reason: "Instagram embed render varies per load (P2-017)" }] });
      expect(d.pages.map((p) => [p.page_id, p.status, p.error])).toEqual([["p001", "captured", null], ["p002", "excluded", "Instagram embed render varies per load (P2-017)"]]);
      expect(d.derived_from?.version).toBe("v1");
      expect(readFileSync(join(dir, "site.private.json"), "utf8")).toBe(before);
      expect(loadSiteCapture(paths, { version: "v1", split: "tuning", siteId: "t01" }).pages.every((p) => p.status === "captured")).toBe(true);
      const dst = siteDir(paths, { version: "v2", split: "tuning", siteId: "t01" });
      expect(statSync(join(dst, "p001", "dom.html")).ino).toBe(statSync(join(dir, "p001", "dom.html")).ino);
      expect(verifySite(paths, { version: "v2", split: "tuning", siteId: "t01" }).problems).toEqual([]);
      expect(() => deriveCorpus(paths, { from: "v1", to: "v2", split: "tuning", siteId: "t01", exclude: [] })).toThrow(/immutable/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores an excluded page in a later version, with its artifacts still in place", () => {
    const { root, paths } = fakeCorpus();
    try {
      deriveCorpus(paths, { from: "v1", to: "v2", split: "tuning", siteId: "t01", exclude: [{ page_id: "p002", reason: "varies" }] });
      const v3 = deriveCorpus(paths, { from: "v2", to: "v3", split: "tuning", siteId: "t01", exclude: [], restore: ["p002"] });
      expect(v3.pages.map((p) => [p.page_id, p.status, p.error])).toEqual([["p001", "captured", null], ["p002", "captured", null]]);
      expect(v3.derived_from).toMatchObject({ version: "v2", restored: ["p002"] });
      expect(verifySite(paths, { version: "v3", split: "tuning", siteId: "t01" }).problems).toEqual([]);
      expect(loadSiteCapture(paths, { version: "v2", split: "tuning", siteId: "t01" }).pages[1].status).toBe("excluded");
      expect(() => deriveCorpus(paths, { from: "v1", to: "v4", split: "tuning", siteId: "t01", exclude: [], restore: ["p001"] })).toThrow(/not an excluded page/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses unknown pages and missing reasons", () => {
    const { root, paths } = fakeCorpus();
    try {
      expect(() => deriveCorpus(paths, { from: "v1", to: "v3", split: "tuning", siteId: "t01", exclude: [{ page_id: "p009", reason: "x" }] })).toThrow(/No page p009/);
      expect(() => deriveCorpus(paths, { from: "v1", to: "v4", split: "tuning", siteId: "t01", exclude: [{ page_id: "p001", reason: " " }] })).toThrow(/needs a reason/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("supplementCorpus", () => {
  it("adds a fetched asset to a new version's supplement HAR and logs the fetch", async () => {
    const { root, paths, dir } = fakeCorpus();
    try {
      const calls: string[] = [];
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const out = await supplementCorpus(paths, {
        from: "v1", to: "v5", split: "tuning", siteId: "t01", urls: ["https://cdn.x.test/menu.png"], reason: "hidden menu icon never requested at capture",
        runId: "supplement-1", userAgent: "WCAGEngine-Eval/0.1 (+{EVAL_CONTACT_URL})", robotsDecision: () => "not governed",
        fetchImpl: async (url) => { calls.push(url); return { status: 200, headers: [["content-type", "image/png"], ["content-length", "4"]], body: png }; },
      });
      expect(calls).toEqual(["https://cdn.x.test/menu.png"]);
      expect(out.supplements).toEqual([expect.objectContaining({ url: "https://cdn.x.test/menu.png", status: 200, content_type: "image/png", bytes: 4, run_id: "supplement-1", reason: "hidden menu icon never requested at capture" })]);
      const dst = siteDir(paths, { version: "v5", split: "tuning", siteId: "t01" });
      const har = JSON.parse(readFileSync(join(dst, SUPPLEMENT_HAR), "utf8"));
      expect(har.log.entries[0].request.url).toBe("https://cdn.x.test/menu.png");
      expect(Buffer.from(har.log.entries[0].response.content.text, "base64")).toEqual(png);
      expect(har.log.entries[0].response.headers.some((h: { name: string }) => /content-length/i.test(h.name))).toBe(false);
      expect(verifySite(paths, { version: "v5", split: "tuning", siteId: "t01" }).problems).toEqual([]);
      expect(loadSiteCapture(paths, { version: "v1", split: "tuning", siteId: "t01" }).supplements).toBeUndefined();
      expect(() => readFileSync(join(dir, SUPPLEMENT_HAR))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a disallowed URL before fetching", async () => {
    const { root, paths } = fakeCorpus();
    try {
      let fetched = false;
      await expect(supplementCorpus(paths, {
        from: "v1", to: "v6", split: "tuning", siteId: "t01", urls: ["https://x.test/private"], reason: "r", runId: "s", userAgent: "ua",
        robotsDecision: () => "disallowed by the captured robots.txt", fetchImpl: async () => { fetched = true; return { status: 200, headers: [], body: Buffer.alloc(0) }; },
      })).rejects.toThrow(/robots/);
      expect(fetched).toBe(false);
      expect(() => loadSiteCapture(paths, { version: "v6", split: "tuning", siteId: "t01" })).toThrow(/No capture/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
