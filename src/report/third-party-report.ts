import type { Finding } from "../types.js";
import type { ExcludedFinding } from "./clustering.js";
import { containersOf, loadThirdPartyConfig, thirdPartyTagOf, type EmbedSweepStop, type ThirdPartyReport } from "../core/third-party.js";
import { otherPageCount } from "./occurrences.js";

// ---------------------------------------------------------------------------
// "Third-party content" section (P2-017): per page and vendor, the embeds
// found, the findings inside them (kept for awareness, not counted) and what
// the keyboard sweep did with them. Container-level findings the site
// controls (an iframe title, placement) are not here; they stay in the
// main findings.
// ---------------------------------------------------------------------------

export const THIRD_PARTY_WORDING =
  "Issues inside third-party embeds are listed for awareness. The site owner may still be responsible for embedded content; they are not counted in this report's findings.";

export interface ThirdPartyFindingRow {
  criterion: string;
  failure_type: string;
  severity: Finding["severity"];
  tier: Finding["confidence"]["tier"];
  detected_by: Finding["evidence"]["detected_by"];
  selector: string;
  html: string;
  /** Pages the same finding was folded onto (deduplicated findings) */
  also_on: number;
}

export interface ThirdPartyVendorSection {
  vendor: string;
  vendor_name: string;
  embed_count: number;
  findings: ThirdPartyFindingRow[];
  sweep: { embeds_entered: number; controls_inside: number | null; kept_focus: number } | null;
}

export interface ThirdPartyPageSection {
  page_url: string;
  vendors: ThirdPartyVendorSection[];
}

export interface ThirdPartySection {
  pages: ThirdPartyPageSection[];
  total_findings: number;
  total_embeds: number;
}

function vendorNameOf(ex: ExcludedFinding): { vendor: string; vendor_name: string } {
  const tag = thirdPartyTagOf(ex.finding);
  if (tag) return { vendor: tag.vendor, vendor_name: tag.vendor_name };
  const known = loadThirdPartyConfig().vendors.find((v) => v.name === ex.detail);
  return known ? { vendor: known.id, vendor_name: known.name } : { vendor: ex.detail.toLowerCase().replace(/[^a-z0-9]+/g, "-"), vendor_name: ex.detail };
}

/**
 * Build the section from the report's excluded third-party findings, the
 * scan's third-party.json (containers and sweep stops; absent for older
 * scans) and, when that is missing, the stored page DOMs.
 */
