import type {
  Finding,
  Confidence,
  ConfidenceTier,
  FalsePositiveRisk,
  DetectedBy,
  Severity,
} from "../types.js";

// ---------------------------------------------------------------------------
// Calibration tables from evidence-envelope.md
// ---------------------------------------------------------------------------

/**
 * Default tier and score ranges by detection method.
 *
 * | Detection method | Default tier | Score range |
 * |-----------------|-------------|-------------|
 * | axe_core        | definitive  | 0.95-1.0    |
 * | playwright      | high        | 0.80-0.94   |
 * | claude_api      | high/moderate | 0.50-0.89 |
 * | indicators      | needs_review | 0.30-0.60  |
 */

// ---------------------------------------------------------------------------
// Claude API prompt-specific calibration
// ---------------------------------------------------------------------------

interface PromptCalibration {
  /** Failure types that produce high confidence */
  highConfidence: Record<string, { score: number; tier: ConfidenceTier }>;
  /** Default for this prompt if failure type not matched */
  default: { score: number; tier: ConfidenceTier };
}

const CLAUDE_CALIBRATION: Record<string, PromptCalibration> = {
  // Prompt 1: Alt text quality (1.1.1)
  "1.1.1": {
    highConfidence: {
      filename_as_alt: { score: 0.87, tier: "high" },
      placeholder_alt: { score: 0.85, tier: "high" },
      redundant_with_context: { score: 0.75, tier: "high" },
    },
    default: { score: 0.57, tier: "moderate" }, // decorative_vs_informative is subjective
  },
  // Prompt 2: Link text quality (2.4.4)
  "2.4.4": {
    highConfidence: {
      click_here: { score: 0.92, tier: "high" },
      read_more: { score: 0.88, tier: "high" },
      generic_text: { score: 0.85, tier: "high" },
    },
    default: { score: 0.75, tier: "high" }, // ambiguous_without_context
  },
  // Prompt 3: Headings (2.4.6 / 1.3.1)
  "2.4.6": {
    highConfidence: {
      skipped_level: { score: 0.96, tier: "definitive" },
      empty_heading: { score: 0.95, tier: "definitive" },
    },
    default: { score: 0.57, tier: "moderate" }, // style_not_structure
  },
  "1.3.1": {
    highConfidence: {
      skipped_level: { score: 0.96, tier: "definitive" },
      missing_heading_structure: { score: 0.90, tier: "high" },
    },
    default: { score: 0.70, tier: "high" },
  },
  // Prompt 4: Color use (1.4.1)
  "1.4.1": {
    highConfidence: {
      link_color_only: { score: 0.87, tier: "high" },
    },
    default: { score: 0.55, tier: "moderate" }, // chart_color_only → needs_review
  },
  // Prompt 5: Consistent navigation (3.2.3)
  "3.2.3": {
    highConfidence: {
      order_changed: { score: 0.96, tier: "definitive" },
      items_missing: { score: 0.90, tier: "high" },
    },
    default: { score: 0.77, tier: "high" }, // similar but not identical labels
  },
  // Prompt 6: Consistent identification (3.2.4)
  "3.2.4": {
    highConfidence: {
      different_labels_same_function: { score: 0.90, tier: "high" },
    },
    default: { score: 0.77, tier: "high" },
  },
};

// ---------------------------------------------------------------------------
// Playwright behavioral calibration
// ---------------------------------------------------------------------------

const PLAYWRIGHT_CALIBRATION: Record<string, { score: number; tier: ConfidenceTier }> = {
  // Keyboard reachability: definitive (element is or isn't reachable)
  "2.1.1": { score: 0.95, tier: "definitive" },
  // No keyboard trap: high (cycle detection is reliable)
  "2.1.2": { score: 0.90, tier: "high" },
  // Bypass blocks: high
  "2.4.1": { score: 0.88, tier: "high" },
  // Focus visible: high (screenshot comparison is reliable)
  "2.4.7": { score: 0.85, tier: "high" },
  // Focus order: moderate to high (visual order comparison has edge cases)
  "2.4.3": { score: 0.78, tier: "high" },
};

