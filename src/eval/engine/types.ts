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
  /** Receives the engine's progress lines (replay writes them to <run>/progress.log) */
  progress?: ProgressSink;
}

export type ProgressSink = (kind: "update" | "complete" | "warn", phase: string, message: string) => void;

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
  /** Load one of this engine's own modules, e.g. "checks/semantic/link-text" (static runs) */
  importModule<T = Record<string, unknown>>(relPath: string): Promise<T>;
}

/**
 * Collects engine warnings (tooling errors surface here and in coverage) and
 * forwards every progress line to an optional sink.
 */
export class CollectingReporter {
  readonly warnings: string[] = [];
  constructor(private readonly sink?: ProgressSink) {}
  update(phase: string, message: string): void {
    this.sink?.("update", phase, message);
  }
  complete(phase: string, message: string): void {
    this.sink?.("complete", phase, message);
  }
  warn(phase: string, message: string): void {
    this.warnings.push(`[${phase}] ${message.split("\n")[0].slice(0, 400)}`);
    this.sink?.("warn", phase, message);
  }
}
