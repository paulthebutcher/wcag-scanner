import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckResult, Finding } from "../types.js";

// ---------------------------------------------------------------------------
// Third-party embeds (P2-017, P2-023, P2-034). One definition of the vendors
// (config/third-party-embeds.json) drives three things:
//
//   1. which elements are embed containers (an Instagram or TikTok iframe or
//      blockquote, a YouTube player, the GrowSurf widget);
//   2. the third_party tag on a finding whose element is strictly inside a
//      container (or carries a vendor's own markers), set once where
//      findings are created so every check is covered;
//   3. the per-page inventory the report shows ("Third-party content").
//
// Checks still run on embed contents. Tagged findings are listed for
// awareness and left out of the main findings, severity totals, effort, Top
// fixes and criterion status. Findings on the container itself (a missing
// iframe title, its placement) are the site's own and are never tagged.
// ---------------------------------------------------------------------------

export interface VendorPattern {
  id: string;
  name: string;
  /** Compound selectors (no combinators) that identify an embed container */
  containers: string[];
  /** Elements the vendor injects anywhere, recognised by their own markers */
  element_markers?: { attr_prefix?: string; token_prefix?: string; url_substring?: string };
}

export interface ThirdPartyConfig {
  version: number;
  note?: string;
  vendors: VendorPattern[];
}

/** What a tagged finding carries in measured_values.third_party */
export interface ThirdPartyTag {
  vendor: string;
  vendor_name: string;
  /** The container the element sits in: a selector (axe frame path) or its opening tag */
  container: string;
  /** How it was decided: frame (axe frame path), dom (position in the page's DOM), marker (vendor markers), selector (selector path) */
  via: "frame" | "dom" | "marker" | "selector";
}

const DEFAULT_CONFIG_PATH = fileURLToPath(new URL("../../config/third-party-embeds.json", import.meta.url));
let cached: ThirdPartyConfig | null = null;

/** The vendor list, from WCAG_THIRD_PARTY_CONFIG or config/third-party-embeds.json (cached). */
export function loadThirdPartyConfig(): ThirdPartyConfig {
  if (cached) return cached;
  const path = process.env.WCAG_THIRD_PARTY_CONFIG || DEFAULT_CONFIG_PATH;
  const config = JSON.parse(readFileSync(path, "utf8")) as ThirdPartyConfig;
  if (!Array.isArray(config.vendors)) throw new Error(`${path}: vendors must be an array`);
  for (const v of config.vendors) {
    if (!v.id || !v.name || !Array.isArray(v.containers)) throw new Error(`${path}: vendor needs id, name and containers`);
    for (const s of v.containers) parseCompoundSelector(s); // throws on an unsupported selector
  }
  cached = config;
  return config;
}

/** Test only: forget the cached config. */
export function resetThirdPartyConfig(): void {
  cached = null;
}

/** One selector list per vendor, for `Element.matches` / `closest` in the page. */
export function vendorSelectorLists(config: ThirdPartyConfig = loadThirdPartyConfig()): Array<{ id: string; name: string; selector: string }> {
  return config.vendors.map((v) => ({ id: v.id, name: v.name, selector: v.containers.join(", ") }));
}

// ---------------------------------------------------------------------------
// A compound-selector matcher over serialized opening tags, so containers can
// be found in a stored DOM string without a DOM parser.
// ---------------------------------------------------------------------------

interface AttrTest { name: string; op: "exists" | "=" | "^=" | "$=" | "*="; value: string }
interface CompoundSelector { tag: string | null; id: string | null; classes: string[]; attrs: AttrTest[] }

