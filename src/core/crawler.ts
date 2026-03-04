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
  /** Number of CMS collection pages to sample per collection (default 5) */
  cmsSamples?: number;
  /** When true, crawl all CMS collection pages instead of sampling */
  fullCrawl?: boolean;
  /** Platform-specific CMS URL pattern (from PlatformAdapter.getCMSPattern()) */
  cmsPattern?: RegExp | null;
}

// ---------------------------------------------------------------------------
// CMS collection detection (exported for testing)
// ---------------------------------------------------------------------------

export interface CMSCollection {
  /** URL path prefix, e.g. "/blog" */
  prefix: string;
  /** All discovered URLs belonging to this collection */
  urls: string[];
}

/**
 * Extract the collection prefix from a URL.
 * A CMS collection page typically has a 2+ segment path like `/blog/my-post`.
 * Returns the first path segment (e.g. "/blog") or `null` for root/single-segment.
 */
export function getCollectionPrefix(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    // Remove trailing slash for consistent parsing
    const cleaned = pathname.endsWith("/") && pathname !== "/"
      ? pathname.slice(0, -1)
      : pathname;
    const segments = cleaned.split("/").filter(Boolean);
    // Need at least 2 segments: /collection/item
    if (segments.length < 2) return null;
    return `/${segments[0]}`;
  } catch {
    return null;
  }
}

/**
 * Detect CMS collections from a list of URLs.
 *
 * Groups URLs by their first path segment (for paths with 2+ segments).
 * Optionally filters by a platform-specific CMS pattern (e.g. Webflow w-dyn URLs).
 * Only groups with `minSize` or more URLs are considered collections.
 */
export function detectCMSCollections(
  urls: string[],
  cmsPattern?: RegExp | null,
  minSize = 2,
): CMSCollection[] {
  const groups = new Map<string, string[]>();

  for (const url of urls) {
    // If a cmsPattern is provided, only consider URLs that match it
    if (cmsPattern) {
      try {
        const pathname = new URL(url).pathname;
        if (!cmsPattern.test(pathname)) continue;
      } catch {
        continue;
      }
    }

    const prefix = getCollectionPrefix(url);
    if (!prefix) continue;

    const existing = groups.get(prefix);
    if (existing) {
      existing.push(url);
    } else {
      groups.set(prefix, [url]);
    }
  }

  const collections: CMSCollection[] = [];
  for (const [prefix, groupUrls] of groups) {
    if (groupUrls.length >= minSize) {
      collections.push({ prefix, urls: groupUrls });
    }
  }

  return collections;
}

/**
 * Sample a subset of URLs from a CMS collection.
 * Always includes the first URL (as the "template") plus up to
 * `sampleSize - 1` additional random items from the rest.
 */
export function sampleCollectionUrls(
  urls: string[],
  sampleSize: number,
): string[] {
  if (urls.length <= sampleSize) return [...urls];

  // First URL is the "template" representative
  const template = urls[0];
  const rest = urls.slice(1);

  // Deterministic-ish shuffle using Fisher-Yates, then take sampleSize - 1
  const shuffled = [...rest];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return [template, ...shuffled.slice(0, sampleSize - 1)];
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

  // ----- Phase 3b: CMS collection sampling ------------------------------------
  const cmsSamples = options.cmsSamples ?? 5;
  const fullCrawl = options.fullCrawl ?? false;

  if (!fullCrawl) {
    const collections = detectCMSCollections(
      queue,
      options.cmsPattern,
    );

    if (collections.length > 0) {
      // Build a set of URLs to keep (non-collection URLs + sampled URLs)
      const collectionUrls = new Set<string>();
      for (const col of collections) {
        for (const u of col.urls) {
          collectionUrls.add(u);
        }
      }

      // Keep all non-collection URLs
      const keptUrls = queue.filter((u) => !collectionUrls.has(u));

      // Add sampled URLs from each collection
      for (const col of collections) {
        const sampled = sampleCollectionUrls(col.urls, cmsSamples);
        console.log(
          `[crawler] Detected CMS collection ${col.prefix}/ with ~${col.urls.length} pages, sampling ${sampled.length}`,
        );
        keptUrls.push(...sampled);
      }

      // Replace queue contents
      queue.length = 0;
      queue.push(...keptUrls);
    }
  }

  const snapshots: PageSnapshot[] = [];

  const ownBrowser = !browser;
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }

  // ----- Phase 4: BFS crawl ---------------------------------------------------
  // Track per-collection visit counts for BFS-discovered CMS pages
  const collectionVisits = new Map<string, number>();

  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
    });

    while (queue.length > 0 && snapshots.length < maxPages) {
      const url = queue.shift()!;
      if (visited.has(url)) continue;

      // CMS sampling guard — skip if we've hit the sample limit for this collection
      if (!fullCrawl) {
        const prefix = getCollectionPrefix(url);
        if (prefix) {
          const count = collectionVisits.get(prefix) ?? 0;
          if (count >= cmsSamples) {
            visited.add(url);
            continue;
          }
          if (count === 0) {
            // Log first encounter of a new collection during BFS
            // (count of remaining queued URLs with this prefix is approximate)
            const queuedCount = queue.filter((u) => {
              const p = getCollectionPrefix(u);
              return p === prefix;
            }).length + 1; // +1 for current URL
            if (queuedCount >= 2) {
              console.log(
                `[crawler] Detected CMS collection ${prefix}/ with ~${queuedCount} pages, sampling ${Math.min(queuedCount, cmsSamples)}`,
              );
            }
          }
          collectionVisits.set(prefix, count + 1);
        }
      }

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
