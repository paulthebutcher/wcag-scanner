/**
 * Debug tool: walks the same candidate-enumeration + tab-sequence pipeline
 * used by src/checks/behavioral/keyboard.ts and dumps everything to stdout
 * so we can see exactly why an element is flagged unreachable.
 *
 * Usage:
 *   npx tsx scripts/debug-keyboard.ts <url>
 *   npx tsx scripts/debug-keyboard.ts https://www.lakewoodcourtoh.gov/contact
 */
import { chromium } from "playwright";
import { recordTabSequence } from "../src/checks/behavioral/keyboard.js";

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

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: npx tsx scripts/debug-keyboard.ts <url>");
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  console.log(`\n[debug-keyboard] Loading ${url} at 1280x800...`);
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000); // let any deferred animations settle

  console.log(`[debug-keyboard] Viewport: ${JSON.stringify(page.viewportSize())}`);

  // ---- Phase 1: enumerate every candidate ----
  const allCandidates = await page.$$(INTERACTIVE_SELECTOR);
  console.log(`\n[debug-keyboard] Phase 1: raw candidates matching INTERACTIVE_SELECTOR: ${allCandidates.length}`);

  type Candidate = {
    index: number;
    selector: string;
    tagName: string;
    outerHtmlShort: string;
    isVisible: boolean;
    ancestorHidden: string | null;
    tabindex: string | null;
    disabled: boolean;
    rect: { x: number; y: number; w: number; h: number };
    inViewport: boolean;
    topmostAtCenter: boolean;
  };

  const candidates: Candidate[] = [];

  for (let i = 0; i < allCandidates.length; i++) {
    const handle = allCandidates[i];
    const visible = await handle.isVisible();

    const detail = await handle.evaluate((el, idx) => {
      const htmlEl = el as HTMLElement;
      // Build the same selector the scanner builds
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

      // Ancestor-hidden detection
      let ancestorHidden: string | null = null;
      let cur: Element | null = htmlEl.parentElement;
      while (cur && cur !== document.documentElement) {
        const curEl = cur as HTMLElement;
        if (curEl.hasAttribute("inert")) {
          ancestorHidden = `inert on <${cur.tagName.toLowerCase()}${cur.className ? "." + String(cur.className).split(" ").join(".") : ""}>`;
          break;
        }
        if (cur.getAttribute("aria-hidden") === "true") {
          ancestorHidden = `aria-hidden on <${cur.tagName.toLowerCase()}${cur.className ? "." + String(cur.className).split(" ").join(".") : ""}>`;
          break;
        }
        if (curEl.hidden) {
          ancestorHidden = `hidden attr on <${cur.tagName.toLowerCase()}>`;
          break;
        }
        const style = window.getComputedStyle(cur);
        if (style.display === "none") {
          ancestorHidden = `display:none on <${cur.tagName.toLowerCase()}${cur.className ? "." + String(cur.className).split(" ").join(".") : ""}>`;
          break;
        }
        if (style.visibility === "hidden") {
          ancestorHidden = `visibility:hidden on <${cur.tagName.toLowerCase()}>`;
          break;
        }
        cur = cur.parentElement;
      }

      const rect = htmlEl.getBoundingClientRect();
      const inViewport = rect.width > 0 && rect.height > 0 &&
        rect.left < window.innerWidth && rect.top < window.innerHeight &&
        rect.right > 0 && rect.bottom > 0;

      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const topmostEl = inViewport ? document.elementFromPoint(cx, cy) : null;
      const topmostAtCenter = topmostEl !== null &&
        (topmostEl === htmlEl || htmlEl.contains(topmostEl) || topmostEl.contains(htmlEl));

      const outer = htmlEl.outerHTML;
      return {
        index: idx,
        selector,
        tagName: htmlEl.tagName.toLowerCase(),
        outerHtmlShort: outer.length > 180 ? outer.slice(0, 180) + "..." : outer,
        ancestorHidden,
        tabindex: htmlEl.getAttribute("tabindex"),
        disabled: !!(htmlEl as HTMLInputElement).disabled,
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        inViewport,
        topmostAtCenter,
      };
    }, i);

    candidates.push({ ...detail, isVisible: visible });
    await handle.dispose();
  }

  // ---- Phase 2: run the tab sequence ----
  console.log(`\n[debug-keyboard] Phase 2: running recordTabSequence...`);
  const tabResult = await recordTabSequence(page, { maxTabs: 500 });
  console.log(`[debug-keyboard]   Tab sequence: ${tabResult.focusStops.length} stops, ${tabResult.totalTabs} tab presses`);
  console.log(`[debug-keyboard]   Ended by cycle: ${tabResult.endedByCycle}`);
  console.log(`[debug-keyboard]   Ended by max: ${tabResult.endedByMax}`);
  console.log(`[debug-keyboard]   Unreachable: ${tabResult.unreachableElements.length}`);

  const reachedSelectors = new Set(tabResult.focusStops.map((s) => s.selector));
  console.log(`\n[debug-keyboard] Reached selectors (${reachedSelectors.size}):`);
  for (const stop of tabResult.focusStops) {
    console.log(`    [${stop.sequenceIndex}] ${stop.tagName}  ${stop.selector}`);
  }

  // ---- Phase 3: compare ----
  console.log(`\n[debug-keyboard] Phase 3: per-candidate analysis`);
  console.log(`[debug-keyboard]   A = candidate isVisible (Playwright)`);
  console.log(`[debug-keyboard]   ancestorHidden = nearest hidden ancestor (if any)`);
  console.log(`[debug-keyboard]   inViewport = candidate rect intersects viewport`);
  console.log(`[debug-keyboard]   topmostAtCenter = elementFromPoint(center) is this element`);
  console.log(`[debug-keyboard]   reached = selector appeared in tab sequence\n`);

  let trulyUnreachableCount = 0;
  let falsePositives = 0;
  for (const c of candidates) {
    const reached = reachedSelectors.has(c.selector);
    const passesPredicate = c.isVisible && !c.ancestorHidden && c.tabindex !== "-1" && !c.disabled;
    // These are the ones the scanner would flag as unreachable
    const wouldBeFlagged = passesPredicate && !reached;
    if (!wouldBeFlagged) continue;

    trulyUnreachableCount++;
    console.log(`--- CANDIDATE #${c.index} WOULD BE FLAGGED ---`);
    console.log(`  selector: ${c.selector}`);
    console.log(`  tag: ${c.tagName}  tabindex: ${c.tabindex ?? "(none)"}  disabled: ${c.disabled}`);
    console.log(`  rect: x=${c.rect.x.toFixed(0)} y=${c.rect.y.toFixed(0)} w=${c.rect.w.toFixed(0)} h=${c.rect.h.toFixed(0)}`);
    console.log(`  isVisible: ${c.isVisible}  inViewport: ${c.inViewport}  topmostAtCenter: ${c.topmostAtCenter}`);
    console.log(`  ancestorHidden: ${c.ancestorHidden ?? "(none)"}`);
    console.log(`  html: ${c.outerHtmlShort}`);

    // Verify that the selector still resolves to exactly one element
    const matchCount = await page.locator(c.selector).count();
    console.log(`  selector resolves to ${matchCount} element(s) at comparison time`);

    // Check if any reached stop's outerHtml matches this candidate's
    const matchingReached = tabResult.focusStops.find((s) =>
      s.outerHtml.startsWith(c.outerHtmlShort.slice(0, 60)),
    );
    if (matchingReached) {
      console.log(`  ! HTML MATCHES reached stop selector="${matchingReached.selector}" — SELECTOR MISMATCH`);
      falsePositives++;
    }
    console.log("");
  }

  console.log(`\n[debug-keyboard] SUMMARY`);
  console.log(`  Candidates total: ${candidates.length}`);
  console.log(`  Passing predicate: ${candidates.filter(c => c.isVisible && !c.ancestorHidden && c.tabindex !== "-1" && !c.disabled).length}`);
  console.log(`  Reached by tab: ${reachedSelectors.size}`);
  console.log(`  Would-be-flagged: ${trulyUnreachableCount}`);
  console.log(`  Of those, HTML matches a reached stop (selector mismatch): ${falsePositives}`);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
