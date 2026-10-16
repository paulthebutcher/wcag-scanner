import type { Page, ElementHandle } from "playwright";
import { pacedReload } from "../../core/etiquette.js";
import type { CheckResult } from "../../types.js";
import { vendorSelectorLists, type EmbedSweepStop } from "../../core/third-party.js";

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
  /** Set on the single stop recorded for a third-party embed the sweep stepped over (P2-034) */
  embed?: { vendor: string; vendor_name: string; container: string };
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
  /** Why the sweep stopped */
  exitReason: TabSweepExitReason;
  /** Selector of the last element that had focus before the sweep stopped */
  lastFocusedSelector: string | null;
  /** Keyboard-reachable interactive elements on the page (reached or not), embed contents left out */
  candidateCount: number;
  /** Controls inside third-party embed containers, not counted as candidates */
  candidatesInsideEmbeds: number;
  /** The page's last candidate (document order) was focused during the sweep */
  lastCandidateReached: boolean;
  /** Third-party embeds the sweep entered, one entry each (P2-034) */
  embeds: EmbedSweepStop[];
}

/**
 * cycle: focus returned to an earlier element (a full lap).
 * max: the Tab press limit was reached.
 * body_focus: focus landed on <body> MAX_CONSECUTIVE_BODY times in a row.
 * repeat_cap: focus stayed on one element (an embedded frame) too long.
 */
/** embed_focus: a third-party embed kept focus after the sweep tried to move past it. */
export type TabSweepExitReason = "cycle" | "max" | "body_focus" | "repeat_cap" | "embed_focus";

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
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;

    // Build a path from tag + nth-of-type
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
 * Tabs through the page recording each distinct focused element. Stops when:
 * - The same element is focused twice (cycle detected — full loop traversed)
 * - maxTabs is reached (default 500)
 * - Too many consecutive body-focus presses with no page element in between
 *
 * Body-focus is NOT a stop condition. The browser's tab cycle naturally
 * passes through body (once per lap) and then wraps to the first tabbable
 * element in document order. If we bailed on the first body-hit we'd miss
 * every element that precedes the browser's initial focus anchor — a real
 * problem on pages with `autofocus` or pages where the user's last focused
 * element wasn't the first tab stop (e.g. Webflow password pages, where
 * autofocus on #pass makes the FIRST Tab press advance past it to the
 * submit button).
 *
 * To mirror what a real keyboard user would experience, we also press
 * Shift+Tab once before the forward sweep to move the focus anchor to
 * "before" the first tab stop, regardless of where autofocus left it.
 */
