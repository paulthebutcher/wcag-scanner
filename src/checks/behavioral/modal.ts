import type { Page } from "playwright";
import type { CheckResult, InteractionState, InteractionTrigger } from "../../types.js";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModalTrigger {
  /** CSS selector for the trigger element */
  selector: string;
  /** What type of trigger pattern was detected */
  type: "aria_haspopup" | "ix2_trigger" | "native_dialog" | "custom_overlay";
  /** Outer HTML of the trigger (truncated) */
  outerHtml: string;
  /** Selector of the modal target (from aria-controls, data attributes, etc.) */
  targetSelector: string | null;
}

export interface ModalTestResult {
  trigger: ModalTrigger;
  /** Whether clicking the trigger opened a modal/overlay */
  opened: boolean;
  /** Whether focus moved into the modal after opening */
  focusMovedIn: boolean;
  /** Whether focus was trapped within the modal */
  focusTrapped: boolean;
  /** Whether Escape key closed the modal */
  escapeCloses: boolean;
  /** Whether focus returned to the trigger after closing */
  focusReturnedToTrigger: boolean;
  /** Captured interaction state for the modal open action */
  interactionState: Omit<InteractionState, "page_snapshot_id"> | null;
  /** List of detected failures */
  failures: ModalFailure[];
}

