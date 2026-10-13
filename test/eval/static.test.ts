import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import axe from "axe-core";
import { AXE_STATIC_WHITELIST, STATIC_PLAN, sanitizeFixture, staticRunsMatch, type StaticRunResult } from "../../src/eval/static.js";
import { runAxeChecks } from "../../src/checks/automated/index.js";
import { readJsonl } from "../../src/eval/util.js";

const REPO = join(import.meta.dirname, "..", "..");

describe("static plan", () => {
  it("covers all 18 seeds with unique case ids", () => {
    const seeds = readJsonl<{ id: string }>(join(REPO, "eval", "seed-labels.jsonl")).map((s) => s.id);
    const covered = new Set(STATIC_PLAN.flatMap((p) => p.seeds));
    expect(seeds.filter((s) => !covered.has(s))).toEqual([]);
    const ids = STATIC_PLAN.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of STATIC_PLAN) {
      if (p.status === "runnable") expect(p.target.kind).not.toBe("none");
      if (p.adjudication === "disputed") expect(p.note.length).toBeGreaterThan(10);
    }
  });

  it("the committed expectations carry no hostnames, URLs or markup", () => {
    const text = readFileSync(join(REPO, "eval", "lakewood-static.json"), "utf8");
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/<\s*[a-z]+[\s>]/i);
    expect(text.toLowerCase()).not.toContain("lakewoodcourtoh");
  });
});

describe("fixture sanitising", () => {
  it("removes scripts, inline handlers, base, preloads and iframe sources", () => {
    const out = sanitizeFixture(`<base href="https://x.test/"><link rel="preload" href="/a.js"><script>alert(1)</script><a href="/" onclick="go()">x</a><iframe title="t" src="https://y.test/"></iframe>`);
    expect(out).not.toMatch(/<script|onclick|<base|preload|src=/i);
    expect(out).toContain('<iframe title="t"');
  });
});

describe("axe static whitelist", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser.close(); });

  const BODY = `<html lang="en"><head><title>t</title></head><body>
    <img src="a.png" class="hero"><a href="/x" class="lnk"><img src="b.png"></a><button class="btn"></button>
    <input type="text" class="field"><select class="sel"><option>1</option></select>
    <div role="buton" class="badrole">x</div><div aria-hidden="maybe" class="badval">y</div>
    <ul class="list"><div>not li</div></ul><input autocomplete="nonsense" name="n" aria-label="n">
    <iframe class="frame"></iframe><p class="txt" style="color:#999;background:#aaa">low contrast</p></body></html>`;
  const CSS = `<style>body{font:18px Georgia;background:#111;color:#eee}.hero{width:300px;float:right}.lnk{position:relative;left:40px}
    .btn{padding:20px;transform:rotate(3deg)}.list{display:flex}.field{border:3px solid red}.txt{color:#000 !important;background:#fff !important}</style>`;

  async function run(html: string, rules: string[]) {
    const ctx = await browser.newContext();
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((fn) => fn);" });
    const page = await ctx.newPage();
    await page.setContent(html);
    const all = axe.getRules().map((r) => r.ruleId);
    const out = await runAxeChecks(page, "t", { disableRules: all.filter((r) => !rules.includes(r)) });
    await ctx.close();
    return out.violations.map((v) => `${(v.raw_result as { ruleId: string }).ruleId}|${v.element_selector}`).sort();
  }

  it("whitelisted rules give the same verdicts on visible elements with and without stylesheets", async () => {
    const without = await run(BODY, AXE_STATIC_WHITELIST);
    const withCss = await run(BODY.replace("</head>", `${CSS}</head>`), AXE_STATIC_WHITELIST);
    expect(without.length).toBeGreaterThan(5);
    expect(withCss).toEqual(without);
  }, 60_000);

  it("a layout-dependent rule (color-contrast) is not whitelisted because CSS changes it", async () => {
    expect(AXE_STATIC_WHITELIST).not.toContain("color-contrast");
    const without = await run(BODY, ["color-contrast"]);
    const withCss = await run(BODY.replace("</head>", `${CSS}</head>`), ["color-contrast"]);
    expect(withCss).not.toEqual(without);
  }, 60_000);
});

describe("static replays", () => {
  it("detect any difference between two runs", () => {
    const outcome = { case_id: "LS-001", engine: "head", outcome: "pass" as const, reason: "", confirmed_detected: true, inclusive_detected: true, severity_ok: null, matched: [] };
    const a = { outcomes: [outcome], predictions: { f: [] } } as unknown as StaticRunResult;
    const b = { outcomes: [{ ...outcome, outcome: "fail" as const }], predictions: { f: [] } } as unknown as StaticRunResult;
    expect(staticRunsMatch(a, a).identical).toBe(true);
    expect(staticRunsMatch(a, b).differences).toEqual(["LS-001"]);
  });
});
