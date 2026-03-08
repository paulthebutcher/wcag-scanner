import type { Page, ElementHandle } from "playwright";
import type { CheckResult } from "../../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Information captured at each tab stop */
export interface FocusStop {
  /** CSS selector for the focused element */
  selector: string;
  /** HTML tag name (lowercase) */
  tagName: string;
  /** ARIA role or implicit role */
  role: string | null;
  /** Bounding box in viewport coordinates */
  boundingBox: { x: number; y: number; width: number; height: number } | null;
  /** tabindex attribute value, or null if not set */
  tabIndex: number | null;
  /** Outer HTML of the element (truncated) */
  outerHtml: string;
  /** Index in the tab sequence (0-based) */
  sequenceIndex: number;
}

export interface TabSequenceResult {
  /** Ordered array of tab stops */
  focusStops: FocusStop[];
  /** Interactive elements that were NOT reached by tabbing */
  unreachableElements: UnreachableElement[];
  /** Total number of Tab presses performed */
  totalTabs: number;
  /** Whether cycle detection ended the sequence */
  endedByCycle: boolean;
  /** Whether max tabs limit ended the sequence */
  endedByMax: boolean;
}

export interface UnreachableElement {
  selector: string;
  tagName: string;
  role: string | null;
  outerHtml: string;
}

export interface KeyboardCheckOptions {
  /** Maximum number of Tab presses before stopping. Default: 500 */
  maxTabs?: number;
}

// ---------------------------------------------------------------------------
// Selectors for interactive elements
// ---------------------------------------------------------------------------

/**
 * CSS selector matching elements that should be keyboard-reachable.
 * Excludes hidden, disabled, and explicitly removed-from-tab-order elements.
 */
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="switch"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="textbox"]',
  '[contenteditable="true"]',
].join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a CSS selector that uniquely identifies an element */
async function getElementSelector(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return "body";

    // Try ID first
    if (el.id) return `#${CSS.escape(el.id)}`;

    // Build a path from tag + nth-of-type
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
    return parts.join(" > ");
  });
}

/** Get details about the currently focused element */
async function getFocusedElementInfo(page: Page): Promise<{
  selector: string;
  tagName: string;
  role: string | null;
  tabIndex: number | null;
  outerHtml: string;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
} | null> {
  const selector = await getElementSelector(page);
  if (selector === "body") return null;

  const info = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;

    const html = el.outerHTML;
    return {
      tagName: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      tabIndex: el.hasAttribute("tabindex")
        ? parseInt(el.getAttribute("tabindex")!, 10)
        : null,
      outerHtml: html.length > 500 ? html.slice(0, 500) + "..." : html,
    };
  });

  if (!info) return null;

  // Get bounding box via Playwright's API for accuracy
  let boundingBox: { x: number; y: number; width: number; height: number } | null = null;
  try {
    const handle = await page.$(selector);
    if (handle) {
      boundingBox = await handle.boundingBox();
      await handle.dispose();
    }
  } catch {
    // Selector may not match uniquely — skip bounding box
  }

  return { selector, ...info, boundingBox };
}

