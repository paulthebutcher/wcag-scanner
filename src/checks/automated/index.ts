import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "playwright";
import type { Result as AxeResult, NodeResult } from "axe-core";
import type { CheckResult, CriterionResult, DetectedBy } from "../../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AxeCheckOptions {
  /** WCAG tags to include. Defaults to ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] */
  tags?: string[];
  /** Rules to disable */
  disableRules?: string[];
}

export interface AxeCheckOutput {
  /** One CheckResult per violation node */
  violations: CheckResult[];
  /** CheckResults for incomplete (needs_review) nodes */
  incomplete: CheckResult[];
  /** Criterion-level pass results */
  passes: CriterionResult[];
  /** Criterion-level not_applicable results (no matching elements on page) */
  inapplicable: CriterionResult[];
}

// ---------------------------------------------------------------------------
// WCAG tag parsing (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Extract WCAG criterion codes from axe-core tags.
 *
 * axe tags look like: ["wcag2a", "wcag111", "best-practice", "cat.text-alternatives"]
 * We want to extract "1.1.1" from "wcag111", "2.4.7" from "wcag247", etc.
 *
 * Pattern: "wcag" followed by 3+ digits. First digit = principle,
 * second digit(s) = guideline, last digit(s) = success criterion.
 * Examples: wcag111 → 1.1.1, wcag143 → 1.4.3, wcag1410 → 1.4.10, wcag247 → 2.4.7
 */
export function extractWcagCriteria(tags: string[]): string[] {
  const criteria: string[] = [];

  for (const tag of tags) {
    // Match "wcag" followed by digits (at least 3), but not "wcag2a", "wcag21a", etc.
    const match = tag.match(/^wcag(\d{3,})$/);
    if (!match) continue;

    const digits = match[1];
    // First digit is the principle (1-4)
    const principle = digits[0];

    // For the remaining digits, we need to split into guideline and criterion.
    // WCAG criteria follow: P.G.C where P=1 digit, G=1-2 digits, C=1-2 digits
    // In the tag encoding, they're concatenated: PGC
    // Most are 3 digits (P.G.C), some are 4+ digits (P.G.CC or P.GG.C)
    const rest = digits.slice(1);

    if (rest.length === 2) {
      // Standard 3-digit tag: e.g. "111" → 1.1.1
      criteria.push(`${principle}.${rest[0]}.${rest[1]}`);
    } else if (rest.length === 3) {
      // Could be P.G.CC (e.g. "1410" → 1.4.10) or P.GG.C (e.g. none in WCAG 2.1)
      // WCAG guidelines go up to 4.x, so guideline is always 1 digit
      // Success criteria can be 1-2 digits
      criteria.push(`${principle}.${rest[0]}.${rest.slice(1)}`);
    } else if (rest.length === 4) {
      // P.G.CCC or P.GG.CC — guideline is 1 digit, criterion is 3 digits
      criteria.push(`${principle}.${rest[0]}.${rest.slice(1)}`);
    }
  }

  return criteria;
}

/**
 * Get the first WCAG criterion from axe tags, or a fallback based on the rule ID.
 */
export function getWcagCriterion(tags: string[]): string {
  const criteria = extractWcagCriteria(tags);
  return criteria[0] ?? "unknown";
}

// ---------------------------------------------------------------------------
// Node → CheckResult mapping (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Convert a single axe NodeResult within a violation/incomplete rule to a CheckResult.
 */
export function nodeToCheckResult(
  node: NodeResult,
  rule: AxeResult,
  detectedBy: DetectedBy = "axe_core",
): CheckResult {
  const criterion = getWcagCriterion(rule.tags);

  // Extract ARIA attributes from the node HTML (basic extraction)
  const ariaAttrs: Record<string, string> = {};
  const ariaMatches = node.html.matchAll(/\b(aria-[\w-]+)\s*=\s*["']([^"']*)["']/gi);
  for (const m of ariaMatches) {
    ariaAttrs[m[1].toLowerCase()] = m[2];
  }
  // Also capture role attribute
  const roleMatch = node.html.match(/\brole\s*=\s*["']([^"']*)["']/i);
  if (roleMatch) {
    ariaAttrs["role"] = roleMatch[1];
  }

  return {
    element_selector: Array.isArray(node.target[0])
      ? node.target[0].join(" ")
      : String(node.target[0]),
    element_html: node.html,
    wcag_criterion: criterion,
    detected_by: detectedBy,
    raw_result: {
      impact: node.impact ?? rule.impact ?? undefined,
      ruleId: rule.id,
      help: rule.help,
      helpUrl: rule.helpUrl,
      failureSummary: node.failureSummary ?? "",
      tags: rule.tags,
    },
    aria_attributes: Object.keys(ariaAttrs).length > 0 ? ariaAttrs : undefined,
  };
}

