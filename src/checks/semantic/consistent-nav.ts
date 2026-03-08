import type { CheckResult, PageSnapshot } from "../../types.js";
import type { PromptRunner } from "../../core/prompt-runner.js";
import {
  consistentNavigation,
  buildConsistentNavUserPrompt,
} from "../../prompts/element-evaluation.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Navigation data extracted from a single page */
export interface PageNavData {
  /** Page URL */
  url: string;
  /** Ordered list of nav item labels */
  navItems: string[];
  /** Raw nav HTML for evidence */
  navHtml: string;
  /** CSS selector for the nav element */
  navSelector: string;
}

/** Result from Claude's evaluation of navigation consistency */
export interface ConsistentNavEvaluation {
  verdict: "pass" | "fail" | "needs_review";
  confidence: number;
  reasoning: string;
  wcag_criterion: string;
  failure_type: string | null;
  suggestion: string | null;
  affected_users: string[];
  requires_human_verification: boolean;
}

/** All failure modes for consistent navigation */
export const CONSISTENT_NAV_FAILURE_TYPES = [
  "order_changed",
  "items_missing",
  "labels_inconsistent",
  "nav_structure_changed",
] as const;

export type ConsistentNavFailureType = (typeof CONSISTENT_NAV_FAILURE_TYPES)[number];

// ---------------------------------------------------------------------------
// Navigation extraction from DOM
// ---------------------------------------------------------------------------

/**
 * Extract navigation elements from a page's DOM string.
 * Looks for <nav> elements, elements with role="navigation",
 * and common Webflow nav patterns.
 */