export interface ModalFailure {
  type: "focus_not_moved" | "focus_not_trapped" | "escape_not_close" | "focus_not_returned";
  criterion: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Modal trigger detection
// ---------------------------------------------------------------------------

/** Selectors for elements that commonly trigger modals */
const MODAL_TRIGGER_SELECTORS = [
  // ARIA patterns
  '[aria-haspopup="dialog"]',
  '[aria-haspopup="true"]',
  // Webflow IX2 patterns — divs/buttons with data-w-id that toggle display
  '[data-w-id][data-modal-trigger]',
  // Common custom patterns
  '[data-modal]',
  '[data-open-modal]',
  '[data-toggle="modal"]',
  '[data-bs-toggle="modal"]',
  '[data-overlay-trigger]',
  '.modal-trigger',
  '.open-modal',
  // Buttons/links referencing a modal target
  '[data-target^="#"][data-target*="modal"]',
  '[href^="#"][data-modal]',
].join(", ");

/**
 * Find elements on the page that trigger modals or overlays.
 */
export async function findModalTriggers(page: Page): Promise<ModalTrigger[]> {
  const triggers = await page.evaluate((selectorStr) => {
    const results: Array<{
      selector: string;
      type: string;
      outerHtml: string;
      targetSelector: string | null;
    }> = [];

    // Helper: build a CSS selector for an element
    function buildSelector(el: Element): string {
      if (el.id) return `#${CSS.escape(el.id)}`;
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
    }

    // 1. Explicit ARIA / data-attribute triggers
    const explicitTriggers = document.querySelectorAll(selectorStr);
    for (const el of explicitTriggers) {
      const htmlEl = el as HTMLElement;
      const style = window.getComputedStyle(htmlEl);
      if (style.display === "none" || style.visibility === "hidden") continue;

      let type = "custom_overlay";
      if (htmlEl.getAttribute("aria-haspopup")) type = "aria_haspopup";
      else if (htmlEl.hasAttribute("data-w-id")) type = "ix2_trigger";

      let targetSelector: string | null = null;
      const controls = htmlEl.getAttribute("aria-controls");
      if (controls) targetSelector = `#${CSS.escape(controls)}`;
      const dataTarget = htmlEl.getAttribute("data-target") || htmlEl.getAttribute("data-bs-target");
      if (dataTarget) targetSelector = dataTarget;

      const html = htmlEl.outerHTML;
      results.push({
        selector: buildSelector(htmlEl),
        type,
        outerHtml: html.length > 500 ? html.slice(0, 500) + "..." : html,
        targetSelector,
      });
    }

    // 2. Webflow IX2 triggers — buttons/divs with data-w-id that might toggle modals
    // Look for elements with data-w-id that are near modal-like containers
    const ix2Elements = document.querySelectorAll("[data-w-id]");
    for (const el of ix2Elements) {
      const htmlEl = el as HTMLElement;
      // Skip if already found
      if (results.some((r) => r.selector === buildSelector(htmlEl))) continue;

      const style = window.getComputedStyle(htmlEl);
      if (style.display === "none" || style.visibility === "hidden") continue;

      // Only consider clickable-looking elements (buttons, links, divs with cursor pointer)
      const tag = htmlEl.tagName.toLowerCase();
      const isClickable = tag === "button" || tag === "a" ||
        style.cursor === "pointer" ||
        htmlEl.getAttribute("role") === "button";

      if (!isClickable) continue;

      // Check if there's a sibling or nearby element that looks like a modal
      const parent = htmlEl.parentElement;
      if (!parent) continue;

      const hasModalSibling = parent.querySelector(
        '.modal, .overlay, .popup, .lightbox, .w-lightbox, ' +
        '[role="dialog"], [aria-modal], .modal-overlay, .modal-wrapper',
      );

      if (hasModalSibling) {
        const html = htmlEl.outerHTML;
        results.push({
          selector: buildSelector(htmlEl),
          type: "ix2_trigger",
          outerHtml: html.length > 500 ? html.slice(0, 500) + "..." : html,
          targetSelector: hasModalSibling.id ? `#${CSS.escape(hasModalSibling.id)}` : null,
        });
      }
    }

    // 3. Native <dialog> elements with associated triggers
    const dialogs = document.querySelectorAll("dialog");
    for (const dialog of dialogs) {
      const dialogId = dialog.id;
      if (!dialogId) continue;

      // Find buttons that reference this dialog
      const openers = document.querySelectorAll(
        `[data-dialog="${CSS.escape(dialogId)}"], ` +
        `[aria-controls="${CSS.escape(dialogId)}"], ` +
        `[data-target="#${CSS.escape(dialogId)}"]`,
      );

      for (const opener of openers) {
        const html = opener.outerHTML;
        results.push({
          selector: buildSelector(opener),
          type: "native_dialog",
          outerHtml: html.length > 500 ? html.slice(0, 500) + "..." : html,
          targetSelector: `#${CSS.escape(dialogId)}`,
        });
      }
    }

    return results;
  }, MODAL_TRIGGER_SELECTORS);

  return triggers.map((t) => ({
    selector: t.selector,
    type: t.type as ModalTrigger["type"],
    outerHtml: t.outerHtml,
    targetSelector: t.targetSelector,
  }));
}

// ---------------------------------------------------------------------------
// Modal testing
// ---------------------------------------------------------------------------

/**
 * Test a single modal trigger: click to open, verify focus management,
 * Escape to close, verify focus returns.
 */
export async function testModal(
  page: Page,
  trigger: ModalTrigger,
): Promise<ModalTestResult> {
  const failures: ModalFailure[] = [];
  let opened = false;
  let focusMovedIn = false;
  let focusTrapped = false;
  let escapeCloses = false;
  let focusReturnedToTrigger = false;
  let interactionState: Omit<InteractionState, "page_snapshot_id"> | null = null;

  // Capture DOM state before opening
  const domBefore = await page.evaluate(() => document.body.innerHTML.length);

  // Click the trigger to open the modal
  try {
    await page.click(trigger.selector, { timeout: 3000 });
  } catch {
    // Trigger not clickable
    return {
      trigger, opened, focusMovedIn, focusTrapped,
      escapeCloses, focusReturnedToTrigger, interactionState, failures,
    };
  }

  // Wait for any animations
  await page.waitForTimeout(300);

  // Check if something opened (new visible elements, overlay, dialog)
  const openState = await page.evaluate((triggerData) => {
    // Check for visible modal/overlay elements
    const modalSelectors = [
      '[role="dialog"]', '[aria-modal="true"]', 'dialog[open]',
      '.modal.active', '.modal.show', '.modal.open', '.modal.visible',
      '.overlay.active', '.overlay.show', '.overlay.open', '.overlay.visible',
      '.popup.active', '.popup.show', '.popup.open', '.popup.visible',
      '.w-lightbox-show', '.w-lightbox-overlay',
    ];

    let modalEl: Element | null = null;
    for (const sel of modalSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const style = window.getComputedStyle(el as HTMLElement);
        if (style.display !== "none" && style.visibility !== "hidden") {
          modalEl = el;
          break;
        }
      }
      if (modalEl) break;
    }

    // Also check if the explicit target is now visible
    if (!modalEl && triggerData.targetSelector) {
      const target = document.querySelector(triggerData.targetSelector);
      if (target) {
        const style = window.getComputedStyle(target as HTMLElement);
        if (style.display !== "none" && style.visibility !== "hidden") {
          modalEl = target;
        }
      }
    }

    // Check if DOM size changed significantly (something appeared)
    const domAfter = document.body.innerHTML.length;

    // Get current focus
    const active = document.activeElement;
    const focusSelector = active && active !== document.body
      ? (active.id ? `#${CSS.escape(active.id)}` : active.tagName.toLowerCase())
      : "body";

    // Get newly visible elements
    const newElements: string[] = [];
    if (modalEl) {
      if (modalEl.id) newElements.push(`#${CSS.escape(modalEl.id)}`);
      else newElements.push(modalEl.tagName.toLowerCase());
    }

    return {
      modalFound: !!modalEl,
      focusSelector,
      focusInModal: modalEl ? modalEl.contains(active) : false,
      newElements,
      domSizeChange: domAfter,
    };
  }, { targetSelector: trigger.targetSelector });

