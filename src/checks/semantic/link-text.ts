import type { CheckResult } from "../../types.js";
import type { PromptRunner, PromptResult } from "../../core/prompt-runner.js";
import {
  linkTextQuality,
  buildLinkTextUserPrompt,
} from "../../prompts/element-evaluation.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Data collected for each link before sending to Claude */
export interface LinkContext {
  /** CSS selector for the link element */
  selector: string;
  /** Outer HTML of the <a> element */
  html: string;
  /** Visible text content of the link */
  visibleText: string;
  /** href attribute value */
  href: string;
  /** aria-label attribute value, if present */
  ariaLabel: string | null;
  /** Surrounding paragraph/context text */
  surroundingContext: string;
  /** Whether this link contains only an image (image link) */
  isImageLink: boolean;
  /** Alt text of the image inside the link, if any */
  imageAlt: string | null;
}

/** Result from Claude's evaluation of a link */
export interface LinkTextEvaluation {
  verdict: "pass" | "fail" | "needs_review";
  confidence: number;
  reasoning: string;
  wcag_criterion: string;
  failure_type: string | null;
  suggestion: string | null;
  affected_users: string[];
  requires_human_verification: boolean;
}

// ---------------------------------------------------------------------------
// Link collection from DOM
// ---------------------------------------------------------------------------

/**
 * Collect all links from a page's DOM string, gathering context for each.
 * Works on serialized DOM without a live browser.
 */
export function collectLinks(dom: string): LinkContext[] {
  const links: LinkContext[] = [];
  // Match <a ...>...</a> (non-greedy, but handles nested tags via counting)
  const linkRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(dom)) !== null) {
    const fullMatch = match[0];
    const attrs = match[1];
    const innerContent = match[2];

    const href = extractAttr(attrs, "href") ?? "";
    const ariaLabel = extractAttr(attrs, "aria-label");
    const selector = buildLinkSelector(attrs, links.length);

    // Visible text: strip tags from inner content
    const visibleText = stripTags(innerContent).trim();

    // Check if this is an image-only link
    const imgMatch = innerContent.match(/<img\b[^>]*>/i);
    const isImageLink = imgMatch !== null && visibleText.length === 0;
    const imageAlt = imgMatch ? extractAttrFromTag(imgMatch[0], "alt") : null;

    // Surrounding context (text before and after the link)
    const contextStart = Math.max(0, match.index - 200);
    const contextEnd = Math.min(dom.length, match.index + fullMatch.length + 200);
    const surroundingRaw = dom.slice(contextStart, contextEnd);
    const surroundingContext = stripTags(surroundingRaw).trim().slice(0, 300);

    links.push({
      selector,
      html: fullMatch,
      visibleText,
      href,
      ariaLabel,
      surroundingContext,
      isImageLink,
      imageAlt,
    });
  }

  return links;
}

// ---------------------------------------------------------------------------
// CMS deduplication
// ---------------------------------------------------------------------------

/**
 * Deduplicate CMS collection links that share identical visible text patterns.
 * Keeps one representative link per unique text pattern.
 */
