// ---------------------------------------------------------------------------
// Production scan etiquette (P2-007): an identifying user agent with a
// contact URL, and paced top-level loads per host. The CLI builds a
// ScanEtiquette for every production scan; unit tests and the offline eval
// harness run without one (their transport paces and identifies itself).
// ---------------------------------------------------------------------------

import { createRequire } from "node:module";
import type { Page } from "playwright";
import { Pacer } from "./pacer.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

/** Engine version as sent in the user agent */
export const ENGINE_VERSION: string = pkg.version;

export const DEFAULT_MIN_DELAY_MS = 3000;

export interface ScanEtiquette {
  userAgent: string;
  contactUrl: string;
  pacer: Pacer;
}

export function isContactUrl(value: string | undefined): value is string {
  return typeof value === "string" && /^https?:\/\/\S+$/.test(value);
}

/** The contact URL for production scans: WCAG_CONTACT_URL, else EVAL_CONTACT_URL. */
export function contactUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const key of ["WCAG_CONTACT_URL", "EVAL_CONTACT_URL"]) {
    const v = env[key]?.trim();
    if (isContactUrl(v)) return v;
  }
  return null;
}

export function productUserAgent(contactUrl: string): string {
  if (!isContactUrl(contactUrl)) throw new Error("The contact URL must be an http(s) URL");
  return `WCAGEngine/${ENGINE_VERSION} (+${contactUrl})`;
}

/**
 * Etiquette for a production scan. Throws when no contact URL is set: a scan
 * that cannot identify itself does not run.
 */
export function productionEtiquette(options: { minDelayMs?: number; env?: NodeJS.ProcessEnv } = {}): ScanEtiquette {
  const contactUrl = contactUrlFromEnv(options.env);
  if (!contactUrl) {
    throw new Error("No contact URL for the scan's user agent: set WCAG_CONTACT_URL (or EVAL_CONTACT_URL) to an http(s) URL the site owner can read");
  }
  const minDelayMs = options.minDelayMs ?? DEFAULT_MIN_DELAY_MS;
  if (!Number.isFinite(minDelayMs) || minDelayMs < 0) throw new Error("--min-delay-ms must be a non-negative number");
  return { userAgent: productUserAgent(contactUrl), contactUrl, pacer: new Pacer(minDelayMs) };
}

// The pacer in force for the scan running in this process. Checks that load
// pages (keyboard retry, form submission, on-input) wait on it through
// pacedGoto/pacedReload; without a scan etiquette they load immediately.
let activePacer: Pacer | null = null;

export function setActivePacer(pacer: Pacer | null): void {
  activePacer = pacer;
}

export function getActivePacer(): Pacer | null {
  return activePacer;
}

type GotoOptions = Parameters<Page["goto"]>[1];
type ReloadOptions = Parameters<Page["reload"]>[0];

/** page.goto, paced per host when a scan etiquette is in force. */
export async function pacedGoto(page: Page, url: string, options?: GotoOptions): ReturnType<Page["goto"]> {
  if (activePacer) await activePacer.beforeTopLevel(url);
  return page.goto(url, options);
}

/** page.reload, paced like any other top-level load. */
export async function pacedReload(page: Page, options?: ReloadOptions): ReturnType<Page["reload"]> {
  if (activePacer) await activePacer.beforeTopLevel(page.url());
  return page.reload(options);
}
