import { appendFileSync, closeSync, existsSync, openSync, unlinkSync, readFileSync } from "node:fs";
import { arr, bool, int, obj, oneOf, str, num, assertValid, ISO_TIME, SHA256, type Schema } from "./schema.js";
import { readJsonl, sha256 } from "./util.js";

// ---------------------------------------------------------------------------
// D4 cases and labels. Both files are private and append-only:
//
//   eval/cases.jsonl   case records; a change of criterion or target is a new
//                      revision of the same case, with a reason
//   eval/labels.jsonl  judgment events (L-000001…), each with a sequence
//                      number; undo and corrections are further events, and
//                      the current state is a deterministic fold
//
// One writer at a time (an exclusive lock file per store).
// ---------------------------------------------------------------------------

export type Unit = "element" | "page" | "interaction" | "scan";
export type Origin = "review" | "independent_audit" | "seed";
export type LabelVerdict = "violation" | "no_violation" | "unsure";
export type Batch = "calibration" | "queue" | "anchor" | "adhoc" | "audit";
export type Severity = "critical" | "major" | "minor" | "advisory";

export interface CaseTarget {
  selector: string | null;
  html_sha256: string | null;
  /** Private: outer HTML (truncated), for matching and display */
  html: string | null;
  context_sha256: string | null;
  /** "load", "scenario:<name>", "modal-open"… null matches any state */
  state: string | null;
}

export interface Assertion {
  assertion_id: string;
  criterion: string;
  issue: string;
  failure_type: string | null;
}

export interface CaseRecord {
  case_id: string;
  revision: number;
  revision_reason: string | null;
  created_at: string;
  created_by: string;
  site: string;
  page: string;
  corpus_version: string;
  unit: Unit;
  target: CaseTarget;
  assertions: Assertion[];
  origin: Origin;
  propagation_group: string | null;
  evidence_refs: string[];
  source_seed_id: string | null;
}

export interface LabelEvent {
  label_id: string;
  seq: number;
  kind: "judgment" | "undo";
  case_id: string | null;
  assertion_id: string | null;
  verdict: LabelVerdict | null;
  /** Annotation on a violation only */
  severity_correction: Severity | null;
  reviewer: string;
  batch: Batch;
  /** Audit judgments: before or after engine output was revealed */
  phase: "pre_reveal" | "post_reveal" | null;
  active_seconds: number | null;
  timestamp: string;
  /** Group id when this judgment was applied by propagation */
  propagation_group: string | null;
  /** Label this propagated judgment copies */
  propagation_source: string | null;
  /** For undo: the label (or propagation operation) undone */
  undoes: string | null;
  /** The engine output the judgment was made against, if any */
  prediction_ref: { run_id: string; prediction_key: string } | null;
  note: string | null;
  /**
   * A provisional judgment (e.g. from a review doc's live check) counts in
   * the regression gate but stays out of official metrics until a reviewer
   * confirms it with a later non-provisional judgment.
   */
  provisional?: boolean;
}

const ASSERTION_SCHEMA = obj({ assertion_id: str({ pattern: /^A\d+$/ }), criterion: str({ pattern: /^(\d\.\d\.\d{1,2}|scan)$/ }), issue: str(), failure_type: str({ nullable: true }) });

export const CASE_SCHEMA: Schema = obj({
  case_id: str({ pattern: /^C-\d{6}$/ }),
  revision: int({ min: 1 }),
  revision_reason: str({ nullable: true }),
  created_at: str({ pattern: ISO_TIME }),
  created_by: str(),
  site: str({ pattern: /^[a-z]\d{2}$/ }),
  page: str({ pattern: /^(p\d{3}|scan)$/ }),
  corpus_version: str(),
  unit: oneOf(["element", "page", "interaction", "scan"]),
  target: obj({
    selector: str({ nullable: true }),
    html_sha256: str({ pattern: SHA256, nullable: true }),
    html: str({ nullable: true }),
    context_sha256: str({ pattern: SHA256, nullable: true }),
    state: str({ nullable: true }),
  }),
  assertions: arr(ASSERTION_SCHEMA, { minItems: 1 }),
  origin: oneOf(["review", "independent_audit", "seed"]),
  propagation_group: str({ nullable: true }),
  evidence_refs: arr(str()),
  source_seed_id: str({ pattern: /^SL-\d{3}$/, nullable: true }),
});

