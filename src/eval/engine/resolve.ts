import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EvalPaths } from "../paths.js";
import type { EngineHandle } from "./types.js";
import { headEngine } from "./head.js";
import { BASELINE_SHA, legacyEngine } from "./legacy.js";

// ---------------------------------------------------------------------------
// Resolve an --engine argument to a runnable engine.
//   head                  the harness's own commit, in-process
//   baseline / ffdcd30…   the baseline through the bridge (patch + sitemap adapter)
//   pre-harness / 5d7a467… the reference commit before the harness, with the
//                         same hook patch (eval/baseline-bridge/5d7a467.patch)
//   <sha>                 any later commit; it must already carry the eval hooks
// ---------------------------------------------------------------------------

export const PRE_HARNESS_SHA = "5d7a46777178ef67dd715e4bf2dd249f4c9fc182";

export async function resolveEngine(paths: EvalPaths, spec: string, harnessSha: string, log: (m: string) => void): Promise<EngineHandle> {
  const full = (rev: string) => execFileSync("git", ["rev-parse", `${rev}^{commit}`], { cwd: paths.repo, encoding: "utf8" }).trim();
  if (spec === "head" || (spec.length >= 7 && harnessSha.startsWith(spec))) return headEngine(harnessSha);
  if (spec === "baseline" || (spec.length >= 7 && BASELINE_SHA.startsWith(spec))) {
    return legacyEngine({ paths, sha: BASELINE_SHA, label: "baseline", patchPath: join(paths.baselineBridgeDir, "ffdcd30.patch"), supportsUrlList: false, log });
  }
  if (spec === "pre-harness" || (spec.length >= 7 && PRE_HARNESS_SHA.startsWith(spec))) {
    return legacyEngine({ paths, sha: PRE_HARNESS_SHA, label: "pre-harness", patchPath: join(paths.baselineBridgeDir, "5d7a467.patch"), supportsUrlList: true, log });
  }
  const sha = full(spec);
  const hasHooks = execFileSync("git", ["show", `${sha}:src/core/scanner.ts`], { cwd: paths.repo, encoding: "utf8" }).includes("evalHooks");
  if (!hasHooks) throw new Error(`Engine ${sha.slice(0, 12)} has no eval hooks and no bridge patch`);
  const patch = join(paths.baselineBridgeDir, `${sha.slice(0, 7)}.patch`);
  return legacyEngine({ paths, sha, label: `engine-${sha.slice(0, 7)}`, patchPath: existsSync(patch) ? patch : null, supportsUrlList: true, log });
}
