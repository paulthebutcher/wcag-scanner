import type {
  CheckResult,
  Finding,
  Analysis,
  AnalysisMethod,
  DetectedBy,
  Severity,
  LlmInput,
  LlmOutput,
} from "../types.js";

// ---------------------------------------------------------------------------
// WCAG criterion → impact description mapping
// ---------------------------------------------------------------------------

const CRITERION_IMPACTS: Record<string, { impact: string; users: string[] }> = {
  // 1.1.1 — Non-text content
  "1.1.1": {
    impact: "Screen reader users cannot perceive the purpose or content of this image",
    users: ["screen_reader"],
  },
  // 1.3.1 — Info and relationships
  "1.3.1": {
    impact: "Structural relationships are not programmatically conveyed, confusing assistive technology users",
    users: ["screen_reader", "cognitive"],
  },
  // 1.4.1 — Use of color
  "1.4.1": {
    impact: "Information conveyed only by color is invisible to users who cannot distinguish colors",
    users: ["low_vision", "cognitive"],
  },
  // 1.4.3 — Contrast (minimum)
  "1.4.3": {
    impact: "Low contrast text is difficult or impossible to read for users with low vision",
    users: ["low_vision"],
  },
  // 1.4.4 — Resize text
  "1.4.4": {
    impact: "Text cannot be resized without loss of content, hindering users who need larger text",
    users: ["low_vision"],
  },
  // 1.4.10 — Reflow
  "1.4.10": {
    impact: "Content does not reflow at 400% zoom, requiring horizontal scrolling",
    users: ["low_vision"],
  },
  // 1.4.11 — Non-text contrast
  "1.4.11": {
    impact: "UI components or graphical objects lack sufficient contrast for users with low vision",
    users: ["low_vision"],
  },
  // 2.1.1 — Keyboard
  "2.1.1": {
    impact: "This interactive element cannot be reached or operated via keyboard, completely blocking keyboard-only users",
    users: ["keyboard_only", "motor_limited", "screen_reader"],
  },
  // 2.1.2 — No keyboard trap
  "2.1.2": {
    impact: "Keyboard focus is trapped within this element, preventing keyboard users from navigating the rest of the page",
    users: ["keyboard_only", "motor_limited", "screen_reader"],
  },
  // 2.4.1 — Bypass blocks
  "2.4.1": {
    impact: "No mechanism to bypass repeated navigation blocks, forcing keyboard users to tab through every link on every page",
    users: ["keyboard_only", "screen_reader"],
  },
  // 2.4.2 — Page titled
  "2.4.2": {
    impact: "Missing or non-descriptive page title makes it difficult to identify the page in tabs and screen reader navigation",
    users: ["screen_reader", "cognitive"],
  },
  // 2.4.3 — Focus order
  "2.4.3": {
    impact: "Focus order does not follow a logical sequence, confusing keyboard and screen reader users",
    users: ["keyboard_only", "screen_reader", "cognitive"],
  },
  // 2.4.4 — Link purpose (in context)
  "2.4.4": {
    impact: "Link text does not describe its destination, making navigation difficult for screen reader users",
    users: ["screen_reader", "cognitive"],
  },
  // 2.4.6 — Headings and labels
  "2.4.6": {
    impact: "Headings or labels do not describe the topic or purpose, hindering content navigation",
    users: ["screen_reader", "cognitive"],
  },
  // 2.4.7 — Focus visible
  "2.4.7": {
    impact: "No visible focus indicator, making it impossible for keyboard users to track their position on the page",
    users: ["keyboard_only", "low_vision"],
  },
  // 3.1.1 — Language of page
  "3.1.1": {
    impact: "Page language not specified, causing screen readers to use incorrect pronunciation",
    users: ["screen_reader"],
  },
  // 3.2.3 — Consistent navigation
  "3.2.3": {
    impact: "Navigation is inconsistent across pages, disorienting users who rely on predictable layout",
    users: ["screen_reader", "cognitive", "low_vision"],
  },
  // 3.2.4 — Consistent identification
  "3.2.4": {
    impact: "Components with the same function are identified differently, confusing users who rely on consistency",
    users: ["screen_reader", "cognitive"],
  },
  // 3.3.1 — Error identification
  "3.3.1": {
    impact: "Form errors are not clearly identified, preventing users from correcting their input",
    users: ["screen_reader", "cognitive", "low_vision"],
  },
  // 3.3.2 — Labels or instructions
  "3.3.2": {
    impact: "Form fields lack labels or instructions, making form completion difficult",
    users: ["screen_reader", "cognitive"],
  },
  // 4.1.1 — Parsing
  "4.1.1": {
    impact: "Invalid markup may cause assistive technologies to misinterpret page structure",
    users: ["screen_reader"],
  },
  // 4.1.2 — Name, role, value
  "4.1.2": {
    impact: "Custom controls lack accessible name, role, or value, making them unusable with assistive technology",
    users: ["screen_reader", "keyboard_only"],
  },
  // 4.1.3 — Status messages
  "4.1.3": {
    impact: "Status messages are not announced to screen readers, leaving users unaware of page updates",
    users: ["screen_reader"],
  },
};

