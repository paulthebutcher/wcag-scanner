import { describe, it, expect } from "vitest";
import { buildThirdPartySection, renderThirdPartyMarkdown, renderThirdPartyHtml, THIRD_PARTY_WORDING } from "../../src/report/third-party-report.js";
import { partitionExclusions, exclusionFor } from "../../src/report/clustering.js";
import { renderExcludedMarkdown } from "../../src/report/top-fixes-report.js";
import { computeSummary, criterionStatusFromFindings, reconcileInMemory } from "../../src/core/scanner.js";
import { scoreConfidence } from "../../src/core/confidence.js";
import type { CriterionResult, Finding } from "../../src/types.js";
import { makeTestFinding } from "./finding-factory.js";

const tag = (vendor: string, name: string, container: string) => ({ third_party: { vendor, vendor_name: name, container, via: "frame" } });
const tp = (page: string, failureType: string, vendor = "instagram", name = "Instagram", container = "#instagram-embed-0") =>
  ({ finding: makeTestFinding({ criterion: "1.1.1", failureType, selector: container, html: `<img src="${failureType}.jpg">`, pageSnapshotId: page, measured: tag(vendor, name, container) }), pageUrl: `https://x.test${page}` });
const own = (page: string) => ({ finding: makeTestFinding({ criterion: "1.1.1", failureType: "image-alt", selector: "img.hero", html: `<img src="hero.jpg">`, pageSnapshotId: page }), pageUrl: `https://x.test${page}` });

describe("third-party content section", () => {
  it("groups findings per page and vendor with embed counts and sweep notes", () => {
    const { kept, excluded } = partitionExclusions([tp("/post", "image-alt"), tp("/post", "link-in-text-block"), tp("/post", "video-caption", "tiktok", "TikTok", "iframe[name=\"__tt_embed__1\"]"), own("/post"), tp("/other", "image-alt")]);
    expect(kept).toHaveLength(1);
    const record = {
      scan_id: "s", config_version: 1,
      pages: [
        { page_url: "https://x.test/post", containers: [{ vendor: "instagram", vendor_name: "Instagram", tag: "iframe", id: "instagram-embed-0", selector_hint: "#instagram-embed-0" }, { vendor: "instagram", vendor_name: "Instagram", tag: "iframe", id: "instagram-embed-1", selector_hint: "#instagram-embed-1" }, { vendor: "tiktok", vendor_name: "TikTok", tag: "blockquote", id: null, selector_hint: "blockquote.tiktok-embed" }],
          sweep: { embeds_entered: [{ vendor: "instagram", vendor_name: "Instagram", container: "#instagram-embed-0", focusables_inside: null, kept_focus: false }, { vendor: "tiktok", vendor_name: "TikTok", container: "blockquote.tiktok-embed", focusables_inside: 2, kept_focus: true }] } },
        { page_url: "https://x.test/quiet", containers: [{ vendor: "youtube", vendor_name: "YouTube", tag: "iframe", id: null, selector_hint: "iframe[src=\"https://www.youtube.com/embed/a\"]" }], sweep: null },
      ],
    };
    const s = buildThirdPartySection(excluded, record);
    expect(s.total_findings).toBe(4);
    expect(s.total_embeds).toBe(4);
    expect(s.pages.map((p) => p.page_url)).toEqual(["https://x.test/other", "https://x.test/post", "https://x.test/quiet"]);
    const post = s.pages[1];
    expect(post.vendors.map((v) => [v.vendor_name, v.embed_count, v.findings.length, v.sweep])).toEqual([
      ["Instagram", 2, 2, { embeds_entered: 1, controls_inside: null, kept_focus: 0 }],
      ["TikTok", 1, 1, { embeds_entered: 1, controls_inside: 2, kept_focus: 1 }],
    ]);
    // Without the record, containers come from the page DOM
    const fromDom = buildThirdPartySection(excluded, null, (url) => url.endsWith("/other") ? `<iframe id="instagram-embed-0" src="https://www.instagram.com/p/a/embed/"></iframe>` : null);
    expect(fromDom.pages.find((p) => p.page_url.endsWith("/other"))?.vendors[0].embed_count).toBe(1);

    const md = renderThirdPartyMarkdown(s);
    expect(md).toContain("## Third-party content (4 finding(s) inside 4 embed(s))");
    expect(md).toContain(THIRD_PARTY_WORDING);
    expect(md).toContain("- **TikTok**: 1 embed(s), 1 finding(s) listed; keyboard sweep stepped over 1 embed(s), 2 focusable control(s) inside; 1 kept focus (possible trap, see 2.1.2)");
    expect(md).toContain("| video-caption | 1.1.1 | major | definitive | `iframe[name=\"__tt_embed__1\"]`");
    expect(md).toContain("- **YouTube**: 1 embed(s), 0 finding(s) listed");
    const html = renderThirdPartyHtml(s);
    expect(html).toContain("Third-Party Content (4 findings inside 4 embeds)");
    expect(html).toContain(THIRD_PARTY_WORDING);
    expect(renderThirdPartyHtml({ pages: [], total_findings: 0, total_embeds: 0 })).toBe("");
    // The excluded sections no longer carry a third-party table of their own
    expect(renderExcludedMarkdown(excluded)).not.toContain("Third-party");
  });

  it("exclusionFor reads the tag, and still recognises GrowSurf markers on older scans", () => {
    expect(exclusionFor(tp("/p", "image-alt").finding)).toEqual({ reason: "third_party", detail: "Instagram" });
    expect(exclusionFor(makeTestFinding({ failureType: "empty_link", html: '<a id="grsf-x"></a>' }))).toEqual({ reason: "third_party", detail: "GrowSurf" });
    expect(exclusionFor(own("/p").finding)).toBeNull();
  });
});

