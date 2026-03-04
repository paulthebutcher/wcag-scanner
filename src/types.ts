// Generated from Data Model spec — see CLAUDE.md for full field reference
// TODO: C1-03 — populate all entity interfaces

export type Platform = "webflow" | "squarespace" | "shopify" | "wordpress" | "framer" | "unknown";
export type Severity = "critical" | "major" | "minor" | "advisory";
export type ConfidenceTier = "definitive" | "high" | "moderate" | "needs_review";
export type DetectedBy = "axe_core" | "playwright" | "claude_api" | "manual";
export type AnalysisMethod = "rule_based" | "llm_semantic" | "llm_visual" | "human";
export type Verdict = "confirmed" | "false_positive" | "downgraded" | "escalated";
export type ScanType = "initial" | "rescan" | "monitoring";
export type CriterionStatus = "passed" | "failed" | "not_applicable" | "not_tested";
export type WcagLevel = "A" | "AA" | "AAA";
export type Category = "contrast" | "semantics" | "keyboard" | "forms" | "images" | "aria" | "structure";
export type Effort = "trivial" | "minor" | "moderate" | "significant";
export type FalsePositiveRisk = "low" | "medium" | "high";
export type GeneratedBy = "template" | "llm" | "human";
export type PromptMode = "realtime" | "batch";

export interface CheckResult {
  element_selector: string;
  element_html: string;
  wcag_criterion: string;
  detected_by: DetectedBy;
  raw_result: unknown;
  screenshot?: Buffer;
  context_screenshot?: Buffer;
  measured_values?: Record<string, unknown>;
  keyboard_sequence?: unknown[];
  aria_attributes?: Record<string, string>;
}

export interface PlatformAdapter {
  detect(dom: string): boolean;
  getRemediationSteps(finding: Finding): PlatformFix;
  getPlatformInfo(): PlatformInfo;
  getPlatformContext(): string;
  getCMSPattern(): RegExp | null;
}

export interface PlatformInfo {
  platform: Platform;
  version: string | null;
  detected_via: string;
}

export interface PromptRunnerConfig {
  mode: PromptMode;
  max_retries: number;
  concurrency: number;
  fallback_on_failure: "needs_review" | "skip";
}

// TODO: Full entity interfaces (ScanSession, PageSnapshot, etc.) — C1-03
export interface ScanSession { id: string; }
export interface PageSnapshot { id: string; }
export interface InteractionState { id: string; }
export interface Finding { id: string; }
export interface Evidence {}
export interface Analysis {}
export interface Confidence {}
export interface Remediation {}
export interface PlatformFix { platform: Platform; }
export interface HumanReview {}
export interface ScanSummary {}
export interface CriterionResult {}
