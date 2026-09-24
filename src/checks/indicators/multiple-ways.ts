import type { CheckResult, PageSnapshot } from "../../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A navigation method detected on a page */
export interface NavigationMethod {
  type: NavigationType;
  selector: string;
  html: string;
}

export type NavigationType =
  | "nav_menu"
  | "search"
  | "sitemap_link"
  | "table_of_contents"
  | "breadcrumbs";

// ---------------------------------------------------------------------------
// Navigation method detection
// ---------------------------------------------------------------------------

/**
 * Detect navigation menus: <nav>, role="navigation", common nav class patterns.
 */
export function detectNavMenu(dom: string): NavigationMethod[] {
  const results: NavigationMethod[] = [];
  const seen = new Set<string>();

  // <nav> elements
  const navPattern = /<nav\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = navPattern.exec(dom)) !== null) {
    const tag = match[0];
    const selector = extractSelector(tag) || "nav";
    if (!seen.has(selector)) {
      seen.add(selector);
      results.push({ type: "nav_menu", selector, html: truncate(tag, 200) });
    }
  }

  // role="navigation"
  const roleNavPattern = /role\s*=\s*"navigation"[^>]*/gi;
  while ((match = roleNavPattern.exec(dom)) !== null) {
    const ctx = extractContext(dom, match.index, 200);
    const selector = extractSelector(ctx);
    if (!seen.has(selector)) {
      seen.add(selector);
      results.push({ type: "nav_menu", selector, html: truncate(ctx, 200) });
    }
  }

  // Webflow navbar: <div class="w-nav …"> (no semantic <nav> or role by default)
  const wNavPattern = /class\s*=\s*"[^"]*\bw-nav\b[^"]*"/gi;
  while ((match = wNavPattern.exec(dom)) !== null) {
    const ctx = extractContext(dom, match.index, 200);
    const selector = extractSelector(ctx);
    if (!seen.has(selector)) {
      seen.add(selector);
      results.push({ type: "nav_menu", selector, html: truncate(ctx, 200) });
    }
  }

  return results;
}

/**
 * Detect search functionality: <input type="search">, role="search",
 * search-related classes, or search form patterns.
 */
export function detectSearch(dom: string): NavigationMethod[] {
  const results: NavigationMethod[] = [];
  const seen = new Set<string>();

  const patterns = [
    /<input\b[^>]*type\s*=\s*"search"[^>]*>/gi,
    /role\s*=\s*"search"[^>]*/gi,
    /<form\b[^>]*class\s*=\s*"[^"]*\bsearch\b[^"]*"[^>]*>/gi,
    /<input\b[^>]*(?:name|id|placeholder)\s*=\s*"[^"]*search[^"]*"[^>]*>/gi,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(dom)) !== null) {
      const ctx = extractContext(dom, match.index, 200);
      const selector = extractSelector(ctx);
      if (!seen.has(selector)) {
        seen.add(selector);
        results.push({ type: "search", selector, html: truncate(ctx, 200) });
      }
    }
  }

  return results;
}

/**
 * Detect sitemap links: links containing "sitemap" in text or href.
 */
export function detectSitemapLink(dom: string): NavigationMethod[] {
  const results: NavigationMethod[] = [];
  const seen = new Set<string>();

  // Links with "sitemap" in text or href
  const sitemapPattern = /<a\b[^>]*>[^<]*sitemap[^<]*<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = sitemapPattern.exec(dom)) !== null) {
    const tag = match[0];
    const selector = extractSelector(tag);
    if (!seen.has(selector)) {
      seen.add(selector);
      results.push({ type: "sitemap_link", selector, html: truncate(tag, 200) });
    }
  }

  // Links with href containing "sitemap"
  const hrefPattern = /<a\b[^>]*href\s*=\s*"[^"]*sitemap[^"]*"[^>]*>[^<]*<\/a>/gi;
  while ((match = hrefPattern.exec(dom)) !== null) {
    const tag = match[0];
    const selector = extractSelector(tag);
    if (!seen.has(selector)) {
      seen.add(selector);
      results.push({ type: "sitemap_link", selector, html: truncate(tag, 200) });
    }
  }

  return results;
}

/**
 * Detect table of contents: elements with "toc" or "table-of-contents" patterns.
 */
export function detectTableOfContents(dom: string): NavigationMethod[] {
  const results: NavigationMethod[] = [];
  const seen = new Set<string>();

  const patterns = [
    /class\s*=\s*"[^"]*\b(toc|table-of-contents|tableofcontents|page-toc|article-toc)\b[^"]*"/gi,
    /id\s*=\s*"[^"]*\b(toc|table-of-contents|tableofcontents)\b[^"]*"/gi,
    /aria-label\s*=\s*"[^"]*table of contents[^"]*"/gi,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(dom)) !== null) {
      const ctx = extractContext(dom, match.index, 200);
      const selector = extractSelector(ctx);
      if (!seen.has(selector)) {
        seen.add(selector);
        results.push({ type: "table_of_contents", selector, html: truncate(ctx, 200) });
      }
    }
  }

  return results;
}

/**
 * Detect breadcrumb navigation.
 */
