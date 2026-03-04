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
// Sitemap parsing (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Extract all `<loc>` values from a sitemap XML string.
 * Works for both regular sitemaps (`<urlset>`) and sitemap index files
 * (`<sitemapindex>`) — the caller decides how to treat the URLs.
 */
export function extractSitemapLocs(xml: string): string[] {
  const locs: string[] = [];
  const re = /<loc[^>]*>([\s\S]*?)<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const url = m[1].trim();
    if (url) locs.push(url);
  }
  return locs;
}

/**
 * True if the XML document is a `<sitemapindex>` rather than a `<urlset>`.
 */
export function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

// ---------------------------------------------------------------------------
// robots.txt parsing (exported for testing)
// ---------------------------------------------------------------------------

export interface RobotsRules {
  disallowedPaths: string[];
  sitemapUrls: string[];
}

/**
 * Parse a robots.txt file and return the Disallow paths for the wildcard
 * (`*`) user-agent plus any `Sitemap:` directives.
 */
export function parseRobotsTxt(content: string): RobotsRules {
  const lines = content.split("\n");
  const disallowed: string[] = [];
  const sitemaps: string[] = [];
  let inWildcardBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Split on first ':' only — value may contain ':'
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (key === "user-agent") {
      inWildcardBlock = value === "*";
    } else if (key === "disallow" && inWildcardBlock && value) {
      disallowed.push(value);
    } else if (key === "sitemap" && value) {
      // Sitemap directives are global — not scoped to a user-agent block
      sitemaps.push(value);
    }
  }

  return { disallowedPaths: disallowed, sitemapUrls: sitemaps };
}

/**
 * True if `urlPath` is NOT blocked by any of the `disallowedPaths`.
 */
export function isAllowedByRobots(
  urlPath: string,
  disallowedPaths: string[],
): boolean {
  for (const pattern of disallowedPaths) {
    if (urlPath.startsWith(pattern)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// HTTP helpers (not exported — internal)
// ---------------------------------------------------------------------------

async function fetchText(
  url: string,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Fetch sitemap URLs from `rootOrigin`.
 *
 * 1.  Try `<rootOrigin>/sitemap.xml`
 * 2.  If it's a sitemap index, fetch each sub-sitemap
 * 3.  Also try any `Sitemap:` URLs discovered from robots.txt
 */
async function fetchAllSitemapUrls(
  rootOrigin: string,
  extraSitemapUrls: string[],
  timeoutMs: number,
): Promise<string[]> {
  const pageUrls: string[] = [];

  // Gather all sitemap XML locations to fetch
  const sitemapLocations = new Set<string>([
    `${rootOrigin}/sitemap.xml`,
    ...extraSitemapUrls,
  ]);

  for (const sitemapUrl of sitemapLocations) {
    const xml = await fetchText(sitemapUrl, timeoutMs);
    if (!xml) continue;

    if (isSitemapIndex(xml)) {
      // It's an index — fetch each child sitemap
      const childUrls = extractSitemapLocs(xml);
      for (const childUrl of childUrls) {
        const childXml = await fetchText(childUrl, timeoutMs);
        if (childXml && !isSitemapIndex(childXml)) {
          pageUrls.push(...extractSitemapLocs(childXml));
        }
      }
    } else {
      pageUrls.push(...extractSitemapLocs(xml));
    }
  }

  return pageUrls;
}

// ---------------------------------------------------------------------------
// Crawler
// ---------------------------------------------------------------------------

/**
 * BFS-crawl from `rootUrl`, returning a PageSnapshot for every discovered
 * page up to `maxPages`.  An external `browser` instance can be passed in
 * for testing; otherwise Chromium is launched and closed automatically.
 *
 * Discovery order:
 *   1. Fetch /robots.txt — extract Disallow paths + Sitemap directives
 *   2. Fetch /sitemap.xml (+ any Sitemap: URLs from robots.txt)
 *   3. Seed the BFS queue with root URL + sitemap URLs
 *   4. BFS link-following from each visited page
 *
 * All URLs are deduplicated and filtered against robots.txt Disallow rules.
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

  // ----- Phase 1: robots.txt --------------------------------------------------
  const robotsTxt = await fetchText(`${rootOrigin}/robots.txt`, timeoutMs);
  const robotsRules: RobotsRules = robotsTxt
    ? parseRobotsTxt(robotsTxt)
    : { disallowedPaths: [], sitemapUrls: [] };

  // ----- Phase 2: sitemaps -----------------------------------------------------
  const sitemapPageUrls = await fetchAllSitemapUrls(
    rootOrigin,
    robotsRules.sitemapUrls,
    timeoutMs,
  );

  // ----- Phase 3: seed queue ---------------------------------------------------
  const visited = new Set<string>();
  const queue: string[] = [normalizedRoot];

  // Add sitemap URLs to the queue (normalised, deduped, same-origin, robots-ok)
  for (const raw of sitemapPageUrls) {
    const normalized = normalizeUrl(raw, rootOrigin);
    if (
      normalized &&
      isSameOrigin(normalized, rootOrigin) &&
      !visited.has(normalized) &&
      isAllowedByRobots(new URL(normalized).pathname, robotsRules.disallowedPaths)
    ) {
      // Avoid duplicate entries in the queue — normalizedRoot is already there
      if (normalized !== normalizedRoot && !queue.includes(normalized)) {
        queue.push(normalized);
      }
    }
  }

  const snapshots: PageSnapshot[] = [];

  const ownBrowser = !browser;
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }

  // ----- Phase 4: BFS crawl ---------------------------------------------------
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
            !visited.has(normalized) &&
            isAllowedByRobots(
              new URL(normalized).pathname,
              robotsRules.disallowedPaths,
            )
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