// ---------------------------------------------------------------------------
// Pass results mapping (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Convert axe passes to CriterionResult entries.
 * Groups by WCAG criterion — one CriterionResult per unique criterion.
 */
export function passesToCriterionResults(
  passes: AxeResult[],
  scanSessionId: string,
): CriterionResult[] {
  const criterionMap = new Map<string, { rules: string[]; nodeCount: number }>();

  for (const rule of passes) {
    const criterion = getWcagCriterion(rule.tags);
    if (criterion === "unknown") continue;

    const existing = criterionMap.get(criterion);
    if (existing) {
      existing.rules.push(rule.id);
      existing.nodeCount += rule.nodes.length;
    } else {
      criterionMap.set(criterion, {
        rules: [rule.id],
        nodeCount: rule.nodes.length,
      });
    }
  }

  const results: CriterionResult[] = [];
  for (const [criterion, data] of criterionMap) {
    results.push({
      scan_session_id: scanSessionId,
      wcag_criterion: criterion,
      status: "passed",
      tested_by: "axe_core",
      evidence_summary: `Passed ${data.rules.length} axe-core rule(s): ${data.rules.join(", ")} (${data.nodeCount} elements tested)`,
      finding_ids: [],
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Inapplicable results mapping (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Convert axe inapplicable rules to CriterionResult entries with status "not_applicable".
 * These are rules where no matching elements were found on the page.
 * Groups by WCAG criterion — one CriterionResult per unique criterion.
 */
export function inapplicableToCriterionResults(
  inapplicable: AxeResult[],
  scanSessionId: string,
): CriterionResult[] {
  const criterionMap = new Map<string, { rules: string[] }>();

  for (const rule of inapplicable) {
    const criterion = getWcagCriterion(rule.tags);
    if (criterion === "unknown") continue;

    const existing = criterionMap.get(criterion);
    if (existing) {
      existing.rules.push(rule.id);
    } else {
      criterionMap.set(criterion, { rules: [rule.id] });
    }
  }

  const results: CriterionResult[] = [];
  for (const [criterion, data] of criterionMap) {
    results.push({
      scan_session_id: scanSessionId,
      wcag_criterion: criterion,
      status: "not_applicable",
      tested_by: "axe_core",
      evidence_summary: `No applicable elements for ${data.rules.length} axe-core rule(s): ${data.rules.join(", ")}`,
      finding_ids: [],
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

const DEFAULT_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/**
 * Run axe-core against a Playwright Page and return structured results.
 *
 * - Each axe violation node becomes one CheckResult
 * - Each axe incomplete node becomes one CheckResult (for needs_review routing)
 * - axe passes are grouped by criterion into CriterionResult entries
 */
export async function runAxeChecks(
  page: Page,
  scanSessionId: string,
  options?: AxeCheckOptions,
): Promise<AxeCheckOutput> {
  const tags = options?.tags ?? DEFAULT_TAGS;

  let builder = new AxeBuilder({ page }).withTags(tags);

  if (options?.disableRules) {
    builder = builder.disableRules(options.disableRules);
  }

  const axeResults = await builder.analyze();

  // Map violations: 1 rule × N nodes → N CheckResults
  const violations: CheckResult[] = [];
  for (const rule of axeResults.violations) {
    for (const node of rule.nodes) {
      violations.push(nodeToCheckResult(node, rule, "axe_core"));
    }
  }

  // Map incomplete: same structure as violations, but flagged for review
  const incomplete: CheckResult[] = [];
  for (const rule of axeResults.incomplete) {
    for (const node of rule.nodes) {
      incomplete.push(nodeToCheckResult(node, rule, "axe_core"));
    }
  }

  // Map passes: group by criterion
  const passes = passesToCriterionResults(axeResults.passes, scanSessionId);

  // Map inapplicable: group by criterion as not_applicable
  const inapplicable = inapplicableToCriterionResults(
    axeResults.inapplicable,
    scanSessionId,
  );

  return { violations, incomplete, passes, inapplicable };
}
