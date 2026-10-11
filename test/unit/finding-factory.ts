import type { Finding, Evidence, Severity } from "../../src/types.js";

let n = 0;

/** Minimal Finding for report/clustering tests. */
export function makeTestFinding(opts: {
  id?: string;
  criterion?: string;
  failureType: string;
  selector?: string;
  html?: string;
  reasoning?: string;
  severity?: Severity;
  detectedBy?: Evidence["detected_by"];
  pageSnapshotId?: string;
  measured?: Record<string, unknown>;
}): Finding {
  n++;
  return {
    id: opts.id ?? `f-${String(n).padStart(4, "0")}`,
    page_snapshot_id: opts.pageSnapshotId ?? "snap-1",
    interaction_state_id: null,
    wcag_criterion: opts.criterion ?? "4.1.2",
    wcag_level: "A",
    severity: opts.severity ?? "major",
    category: "aria",
    finding_type_hash: `hash-${opts.failureType}`,
    evidence: {
      element_selector: opts.selector ?? "div.x",
      element_html: opts.html ?? '<div class="x"></div>',
      element_screenshot: "",
      element_computed_styles: {},
      context_screenshot: "",
      measured_values: { failure_type: opts.failureType, ...(opts.measured ?? {}) },
      keyboard_sequence: null,
      aria_attributes: {},
      detected_by: opts.detectedBy ?? "axe_core",
    },
    analysis: {
      method: "rule_based",
      reasoning: opts.reasoning ?? "reasoning",
      llm_input: null,
      llm_output: null,
      impact_description: "",
      affected_users: [],
    },
    confidence: { score: 0.95, tier: "definitive", basis: "", requires_human: false, false_positive_risk: "low" },
    remediation: {
      generic_fix: "Stored fix",
      platform_fix: { platform: "webflow", platform_version: "", steps: ["Stored step"], designer_path: "", screenshots: [], generated_by: "template", platform_docs_url: null },
      code_fix: null,
      estimated_effort: "minor",
      fix_verified: false,
    },
    human_review: null,
  };
}

export const contrastReasoning = (fg: string, bg: string, ratio = 2.4, expected = 4.5, size = "10.5pt (14px)", weight = "normal") =>
  `Fix any of the following:\n  Element has insufficient color contrast of ${ratio} (foreground color: ${fg}, background color: ${bg}, font size: ${size}, font weight: ${weight}). Expected contrast ratio of ${expected}:1`;
