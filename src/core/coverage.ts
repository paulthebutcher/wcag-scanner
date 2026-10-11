import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CoverageStatus = "ran" | "failed" | "skipped";

/** One check's outcome on one page. */
export interface CoverageEntry {
  /** Stable check id, e.g. "axe-core", "focus-visible", "form-submission" */
  check: string;
  /** Check tier (1-5) */
  tier: number;
  page_url: string;
  status: CoverageStatus;
  /** Error message (failed) or reason (skipped) */
  message?: string;
}

/** Everything persisted for a scan in <dataDir>/<scanId>/coverage.json */
export interface ScanCoverage {
  scan_id: string;
  /** Pages captured by the crawl: the denominator for every check */
  page_urls: string[];
  /** URLs the crawl tried and could not load (not part of page_urls) */
  crawl_failures: Array<{ url: string; error: string }>;
  entries: CoverageEntry[];
}

/** Per-check roll-up used by the reports. */
export interface CheckCoverageRow {
  check: string;
  tier: number;
  pages_crawled: number;
  ran: number;
  failed: number;
  skipped: number;
  /** Pages with no recorded outcome for this check */
  not_recorded: number;
  /** Failure messages grouped, most pages first */
  failures: Array<{ message: string; pages: string[] }>;
  /** Skip reasons grouped, most pages first */
  skips: Array<{ reason: string; pages: string[] }>;
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

const STATUS_RANK: Record<CoverageStatus, number> = { failed: 3, ran: 2, skipped: 1 };

/** First line of an error message, trimmed (Playwright appends call logs). */
export function firstLine(message: string): string {
  return message.split("\n")[0].trim().slice(0, 300);
}

/**
 * Collects check outcomes during a scan. A check can report several times
 * for one page (one per form, say); the page's status is the most
 * significant one: failed, then ran, then skipped.
 */
export class CoverageRecorder {
  private readonly byKey = new Map<string, CoverageEntry>();
  private readonly crawlFailures: Array<{ url: string; error: string }> = [];

  record(check: string, tier: number, pageUrl: string, status: CoverageStatus, message?: string): void {
    const key = `${check}\u0000${pageUrl}`;
    const entry: CoverageEntry = { check, tier, page_url: pageUrl, status };
    if (message) entry.message = firstLine(message);
    const existing = this.byKey.get(key);
    if (!existing || STATUS_RANK[status] > STATUS_RANK[existing.status]) {
      this.byKey.set(key, entry);
    }
  }

  ran(check: string, tier: number, pageUrl: string): void {
    this.record(check, tier, pageUrl, "ran");
  }

  failed(check: string, tier: number, pageUrl: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.record(check, tier, pageUrl, "failed", message);
  }

  skipped(check: string, tier: number, pageUrl: string, reason: string): void {
    this.record(check, tier, pageUrl, "skipped", reason);
  }

  /** Record the same status for every page (site-level checks, no API key). */
  recordAll(check: string, tier: number, pageUrls: string[], status: CoverageStatus, message?: string): void {
    for (const url of pageUrls) this.record(check, tier, url, status, message);
  }

  crawlFailure(url: string, error: string): void {
    this.crawlFailures.push({ url, error: firstLine(error) });
  }

  entries(): CoverageEntry[] {
    return Array.from(this.byKey.values());
  }

  toJSON(scanId: string, pageUrls: string[]): ScanCoverage {
    return {
      scan_id: scanId,
      page_urls: pageUrls,
      crawl_failures: [...this.crawlFailures],
      entries: this.entries(),
    };
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function groupBy(entries: CoverageEntry[]): Array<{ text: string; pages: string[] }> {
  const groups = new Map<string, string[]>();
  for (const e of entries) {
    const text = e.message ?? "(no message)";
    const pages = groups.get(text) ?? [];
    pages.push(e.page_url);
    groups.set(text, pages);
  }
  return Array.from(groups.entries())
    .map(([text, pages]) => ({ text, pages: pages.sort() }))
    .sort((a, b) => b.pages.length - a.pages.length || a.text.localeCompare(b.text));
}

/** One row per check, ordered by tier then check id. */
export function summarizeCoverage(coverage: ScanCoverage): CheckCoverageRow[] {
  const pagesCrawled = coverage.page_urls.length;
  const byCheck = new Map<string, CoverageEntry[]>();
  for (const e of coverage.entries) {
    const list = byCheck.get(e.check) ?? [];
    list.push(e);
    byCheck.set(e.check, list);
  }

  const rows: CheckCoverageRow[] = [];
  for (const [check, entries] of byCheck) {
    const failedEntries = entries.filter((e) => e.status === "failed");
    const skippedEntries = entries.filter((e) => e.status === "skipped");
    const ran = entries.filter((e) => e.status === "ran").length;
    rows.push({
      check,
      tier: entries[0].tier,
      pages_crawled: pagesCrawled,
      ran,
      failed: failedEntries.length,
      skipped: skippedEntries.length,
      not_recorded: Math.max(0, pagesCrawled - entries.length),
      failures: groupBy(failedEntries).map((g) => ({ message: g.text, pages: g.pages })),
      skips: groupBy(skippedEntries).map((g) => ({ reason: g.text, pages: g.pages })),
    });
  }
  return rows.sort((a, b) => a.tier - b.tier || a.check.localeCompare(b.check));
}

// ---------------------------------------------------------------------------
// Persistence: <dataDir>/<scanId>/coverage.json (same pattern as timings.json)
// ---------------------------------------------------------------------------

export function coveragePath(dataDir: string, scanId: string): string {
  return join(dataDir, scanId, "coverage.json");
}

export function writeCoverage(dataDir: string, coverage: ScanCoverage): string {
  const dir = join(dataDir, coverage.scan_id);
  mkdirSync(dir, { recursive: true });
  const path = coveragePath(dataDir, coverage.scan_id);
  writeFileSync(path, JSON.stringify(coverage, null, 2), "utf8");
  return path;
}

/** Load a scan's coverage, or null for scans that predate coverage recording. */
export function loadCoverage(dataDir: string, scanId: string): ScanCoverage | null {
  const path = coveragePath(dataDir, scanId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ScanCoverage;
  } catch {
    return null;
  }
}