export function buildThirdPartySection(
  excluded: ExcludedFinding[],
  record: ThirdPartyReport | null,
  domOf?: (pageUrl: string) => string | null,
): ThirdPartySection {
  const pages = new Map<string, Map<string, ThirdPartyVendorSection>>();
  const vendorSection = (pageUrl: string, vendor: string, vendorName: string): ThirdPartyVendorSection => {
    const byVendor = pages.get(pageUrl) ?? new Map<string, ThirdPartyVendorSection>();
    pages.set(pageUrl, byVendor);
    const existing = byVendor.get(vendor);
    if (existing) return existing;
    const created: ThirdPartyVendorSection = { vendor, vendor_name: vendorName, embed_count: 0, findings: [], sweep: null };
    byVendor.set(vendor, created);
    return created;
  };

  // Containers and sweep stops per page
  const recordPages = new Map((record?.pages ?? []).map((p) => [p.page_url, p]));
  const pageUrls = new Set<string>([...recordPages.keys(), ...excluded.filter((e) => e.reason === "third_party").map((e) => e.pageUrl)]);
  for (const url of pageUrls) {
    const rec = recordPages.get(url);
    const containers = rec ? rec.containers : (domOf ? containersOf(domOf(url) ?? "") : []);
    for (const c of containers) vendorSection(url, c.vendor, c.vendor_name).embed_count++;
    const stops: EmbedSweepStop[] = rec?.sweep?.embeds_entered ?? [];
    for (const s of stops) {
      const v = vendorSection(url, s.vendor, s.vendor_name);
      const sweep = v.sweep ?? { embeds_entered: 0, controls_inside: null, kept_focus: 0 };
      sweep.embeds_entered++;
      if (s.focusables_inside !== null) sweep.controls_inside = (sweep.controls_inside ?? 0) + s.focusables_inside;
      if (s.kept_focus) sweep.kept_focus++;
      v.sweep = sweep;
    }
  }

  // Findings inside embeds
  let total = 0;
  for (const ex of excluded) {
    if (ex.reason !== "third_party") continue;
    const { vendor, vendor_name } = vendorNameOf(ex);
    const f = ex.finding;
    vendorSection(ex.pageUrl, vendor, vendor_name).findings.push({
      criterion: f.wcag_criterion,
      failure_type: String(f.evidence.measured_values?.failure_type ?? "(none)"),
      severity: f.severity,
      tier: f.confidence.tier,
      detected_by: f.evidence.detected_by,
      selector: f.evidence.element_selector,
      html: f.evidence.element_html,
      also_on: otherPageCount(f),
    });
    total++;
  }

  const out: ThirdPartyPageSection[] = Array.from(pages, ([page_url, byVendor]) => ({
    page_url,
    vendors: Array.from(byVendor.values())
      .filter((v) => v.embed_count > 0 || v.findings.length > 0 || v.sweep)
      .sort((a, b) => a.vendor_name.localeCompare(b.vendor_name)),
  })).filter((p) => p.vendors.length > 0).sort((a, b) => pathOf(a.page_url).localeCompare(pathOf(b.page_url)));
  return { pages: out, total_findings: total, total_embeds: out.reduce((n, p) => n + p.vendors.reduce((m, v) => m + v.embed_count, 0), 0) };
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function htmlEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function mdCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function sweepText(v: ThirdPartyVendorSection): string {
  if (!v.sweep) return "";
  const inside = v.sweep.controls_inside === null ? "contents not inspected" : `${v.sweep.controls_inside} focusable control(s) inside`;
  const kept = v.sweep.kept_focus > 0 ? `; ${v.sweep.kept_focus} kept focus (possible trap, see 2.1.2)` : "";
  return `keyboard sweep stepped over ${v.sweep.embeds_entered} embed(s), ${inside}${kept}`;
}

export function renderThirdPartyMarkdown(section: ThirdPartySection | null | undefined): string {
  if (!section || section.pages.length === 0) return "";
  const lines = [
    `## Third-party content (${section.total_findings} finding(s) inside ${section.total_embeds} embed(s))`,
    "",
    THIRD_PARTY_WORDING,
    "",
  ];
  for (const p of section.pages) {
    lines.push(`### ${pathOf(p.page_url)}`, "");
    for (const v of p.vendors) {
      const sweep = sweepText(v);
      lines.push(`- **${v.vendor_name}**: ${v.embed_count} embed(s), ${v.findings.length} finding(s) listed${sweep ? `; ${sweep}` : ""}`);
      if (v.findings.length > 0) {
        lines.push("", "| Check / failure type | WCAG | Severity | Tier | Element |", "|---|---|---|---|---|");
        for (const f of v.findings) {
          lines.push(`| ${mdCell(f.failure_type)} | ${f.criterion} | ${f.severity} | ${f.tier} | \`${mdCell(f.selector)}\` ${mdCell(f.html.slice(0, 100))}${f.also_on > 0 ? ` (+${f.also_on} page(s))` : ""} |`);
        }
        lines.push("");
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function renderThirdPartyHtml(section: ThirdPartySection | null | undefined): string {
  if (!section || section.pages.length === 0) return "";
  const pages = section.pages.map((p) => `
      <h3><code>${htmlEsc(pathOf(p.page_url))}</code></h3>
      ${p.vendors.map((v) => `
      <div class="third-party-vendor">
        <p><strong>${htmlEsc(v.vendor_name)}</strong>: ${v.embed_count} embed${v.embed_count !== 1 ? "s" : ""}, ${v.findings.length} finding${v.findings.length !== 1 ? "s" : ""} listed${v.sweep ? `; ${htmlEsc(sweepText(v))}` : ""}</p>
        ${v.findings.length > 0 ? `<details><summary>${v.findings.length} finding${v.findings.length !== 1 ? "s" : ""} inside ${htmlEsc(v.vendor_name)} content</summary>
        <table class="topfix-table">
          <thead><tr><th>Check / failure type</th><th>WCAG</th><th>Severity</th><th>Tier</th><th>Element</th></tr></thead>
          <tbody>${v.findings.map((f) => `
            <tr><td>${htmlEsc(f.failure_type)}</td><td>${htmlEsc(f.criterion)}</td><td>${htmlEsc(f.severity)}</td><td>${htmlEsc(f.tier)}</td><td><code>${htmlEsc(f.selector)}</code><div class="topfix-summary">${htmlEsc(f.html.slice(0, 160))}${f.also_on > 0 ? ` (+${f.also_on} page${f.also_on !== 1 ? "s" : ""})` : ""}</div></td></tr>`).join("")}
          </tbody>
        </table></details>` : ""}
      </div>`).join("")}`).join("");
  return `
    <section class="excluded third-party" id="third-party-content">
      <h2>Third-Party Content (${section.total_findings} finding${section.total_findings !== 1 ? "s" : ""} inside ${section.total_embeds} embed${section.total_embeds !== 1 ? "s" : ""})</h2>
      <p class="section-intro">${htmlEsc(THIRD_PARTY_WORDING)}</p>
      ${pages}
    </section>`;
}
