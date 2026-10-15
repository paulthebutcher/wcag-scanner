import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { readJsonl, writeJson } from "./util.js";
import type { EvalPaths } from "./paths.js";

// ---------------------------------------------------------------------------
// Invariant 5: committed exports carry no municipal hostnames, URLs or HTML.
// Every committed export goes through assertExportSafe before it is written,
// and the privacy test scans the committed eval tree with the same rules.
// ---------------------------------------------------------------------------

const URL_RE = /\b(?:https?|wss?|ftp):\/\/[^\s"'<>]+/i;
const HTML_RE = /<\s*\/?\s*(?:html|head|body|div|span|a|img|form|input|button|nav|section|script|style|iframe|svg|p|h[1-6]|ul|li|table|label|select|textarea|main|header|footer)\b[^>]*>/i;
/** Any public-sector-looking hostname, even when we hold no private list. */
const GOV_HOST_RE = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:gov|us|mil)\b/i;

/** Files under eval/ that are committed exports and must stay content-free. */
export const EXPORT_GLOBS = [
  "runs/",
  "baselines/",
  "corpus.json",
  "lakewood-static.json",
  "phase2-defects.jsonl",
  "label-overrides.json",
  "holdout-access.log",
  "baseline-bridge/",
];

export interface PrivacyFinding {
  file: string;
  kind: "url" | "html" | "hostname";
  excerpt: string;
}

/**
 * Hostnames known to be private: every domain in sites.private.json and the
 * sites named in the seed labels. Missing private files simply contribute
 * nothing; the generic public-sector pattern still applies.
 */
export function knownPrivateHosts(paths: EvalPaths): string[] {
  const hosts = new Set<string>();
  if (existsSync(paths.sitesPrivate)) {
    try {
      const sites = JSON.parse(readFileSync(paths.sitesPrivate, "utf8")) as { sites?: Array<{ domain?: string; root_url?: string }> };
      for (const s of sites.sites ?? []) {
        if (s.domain) hosts.add(bareHost(s.domain));
        if (s.root_url) {
          try { hosts.add(bareHost(new URL(s.root_url).hostname)); } catch { /* not a URL */ }
        }
      }
    } catch {
      // Unreadable private inventory: fall back to the generic rules
    }
  }
  for (const row of readJsonl<{ site?: string }>(paths.seedLabels)) {
    if (row.site) hosts.add(bareHost(row.site));
  }
  return Array.from(hosts).filter(Boolean).sort();
}

function bareHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, "");
}

export function scanText(text: string, file: string, privateHosts: string[]): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  const url = text.match(URL_RE);
  if (url) findings.push({ file, kind: "url", excerpt: url[0].slice(0, 40) });
  const html = text.match(HTML_RE);
  if (html) findings.push({ file, kind: "html", excerpt: html[0].slice(0, 40) });
  const lower = text.toLowerCase();
  for (const host of privateHosts) {
    // Match the registrable part too ("lakewoodcourtoh" in "…lakewoodcourtoh…")
    const stem = host.split(".")[0];
    if (lower.includes(host) || (stem.length >= 8 && lower.includes(stem))) {
      findings.push({ file, kind: "hostname", excerpt: host });
    }
  }
  const gov = text.match(GOV_HOST_RE);
  if (gov) findings.push({ file, kind: "hostname", excerpt: gov[0] });
  return findings;
}

/** Throw if `value` would leak private content when committed. */
export function assertExportSafe(value: unknown, label: string, privateHosts: string[]): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const findings = scanText(text, label, privateHosts);
  if (findings.length > 0) {
    throw new Error(`Refusing to write ${label}: ${findings.map((f) => `${f.kind} (${f.excerpt})`).join(", ")}`);
  }
}

/** Write a committed export after the privacy check. */
export function writeExport(path: string, value: unknown, privateHosts: string[]): void {
  assertExportSafe(value, path, privateHosts);
  writeJson(path, value);
}

/** Whether a repo-relative path is a committed export the scan covers. */
export function isExportPath(repoRelative: string): boolean {
  const rel = repoRelative.replace(/\\/g, "/");
  if (!rel.startsWith("eval/")) return false;
  const inEval = rel.slice("eval/".length);
  return EXPORT_GLOBS.some((g) => (g.endsWith("/") ? inEval.startsWith(g) : inEval === g));
}

/**
 * Scan the staged (index) content of every export file in the next commit
 * (the pre-commit check). `staged` lists repo-relative paths with their
 * staged text.
 */
export function scanStagedExports(paths: EvalPaths, staged: Array<{ path: string; text: string }>): PrivacyFinding[] {
  const hosts = knownPrivateHosts(paths);
  return staged.filter((f) => isExportPath(f.path)).flatMap((f) => scanText(f.text, f.path, hosts));
}

/** Scan every committed export file under eval/. */
export function scanCommittedExports(paths: EvalPaths): PrivacyFinding[] {
  const hosts = knownPrivateHosts(paths);
  const findings: PrivacyFinding[] = [];
  for (const entry of EXPORT_GLOBS) {
    const full = join(paths.evalDir, entry);
    if (!existsSync(full)) continue;
    for (const file of walk(full)) {
      const text = readFileSync(file, "utf8");
      findings.push(...scanText(text, relative(paths.repo, file), hosts));
    }
  }
  return findings;
}

function walk(path: string): string[] {
  const st = statSync(path);
  if (st.isFile()) return [path];
  const out: string[] = [];
  for (const name of readdirSync(path).sort()) out.push(...walk(join(path, name)));
  return out;
}
