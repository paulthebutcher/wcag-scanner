import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { platform, release, arch } from "node:os";
import {
  arr, bool, int, obj, oneOf, rec, str, any, assertValid, validate,
  SHA256, ISO_TIME, type Schema,
} from "./schema.js";
import { newRunId, repoState, sha256File, utcNow, writeJson, readJson, type RepoState } from "./util.js";

// ---------------------------------------------------------------------------
// D8 run manifest: every eval command that produces a result writes one.
// A successful command is not automatically a valid official evaluation:
// `validity` says whether the result may be used, and why not.
// ---------------------------------------------------------------------------

export const PURPOSES = ["diagnostic", "official-regression", "official-accuracy"] as const;
export type Purpose = (typeof PURPOSES)[number];

export const COMPLETION = ["running", "completed", "failed", "aborted"] as const;
export type Completion = (typeof COMPLETION)[number];

export interface BridgeInfo {
  original_sha: string;
  patch_sha256: string | null;
  adapter_sha256: string;
  effective_source_sha256: string;
}

export interface EngineInfo {
  /** Which engine a run executed: "head", "baseline", "pre-harness" or "none" */
  label: string;
  sha: string | null;
  bridge: BridgeInfo | null;
}

export interface EnvironmentInfo {
  node: string;
  os: string;
  lockfile_sha256: string | null;
  playwright: string | null;
  browser_build: string | null;
  axe_core: string | null;
  anthropic_sdk: string | null;
  sharp: string | null;
}

export interface ScanContract {
  tiers: number[];
  checks: string[] | null;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  locale: string;
  timezone: string;
  user_agent: string;
  page_order: string[];
  page_concurrency: number;
  llm_concurrency: number;
  service_workers: "block" | "allow";
}

export interface CorpusInfo {
  version: string;
  split: string;
  sites: string[];
  page_set_sha256: string;
  /** page id ("m01/p001") → sha256 of its capture bundle */
  artifact_hashes: Record<string, string>;
  exclusions: Array<{ page: string; reason: string }>;
  declared_exclusions_version: number | null;
}

export interface ModelInfo {
  cache_namespace: string | null;
  mode: "none" | "inject" | "collect" | "record" | "replay";
  entries_read: number;
  entries_created: number;
  model_ids: string[];
  template_hashes: Record<string, string>;
  system_prompt_hashes: Record<string, string>;
  parameters: Record<string, unknown>;
  image_index_sha256: string | null;
  /** Requests served from responses another engine's run recorded */
  shared_responses: number;
  /** sha256 over the sorted cached attempts this run used */
  entries_sha256: string | null;
  cost_usd_estimate: number | null;
}

export interface InputHash {
  path: string;
  sha256: string | null;
  through_sequence?: number | null;
  count?: number;
}

export interface Totals {
  pages: number;
  coverage: Record<string, number>;
  tooling_errors: number;
  ambiguities: number;
  image_misses: number;
  har_misses: number;
  cache_misses: number;
  attempted_egress: number;
  contained_submissions: number;
  declared_exclusion_hits: number;
}

export interface Validity {
  valid: boolean;
  official: boolean;
  reasons: string[];
  unavailable: Array<{ result: string; reason: string }>;
}

export interface RunManifest {
  schema_version: 1;
  run_id: string;
  command: string;
  purpose: Purpose;
  started_at: string;
  finished_at: string | null;
  completion: Completion;
  engine: EngineInfo;
  harness: { sha: string; dirty: boolean; changed_paths: string[] };
  environment: EnvironmentInfo;
  scan_contract: ScanContract | null;
  corpus: CorpusInfo | null;
  model: ModelInfo | null;
  inputs: Record<string, InputHash>;
  /** Run ids this run consumed (compare, metrics, review) */
  consumes: string[];
  totals: Totals;
  validity: Validity;
  /** Command-specific detail that does not fit the fields above */
  extra: Record<string, unknown>;
}

const viewportSchema = obj({ width: int({ min: 1 }), height: int({ min: 1 }), deviceScaleFactor: { type: "number", min: 0.1 } });

