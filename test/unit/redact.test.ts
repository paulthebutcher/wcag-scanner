import { describe, it, expect } from "vitest";
import { redactVolatile, hasVolatile, PLACEHOLDERS } from "../../src/core/redact.js";
import { buildHighRiskFormUserPrompt, buildInputPurposeUserPrompt, buildErrorMessageUserPrompt } from "../../src/prompts/form-interaction.js";
import { buildLinkTextUserPrompt, buildAltTextUserPrompt } from "../../src/prompts/element-evaluation.js";
import { cacheKey } from "../../src/core/prompt-runner.js";
import { highRiskFormDetection } from "../../src/prompts/form-interaction.js";

const formWith = (visitor: string, stamp: string) => `<form id="wf-form-Start" name="wf-form-Start" method="post" class="w-form">
  <input type="hidden" name="visitor_id" value="${visitor}">
  <input type="hidden" name="landing_timestamp" value="${stamp}">
  <input type="hidden" name="source" value="organic">
  <label for="email">Work email</label><input id="email" name="email" type="email" value="pat@example.test" required>
  <input type="text" name="company" placeholder="Company" value="Acme">
  <a href="/terms?utm_source=form&utm_campaign=start&ref=footer">Terms</a>
  <button type="submit">Start</button>
</form>`;

describe("volatile values are redacted from prompt inputs (P2-021, P2-020)", () => {
  it("replaces hidden-input values, UUIDs, timestamps, tracking parameters and GrowSurf's class, and keeps names, types and visible values", () => {
    const out = redactVolatile(formWith("v_7c777cba-1a2b-4c3d-8e9f-0a1b2c3d4e5f", "2026-10-16T18:55:03.123Z") + ` <div class="grsf-unique-3goiz grsf-global" data-t="1729105200"></div>`);
    expect(out).toContain(`<input type="hidden" name="visitor_id" value="${PLACEHOLDERS.hidden}">`);
    expect(out).toContain(`<input type="hidden" name="landing_timestamp" value="${PLACEHOLDERS.hidden}">`);
    expect(out).toContain(`<input type="hidden" name="source" value="${PLACEHOLDERS.hidden}">`);
    expect(out).toContain(`type="email" value="pat@example.test" required`); // visible field value stays
    expect(out).toContain(`placeholder="Company" value="Acme"`);
    expect(out).toContain(`href="/terms?utm_source=${PLACEHOLDERS.tracking}&utm_campaign=${PLACEHOLDERS.tracking}&ref=footer"`);
    expect(out).toContain(`class="grsf-unique-${PLACEHOLDERS.vendorId} grsf-global" data-t="${PLACEHOLDERS.timestamp}"`);
    expect(out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(out).not.toContain("2026-10-16T18:55");
    expect(redactVolatile(`id "${"c1b7d6e2-9c2a-4d1a-9f3e-5a6b7c8d9e0f"}" at 2026-10-16 18:55:03 and 1729105200000`)).toBe(`id "${PLACEHOLDERS.uuid}" at ${PLACEHOLDERS.timestamp} and 1729105200000`); // a bare number in text is left alone
    expect(hasVolatile("plain text with a date 2026-10-16")).toBe(false);
    expect(redactVolatile("")).toBe("");
  });

  it("two loads of the same form differing only in per-load values give the same prompt and the same cache key", () => {
    const a = formWith("v_7c777cba-1a2b-4c3d-8e9f-0a1b2c3d4e5f", "2026-10-16T18:55:03.123Z");
    const b = formWith("v_02fdc311-9b8a-4765-8c1d-2e3f4a5b6c7d", "2026-10-16T19:02:41.004Z");
    const prompt = (html: string) => buildHighRiskFormUserPrompt({ formHtml: html, fieldLabels: ["Work email", "Company"], submitButtonText: "Start", hasConfirmation: false, hasReviewStep: false });
    expect(prompt(a)).toBe(prompt(b));
    expect(prompt(a)).not.toContain("7c777cba");
    expect(cacheKey({ template: highRiskFormDetection, userMessage: prompt(a) })).toBe(cacheKey({ template: highRiskFormDetection, userMessage: prompt(b) }));
    expect(buildErrorMessageUserPrompt({ formHtml: a, errorMessages: [], totalFields: 2 })).toBe(buildErrorMessageUserPrompt({ formHtml: b, errorMessages: [], totalFields: 2 }));
    expect(buildInputPurposeUserPrompt({ elementHtml: `<input type="hidden" name="visitor_id" value="abc-123">`, labelText: "", autocompleteValue: null, inputType: "hidden" })).toContain(PLACEHOLDERS.hidden);
  });

  it("semantic prompts drop tracking parameters and the vendor class but keep the link's text and href path", () => {
    const link = buildLinkTextUserPrompt({ elementHtml: `<a href="https://x.test/pricing?utm_source=footer&gclid=XyZ123">See pricing</a>`, linkText: "See pricing", surroundingContext: `plans grsf-unique-abc12 compare` });
    expect(link).toContain(`href="https://x.test/pricing?utm_source=${PLACEHOLDERS.tracking}&gclid=${PLACEHOLDERS.tracking}"`);
    expect(link).toContain("See pricing");
    expect(link).toContain(`grsf-unique-${PLACEHOLDERS.vendorId}`);
    const alt = buildAltTextUserPrompt({ elementHtml: `<img src="/a.png?v=1729105200000" alt="Team">`, altText: "Team", surroundingContext: "Our team at 2026-10-16T09:00:00Z", pageTitle: "About", isDecorativeCandidate: false } as never);
    expect(alt).toContain(PLACEHOLDERS.timestamp);
    expect(alt).toContain('alt="Team"');
  });
});
