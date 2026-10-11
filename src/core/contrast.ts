// ---------------------------------------------------------------------------
// WCAG contrast helpers and same-hue replacement colours
//
// Used to turn an axe color-contrast result ("foreground color: #286140,
// background color: #17191e, ... Expected contrast ratio of 4.5:1") into a
// concrete fix: the same hue, lightened or darkened until it passes.
// ---------------------------------------------------------------------------

export interface Rgb { r: number; g: number; b: number }

export function parseHex(hex: string): Rgb | null {
  let h = hex.trim().replace(/^#/, "").toLowerCase();
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split("").map((c) => c + c).join("");
  if (h.length === 8) h = h.slice(0, 6); // ignore alpha
  if (!/^[0-9a-f]{6}$/.test(h)) return null;
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

export function toHex({ r, g, b }: Rgb): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** WCAG 2.x relative luminance. */
export function luminance({ r, g, b }: Rgb): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

interface Hsl { h: number; s: number; l: number }

function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h / 6, s, l };
}

function hslToRgb({ h, s, l }: Hsl): Rgb {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return { r: hue(p, q, h + 1 / 3) * 255, g: hue(p, q, h) * 255, b: hue(p, q, h - 1 / 3) * 255 };
}

/**
 * The closest colour with the same hue and saturation as `foreground` that
 * reaches `target` contrast against every background. Lightness moves away
 * from the backgrounds (lighter on dark backgrounds, darker on light ones)
 * in 0.5% steps; the other direction is tried if the first cannot reach the
 * target. Returns null if no lightness works.
 */
export function passingReplacement(foreground: string, backgrounds: string[], target: number): string | null {
  const fg = parseHex(foreground);
  const bgs = backgrounds.map(parseHex).filter((b): b is Rgb => b !== null);
  if (!fg || bgs.length === 0) return null;

  const passes = (c: Rgb) => bgs.every((bg) => contrastRatio(c, bg) >= target);
  if (passes(fg)) return toHex(fg);

  const hsl = rgbToHsl(fg);
  const avgBgLum = bgs.reduce((sum, b) => sum + luminance(b), 0) / bgs.length;
  const firstDirection = avgBgLum < 0.18 ? 1 : -1;

  for (const direction of [firstDirection, -firstDirection]) {
    for (let step = 1; step <= 200; step++) {
      const l = hsl.l + direction * step * 0.005;
      if (l < 0 || l > 1) break;
      // Round to the hex that would be published, then re-check it
      const candidate = parseHex(toHex(hslToRgb({ ...hsl, l })))!;
      if (passes(candidate)) return toHex(candidate);
    }
  }
  return null;
}

/** Colours and thresholds parsed from an axe color-contrast message. */
export interface ContrastMeasurement {
  foreground: string;
  background: string;
  /** Contrast ratio axe measured */
  ratio: number | null;
  /** Ratio axe expects: 4.5 for normal text, 3 for large text */
  expected: number;
  fontSizePx: number | null;
  fontWeight: string | null;
}

/**
 * Parse axe's color-contrast failure summary. Returns null when axe could
 * not measure the colours (background image, gradient, overlap).
 */
export function parseContrastMeasurement(text: string): ContrastMeasurement | null {
  const colors = text.match(/foreground color:\s*(#[0-9a-fA-F]{3,8}),\s*background color:\s*(#[0-9a-fA-F]{3,8})/);
  if (!colors) return null;
  const ratio = text.match(/contrast of\s*([\d.]+)/);
  const expected = text.match(/Expected contrast ratio of\s*([\d.]+)\s*:\s*1/);
  const size = text.match(/font size:\s*[\d.]+pt\s*\(([\d.]+)px\)/);
  const weight = text.match(/font weight:\s*([a-z0-9]+)/i);
  const fontSizePx = size ? Number(size[1]) : null;
  const fontWeight = weight ? weight[1].toLowerCase() : null;
  return {
    foreground: colors[1].toLowerCase(),
    background: colors[2].toLowerCase(),
    ratio: ratio ? Number(ratio[1]) : null,
    expected: expected ? Number(expected[1]) : requiredRatio(fontSizePx, fontWeight),
    fontSizePx,
    fontWeight,
  };
}

/** WCAG 1.4.3: 3:1 for large text (≥24px, or ≥18.66px bold), else 4.5:1. */
export function requiredRatio(fontSizePx: number | null, fontWeight: string | null): number {
  if (fontSizePx === null) return 4.5;
  const bold = fontWeight === "bold" || fontWeight === "bolder" || Number(fontWeight) >= 700;
  return fontSizePx >= 24 || (bold && fontSizePx >= 18.66) ? 3 : 4.5;
}