export async function recordTabSequence(
  page: Page,
  options?: KeyboardCheckOptions,
): Promise<TabSequenceResult> {
  const maxTabs = options?.maxTabs ?? 500;
  const focusStops: FocusStop[] = [];
  const visitedSelectors = new Set<string>();
  // Third-party embeds are stepped over, one stop each (P2-034)
  const vendors = vendorSelectorLists();
  const embeds: EmbedSweepStop[] = [];
  const embedEntries = new Map<string, number>();
  const MAX_EMBED_REENTRIES = 3;

  let endedByCycle = false;
  let endedByMax = false;
  let totalTabs = 0;
  let exitReason: TabSweepExitReason = "max";
  let lastFocusedSelector: string | null = null;

  // Reset focus. Calling body.focus() alone doesn't always reset the
  // browser's sequential-focus-navigation starting point; if something was
  // autofocused, Tab advances from *there*, not from the top of document
  // order. Pressing Shift+Tab after focusing body moves the anchor off the
  // page entirely (into chrome), so the next Tab enters at document start.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur?.();
    document.body.focus();
  });
  await page.keyboard.press("Shift+Tab");

  let consecutiveBodyFocuses = 0;
  const MAX_CONSECUTIVE_BODY = 3;
  // Tabbing through the controls inside an iframe (a YouTube player, a
  // form embed) leaves document.activeElement on the iframe itself, so it
  // reads as the same element several presses in a row. That is not a lap.
  let lastSelector: string | null = null;
  let consecutiveRepeats = 0;
  const MAX_CONSECUTIVE_REPEATS = 50;

  sweep: for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press("Tab");
    totalTabs++;

    let info = await getFocusedElementInfo(page);

    if (!info) {
      // Focus is on body — the browser passes through body between laps.
      // Don't break; keep tabbing so we sweep the full cycle. But if we see
      // body repeatedly with no page element in between, the page has
      // nothing focusable left and we should stop.
      consecutiveBodyFocuses++;
      if (consecutiveBodyFocuses >= MAX_CONSECUTIVE_BODY) {
        exitReason = "body_focus";
        break;
      }
      lastSelector = null;
      continue;
    }
    consecutiveBodyFocuses = 0;
    lastFocusedSelector = info.selector;

    // A third-party embed (an Instagram or TikTok iframe, a vendor widget):
    // record it once, then continue from the first control after it instead
    // of tabbing through its internals (P2-034). Chained embeds are stepped
    // over one after another.
    let stepped = false;
    for (let chained = 0; chained < 10; chained++) {
      const embed = await stepOverEmbed(page, vendors);
      if (!embed) break;
      stepped = true;
      const key = `embed:${embed.container}`;
      const entries = (embedEntries.get(key) ?? 0) + 1;
      embedEntries.set(key, entries);
      let stop = embeds.find((e) => e.container === embed.container);
      if (!stop) {
        stop = { vendor: embed.vendor, vendor_name: embed.vendor_name, container: embed.container, focusables_inside: embed.focusables_inside, kept_focus: false };
        embeds.push(stop);
        visitedSelectors.add(key);
        focusStops.push({
          selector: embed.container, tagName: embed.tagName, role: null, boundingBox: null, tabIndex: null,
          outerHtml: embed.opening, sequenceIndex: focusStops.length,
          embed: { vendor: embed.vendor, vendor_name: embed.vendor_name, container: embed.container },
        });
      }
      if (!embed.moved) {
        // Nothing focusable after the embed: the lap is complete
        endedByCycle = true;
        exitReason = "cycle";
        break sweep;
      }
      if (embed.still_inside || entries > MAX_EMBED_REENTRIES) {
        // The embed holds on to focus (or keeps taking it back): the rest
        // of the page was not tested; reported as a possible trap
        stop.kept_focus = true;
        exitReason = "embed_focus";
        break sweep;
      }
      info = await getFocusedElementInfo(page);
      if (!info) break;
    }
    if (!info) {
      lastSelector = null;
      continue;
    }
    if (stepped) {
      lastSelector = null;
      lastFocusedSelector = info.selector;
    }

    if (info.selector === lastSelector) {
      // Still inside the same embedded document. Past the cap, focus is
      // stuck there; the keyboard-trap check reports that case.
      consecutiveRepeats++;
      if (consecutiveRepeats >= MAX_CONSECUTIVE_REPEATS) {
        exitReason = "repeat_cap";
        break;
      }
      continue;
    }
    consecutiveRepeats = 0;
    lastSelector = info.selector;

    // Cycle detection: an earlier element focused again — we've completed a lap.
    if (visitedSelectors.has(info.selector)) {
      endedByCycle = true;
      exitReason = "cycle";
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
  const { unreachable: unreachableElements, candidateCount, candidatesInsideEmbeds, lastCandidateReached } = await findUnreachableElements(page, visitedSelectors);

  return {
    focusStops,
    unreachableElements,
    totalTabs,
    endedByCycle,
    endedByMax,
    exitReason,
    lastFocusedSelector,
    candidateCount,
    candidatesInsideEmbeds,
    lastCandidateReached,
    embeds,
  };
}

/** What stepOverEmbed found and did for the focused element */
interface EmbedStep {
  vendor: string;
  vendor_name: string;
  container: string;
  tagName: string;
  opening: string;
  focusables_inside: number | null;
  /** A keyboard-reachable control after the container existed and was focused */
  moved: boolean;
  /** Focus is still inside the container after that */
  still_inside: boolean;
}

