import { appendFileSync } from "node:fs";
import type { EvalPaths } from "./paths.js";
import { repoState } from "./util.js";

// ---------------------------------------------------------------------------
// Holdout seal (invariant 10). Phase 1 captures holdout passively and never
// scans, labels, reviews, summarises or sends model calls on it. Any later
// access needs `--split holdout --unseal "<reason>"` and leaves a line in the
// committed access log (timestamp, SHA, command, reason; no content).
// ---------------------------------------------------------------------------

export class HoldoutSealed extends Error {}

export function guardSplit(paths: EvalPaths, split: string, unsealReason: string | undefined, command: string): void {
  if (split !== "holdout") return;
  if (!unsealReason || unsealReason.trim().length < 10) {
    throw new HoldoutSealed(`The holdout split is sealed. Access needs --unseal "<reason>" (at least 10 characters); it is logged to eval/holdout-access.log.`);
  }
  const reason = unsealReason.replace(/[\r\n\t]+/g, " ").trim();
  const sha = repoState(paths.repo).sha;
  appendFileSync(paths.holdoutAccessLog, `${new Date().toISOString()}\t${sha}\t${command}\t${reason}\n`);
}
