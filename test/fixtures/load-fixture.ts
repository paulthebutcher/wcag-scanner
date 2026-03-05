/**
 * Test fixture loader — returns a mock PageSnapshot from saved HTML files
 * without requiring Playwright or a running browser.
 *
 * Usage:
 *   import { loadFixture, FIXTURE_NAMES } from "../fixtures/load-fixture.js";
 *
 *   const fixture = loadFixture("webflow-landing");
 *   // fixture.snapshot  — PageSnapshot with DOM, URL, title
 *   // fixture.dom       — raw HTML string
 *   // fixture.metadata  — fixture metadata (violations, platform, etc.)
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { PageSnapshot, Platform, Viewport } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FixtureMetadata {
  url: string;
  title: string;
  platform: Platform;
  platform_detected_via: string;
  has_violations: boolean;
  violation_types: string[];
  has_navigation: boolean;
  has_form: boolean;
}

export interface LoadedFixture {
  /** Mock PageSnapshot — can be used anywhere a PageSnapshot is expected */
  snapshot: PageSnapshot;
  /** Raw HTML string (same as snapshot.full_dom) */
  dom: string;
  /** Fixture metadata describing what's in this fixture */
  metadata: FixtureMetadata;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** All available fixture names */
export const FIXTURE_NAMES = [
  "webflow-landing",
  "webflow-contact-form",
  "webflow-blog-post",
  "webflow-portfolio",
] as const;

export type FixtureName = (typeof FIXTURE_NAMES)[number];

const DEFAULT_VIEWPORT: Viewport = {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

let metadataCache: Record<string, FixtureMetadata> | null = null;

function loadMetadata(): Record<string, FixtureMetadata> {
  if (!metadataCache) {
    const raw = readFileSync(join(__dirname, "metadata.json"), "utf-8");
    metadataCache = JSON.parse(raw) as Record<string, FixtureMetadata>;
  }
  return metadataCache;
}

/**
 * Load a test fixture by name.
 *
 * Returns a `LoadedFixture` containing a mock `PageSnapshot` (with real DOM),
 * the raw HTML string, and metadata about the fixture's characteristics.
 *
 * The snapshot uses a random UUID for `id` and `scan_session_id` so each
 * test invocation gets unique IDs.
 */
export function loadFixture(name: FixtureName): LoadedFixture {
  const allMetadata = loadMetadata();
  const metadata = allMetadata[name];
  if (!metadata) {
    throw new Error(
      `Unknown fixture: "${name}". Available: ${FIXTURE_NAMES.join(", ")}`,
    );
  }

  const htmlPath = join(__dirname, `${name}.html`);
  const dom = readFileSync(htmlPath, "utf-8");

  const snapshot: PageSnapshot = {
    id: randomUUID(),
    scan_session_id: randomUUID(),
    url: metadata.url,
    title: metadata.title,
    captured_at: new Date().toISOString(),
    full_dom: dom,
    screenshot: "", // No screenshot in offline fixtures
    viewport: DEFAULT_VIEWPORT,
  };

  return { snapshot, dom, metadata };
}

/**
 * Load all fixtures at once.
 * Returns a Map keyed by fixture name.
 */
export function loadAllFixtures(): Map<FixtureName, LoadedFixture> {
  const result = new Map<FixtureName, LoadedFixture>();
  for (const name of FIXTURE_NAMES) {
    result.set(name, loadFixture(name));
  }
  return result;
}