export const RUN_MANIFEST_SCHEMA: Schema = obj({
  schema_version: int({ min: 1, max: 1 }),
  run_id: str({ pattern: /^[a-z0-9-]+-\d{8}T\d{6}Z-[0-9a-f]{6}$/ }),
  command: str(),
  purpose: oneOf(PURPOSES),
  started_at: str({ pattern: ISO_TIME }),
  finished_at: str({ pattern: ISO_TIME, nullable: true }),
  completion: oneOf(COMPLETION),
  engine: obj({
    label: str(),
    sha: str({ pattern: /^[0-9a-f]{40}$/, nullable: true }),
    bridge: obj({
      original_sha: str({ pattern: /^[0-9a-f]{40}$/ }),
      patch_sha256: str({ pattern: SHA256, nullable: true }),
      adapter_sha256: str({ pattern: SHA256 }),
      effective_source_sha256: str({ pattern: SHA256 }),
    }, { nullable: true }),
  }),
  harness: obj({ sha: str({ pattern: /^[0-9a-f]{40}$/ }), dirty: bool(), changed_paths: arr(str()) }),
  environment: obj({
    node: str(),
    os: str(),
    lockfile_sha256: str({ pattern: SHA256, nullable: true }),
    playwright: str({ nullable: true }),
    browser_build: str({ nullable: true }),
    axe_core: str({ nullable: true }),
    anthropic_sdk: str({ nullable: true }),
    sharp: str({ nullable: true }),
  }),
  scan_contract: obj({
    tiers: arr(int({ min: 1, max: 5 })),
    checks: arr(str(), { nullable: true }),
    viewport: viewportSchema,
    locale: str(),
    timezone: str(),
    user_agent: str(),
    page_order: arr(str()),
    page_concurrency: int({ min: 1 }),
    llm_concurrency: int({ min: 1 }),
    service_workers: oneOf(["block", "allow"]),
  }, { nullable: true }),
  corpus: obj({
    version: str(),
    split: oneOf(["tuning", "dev", "holdout", "pilot", "static"]),
    sites: arr(str({ pattern: /^[a-z]\d{2}$/ })),
    page_set_sha256: str({ pattern: SHA256 }),
    artifact_hashes: rec(str({ pattern: SHA256 })),
    exclusions: arr(obj({ page: str(), reason: str() })),
    declared_exclusions_version: int({ nullable: true }),
  }, { nullable: true }),
  model: obj({
    cache_namespace: str({ nullable: true }),
    mode: oneOf(["none", "inject", "collect", "record", "replay"]),
    entries_read: int({ min: 0 }),
    entries_created: int({ min: 0 }),
    model_ids: arr(str()),
    template_hashes: rec(str({ pattern: SHA256 })),
    system_prompt_hashes: rec(str({ pattern: SHA256 })),
    parameters: rec(any()),
    image_index_sha256: str({ pattern: SHA256, nullable: true }),
    shared_responses: int({ min: 0 }),
    entries_sha256: str({ pattern: SHA256, nullable: true }),
    cost_usd_estimate: { type: "number", min: 0, nullable: true },
  }, { nullable: true }),
  inputs: rec(obj({
    path: str(),
    sha256: str({ pattern: SHA256, nullable: true }),
    through_sequence: int({ min: 0, nullable: true, optional: true }),
    count: int({ min: 0, optional: true }),
  })),
  consumes: arr(str()),
  totals: obj({
    pages: int({ min: 0 }),
    coverage: rec(int({ min: 0 })),
    tooling_errors: int({ min: 0 }),
    ambiguities: int({ min: 0 }),
    image_misses: int({ min: 0 }),
    har_misses: int({ min: 0 }),
    cache_misses: int({ min: 0 }),
    attempted_egress: int({ min: 0 }),
    contained_submissions: int({ min: 0 }),
    declared_exclusion_hits: int({ min: 0 }),
  }),
  validity: obj({
    valid: bool(),
    official: bool(),
    reasons: arr(str()),
    unavailable: arr(obj({ result: str(), reason: str() })),
  }),
  extra: rec(any()),
});

// ---------------------------------------------------------------------------
// Environment capture
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);