// Default for unknown criteria
const DEFAULT_IMPACT = {
  impact: "This element has an accessibility issue that may affect users of assistive technology",
  users: ["screen_reader", "keyboard_only"],
};

// ---------------------------------------------------------------------------
// Rule-based analysis — for axe-core and Playwright detections
// ---------------------------------------------------------------------------

/**
 * Generate rule-based reasoning from the check type and measured values.
 */
function generateRuleBasedReasoning(checkResult: CheckResult): string {
  const raw = checkResult.raw_result as Record<string, unknown> | null;
  const measured = checkResult.measured_values ?? {};

  // axe-core results include failureSummary
  if (checkResult.detected_by === "axe_core" && raw) {
    const failureSummary = raw.failureSummary as string | undefined;
    const ruleId = raw.id as string | undefined;

    const parts: string[] = [];
    if (ruleId) parts.push(`axe-core rule "${ruleId}" failed.`);
    if (failureSummary) parts.push(failureSummary);
    if (parts.length === 0) parts.push("axe-core detected a violation.");

    // Add measured values context
    if (measured.contrast_ratio !== undefined) {
      parts.push(`Measured contrast ratio: ${measured.contrast_ratio}.`);
    }

    return parts.join(" ");
  }

  // Playwright behavioral results
  if (checkResult.detected_by === "playwright" && raw) {
    const type = raw.type as string | undefined;

    switch (type) {
      case "unreachable_interactive_element":
        return `Interactive element (${(raw.tagName as string) ?? "unknown"}) was not reached during keyboard tab sequence. ` +
          `Tab sequence covered ${measured.tab_sequence_length ?? "?"} elements in ${measured.total_tabs ?? "?"} tab presses.`;

      case "keyboard_trap":
        return `Keyboard focus is trapped within this element (${(raw.trapContext as string) ?? "unknown"} context). ` +
          `${measured.elements_in_cycle ?? "?"} elements form a focus cycle detected after ${measured.tabs_before_detected ?? "?"} tab presses.`;

      case "focus_not_visible":
        return `Element lacks a visible focus indicator. ` +
          `Focus indicator contrast: ${measured.focus_contrast ?? "not measurable"}, ` +
          `minimum required: ${measured.min_contrast ?? "3:1"}.`;

      case "no_skip_nav":
        return "Page lacks a working skip navigation link. " +
          "Keyboard users must tab through all navigation items to reach main content.";

      case "skip_nav_broken":
        return "Skip navigation link exists but does not function correctly. " +
          `Target: ${measured.skip_target ?? "unknown"}, focus moved: ${measured.focus_moved ?? "no"}.`;

      case "focus_order_mismatch":
        return `Focus order does not match visual layout. ` +
          `Visual position and tab order diverge at element index ${measured.divergence_index ?? "?"}.`;

      default:
        return `Playwright behavioral test detected: ${type ?? "unknown issue"}. ` +
          `Measured values: ${JSON.stringify(measured)}.`;
    }
  }

  // Generic fallback
  return `Detected by ${checkResult.detected_by}. ${JSON.stringify(measured)}`;
}

