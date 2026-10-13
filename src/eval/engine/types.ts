import type { Browser } from "playwright";
import type { CriterionResult, Finding, PageSnapshot, Viewport } from "../../types.js";
import type { FormInfo } from "../../checks/forms/discovery.js";
import type { SubmissionState } from "../../checks/forms/submission.js";
import type { ScanCoverage } from "../../core/coverage.js";
import type { BridgeInfo } from "../manifest.js";
import type { AnthropicErrors } from "../model/client.js";
import type { EnginePromptModule } from "../model/runner.js";
import type { SyntheticResponse } from "../transport/node-fetch.js";

// ---------------------------------------------------------------------------
// An engine the harness can run: HEAD in-process, or an older SHA (the
// baseline, the pre-harness reference) from a worktree through the bridge.
// ---------------------------------------------------------------------------

export type SubmissionStatesHook = (pageUrl: string, form: FormInfo, states: SubmissionState[]) => SubmissionState[];

export interface EngineRunOptions {
  rootUrl: string;
  /** Frozen page order */
  pageUrls: string[];
  dataDir: string;
  /** Controlled browser, or undefined for the engine's own default launch */
  browser?: Browser;
  /** The engine's own PromptRunner with the eval client inside */
  runner: unknown;
  tiers: number[];
  pageConcurrency: number;
  llmConcurrency: number;
  viewport: Viewport;
  /** Only with eval hooks; undefined keeps the default path */
  submissionStates?: SubmissionStatesHook;
}

export interface EngineRunResult {
  scanId: string;
  findings: Finding[];
  criterionResults: CriterionResult[];
  /** null when the engine predates coverage recording */
  coverage: ScanCoverage | null;
  pageSnapshots: PageSnapshot[];
  warnings: string[];
}

export interface EngineHandle {
  label: string;
  sha: string;
  bridge: BridgeInfo | null;
  promptModule: EnginePromptModule;
  errors: AnthropicErrors;
  /** Check ids this engine version has (capability map, D6) */
  checks: string[];
  /** Whether the engine accepts a page list (otherwise the bridge serves a sitemap) */
  supportsUrlList: boolean;
  /** Node fetch responses the bridge synthesises (declared in the manifest) */
  syntheticFetches(rootUrl: string, pageUrls: string[]): Map<string, SyntheticResponse>;
  run(options: EngineRunOptions): Promise<EngineRunResult>;
}

/** Collects engine warnings (tooling errors surface here and in coverage). */
export class CollectingReporter {
  readonly warnings: string[] = [];
  update(): void { /* progress is not recorded */ }
  complete(): void { /* progress is not recorded */ }
  warn(phase: string, message: string): void {
    this.warnings.push(`[${phase}] ${message.split("\n")[0].slice(0, 400)}`);
  }
}
