/**
 * Even more detailed: trace each Tab press and print document.activeElement.
 */
import { chromium } from "playwright";

async function main() {
  const url = process.argv[2] ?? "https://www.lakewoodcourtoh.gov/court-docket-search";
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  console.log(`\nLoading ${url}...`);
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  const initialActive = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? { tag: el.tagName.toLowerCase(), id: el.id, outer: el.outerHTML.slice(0, 120) } : null;
  });
  console.log(`Initial activeElement:`, initialActive);

  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur?.();
    document.body.focus();
  });
  const afterBlur = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? { tag: el.tagName.toLowerCase(), id: el.id, isBody: el === document.body } : null;
  });
  console.log(`After body.focus():`, afterBlur);

  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    const state = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return { tag: null, id: null, isBody: false };
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id,
        isBody: el === document.body,
        name: el.getAttribute("name"),
        type: el.getAttribute("type"),
        outer: el.outerHTML.slice(0, 120),
      };
    });
    console.log(`Tab #${i + 1}:`, state);
  }

  await browser.close();
}

main().catch(console.error);