/**
 * If the focused element is a third-party embed container or inside one,
 * move focus to the first keyboard-reachable control after the container
 * and describe the embed; null when focus is on the page's own content.
 */
async function stepOverEmbed(page: Page, vendors: Array<{ id: string; name: string; selector: string }>): Promise<EmbedStep | null> {
  if (vendors.length === 0) return null;
  return page.evaluate(async ({ vendors, interactive }) => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    let container: Element | null = null;
    let vendor: { id: string; name: string; selector: string } | null = null;
    for (const v of vendors) {
      const c = el.matches(v.selector) ? el : el.closest(v.selector);
      if (c) { container = c; vendor = v; break; }
    }
    if (!container || !vendor) return null;
    const isFrame = container.tagName === "IFRAME";
    const focusablesInside = isFrame ? null : container.querySelectorAll(interactive).length;
    let next: HTMLElement | null = null;
    for (const cand of Array.from(document.querySelectorAll(interactive)) as HTMLElement[]) {
      if (container.contains(cand)) continue;
      if (!(container.compareDocumentPosition(cand) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      if (cand.getAttribute("tabindex") === "-1") continue;
      if ((cand as HTMLInputElement).disabled) continue;
      if (cand.closest("[inert], [aria-hidden=\"true\"], [hidden]")) continue;
      const style = window.getComputedStyle(cand);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (cand.getClientRects().length === 0) continue;
      next = cand;
      break;
    }
    if (next) {
      next.focus();
      // An embed that takes focus back usually does so from a timer
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const active = document.activeElement;
    const stillInside = !!active && (active === container || container.contains(active));
    const html = container.outerHTML;
    const opening = html.slice(0, html.indexOf(">") + 1);
    let desc: string;
    if (container.id && document.querySelectorAll(`#${CSS.escape(container.id)}`).length === 1) {
      desc = `#${CSS.escape(container.id)}`;
    } else {
      const name = container.getAttribute("name");
      const src = container.getAttribute("src");
      const attr = name ? `[name="${name}"]` : src ? `[src="${src.slice(0, 80)}"]` : "";
      let classes = "";
      for (const c of Array.from(container.classList).slice(0, 2)) classes += `.${c}`;
      desc = `${container.tagName.toLowerCase()}${classes}${attr}`;
    }
    return {
      vendor: vendor.id, vendor_name: vendor.name, container: desc, tagName: container.tagName.toLowerCase(),
      opening: opening.length > 300 ? `${opening.slice(0, 300)}…` : opening,
      focusables_inside: focusablesInside, moved: next !== null, still_inside: stillInside,
    };
  }, { vendors, interactive: INTERACTIVE_SELECTOR });
}

/**
 * Find interactive elements on the page that were NOT reached during tabbing.
 */
async function findUnreachableElements(
  page: Page,
  reachedSelectors: Set<string>,
): Promise<{ unreachable: UnreachableElement[]; candidateCount: number; candidatesInsideEmbeds: number; lastCandidateReached: boolean }> {
  const interactiveElements = await page.$$(INTERACTIVE_SELECTOR);
  const unreachable: UnreachableElement[] = [];
  let candidateCount = 0;
  // Controls inside third-party embeds are the vendor's; the sweep steps
  // over them, so they are neither candidates nor unreachable (P2-034)
  const embedSelector = vendorSelectorLists().map((v) => v.selector).join(", ");
  let candidatesInsideEmbeds = 0;
  let lastCandidateSelector: string | null = null;

  for (const handle of interactiveElements) {
    if (embedSelector) {
      const inEmbed = await handle.evaluate((el, sel) => el.closest(sel) !== null, embedSelector);
      if (inEmbed) {
        candidatesInsideEmbeds++;
        await handle.dispose();
        continue;
      }
    }
    const reachable = await isKeyboardReachable(handle);
    if (!reachable) {
      await handle.dispose();
      continue;
    }
    candidateCount++;

    const info = await handle.evaluate((el) => {
      const htmlEl = el as HTMLElement;
      const html = htmlEl.outerHTML;
      // Build selector
      let selector: string;
      if (htmlEl.id && document.querySelectorAll(`#${CSS.escape(htmlEl.id)}`).length === 1) {
        selector = `#${CSS.escape(htmlEl.id)}`;
      } else {
        const parts: string[] = [];
        let current: Element | null = htmlEl;
        while (current && current !== document.documentElement) {
          let part = current.tagName.toLowerCase();
          if (current.id && document.querySelectorAll(`#${CSS.escape(current.id)}`).length === 1) {
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

    if (info) lastCandidateSelector = info.selector;
    if (info && !reachedSelectors.has(info.selector)) {
      unreachable.push(info);
    }

    await handle.dispose();
  }

  return {
    unreachable, candidateCount, candidatesInsideEmbeds,
    lastCandidateReached: lastCandidateSelector === null || reachedSelectors.has(lastCandidateSelector),
  };
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
): Promise<{
  results: CheckResult[];
  tabSequence: TabSequenceResult;
  /** Set when the sweep stayed truncated after a retry: the check is partial on this page */
  partialReason: string | null;
  /** Whether the page was reloaded and swept a second time */
  retried: boolean;
  /** How the first sweep ended when it was retried (shows what stole focus) */
  firstSweep: { exitReason: TabSweepExitReason; stops: number; lastFocusedSelector: string | null } | null;
  /** One-line description of the sweep, for coverage */
  sweepSummary: string;
}> {
  let tabSequence = await recordTabSequence(page, options);
  let retried = false;
  let firstSweep: { exitReason: TabSweepExitReason; stops: number; lastFocusedSelector: string | null } | null = null;

  // A sweep that stops on <body> focus or a stuck element after reaching
  // fewer than half of the page's controls usually means something stole
  // focus (intermittently), not that the rest is unreachable. Retry once on
  // a fresh load.
  if (isTruncatedSweep(tabSequence)) {
    retried = true;
    firstSweep = {
      exitReason: tabSequence.exitReason,
      stops: tabSequence.focusStops.length,
      lastFocusedSelector: tabSequence.lastFocusedSelector,
    };
    await pacedReload(page, { waitUntil: "load", timeout: 30_000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    tabSequence = await recordTabSequence(page, options);
  }

  const sweepValues = {
    tab_sequence_length: tabSequence.focusStops.length,
    total_tabs: tabSequence.totalTabs,
    ended_by_cycle: tabSequence.endedByCycle,
    ended_by_max: tabSequence.endedByMax,
    exit_reason: tabSequence.exitReason,
    last_focused_selector: tabSequence.lastFocusedSelector,
    candidate_count: tabSequence.candidateCount,
    candidates_inside_embeds: tabSequence.candidatesInsideEmbeds,
    embeds_entered: tabSequence.embeds.length,
    embed_vendors: Array.from(new Set(tabSequence.embeds.map((e) => e.vendor))),
    retried,
    ...(firstSweep ? {
      first_sweep_exit_reason: firstSweep.exitReason,
      first_sweep_stops: firstSweep.stops,
      first_sweep_last_focused: firstSweep.lastFocusedSelector,
    } : {}),
  };
  const firstSweepText = firstSweep
    ? `; first sweep ${firstSweep.exitReason} after ${firstSweep.stops} stops, last focused ${firstSweep.lastFocusedSelector ?? "nothing"}`
    : "";
  const embedCounts = new Map<string, number>();
  for (const e of tabSequence.embeds) embedCounts.set(e.vendor_name, (embedCounts.get(e.vendor_name) ?? 0) + 1);
  const embedsText = tabSequence.embeds.length > 0
    ? `, stepped over ${tabSequence.embeds.length} third-party embed(s) (${Array.from(embedCounts, ([v, n]) => `${v} ×${n}`).join(", ")}; ${tabSequence.candidatesInsideEmbeds} control(s) inside)`
    : "";
  const sweepSummary = `sweep ended by ${tabSequence.exitReason} after ${tabSequence.focusStops.length} stops, ` +
    `last focused ${tabSequence.lastFocusedSelector ?? "nothing"}, retried ${retried ? "yes" : "no"}${firstSweepText}${embedsText}`;

  // An embed that kept focus after the sweep tried to move past it: a
  // possible keyboard trap (2.1.2), for review (needs_review in confidence.ts)
  const trapResults: CheckResult[] = tabSequence.embeds.filter((e) => e.kept_focus).map((e) => ({
    element_selector: e.container,
    element_html: tabSequence.focusStops.find((st) => st.embed?.container === e.container)?.outerHtml ?? `<${e.vendor} embed>`,
    wcag_criterion: "2.1.2",
    detected_by: "playwright",
    raw_result: {
      type: "possible_embed_focus_trap",
      vendor: e.vendor,
      vendorName: e.vendor_name,
      container: e.container,
      description: `Focus stayed in the ${e.vendor_name} embed after the sweep moved it to the next control; a keyboard user may not be able to leave the embed`,
    },
    measured_values: { failure_type: "possible_embed_focus_trap", vendor: e.vendor, container: e.container, exit_reason: tabSequence.exitReason },
  }));

  // Still truncated: the unreached elements were never tested, so report
  // the sweep for review instead of calling them unreachable.
  if (isTruncatedSweep(tabSequence)) {
    const reached = tabSequence.candidateCount - tabSequence.unreachableElements.length;
    const partialReason = `tab sweep stopped early (${tabSequence.exitReason}) after ${tabSequence.focusStops.length} stops, ` +
      `${reached} of ${tabSequence.candidateCount} controls reached, last focused ${tabSequence.lastFocusedSelector ?? "nothing"}; retried once${firstSweepText}`;
    return {
      results: [...trapResults, {
        element_selector: tabSequence.lastFocusedSelector ?? "body",
        element_html: `<tab-sweep-summary exit-reason="${tabSequence.exitReason}" stops="${tabSequence.focusStops.length}" candidates="${tabSequence.candidateCount}"/>`,
        wcag_criterion: "2.1.1",
        detected_by: "playwright",
        raw_result: {
          type: "truncated_tab_sweep",
          exitReason: tabSequence.exitReason,
          stopsReached: tabSequence.focusStops.length,
          lastFocusedSelector: tabSequence.lastFocusedSelector,
          description: partialReason,
        },
        measured_values: { ...sweepValues, controls_reached: reached },
      }],
      tabSequence,
      partialReason,
      retried,
      firstSweep,
      sweepSummary,
    };
  }

  const results: CheckResult[] = [...trapResults];

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
      measured_values: { ...sweepValues },
    });
  }

  return { results, tabSequence, partialReason: null, retried, firstSweep, sweepSummary };
}

/**
 * A sweep cut short before a full lap: it stopped on body focus or a stuck
 * element having reached fewer than half of the page's candidate controls,
 * it closed a lap before the last control was reached, or an embed kept
 * focus. Unreached controls were never tested, so they are not reported as
 * unreachable.
 */
export function isTruncatedSweep(seq: TabSequenceResult): boolean {
  // An embed that kept focus: the rest of the page was not tested
  if (seq.exitReason === "embed_focus") return true;
  if (seq.candidateCount === 0) return false;
  // A lap that closed before the page's last control was reached (P2-034):
  // something sent focus back, so the controls after it were never tested
  if (seq.exitReason === "cycle") return !seq.lastCandidateReached;
  if (seq.exitReason !== "body_focus" && seq.exitReason !== "repeat_cap") return false;
  const reached = seq.candidateCount - seq.unreachableElements.length;
  return reached / seq.candidateCount < 0.5;
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
  const embeds = vendorSelectorLists().map((v) => v.selector).join(", ");
  return page.evaluate(({ selector, embeds }) => {
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

      // Third-party embed containers and their contents are not trap
      // candidates; the keyboard sweep reports an embed that keeps focus
      if (embeds && (el.matches(embeds) || el.closest(embeds))) continue;

      // Build a selector for this element
      let sel: string;
      if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
        sel = `#${CSS.escape(el.id)}`;
      } else {
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
  }, { selector: TRAP_CANDIDATE_SELECTORS, embeds });
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
