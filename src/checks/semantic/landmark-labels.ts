/**
 * Landmark label checks — detects unlabeled or duplicate navigation landmarks.
 *
 * WCAG criteria:
 * - 1.3.1 Info and Relationships (nav landmarks must be distinguishable)
 * - 2.4.1 Bypass Blocks (nav landmarks help users skip content)
 *
 * Failure types:
 * - duplicate_nav_landmark — multiple navs with no/same label
 * - unlabeled_nav_landmark — single nav with no label
 */

import type { CheckResult } from "../../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NavElement {
  selector: string;
  html: string;
  tagName: string;
  ariaLabel: string | null;
  ariaLabelledby: string | null;
  role: string | null;
}

// ---------------------------------------------------------------------------
// DOM extraction
// ---------------------------------------------------------------------------

/**
 * Extract an attribute value from an attribute string.
 * Handles double-quoted, single-quoted, and unquoted values.
 */
function getAttr(attrStr: string, attr: string): string | null {
  const re = new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = attrStr.match(re);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/** Build a CSS selector from an element's attributes. */
function buildSelector(tagName: string, attrStr: string, index: number): string {
  const id = getAttr(attrStr, "id");
  if (id) return `${tagName}#${id}`;
  const cls = getAttr(attrStr, "class");
  if (cls) {
    const classes = cls.trim().split(/\s+/).filter(Boolean).slice(0, 3).join(".");
    return `${tagName}.${classes}`;
  }
  return `${tagName}:nth-of-type(${index + 1})`;
}

/**
 * Extract all navigation landmark elements from serialized DOM.
 * Finds both <nav> elements and elements with role="navigation".
 */
export function extractNavElements(dom: string): NavElement[] {
  const navs: NavElement[] = [];

  // Match <nav ...> ... </nav>
  const navRegex = /<nav\b([^>]*)>([\s\S]*?)<\/nav>/gi;
  let navIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = navRegex.exec(dom)) !== null) {
    const attrStr = match[1];
    const selector = buildSelector("nav", attrStr, navIndex);
    navs.push({
      selector,
      html: match[0].length > 200 ? match[0].slice(0, 200) + "..." : match[0],
      tagName: "nav",
      ariaLabel: getAttr(attrStr, "aria-label"),
      ariaLabelledby: getAttr(attrStr, "aria-labelledby"),
      role: getAttr(attrStr, "role"),
    });
    navIndex++;
  }

  // Match elements with role="navigation" that are NOT <nav>
  const roleNavRegex = /<(?!nav\b)(\w+)\b([^>]*role\s*=\s*["']navigation["'][^>]*)>/gi;
  let roleIndex = 0;
  while ((match = roleNavRegex.exec(dom)) !== null) {
    const tagName = match[1].toLowerCase();
    const attrStr = match[2];
    // Skip if this element is already captured as a <nav>
    const selector = buildSelector(tagName, attrStr, roleIndex);
    navs.push({
      selector,
      html: match[0].length > 200 ? match[0].slice(0, 200) + "..." : match[0],
      tagName,
      ariaLabel: getAttr(attrStr, "aria-label"),
      ariaLabelledby: getAttr(attrStr, "aria-labelledby"),
      role: "navigation",
    });
    roleIndex++;
  }

  return navs;
}

// ---------------------------------------------------------------------------
// Check logic
// ---------------------------------------------------------------------------

/** Check if a nav element has an accessible label. */
function hasLabel(nav: NavElement): boolean {
  return (nav.ariaLabel !== null && nav.ariaLabel.trim().length > 0)
    || (nav.ariaLabelledby !== null && nav.ariaLabelledby.trim().length > 0);
}

/**
 * Run landmark label checks on a serialized DOM string.
 *
 * Returns CheckResult[] for:
 * - Multiple nav elements where any lack labels → duplicate_nav_landmark
 * - Single nav with no label → unlabeled_nav_landmark
 */
export function runLandmarkLabelChecks(dom: string): CheckResult[] {
  const navs = extractNavElements(dom);

  if (navs.length === 0) return [];

  const results: CheckResult[] = [];
  const unlabeled = navs.filter(n => !hasLabel(n));

  if (navs.length > 1) {
    // Multiple navs — check for duplicate/unlabeled landmarks
    // Also flag if labels are identical (duplicates)
    const labels = navs
      .filter(n => hasLabel(n))
      .map(n => (n.ariaLabel ?? n.ariaLabelledby ?? "").trim().toLowerCase());
    const hasDuplicateLabels = labels.length !== new Set(labels).size;

    if (unlabeled.length > 0 || hasDuplicateLabels) {
      // Report one finding per unlabeled nav
      for (const nav of unlabeled) {
        results.push({
          element_selector: nav.selector,
          element_html: nav.html,
          wcag_criterion: "1.3.1",
          detected_by: "playwright",
          raw_result: {
            type: "duplicate_nav_landmark",
            total_navs: navs.length,
            unlabeled_count: unlabeled.length,
            has_duplicate_labels: hasDuplicateLabels,
          },
          measured_values: {
            failure_type: "duplicate_nav_landmark",
            total_navs: navs.length,
            unlabeled_count: unlabeled.length,
          },
          aria_attributes: {
            "aria-label": nav.ariaLabel ?? "",
            "aria-labelledby": nav.ariaLabelledby ?? "",
          },
        });
      }

      // Also flag duplicate labels if any
      if (hasDuplicateLabels) {
        const dupLabels = labels.filter((l, i) => labels.indexOf(l) !== i);
        const dupsWithLabel = navs.filter(n =>
          dupLabels.includes((n.ariaLabel ?? n.ariaLabelledby ?? "").trim().toLowerCase()),
        );
        for (const nav of dupsWithLabel) {
          // Only add if not already in results
          if (!results.some(r => r.element_selector === nav.selector)) {
            results.push({
              element_selector: nav.selector,
              element_html: nav.html,
              wcag_criterion: "1.3.1",
              detected_by: "playwright",
              raw_result: {
                type: "duplicate_nav_landmark",
                total_navs: navs.length,
                duplicate_label: nav.ariaLabel ?? nav.ariaLabelledby ?? "",
              },
              measured_values: {
                failure_type: "duplicate_nav_landmark",
                total_navs: navs.length,
                duplicate_label: nav.ariaLabel ?? nav.ariaLabelledby ?? "",
              },
              aria_attributes: {
                "aria-label": nav.ariaLabel ?? "",
                "aria-labelledby": nav.ariaLabelledby ?? "",
              },
            });
          }
        }
      }
    }
  } else if (navs.length === 1 && unlabeled.length === 1) {
    // Single nav with no label
    const nav = navs[0];
    results.push({
      element_selector: nav.selector,
      element_html: nav.html,
      wcag_criterion: "1.3.1",
      detected_by: "playwright",
      raw_result: {
        type: "unlabeled_nav_landmark",
        total_navs: 1,
      },
      measured_values: {
        failure_type: "unlabeled_nav_landmark",
        total_navs: 1,
      },
      aria_attributes: {
        "aria-label": "",
        "aria-labelledby": "",
      },
    });
  }

  return results;
}
