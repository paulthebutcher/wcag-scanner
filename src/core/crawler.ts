import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { PageSnapshot, Viewport } from "../types.js";
import type { FileStore } from "../store/files.js";
import type { ProgressReporter } from "./progress.js";

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
  /** Progress reporter (optional — if omitted, no progress is reported) */
  reporter?: ProgressReporter;
  /**
   * When true, include pages marked noindex in the scan. Default false —
   * noindex pages are detected via meta robots / googlebot / X-Robots-Tag
   * and skipped, on the basis that they're hidden from SERPs and not the
   * target of the accessibility assessment.
   */
  includeNoindex?: boolean;
  /** Pages loaded in parallel (default 4) */
  concurrency?: number;
  /**
   * After the load event, wait at most this long for the network to go
   * quiet before capturing the page (default 5000). Pages that keep making
   * background requests are captured anyway instead of being skipped.
   */
  idleTimeoutMs?: number;
  /**
   * Called with the live page after its snapshot is captured and before the
   * page is closed, so callers can run checks without loading the page again.
   */
  onPage?: (page: Page, snapshot: PageSnapshot, screenshot: Buffer) => Promise<void>;
}

export interface ExcludedPage {
  url: string;
  source: NoindexSource;
}

export interface CrawlResult {
  snapshots: PageSnapshot[];
  excludedByNoindex: ExcludedPage[];
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
// Noindex detection
// ---------------------------------------------------------------------------

export type NoindexSource = "meta-robots" | "meta-googlebot" | "x-robots-tag";

export interface NoindexDetection {
  noindex: boolean;
  source: NoindexSource | null;
}

/** Case-insensitive check for a `noindex` token in a comma-separated directive list. */
function hasNoindexToken(directives: string): boolean {
  return directives
    .toLowerCase()
    .split(",")
    .map((d) => d.trim())
    .some((d) => d === "noindex" || d.endsWith(": noindex") || d.endsWith(":noindex"));
}

/**
 * Detect whether a page is marked "noindex" by any of:
 *   - `<meta name="robots" content="...noindex...">` in the HTML
 *   - `<meta name="googlebot" content="...noindex...">`
 *   - `X-Robots-Tag` response header (may include a bot-name prefix)
 *
 * Returns the first signal found. Header check takes precedence for
 * clarity in logs; HTML meta robots checked before googlebot variant.
 */
export function detectNoindex(
  dom: string,
  headers: Record<string, string>,
): NoindexDetection {
  // X-Robots-Tag response header. Playwright lowercases header names.
  const xrt = headers["x-robots-tag"];
  if (typeof xrt === "string" && hasNoindexToken(xrt)) {
    return { noindex: true, source: "x-robots-tag" };
  }

  // <meta name="robots" ... content="..."> and googlebot variant.
  // Tolerates attributes in either order and single or double quotes.
  const metaRegex = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRegex.exec(dom)) !== null) {
    const tag = m[0];
    const nameMatch = tag.match(/\bname\s*=\s*["']([^"']+)["']/i);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();
    if (name !== "robots" && name !== "googlebot") continue;
    const contentMatch = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i);
    if (!contentMatch) continue;
    if (hasNoindexToken(contentMatch[1])) {
      return {
        noindex: true,
        source: name === "robots" ? "meta-robots" : "meta-googlebot",
      };
    }
  }

  return { noindex: false, source: null };
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
// Template signature (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Compute a signature that is equal for pages rendered from the same
 * template. Webflow stamps every page with `data-wf-page`; CMS items share
 * their template page's id, while static pages each have their own. For
 * other platforms, fall back to a hash of the body's structural skeleton
 * (tag + class names, three levels deep).
 */
export function templateSignature(dom: string, skeleton: string): string {
  const htmlTag = dom.match(/<html\b[^>]*>/i)?.[0] ?? "";
  const wfPage = htmlTag.match(/\bdata-wf-page\s*=\s*["']([^"']+)["']/i);
  if (wfPage) return `wf:${wfPage[1]}`;
  return `sk:${createHash("sha1").update(skeleton).digest("hex").slice(0, 16)}`;
}

async function pageSkeleton(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts: string[] = [];
    const walk = (el: Element, depth: number): void => {
      if (depth > 3) return;
      for (const child of Array.from(el.children)) {
        const tag = child.tagName.toLowerCase();
        if (tag === "script" || tag === "style" || tag === "noscript") continue;
        const cls = typeof child.className === "string" ? child.className.trim().split(/\s+/).sort().join(".") : "";
        parts.push(`${depth}:${tag}.${cls}`);
        walk(child, depth + 1);
      }
    };
    if (document.body) walk(document.body, 1);
    return parts.join("|");
  });
}

