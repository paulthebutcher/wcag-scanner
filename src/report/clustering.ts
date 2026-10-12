import { createHash } from "node:crypto";
import type { Finding, Severity } from "../types.js";
import { parseContrastMeasurement } from "../core/contrast.js";
import { buildSpecificRemediation } from "../adapters/webflow.js";
import { findingPageUrls, pageOccurrences } from "./occurrences.js";

// ---------------------------------------------------------------------------
// Component clustering ("Top fixes")
//
// Findings are grouped into clusters that one fix clears: same failure type
// on the same component, wherever it occurs. The signature is deterministic
// so a later rescan can be matched cluster by cluster (`wcag verify`).
// ---------------------------------------------------------------------------

/** A finding with the URL of the page it is stored against. */
export interface PagedFinding {
  finding: Finding;
  pageUrl: string;
}

export interface ClusterRemediation {
  summary: string;
  steps: string[];
  designer_path: string;
  code_fix: string | null;
}

export interface Cluster {
  /** Stable hash of the signature */
  cluster_id: string;
  signature: string;
  failure_type: string;
  wcag_criterion: string;
  /** Highest severity among the cluster's findings */
  severity: Severity;
  /** Every page the cluster occurs on, sorted */
  page_urls: string[];
  page_count: number;
  /** Page occurrences (deduplicated findings expanded to every page) */
  occurrence_count: number;
  /** False when some folded pages are known only by count (older scans) */
  pages_complete: boolean;
  representative: { selector: string; html: string; page_url: string };
  remediation: ClusterRemediation;
  finding_ids: string[];
  findings: Finding[];
}

export type ExclusionReason = "needs_manual_check" | "third_party";

export interface ExcludedFinding extends PagedFinding {
  reason: ExclusionReason;
  /** e.g. "background colour could not be determined: element contains an image node", "GrowSurf" */
  detail: string;
}

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

