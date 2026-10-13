import { appendFileSync, existsSync } from "node:fs";
import { readJsonl } from "./util.js";
import { assertExportSafe, knownPrivateHosts } from "./privacy.js";
import type { EvalPaths } from "./paths.js";

// ---------------------------------------------------------------------------
// eval/phase2-defects.jsonl: engine defects found while building the harness
// (never fixed in Phase 1). Committed, so every entry passes the privacy
// check: check ids, criteria and run ids only, no URLs or markup.
// ---------------------------------------------------------------------------

export interface DefectInput {
  found_in: string;
  component: string;
  summary: string;
  affects: string[];
  evidence: string;
}

export interface Defect extends DefectInput {
  id: string;
  status: "open";
}

export function appendDefect(paths: EvalPaths, input: DefectInput): Defect {
  const existing = readJsonl<Defect>(paths.phase2Defects);
  const next = existing.reduce((m, d) => Math.max(m, Number(d.id.replace(/^P2-/, "")) || 0), 0) + 1;
  const defect: Defect = { id: `P2-${String(next).padStart(3, "0")}`, ...input, status: "open" };
  assertExportSafe(defect, "phase2 defect", knownPrivateHosts(paths));
  appendFileSync(paths.phase2Defects, (existsSync(paths.phase2Defects) ? "" : "") + JSON.stringify(defect) + "\n");
  return defect;
}