/** Follow redirects from `url` and return the final URL, or null on failure. */
async function resolveFinalUrl(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    clearTimeout(timer);
    await res.body?.cancel().catch(() => {});
    return res.url || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Crawler
// ---------------------------------------------------------------------------

interface CollectionState {
  /** unknown until two pages of the prefix have been loaded and compared */
  status: "unknown" | "collection" | "static";
  /** Pages started (in flight or done) under this prefix */
  started: number;
  /** Template signatures of loaded pages */
  signatures: string[];
  /** URLs held back while the status is unknown */
  deferred: string[];
}

/**
 * BFS-crawl from `rootUrl`, returning a PageSnapshot for every discovered
 * page up to `maxPages`.  An external `browser` instance can be passed in
 * for testing; otherwise Chromium is launched and closed automatically.
 *
 * Discovery order:
 *   1. Resolve the root URL through any redirect (e.g. apex → www)
 *   2. Fetch /robots.txt — extract Disallow paths + Sitemap directives
 *   3. Fetch /sitemap.xml (+ any Sitemap: URLs from robots.txt)
 *   4. Seed the BFS queue with root URL + sitemap URLs
 *   5. BFS link-following, `concurrency` pages at a time
 *
 * All URLs are deduplicated and filtered against robots.txt Disallow rules.
 *
 * CMS sampling: a URL prefix (`/blog/*`) is only treated as a collection
 * once two of its pages turn out to share a template. Until then at most
 * two pages of the prefix are loaded; sections of distinct static pages are
 * crawled in full.
 */
export async function crawl(
  rootUrl: string,
  options: CrawlOptions,
  browser?: Browser,
): Promise<CrawlResult> {
  const maxPages = options.maxPages ?? 50;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 5_000;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const viewport = options.viewport ?? {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
  };

  let normalizedRoot = normalizeUrl(rootUrl, rootUrl);
  if (!normalizedRoot) {
    throw new Error(`Invalid root URL: ${rootUrl}`);
  }

  // ----- Phase 0: resolve root redirect ---------------------------------------
  // If the site redirects (apex → www, http → https), crawl from the final
  // URL so sitemap and link same-origin checks use the real origin.
  const finalRoot = await resolveFinalUrl(normalizedRoot, timeoutMs);
  if (finalRoot) {
    const normalizedFinal = normalizeUrl(finalRoot, finalRoot);
    if (normalizedFinal && new URL(normalizedFinal).origin !== new URL(normalizedRoot).origin) {
      options.reporter?.complete("crawl", `${normalizedRoot} redirects to ${normalizedFinal}; crawling from there`);
      normalizedRoot = normalizedFinal;
    }
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
  // Every URL ever queued, so each is queued (and counted) once.
  const queued = new Set<string>([normalizedRoot]);
  const queue: string[] = [normalizedRoot];

  const enqueue = (raw: string, base: string): void => {
    const normalized = normalizeUrl(raw, base);
    if (
      normalized &&
      !queued.has(normalized) &&
      isSameOrigin(normalized, rootOrigin) &&
      isAllowedByRobots(new URL(normalized).pathname, robotsRules.disallowedPaths)
    ) {
      queued.add(normalized);
      queue.push(normalized);
    }
  };

  for (const raw of sitemapPageUrls) enqueue(raw, rootOrigin);

  const cmsSamples = options.cmsSamples ?? 5;
  const fullCrawl = options.fullCrawl ?? false;

  const snapshots: PageSnapshot[] = [];
  const excludedByNoindex: ExcludedPage[] = [];
  const includeNoindex = options.includeNoindex ?? false;

  const ownBrowser = !browser;
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }

  // ----- Phase 4: BFS crawl ---------------------------------------------------
  const collections = new Map<string, CollectionState>();
  const collectionFor = (prefix: string): CollectionState => {
    let state = collections.get(prefix);
    if (!state) {
      state = { status: "unknown", started: 0, signatures: [], deferred: [] };
      collections.set(prefix, state);
    }
    return state;
  };

  /** Pop the next URL that may be loaded now, applying the CMS sampling guard. */
  const nextUrl = (): string | null => {
    while (queue.length > 0) {
      const url = queue.shift()!;
      if (visited.has(url)) continue;

      if (!fullCrawl) {
        const prefix = getCollectionPrefix(url);
        if (prefix) {
          const state = collectionFor(prefix);
          if (state.status === "collection" && state.started >= cmsSamples) {
            visited.add(url);
            continue;
          }
          if (state.status === "unknown" && state.started >= 2) {
            // Two probe pages are loading; hold the rest until we know
            // whether this prefix is a collection.
            state.deferred.push(url);
            continue;
          }
          state.started++;
        }
      }

      visited.add(url);
      return url;
    }
    return null;
  };

  /** Record a loaded page's template signature and settle the prefix status. */
  const recordSignature = (url: string, signature: string | null): void => {
    if (fullCrawl) return;
    const prefix = getCollectionPrefix(url);
    if (!prefix) return;
    const state = collectionFor(prefix);
    if (state.status !== "unknown") return;

    if (signature === null) {
      // The probe failed to load; let another page take its place.
      state.started = Math.max(0, state.started - 1);
    } else {
      state.signatures.push(signature);
      if (state.signatures.length >= 2) {
        state.status = state.signatures[0] === state.signatures[1] ? "collection" : "static";
        if (state.status === "collection") {
          let known = 0;
          for (const u of queued) if (getCollectionPrefix(u) === prefix) known++;
          options.reporter?.complete(
            "crawl",
            `CMS collection ${prefix}/ (~${known} pages), sampling ${Math.min(known, cmsSamples)}`,
          );
        }
      }
    }

    if (state.deferred.length > 0 && (state.status !== "unknown" || state.started < 2)) {
      queue.unshift(...state.deferred);
      state.deferred = [];
    }
  };

  let context: BrowserContext | undefined;
  let screenshotIndex = 0;

  const visit = async (ctx: BrowserContext, url: string): Promise<void> => {
    const page = await ctx.newPage();
    let signature: string | null = null;
    try {
      const response = await page.goto(url, {
        waitUntil: "load",
        timeout: timeoutMs,
      });
      // Give late requests a bounded chance to settle. Pages with video,
      // animation or analytics traffic never go idle; capture them anyway.
      await page.waitForLoadState("networkidle", { timeout: idleTimeoutMs }).catch(() => {});
      const responseHeaders = response?.headers() ?? {};

      // A URL that redirects off-site or onto a page we already have is
      // not a new page.
      const finalUrl = normalizeUrl(page.url(), page.url());
      if (finalUrl && finalUrl !== url) {
        if (!isSameOrigin(finalUrl, rootOrigin) || visited.has(finalUrl)) {
          return;
        }
        visited.add(finalUrl);
        queued.add(finalUrl);
      }

      const dom = await page.content();
      signature = templateSignature(dom, await pageSkeleton(page).catch(() => ""));

      // Noindex filter: if the page is hidden from SERPs (meta robots /
      // googlebot / X-Robots-Tag), record it and skip adding it to the
      // snapshot list. We still crawl outbound links — noindex means
      // "don't index this page", not "don't follow its links".
      const noindex = detectNoindex(dom, responseHeaders);
      const shouldExclude = noindex.noindex && !includeNoindex;

      if (!shouldExclude && snapshots.length < maxPages) {
        const title = await page.title();
        const screenshotBuffer = await page.screenshot({ fullPage: true });

        const screenshotPath = options.fileStore.store(
          options.scanSessionId,
          `page-${screenshotIndex++}.png`,
          screenshotBuffer,
        );

        const snapshot: PageSnapshot = {
          id: randomUUID(),
          scan_session_id: options.scanSessionId,
          url,
          title,
          captured_at: new Date().toISOString(),
          full_dom: dom,
          screenshot: screenshotPath,
          viewport,
        };
        snapshots.push(snapshot);
        options.reporter?.update("crawl", `Discovering pages... ${snapshots.length} captured, ${queued.size} known`);

        if (options.onPage) {
          try {
            await options.onPage(page, snapshot, screenshotBuffer);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            options.reporter?.warn("crawl", `Page hook failed for ${url}: ${msg}`);
          }
        }
      } else if (shouldExclude) {
        excludedByNoindex.push({ url, source: noindex.source! });
        options.reporter?.update(
          "crawl",
          `Excluded noindex page: ${url} (${noindex.source})`,
        );
      }

      // Extract links regardless of exclusion so BFS can still discover
      // pages reached only via a noindex page's outbound links.
      const hrefs: string[] = await page.evaluate(() =>
        Array.from(document.querySelectorAll("a[href]")).map(
          (a) => a.getAttribute("href") ?? "",
        ),
      );
      for (const href of hrefs) enqueue(href, url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      options.reporter?.warn("crawl", `Skipping ${url}: ${msg}`);
    } finally {
      recordSignature(url, signature);
      await page.close().catch(() => {});
    }
  };

  try {
    context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
    });
    // tsx/esbuild (keepNames) wraps named functions in a `__name(fn, "name")`
    // helper. Callbacks passed to page.evaluate are serialized into the
    // browser, where that helper doesn't exist — define a no-op so they run.
    await context.addInitScript({ content: "globalThis.__name = globalThis.__name || ((fn) => fn);" });

    const inFlight = new Set<Promise<void>>();
    for (;;) {
      while (inFlight.size < concurrency && snapshots.length + inFlight.size < maxPages) {
        const url = nextUrl();
        if (!url) break;
        const task: Promise<void> = visit(context, url).finally(() => {
          inFlight.delete(task);
        });
        inFlight.add(task);
      }
      if (inFlight.size === 0) break;
      await Promise.race(inFlight);
    }
  } finally {
    if (context) await context.close();
    if (ownBrowser && browser) await browser.close();
  }

  return { snapshots, excludedByNoindex };
}