  opened = openState.modalFound;

  if (!opened) {
    // Check if DOM changed significantly (modal might be added dynamically)
    const domAfter = openState.domSizeChange;
    if (Math.abs(domAfter - domBefore) > 100) {
      opened = true; // Something changed, likely a modal
    }
  }

  if (!opened) {
    // Nothing opened — can't test focus management
    return {
      trigger, opened, focusMovedIn, focusTrapped,
      escapeCloses, focusReturnedToTrigger, interactionState, failures,
    };
  }

  // Capture InteractionState
  interactionState = {
    id: randomUUID(),
    trigger: {
      type: "click",
      target: trigger.selector,
    },
    dom_diff: "",
    screenshot: "",
    new_elements_visible: openState.newElements,
    focus_element: openState.focusSelector,
  };

  // Check if focus moved into the modal
  focusMovedIn = openState.focusInModal;
  if (!focusMovedIn) {
    // Focus might be on the modal container itself
    focusMovedIn = openState.focusSelector !== "body" &&
      openState.focusSelector !== trigger.selector;
  }

  if (!focusMovedIn) {
    failures.push({
      type: "focus_not_moved",
      criterion: "2.4.3",
      description: `Focus did not move to modal after opening. Focus remained on: ${openState.focusSelector}`,
    });
  }

  // Tab through to check focus trapping
  focusTrapped = await checkFocusTrapping(page, trigger);
  if (!focusTrapped && focusMovedIn) {
    failures.push({
      type: "focus_not_trapped",
      criterion: "2.1.2",
      description: "Focus is not trapped within the open modal. Users can Tab behind the modal to background content.",
    });
  }

  // Press Escape to close the modal
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // Check if modal closed
  const closeState = await page.evaluate((triggerSel) => {
    // Check if modal-like elements are still visible
    const modalSelectors = [
      '[role="dialog"]', '[aria-modal="true"]', 'dialog[open]',
      '.modal.active', '.modal.show', '.modal.open', '.modal.visible',
      '.overlay.active', '.overlay.show', '.overlay.open', '.overlay.visible',
      '.popup.active', '.popup.show', '.popup.open', '.popup.visible',
    ];

    let modalStillVisible = false;
    for (const sel of modalSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const style = window.getComputedStyle(el as HTMLElement);
        if (style.display !== "none" && style.visibility !== "hidden") {
          modalStillVisible = true;
          break;
        }
      }
      if (modalStillVisible) break;
    }

    // Check if focus returned to the trigger
    const active = document.activeElement;
    const triggerEl = document.querySelector(triggerSel);
    const focusOnTrigger = active === triggerEl;

    return { modalStillVisible, focusOnTrigger };
  }, trigger.selector);

  escapeCloses = !closeState.modalStillVisible;

  if (!escapeCloses) {
    failures.push({
      type: "escape_not_close",
      criterion: "2.1.2",
      description: "Modal did not close when Escape was pressed. Keyboard users may be trapped.",
    });
  }

  // Check focus return
  focusReturnedToTrigger = closeState.focusOnTrigger;
  if (escapeCloses && !focusReturnedToTrigger) {
    failures.push({
      type: "focus_not_returned",
      criterion: "2.4.3",
      description: "Focus did not return to the trigger element after modal was closed.",
    });
  }

  return {
    trigger, opened, focusMovedIn, focusTrapped,
    escapeCloses, focusReturnedToTrigger, interactionState, failures,
  };
}

/**
 * Check if focus is properly trapped within a modal by tabbing through.
 * Returns true if focus stays within the modal for several tab presses.
 */
