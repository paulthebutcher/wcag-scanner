import { describe, it, expect } from "vitest";
import {
  loadThirdPartyConfig, parseCompoundSelector, parseOpeningTag, matchesCompoundSelector, vendorForTag, closeOf,
  findEmbedContainers, vendorForMarkers, classifyInDom, tagCheckResults, thirdPartyTagOf, isThirdPartyFinding,
  containersOf, writeThirdPartyReport, loadThirdPartyReport,
} from "../../src/core/third-party.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckResult } from "../../src/types.js";
import { makeTestFinding } from "./finding-factory.js";

const config = loadThirdPartyConfig();

const PAGE = `<html><body>
<div class="insta-vid"><iframe src="https://www.instagram.com/reel/ABC/embed/" width="100%" height="480" frameborder="0"></iframe></div>
<div class="w-embed"><iframe class="instagram-media instagram-media-rendered" id="instagram-embed-0" src="https://www.instagram.com/p/DEF/embed/captioned/" title="Instagram"></iframe></div>
<div class="w-embed w-script"><blockquote class="tiktok-embed" cite="https://www.tiktok.com/@u" id="v11482"> <iframe name="__tt_embed__v11482" src="https://www.tiktok.com/embed/v2/u" style="width:100%"></iframe><section><a href="https://www.tiktok.com/@u">@u</a></section></blockquote></div>
<div class="w-embed-youtubevideo"><iframe src="https://www.youtube.com/embed/l0Sr9bEI-I0?rel=0" frameborder="0"></iframe></div>
<blockquote class="instagram-media" data-instgrm-permalink="https://www.instagram.com/p/x/"><div><a href="https://www.instagram.com/p/x/">A post</a></div><p>Caption <a href="https://www.instagram.com/u/">by user</a></p></blockquote>
<a href="http://instagram.com/popflyco" class="footer-social-link"><img alt="" src="ig.svg"></a>
<div class="grsf-global grsf-unique-abc grsf-global-show"><div class="grsf-stack"><div id="grsf-window" class="grsf-window"><div class="grsf-panel"><button id="grsf-signup-button" class="grsf-btn">Join</button></div></div></div></div>
<p class="own">Own content <a href="/x">link</a></p>
</body></html>`;

describe("third-party embed config and selector matcher", () => {
  it("loads the committed vendor list", () => {
    expect(config.vendors.map((v) => v.id)).toEqual(["instagram", "tiktok", "youtube", "vimeo", "x", "growsurf"]);
    for (const v of config.vendors) expect(v.containers.length).toBeGreaterThan(0);
  });

  it("parses compound selectors and matches opening tags", () => {
    const tag = parseOpeningTag(`<iframe class="instagram-media instagram-media-rendered" id="instagram-embed-3" src="https://www.instagram.com/p/x/embed/" allowtransparency>`)!;
    expect(tag.name).toBe("iframe");
    expect(matchesCompoundSelector(tag, "iframe[src*=\"instagram.com\"]")).toBe(true);
    expect(matchesCompoundSelector(tag, "[id^=\"instagram-embed-\"]")).toBe(true);
    expect(matchesCompoundSelector(tag, "iframe.instagram-media")).toBe(true);
    expect(matchesCompoundSelector(tag, "blockquote.instagram-media")).toBe(false);
    expect(matchesCompoundSelector(tag, "iframe[src$=\"/embed/\"]")).toBe(true);
    expect(matchesCompoundSelector(tag, "iframe[allowtransparency]")).toBe(true);
    expect(matchesCompoundSelector(tag, "iframe[name^=\"__tt_embed__\"]")).toBe(false);
    expect(parseCompoundSelector("iframe[name^=\"__tt_embed__\"]")).toEqual({ tag: "iframe", id: null, classes: [], attrs: [{ name: "name", op: "^=", value: "__tt_embed__" }] });
    expect(() => parseCompoundSelector("div > a")).toThrow(/compound/);
    expect(vendorForTag(parseOpeningTag(`<a href="http://instagram.com/popflyco" class="footer-social-link">`)!, config)).toBeNull();
  });

  it("finds the closing tag of a nested container", () => {
    const dom = `<div class="a"><div>x</div><div><div>y</div></div></div><div>after</div>`;
    const open = dom.indexOf(">") + 1;
    expect(dom.slice(closeOf(dom, "div", open))).toBe(`</div><div>after</div>`);
    expect(closeOf(`<iframe src="x"></iframe>z`, "iframe", 16)).toBe(16);
  });
});

describe("embed containers in a serialized DOM", () => {
  it("lists every vendor container once, in order, with the footer social link left out", () => {
    const c = findEmbedContainers(PAGE, config);
    expect(c.map((x) => [x.vendor, x.tag, x.selector_hint])).toEqual([
      ["instagram", "iframe", 'iframe[src="https://www.instagram.com/reel/ABC/embed/"]'],
      ["instagram", "iframe", "#instagram-embed-0"],
      ["tiktok", "blockquote", "#v11482"],
      ["youtube", "iframe", 'iframe[src="https://www.youtube.com/embed/l0Sr9bEI-I0?rel=0"]'],
      ["instagram", "blockquote", "blockquote.instagram-media"],
      ["growsurf", "div", "div.grsf-global"],
    ]);
    // The TikTok iframe sits inside the TikTok blockquote: one container, not two
    expect(c.filter((x) => x.vendor === "tiktok")).toHaveLength(1);
    const tt = c.find((x) => x.vendor === "tiktok")!;
    expect(PAGE.slice(tt.start, tt.end)).toContain('name="__tt_embed__v11482"');
    expect(containersOf(PAGE)).toHaveLength(6);
  });
});

