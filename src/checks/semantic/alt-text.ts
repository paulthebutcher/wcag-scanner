import type { Page } from "playwright";
import type { CheckResult } from "../../types.js";
import type { PromptRunner, PromptResult } from "../../core/prompt-runner.js";
import {
  altTextQuality,
  buildAltTextUserPrompt,
} from "../../prompts/element-evaluation.js";
import { buildLlmCapture } from "./llm-capture.js";

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
// Alt text pre-filter — skip API call for clearly acceptable alt text
// ---------------------------------------------------------------------------

/** Known file extension patterns */
const FILE_EXT_RE = /\.(jpe?g|png|gif|svg|webp|avif|bmp|tiff?|ico)(\?.*)?$/i;

/** Common camera / screenshot prefixes that indicate a filename */
const FILENAME_PREFIX_RE = /^(IMG[_-]|DSC[_-]|DCIM|Screenshot|Screen Shot|Capture|Photo[_-]|PXL_|DJI_|GOPR|VID[_-])/i;

/** Single generic words that are never useful alt text */
const GENERIC_SINGLE_WORDS = new Set([
  "image", "photo", "picture", "icon", "logo",
  "graphic", "banner", "screenshot", "thumbnail",
]);

/** Placeholder / filler text */
const PLACEHOLDER_RE = /^(alt\s*text|description|todo|placeholder|untitled)$/i;

/**
 * Returns `true` if the alt text is clearly acceptable and can skip the
 * Claude API call. Returns `false` if any anti-pattern is detected (or
 * the text is empty / too short / too long), meaning it should proceed
 * to the full semantic evaluation.
 *
 * Conditions for auto-pass (ALL must be true):
 * 1. Non-empty and not whitespace-only
 * 2. Not a filename (has file extension or camera/screenshot prefix)
 * 3. Not a single generic word (image, photo, icon, etc.)
 * 4. Not placeholder text (todo, placeholder, alt text, etc.)
 * 5. Length between 5 and 250 characters (inclusive)
 */
export function altTextPassesPreFilter(alt: string | null): boolean {
  // Null or missing alt attribute — needs evaluation
  if (alt === null) return false;

  const trimmed = alt.trim();

  // 1. Non-empty
  if (trimmed.length === 0) return false;

  // 5. Length bounds (check early to short-circuit)
  if (trimmed.length < 5 || trimmed.length > 250) return false;

  const lower = trimmed.toLowerCase();

  // 2. Filename detection: extension or camera/screenshot prefix
  if (FILE_EXT_RE.test(lower) || FILENAME_PREFIX_RE.test(trimmed)) return false;

  // 3. Single generic word (exact match only)
  if (GENERIC_SINGLE_WORDS.has(lower)) return false;

  // 4. Placeholder text
  if (PLACEHOLDER_RE.test(lower)) return false;

  return true;
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
    /** Supplies the image itself (base64 PNG) for the vision prompt */
    imageProvider?: (img: ImageContext) => Promise<string | undefined>;
  } = {},
): Promise<CheckResult[]> {
  const {
    axeFlaggedSelectors = new Set(),
    deduplicateCms = true,
    screenshotProvider,
    imageProvider,
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

  // 4a. Skip images with alt="" that are inside labeled functional elements.
  //     When an <img alt=""> sits inside a link or button that already has
  //     visible text content, the empty alt is correct (image is decorative).
  //     Sending these to Claude produces hedged needs_review findings that are
  //     always false positives.
  images = images.filter((img) => {
    if (img.alt === "" && img.isInsideFunctional && img.surroundingContext.trim().length > 0) {
      return false;
    }
    return true;
  });

  // 5. Pre-filter: auto-pass images whose alt text is clearly acceptable
  //    (non-empty, not a filename/generic/placeholder, 5-250 chars)
  images = images.filter((img) => !altTextPassesPreFilter(img.alt));

  if (images.length === 0) {
    return [];
  }

  // 6. Get screenshots if provider available
  if (screenshotProvider || imageProvider) {
    await Promise.all(images.map(async (img) => {
      try {
        img.screenshotBase64 = imageProvider
          ? await imageProvider(img)
          : await screenshotProvider!(img.selector);
      } catch {
        // Evaluate from HTML and context alone
      }
    }));
  }

  // 7. Send each image to Claude API for evaluation
  const results: CheckResult[] = [];
  const promptInputs = images.map((img) => ({
    template: altTextQuality,
    userMessage: buildAltTextUserPrompt({
      elementHtml: img.html,
      altText: img.alt ?? "(no alt attribute)",
      surroundingContext: img.surroundingContext,
      imageAttached: Boolean(img.screenshotBase64),
    }),
    imageBase64: img.screenshotBase64,
    imageMediaType: "image/png" as const,
  }));

  const evalResults = await runner.runPrompts<AltTextEvaluation>(promptInputs);

  // 8. Map results to CheckResult[]
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const evalResult = evalResults[i];
    const capture = buildLlmCapture(promptInputs[i], evalResult);

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
      }, capture));
      continue;
    }

    const evaluation = evalResult.data!;

    if (evaluation.verdict === "fail" || evaluation.verdict === "needs_review") {
      results.push(createCheckResult(img, evaluation, capture));
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
  capture?: ReturnType<typeof buildLlmCapture>,
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
    ...(capture ? { llm_input: capture.llm_input, llm_output: capture.llm_output } : {}),
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

  if (openLinks > closeLinks || openButtons > closeButtons) return true;

  // Custom controls: an element with an interactive role that hasn't been
  // closed yet (e.g. Webflow's <div class="w-dropdown-toggle" role="button">).
  const roleOpen = /<([a-z][a-z0-9]*)\b[^>]*\brole\s*=\s*["'](?:button|link|menuitem|tab)["'][^>]*>/gi;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = roleOpen.exec(preceding)) !== null) last = m;
  if (!last) return false;
  const tag = last[1];
  const after = preceding.slice(last.index + last[0].length);
  const opens = (after.match(new RegExp(`<${tag}\\b`, "gi")) || []).length;
  const closes = (after.match(new RegExp(`</${tag}>`, "gi")) || []).length;
  return closes <= opens;
}