export function extractNavData(dom: string, url: string): PageNavData[] {
  const navs: PageNavData[] = [];

  // Match <nav ...>...</nav> elements
  const navRegex = /<nav\b([^>]*)>([\s\S]*?)<\/nav>/gi;
  let match: RegExpExecArray | null;
  let navIndex = 0;

  while ((match = navRegex.exec(dom)) !== null) {
    const attrs = match[1];
    const innerContent = match[2];
    const selector = buildNavSelector(attrs, navIndex);

    // Extract nav items (links within the nav)
    const navItems = extractNavItems(innerContent);

    if (navItems.length > 0) {
      navs.push({
        url,
        navItems,
        navHtml: match[0],
        navSelector: selector,
      });
    }

    navIndex++;
  }

  // Also check for role="navigation" on non-nav elements
  const roleNavRegex = /<(\w+)\b([^>]*role\s*=\s*["']navigation["'][^>]*)>([\s\S]*?)<\/\1>/gi;
  while ((match = roleNavRegex.exec(dom)) !== null) {
    const tag = match[1].toLowerCase();
    if (tag === "nav") continue; // Already captured

    const attrs = match[2];
    const innerContent = match[3];
    const selector = buildNavSelector(attrs, navIndex);

    const navItems = extractNavItems(innerContent);

    if (navItems.length > 0) {
      navs.push({
        url,
        navItems,
        navHtml: match[0],
        navSelector: selector,
      });
    }

    navIndex++;
  }

  return navs;
}

/**
 * Extract navigation item labels from nav inner HTML.
 * Looks for <a> elements and extracts their visible text.
 */
function extractNavItems(navHtml: string): string[] {
  const items: string[] = [];
  const linkRegex = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(navHtml)) !== null) {
    const text = stripTags(match[1]).trim();
    if (text.length > 0) {
      items.push(text);
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Navigation comparison helpers
// ---------------------------------------------------------------------------

/**
 * Check if two nav item lists represent the same navigation
 * (for matching navs across pages). Uses a similarity threshold
 * to account for current-page styling or minor differences.
 */
export function isMatchingNav(
  items1: string[],
  items2: string[],
  threshold = 0.5,
): boolean {
  if (items1.length === 0 || items2.length === 0) return false;

  // Count shared items (case-insensitive)
  const set1 = new Set(items1.map((i) => i.toLowerCase()));
  const set2 = new Set(items2.map((i) => i.toLowerCase()));
  let shared = 0;
  for (const item of set1) {
    if (set2.has(item)) shared++;
  }

  const maxLen = Math.max(set1.size, set2.size);
  return shared / maxLen >= threshold;
}

/**
 * Group navigations across pages by matching content.
 * Returns groups where each group contains the same logical navigation
 * as it appears on different pages.
 */
export function groupNavsAcrossPages(
  allNavs: PageNavData[],
): PageNavData[][] {
  const groups: PageNavData[][] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < allNavs.length; i++) {
    if (assigned.has(i)) continue;

    const group = [allNavs[i]];
    assigned.add(i);

    for (let j = i + 1; j < allNavs.length; j++) {
      if (assigned.has(j)) continue;

      // Don't match navs from the same page
      if (allNavs[j].url === allNavs[i].url) continue;

      if (isMatchingNav(allNavs[i].navItems, allNavs[j].navItems)) {
        group.push(allNavs[j]);
        assigned.add(j);
      }
    }

    // Only include groups that appear on multiple pages
    if (group.length > 1) {
      groups.push(group);
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Main check function
// ---------------------------------------------------------------------------

/**
 * Run consistent navigation check across all pages in a scan.
 *
 * This runs ONCE per scan (not per page) after all pages are crawled.
 *
 * 1. Extracts nav elements from each PageSnapshot.
 * 2. Groups matching navs across pages.
 * 3. Calls Prompt 5 with all pages' nav data for each nav group.
 * 4. Detects: order_changed, items_missing, labels_inconsistent, nav_structure_changed.
 * 5. Correctly handles: current page styled differently, contextual sub-navigation.
 */
export async function runConsistentNavChecks(
  snapshots: PageSnapshot[],
  runner: PromptRunner,
): Promise<CheckResult[]> {
  if (snapshots.length < 2) {
    // Need at least 2 pages to compare navigation consistency
    return [];
  }

  // 1. Extract nav data from each page
  const allNavs: PageNavData[] = [];
  for (const snapshot of snapshots) {
    const pageNavs = extractNavData(snapshot.full_dom, snapshot.url);
    allNavs.push(...pageNavs);
  }

  if (allNavs.length === 0) {
    return [];
  }

  // 2. Group matching navs across pages
  const navGroups = groupNavsAcrossPages(allNavs);

  if (navGroups.length === 0) {
    // No navigation appears on multiple pages — nothing to compare
    return [];
  }

  // 3. For each nav group, call Prompt 5
  const results: CheckResult[] = [];

  for (const group of navGroups) {
    const pagesData = group.map((nav) => ({
      url: nav.url,
      navItems: nav.navItems,
    }));

    const userMessage = buildConsistentNavUserPrompt({ pages: pagesData });

    const evalResult = await runner.runPrompt<ConsistentNavEvaluation>({
      template: consistentNavigation,
      userMessage,
    });

    if (!evalResult.success && !evalResult.data) {
      results.push({
        element_selector: group[0].navSelector,
        element_html: group[0].navHtml.slice(0, 500),
        wcag_criterion: "3.2.3",
        detected_by: "claude_api",
        raw_result: {
          verdict: "needs_review",
          confidence: 0,
          reasoning: `API evaluation failed: ${evalResult.error}`,
          wcag_criterion: "3.2.3",
          failure_type: null,
          suggestion: null,
          affected_users: ["screen_reader", "cognitive"],
          requires_human_verification: true,
        },
        measured_values: {
          pages_compared: group.length,
          page_urls: group.map((n) => n.url),
        },
      });
      continue;
    }

    const evaluation = evalResult.data!;

    if (evaluation.verdict === "fail" || evaluation.verdict === "needs_review") {
      results.push({
        element_selector: group[0].navSelector,
        element_html: group[0].navHtml.slice(0, 500),
        wcag_criterion: "3.2.3",
        detected_by: "claude_api",
        raw_result: evaluation,
        measured_values: {
          failure_type: evaluation.failure_type,
          confidence: evaluation.confidence,
          pages_compared: group.length,
          page_urls: group.map((n) => n.url),
          nav_items_per_page: group.map((n) => ({
            url: n.url,
            items: n.navItems,
          })),
        },
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// DOM parsing helpers
// ---------------------------------------------------------------------------

/** Extract an attribute value from an attribute string */
function extractAttr(attrStr: string, attr: string): string | null {
  const regex = new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = attrStr.match(regex);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/** Build a CSS selector for a nav element */
function buildNavSelector(attrStr: string, index: number): string {
  const id = extractAttr(attrStr, "id");
  if (id) return `nav#${id}`;

  const ariaLabel = extractAttr(attrStr, "aria-label");
  if (ariaLabel) {
    const safeLabel = ariaLabel.replace(/"/g, '\\"');
    return `nav[aria-label="${safeLabel}"]`;
  }

  const className = extractAttr(attrStr, "class");
  if (className) {
    const classes = className.split(/\s+/).filter(Boolean).join(".");
    return `nav.${classes}`;
  }

  return `nav:nth-of-type(${index + 1})`;
}

/** Strip HTML tags from a string */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}
