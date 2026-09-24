import type { CheckResult } from "../../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Data collected for each link for duplicate-link detection */
export interface LinkInfo {
  /** CSS selector for the link element */
  selector: string;
  /** Outer HTML of the <a> element */
  html: string;
  /** href attribute value */
  href: string;
  /** Accessible name: aria-label if present, else visible text */
  accessibleName: string;
  /** Visible text content of the link (tags stripped) */
  visibleText: string;
}

// ---------------------------------------------------------------------------
// DOM parsing helpers
// ---------------------------------------------------------------------------

/** Extract an attribute value from an attribute string */
function getAttr(attrStr: string, attr: string): string | null {
  const re = new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = attrStr.match(re);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/** Strip HTML tags from a string */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Build a CSS selector for a link */
function buildSelector(attrStr: string, index: number): string {
  const id = getAttr(attrStr, "id");
  if (id) return `a#${id}`;

  const className = getAttr(attrStr, "class");
  if (className) {
    const classes = className.split(/\s+/).filter(Boolean).join(".");
    return `a.${classes}`;
  }

  const href = getAttr(attrStr, "href");
  if (href) {
    const safeHref = href.replace(/"/g, '\\"').slice(0, 80);
    return `a[href="${safeHref}"]`;
  }

  return `a:nth-of-type(${index + 1})`;
}

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a URL for duplicate-link comparison.
 *
 * When a page URL is supplied, relative hrefs are resolved to absolute form
 * before comparison so that "/court-forms" and
 * "https://www.lakewoodcourtoh.gov/court-forms" are treated as the same
 * destination.
 *
 * Normalization steps applied to absolute URLs:
 *   - Hostname lowercased
 *   - Default port removed (443 for https, 80 for http)
 *   - Fragment (#anchor) stripped
 *   - Trailing slash removed (except bare "/")
 *
 * Cross-origin URLs are never merged — only same-origin relative/absolute
 * pairs that resolve to the same canonical path are de-duped.
 * Query strings are preserved as distinct (tracking params are not stripped).
 */
function normalizeUrl(href: string, pageUrl?: string): string {
  const raw = href.trim();

  // Attempt to resolve and fully normalise via the URL constructor.
  try {
    const base = pageUrl ? new URL(pageUrl) : undefined;
    const parsed = base ? new URL(raw, base) : new URL(raw);

    // Lowercase hostname; remove default ports.
    parsed.hostname = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80")
    ) {
      parsed.port = "";
    }

    // Strip fragment.
    parsed.hash = "";

    // Strip trailing slash (except bare "/").
    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    return parsed.href;
  } catch {
    // Fall back to simple string normalisation for non-parseable values
    // (e.g. mailto:, javascript:, data:).
    let url = raw.toLowerCase();
    const hashIdx = url.indexOf("#");
    if (hashIdx !== -1) url = url.slice(0, hashIdx);
    if (url.length > 1 && url.endsWith("/")) url = url.slice(0, -1);
    return url;
  }
}

// ---------------------------------------------------------------------------
// Link collection
// ---------------------------------------------------------------------------

/**
 * Collect all links from a page's DOM string for duplicate-link analysis.
 * Extracts href, visible text, and aria-label for each link.
 */
export function collectLinksForDuplication(dom: string): LinkInfo[] {
  const links: LinkInfo[] = [];
  const linkRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(dom)) !== null) {
    const fullMatch = match[0];
    const attrs = match[1];
    const innerContent = match[2];

    const href = getAttr(attrs, "href");

    // Skip links with empty href or href="#"
    if (!href || href === "#") continue;

    const ariaLabel = getAttr(attrs, "aria-label");
    const visibleText = stripTags(innerContent);

    // Accessible name: aria-label if present, otherwise visible text
    const accessibleName = ariaLabel?.trim() || visibleText;

    // Skip links with no accessible name
    if (!accessibleName) continue;

    const selector = buildSelector(attrs, links.length);

    links.push({
      selector,
      html: fullMatch,
      href,
      accessibleName,
      visibleText,
    });
  }

  return links;
}

// ---------------------------------------------------------------------------
// Main check function
// ---------------------------------------------------------------------------

/**
 * Detect multiple links with identical accessible names pointing to different URLs.
 *
 * Groups links by case-insensitive accessible name. For each group with 2+ links,
 * checks if they point to different normalized URLs. If so, creates one CheckResult
 * per group representing the duplicate pattern.
 *
 * WCAG 2.4.4 requires link text (combined with context) to identify the link purpose.
 * Identical link text pointing to different destinations is confusing for all users,
 * especially screen reader users who navigate by link list.
 *
 * @param dom     Serialized page DOM string.
 * @param pageUrl The URL of the page being scanned.  When supplied, relative
 *                hrefs are resolved to absolute form before comparison, so
 *                "/court-forms" and "https://example.com/court-forms" are
 *                treated as the same destination and do not produce a finding.
 */
export function runDuplicateLinkChecks(dom: string, pageUrl?: string): CheckResult[] {
  const links = collectLinksForDuplication(dom);

  // Group by accessible name (case-insensitive, trimmed)
  const groups = new Map<string, LinkInfo[]>();
  for (const link of links) {
    const key = link.accessibleName.toLowerCase().trim();
    const group = groups.get(key);
    if (group) {
      group.push(link);
    } else {
      groups.set(key, [link]);
    }
  }

  const results: CheckResult[] = [];

  for (const [, group] of groups) {
    // Only care about groups with 2+ links
    if (group.length < 2) continue;

    // Collect distinct normalized URLs
    const distinctUrls = new Set<string>();
    for (const link of group) {
      distinctUrls.add(normalizeUrl(link.href, pageUrl));
    }

    // Same name + same URL = not a problem
    if (distinctUrls.size < 2) continue;

    // Different URLs with same accessible name → violation
    const sampleUrls = Array.from(distinctUrls).slice(0, 3);
    const firstLink = group[0];

    results.push({
      element_selector: firstLink.selector,
      element_html: firstLink.html,
      wcag_criterion: "2.4.4",
      detected_by: "playwright",
      raw_result: {
        group_links: group.map((l) => ({ selector: l.selector, href: l.href })),
      },
      measured_values: {
        failure_type: "duplicate_link_text",
        duplicate_count: group.length,
        distinct_urls: distinctUrls.size,
        accessible_name: firstLink.accessibleName,
        sample_urls: sampleUrls,
      },
      aria_attributes: {},
    });
  }

  return results;
}