export function deduplicateCmsLinks(links: LinkContext[]): LinkContext[] {
  const seen = new Map<string, LinkContext>();

  for (const link of links) {
    // Pattern key: visible text (or aria-label if no visible text) + image link status
    const textKey = link.visibleText || link.ariaLabel || link.imageAlt || "__empty__";
    const patternKey = `${textKey}|${link.isImageLink}`;

    if (!seen.has(patternKey)) {
      seen.set(patternKey, link);
    }
  }

  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// Aria-label pass-through
// ---------------------------------------------------------------------------

/**
 * Check if a link has a descriptive aria-label that makes it pass
 * regardless of visible text quality.
 * A descriptive aria-label must be non-empty and not a generic phrase.
 */
export function hasDescriptiveAriaLabel(link: LinkContext): boolean {
  if (!link.ariaLabel) return false;

  const label = link.ariaLabel.trim().toLowerCase();
  if (label.length === 0) return false;

  // Generic labels that don't count as descriptive
  const genericLabels = [
    "click here",
    "read more",
    "learn more",
    "link",
    "here",
    "more",
    "go",
  ];

  return !genericLabels.includes(label);
}

// ---------------------------------------------------------------------------
// Main check function
// ---------------------------------------------------------------------------

/**
 * Run link text quality checks on all links in a page.
 *
 * 1. Collects all links with context from the DOM.
 * 2. Deduplicates CMS collection links with identical text patterns.
 * 3. Filters out links with descriptive aria-labels (auto-pass).
 * 4. Sends link list to Claude API (Prompt 2) for quality evaluation.
 * 5. Returns CheckResult[] for links that fail.
 */
export async function runLinkTextChecks(
  dom: string,
  runner: PromptRunner,
  options: {
    deduplicateCms?: boolean;
  } = {},
): Promise<CheckResult[]> {
  const { deduplicateCms = true } = options;

  // 1. Collect all links
  let links = collectLinks(dom);

  // 2. Deduplicate CMS collection links
  if (deduplicateCms) {
    links = deduplicateCmsLinks(links);
  }

  // 3. Filter out links with descriptive aria-labels
  const linksToCheck = links.filter((link) => !hasDescriptiveAriaLabel(link));

  if (linksToCheck.length === 0) {
    return [];
  }

  // 4. Send each link to Claude API for evaluation
  const promptInputs = linksToCheck.map((link) => ({
    template: linkTextQuality,
    userMessage: buildLinkTextUserPrompt({
      elementHtml: link.html,
      linkText: link.visibleText || (link.isImageLink ? `[image: ${link.imageAlt ?? "no alt"}]` : "(empty)"),
      surroundingContext: link.surroundingContext,
    }),
  }));

  const evalResults = await runner.runPrompts<LinkTextEvaluation>(promptInputs);

  // 5. Map results to CheckResult[]
  const results: CheckResult[] = [];

  for (let i = 0; i < linksToCheck.length; i++) {
    const link = linksToCheck[i];
    const evalResult = evalResults[i];

    if (!evalResult.success && !evalResult.data) {
      results.push(createCheckResult(link, {
        verdict: "needs_review",
        confidence: 0,
        reasoning: `API evaluation failed: ${evalResult.error}`,
        wcag_criterion: "2.4.4",
        failure_type: null,
        suggestion: null,
        affected_users: ["screen_reader"],
        requires_human_verification: true,
      }));
      continue;
    }

    const evaluation = evalResult.data!;

    if (evaluation.verdict === "fail" || evaluation.verdict === "needs_review") {
      results.push(createCheckResult(link, evaluation));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// CheckResult creation
// ---------------------------------------------------------------------------

function createCheckResult(
  link: LinkContext,
  evaluation: LinkTextEvaluation,
): CheckResult {
  return {
    element_selector: link.selector,
    element_html: link.html,
    wcag_criterion: "2.4.4",
    detected_by: "claude_api",
    raw_result: evaluation,
    measured_values: {
      visible_text: link.visibleText,
      href: link.href,
      aria_label: link.ariaLabel,
      failure_type: evaluation.failure_type,
      confidence: evaluation.confidence,
      is_image_link: link.isImageLink,
    },
    aria_attributes: link.ariaLabel ? { "aria-label": link.ariaLabel } : {},
  };
}

// ---------------------------------------------------------------------------
// DOM parsing helpers
// ---------------------------------------------------------------------------

/** Extract an attribute value from an attribute string (not full tag) */
function extractAttr(attrStr: string, attr: string): string | null {
  const regex = new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = attrStr.match(regex);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/** Extract an attribute from a full tag string */
function extractAttrFromTag(tag: string, attr: string): string | null {
  return extractAttr(tag, attr);
}

/** Build a CSS selector for a link */
function buildLinkSelector(attrStr: string, index: number): string {
  const id = extractAttr(attrStr, "id");
  if (id) return `a#${id}`;

  const className = extractAttr(attrStr, "class");
  if (className) {
    const classes = className.split(/\s+/).filter(Boolean).join(".");
    return `a.${classes}`;
  }

  const href = extractAttr(attrStr, "href");
  if (href) {
    const safeHref = href.replace(/"/g, '\\"').slice(0, 80);
    return `a[href="${safeHref}"]`;
  }

  return `a:nth-of-type(${index + 1})`;
}

/** Strip HTML tags from a string */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}
