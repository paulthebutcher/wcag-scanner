import type { Page } from "playwright";
import type { CheckResult } from "../../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkipLinkResult {
  /** Whether a skip link was found among the first focusable elements */
  found: boolean;
  /** The skip link element details (null if not found) */
  skipLink: {
    selector: string;
    text: string;
    href: string;
    outerHtml: string;
  } | null;
  /** Whether the skip link successfully moved focus to its target */
  focusMoved: boolean;
  /** Whether the target is a main content region */
  targetIsMainContent: boolean;
  /** The target element details (null if link not found or broken) */
  target: {
    selector: string;
    tagName: string;
    role: string | null;
    id: string | null;
  } | null;
  /** Description of what went wrong (null if everything is fine) */
  failureReason: string | null;
}

// ---------------------------------------------------------------------------
// Skip link detection
// ---------------------------------------------------------------------------

/**
 * Common patterns for skip navigation links.
 * Matches text content and href patterns.
 */
const SKIP_LINK_TEXT_PATTERNS = [
  /skip\s*(to)?\s*(main)?\s*(content|navigation|nav)?/i,
  /jump\s*to\s*(main\s*)?(content|navigation)/i,
  /go\s*to\s*(main\s*)?(content)/i,
];

const SKIP_LINK_HREF_PATTERNS = [
  /^#(main|content|main-content|maincontent|skip|primary)/i,
];

/**
 * Check the first N focusable elements for a skip navigation link.
 * Activates the link and verifies focus moves to the target.
 */
export async function verifySkipNav(
  page: Page,
  maxElementsToCheck: number = 3,
): Promise<SkipLinkResult> {
  // Reset focus to body
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur?.();
    document.body.focus();
  });

  // Tab through the first N elements looking for a skip link
  for (let i = 0; i < maxElementsToCheck; i++) {
    await page.keyboard.press("Tab");

    const linkInfo = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;

      const tagName = el.tagName.toLowerCase();
      if (tagName !== "a") return null;

      const href = el.getAttribute("href") ?? "";
      const text = (el.textContent ?? "").trim();
      const html = el.outerHTML;

      // Build selector
      let selector: string;
      if (el.id) {
        selector = `#${CSS.escape(el.id)}`;
      } else {
        const parts: string[] = [];
        let current: Element | null = el;
        while (current && current !== document.documentElement) {
          let part = current.tagName.toLowerCase();
          if (current.id) {
            parts.unshift(`#${CSS.escape(current.id)} > ${part}`);
            break;
          }
          const parent: Element | null = current.parentElement;
          if (parent) {
            const currentTag = current.tagName;
            const siblings = Array.from(parent.children).filter(
              (c: Element) => c.tagName === currentTag,
            );
            if (siblings.length > 1) {
              const index = siblings.indexOf(current) + 1;
              part += `:nth-of-type(${index})`;
            }
          }
          parts.unshift(part);
          current = parent;
        }
        selector = parts.join(" > ");
      }

      return {
        selector,
        text,
        href,
        outerHtml: html.length > 500 ? html.slice(0, 500) + "..." : html,
      };
    });

    if (!linkInfo) continue;

    // Check if this looks like a skip link
    const isSkipLink = isSkipNavLink(linkInfo.text, linkInfo.href);
    if (!isSkipLink) continue;

    // Found a skip link — activate it and verify
    return await activateAndVerifySkipLink(page, linkInfo);
  }

  // No skip link found
  return {
    found: false,
    skipLink: null,
    focusMoved: false,
    targetIsMainContent: false,
    target: null,
    failureReason: "No skip navigation link found among the first focusable elements",
  };
}

/**
 * Check if a link's text and href match skip navigation patterns.
 */
function isSkipNavLink(text: string, href: string): boolean {
  // Check text patterns
  for (const pattern of SKIP_LINK_TEXT_PATTERNS) {
    if (pattern.test(text)) return true;
  }

  // Check href patterns
  for (const pattern of SKIP_LINK_HREF_PATTERNS) {
    if (pattern.test(href)) return true;
  }

  return false;
}

/**
 * Activate a skip link and verify it works correctly.
 */
