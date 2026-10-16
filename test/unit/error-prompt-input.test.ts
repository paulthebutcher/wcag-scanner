import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { composeErrorPromptMarkup } from "../../src/checks/forms/error-evaluation.js";
import { captureFormMarkup, FORM_MARKUP_CAPS, type FormMarkup } from "../../src/checks/forms/submission.js";
import { buildErrorMessageUserPrompt } from "../../src/prompts/form-interaction.js";
import type { FormInfo } from "../../src/checks/forms/discovery.js";

const formInfo = { selector: "#f", html: "<form id=\"f\"><input name=\"email\" required></form>", fields: [{ selector: "#e", html: "", tagName: "input", type: "email", name: "email", label: "Email", required: true }] } as unknown as FormInfo;
const page = (htmlClasses: string) => `<!DOCTYPE html><html lang="en" class="${htmlClasses}"><head><meta charset="utf-8"><title>Contact</title><style>.x{color:red}</style><script>window.__v = Math.random()</script></head><body>
<header><nav><a href="/">Home</a></nav></header>
<main><section class="contact"><h1>Contact</h1><p class="intro">Write to us.</p>
<form id="f" method="post" action="/send"><label for="e">Email</label><input id="e" name="email" type="email" required aria-invalid="true" aria-describedby="e-err"><div id="e-err" role="alert">Enter a valid email</div><button type="submit">Send</button></form>
<p class="after">We reply within a day.</p></section></main>
<footer><a href="/privacy">Privacy</a></footer></body></html>`;

describe("error-message prompt input is the form, its error regions and a bounded context (P2-001, P2-022)", () => {
  it("composes the three parts under their caps with a header that records what was sent, and never the page head", () => {
    const markup: FormMarkup = {
      form: `<form id="f">${"<input>".repeat(2000)}</form>`, // 14,009 chars: over the cap
      errorRegions: ["<div role=\"alert\">Enter a valid email</div>", "<p class=\"err\">" + "x".repeat(2100) + "</p>"],
      context: "<section>" + "a".repeat(2000) + "<!-- the form, shown above -->" + "b".repeat(2000) + "</section>",
    };
    const out = composeErrorPromptMarkup({ formMarkup: markup, formInfo, domAfter: page("wf-a-active") });
    const header = out.split("\n")[0];
    expect(header).toBe(`[sent: form ${FORM_MARKUP_CAPS.form + 3} chars (truncated), 1 of 2 error region(s) 43 chars (truncated), context ${FORM_MARKUP_CAPS.contextEachSide * 2 + 30 + 2} chars (bounded)]`);
    expect(out).toContain("Form (after submission):\n<form id=\"f\">");
    expect(out).toContain("Error regions (role=alert, aria-live, aria-invalid fields and detected messages):\n<div role=\"alert\">Enter a valid email</div>");
    expect(out).toContain("…" + "a".repeat(1500) + "<!-- the form, shown above -->" + "b".repeat(1500) + "…");
    expect(out).not.toContain("<head");
    expect(out).not.toContain("wf-a-active");
    expect(out.length).toBeLessThan(FORM_MARKUP_CAPS.form + FORM_MARKUP_CAPS.errorRegions + FORM_MARKUP_CAPS.contextEachSide * 2 + 600);
  });

  it("falls back to the form's discovery-time markup when a state carries no capture, never to the page head", () => {
    const out = composeErrorPromptMarkup({ formInfo, domAfter: page("wf-a-active wf-b-active") });
    expect(out.split("\n")[0]).toMatch(/^\[sent: form \d+ chars \(discovery-time markup; no post-submission capture\), 0 error regions, no context\]$/);
    expect(out).toContain(formInfo.html);
    expect(out).not.toContain("<head");
    expect(buildErrorMessageUserPrompt({ formHtml: out, errorMessages: [], totalFields: 1 })).toContain("the header line records what was sent");
  });

  describe("captured in the page after a submission attempt", () => {
    let browser: Browser; let server: http.Server; let origin = "";
    beforeAll(async () => {
      browser = await chromium.launch({ headless: true });
      server = http.createServer((req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(page(req.url === "/b" ? "wf-barlow-n7-active wf-hostgrotesk-n4-active" : "wf-hostgrotesk-n4-active wf-barlow-n7-active")); });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => { await browser.close(); await new Promise<void>((r) => server.close(() => r())); });

    it("captures the form, its error regions and the parent context, identical across loads whose html classes differ (P2-022)", async () => {
      const context = await browser.newContext();
      const p = await context.newPage();
      try {
        const prompts: string[] = [];
        for (const path of ["/a", "/b"]) {
          await p.goto(`${origin}${path}`, { waitUntil: "load" });
          const markup = (await captureFormMarkup(p, "#f", ["#e-err"]))!;
          expect(markup.form.startsWith("<form id=\"f\"")).toBe(true);
          expect(markup.errorRegions).toEqual([
            "<div id=\"e-err\" role=\"alert\">Enter a valid email</div>",
            "<input id=\"e\" name=\"email\" type=\"email\" required=\"\" aria-invalid=\"true\" aria-describedby=\"e-err\">",
          ]);
          expect(markup.context).toMatch(/<p class="intro">Write to us\.<\/p>\s*<!-- the form, shown above -->\s*<p class="after">/);
          expect(markup.context).not.toContain("<form");
          prompts.push(composeErrorPromptMarkup({ formMarkup: markup, formInfo, domAfter: await p.content() }));
        }
        expect(prompts[0]).toBe(prompts[1]);
        expect(await captureFormMarkup(p, "#missing", [])).toBeNull();
      } finally {
        await context.close();
      }
    }, 30_000);
  });
});
