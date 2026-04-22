/**
 * Reproduce the real scanner pipeline: tab through the page first (as
 * runKeyboardChecks does), THEN run verifySkipNav. Before the fix this
 * misses the skip link because body.focus() doesn't reset the browser's
 * tab-navigation anchor.
 */
import { chromium } from "playwright";
import { recordTabSequence } from "../src/checks/behavioral/keyboard.js";
import { verifySkipNav } from "../src/checks/behavioral/skip-nav.js";

async function main() {
  const url = process.argv[2] ?? "https://www.lakewoodcourtoh.gov/";
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  console.log(`\nLoading ${url}...`);
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  // Step 1: run keyboard check (pollutes focus anchor)
  console.log("\nStep 1: running recordTabSequence (mimics runKeyboardChecks)...");
  const tab = await recordTabSequence(page, { maxTabs: 500 });
  console.log(`  ${tab.focusStops.length} stops, ${tab.totalTabs} tab presses, endedByCycle=${tab.endedByCycle}`);

  // Where is focus now?
  const after = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? { tag: el.tagName.toLowerCase(), id: el.id, isBody: el === document.body, outer: el.outerHTML.slice(0, 120) } : null;
  });
  console.log(`  focus after tab sequence:`, after);

  // Step 2: run skip-nav check (this is what used to fail)
  console.log("\nStep 2: running verifySkipNav on the SAME page...");
  const result = await verifySkipNav(page);
  console.log(JSON.stringify(result, null, 2));

  await browser.close();
}

main().catch(console.error);