export function detectBreadcrumbs(dom: string): NavigationMethod[] {
  const results: NavigationMethod[] = [];
  const seen = new Set<string>();

  const patterns = [
    /class\s*=\s*"[^"]*\b(breadcrumb|breadcrumbs)\b[^"]*"/gi,
    /aria-label\s*=\s*"[^"]*breadcrumb[^"]*"/gi,
    /role\s*=\s*"[^"]*\b(breadcrumb)\b[^"]*"/gi,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(dom)) !== null) {
      const ctx = extractContext(dom, match.index, 200);
      const selector = extractSelector(ctx);
      if (!seen.has(selector)) {
        seen.add(selector);
        results.push({ type: "breadcrumbs", selector, html: truncate(ctx, 200) });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main check function: 2.4.5 Multiple Ways
// ---------------------------------------------------------------------------

/**
 * Detect all navigation methods on a page.
 */
export function detectNavigationMethods(dom: string): NavigationMethod[] {
  return [
    ...detectNavMenu(dom),
    ...detectSearch(dom),
    ...detectSitemapLink(dom),
    ...detectTableOfContents(dom),
    ...detectBreadcrumbs(dom),
  ];
}

/**
 * Check for WCAG 2.4.5 (Multiple Ways).
 *
 * Pattern-matches for navigation methods: nav menu, search, sitemap,
 * table of contents, breadcrumbs.
 *
 * Auto-pass: If 2+ distinct navigation method types are detected.
 * Flag: If fewer than 2 types found, flags for human review.
 */
export function checkMultipleWays(snapshot: PageSnapshot): CheckResult[] {
  const dom = snapshot.full_dom;
  const methods = detectNavigationMethods(dom);

  // Count distinct navigation types
  const distinctTypes = new Set(methods.map((m) => m.type));

  // Auto-pass: 2+ distinct types
  if (distinctTypes.size >= 2) return [];

  // Flag for human review
  const detectedTypesStr = distinctTypes.size > 0
    ? Array.from(distinctTypes).join(", ")
    : "none";

  return [{
    element_selector: "html",
    element_html: `<html> (page: ${snapshot.url})`,
    wcag_criterion: "2.4.5",
    detected_by: "playwright",
    raw_result: {
      verdict: "needs_review",
      reasoning: `Only ${distinctTypes.size} navigation method type(s) detected: ${detectedTypesStr}. ` +
        "WCAG 2.4.5 requires at least two ways to navigate. Manual review needed.",
      detected_methods: methods.map((m) => ({ type: m.type, selector: m.selector })),
    },
    measured_values: {
      distinct_navigation_types: distinctTypes.size,
      detected_types: Array.from(distinctTypes),
      all_methods: methods.map((m) => ({ type: m.type, selector: m.selector })),
      failure_type: "insufficient_navigation_methods",
    },
  }];
}

// ---------------------------------------------------------------------------
// Motion actuation detection: 2.5.4
// ---------------------------------------------------------------------------

/** Patterns for motion-related JS event listeners */
const MOTION_EVENT_PATTERNS = [
  /addEventListener\s*\(\s*["']devicemotion["']/gi,
  /addEventListener\s*\(\s*["']deviceorientation["']/gi,
  /on(?:device)?motion\s*=/gi,
  /on(?:device)?orientation\s*=/gi,
  /DeviceMotionEvent/g,
  /DeviceOrientationEvent/g,
];

/**
 * Scan DOM (including inline scripts) for device motion/orientation listeners.
 */
export function detectMotionListeners(dom: string): { pattern: string; context: string }[] {
  const results: { pattern: string; context: string }[] = [];

  for (const pattern of MOTION_EVENT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(dom)) !== null) {
      results.push({
        pattern: match[0],
        context: extractContext(dom, match.index, 100),
      });
    }
  }

  return results;
}

/**
 * Check for WCAG 2.5.4 (Motion Actuation).
 *
 * Scans inline JS for devicemotion/deviceorientation listeners.
 *
 * Auto-pass: If no motion listeners found.
 * Flag: If motion listeners found, flags for human review.
 */
export function checkMotionActuation(snapshot: PageSnapshot): CheckResult[] {
  const dom = snapshot.full_dom;
  const listeners = detectMotionListeners(dom);

  // Auto-pass: no motion listeners
  if (listeners.length === 0) return [];

  return [{
    element_selector: "script",
    element_html: truncate(listeners[0].context, 300),
    wcag_criterion: "2.5.4",
    detected_by: "playwright",
    raw_result: {
      verdict: "needs_review",
      reasoning: "Device motion/orientation event listeners detected. " +
        "WCAG 2.5.4 requires that functionality triggered by device motion " +
        "also has a UI alternative and can be disabled.",
      detected_listeners: listeners.map((l) => l.pattern),
    },
    measured_values: {
      motion_listeners_found: listeners.length,
      listener_patterns: listeners.map((l) => l.pattern),
      failure_type: "motion_actuation_detected",
    },
  }];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractSelector(html: string): string {
  const idMatch = html.match(/\bid\s*=\s*"([^"]+)"/i);
  if (idMatch) return `#${idMatch[1]}`;

  const classMatch = html.match(/\bclass\s*=\s*"([^"]+)"/i);
  if (classMatch) {
    const first = classMatch[1].split(/\s+/)[0];
    return `.${first}`;
  }

  const tagMatch = html.match(/<([a-z][a-z0-9]*)/i);
  return tagMatch ? tagMatch[1] : "unknown";
}

function extractContext(dom: string, index: number, radius: number): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(dom.length, index + radius);
  return dom.slice(start, end);
}

function truncate(str: string, max: number): string {
  return str.length <= max ? str : str.slice(0, max) + "...";
}