// ---------------------------------------------------------------------------
// LLM analysis — for Claude API detections
// ---------------------------------------------------------------------------

/**
 * Build an Analysis from Claude API evaluation results.
 * The LLM input/output are stored for transparency.
 */
function buildLlmAnalysis(
  checkResult: CheckResult,
  criterion: string,
): Analysis {
  const raw = checkResult.raw_result as Record<string, unknown> | null;
  const measured = checkResult.measured_values ?? {};

  // Extract LLM reasoning from the raw evaluation result
  const reasoning = (raw?.reasoning as string) ?? "";
  const confidence = raw?.confidence as number | undefined;
  const failureType = raw?.failure_type as string | undefined;
  const requiresHuman = raw?.requires_human_verification as boolean | undefined;

  // Build LLM input/output records for transparency
  const llmInput: LlmInput = {
    prompt: (measured.prompt_name as string) ?? "unknown",
    dom_snippet: checkResult.element_html.slice(0, 500),
    screenshot_provided: checkResult.screenshot !== undefined,
  };

  const llmOutput: LlmOutput = {
    raw_response: JSON.stringify(raw),
    model: (measured.model as string) ?? "claude-sonnet-4-6",
    tokens_used: (measured.tokens_used as number) ?? 0,
  };

  // Determine analysis method: visual if screenshot was used, semantic otherwise
  const method: AnalysisMethod = checkResult.screenshot
    ? "llm_visual"
    : "llm_semantic";

  const { impact, users } = lookupImpact(criterion);

  return {
    method,
    reasoning: reasoning || `Claude API evaluated this element for WCAG ${criterion} compliance and found a potential ${failureType ?? "issue"}.`,
    llm_input: llmInput,
    llm_output: llmOutput,
    impact_description: impact,
    affected_users: users,
  };
}

// ---------------------------------------------------------------------------
// Impact lookup
// ---------------------------------------------------------------------------

function lookupImpact(criterion: string): { impact: string; users: string[] } {
  return CRITERION_IMPACTS[criterion] ?? DEFAULT_IMPACT;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce an Analysis sub-entity from a CheckResult.
 *
 * Routes by `detected_by`:
 * - `axe_core` / `playwright` → rule-based analysis
 * - `claude_api` → LLM analysis with stored input/output
 * - `manual` → rule-based with generic reasoning
 */
export function analyze(checkResult: CheckResult): Analysis {
  const criterion = checkResult.wcag_criterion;
  const { impact, users } = lookupImpact(criterion);

  switch (checkResult.detected_by) {
    case "axe_core":
    case "playwright":
      return {
        method: "rule_based",
        reasoning: generateRuleBasedReasoning(checkResult),
        llm_input: null,
        llm_output: null,
        impact_description: impact,
        affected_users: users,
      };

    case "claude_api":
      return buildLlmAnalysis(checkResult, criterion);

    case "manual":
      return {
        method: "human",
        reasoning: generateRuleBasedReasoning(checkResult),
        llm_input: null,
        llm_output: null,
        impact_description: impact,
        affected_users: users,
      };
  }
}

/**
 * Analyze a batch of CheckResults.
 * Errors on individual results are logged and produce a fallback analysis.
 */
export function analyzeBatch(checkResults: CheckResult[]): Analysis[] {
  return checkResults.map((cr) => {
    try {
      return analyze(cr);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[analyzer] Failed to analyze ${cr.element_selector}: ${msg}`);
      const { impact, users } = lookupImpact(cr.wcag_criterion);
      return {
        method: "rule_based" as AnalysisMethod,
        reasoning: `Analysis failed: ${msg}`,
        llm_input: null,
        llm_output: null,
        impact_description: impact,
        affected_users: users,
      };
    }
  });
}