async function checkFocusTrapping(
  page: Page,
  trigger: ModalTrigger,
): Promise<boolean> {
  const maxTabs = 20;
  const focusedSelectors: string[] = [];

  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press("Tab");

    const focusInfo = await page.evaluate(() => {
      const active = document.activeElement;
      if (!active || active === document.body) return { selector: "body", inModal: false };

      const selector = active.id ? `#${CSS.escape(active.id)}` : active.tagName.toLowerCase();

      // Check if inside a modal container
      const inModal = !!active.closest(
        '[role="dialog"], [aria-modal="true"], dialog, .modal, .overlay, .popup',
      );

      return { selector, inModal };
    });

    if (!focusInfo.inModal && focusInfo.selector !== "body") {
      // Focus escaped the modal
      return false;
    }

    focusedSelectors.push(focusInfo.selector);

    // If we've tabbed through at least 3 elements and focus is still in the modal
    if (i >= 3) {
      return true;
    }
  }

  // If focus stayed in modal for all tabs, it's trapped
  return focusedSelectors.length > 0 && focusedSelectors.every(
    (_, idx) => idx < focusedSelectors.length,
  );
}

// ---------------------------------------------------------------------------
// Cleanup helper
// ---------------------------------------------------------------------------

/**
 * Attempt to dismiss any open modals/overlays so the next test starts clean.
 * Tries Escape key, then hides any visible modal-like elements via style.
 */
async function dismissOpenModals(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // Force-hide any remaining visible modals via JS
  await page.evaluate(() => {
    const selectors = [
      '[role="dialog"]', '[aria-modal="true"]', 'dialog[open]',
      '.modal', '.overlay', '.popup', '.modal-overlay',
      '.w-lightbox-overlay',
    ];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const style = window.getComputedStyle(el as HTMLElement);
        if (style.display !== "none" && style.visibility !== "hidden") {
          (el as HTMLElement).style.display = "none";
          el.classList.remove("show", "active", "open", "visible");
        }
      }
    }
    // Close any open native dialogs
    const dialogs = document.querySelectorAll("dialog[open]");
    for (const d of dialogs) {
      (d as HTMLDialogElement).close();
    }
  });

  // Return focus to body
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur?.();
  });
  await page.waitForTimeout(100);
}

// ---------------------------------------------------------------------------
// CheckResult generation
// ---------------------------------------------------------------------------

/**
 * Run modal focus management checks and produce CheckResults.
 *
 * Criteria covered:
 * - 2.4.3 (Focus Order): focus must move to modal on open and return on close
 * - 2.1.2 (No Keyboard Trap): focus must be trapped in modal but Escape must close
 */
export async function runModalChecks(
  page: Page,
): Promise<{ results: CheckResult[]; interactionStates: Omit<InteractionState, "page_snapshot_id">[] }> {
  const triggers = await findModalTriggers(page);
  const results: CheckResult[] = [];
  const interactionStates: Omit<InteractionState, "page_snapshot_id">[] = [];

  for (const trigger of triggers) {
    // Dismiss any leftover overlays from a previous test
    await dismissOpenModals(page);

    const testResult = await testModal(page, trigger);

    if (testResult.interactionState) {
      interactionStates.push(testResult.interactionState);
    }

    if (!testResult.opened) continue;

    for (const failure of testResult.failures) {
      results.push({
        element_selector: trigger.selector,
        element_html: trigger.outerHtml,
        wcag_criterion: failure.criterion,
        detected_by: "playwright",
        raw_result: {
          type: `modal_${failure.type}`,
          triggerType: trigger.type,
          triggerSelector: trigger.selector,
          targetSelector: trigger.targetSelector,
          opened: testResult.opened,
          focusMovedIn: testResult.focusMovedIn,
          focusTrapped: testResult.focusTrapped,
          escapeCloses: testResult.escapeCloses,
          focusReturnedToTrigger: testResult.focusReturnedToTrigger,
          failureDescription: failure.description,
        },
        measured_values: {
          modal_opened: testResult.opened,
          focus_moved_in: testResult.focusMovedIn,
          focus_trapped: testResult.focusTrapped,
          escape_closes: testResult.escapeCloses,
          focus_returned: testResult.focusReturnedToTrigger,
          trigger_type: trigger.type,
        },
      });
    }
  }

  return { results, interactionStates };
}