function packageVersion(name: string, root: string): string | null {
  try {
    const path = require.resolve(`${name}/package.json`, { paths: [root] });
    return (JSON.parse(readFileSync(path, "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

export function captureEnvironment(root: string, browserBuild: string | null = null): EnvironmentInfo {
  const lockfile = join(root, "package-lock.json");
  return {
    node: process.version,
    os: `${platform()} ${release()} ${arch()}`,
    lockfile_sha256: existsSync(lockfile) ? sha256File(lockfile) : null,
    playwright: packageVersion("playwright", root),
    browser_build: browserBuild,
    axe_core: packageVersion("axe-core", root),
    anthropic_sdk: packageVersion("@anthropic-ai/sdk", root),
    sharp: packageVersion("sharp", root),
  };
}

export function emptyTotals(): Totals {
  return {
    pages: 0,
    coverage: {},
    tooling_errors: 0,
    ambiguities: 0,
    image_misses: 0,
    har_misses: 0,
    cache_misses: 0,
    attempted_egress: 0,
    contained_submissions: 0,
    declared_exclusion_hits: 0,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export class OfficialRunRefused extends Error {}

export interface StartRunOptions {
  command: string;
  argv: string[];
  purpose: Purpose;
  root: string;
  runsDir: string;
  engine?: EngineInfo;
  /** Injected repo state (tests); defaults to the live repository */
  repo?: RepoState;
}

export interface RunHandle {
  manifest: RunManifest;
  dir: string;
  path: string;
  /** Persist the manifest as it stands (atomic). */
  save(): void;
  /** Mark completion, compute validity, validate the schema and persist. */
  finish(completion: Completion): RunManifest;
  invalidate(reason: string): void;
  unavailable(result: string, reason: string): void;
}

/**
 * Start a run: allocate its id and private directory and write the initial
 * manifest. Official purposes are refused outright on a dirty tree.
 */
export function startRun(options: StartRunOptions): RunHandle {
  const repo = options.repo ?? repoState(options.root);
  const official = options.purpose !== "diagnostic";
  if (official && repo.dirty) {
    throw new OfficialRunRefused(
      `Refusing ${options.purpose} run on a dirty tree (${repo.changed_paths.slice(0, 5).join(", ")}${repo.changed_paths.length > 5 ? ", …" : ""}). Commit or stash first.`,
    );
  }

  const runId = newRunId(options.command);
  const dir = join(options.runsDir, runId);
  const path = join(dir, "manifest.json");
  const manifest: RunManifest = {
    schema_version: 1,
    run_id: runId,
    command: ["wcag", "eval", ...options.argv].join(" "),
    purpose: options.purpose,
    started_at: utcNow(),
    finished_at: null,
    completion: "running",
    engine: options.engine ?? { label: "none", sha: null, bridge: null },
    harness: { sha: repo.sha, dirty: repo.dirty, changed_paths: repo.changed_paths },
    environment: captureEnvironment(options.root),
    scan_contract: null,
    corpus: null,
    model: null,
    inputs: {},
    consumes: [],
    totals: emptyTotals(),
    validity: { valid: true, official, reasons: [], unavailable: [] },
    extra: {},
  };

  const handle: RunHandle = {
    manifest,
    dir,
    path,
    save: () => writeJson(path, manifest),
    invalidate: (reason) => {
      manifest.validity.valid = false;
      if (!manifest.validity.reasons.includes(reason)) manifest.validity.reasons.push(reason);
    },
    unavailable: (result, reason) => {
      manifest.validity.unavailable.push({ result, reason });
    },
    finish: (completion) => {
      manifest.completion = completion;
      manifest.finished_at = utcNow();
      applyValidityRules(manifest);
      assertValid(RUN_MANIFEST_SCHEMA, manifest, `run manifest ${runId}`);
      writeJson(path, manifest);
      return manifest;
    },
  };
  handle.save();
  return handle;
}

/**
 * Validity rules shared by every command. Totals that mean the evidence was
 * incomplete always invalidate; an official run additionally needs a clean
 * tree (re-checked here in case the tree changed during the run).
 */
export function applyValidityRules(manifest: RunManifest): void {
  const reasons = new Set(manifest.validity.reasons);
  const t = manifest.totals;
  if (manifest.completion !== "completed") reasons.add(`run did not complete (${manifest.completion})`);
  if (t.attempted_egress > 0) reasons.add(`${t.attempted_egress} attempted network egress`);
  if (t.har_misses > 0) reasons.add(`${t.har_misses} unexpected HAR miss(es)`);
  if (t.image_misses > 0) reasons.add(`${t.image_misses} image store miss(es)`);
  if (t.cache_misses > 0) reasons.add(`${t.cache_misses} response cache miss(es)`);
  if (manifest.validity.official && manifest.harness.dirty) reasons.add("official run on a dirty tree");
  manifest.validity.reasons = Array.from(reasons);
  manifest.validity.valid = manifest.validity.reasons.length === 0;
}

export function loadManifest(runsDir: string, runId: string): RunManifest {
  if (runId === "latest" || !/^[a-z0-9-]+-\d{8}T\d{6}Z-[0-9a-f]{6}$/.test(runId)) {
    throw new Error(`Expected an explicit run id (got "${runId}"); "latest" is not accepted.`);
  }
  const path = join(runsDir, runId, "manifest.json");
  if (!existsSync(path)) throw new Error(`No manifest for run ${runId} at ${path}`);
  const manifest = readJson<RunManifest>(path);
  const errors = validate(RUN_MANIFEST_SCHEMA, manifest);
  if (errors.length > 0) throw new Error(`Manifest for ${runId} fails schema validation:\n  ${errors.slice(0, 10).join("\n  ")}`);
  return manifest;
}

/** Hash entry for a consumed input file (labels, cases, overrides…). */
export function inputHash(path: string, extra: Partial<InputHash> = {}): InputHash {
  return { path, sha256: existsSync(path) ? sha256File(path) : null, ...extra };
}
