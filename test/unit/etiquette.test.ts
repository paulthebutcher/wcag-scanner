import { describe, it, expect } from "vitest";
import { contactUrlFromEnv, productUserAgent, productionEtiquette, ENGINE_VERSION, DEFAULT_MIN_DELAY_MS, pacedGoto, setActivePacer, getActivePacer } from "../../src/core/etiquette.js";
import { Pacer } from "../../src/core/pacer.js";
import { decideRobots, parseRobots, isAllowed, PRODUCT_TOKEN } from "../../src/core/robots.js";
import { classifyRequest } from "../../src/core/containment.js";

const CONTACT = "https://example.test/scanner";

describe("production etiquette (P2-007)", () => {
  it("builds the identifying user agent from the package version and the contact URL", () => {
    expect(productUserAgent(CONTACT)).toBe(`WCAGEngine/${ENGINE_VERSION} (+${CONTACT})`);
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(() => productUserAgent("not a url")).toThrow(/http\(s\) URL/);
  });

  it("reads WCAG_CONTACT_URL first, then EVAL_CONTACT_URL, and ignores non-URLs", () => {
    expect(contactUrlFromEnv({ WCAG_CONTACT_URL: CONTACT, EVAL_CONTACT_URL: "https://other.test/" })).toBe(CONTACT);
    expect(contactUrlFromEnv({ EVAL_CONTACT_URL: "https://other.test/" })).toBe("https://other.test/");
    expect(contactUrlFromEnv({ WCAG_CONTACT_URL: "mailto:x@y" })).toBeNull();
    expect(contactUrlFromEnv({})).toBeNull();
  });

  it("refuses to build etiquette without a contact URL, and paces 3 s by default", () => {
    expect(() => productionEtiquette({ env: {} })).toThrow(/WCAG_CONTACT_URL/);
    const e = productionEtiquette({ env: { WCAG_CONTACT_URL: CONTACT } });
    expect(e.userAgent).toContain(CONTACT);
    expect(DEFAULT_MIN_DELAY_MS).toBe(3000);
    expect(e.pacer.intervalFor("example.test")).toBe(3000);
    expect(productionEtiquette({ env: { WCAG_CONTACT_URL: CONTACT }, minDelayMs: 500 }).pacer.intervalFor("x")).toBe(500);
    expect(() => productionEtiquette({ env: { WCAG_CONTACT_URL: CONTACT }, minDelayMs: -1 })).toThrow(/min-delay-ms/);
  });

  it("the pacer keeps consecutive loads of one host at least the interval apart and lets a larger crawl-delay win", async () => {
    let now = 0;
    const slept: number[] = [];
    const pacer = new Pacer(3000, () => now, async (ms) => { slept.push(ms); now += ms; });
    await pacer.beforeTopLevel("https://a.test/1");
    now += 1000;
    await pacer.beforeTopLevel("https://a.test/2");
    expect(slept).toEqual([2000]);
    await pacer.beforeTopLevel("https://b.test/1"); // another host: no wait
    expect(slept).toEqual([2000]);
    pacer.setCrawlDelay("a.test", 10);
    expect(pacer.intervalFor("a.test")).toBe(10_000);
    await pacer.beforeTopLevel("https://a.test/3");
    expect(slept).toEqual([2000, 10_000]);
    expect(pacer.log.map((r) => r.waited_ms)).toEqual([0, 2000, 0, 10_000]);
  });

  it("pacedGoto waits on the active pacer only when one is installed", async () => {
    const calls: string[] = [];
    const page = { goto: async (url: string) => { calls.push(url); return null; }, url: () => "https://a.test/" } as unknown as import("playwright").Page;
    expect(getActivePacer()).toBeNull();
    await pacedGoto(page, "https://a.test/x");
    let waited = 0;
    const pacer = new Pacer(100, () => 0, async () => { waited++; });
    setActivePacer(pacer);
    try {
      await pacedGoto(page, "https://a.test/y");
      await pacedGoto(page, "https://a.test/z");
    } finally {
      setActivePacer(null);
    }
    expect(calls).toEqual(["https://a.test/x", "https://a.test/y", "https://a.test/z"]);
    expect(waited).toBe(1);
    expect(pacer.log).toHaveLength(2);
  });
});

describe("robots.txt for production scans", () => {
  it("applies the engine's product group, falls back to the wildcard group, and refuses on errors", () => {
    const body = "User-agent: *\nDisallow: /private\nCrawl-delay: 2\n\nUser-agent: WCAGEngine\nDisallow: /staff/\nCrawl-delay: 5\n";
    const policy = parseRobots(body);
    expect(PRODUCT_TOKEN).toBe("wcagengine");
    expect(policy.group).toBe("product");
    expect(policy.crawlDelaySeconds).toBe(5);
    expect(isAllowed(policy, "https://x.test/staff/list")).toBe(false);
    expect(isAllowed(policy, "https://x.test/private")).toBe(true);
    const wildcard = parseRobots("User-agent: *\nDisallow: /private\n");
    expect(wildcard.group).toBe("wildcard");
    expect(isAllowed(wildcard, "https://x.test/private/x")).toBe(false);
    expect(decideRobots({ kind: "http-error", status: 404 }).usable).toBe(true);
    expect(decideRobots({ kind: "http-error", status: 503 })).toEqual({ usable: false, reason: "robots.txt returned HTTP 503" });
    expect(decideRobots({ kind: "network-error", error: "ECONNREFUSED" }).usable).toBe(false);
  });
});

describe("submission containment classification (P2-006)", () => {
  it("contains a GET navigation during a submission and every unsafe-method request", () => {
    expect(classifyRequest({ method: "GET", isNavigation: true, url: "https://x.test/?q=1" }, true)).toBe("contain-navigation");
    expect(classifyRequest({ method: "GET", isNavigation: true, url: "https://x.test/" }, false)).toBe("pass");
    expect(classifyRequest({ method: "GET", isNavigation: false, url: "https://x.test/a.css" }, true)).toBe("pass");
    expect(classifyRequest({ method: "POST", isNavigation: true, url: "https://x.test/submit" }, false)).toBe("contain-navigation");
    expect(classifyRequest({ method: "POST", isNavigation: false, url: "https://x.test/api" }, false)).toBe("contain-abort");
  });
});