describe("classifying findings", () => {
  const containers = findEmbedContainers(PAGE, config);
  const inside = (selector: string, html: string) => classifyInDom(selector, html, PAGE, containers, config);

  it("tags an element inside a blockquote embed, by position, and not the container itself", () => {
    expect(inside("blockquote.instagram-media > p > a", `<a href="https://www.instagram.com/u/">by user</a>`)).toMatchObject({ vendor: "instagram", via: "dom", container: "blockquote.instagram-media" });
    expect(inside("section > a", `<a href="https://www.tiktok.com/@u">@u</a>`)).toMatchObject({ vendor: "tiktok", via: "dom", container: "#v11482" });
    expect(inside("blockquote.instagram-media", `<blockquote class="instagram-media" data-instgrm-permalink="https://www.instagram.com/p/x/">`)).toBeNull();
    expect(inside("#instagram-embed-0", `<iframe class="instagram-media instagram-media-rendered" id="instagram-embed-0" src="https://www.instagram.com/p/DEF/embed/captioned/" title="Instagram"></iframe>`)).toBeNull();
  });

  it("tags vendor-marked elements (GrowSurf) and a selector path through a container", () => {
    expect(vendorForMarkers("#grsf-signup-button", `<button id="grsf-signup-button" class="grsf-btn">Join</button>`, config)?.id).toBe("growsurf");
    expect(vendorForMarkers(".grsf-unique-abc .grsf-leaderboard", `.grsf-unique-abc .grsf-leaderboard { animation: spin 1s }`, config)?.id).toBe("growsurf");
    expect(vendorForMarkers("div.x", `<div data-grsf-campaign="1">`, config)?.id).toBe("growsurf");
    expect(vendorForMarkers("img.y", `<img src="https://cdn.growsurf.com/a.png">`, config)?.id).toBe("growsurf");
    expect(vendorForMarkers("p.own > a", `<a href="/x">link</a>`, config)).toBeNull();
    expect(inside("#instagram-embed-0 > div > a", `<a href="/deep">deep</a>`)).toMatchObject({ vendor: "instagram", via: "selector" });
  });

  it("leaves the page's own content and vendor-site links untagged", () => {
    expect(inside("p.own > a", `<a href="/x">link</a>`)).toBeNull();
    expect(inside("a.footer-social-link", `<a href="http://instagram.com/popflyco" class="footer-social-link"><img alt="" src="ig.svg"></a>`)).toBeNull();
  });

  it("tagCheckResults sets the tag once and keeps existing tags", () => {
    const results: CheckResult[] = [
      { element_selector: "p.own > a", element_html: `<a href="/x">link</a>`, wcag_criterion: "2.4.4", detected_by: "claude_api", raw_result: {} },
      { element_selector: "section > a", element_html: `<a href="https://www.tiktok.com/@u">@u</a>`, wcag_criterion: "2.4.4", detected_by: "claude_api", raw_result: {}, measured_values: { failure_type: "generic_link_text" } },
      { element_selector: "x", element_html: "<x>", wcag_criterion: "1.1.1", detected_by: "axe_core", raw_result: {}, measured_values: { third_party: { vendor: "youtube", vendor_name: "YouTube", container: "iframe", via: "frame" } } },
    ];
    expect(tagCheckResults(results, PAGE, config)).toBe(1);
    expect(results[0].measured_values?.third_party).toBeUndefined();
    expect(results[1].measured_values).toMatchObject({ failure_type: "generic_link_text", third_party: { vendor: "tiktok", vendor_name: "TikTok" } });
    expect((results[2].measured_values?.third_party as { vendor: string }).vendor).toBe("youtube");
    const f = makeTestFinding({ failureType: "generic_link_text", measured: { third_party: { vendor: "tiktok", vendor_name: "TikTok", container: "#v11482", via: "dom" } } });
    expect(thirdPartyTagOf(f)?.vendor_name).toBe("TikTok");
    expect(isThirdPartyFinding(makeTestFinding({ failureType: "x" }))).toBe(false);
  });

  it("writes and reads the per-scan record", () => {
    const dir = mkdtempSync(join(tmpdir(), "wcag-tp-"));
    try {
      const report = { scan_id: "s1", config_version: 1, pages: [{ page_url: "https://x.test/", containers: containersOf(PAGE), sweep: { embeds_entered: [{ vendor: "instagram", vendor_name: "Instagram", container: "#instagram-embed-0", focusables_inside: null, kept_focus: false }] } }] };
      writeThirdPartyReport(dir, report);
      expect(loadThirdPartyReport(dir, "s1")).toEqual(report);
      expect(loadThirdPartyReport(dir, "nope")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
