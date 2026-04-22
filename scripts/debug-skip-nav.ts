/**
 * Dumps everything the skip-nav check looks at on a page so you can see
 * which specific condition is failing.
 */
import { chromium } from "playwright";
import { verifySkipNav } from "../src/checks/behavioral/skip-nav.js";

async function main() {
  const url = process.argv[2] ?? "https://www.lakewoodcourtoh.gov/";
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  console.log(`\nLoading ${url}...`);
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  // Show the first 5 elements the scanner would see when tabbing
  console.log(`\n-- First 5 elements reached by Tab from body --`);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur?.();
    document.body.focus();
  });
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Tab");
    const state = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { tag: "body" };
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id,
        class: el.getAttribute("class"),
        href: el.getAttribute("href"),
        text: (el.textContent ?? "").trim().slice(0, 60),
        outer: el.outerHTML.slice(0, 200),
      };
    });
    console.log(`  Tab #${i + 1}:`, state);
  }

  // Also check any <a> with text matching "skip" anywhere on the page
  console.log(`\n-- All anchors whose text includes 'skip' (case-insensitive) --`);
  const skipCandidates = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll("a"));
    return links
      .filter((a) => /skip/i.test(a.textContent ?? "") || /^#(main|content|skip|primary)/i.test(a.getAttribute("href") ?? ""))
      .map((a) => ({
        text: (a.textContent ?? "").trim(),
        href: a.getAttribute("href"),
        id: a.id || null,
        class: a.getAttribute("class"),
        // Is it among first 3 tab stops?
        outer: a.outerHTML.slice(0, 300),
      }));
  });
  console.log(`  Found ${skipCandidates.length} candidate(s):`);
  for (const c of skipCandidates) console.log("   ", c);

  // Check what the target element (if any) looks like
  console.log(`\n-- Targets with IDs that the scanner accepts as 'main content' --`);
  const acceptedIds = ["main", "content", "main-content", "maincontent", "primary"];
  const targets = await page.evaluate((ids) => {
    const result: Array<{ id: string; tag: string; hasMainRole: boolean; tabindex: string | null }> = [];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) {
        result.push({
          id,
          tag: el.tagName.toLowerCase(),
          hasMainRole: el.tagName.toLowerCase() === "main" || el.getAttribute("role") === "main",
          tabindex: el.getAttribute("tabindex"),
        });
      }
    }
    const mainEls = document.querySelectorAll('main, [role="main"]');
    for (const el of Array.from(mainEls)) {
      result.push({
        id: el.id || "(no id)",
        tag: el.tagName.toLowerCase(),
        hasMainRole: true,
        tabindex: el.getAttribute("tabindex"),
      });
    }
    return result;
  }, acceptedIds);
  for (const t of targets) console.log("   ", t);

  // Run the actual scanner check ON A FRESH PAGE so prior tabbing doesn't
  // contaminate the browser's focus anchor.
  console.log(`\n-- verifySkipNav() result (fresh page) --`);
  const freshPage = await context.newPage();
  await freshPage.goto(url, { waitUntil: "networkidle" });
  await freshPage.waitForTimeout(1000);
  const result = await verifySkipNav(freshPage);
  console.log(JSON.stringify(result, null, 2));
  await freshPage.close();

  await browser.close();
}

main().catch(console.error);
