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

/**
 * Predicate mirroring whether the browser's native tab order would reach an
 * element. Used to build the "expected" set in findUnreachableElements.
 *
 * Two layers:
 *   1. Playwright's isVisible() — source of truth for CSS visibility (covers
 *      display:none / visibility:hidden on self or any ancestor, empty
 *      bounding boxes, and elements not in the render tree).
 *   2. An ancestor walk for focusability properties CSS visibility doesn't
 *      cover: aria-hidden="true", inert, hidden attr, and <fieldset disabled>.
 *      Also checks self for disabled and negative tabindex.
 *
 * The previous implementation only checked aria-hidden / hidden on the
 * element itself and used getBoundingClientRect as a proxy for visibility,
 * which missed elements hidden by an ancestor's aria-hidden or inert — a
 * common pattern in responsive nav markup (e.g. a mobile menu wrapper that
 * stays in the DOM but is aria-hidden at desktop breakpoints).
 */
async function isKeyboardReachable(handle: ElementHandle): Promise<boolean> {
  // Layer 1: browser-truth visibility.
  if (!(await handle.isVisible())) return false;

  // Layer 2: focusability properties and ancestor state.
  return handle.evaluate((el) => {
    const htmlEl = el as HTMLElement;

    // Self-only checks.
    if ((htmlEl as HTMLInputElement).disabled) return false;
    const ti = htmlEl.getAttribute("tabindex");
    if (ti !== null && parseInt(ti, 10) < 0) return false;

    // Walk self + ancestors — any of these on the chain excludes the element
    // from the browser's tab order.
    let cur: Element | null = htmlEl;
    while (cur && cur !== document.documentElement) {
      const curEl = cur as HTMLElement;
      if (curEl.hasAttribute?.("inert")) return false;
      if (cur.getAttribute("aria-hidden") === "true") return false;
      if (curEl.hidden) return false;
      // <fieldset disabled> disables all descendant form controls natively.
      if (cur.tagName === "FIELDSET" && (cur as HTMLFieldSetElement).disabled) {
        return false;
      }
      cur = cur.parentElement;
    }
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
    const reachable = await isKeyboardReachable(handle);
    if (!reachable) {
      await handle.dispose();
      continue;
    }

    const info = await handle.evaluate((el) => {
      const htmlEl = el as HTMLElement;
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

// ---------------------------------------------------------------------------
// Keyboard trap detection (C2-02)
// ---------------------------------------------------------------------------

/** A detected keyboard trap — focus cycles within a subset of elements */
export interface KeyboardTrap {
  /** Elements in the focus cycle */
  elementsInCycle: { selector: string; tagName: string; role: string | null }[];
  /** Number of Tab presses before the trap was detected */
  tabsBeforeDetected: number;
  /** The selector of the container element (if identifiable) */
  containerSelector: string | null;
  /** Whether this appears to be a custom widget, dropdown, or iframe */
  trapContext: "custom_widget" | "dropdown" | "iframe" | "unknown";
}

export interface TrapDetectionResult {
  /** Detected keyboard traps */
  traps: KeyboardTrap[];
  /** Total Tab presses performed during detection */
  totalTabs: number;
}

export interface TrapCheckOptions {
  /** Maximum Tab presses per element to detect a trap. Default: 50 */
  maxTabsPerElement?: number;
  /** Elements to specifically test for trapping. Default: auto-detect */
  targetSelectors?: string[];
}

/** Selectors for elements likely to contain keyboard traps */
const TRAP_CANDIDATE_SELECTORS = [
  // Custom widgets
  '[role="dialog"]:not([aria-modal="true"])',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="tree"]',
  '[role="tabpanel"]',
  '[role="toolbar"]',
  // Dropdown menus
  '.dropdown',
  '.w-dropdown',
  '[data-dropdown]',
  'details',
  // Embedded content
  'iframe',
  'object',
  'embed',
  // Common custom widget patterns
  '[data-widget]',
  '.custom-select',
  '.accordion',
  '.carousel',
  '.slider',
  '.modal:not([aria-modal="true"])',
  '.popup',
  '.tooltip[tabindex]',
].join(', ');

/**
 * Detect keyboard traps on a page.
 *
 * Tests each candidate element by:
 * 1. Focusing the first tabbable child
 * 2. Pressing Tab repeatedly
 * 3. Checking if focus stays within the element's subtree
 *
 * A trap is detected when focus cycles within a subset of elements
 * without being able to escape. Does NOT flag elements with
 * `role="dialog"` and `aria-modal="true"` (intentional focus trapping).
 */
export async function detectKeyboardTraps(
  page: Page,
  options?: TrapCheckOptions,
): Promise<TrapDetectionResult> {
  const maxTabsPerElement = options?.maxTabsPerElement ?? 50;
  const traps: KeyboardTrap[] = [];
  let totalTabs = 0;

  // Find candidate elements to test
  const candidateSelectors = options?.targetSelectors ?? await findTrapCandidates(page);

  for (const containerSelector of candidateSelectors) {
    const result = await testElementForTrap(page, containerSelector, maxTabsPerElement);
    totalTabs += result.tabsUsed;

    if (result.trap) {
      traps.push(result.trap);
    }
  }

  return { traps, totalTabs };
}

/**
 * Find elements on the page that are candidates for keyboard trap testing.
 */
async function findTrapCandidates(page: Page): Promise<string[]> {
  return page.evaluate((selector) => {
    const elements = document.querySelectorAll(selector);
    const selectors: string[] = [];

    for (const el of elements) {
      // Skip modal dialogs with intentional focus trapping
      if (
        el.getAttribute("role") === "dialog" &&
        el.getAttribute("aria-modal") === "true"
      ) {
        continue;
      }

      // Skip hidden elements
      const style = window.getComputedStyle(el as HTMLElement);
      if (style.display === "none" || style.visibility === "hidden") continue;

      // Build a selector for this element
      let sel: string;
      if (el.id) {
        sel = `#${CSS.escape(el.id)}`;
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
        sel = parts.join(" > ");
      }

      selectors.push(sel);
    }

    return selectors;
  }, TRAP_CANDIDATE_SELECTORS);
}

/**
 * Test a single element for a keyboard trap by tabbing through its children.
 */
async function testElementForTrap(
  page: Page,
  containerSelector: string,
  maxTabs: number,
): Promise<{ trap: KeyboardTrap | null; tabsUsed: number }> {
  let tabsUsed = 0;

  // Check if the element exists and has tabbable children
  const containerHandle = await page.$(containerSelector);
  if (!containerHandle) {
    return { trap: null, tabsUsed: 0 };
  }

  // Determine the trap context
  const trapContext = await containerHandle.evaluate((el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "iframe" || tag === "object" || tag === "embed") return "iframe";
    const role = el.getAttribute("role");
    if (role === "menu" || role === "listbox" || el.classList.contains("dropdown") ||
        el.classList.contains("w-dropdown") || el.hasAttribute("data-dropdown") ||
        tag === "details") return "dropdown";
    return "custom_widget";
  }) as KeyboardTrap["trapContext"];

  // For iframes, test by focusing the iframe and trying to Tab out
  if (trapContext === "iframe") {
    const trap = await testIframeForTrap(page, containerSelector, containerHandle, maxTabs);
    await containerHandle.dispose();
    return { trap, tabsUsed: maxTabs };
  }

  // Find the first tabbable element inside the container
  const firstTabbable = await page.evaluate((sel) => {
    const container = document.querySelector(sel);
    if (!container) return null;

    const tabbable = container.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
      'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );

    if (tabbable.length === 0) return null;

    // Focus the first tabbable element
    (tabbable[0] as HTMLElement).focus();
    return true;
  }, containerSelector);

  await containerHandle.dispose();

  if (!firstTabbable) {
    return { trap: null, tabsUsed: 0 };
  }

  // Now tab through and track if focus stays inside the container
  const focusedInContainer: Map<string, { tagName: string; role: string | null }> = new Map();
  let consecutiveInsideCount = 0;
  let cycleDetected = false;
  const seenSequence: string[] = [];

  for (let i = 0; i < maxTabs; i++) {
    const info = await getFocusedElementInfo(page);
    tabsUsed++;

    if (!info) {
      // Focus left the page — not trapped
      break;
    }

    // Check if focused element is inside the container
    const isInside = await page.evaluate(
      ({ sel, focusedSel }) => {
        const container = document.querySelector(sel);
        const focused = document.querySelector(focusedSel);
        if (!container || !focused) return false;
        return container.contains(focused);
      },
      { sel: containerSelector, focusedSel: info.selector },
    );

    if (isInside) {
      consecutiveInsideCount++;
      focusedInContainer.set(info.selector, {
        tagName: info.tagName,
        role: info.role,
      });
      seenSequence.push(info.selector);

      // Check for cycle: if we've seen the same sequence of selectors repeat
      if (seenSequence.length >= 4) {
        const cycleLen = detectCycleInSequence(seenSequence);
        if (cycleLen > 0 && cycleLen < seenSequence.length) {
          cycleDetected = true;
          break;
        }
      }
    } else {
      // Focus escaped the container — not trapped
      break;
    }

    await page.keyboard.press("Tab");
  }

  if (cycleDetected && focusedInContainer.size >= 1) {
    const elementsInCycle = Array.from(focusedInContainer.entries()).map(
      ([selector, info]) => ({
        selector,
        tagName: info.tagName,
        role: info.role,
      }),
    );

    return {
      trap: {
        elementsInCycle,
        tabsBeforeDetected: tabsUsed,
        containerSelector,
        trapContext,
      },
      tabsUsed,
    };
  }

  return { trap: null, tabsUsed };
}

/**
 * Test an iframe for keyboard trapping.
 */
async function testIframeForTrap(
  page: Page,
  containerSelector: string,
  handle: ElementHandle,
  maxTabs: number,
): Promise<KeyboardTrap | null> {
  // Focus the iframe
  try {
    await handle.focus();
  } catch {
    return null;
  }

  // Tab within the iframe and check if focus can escape
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press("Tab");

    const isStillInIframe = await page.evaluate((sel) => {
      const iframe = document.querySelector(sel);
      const active = document.activeElement;
      if (!iframe || !active) return false;
      return active === iframe || iframe.contains(active);
    }, containerSelector);

    if (!isStillInIframe) {
      // Focus escaped — not trapped
      return null;
    }
  }

  // If we exhausted maxTabs and focus is still in the iframe, it's a trap
  const outerHtml = await handle.evaluate((el) => {
    const html = (el as HTMLElement).outerHTML;
    return html.length > 500 ? html.slice(0, 500) + "..." : html;
  });

  return {
    elementsInCycle: [{
      selector: containerSelector,
      tagName: "iframe",
      role: null,
    }],
    tabsBeforeDetected: maxTabs,
    containerSelector,
    trapContext: "iframe",
  };
}

/**
 * Detect a repeating cycle in a sequence of selectors.
 * Returns the cycle length if found, 0 otherwise.
 */
function detectCycleInSequence(sequence: string[]): number {
  const len = sequence.length;

  // Try cycle lengths from 1 to half the sequence length
  for (let cycleLen = 1; cycleLen <= Math.floor(len / 2); cycleLen++) {
    let isCycle = true;

    // Check if the last `cycleLen` elements match the previous `cycleLen` elements
    for (let j = 0; j < cycleLen; j++) {
      if (sequence[len - 1 - j] !== sequence[len - 1 - cycleLen - j]) {
        isCycle = false;
        break;
      }
    }

    if (isCycle) {
      return cycleLen;
    }
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Trap CheckResult generation (C2-02)
// ---------------------------------------------------------------------------

/**
 * Run keyboard trap detection and produce CheckResults.
 *
 * Each detected trap produces a CheckResult for WCAG 2.1.2 (No Keyboard Trap).
 */
export async function runTrapChecks(
  page: Page,
  options?: TrapCheckOptions,
): Promise<CheckResult[]> {
  const { traps, totalTabs } = await detectKeyboardTraps(page, options);

  return traps.map((trap) => ({
    element_selector: trap.containerSelector ?? trap.elementsInCycle[0].selector,
    element_html: trap.elementsInCycle.map((e) => e.selector).join(", "),
    wcag_criterion: "2.1.2",
    detected_by: "playwright" as const,
    raw_result: {
      type: "keyboard_trap",
      trapContext: trap.trapContext,
      elementsInCycle: trap.elementsInCycle,
      tabsBeforeDetected: trap.tabsBeforeDetected,
      containerSelector: trap.containerSelector,
    },
    measured_values: {
      elements_in_cycle: trap.elementsInCycle.length,
      tabs_before_detected: trap.tabsBeforeDetected,
      trap_context: trap.trapContext,
      total_detection_tabs: totalTabs,
    },
  }));
}