async function activateAndVerifySkipLink(
  page: Page,
  linkInfo: { selector: string; text: string; href: string; outerHtml: string },
): Promise<SkipLinkResult> {
  const href = linkInfo.href;

  // Activate the skip link (Enter key while focused)
  await page.keyboard.press("Enter");

  // Wait for navigation/focus change
  await page.waitForTimeout(100);

  // Check where focus moved
  const targetInfo = await page.evaluate((expectedHref: string) => {
    const active = document.activeElement;

    // If the href is a fragment link, check if the target element received focus
    if (expectedHref.startsWith("#")) {
      const targetId = expectedHref.slice(1);
      const targetEl = document.getElementById(targetId);

      if (targetEl) {
        const isMainContent =
          targetEl.tagName.toLowerCase() === "main" ||
          targetEl.getAttribute("role") === "main" ||
          targetEl.id === "main" ||
          targetEl.id === "content" ||
          targetEl.id === "main-content" ||
          targetEl.id === "maincontent" ||
          targetEl.id === "primary" ||
          targetEl.classList.contains("main-content");

        // Check if focus actually moved to the target or is within it
        const focusedCorrectly =
          active === targetEl || targetEl.contains(active);

        let selector: string;
        if (targetEl.id) {
          selector = `#${CSS.escape(targetEl.id)}`;
        } else {
          selector = targetEl.tagName.toLowerCase();
        }

        return {
          found: true,
          focusedCorrectly,
          isMainContent,
          selector,
          tagName: targetEl.tagName.toLowerCase(),
          role: targetEl.getAttribute("role"),
          id: targetEl.id || null,
        };
      }

      // Target element not found
      return {
        found: false,
        focusedCorrectly: false,
        isMainContent: false,
        selector: null,
        tagName: null,
        role: null,
        id: targetId,
      };
    }

    // Non-fragment skip link — just check if focus moved away
    return {
      found: active !== document.body,
      focusedCorrectly: active !== document.body,
      isMainContent: false,
      selector: active?.id ? `#${CSS.escape(active.id)}` : (active?.tagName?.toLowerCase() ?? null),
      tagName: active?.tagName?.toLowerCase() ?? null,
      role: active?.getAttribute("role") ?? null,
      id: active?.id ?? null,
    };
  }, href);

  if (!targetInfo.found) {
    return {
      found: true,
      skipLink: linkInfo,
      focusMoved: false,
      targetIsMainContent: false,
      target: null,
      failureReason: `Skip link target "${href}" not found in the document`,
    };
  }

  if (!targetInfo.focusedCorrectly) {
    return {
      found: true,
      skipLink: linkInfo,
      focusMoved: false,
      targetIsMainContent: targetInfo.isMainContent,
      target: targetInfo.selector ? {
        selector: targetInfo.selector,
        tagName: targetInfo.tagName!,
        role: targetInfo.role,
        id: targetInfo.id,
      } : null,
      failureReason: `Skip link target exists but focus did not move to it. The target may need tabindex="-1" to receive focus.`,
    };
  }

  return {
    found: true,
    skipLink: linkInfo,
    focusMoved: true,
    targetIsMainContent: targetInfo.isMainContent,
    target: {
      selector: targetInfo.selector!,
      tagName: targetInfo.tagName!,
      role: targetInfo.role,
      id: targetInfo.id,
    },
    failureReason: !targetInfo.isMainContent
      ? `Skip link target "${href}" does not appear to be a main content region`
      : null,
  };
}

// ---------------------------------------------------------------------------
// CheckResult generation
// ---------------------------------------------------------------------------

/**
 * Run skip navigation verification and produce CheckResults.
 *
 * Criterion 2.4.1 (Bypass Blocks):
 * - If no skip link found: CheckResult with confidence definitive
 * - If found but broken: CheckResult with evidence of what went wrong
 * - If found and working: no CheckResult
 */
export async function runSkipNavChecks(
  page: Page,
): Promise<CheckResult[]> {
  const result = await verifySkipNav(page);

  // Skip link found and working → no violation
  if (result.found && result.focusMoved && result.targetIsMainContent) {
    return [];
  }

  if (!result.found) {
    // No skip link at all — definitive violation
    return [{
      element_selector: "html",
      element_html: "<html>",
      wcag_criterion: "2.4.1",
      detected_by: "playwright",
      raw_result: {
        type: "missing_skip_navigation",
        failureReason: result.failureReason,
      },
      measured_values: {
        skip_link_found: false,
        focus_moved: false,
        target_is_main_content: false,
        confidence: "definitive",
      },
    }];
  }

  // Skip link found but broken
  return [{
    element_selector: result.skipLink!.selector,
    element_html: result.skipLink!.outerHtml,
    wcag_criterion: "2.4.1",
    detected_by: "playwright",
    raw_result: {
      type: "broken_skip_navigation",
      skipLinkText: result.skipLink!.text,
      skipLinkHref: result.skipLink!.href,
      focusMoved: result.focusMoved,
      targetIsMainContent: result.targetIsMainContent,
      failureReason: result.failureReason,
      target: result.target,
    },
    measured_values: {
      skip_link_found: true,
      focus_moved: result.focusMoved,
      target_is_main_content: result.targetIsMainContent,
      confidence: "high",
    },
  }];
}
