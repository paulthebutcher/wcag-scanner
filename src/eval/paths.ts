import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Every location the harness reads or writes. Committed files live under
// <repo>/eval; private data under <dataDir> (gitignored wcag-data by
// default). Tests pass temporary roots so they never touch real data.
// ---------------------------------------------------------------------------

export interface EvalPaths {
  repo: string;
  /** Committed: config, inventory, seeds, overrides, aggregate exports */
  evalDir: string;
  config: string;
  corpusInventory: string;
  seedLabels: string;
  labelOverrides: string;
  lakewoodStatic: string;
  baselineBridgeDir: string;
  holdoutAccessLog: string;
  phase2Defects: string;
  committedRunsDir: string;
  committedBaselinesDir: string;
  /** Private (gitignored even though they sit under eval/) */
  labels: string;
  cases: string;
  seedResolutions: string;
  /** Private data root */
  dataDir: string;
  corpusDir: string;
  sitesPrivate: string;
  builtwith: string;
  cacheDir: string;
  runsDir: string;
  worktreesDir: string;
}

export function evalPaths(repo: string, dataDir?: string): EvalPaths {
  const root = resolve(repo);
  const evalDir = join(root, "eval");
  const data = resolve(dataDir ?? process.env.WCAG_EVAL_DATA_DIR ?? join(root, "wcag-data"));
  const corpusDir = join(data, "eval-corpus");
  return {
    repo: root,
    evalDir,
    config: join(evalDir, "config.json"),
    corpusInventory: join(evalDir, "corpus.json"),
    seedLabels: join(evalDir, "seed-labels.jsonl"),
    labelOverrides: join(evalDir, "label-overrides.json"),
    lakewoodStatic: join(evalDir, "lakewood-static.json"),
    baselineBridgeDir: join(evalDir, "baseline-bridge"),
    holdoutAccessLog: join(evalDir, "holdout-access.log"),
    phase2Defects: join(evalDir, "phase2-defects.jsonl"),
    committedRunsDir: join(evalDir, "runs"),
    committedBaselinesDir: join(evalDir, "baselines"),
    labels: join(evalDir, "labels.jsonl"),
    cases: join(evalDir, "cases.jsonl"),
    seedResolutions: join(evalDir, "seed-resolutions.jsonl"),
    dataDir: data,
    corpusDir,
    sitesPrivate: join(corpusDir, "sites.private.json"),
    builtwith: join(corpusDir, "builtwith.csv"),
    cacheDir: join(data, "eval-cache"),
    runsDir: join(data, "eval-runs"),
    worktreesDir: join(data, "eval-worktrees"),
  };
}