/** Check whether an element is visible and not disabled */
async function isVisibleAndEnabled(handle: ElementHandle): Promise<boolean> {
  return handle.evaluate((el) => {
    const htmlEl = el as HTMLElement;
    if ((htmlEl as HTMLInputElement).disabled) return false;
    if (htmlEl.getAttribute("aria-hidden") === "true") return false;
    if (htmlEl.hidden) return false;
    const style = window.getComputedStyle(htmlEl);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (style.opacity === "0") return false;
    // Check if element has any dimensions
    const rect = htmlEl.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Tab sequence recording (C2-01)
// ---------------------------------------------------------------------------

/**
 * Record the full tab sequence of a page.
 *
 * Tabs through the page starting from the body, recording each focused element.
 * Stops when:
 * - The same element is focused twice (cycle detected)
 * - maxTabs is reached (default 500)
 * - Focus returns to the body element
 */
export async function recordTabSequence(
  page: Page,
  options?: KeyboardCheckOptions,
): Promise<TabSequenceResult> {
  const maxTabs = options?.maxTabs ?? 500;
  const focusStops: FocusStop[] = [];
  const visitedSelectors = new Set<string>();

  let endedByCycle = false;
  let endedByMax = false;
  let totalTabs = 0;

  // Start from the body
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur?.();
    document.body.focus();
  });

  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press("Tab");
    totalTabs++;

    const info = await getFocusedElementInfo(page);

    // Focus returned to body or no focused element
    if (!info) {
      // If we've already recorded stops, try one more Tab to see if focus wraps
      // back to a page element (browser wraps tab order through address bar/body)
      if (focusStops.length > 0 && i + 1 < maxTabs) {
        await page.keyboard.press("Tab");
        totalTabs++;
        i++;
        const wrapInfo = await getFocusedElementInfo(page);
        if (wrapInfo && visitedSelectors.has(wrapInfo.selector)) {
          endedByCycle = true;
        }
      }
      break;
    }

    // Cycle detection: same element focused twice
    if (visitedSelectors.has(info.selector)) {
      endedByCycle = true;
      break;
    }

    visitedSelectors.add(info.selector);
    focusStops.push({
      selector: info.selector,
      tagName: info.tagName,
      role: info.role,
      boundingBox: info.boundingBox,
      tabIndex: info.tabIndex,
      outerHtml: info.outerHtml,
      sequenceIndex: focusStops.length,
    });
  }

  if (totalTabs >= maxTabs && !endedByCycle) {
    endedByMax = true;
  }

  // Find interactive elements not reached by tabbing
  const unreachableElements = await findUnreachableElements(page, visitedSelectors);

  return {
    focusStops,
    unreachableElements,
    totalTabs,
    endedByCycle,
    endedByMax,
  };
}

/**
 * Find interactive elements on the page that were NOT reached during tabbing.
 */
async function findUnreachableElements(
  page: Page,
  reachedSelectors: Set<string>,
): Promise<UnreachableElement[]> {
  const interactiveElements = await page.$$(INTERACTIVE_SELECTOR);
  const unreachable: UnreachableElement[] = [];

  for (const handle of interactiveElements) {
    const visible = await isVisibleAndEnabled(handle);
    if (!visible) {
      await handle.dispose();
      continue;
    }

    const info = await handle.evaluate((el) => {
      const htmlEl = el as HTMLElement;
      // Skip elements explicitly removed from tab order via attribute
      if (htmlEl.getAttribute("tabindex") === "-1") return null;

      const html = htmlEl.outerHTML;
      // Build selector
      let selector: string;
      if (htmlEl.id) {
        selector = `#${CSS.escape(htmlEl.id)}`;
      } else {
        const parts: string[] = [];
        let current: Element | null = htmlEl;
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
        tagName: htmlEl.tagName.toLowerCase(),
        role: htmlEl.getAttribute("role"),
        outerHtml: html.length > 500 ? html.slice(0, 500) + "..." : html,
      };
    });

    if (info && !reachedSelectors.has(info.selector)) {
      unreachable.push(info);
    }

    await handle.dispose();
  }

  return unreachable;
}

// ---------------------------------------------------------------------------
// CheckResult generation (C2-01)
// ---------------------------------------------------------------------------

/**
 * Run tab sequence recording and produce CheckResults for unreachable elements.
 *
 * Each unreachable interactive element produces a CheckResult for WCAG 2.1.1 (Keyboard).
 * The full tab sequence is attached as measured_values for downstream analysis.
 */
export async function runKeyboardChecks(
  page: Page,
  options?: KeyboardCheckOptions,
): Promise<{ results: CheckResult[]; tabSequence: TabSequenceResult }> {
  const tabSequence = await recordTabSequence(page, options);

  const results: CheckResult[] = [];

  // Each unreachable element is a 2.1.1 violation
  for (const unreachable of tabSequence.unreachableElements) {
    results.push({
      element_selector: unreachable.selector,
      element_html: unreachable.outerHtml,
      wcag_criterion: "2.1.1",
      detected_by: "playwright",
      raw_result: {
        type: "unreachable_interactive_element",
        tagName: unreachable.tagName,
        role: unreachable.role,
        totalTabStops: tabSequence.focusStops.length,
        totalTabs: tabSequence.totalTabs,
      },
      measured_values: {
        tab_sequence_length: tabSequence.focusStops.length,
        total_tabs: tabSequence.totalTabs,
        ended_by_cycle: tabSequence.endedByCycle,
        ended_by_max: tabSequence.endedByMax,
      },
    });
  }

  return { results, tabSequence };
}