export const LABEL_SCHEMA: Schema = obj({
  label_id: str({ pattern: /^L-\d{6}$/ }),
  seq: int({ min: 1 }),
  kind: oneOf(["judgment", "undo"]),
  case_id: str({ pattern: /^C-\d{6}$/, nullable: true }),
  assertion_id: str({ pattern: /^A\d+$/, nullable: true }),
  verdict: oneOf(["violation", "no_violation", "unsure"], { nullable: true }),
  severity_correction: oneOf(["critical", "major", "minor", "advisory"], { nullable: true }),
  reviewer: str(),
  batch: oneOf(["calibration", "queue", "anchor", "adhoc", "audit"]),
  phase: oneOf(["pre_reveal", "post_reveal"], { nullable: true }),
  active_seconds: num({ min: 0, nullable: true }),
  timestamp: str({ pattern: ISO_TIME }),
  propagation_group: str({ nullable: true }),
  propagation_source: str({ nullable: true }),
  undoes: str({ nullable: true }),
  prediction_ref: obj({ run_id: str(), prediction_key: str() }, { nullable: true }),
  note: str({ nullable: true }),
  provisional: bool({ optional: true }),
});

// ---------------------------------------------------------------------------
// Single writer
// ---------------------------------------------------------------------------

export class StoreLocked extends Error {}

function withLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  let fd: number;
  try {
    fd = openSync(lock, "wx");
  } catch {
    throw new StoreLocked(`${path} is locked by another writer (${lock})`);
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export class CaseStore {
  constructor(readonly path: string) {}

  records(): CaseRecord[] {
    return readJsonl<CaseRecord>(this.path);
  }

  /** Latest revision of every case. */
  current(): Map<string, CaseRecord> {
    const out = new Map<string, CaseRecord>();
    for (const r of this.records()) {
      const prior = out.get(r.case_id);
      if (!prior || r.revision > prior.revision) out.set(r.case_id, r);
    }
    return out;
  }

  create(input: Omit<CaseRecord, "case_id" | "revision" | "revision_reason" | "created_at">): CaseRecord {
    return withLock(this.path, () => {
      const records = this.records();
      const next = records.reduce((m, r) => Math.max(m, Number(r.case_id.slice(2))), 0) + 1;
      const record: CaseRecord = {
        case_id: `C-${String(next).padStart(6, "0")}`,
        revision: 1,
        revision_reason: null,
        created_at: new Date().toISOString(),
        ...input,
        target: { ...input.target, html_sha256: input.target.html_sha256 ?? (input.target.html ? sha256(input.target.html) : null) },
      };
      assertValid(CASE_SCHEMA, record, "case");
      appendFileSync(this.path, JSON.stringify(record) + "\n");
      return record;
    });
  }

  /** Append a revision (criterion, target or assertion changes need a reason). */
  revise(caseId: string, changes: Partial<Pick<CaseRecord, "target" | "assertions" | "unit" | "propagation_group" | "evidence_refs">>, reason: string, by: string): CaseRecord {
    if (!reason.trim()) throw new Error("A case revision needs a reason");
    return withLock(this.path, () => {
      const prior = this.current().get(caseId);
      if (!prior) throw new Error(`No case ${caseId}`);
      const record: CaseRecord = { ...prior, ...changes, revision: prior.revision + 1, revision_reason: reason, created_at: new Date().toISOString(), created_by: by };
      assertValid(CASE_SCHEMA, record, "case revision");
      appendFileSync(this.path, JSON.stringify(record) + "\n");
      return record;
    });
  }

  sha256(): string | null {
    return existsSync(this.path) ? sha256(readFileSync(this.path)) : null;
  }
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export type LabelInput = Omit<LabelEvent, "label_id" | "seq" | "timestamp"> & { timestamp?: string };

export class LabelStore {
  constructor(readonly path: string) {}

  events(): LabelEvent[] {
    return readJsonl<LabelEvent>(this.path).sort((a, b) => a.seq - b.seq);
  }

  lastSeq(): number {
    return this.events().reduce((m, e) => Math.max(m, e.seq), 0);
  }

  /** Append events atomically under the lock; ids and sequence numbers are assigned here. */
  append(inputs: LabelInput[]): LabelEvent[] {
    return withLock(this.path, () => {
      let seq = this.lastSeq();
      const out: LabelEvent[] = [];
      for (const input of inputs) {
        seq++;
        const event: LabelEvent = { ...input, label_id: `L-${String(seq).padStart(6, "0")}`, seq, timestamp: input.timestamp ?? new Date().toISOString() };
        if (event.kind === "judgment") {
          if (!event.case_id || !event.assertion_id || !event.verdict) throw new Error("A judgment needs a case, an assertion and a verdict");
          if (event.severity_correction && event.verdict !== "violation") throw new Error("A severity correction annotates a violation only");
        } else if (!event.undoes) {
          throw new Error("An undo names the label or propagation it undoes");
        }
        assertValid(LABEL_SCHEMA, event, "label");
        out.push(event);
      }
      appendFileSync(this.path, out.map((e) => JSON.stringify(e)).join("\n") + "\n");
      return out;
    });
  }

  sha256(): string | null {
    return existsSync(this.path) ? sha256(readFileSync(this.path)) : null;
  }
}

export interface FoldedJudgment {
  case_id: string;
  assertion_id: string;
  verdict: LabelVerdict;
  severity_correction: Severity | null;
  label_id: string;
  reviewer: string;
  batch: Batch;
  phase: LabelEvent["phase"];
  propagation_group: string | null;
  provisional: boolean;
  history: string[];
}

/**
 * Fold label events (up to `throughSeq`) into the current judgment per
 * (case, assertion). The latest live judgment wins; an undo removes the
 * label it names, and undoing a propagated label (or its group id) removes
 * every judgment applied by that propagation.
 */
export function foldLabels(events: LabelEvent[], throughSeq = Infinity): Map<string, FoldedJudgment> {
  const ordered = events.filter((e) => e.seq <= throughSeq).sort((a, b) => a.seq - b.seq);
  const undone = new Set<string>();
  const undoneGroups = new Set<string>();
  // Undo targets are resolved first: an undo can only refer to earlier labels
  const byId = new Map(ordered.map((e) => [e.label_id, e]));
  for (const e of ordered) {
    if (e.kind !== "undo" || !e.undoes) continue;
    const target = byId.get(e.undoes);
    if (target && target.seq < e.seq) {
      undone.add(target.label_id);
      if (target.propagation_group) undoneGroups.add(target.propagation_group);
    } else if (!target) {
      undoneGroups.add(e.undoes);
    }
  }
  const out = new Map<string, FoldedJudgment>();
  const history = new Map<string, string[]>();
  for (const e of ordered) {
    if (e.kind !== "judgment" || !e.case_id || !e.assertion_id || !e.verdict) continue;
    const key = `${e.case_id}|${e.assertion_id}`;
    const h = history.get(key) ?? [];
    h.push(e.label_id);
    history.set(key, h);
    if (undone.has(e.label_id)) continue;
    if (e.propagation_group && undoneGroups.has(e.propagation_group)) continue;
    out.set(key, {
      case_id: e.case_id, assertion_id: e.assertion_id, verdict: e.verdict, severity_correction: e.severity_correction,
      label_id: e.label_id, reviewer: e.reviewer, batch: e.batch, phase: e.phase, propagation_group: e.propagation_group,
      provisional: e.provisional === true, history: h,
    });
  }
  return out;
}

/** Judgments that count in official metrics: provisional ones are left out. */
export function officialJudgments(judgments: Map<string, FoldedJudgment>): Map<string, FoldedJudgment> {
  return new Map(Array.from(judgments).filter(([, j]) => !j.provisional));
}

// ---------------------------------------------------------------------------
// Seed resolutions (private sidecar) and overrides (committed)
// ---------------------------------------------------------------------------

export type ResolutionStatus = "resolved" | "partially_resolved" | "unresolved_fixture" | "scan_level" | "disputed" | "requires_rendering";

export interface SeedResolution {
  seed_id: string;
  seq: number;
  status: ResolutionStatus;
  store: string | null;
  scan_id: string | null;
  snapshot_ids: string[];
  finding_ids: string[];
  case_ids: string[];
  element: { selector: string | null; html_sha256: string | null } | null;
  state: string | null;
  method: string;
  notes: string;
  resolved_at: string;
}

export interface LabelOverride {
  seed_id: string;
  status: "disputed" | "scan_level" | "composite";
  reason: string;
  pending: string | null;
  exclude_from: Array<"element" | "criterion">;
}

export interface OverridesFile {
  schema_version: 1;
  overrides: LabelOverride[];
}