/** Remove positional pseudo-classes so the same component matches on every page. */
export function normalizeSelector(selector: string): string {
  return selector
    .replace(/:nth-(?:last-)?(?:child|of-type)\([^)]*\)/g, "")
    .replace(/\s*>\s*/g, " > ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Drop the values of src, href, srcset and style, which vary between pages and builds. */
export function stripVolatileAttributes(html: string): string {
  return html
    .replace(/\s(src|href|srcset|style)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, " $1")
    .replace(/\s+/g, " ")
    .trim();
}

function rootTag(html: string): string {
  const m = html.match(/^\s*<[a-zA-Z][a-zA-Z0-9-]*[^>]*>/);
  return m ? m[0] : "";
}

function attrValue(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}

/** Class list of the element's own (root) tag, sorted. */
export function rootClassList(html: string): string[] {
  const cls = attrValue(rootTag(html), "class");
  return cls ? cls.split(/\s+/).filter(Boolean).sort() : [];
}

/** Webflow interaction id of the element's own tag, if any. */
export function dataWId(html: string): string | null {
  return attrValue(rootTag(html), "data-w-id");
}

function sha1(text: string, length = 16): string {
  return createHash("sha1").update(text).digest("hex").slice(0, length);
}

export function failureTypeOf(finding: Finding): string {
  const ft = finding.evidence.measured_values?.failure_type;
  return typeof ft === "string" && ft ? ft : "unknown";
}

/**
 * Deterministic signature of a finding's component and failure.
 *
 * Normally: criterion | failure type | selector without :nth-* | root class
 * list | data-w-id | hash of the HTML with src/href/srcset/style values
 * removed.
 *
 * Measured axe colour-contrast results are keyed by their foreground colour
 * instead: the fix is one colour change, and that colour is usually shared by
 * several components (footer links, cookie banner links, legal-page links).
 */
export function elementSignature(finding: Finding): string {
  const ft = failureTypeOf(finding);
  if (ft === "color-contrast") {
    const m = parseContrastMeasurement(finding.analysis.reasoning);
    if (m) return ["1.4.3", ft, `fg:${m.foreground}`].join("|");
  }
  const html = finding.evidence.element_html ?? "";
  return [
    finding.wcag_criterion,
    ft,
    normalizeSelector(finding.evidence.element_selector ?? ""),
    rootClassList(html).join(" "),
    dataWId(html) ?? "",
    sha1(stripVolatileAttributes(html)),
  ].join("|");
}

/** Stable id for a signature. */
export function clusterId(signature: string): string {
  return sha1(signature, 12);
}

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

function idAndClassTokens(finding: Finding): string[] {
  const tag = rootTag(finding.evidence.element_html ?? "");
  const tokens = [
    ...(attrValue(tag, "id") ?? "").split(/\s+/),
    ...(attrValue(tag, "class") ?? "").split(/\s+/),
    ...Array.from((finding.evidence.element_selector ?? "").matchAll(/[#.]([A-Za-z0-9_-]+)/g), (m) => m[1]),
  ];
  return tokens.filter(Boolean);
}

/**
 * GrowSurf (referral widget) content. One function so every rule lives in
 * one place: the element's own data-grsf-* attribute or grsf- id/class, a
 * grsf- id/class on any ancestor named in its selector path, or a
 * src/href/srcset pointing at GrowSurf. Stored findings keep only the
 * element's own markup, so ancestors are seen through the selector.
 */
export function isGrowSurfElement(finding: Finding): boolean {
  const html = finding.evidence.element_html ?? "";
  const selector = finding.evidence.element_selector ?? "";
  const tag = rootTag(html);
  if (/\sdata-grsf[\w-]*(\s*=|[\s>/])/i.test(tag)) return true;
  if (idAndClassTokens(finding).some((t) => t.startsWith("grsf-"))) return true;
  if (/\[data-grsf/i.test(selector)) return true;
  for (const attr of ["src", "href", "srcset"]) {
    if (/growsurf/i.test(attrValue(tag, attr) ?? "")) return true;
  }
  // Attribute selectors such as img[src="https://…growsurf-prod/…"]
  return /\[(?:src|href|srcset)[^\]]*growsurf/i.test(selector);
}

/**
 * Why a finding is left out of Top fixes and failure counts, or null:
 * - axe colour-contrast where the background could not be determined
 *   (image, gradient, overlap) → needs a manual check;
 * - GrowSurf content (isGrowSurfElement) or content inside an embedded
 *   frame → third party.
 */
export function exclusionFor(finding: Finding): { reason: ExclusionReason; detail: string } | null {
  if (isGrowSurfElement(finding)) return { reason: "third_party", detail: "GrowSurf" };
  // axe reports results inside an embedded frame against the iframe's
  // selector, with the frame's own markup as the element: content from
  // YouTube, Instagram and similar embeds the site cannot edit.
  if (finding.evidence.detected_by === "axe_core" && /^iframe\b/i.test(finding.evidence.element_selector ?? "")) {
    const tag = (finding.evidence.element_html ?? "").match(/^\s*<([a-zA-Z][a-zA-Z0-9-]*)/)?.[1]?.toLowerCase();
    if (tag && tag !== "iframe") return { reason: "third_party", detail: "Embedded frame content (video players, social embeds)" };
  }
  if (finding.evidence.detected_by === "axe_core" && failureTypeOf(finding) === "color-contrast") {
    const m = finding.analysis.reasoning.match(/background color could not be determined\s+(?:because|due to)\s+([^.\n]+)/i);
    if (m) return { reason: "needs_manual_check", detail: `background colour could not be determined: ${m[1].trim()}` };
  }
  return null;
}

export function partitionExclusions(findings: PagedFinding[]): { kept: PagedFinding[]; excluded: ExcludedFinding[] } {
  const kept: PagedFinding[] = [];
  const excluded: ExcludedFinding[] = [];
  for (const pf of findings) {
    const ex = exclusionFor(pf.finding);
    if (ex) excluded.push({ ...pf, ...ex });
    else kept.push(pf);
  }
  return { kept, excluded };
}

// ---------------------------------------------------------------------------
// Clustering + ranking
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, major: 1, minor: 2, advisory: 3 };

function remediationFor(findings: Finding[], platform: string): ClusterRemediation {
  const specific = platform === "webflow" ? buildSpecificRemediation(findings) : null;
  if (specific) {
    return { summary: specific.generic_fix, steps: specific.steps, designer_path: specific.designer_path, code_fix: specific.code_fix };
  }
  const withSteps = findings.find((f) => f.remediation.platform_fix.steps.length > 0) ?? findings[0];
  const r = withSteps.remediation;
  return {
    summary: r.generic_fix || r.platform_fix.steps[0] || "",
    steps: r.platform_fix.steps,
    designer_path: r.platform_fix.designer_path,
    code_fix: r.code_fix,
  };
}

/** Group findings into clusters, ranked by occurrences one fix clears. */
export function clusterFindings(findings: PagedFinding[], options: { platform?: string } = {}): Cluster[] {
  const platform = options.platform ?? "webflow";
  const bySignature = new Map<string, PagedFinding[]>();
  for (const pf of findings) {
    const sig = elementSignature(pf.finding);
    const list = bySignature.get(sig) ?? [];
    list.push(pf);
    bySignature.set(sig, list);
  }

  const clusters: Cluster[] = [];
  for (const [signature, members] of bySignature) {
    // Deterministic order: by page URL, then finding id
    members.sort((a, b) => a.pageUrl.localeCompare(b.pageUrl) || a.finding.id.localeCompare(b.finding.id));
    const pages = new Set<string>();
    let complete = true;
    let maxPerFinding = 0;
    let occurrences = 0;
    for (const { finding, pageUrl } of members) {
      const { urls, complete: c } = findingPageUrls(finding, pageUrl);
      urls.forEach((u) => pages.add(u));
      complete &&= c;
      occurrences += pageOccurrences(finding);
      maxPerFinding = Math.max(maxPerFinding, pageOccurrences(finding));
    }
    const fs = members.map((m) => m.finding);
    const severity = fs.reduce<Severity>((best, f) => (SEVERITY_RANK[f.severity] < SEVERITY_RANK[best] ? f.severity : best), "advisory");
    const rep = members[0];
    clusters.push({
      cluster_id: clusterId(signature),
      signature,
      failure_type: failureTypeOf(rep.finding),
      wcag_criterion: rep.finding.wcag_criterion,
      severity,
      page_urls: Array.from(pages).sort(),
      // Older scans store folded pages as a count only
      page_count: Math.max(pages.size, maxPerFinding),
      occurrence_count: occurrences,
      pages_complete: complete,
      representative: {
        selector: rep.finding.evidence.element_selector,
        html: rep.finding.evidence.element_html,
        page_url: rep.pageUrl,
      },
      remediation: remediationFor(fs, platform),
      finding_ids: fs.map((f) => f.id),
      findings: fs,
    });
  }

  return rankClusters(clusters);
}

/** Most occurrences cleared per fix first; ties by pages, severity, then id. */
export function rankClusters(clusters: Cluster[]): Cluster[] {
  return [...clusters].sort((a, b) =>
    b.occurrence_count - a.occurrence_count ||
    b.page_count - a.page_count ||
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    a.cluster_id.localeCompare(b.cluster_id),
  );
}

/** Short label for a cluster: the component and what is wrong. */
export function clusterLabel(cluster: Cluster): string {
  if (cluster.failure_type === "color-contrast") {
    const fg = cluster.signature.split("fg:")[1];
    return fg ? `Text colour ${fg} contrast` : "Colour contrast";
  }
  const classes = rootClassList(cluster.representative.html).filter((c) => !c.startsWith("w-") && c !== "w--current");
  const tag = (cluster.representative.html.match(/^\s*<([a-zA-Z0-9-]+)/)?.[1] ?? "").toLowerCase();
  const component = classes.length > 0 ? `${tag}.${classes.join(".")}` : normalizeSelector(cluster.representative.selector) || tag;
  return `${component}: ${cluster.failure_type.replace(/[_-]/g, " ")}`;
}