// ---------------------------------------------------------------------------
// False positive risk mapping
// ---------------------------------------------------------------------------

function assessFalsePositiveRisk(
  detectedBy: DetectedBy,
  criterion: string,
  failureType: string | undefined,
): FalsePositiveRisk {
  if (detectedBy === "axe_core") return "low";

  if (detectedBy === "playwright") {
    if (criterion === "2.1.1") return "low"; // keyboard reachability
    if (criterion === "2.4.3") return "medium"; // focus order
    return "low";
  }

  if (detectedBy === "claude_api") {
    // Heading structure (skipped_level) is structural fact → low
    if (criterion === "2.4.6" && failureType === "skipped_level") return "low";
    if (criterion === "1.3.1" && failureType === "skipped_level") return "low";
    // Heading structure (style_not_structure) → high
    if (failureType === "style_not_structure") return "high";
    // Alt text quality → medium
    if (criterion === "1.1.1") return "medium";
    // Link text quality → low-medium → we use "low" for definitive patterns
    if (criterion === "2.4.4") {
      if (failureType === "click_here" || failureType === "read_more") return "low";
      return "medium";
    }
    // Use of color → medium-high
    if (criterion === "1.4.1") {
      if (failureType === "link_color_only") return "medium";
      return "high";
    }
    // Consistent navigation → low
    if (criterion === "3.2.3") return "low";
    if (criterion === "3.2.4") return "low";
    return "medium";
  }

  // manual / indicators → high
  return "high";
}

// ---------------------------------------------------------------------------
// requires_human flag logic
// ---------------------------------------------------------------------------

