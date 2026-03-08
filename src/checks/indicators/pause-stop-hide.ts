import type { CheckResult } from "../../types.js";
import type { PageSnapshot } from "../../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An animated element detected in the DOM/CSS */
export interface AnimatedElement {
  selector: string;
  html: string;
  animationType: AnimationType;
  /** Duration in ms (null if unknown, e.g. GIFs) */
  duration: number | null;
  /** Whether the animation loops infinitely */
  infinite: boolean;
}

export type AnimationType =
  | "css_animation"
  | "css_transition"
  | "carousel"
  | "auto_scroll"
  | "gif"
  | "video";

/** A pause/stop/hide mechanism found near an animated element */
export interface PauseMechanism {
  selector: string;
  html: string;
  mechanismType: "button" | "control" | "attribute";
}

// ---------------------------------------------------------------------------
// CSS animation detection
// ---------------------------------------------------------------------------

/** Regex patterns for CSS animation properties in inline styles or style blocks */
const ANIMATION_PATTERNS = [
  // animation or animation-name on elements
  /animation\s*:\s*([^;}"]+)/gi,
  /animation-name\s*:\s*([^;}"]+)/gi,
];

const INFINITE_PATTERN = /infinite/i;

/** Duration extraction: handles s and ms */
const DURATION_PATTERN = /([\d.]+)\s*(ms|s)\b/i;

function parseDuration(raw: string): number | null {
  const match = raw.match(DURATION_PATTERN);
  if (!match) return null;
  const val = parseFloat(match[1]);
  return match[2] === "s" ? val * 1000 : val;
}

/**
 * Detect CSS animations from inline styles and <style> blocks in the DOM.
 */
export function detectCSSAnimations(dom: string): AnimatedElement[] {
  const results: AnimatedElement[] = [];

  // 1) Find elements with inline animation styles
  const inlinePattern = /<([a-z][a-z0-9]*)\b[^>]*style\s*=\s*"([^"]*animation[^"]*)"/gi;
  let match: RegExpExecArray | null;

  while ((match = inlinePattern.exec(dom)) !== null) {
    const fullTag = match[0];
    const styleValue = match[2];
    const infinite = INFINITE_PATTERN.test(styleValue);
    const duration = parseDuration(styleValue);

    // Extract a simple selector from id or class
    const selector = extractSelector(fullTag);

    results.push({
      selector,
      html: truncate(fullTag, 300),
      animationType: "css_animation",
      duration,
      infinite,
    });
  }

  // 2) Find @keyframes in <style> blocks and animation rules
  const styleBlocks = dom.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) ?? [];
  for (const block of styleBlocks) {
    const content = block.replace(/<\/?style[^>]*>/gi, "");

    // Find animation declarations in CSS rules
    const cssRulePattern = /([^{}]+)\{([^}]*animation[^}]*)\}/gi;
    let cssMatch: RegExpExecArray | null;
    while ((cssMatch = cssRulePattern.exec(content)) !== null) {
      const selectorPart = cssMatch[1].trim();
      const properties = cssMatch[2];
      const infinite = INFINITE_PATTERN.test(properties);
      const duration = parseDuration(properties);

      results.push({
        selector: selectorPart,
        html: truncate(cssMatch[0], 300),
        animationType: "css_animation",
        duration,
        infinite,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Carousel / auto-scroll detection
// ---------------------------------------------------------------------------

/** Patterns indicating carousels or auto-scrolling content */
const CAROUSEL_PATTERNS = [
  /class\s*=\s*"[^"]*\b(carousel|slider|swiper|slick|flickity|splide|glide|owl-carousel|slideshow)\b[^"]*"/gi,
  /data-(?:autoplay|auto-play|auto-slide|interval|slide-interval|swiper-autoplay)\s*=/gi,
  /class\s*=\s*"[^"]*\b(marquee|auto-scroll|scrolling-text|ticker)\b[^"]*"/gi,
  /<marquee\b/gi,
];

/**
 * Detect carousel and auto-scrolling elements in the DOM.
 */
export function detectCarousels(dom: string): AnimatedElement[] {
  const results: AnimatedElement[] = [];
  const seen = new Set<string>();

  for (const pattern of CAROUSEL_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(dom)) !== null) {
      const ctx = extractContext(dom, match.index, 500);
      const selector = extractSelector(ctx);
      if (seen.has(selector)) continue;
      seen.add(selector);

      const isMarquee = /<marquee\b/i.test(ctx);
      results.push({
        selector,
        html: truncate(ctx, 300),
        animationType: isMarquee ? "auto_scroll" : "carousel",
        duration: null,
        infinite: true,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// GIF detection
// ---------------------------------------------------------------------------

/**
 * Detect GIF images in the DOM.
 */
export function detectGIFs(dom: string): AnimatedElement[] {
  const results: AnimatedElement[] = [];
  const gifPattern = /<img\b[^>]*src\s*=\s*"[^"]*\.gif(?:\?[^"]*)?"/gi;

  let match: RegExpExecArray | null;
  while ((match = gifPattern.exec(dom)) !== null) {
    const tag = match[0];
    // Close the tag for html display
    const fullTag = tag.includes("/>") ? tag : tag + ">";
    const selector = extractSelector(fullTag);

    results.push({
      selector,
      html: truncate(fullTag, 300),
      animationType: "gif",
      duration: null,
      infinite: true, // GIFs loop by default
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Video detection
// ---------------------------------------------------------------------------

/**
 * Detect video elements in the DOM (including autoplay).
 */
export function detectVideos(dom: string): AnimatedElement[] {
  const results: AnimatedElement[] = [];
  const videoPattern = /<video\b[^>]*>/gi;

  let match: RegExpExecArray | null;
  while ((match = videoPattern.exec(dom)) !== null) {
    const tag = match[0];
    const selector = extractSelector(tag);
    const autoplay = /\bautoplay\b/i.test(tag);

    results.push({
      selector,
      html: truncate(tag, 300),
      animationType: "video",
      duration: null,
      infinite: /\bloop\b/i.test(tag),
    });

    // Only flag videos that autoplay — static videos with controls are fine
    if (!autoplay) {
      results.pop();
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Pause/stop/hide mechanism detection
// ---------------------------------------------------------------------------

/** Patterns for pause/stop controls near animated elements */
const PAUSE_MECHANISM_PATTERNS = [
  /aria-label\s*=\s*"[^"]*(pause|stop|play|toggle.?animation|toggle.?motion)[^"]*"/gi,
  /<button\b[^>]*>[^<]*(pause|stop|play)[^<]*<\/button>/gi,
  /class\s*=\s*"[^"]*\b(pause|play|stop|media-control|player-control)\b[^"]*"/gi,
  /prefers-reduced-motion/gi,
  /role\s*=\s*"button"[^>]*>[^<]*(pause|stop|play)[^<]*/gi,
];

/**
 * Search for pause/stop/hide mechanisms in the DOM near animated content.
 */
export function findPauseMechanisms(dom: string): PauseMechanism[] {
  const results: PauseMechanism[] = [];
  const seen = new Set<string>();

  for (const pattern of PAUSE_MECHANISM_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(dom)) !== null) {
      const ctx = extractContext(dom, match.index, 300);
      const selector = extractSelector(ctx);
      if (seen.has(selector)) continue;
      seen.add(selector);

      const isPrefersReducedMotion = /prefers-reduced-motion/i.test(match[0]);
      results.push({
        selector: isPrefersReducedMotion ? "@media" : selector,
        html: truncate(ctx, 200),
        mechanismType: isPrefersReducedMotion ? "attribute" : "button",
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main check function: 2.2.2 Pause, Stop, Hide
// ---------------------------------------------------------------------------

/**
 * Check for WCAG 2.2.2 (Pause, Stop, Hide).
 *
 * Detects animated content (CSS animations, carousels, auto-scrolling)
 * and checks whether a pause/stop/hide mechanism exists nearby.
 *
 * Auto-pass: If no animated content is found, produces no CheckResult.
 * Flag: If animated content found without pause mechanism, flags for human review.
 */
export function checkPauseStopHide(snapshot: PageSnapshot): CheckResult[] {
  const dom = snapshot.full_dom;
  const results: CheckResult[] = [];

  // Gather all animated elements
  const animated = [
    ...detectCSSAnimations(dom),
    ...detectCarousels(dom),
  ];

  // Auto-pass: no animated content found
  if (animated.length === 0) return [];

  // Check for pause mechanisms
  const mechanisms = findPauseMechanisms(dom);
  const hasPauseMechanism = mechanisms.length > 0;

  // Flag each animated element for human review
  for (const elem of animated) {
    results.push({
      element_selector: elem.selector,
      element_html: elem.html,
      wcag_criterion: "2.2.2",
      detected_by: "playwright",
      raw_result: {
        verdict: hasPauseMechanism ? "needs_review" : "fail",
        animationType: elem.animationType,
        duration: elem.duration,
        infinite: elem.infinite,
        pauseMechanismFound: hasPauseMechanism,
        pauseMechanisms: mechanisms.map((m) => ({
          selector: m.selector,
          type: m.mechanismType,
        })),
      },
      measured_values: {
        animation_type: elem.animationType,
        duration_ms: elem.duration,
        is_infinite: elem.infinite,
        pause_mechanism_found: hasPauseMechanism,
        failure_type: hasPauseMechanism
          ? "animated_content_needs_review"
          : "animated_content_no_pause",
      },
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main check function: 2.3.1 Three Flashes
// ---------------------------------------------------------------------------

/**
 * Check for WCAG 2.3.1 (Three Flashes or Below Threshold).
 *
 * Detects content that might flash: GIFs, videos, and very short CSS animations.
 *
 * Auto-pass: If no potentially flashing content is found, produces no CheckResult.
 * Flag: If found, flags for human review (automated flash rate detection is unreliable).
 */
export function checkThreeFlashes(snapshot: PageSnapshot): CheckResult[] {
  const dom = snapshot.full_dom;
  const results: CheckResult[] = [];

  // Detect potentially flashing content
  const gifs = detectGIFs(dom);
  const videos = detectVideos(dom);

  // Also flag very short CSS animations (< 350ms) that could flash
  const shortAnimations = detectCSSAnimations(dom).filter(
    (a) => a.duration !== null && a.duration < 350,
  );

  const flashCandidates = [...gifs, ...videos, ...shortAnimations];

  // Auto-pass: no potentially flashing content
  if (flashCandidates.length === 0) return [];

  for (const elem of flashCandidates) {
    results.push({
      element_selector: elem.selector,
      element_html: elem.html,
      wcag_criterion: "2.3.1",
      detected_by: "playwright",
      raw_result: {
        verdict: "needs_review",
        animationType: elem.animationType,
        duration: elem.duration,
        reasoning:
          "Potentially flashing content detected. Automated flash rate analysis is unreliable — manual review required to determine if content flashes more than 3 times per second.",
      },
      measured_values: {
        content_type: elem.animationType,
        duration_ms: elem.duration,
        failure_type: `potential_flash_${elem.animationType}`,
      },
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractSelector(html: string): string {
  // Try id first
  const idMatch = html.match(/\bid\s*=\s*"([^"]+)"/i);
  if (idMatch) return `#${idMatch[1]}`;

  // Try class
  const classMatch = html.match(/\bclass\s*=\s*"([^"]+)"/i);
  if (classMatch) {
    const first = classMatch[1].split(/\s+/)[0];
    return `.${first}`;
  }

  // Fall back to tag name
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
