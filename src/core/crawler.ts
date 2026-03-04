import { chromium, type Browser, type BrowserContext } from "playwright";
import { randomUUID } from "node:crypto";
import type { PageSnapshot, Viewport } from "../types.js";
import type { FileStore } from "../store/files.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CrawlOptions {
  scanSessionId: string;
  fileStore: FileStore;
  maxPages?: number;
  timeoutMs?: number;
  viewport?: Viewport;
}

// ---------------------------------------------------------------------------
// URL utilities (exported for testing)
// ---------------------------------------------------------------------------

const SKIP_PREFIXES = ["mailto:", "tel:", "javascript:", "data:", "blob:", "ftp:"];

/**
 * Resolve `raw` against `baseUrl`, normalise and return the canonical form.
 * Returns `null` for non-http(s) schemes, empty strings or unparsable values.
 */
export function normalizeUrl(raw: string, baseUrl: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Fast reject non-http schemes before URL parsing
  const lower = trimmed.toLowerCase();
  for (const prefix of SKIP_PREFIXES) {
    if (lower.startsWith(prefix)) return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed, baseUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  // Strip fragment
  parsed.hash = "";

  // Strip trailing slash for non-root paths
  let normalized = parsed.href;
  if (parsed.pathname !== "/" && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

/**
 * True when `url` belongs to the same origin as `rootUrl`.
 */
export function isSameOrigin(url: string, rootUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(rootUrl).origin;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Crawler
// ---------------------------------------------------------------------------

/**
 * BFS-crawl from `rootUrl`, returning a PageSnapshot for every discovered
 * page up to `maxPages`.  An external `browser` instance can be passed in
 * for testing; otherwise Chromium is launched and closed automatically.
 */
export async function crawl(
  rootUrl: string,
  options: CrawlOptions,
  browser?: Browser,
): Promise<PageSnapshot[]> {
  const maxPages = options.maxPages ?? 50;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const viewport = options.viewport ?? {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
  };

  const normalizedRoot = normalizeUrl(rootUrl, rootUrl);
  if (!normalizedRoot) {
    throw new Error(`Invalid root URL: ${rootUrl}`);
  }
  const rootOrigin = new URL(normalizedRoot).origin;

  const visited = new Set<string>();
  const queue: string[] = [normalizedRoot];
  const snapshots: PageSnapshot[] = [];

  const ownBrowser = !browser;
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }

  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
    });

    while (queue.length > 0 && snapshots.length < maxPages) {
      const url = queue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);

      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: "load", timeout: timeoutMs });

        const title = await page.title();
        const dom = await page.content();
        const screenshotBuffer = await page.screenshot({ fullPage: true });

        const screenshotPath = options.fileStore.store(
          options.scanSessionId,
          `page-${snapshots.length}.png`,
          screenshotBuffer,
        );

        snapshots.push({
          id: randomUUID(),
          scan_session_id: options.scanSessionId,
          url,
          title,
          captured_at: new Date().toISOString(),
          full_dom: dom,
          screenshot: screenshotPath,
          viewport,
        });

        // Extract links from the page
        const hrefs: string[] = await page.evaluate(() =>
          Array.from(document.querySelectorAll("a[href]")).map(
            (a) => a.getAttribute("href") ?? "",
          ),
        );

        for (const href of hrefs) {
          const normalized = normalizeUrl(href, url);
          if (
            normalized &&
            isSameOrigin(normalized, rootOrigin) &&
            !visited.has(normalized)
          ) {
            queue.push(normalized);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[crawler] Skipping ${url}: ${msg}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    if (context) await context.close();
    if (ownBrowser && browser) await browser.close();
  }

  return snapshots;
}
