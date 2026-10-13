import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "../util.js";
import type { EvalPaths } from "../paths.js";

// ---------------------------------------------------------------------------
// Independent audit sessions (D9). Paul annotates declared pages and criteria
// before any engine output is shown; engine findings, reasoning and counts
// stay hidden until the annotation is frozen. Private, under wcag-data.
// ---------------------------------------------------------------------------

export type AuditCellStatus = "complete" | "partial" | "unable" | "pending";

export interface AuditSession {
  schema_version: 1;
  audit_id: string;
  corpus_version: string;
  split: "tuning" | "dev";
  pages: string[];
  criteria: string[];
  status: "annotating" | "frozen" | "revealed";
  cells: Record<string, AuditCellStatus>;
  created_at: string;
  frozen_at: string | null;
  revealed_run: string | null;
  revealed_at: string | null;
}

export function auditDir(paths: EvalPaths): string {
  return join(paths.dataDir, "eval-audits");
}

export function cellKey(page: string, criterion: string): string {
  return `${page}|${criterion}`;
}

export function createAudit(paths: EvalPaths, input: { corpusVersion: string; split: "tuning" | "dev"; pages: string[]; criteria: string[] }): AuditSession {
  if (input.pages.length === 0 || input.criteria.length === 0) throw new Error("An audit declares at least one page and one criterion");
  for (const p of input.pages) if (!/^[a-z]\d{2}\/p\d{3}$/.test(p)) throw new Error(`Pages are declared as site/page (e.g. t01/p001), got "${p}"`);
  const dir = auditDir(paths);
  const existing = existsSync(dir) ? readdirSync(dir).filter((f) => /^AU-\d{4}\.json$/.test(f)).length : 0;
  const audit: AuditSession = {
    schema_version: 1,
    audit_id: `AU-${String(existing + 1).padStart(4, "0")}`,
    corpus_version: input.corpusVersion,
    split: input.split,
    pages: input.pages,
    criteria: input.criteria,
    status: "annotating",
    cells: Object.fromEntries(input.pages.flatMap((p) => input.criteria.map((c) => [cellKey(p, c), "pending" as AuditCellStatus]))),
    created_at: new Date().toISOString(),
    frozen_at: null,
    revealed_run: null,
    revealed_at: null,
  };
  saveAudit(paths, audit);
  return audit;
}

export function loadAudit(paths: EvalPaths, auditId: string): AuditSession {
  const path = join(auditDir(paths), `${auditId}.json`);
  if (!existsSync(path)) throw new Error(`No audit ${auditId}`);
  return readJson<AuditSession>(path);
}

export function saveAudit(paths: EvalPaths, audit: AuditSession): void {
  writeJson(join(auditDir(paths), `${audit.audit_id}.json`), audit);
}
