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
  // Enumerate the first N keyboard-reachable anchors in DOM order. We
  // intentionally do NOT rely on Tab here — the browser's sequential-focus
  // starting point is pollutable by prior checks (focus-visible, trap,
  // keyboard) that run before us in the scanner pipeline, and body.focus()
  // does not reset that anchor. DOM-order enumeration is deterministic and
  // captures the same elements a keyboard user would reach from the top of
  // the page regardless of current focus state.
  const candidates = await page.evaluate((maxCheck) => {
    // Standard tabbable selector: anchors, buttons, form controls, explicit
    // positive-tabindex elements. We walk these in DOM order — for pages
    // without tabindex > 0 overrides (the normal case) this matches native
    // browser tab order. The old implementation used Tab to enumerate,
    // which was unreliable after prior checks moved the focus anchor.
    const focusableSel = 'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';
    const focusables = Array.from(document.querySelectorAll(focusableSel)) as HTMLElement[];
    const isReachable = (el: Element): boolean => {
      let cur: Element | null = el;
      while (cur && cur !== document.documentElement) {
        const curEl = cur as HTMLElement;
        if (curEl.hasAttribute?.("inert")) return false;
        if (cur.getAttribute("aria-hidden") === "true") return false;
        if (curEl.hidden) return false;
        const style = window.getComputedStyle(curEl);
        if (style.display === "none") return false;
        if (style.visibility === "hidden") return false;
        cur = cur.parentElement;
      }
      const ti = (el as HTMLElement).getAttribute("tabindex");
      if (ti !== null && parseInt(ti, 10) < 0) return false;
      // Note: skip links are commonly positioned off-screen until focused,
      // so we do NOT require the rect to be in-viewport.
      return true;
    };

    const buildSelector = (el: Element): string => {
      if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
      const parts: string[] = [];
      let current: Element | null = el;
      while (current && current !== document.documentElement) {
        let part = current.tagName.toLowerCase();
        if (current.id && document.querySelectorAll(`#${CSS.escape(current.id)}`).length === 1) {
          parts.unshift(`#${CSS.escape(current.id)} > ${part}`);
          break;
        }
        const parent: Element | null = current.parentElement;
        if (parent) {
          const tag = current.tagName;
          const siblings = Array.from(parent.children).filter((c) => c.tagName === tag);
          if (siblings.length > 1) {
            const index = siblings.indexOf(current) + 1;
            part += `:nth-of-type(${index})`;
          }
        }
        parts.unshift(part);
        current = parent;
      }
      return parts.join(" > ");
    };

    // Take the first N reachable focusables in DOM order, then filter to
    // anchors. A skip link at position 5 (after 4 buttons) is still missed
    // because a keyboard user would have already tabbed through 4 elements
    // before reaching it — defeating the purpose of a skip link.
    const firstN: HTMLElement[] = [];
    for (const el of focusables) {
      if (firstN.length >= maxCheck) break;
      if (!isReachable(el)) continue;
      firstN.push(el);
    }
    const picked: Array<{ selector: string; text: string; href: string; outerHtml: string }> = [];
    for (const el of firstN) {
      if (el.tagName.toLowerCase() !== "a") continue;
      const html = el.outerHTML;
      picked.push({
        selector: buildSelector(el),
        text: (el.textContent ?? "").trim(),
        href: (el as HTMLAnchorElement).getAttribute("href") ?? "",
        outerHtml: html.length > 500 ? html.slice(0, 500) + "..." : html,
      });
    }
    return picked;
  }, maxElementsToCheck);

  for (const linkInfo of candidates) {
    if (!isSkipNavLink(linkInfo.text, linkInfo.href)) continue;
    return await activateAndVerifySkipLink(page, linkInfo);
  }

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

  // Focus the link first. DOM enumeration picked this element without
  // tabbing, so we must explicitly set focus before simulating Enter.
  // Use the locator so Playwright handles scrolling/pointer-events.
  try {
    await page.locator(linkInfo.selector).first().focus();
  } catch {
    // Fall through — press Enter anyway; if focus isn't on the link,
    // the result will reflect that and we'll report it honestly.
  }

  // Activate the skip link
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
