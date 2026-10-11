import type { Finding } from "../types.js";

// ---------------------------------------------------------------------------
// Page occurrences for deduplicated findings
//
// Shared elements (nav, footer, template components) are stored once, on
// the first page they were seen, with measured_values.also_found_on_pages
// (a count) and, since coverage recording, also_found_on_urls (the list).
// These helpers expand a stored finding back to every page it occurs on so
// counts are comparable with axe findings, which are stored once per page.
// ---------------------------------------------------------------------------

/** Number of other pages this finding was folded from (0 if not deduplicated). */
export function otherPageCount(finding: Finding): number {
  const n = finding.evidence.measured_values?.also_found_on_pages;
  return typeof n === "number" && n > 0 ? n : 0;
}

/** Number of pages the finding occurs on: its own page plus folded pages. */
export function pageOccurrences(finding: Finding): number {
  return 1 + otherPageCount(finding);
}

/** True when the finding stands for the same element on several pages. */
export function isDeduplicated(finding: Finding): boolean {
  return otherPageCount(finding) > 0;
}

/**
 * Every page URL the finding occurs on. `primaryUrl` is the URL of the page
 * the finding is stored against. Scans recorded before URL lists were kept
 * only have the count; the result then holds just the primary URL and
 * `complete` is false.
 */
export function findingPageUrls(
  finding: Finding,
  primaryUrl: string,
): { urls: string[]; complete: boolean } {
  const others = finding.evidence.measured_values?.also_found_on_urls;
  const list = Array.isArray(others) ? others.filter((u): u is string => typeof u === "string") : [];
  const urls = Array.from(new Set([primaryUrl, ...list]));
  return { urls, complete: list.length >= otherPageCount(finding) };
}

/** Unique elements and page occurrences for a set of findings. */
export function occurrenceTotals(findings: Finding[]): { uniqueElements: number; pageOccurrences: number } {
  return {
    uniqueElements: findings.length,
    pageOccurrences: findings.reduce((sum, f) => sum + pageOccurrences(f), 0),
  };
}
