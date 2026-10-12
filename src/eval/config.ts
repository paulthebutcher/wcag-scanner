import { arr, int, num, obj, oneOf, str, assertValid, type Schema } from "./schema.js";
import { hashJson, readJson } from "./util.js";
import { CHECK_TIERS } from "../core/check-registry.js";

// ---------------------------------------------------------------------------
// eval/config.json: gate thresholds, check classification, capture and
// replay contract, declared exclusions and the criterion coverage list.
// ---------------------------------------------------------------------------

export type CoverageLevel = "full" | "partial" | "manual";

export interface CriterionCoverage {
  id: string;
  name: string;
  level: "A" | "AA";
  checks: string[];
  coverage: CoverageLevel;
  note: string;
}

export interface EvalConfig {
  schema_version: 1;
  frozen_at: string;
  scope: { platform: string; wcag_version: string; levels: string[] };
  gate: {
    metric_drop_threshold: number;
    metric_gate_min_n: number;
    insufficient_evidence_n: number;
    metric_gate_splits: string[];
    max_excluded_page_fraction_per_tuning_site: number;
  };
  capture: {
    max_pages_per_site: number;
    min_seconds_between_top_level_loads: number;
    one_active_page_per_host: boolean;
    user_agent_template: string;
    readiness: { wait_until: "load" | "domcontentloaded"; network_idle_cap_ms: number; settle_ms: number };
  };
  replay: {
    page_concurrency: number;
    llm_concurrency: number;
    viewport: { width: number; height: number; deviceScaleFactor: number };
    locale: string;
    timezone: string;
    service_workers: "block";
    tiers: number[];
  };
  declared_exclusions: { version: number; note: string; host_suffixes: string[] };
  check_classification: { note: string; behavioral: string[]; non_behavioral: string[] };
  criteria: CriterionCoverage[];
}

const CONFIG_SCHEMA: Schema = obj({
  schema_version: int({ min: 1, max: 1 }),
  frozen_at: str({ pattern: /^\d{4}-\d{2}-\d{2}$/ }),
  scope: obj({ platform: str(), wcag_version: str(), levels: arr(str()) }),
  gate: obj({
    metric_drop_threshold: num({ min: 0, max: 1 }),
    metric_gate_min_n: int({ min: 1 }),
    insufficient_evidence_n: int({ min: 1 }),
    metric_gate_splits: arr(str()),
    max_excluded_page_fraction_per_tuning_site: num({ min: 0, max: 1 }),
  }),
  capture: obj({
    max_pages_per_site: int({ min: 1 }),
    min_seconds_between_top_level_loads: num({ min: 0 }),
    one_active_page_per_host: { type: "boolean" },
    user_agent_template: str({ pattern: /\{EVAL_CONTACT_URL\}/ }),
    readiness: obj({ wait_until: oneOf(["load", "domcontentloaded"]), network_idle_cap_ms: int({ min: 0 }), settle_ms: int({ min: 0 }) }),
  }),
  replay: obj({
    page_concurrency: int({ min: 1 }),
    llm_concurrency: int({ min: 1 }),
    viewport: obj({ width: int({ min: 1 }), height: int({ min: 1 }), deviceScaleFactor: num({ min: 0.1 }) }),
    locale: str(),
    timezone: str(),
    service_workers: oneOf(["block"]),
    tiers: arr(int({ min: 1, max: 5 })),
  }),
  declared_exclusions: obj({ version: int({ min: 1 }), note: str(), host_suffixes: arr(str()) }),
  check_classification: obj({ note: str(), behavioral: arr(str()), non_behavioral: arr(str()) }),
  criteria: arr(obj({
    id: str({ pattern: /^\d\.\d\.\d{1,2}$/ }),
    name: str(),
    level: oneOf(["A", "AA"]),
    checks: arr(str()),
    coverage: oneOf(["full", "partial", "manual"]),
    note: str(),
  })),
}, { additional: false });

/**
 * Load and validate eval/config.json. Beyond the schema, every check id must
 * be a real engine check (check-registry), every check must be classified
 * exactly once, and a criterion with no checks cannot claim coverage.
 */
export function loadEvalConfig(path: string): EvalConfig {
  const config = readJson<EvalConfig>(path);
  assertValid(CONFIG_SCHEMA, config, path);
  const problems = configProblems(config);
  if (problems.length > 0) throw new Error(`Invalid ${path}:\n  ${problems.join("\n  ")}`);
  return config;
}

export function configProblems(config: EvalConfig): string[] {
  const problems: string[] = [];
  const known = new Set(Object.keys(CHECK_TIERS));
  const classified = [...config.check_classification.behavioral, ...config.check_classification.non_behavioral];
  const seen = new Set<string>();
  for (const check of classified) {
    if (!known.has(check)) problems.push(`check_classification: unknown check "${check}"`);
    if (seen.has(check)) problems.push(`check_classification: "${check}" classified twice`);
    seen.add(check);
  }
  for (const check of known) {
    if (!seen.has(check)) problems.push(`check_classification: check "${check}" is not classified`);
  }
  const ids = new Set<string>();
  for (const c of config.criteria) {
    if (ids.has(c.id)) problems.push(`criteria: ${c.id} listed twice`);
    ids.add(c.id);
    for (const check of c.checks) {
      if (!known.has(check)) problems.push(`criteria ${c.id}: unknown check "${check}"`);
    }
    if (c.checks.length === 0 && c.coverage !== "manual") problems.push(`criteria ${c.id}: no checks but coverage "${c.coverage}"`);
  }
  return problems;
}

export function isBehavioral(config: EvalConfig, check: string): boolean {
  return config.check_classification.behavioral.includes(check);
}

export function configHash(config: EvalConfig): string {
  return hashJson(config);
}