describe("third-party findings set no criterion status and are counted apart", () => {
  const scored = (f: Finding): Finding => ({ ...f, confidence: scoreConfidence(f) });
  const cr = (criterion: string, status: CriterionResult["status"]): CriterionResult => ({ scan_session_id: "s", wcag_criterion: criterion, status, tested_by: "axe_core", evidence_summary: "stored", finding_ids: [] });
  const embedOnly = scored(tp("/p", "image-alt").finding);
  const ownFail = scored(own("/p").finding);

  it("criterionStatusFromFindings ignores tagged findings", () => {
    expect(criterionStatusFromFindings([embedOnly])).toBeNull();
    expect(criterionStatusFromFindings([embedOnly, ownFail])).toEqual({ status: "failed", summary: "1 violation(s) found" });
  });

  it("reconcileInMemory keeps the stored status when only tagged findings remain, and never passes on them", () => {
    expect(reconcileInMemory("s", [embedOnly], [cr("1.1.1", "passed")])[0].status).toBe("passed");
    expect(reconcileInMemory("s", [embedOnly], [cr("1.1.1", "not_tested")])[0].status).toBe("not_tested");
    const [r] = reconcileInMemory("s", [embedOnly, ownFail], [cr("1.1.1", "passed")]);
    expect(r.status).toBe("failed");
    expect(r.finding_ids).toEqual([ownFail.id]);
  });

  it("computeSummary counts tagged findings separately from confirmed and needs-review ones", () => {
    const s = computeSummary("s", [embedOnly, ownFail, scored(tp("/q", "video-caption", "tiktok", "TikTok", "iframe"). finding)], [cr("2.4.1", "passed")]);
    expect(s.total_findings).toBe(1);
    expect(s.by_severity.major).toBe(1);
    expect(s.third_party_findings).toBe(2);
    expect(s.third_party_by_vendor).toEqual({ Instagram: 1, TikTok: 1 });
    expect(s.wcag_criteria_failed).toEqual(["1.1.1"]);
    expect(s.by_confidence.definitive).toBe(1);
  });
});
