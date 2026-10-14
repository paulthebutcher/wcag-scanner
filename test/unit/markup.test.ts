import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withoutRawTextContent } from "../../src/core/markup.js";
import { PromptRunner } from "../../src/core/prompt-runner.js";
import { runAltTextChecks } from "../../src/checks/semantic/alt-text.js";
import { runLinkTextChecks } from "../../src/checks/semantic/link-text.js";
import { runHeadingChecks } from "../../src/checks/semantic/headings.js";
import { runLandmarkLabelChecks } from "../../src/checks/semantic/landmark-labels.js";
import { runDuplicateLinkChecks } from "../../src/checks/semantic/duplicate-links.js";
import { runTableStructureChecks } from "../../src/checks/semantic/table-structure.js";
import { discoverForms } from "../../src/checks/forms/discovery.js";
import { checkMultipleWays } from "../../src/checks/indicators/multiple-ways.js";
import { checkPauseStopHide, checkThreeFlashes, findPauseMechanisms } from "../../src/checks/indicators/pause-stop-hide.js";
import type { PageSnapshot } from "../../src/types.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "..", "fixtures", `${name}.html`), "utf8");
const snapshot = (dom: string): PageSnapshot => ({
  id: "p", scan_session_id: "s", url: "https://x.test/", title: "t", captured_at: "2026-10-14T00:00:00Z", full_dom: dom, screenshot: "",
  viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
});

describe("withoutRawTextContent", () => {
  it("removes the contents of style, script, noscript and template and keeps the tags", () => {
    const html = `<head><style>.a{color:red}</style><script src="x.js"></script><script>var s = "<a href='/'>x</a>";</script></head>`
      + `<body><noscript><iframe src="gtm"></iframe></noscript><template id="t"><img src="t.png"></template><p>Kept</p></body>`;
    expect(withoutRawTextContent(html)).toBe(
      `<head><style></style><script src="x.js"></script><script></script></head>`
      + `<body><noscript></noscript><template id="t"></template><p>Kept</p></body>`,
    );
  });

  it("ends each element only at its own closing tag, case-insensitively", () => {
    expect(withoutRawTextContent(`<SCRIPT>if (a) "</style><img>";</Script ><img alt="real">`)).toBe(`<SCRIPT></Script ><img alt="real">`);
  });

  it("runs an unclosed element to the end of the document, as a browser does", () => {
    expect(withoutRawTextContent(`<p>a</p><style>.x{} /style> <body><img alt=""></body>`)).toBe(`<p>a</p><style>`);
  });

  it("leaves similar tag names and plain markup alone", () => {
    const html = `<scripts>a</scripts><script-x>b</script-x><styled>c</styled><p>stylesheet</p>`;
    expect(withoutRawTextContent(html)).toBe(html);
  });

  it("removes the header and sections that the 8e03985c typo swallowed", () => {
    const broken = withoutRawTextContent(fixture("render-broken-blank"));
    expect(broken).not.toContain("header-logo-link");
    expect(broken).not.toContain("<section");
    const healthy = withoutRawTextContent(fixture("render-healthy"));
    expect(healthy).toContain("header-logo-link");
    expect((healthy.match(/<section/g) ?? []).length).toBe(6);
  });
});

