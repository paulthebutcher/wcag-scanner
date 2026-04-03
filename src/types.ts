// Generated from Data Model spec — see CLAUDE.md for full field reference

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

// Sub-entity helper interfaces

export interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export interface InteractionTrigger {
  type: "click" | "hover" | "keypress" | "scroll";
  target: string;
  key?: string;
}

export interface LlmInput {
  prompt: string;
  dom_snippet: string;
  screenshot_provided: boolean;
}

export interface LlmOutput {
  raw_response: string;
  model: string;
  tokens_used: number;
}

export interface KeyboardEvent {
  type: string;
  key: string;
  target: string;
  timestamp?: string;
}

export interface SeverityCounts {
  critical: number;
  major: number;
  minor: number;
  advisory: number;
}

export interface ConfidenceCounts {
  definitive: number;
  high: number;
  moderate: number;
  needs_review: number;
}

export interface CategoryCounts {
  contrast: number;
  semantics: number;
  keyboard: number;
  forms: number;
  images: number;
  aria: number;
  structure: number;
}

// Operational interfaces

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

// Entity interfaces

/** Audit trail of which detection rules/versions were active during a scan */
export interface DetectionManifest {
  /** Engine version (package.json version) */
  engine_version: string;
  /** @axe-core/playwright version from node_modules */
  axe_core_version: string;
  /** Any axe-core rules explicitly disabled */
  axe_disabled_rules: string[];
  /** Which check tiers were active */
  active_tiers: number[];
  /** Whether the Anthropic API key was present and usable */
  api_key_present: boolean;
  /** Tier 3 semantic checks that were enabled */
  semantic_checks: string[];
}

export interface ScanSession {
  id: string;
  url: string;
  platform: Platform;
  platform_detected_via: string;
  initiated_at: string;
  completed_at: string;
  comparison_scan_id: string | null;
  scan_type: ScanType;
  /** Audit trail: which rules, versions, and tiers were active */
  detection_manifest: DetectionManifest | null;
}

export interface PageSnapshot {
  id: string;
  scan_session_id: string;
  url: string;
  title: string;
  captured_at: string;
  full_dom: string;
  screenshot: string;
  viewport: Viewport;
}

export interface InteractionState {
  id: string;
  page_snapshot_id: string;
  trigger: InteractionTrigger;
  dom_diff: string;
  screenshot: string;
  new_elements_visible: string[];
  focus_element: string;
}

export interface Finding {
  id: string;
  page_snapshot_id: string;
  interaction_state_id: string | null;
  wcag_criterion: string;
  wcag_level: WcagLevel;
  severity: Severity;
  category: Category;
  finding_type_hash: string;
  evidence: Evidence;
  analysis: Analysis;
  confidence: Confidence;
  remediation: Remediation;
  human_review: HumanReview | null;
}

export interface Evidence {
  element_selector: string;
  element_html: string;
  element_screenshot: string;
  element_computed_styles: Record<string, string>;
  context_screenshot: string;
  measured_values: Record<string, unknown>;
  keyboard_sequence: KeyboardEvent[] | null;
  aria_attributes: Record<string, string>;
  detected_by: DetectedBy;
}

export interface Analysis {
  method: AnalysisMethod;
  reasoning: string;
  llm_input: LlmInput | null;
  llm_output: LlmOutput | null;
  impact_description: string;
  affected_users: string[];
}

export interface Confidence {
  score: number;
  tier: ConfidenceTier;
  basis: string;
  requires_human: boolean;
  false_positive_risk: FalsePositiveRisk;
}

export interface Remediation {
  generic_fix: string;
  platform_fix: PlatformFix;
  code_fix: string | null;
  estimated_effort: Effort;
  fix_verified: boolean;
}

export interface PlatformFix {
  platform: Platform;
  platform_version: string;
  steps: string[];
  designer_path: string;
  screenshots: string[];
  generated_by: GeneratedBy;
  platform_docs_url: string | null;
}

export interface HumanReview {
  reviewer: string;
  reviewed_at: string;
  verdict: Verdict;
  notes: string;
  severity_override: Severity | null;
  remediation_override: string | null;
}

export interface ScanSummary {
  scan_session_id: string;
  total_findings: number;
  by_severity: SeverityCounts;
  by_confidence: ConfidenceCounts;
  by_category: CategoryCounts;
  human_reviewed_pct: number;
  estimated_total_effort: string;
  wcag_criteria_failed: string[];
  wcag_criteria_passed: string[];
}

export interface CriterionResult {
  scan_session_id: string;
  wcag_criterion: string;
  status: CriterionStatus;
  tested_by: DetectedBy;
  evidence_summary: string;
  finding_ids: string[];
}
