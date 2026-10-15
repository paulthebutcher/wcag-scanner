import { readFileSync } from "node:fs";
import { sha256, writeJson } from "../util.js";

// ---------------------------------------------------------------------------
// HAR helpers. Each captured page has its own HAR; replay serves a site from
// one merged HAR (an engine loads a page in several contexts, and a page's
// subresources are shared across pages). Merging is deterministic: pages in
// page-id order, first entry wins for a repeated request, failed and
// contained entries are dropped because they were never real responses.
// ---------------------------------------------------------------------------

export interface HarEntry {
  startedDateTime: string;
  request: { method: string; url: string; postData?: { text?: string; mimeType?: string } };
  response: {
    status: number;
    statusText?: string;
    headers: Array<{ name: string; value: string }>;
    redirectURL?: string;
    content: { size?: number; mimeType?: string; text?: string; encoding?: string };
    _failureText?: string;
  };
  pageref?: string;
  [key: string]: unknown;
}

export interface Har {
  log: {
    version: string;
    creator: { name: string; version: string };
    pages?: Array<{ id: string; title?: string; startedDateTime: string; [key: string]: unknown }>;
    entries: HarEntry[];
  };
}

export function readHar(path: string): Har {
  return JSON.parse(readFileSync(path, "utf8")) as Har;
}

/** A HAR entry that recorded a real response the browser could be served. */
export function isServable(entry: HarEntry): boolean {
  return entry.response.status > 0 && !entry.response._failureText;
}

function entryKey(e: HarEntry): string {
  return `${e.request.method.toUpperCase()} ${e.request.url} ${e.request.postData?.text ?? ""}`;
}

export function bodyOf(entry: HarEntry): Buffer {
  const text = entry.response.content.text ?? "";
  return entry.response.content.encoding === "base64" ? Buffer.from(text, "base64") : Buffer.from(text, "utf8");
}

export interface MergeStats {
  pages: number;
  entries_in: number;
  entries_out: number;
  dropped_unservable: number;
  duplicates_identical: number;
  /** Same request, different response body across or within pages */
  duplicates_conflicting: number;
}

export function mergeHars(hars: Array<{ pageId: string; har: Har }>): { har: Har; stats: MergeStats } {
  const sorted = [...hars].sort((a, b) => a.pageId.localeCompare(b.pageId));
  const seen = new Map<string, string>();
  const entries: HarEntry[] = [];
  const pages: NonNullable<Har["log"]["pages"]> = [];
  const stats: MergeStats = { pages: sorted.length, entries_in: 0, entries_out: 0, dropped_unservable: 0, duplicates_identical: 0, duplicates_conflicting: 0 };
  for (const { har } of sorted) {
    pages.push(...(har.log.pages ?? []));
    for (const entry of har.log.entries) {
      stats.entries_in++;
      if (!isServable(entry)) {
        stats.dropped_unservable++;
        continue;
      }
      const key = entryKey(entry);
      const bodyHash = sha256(bodyOf(entry)) + `:${entry.response.status}`;
      const prior = seen.get(key);
      if (prior !== undefined) {
        if (prior === bodyHash) stats.duplicates_identical++;
        else stats.duplicates_conflicting++;
        continue;
      }
      seen.set(key, bodyHash);
      entries.push(entry);
    }
  }
  stats.entries_out = entries.length;
  return {
    har: { log: { version: "1.2", creator: { name: "wcag-eval-merge", version: "1" }, pages, entries } },
    stats,
  };
}

export function writeHar(path: string, har: Har): void {
  writeJson(path, har);
}

// ---------------------------------------------------------------------------
// Narrow fuzzy matching for cache-busting query parameters. Used only after
// an exact HAR lookup fails, and only when exactly one recorded response
// fits; every use is counted in the run manifest.
// ---------------------------------------------------------------------------

const CACHE_BUSTER_KEYS = new Set(["_", "cb", "cachebust", "cachebuster", "nocache", "ts", "timestamp", "t", "rnd", "rand", "random", "_dc"]);

export function normalizeCacheBusters(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const kept: Array<[string, string]> = [];
  let dropped = false;
  for (const [k, v] of parsed.searchParams.entries()) {
    if (CACHE_BUSTER_KEYS.has(k.toLowerCase()) || /^\d{10,}$/.test(v)) {
      dropped = true;
      continue;
    }
    kept.push([k, v]);
  }
  if (!dropped) return null;
  parsed.search = "";
  for (const [k, v] of kept) parsed.searchParams.append(k, v);
  parsed.hash = "";
  return `${parsed.origin}${parsed.pathname}?${parsed.searchParams.toString()}`;
}

export class FuzzyIndex {
  private readonly byNormalized = new Map<string, HarEntry[]>();

  constructor(entries: HarEntry[]) {
    for (const e of entries) {
      if (!isServable(e) || e.request.method.toUpperCase() !== "GET") continue;
      const norm = normalizeCacheBusters(e.request.url);
      if (!norm) continue;
      const list = this.byNormalized.get(norm) ?? [];
      list.push(e);
      this.byNormalized.set(norm, list);
    }
  }

  /** The single recorded response for a cache-busted GET, or null. */
  lookup(method: string, url: string): HarEntry | null {
    if (method.toUpperCase() !== "GET") return null;
    const norm = normalizeCacheBusters(url);
    if (!norm) return null;
    const candidates = this.byNormalized.get(norm) ?? [];
    const distinct = new Map<string, HarEntry>();
    for (const c of candidates) distinct.set(sha256(bodyOf(c)) + c.response.status, c);
    return distinct.size === 1 ? [...distinct.values()][0] : null;
  }
}