const SELECTOR_PART = /^([a-zA-Z][\w-]*)?((?:[#.][\w-]+|\[[\w-]+(?:[\^$*]?=(?:"[^"]*"|'[^']*'|[^\]]+))?\])*)$/;

export function parseCompoundSelector(selector: string): CompoundSelector {
  const m = selector.trim().match(SELECTOR_PART);
  if (!m || selector.trim() === "") throw new Error(`Unsupported container selector "${selector}" (compound selectors only)`);
  const out: CompoundSelector = { tag: m[1] ? m[1].toLowerCase() : null, id: null, classes: [], attrs: [] };
  const rest = m[2] ?? "";
  const partRe = /#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:([\^$*]?=)("([^"]*)"|'([^']*)'|([^\]]+)))?\]/g;
  let p: RegExpExecArray | null;
  while ((p = partRe.exec(rest)) !== null) {
    if (p[1]) out.id = p[1];
    else if (p[2]) out.classes.push(p[2]);
    else if (p[3]) {
      const value = p[6] ?? p[7] ?? p[8] ?? "";
      out.attrs.push({ name: p[3].toLowerCase(), op: p[4] ? (p[4] as AttrTest["op"]) : "exists", value });
    }
  }
  return out;
}

export interface ParsedTag { name: string; attrs: Record<string, string> }

/** Parse an opening tag's name and attributes; null when it is not an opening tag. */
export function parseOpeningTag(tag: string): ParsedTag | null {
  const m = tag.match(/^\s*<([a-zA-Z][\w-]*)([^>]*)>/);
  if (!m) return null;
  const attrs: Record<string, string> = {};
  const attrRe = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let a: RegExpExecArray | null;
  while ((a = attrRe.exec(m[2])) !== null) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
  return { name: m[1].toLowerCase(), attrs };
}

export function matchesCompoundSelector(tag: ParsedTag, selector: string | CompoundSelector): boolean {
  const s = typeof selector === "string" ? parseCompoundSelector(selector) : selector;
  if (s.tag && s.tag !== tag.name) return false;
  if (s.id && tag.attrs.id !== s.id) return false;
  if (s.classes.length > 0) {
    const classes = new Set((tag.attrs.class ?? "").split(/\s+/).filter(Boolean));
    if (!s.classes.every((c) => classes.has(c))) return false;
  }
  for (const a of s.attrs) {
    const v = tag.attrs[a.name];
    if (v === undefined) return false;
    if (a.op === "=" && v !== a.value) return false;
    if (a.op === "^=" && !v.startsWith(a.value)) return false;
    if (a.op === "$=" && !v.endsWith(a.value)) return false;
    if (a.op === "*=" && !v.includes(a.value)) return false;
  }
  return true;
}

/** The vendor whose container selectors an opening tag matches, or null. */
export function vendorForTag(tag: ParsedTag, config: ThirdPartyConfig = loadThirdPartyConfig()): VendorPattern | null {
  for (const v of config.vendors) {
    if (v.containers.some((sel) => matchesCompoundSelector(tag, sel))) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Containers in a serialized DOM
// ---------------------------------------------------------------------------

export interface EmbedContainer {
  vendor: string;
  vendor_name: string;
  tag: string;
  id: string | null;
  /** The opening tag, truncated */
  opening: string;
  /** Offsets of the container's contents in the DOM string */
  start: number;
  end: number;
  /** A short selector for display: #id, or tag plus the matched attribute */
  selector_hint: string;
}

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/** Index just before the closing tag that matches an opening tag ending at `openEnd` (depth-counted), or the DOM's end. */
export function closeOf(dom: string, tagName: string, openEnd: number): number {
  if (VOID_TAGS.has(tagName)) return openEnd;
  const re = new RegExp(`<(/?)${tagName}(?=[\\s>/])[^>]*>`, "gi");
  re.lastIndex = openEnd;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(dom)) !== null) {
    if (m[1] === "/") {
      depth--;
      if (depth === 0) return m.index;
    } else if (!m[0].endsWith("/>")) {
      depth++;
    }
  }
  return dom.length;
}

function hintFor(tag: ParsedTag, vendor: VendorPattern): string {
  if (tag.attrs.id) return `#${tag.attrs.id}`;
  for (const sel of vendor.containers) {
    const s = parseCompoundSelector(sel);
    if (matchesCompoundSelector(tag, s) && s.attrs.length > 0) {
      const a = s.attrs[0];
      return `${tag.name}[${a.name}="${(tag.attrs[a.name] ?? "").slice(0, 60)}"]`;
    }
    if (matchesCompoundSelector(tag, s) && s.classes.length > 0) return `${tag.name}.${s.classes.join(".")}`;
  }
  return tag.name;
}

/** Every embed container in a serialized DOM, in document order. */
export function findEmbedContainers(dom: string, config: ThirdPartyConfig = loadThirdPartyConfig()): EmbedContainer[] {
  const out: EmbedContainer[] = [];
  const openRe = /<(iframe|blockquote|div|section|embed|object)(?=[\s>/])[^>]*>/gi;
  let m: RegExpExecArray | null;
  let skipUntil = 0;
  while ((m = openRe.exec(dom)) !== null) {
    if (m.index < skipUntil) continue; // inside a container already recorded
    const tag = parseOpeningTag(m[0]);
    if (!tag) continue;
    const vendor = vendorForTag(tag, config);
    if (!vendor) continue;
    const start = m.index + m[0].length;
    const end = closeOf(dom, tag.name, start);
    out.push({
      vendor: vendor.id, vendor_name: vendor.name, tag: tag.name, id: tag.attrs.id ?? null,
      opening: m[0].length > 200 ? `${m[0].slice(0, 200)}…` : m[0], start, end, selector_hint: hintFor(tag, vendor),
    });
    skipUntil = end;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tagging findings
// ---------------------------------------------------------------------------

function rootTag(html: string): string {
  return html.match(/^\s*<[^>]*>/)?.[0] ?? "";
}

/** Tokens from the element's own id and class and from its selector path. */
function idAndClassTokens(selector: string, html: string): string[] {
  const tag = parseOpeningTag(rootTag(html));
  return [
    ...(tag?.attrs.id ?? "").split(/\s+/),
    ...(tag?.attrs.class ?? "").split(/\s+/),
    ...Array.from(selector.matchAll(/[#.]([A-Za-z0-9_-]+)/g), (x) => x[1]),
  ].filter(Boolean);
}

/**
 * A vendor whose own markers the element carries (GrowSurf: data-grsf-*
 * attributes, grsf- id/class tokens on the element or on an ancestor in its
 * selector path, assets served from growsurf). Works on stored findings
 * without the page.
 */
export function vendorForMarkers(selector: string, html: string, config: ThirdPartyConfig = loadThirdPartyConfig()): VendorPattern | null {
  const tag = rootTag(html);
  const tokens = idAndClassTokens(selector, html);
  for (const v of config.vendors) {
    const mk = v.element_markers;
    if (!mk) continue;
    if (mk.attr_prefix && new RegExp(`\\s${mk.attr_prefix}[\\w-]*(\\s*=|[\\s>/])`, "i").test(tag)) return v;
    if (mk.token_prefix && tokens.some((t) => t.startsWith(mk.token_prefix!))) return v;
    if (mk.attr_prefix && new RegExp(`\\[${mk.attr_prefix}`, "i").test(selector)) return v;
    if (mk.url_substring) {
      const urlRe = new RegExp(mk.url_substring, "i");
      const parsed = parseOpeningTag(tag);
      for (const attr of ["src", "href", "srcset"]) if (urlRe.test(parsed?.attrs[attr] ?? "")) return v;
      if (new RegExp(`\\[(?:src|href|srcset)[^\\]]*${mk.url_substring}`, "i").test(selector)) return v;
    }
  }
  return null;
}

/** Whether the element (by its opening tag) is itself an embed container. */
function isContainerElement(html: string, config: ThirdPartyConfig): boolean {
  const tag = parseOpeningTag(rootTag(html));
  return tag !== null && vendorForTag(tag, config) !== null;
}

/**
 * Tag for an element that a DOM-string check reported (semantic, forms,
 * indicators, behavioral): by the vendor's markers, by its position strictly
 * inside a container's contents, or by a container token in its selector
 * path. Null for the container itself and for anything else.
 */
export function classifyInDom(selector: string, html: string, dom: string, containers: EmbedContainer[], config: ThirdPartyConfig = loadThirdPartyConfig()): ThirdPartyTag | null {
  const marker = vendorForMarkers(selector, html, config);
  if (marker) return { vendor: marker.id, vendor_name: marker.name, container: "vendor markers", via: "marker" };
  if (containers.length === 0 || isContainerElement(html, config)) return null;
  const needle = html.trim();
  if (needle.length >= 8) {
    let at = dom.indexOf(needle);
    while (at !== -1) {
      const c = containers.find((x) => at >= x.start && at < x.end);
      if (c) return { vendor: c.vendor, vendor_name: c.vendor_name, container: c.selector_hint, via: "dom" };
      at = dom.indexOf(needle, at + 1);
    }
  }
  // A selector path through a container (axe frame paths are handled at axe time)
  for (const c of containers) {
    const token = c.id ? `#${c.id}` : null;
    if (token && selector.includes(token) && selector.trim() !== token) {
      return { vendor: c.vendor, vendor_name: c.vendor_name, container: c.selector_hint, via: "selector" };
    }
  }
  return null;
}

/** Set measured_values.third_party on every check result inside a container; results already tagged are kept. */
export function tagCheckResults(results: CheckResult[], dom: string, config: ThirdPartyConfig = loadThirdPartyConfig()): number {
  if (results.every((r) => r.measured_values?.third_party)) return 0;
  const containers = findEmbedContainers(dom, config);
  let tagged = 0;
  for (const r of results) {
    if (r.measured_values?.third_party) continue;
    const tag = classifyInDom(r.element_selector ?? "", r.element_html ?? "", dom, containers, config);
    if (tag) {
      r.measured_values = { ...(r.measured_values ?? {}), third_party: tag };
      tagged++;
    }
  }
  return tagged;
}

/** The third_party tag a stored finding carries, or null. */
export function thirdPartyTagOf(finding: Pick<Finding, "evidence">): ThirdPartyTag | null {
  const t = finding.evidence.measured_values?.third_party as ThirdPartyTag | undefined;
  return t && typeof t === "object" && typeof t.vendor === "string" ? t : null;
}

export function isThirdPartyFinding(finding: Pick<Finding, "evidence">): boolean {
  return thirdPartyTagOf(finding) !== null;
}

// ---------------------------------------------------------------------------
// Per-scan record: <dataDir>/<scanId>/third-party.json
// ---------------------------------------------------------------------------

export interface EmbedSweepStop {
  vendor: string;
  vendor_name: string;
  container: string;
  /** Focusable controls inside the container; null for an iframe (its document is not inspected) */
  focusables_inside: number | null;
  /** The embed kept focus after the sweep tried to move past it */
  kept_focus: boolean;
}

export interface ThirdPartyPageRecord {
  page_url: string;
  containers: Array<Pick<EmbedContainer, "vendor" | "vendor_name" | "tag" | "id" | "selector_hint">>;
  /** From the keyboard sweep, when it ran on the page */
  sweep: { embeds_entered: EmbedSweepStop[] } | null;
}

export interface ThirdPartyReport {
  scan_id: string;
  config_version: number;
  pages: ThirdPartyPageRecord[];
}

export function containersOf(dom: string, config: ThirdPartyConfig = loadThirdPartyConfig()): ThirdPartyPageRecord["containers"] {
  return findEmbedContainers(dom, config).map((c) => ({ vendor: c.vendor, vendor_name: c.vendor_name, tag: c.tag, id: c.id, selector_hint: c.selector_hint }));
}

export function thirdPartyReportPath(dataDir: string, scanId: string): string {
  return join(dataDir, scanId, "third-party.json");
}

export function writeThirdPartyReport(dataDir: string, report: ThirdPartyReport): string {
  const path = thirdPartyReportPath(dataDir, report.scan_id);
  mkdirSync(join(dataDir, report.scan_id), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2), "utf8");
  return path;
}

export function loadThirdPartyReport(dataDir: string, scanId: string): ThirdPartyReport | null {
  const path = thirdPartyReportPath(dataDir, scanId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ThirdPartyReport;
  } catch {
    return null;
  }
}