function shouldRequireHuman(
  tier: ConfidenceTier,
  severity: Severity,
  detectedBy: DetectedBy,
  falsePositiveRisk: FalsePositiveRisk,
  claudeRequiresHuman: boolean,
): boolean {
  // Always require human for needs_review tier
  if (tier === "needs_review") return true;

  // Moderate confidence + critical/major severity → require human
  if (tier === "moderate" && (severity === "critical" || severity === "major")) return true;

  // Indicators (Tier 5) always need review
  if (detectedBy === "manual") return true;

  // Claude explicitly requested human verification
  if (claudeRequiresHuman) return true;

  // High false positive risk → require human
  if (falsePositiveRisk === "high") return true;

  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score a Finding and produce a Confidence sub-entity.
 *
 * Scoring rules:
 * - axe_core → definitive (0.95+), exception: incomplete → needs_review
 * - playwright → high (0.80-0.94), with criterion-specific calibration
 * - claude_api → high or moderate (0.50-0.89), with prompt+failure_type calibration
 * - indicators/manual → needs_review (0.30-0.60)
 */
export function scoreConfidence(finding: Finding): Confidence {
  const detectedBy = finding.evidence.detected_by;
  const criterion = finding.wcag_criterion;
  const severity = finding.severity;
  const measured = finding.evidence.measured_values;
  const raw = (typeof finding.evidence === "object" ? finding.evidence : null);

  // Extract failure type from measured_values or raw evidence
  const failureType = (measured?.failure_type as string) ?? undefined;

  // Extract Claude's requires_human_verification flag
  const claudeRequiresHuman = extractClaudeRequiresHuman(finding);

  // Check if this is an axe-core incomplete result
  const isAxeIncomplete = detectedBy === "axe_core" &&
    finding.finding_type_hash.length > 0 &&
    isIncompleteResult(finding);

  let score: number;
  let tier: ConfidenceTier;

  switch (detectedBy) {
    case "axe_core": {
      if (isAxeIncomplete) {
        score = 0.50;
        tier = "needs_review";
      } else {
        score = 0.97;
        tier = "definitive";
      }
      break;
    }

    case "playwright": {
      const cal = PLAYWRIGHT_CALIBRATION[criterion];
      if (cal) {
        score = cal.score;
        tier = cal.tier;
      } else {
        score = 0.85;
        tier = "high";
      }
      break;
    }

    case "claude_api": {
      const promptCal = CLAUDE_CALIBRATION[criterion];
      if (promptCal && failureType && promptCal.highConfidence[failureType]) {
        const ft = promptCal.highConfidence[failureType];
        score = ft.score;
        tier = ft.tier;
      } else if (promptCal) {
        score = promptCal.default.score;
        tier = promptCal.default.tier;
      } else {
        // Unknown criterion for Claude → moderate
        score = 0.65;
        tier = "moderate";
      }

      // Override: if Claude returned low confidence, downgrade
      const claudeConfidence = measured?.confidence as number | undefined;
      if (claudeConfidence !== undefined && claudeConfidence < score) {
        score = claudeConfidence;
        if (score < 0.50) tier = "needs_review";
        else if (score < 0.65) tier = "moderate";
        else if (score < 0.80) tier = "high";
      }
      break;
    }

    case "manual":
    default: {
      score = 0.45;
      tier = "needs_review";
      break;
    }
  }

  const falsePositiveRisk = assessFalsePositiveRisk(detectedBy, criterion, failureType);
  const requiresHuman = shouldRequireHuman(tier, severity, detectedBy, falsePositiveRisk, claudeRequiresHuman);
  const basis = generateBasis(detectedBy, criterion, tier, failureType, isAxeIncomplete);

  return {
    score,
    tier,
    basis,
    requires_human: requiresHuman,
    false_positive_risk: falsePositiveRisk,
  };
}

/**
 * Score confidence for a batch of findings.
 * Errors are logged and produce a needs_review fallback.
 */
export function scoreConfidenceBatch(findings: Finding[]): Confidence[] {
  return findings.map((f) => {
    try {
      return scoreConfidence(f);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[confidence] Failed to score ${f.id}: ${msg}`);
      return {
        score: 0.40,
        tier: "needs_review" as ConfidenceTier,
        basis: `Scoring failed: ${msg}`,
        requires_human: true,
        false_positive_risk: "high" as FalsePositiveRisk,
      };
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractClaudeRequiresHuman(finding: Finding): boolean {
  // Check analysis.llm_output for the raw response
  if (finding.analysis.llm_output?.raw_response) {
    try {
      const parsed = JSON.parse(finding.analysis.llm_output.raw_response);
      if (parsed.requires_human_verification === true) return true;
    } catch {
      // Ignore parse errors
    }
  }

  // Check measured values
  const measured = finding.evidence.measured_values;
  if (measured?.requires_human_verification === true) return true;

  return false;
}

function isIncompleteResult(finding: Finding): boolean {
  // Check the analysis reasoning or raw evidence for incomplete markers
  if (finding.analysis.reasoning.includes("incomplete")) return true;

  // Check if the finding was created from axe incomplete[] array
  // The failure type in the hash would contain "incomplete"
  const measured = finding.evidence.measured_values;
  if (measured?.axe_incomplete === true) return true;

  return false;
}

function generateBasis(
  detectedBy: DetectedBy,
  criterion: string,
  tier: ConfidenceTier,
  failureType: string | undefined,
  isAxeIncomplete: boolean,
): string {
  switch (detectedBy) {
    case "axe_core":
      if (isAxeIncomplete) {
        return "axe-core flagged this as incomplete — requires manual verification to confirm.";
      }
      return "axe-core rules are binary checks with very low false positive rates. " +
        `Rule tested criterion ${criterion} and found a definitive violation.`;

    case "playwright":
      return `Playwright behavioral test for ${criterion} produced ${tier} confidence. ` +
        "Automated keyboard/focus testing is reliable but edge cases exist.";

    case "claude_api": {
      const parts = [`Claude API evaluated criterion ${criterion}`];
      if (failureType) parts.push(`and identified failure type "${failureType}"`);
      parts.push(`with ${tier} confidence.`);
      if (tier === "moderate") {
        parts.push("Subjective judgment may vary — human review recommended.");
      }
      return parts.join(" ");
    }

    case "manual":
      return "Flagged by Tier 5 indicator for human review. " +
        "These findings require expert judgment to confirm or dismiss.";

    default:
      return `Detected by ${detectedBy} with ${tier} confidence.`;
  }
}
