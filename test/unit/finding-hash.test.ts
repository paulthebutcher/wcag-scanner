import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeFindingTypeHash, realFailureType, FINDING_HASH_VERSION } from "../../src/core/finding-hash.js";
import { openDatabase, migrateFindingTypeHashes, insertScanSession, insertPageSnapshot, insertFinding, listFindingsByScan } from "../../src/store/db.js";
import { groupFindingsByHash, computeDiff } from "../../src/report/generator.js";
import { makeTestFinding } from "./finding-factory.js";
import type { ScanSession, PageSnapshot } from "../../src/types.js";

const session = (id: string): ScanSession => ({ id, url: "https://x.test", platform: "webflow", platform_detected_via: "test", initiated_at: "2026-10-16T00:00:00Z", completed_at: "2026-10-16T00:10:00Z", comparison_scan_id: null, scan_type: "initial", detection_manifest: null, excluded_pages: null } as unknown as ScanSession);
const snapshot = (id: string, scan: string): PageSnapshot => ({ id, scan_session_id: scan, url: `https://x.test/${id}`, title: id, captured_at: "2026-10-16T00:00:00Z", full_dom: "<html></html>", screenshot: "", viewport: { width: 1280, height: 800, deviceScaleFactor: 1 } } as unknown as PageSnapshot);

describe("finding_type_hash from the real failure type (P2-003)", () => {
  it("resolves the measured failure type first, then the raw rule id or type, then the fallback", () => {
    expect(realFailureType({ measured_values: { failure_type: "image-alt" }, raw_result: { ruleId: "other" } }, "axe_violation")).toBe("image-alt");
    expect(realFailureType({ raw_result: { ruleId: "color-contrast" } }, "axe_violation")).toBe("color-contrast");
    expect(realFailureType({ raw_result: { type: "focus_order_mismatch" } }, "behavioral")).toBe("focus_order_mismatch");
    expect(realFailureType({ raw_result: { failure_type: "generic_link_text" } }, "semantic")).toBe("generic_link_text");
    expect(realFailureType({ measured_values: { failure_type: "" }, raw_result: {} }, "semantic")).toBe("semantic");
    const a = computeFindingTypeHash("2.4.6", "missing_heading", "webflow"); const b = computeFindingTypeHash("2.4.6", "skipped_level", "webflow");
    expect(a).not.toBe(b);
    expect(computeFindingTypeHash("2.4.6", "missing_heading", "webflow")).toBe(a);
  });

  it("migrates stored hashes once on open, so groups split per failure type and report --compare still matches across scans", () => {
    const dir = mkdtempSync(join(tmpdir(), "wcag-hash-")); const path = join(dir, "wcag.db");
    try {
      let db = openDatabase(path);
      const tierHash = computeFindingTypeHash("2.4.6", "semantic", "webflow"); // the old scheme: one hash per tier
      for (const scan of ["s1", "s2"]) {
        insertScanSession(db, session(scan));
        insertPageSnapshot(db, snapshot(`${scan}-p1`, scan));
        for (const ft of ["missing_heading", "skipped_level", "possible_misleading_structure"]) {
          const f = makeTestFinding({ criterion: "2.4.6", failureType: ft, selector: `h2.${ft}`, html: `<h2>${ft}</h2>`, pageSnapshotId: `${scan}-p1` });
          insertFinding(db, { ...f, finding_type_hash: tierHash });
        }
      }
      expect(new Set(listFindingsByScan(db, "s1").map((f) => f.finding_type_hash)).size).toBe(1);
      db.pragma("user_version = 0"); // the rows were written under the old scheme
      db.close();

      db = openDatabase(path); // the migration runs here
      const s1 = listFindingsByScan(db, "s1"); const s2 = listFindingsByScan(db, "s2");
      expect(new Set(s1.map((f) => f.finding_type_hash)).size).toBe(3);
      for (const f of s1) expect(f.finding_type_hash).toBe(computeFindingTypeHash("2.4.6", String(f.evidence.measured_values?.failure_type), "webflow"));
      expect(Number(db.pragma("user_version", { simple: true }))).toBe(FINDING_HASH_VERSION);
      expect(migrateFindingTypeHashes(db).size).toBe(0); // idempotent
      // Cards: one per failure type, never spanning two
      const groups = groupFindingsByHash(s1);
      expect(groups.map((g) => [g.failureType, g.instanceCount]).sort()).toEqual([["missing_heading", 1], ["possible_misleading_structure", 1], ["skipped_level", 1]]);
      for (const g of groups) expect(new Set(g.findings.map((f) => f.evidence.measured_values?.failure_type)).size).toBe(1);
      // Before/after comparison still matches the same kinds across the two scans
      const diff = computeDiff(groupFindingsByHash(s2), groups);
      expect(diff.persistent).toHaveLength(3);
      expect(diff.resolved).toHaveLength(0);
      expect(diff.newFindings).toHaveLength(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
