/**
 * What does Shift+Tab actually do from body in headless Chromium?
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const fixture = readFileSync(join(process.cwd(), "test/fixtures/skip-nav-test.html"), "utf8");
  await page.setContent(fixture);

  // Tab forward 5 times to pollute anchor
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur?.();
    document.body.focus();
  });
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Tab");
    const s = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? { tag: el.tagName.toLowerCase(), id: el.id, text: (el.textContent ?? "").trim().slice(0, 30), isBody: el === document.body } : null;
    });
    console.log(`Forward Tab #${i + 1}:`, s);
  }

  // Now body.focus() + Shift+Tab
  console.log("\n-- body.focus() then Shift+Tab --");
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur?.();
    document.body.focus();
  });
  const afterBody = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? { tag: el.tagName.toLowerCase(), id: el.id, isBody: el === document.body } : null;
  });
  console.log(`After body.focus():`, afterBody);

  await page.keyboard.press("Shift+Tab");
  const afterShiftTab = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? { tag: el.tagName.toLowerCase(), id: el.id, text: (el.textContent ?? "").trim().slice(0, 30), isBody: el === document.body } : null;
  });
  console.log(`After Shift+Tab:`, afterShiftTab);

  // Now forward tabs — where do they land?
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    const s = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? { tag: el.tagName.toLowerCase(), id: el.id, text: (el.textContent ?? "").trim().slice(0, 30), isBody: el === document.body } : null;
    });
    console.log(`Forward Tab after Shift+Tab #${i + 1}:`, s);
  }

  await browser.close();
}

main().catch(console.error);
