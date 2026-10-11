import { describe, it, expect } from "vitest";
import {
  parseHex,
  contrastRatio,
  passingReplacement,
  parseContrastMeasurement,
  requiredRatio,
} from "../../src/core/contrast.js";
import { buildSpecificRemediation, WebflowAdapter } from "../../src/adapters/webflow.js";
import { makeTestFinding, contrastReasoning } from "./finding-factory.js";

const ratio = (a: string, b: string) => contrastRatio(parseHex(a)!, parseHex(b)!);

function hue(hex: string): number {
  const { r, g, b } = parseHex(hex)!;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h / 6) * 360;
}

describe("contrast replacement", () => {
  it("parses axe's measurement, including the expected ratio", () => {
    expect(parseContrastMeasurement(contrastReasoning("#286140", "#17191e"))).toEqual({
      foreground: "#286140", background: "#17191e", ratio: 2.4, expected: 4.5, fontSizePx: 14, fontWeight: "normal",
    });
    expect(parseContrastMeasurement("Element's background color could not be determined due to a background gradient")).toBeNull();
  });

  it("lightens #286140 on #17191e to a same-hue colour that reaches 4.5:1", () => {
    const fix = passingReplacement("#286140", ["#17191e"], 4.5)!;
    expect(ratio(fix, "#17191e")).toBeGreaterThanOrEqual(4.5);
    expect(Math.abs(hue(fix) - hue("#286140"))).toBeLessThan(4);
    expect(parseHex(fix)!.g).toBeGreaterThan(0x61);
  });

  it("passes against every background it is used on", () => {
    const fix = passingReplacement("#286140", ["#17191e", "#1e252b"], 4.5)!;
    expect(ratio(fix, "#17191e")).toBeGreaterThanOrEqual(4.5);
    expect(ratio(fix, "#1e252b")).toBeGreaterThanOrEqual(4.5);
  });

  it("darkens on light backgrounds and uses 3:1 for large text", () => {
    const fix = passingReplacement("#999999", ["#ffffff"], 3)!;
    expect(ratio(fix, "#ffffff")).toBeGreaterThanOrEqual(3);
    expect(ratio(fix, "#ffffff")).toBeLessThan(4.5);
    expect(requiredRatio(24, "normal")).toBe(3);
    expect(requiredRatio(18.67, "700")).toBe(3);
    expect(requiredRatio(18.67, "normal")).toBe(4.5);
    expect(requiredRatio(14, "bold")).toBe(4.5);
  });

  it("returns the colour unchanged when it already passes", () => {
    expect(passingReplacement("#ffffff", ["#000000"], 4.5)).toBe("#ffffff");
  });
});

describe("Webflow finding-specific remediation", () => {
  it("color-contrast names the measured colours and a passing replacement", () => {
    const f = makeTestFinding({ criterion: "1.4.3", failureType: "color-contrast", html: '<a class="tos-footer-link">Privacy</a>', reasoning: contrastReasoning("#286140", "#17191e") });
    const r = buildSpecificRemediation(f)!;
    const replacement = passingReplacement("#286140", ["#17191e"], 4.5)!;
    expect(r.generic_fix).toContain("#286140");
    expect(r.generic_fix).toContain("#17191e");
    expect(r.generic_fix).toContain(replacement);
    expect(r.steps.join(" ")).toContain(".tos-footer-link");
  });

  it("custom_interactive_no_role adds role and tabindex via custom attributes and covers Enter/Space", () => {
    const r = buildSpecificRemediation(makeTestFinding({ failureType: "custom_interactive_no_role", html: '<div data-w-id="ff1f" class="btn modal full">' }))!;
    const text = [r.generic_fix, ...r.steps].join(" ");
    expect(text).toContain('role="button"');
    expect(text).toMatch(/Custom attributes.*role.*button/);
    expect(text).toMatch(/tabindex.*0/);
    expect(text).toContain("Enter and Space");
    expect(r.steps.join(" ")).toContain(".btn.modal.full");
    expect(r.code_fix).toContain("keydown");
  });

  it("no_visible_focus_indicator points at the class's Focused (Keyboard) state", () => {
    const r = buildSpecificRemediation(makeTestFinding({ criterion: "2.4.7", failureType: "no_visible_focus_indicator", html: '<a class="footer-link-l2">Centralize</a>' }))!;
    expect(r.steps.join(" ")).toContain("Focused (Keyboard)");
    expect(r.code_fix).toContain(".footer-link-l2:focus-visible");
  });

  it("aria-prohibited-attr replaces the generic text", () => {
    const f = makeTestFinding({ failureType: "aria-prohibited-attr", html: '<div aria-label="Next" class="swiper-button-next">', reasoning: "Fix all of the following:\n  aria-label attribute cannot be used on a div with no valid role attribute." });
    const r = buildSpecificRemediation(f)!;
    expect(r.generic_fix).toContain("aria-label");
    expect(r.generic_fix).toContain('role="button"');
    const steps = new WebflowAdapter().getRemediationSteps(f).steps.join(" ");
    expect(steps).not.toContain("Review the element and fix");
  });

  it("leaves other failure types to the existing templates", () => {
    expect(buildSpecificRemediation(makeTestFinding({ failureType: "image-alt" }))).toBeNull();
  });
});
