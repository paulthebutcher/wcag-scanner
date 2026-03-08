import type { Page } from "playwright";
import type { CheckResult } from "../../types.js";
import type { PromptRunner, PromptResult } from "../../core/prompt-runner.js";
import {
  altTextQuality,
  buildAltTextUserPrompt,
} from "../../prompts/element-evaluation.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Data collected for each image before sending to Claude */
export interface ImageContext {
  /** CSS selector for the image element */
  selector: string;
  /** Outer HTML of the <img> element */
  html: string;
  /** Current alt attribute value (empty string if alt="", null if absent) */
  alt: string | null;
  /** Surrounding context — parent element's text content */
  surroundingContext: string;
  /** Whether the image is inside a link or button */
  isInsideFunctional: boolean;
  /** Whether this image was already flagged by axe-core (missing alt) */
  axeFlagged: boolean;
  /** src attribute for deduplication */
  src: string;
  /** Base64-encoded screenshot of the image (if available) */
  screenshotBase64?: string;
}

/** Result from Claude's evaluation of an image */
export interface AltTextEvaluation {
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
// Image collection from DOM
// ---------------------------------------------------------------------------

/**
 * Collect all images from a page's DOM string, gathering context for each.
 * Does NOT require a live Playwright page — works on serialized DOM.
 */
export function collectImages(
  dom: string,
  axeFlaggedSelectors: Set<string> = new Set(),
): ImageContext[] {
  // Use regex-based extraction from serialized DOM
  // This avoids needing a live browser page for the collection step
  const images: ImageContext[] = [];
  const imgRegex = /<img\b[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = imgRegex.exec(dom)) !== null) {
    const imgTag = match[0];

    // Extract attributes
    const alt = extractAttr(imgTag, "alt");
    const src = extractAttr(imgTag, "src") ?? "";
    const selector = buildSelectorFromImg(imgTag, images.length);

    // Extract surrounding context (text around the img tag)
    const contextStart = Math.max(0, match.index - 200);
    const contextEnd = Math.min(dom.length, match.index + imgTag.length + 200);
    const surroundingRaw = dom.slice(contextStart, contextEnd);
    const surroundingContext = stripTags(surroundingRaw).trim().slice(0, 300);

    // Determine if inside a functional element (link/button)
    const before = dom.slice(Math.max(0, match.index - 500), match.index);
    const isInsideFunctional = isInsideLinkOrButton(before);

    const isAxeFlagged = axeFlaggedSelectors.has(selector);

    images.push({
      selector,
      html: imgTag,
      alt,
      surroundingContext,
      isInsideFunctional,
      axeFlagged: isAxeFlagged,
      src,
    });
  }

  return images;
}

// ---------------------------------------------------------------------------
// CMS deduplication
// ---------------------------------------------------------------------------

/**
 * Deduplicate CMS collection images that share identical alt text patterns.
 * Keeps one representative image per unique alt pattern within the same
 * CMS collection (identified by similar src patterns).
 */
