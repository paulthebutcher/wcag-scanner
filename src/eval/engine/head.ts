import Anthropic from "@anthropic-ai/sdk";
import { scan } from "../../core/scanner.js";
import { createPromptRunner, type PromptRunner } from "../../core/prompt-runner.js";
import { CHECK_TIERS } from "../../core/check-registry.js";
import type { EngineHandle } from "./types.js";
import { CollectingReporter } from "./types.js";

// ---------------------------------------------------------------------------
// HEAD runs in-process. It already accepts an injected browser, a page list,
// a page concurrency and a prompt runner; the only eval hook it needs is the
// submission-state image substitution (ScanOptions.evalHooks).
// ---------------------------------------------------------------------------

export function headEngine(sha: string, label = "head"): EngineHandle {
  return {
    label,
    sha,
    bridge: null,
    promptModule: { createPromptRunner },
    errors: Anthropic,
    checks: Object.keys(CHECK_TIERS),
    supportsUrlList: true,
    syntheticFetches: () => new Map(),
    // Relative ".js" specifiers resolve to the .ts sources under tsx/vitest
    importModule: async <T>(rel: string) => import(new URL(`../../${rel}.js`, import.meta.url).href) as Promise<T>,
    run: async (options) => {
      const reporter = new CollectingReporter(options.progress);
      const result = await scan({
        url: options.rootUrl,
        dataDir: options.dataDir,
        urls: options.pageUrls,
        tiers: options.tiers,
        viewport: options.viewport,
        pageConcurrency: options.pageConcurrency,
        concurrency: options.llmConcurrency,
        promptRunner: options.runner as PromptRunner,
        includeNoindex: false,
        reporter,
        ...(options.submissionStates ? { evalHooks: { submissionStates: options.submissionStates } } : {}),
      }, options.browser);
      return {
        scanId: result.scanSession.id,
        findings: result.findings,
        criterionResults: result.criterionResults,
        coverage: result.coverage,
        pageSnapshots: result.pageSnapshots,
        warnings: reporter.warnings,
      };
    },
  };
}