describe("checks ignore markup inside raw-text elements (P2-012)", () => {
  function runner(): { runner: PromptRunner; spy: ReturnType<typeof vi.fn> } {
    const r = new PromptRunner("test-key", { max_retries: 0 });
    // One passing verdict per input
    const spy = vi.fn().mockImplementation(async (inputs: unknown[]) => inputs.map(() => ({
      success: true, data: { verdict: "pass", confidence: 0.9, reasoning: "ok", failure_type: null, suggestion: null, affected_users: [], requires_human_verification: false, results: [] },
      rawResponse: "{}", model: "m", tokensUsed: 1, latencyMs: 1, retries: 0,
    })));
    r.runPrompts = spy;
    return { runner: r, spy };
  }
  const sentTo = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.flatMap((c) => c[0] as Array<{ userMessage: string }>).map((i) => i.userMessage).join("\n");

  it("alt text: a swallowed logo link is not evaluated; a rendered logo link with no name still is", async () => {
    const logo = `<a href="/" class="header-logo-link w-nav-brand"><img alt="" src="logo.png"></a>`;
    const broken = runner();
    await runAltTextChecks(`<head><style>.a{} /style></head><body>${logo}</body>`, broken.runner);
    expect(broken.spy).not.toHaveBeenCalled();
    await runAltTextChecks(fixture("render-broken-blank"), broken.runner);
    expect(sentTo(broken.spy)).not.toContain("header-logo-link");

    const healthy = runner();
    await runAltTextChecks(`<head><style>.a{}</style></head><body>${logo}</body>`, healthy.runner);
    expect(sentTo(healthy.spy)).toContain("logo.png");
  });

  it("alt text: CSS and script text no longer reach the image's surrounding context", async () => {
    const { runner: r, spy } = runner();
    await runAltTextChecks(`<body><style>.hero a { color: #286140; }</style><script>track("hero")</script><img src="team.jpg" alt="IMG_2041.jpg"></body>`, r);
    const sent = sentTo(spy);
    expect(sent).toContain("IMG_2041.jpg");
    expect(sent).not.toContain("#286140");
    expect(sent).not.toContain("track(");
  });

  it("link text: links quoted in script text are not evaluated", async () => {
    const { runner: r, spy } = runner();
    await runLinkTextChecks(`<body><script>const t = '<a href="/x">click here</a>';</script><a href="/about">Read more</a></body>`, r);
    const sent = sentTo(spy);
    expect(sent).not.toContain("click here");
    expect(sent).toContain("Read more");
  });

  it("headings: a heading inside a template is not part of the outline", async () => {
    const { runner: r, spy } = runner();
    await runHeadingChecks(`<body><h1>Title</h1><template><h4>Card</h4></template><h2>Section</h2></body>`, "Title", r);
    expect(sentTo(spy)).not.toContain("Card");
  });

  it("structural checks find nothing inside style text", () => {
    const swallowed = `<head><style>.a{} /style><body><nav><a href="/">Home</a></nav><nav><a href="/x">X</a></nav>`
      + `<table><tr><td>1</td></tr></table><a href="/a">Same</a><a href="/b">Same</a><form><input name="email"></form>`
      + `<img src="spinner.gif"><video autoplay src="v.mp4"></video><div class="swiper"></div></style></head><body><p>Only this renders</p></body>`;
    expect(runLandmarkLabelChecks(swallowed)).toEqual([]);
    expect(runTableStructureChecks(swallowed)).toEqual([]);
    expect(runDuplicateLinkChecks(swallowed, "https://x.test/")).toEqual([]);
    expect(discoverForms(snapshot(swallowed))).toEqual([]);
    expect(checkThreeFlashes(snapshot(swallowed))).toEqual([]);
    expect(checkPauseStopHide(snapshot(swallowed)).filter((r) => r.measured_values?.animation_type === "carousel")).toEqual([]);
    // The same markup rendered is still found
    const rendered = swallowed.replace(" /style>", "</style>").replace("</style></head>", "</head>");
    expect(runLandmarkLabelChecks(rendered).length).toBeGreaterThan(0);
    expect(discoverForms(snapshot(rendered))).toHaveLength(1);
  });

  it("multiple ways: a search box quoted in a script is not a navigation method", () => {
    const dom = `<body><nav><a href="/">Home</a></nav><script>var tpl = '<input type="search" name="q">';</script></body>`;
    expect(checkMultipleWays(snapshot(dom))).toHaveLength(1);
  });

  it("CSS and script text that checks read by design is still read", () => {
    const dom = `<head><style>@keyframes spin{} .spinner{animation: spin 1s infinite} @media (prefers-reduced-motion: reduce){.spinner{animation:none}}</style></head><body><div class="spinner"></div></body>`;
    expect(checkPauseStopHide(snapshot(dom)).some((r) => r.measured_values?.animation_type === "css_animation")).toBe(true);
    expect(findPauseMechanisms(dom).map((m) => m.selector)).toContain("@media");
  });
});