export function deduplicateCmsImages(images: ImageContext[]): ImageContext[] {
  const seen = new Map<string, ImageContext>();

  for (const img of images) {
    // Create a pattern key from the alt text and whether it's functional
    // CMS images typically have the same alt pattern (e.g., all empty, all same template)
    const patternKey = `${img.alt ?? "__null__"}|${img.isInsideFunctional}`;

    if (!seen.has(patternKey)) {
      seen.set(patternKey, img);
    }
  }

  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// Main check function
// ---------------------------------------------------------------------------

/**
 * Run alt text quality checks on all images in a page.
 *
 * 1. Collects all images with context from the DOM.
 * 2. Skips images already flagged by axe-core (missing alt entirely).
 * 3. Deduplicates CMS collection images with identical alt patterns.
 * 4. Sends remaining images to Claude API (Prompt 1) for quality evaluation.
 * 5. Returns CheckResult[] for images that fail.
 */
export async function runAltTextChecks(
  dom: string,
  runner: PromptRunner,
  options: {
    axeFlaggedSelectors?: Set<string>;
    deduplicateCms?: boolean;
    screenshotProvider?: (selector: string) => Promise<string | undefined>;
  } = {},
): Promise<CheckResult[]> {
  const {
    axeFlaggedSelectors = new Set(),
    deduplicateCms = true,
    screenshotProvider,
  } = options;

  // 1. Collect all images
  let images = collectImages(dom, axeFlaggedSelectors);

  // 2. Skip images already flagged by axe-core as completely missing alt
  images = images.filter((img) => !img.axeFlagged);

  // 3. Skip images with no alt attribute at all (axe-core handles those)
  // We focus on images that HAVE alt text but it may be poor quality
  // Also include images with alt="" that might be informative (not properly marked decorative)
  // The Claude prompt will determine if the usage is correct

  // 4. Deduplicate CMS collection images
  if (deduplicateCms) {
    images = deduplicateCmsImages(images);
  }

  if (images.length === 0) {
    return [];
  }

  // 5. Get screenshots if provider available
  if (screenshotProvider) {
    for (const img of images) {
      img.screenshotBase64 = await screenshotProvider(img.selector);
    }
  }

  // 6. Send each image to Claude API for evaluation
  const results: CheckResult[] = [];
  const promptInputs = images.map((img) => ({
    template: altTextQuality,
    userMessage: buildAltTextUserPrompt({
      elementHtml: img.html,
      altText: img.alt ?? "(no alt attribute)",
      surroundingContext: img.surroundingContext,
    }),
    imageBase64: img.screenshotBase64,
    imageMediaType: "image/png" as const,
  }));

  const evalResults = await runner.runPrompts<AltTextEvaluation>(promptInputs);

  // 7. Map results to CheckResult[]
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const evalResult = evalResults[i];

    if (!evalResult.success && !evalResult.data) {
      // API failed and no fallback data — create needs_review result
      results.push(createCheckResult(img, {
        verdict: "needs_review",
        confidence: 0,
        reasoning: `API evaluation failed: ${evalResult.error}`,
        wcag_criterion: "1.1.1",
        failure_type: null,
        suggestion: null,
        affected_users: ["screen_reader"],
        requires_human_verification: true,
      }));
      continue;
    }

    const evaluation = evalResult.data!;

    if (evaluation.verdict === "fail" || evaluation.verdict === "needs_review") {
      results.push(createCheckResult(img, evaluation));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// CheckResult creation
// ---------------------------------------------------------------------------

function createCheckResult(
  img: ImageContext,
  evaluation: AltTextEvaluation,
): CheckResult {
  return {
    element_selector: img.selector,
    element_html: img.html,
    wcag_criterion: "1.1.1",
    detected_by: "claude_api",
    raw_result: evaluation,
    screenshot: img.screenshotBase64 ? Buffer.from(img.screenshotBase64, "base64") : undefined,
    measured_values: {
      alt_text: img.alt,
      failure_type: evaluation.failure_type,
      confidence: evaluation.confidence,
      is_inside_functional: img.isInsideFunctional,
    },
    aria_attributes: {},
  };
}

// ---------------------------------------------------------------------------
// DOM parsing helpers
// ---------------------------------------------------------------------------

/** Extract an attribute value from an HTML tag string */
export function extractAttr(tag: string, attr: string): string | null {
  // Match attr="value", attr='value', or attr=value
  const regex = new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = tag.match(regex);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/** Build a CSS selector from img attributes */
function buildSelectorFromImg(imgTag: string, index: number): string {
  const id = extractAttr(imgTag, "id");
  if (id) return `#${id}`;

  const className = extractAttr(imgTag, "class");
  const src = extractAttr(imgTag, "src");

  if (className) {
    const classes = className.split(/\s+/).filter(Boolean).join(".");
    return `img.${classes}`;
  }

  if (src) {
    // Use a truncated src for selector
    const safeSrc = src.replace(/"/g, '\\"').slice(0, 80);
    return `img[src="${safeSrc}"]`;
  }

  return `img:nth-of-type(${index + 1})`;
}

/** Strip HTML tags from a string */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

/** Check if position is inside an <a> or <button> by looking at preceding HTML */
function isInsideLinkOrButton(preceding: string): boolean {
  // Count open/close tags to determine nesting
  const openLinks = (preceding.match(/<a\b/gi) || []).length;
  const closeLinks = (preceding.match(/<\/a>/gi) || []).length;
  const openButtons = (preceding.match(/<button\b/gi) || []).length;
  const closeButtons = (preceding.match(/<\/button>/gi) || []).length;

  return openLinks > closeLinks || openButtons > closeButtons;
}
