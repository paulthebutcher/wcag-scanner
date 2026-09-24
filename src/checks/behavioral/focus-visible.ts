import sharp from "sharp";
import type { Page } from "playwright";
import type { CheckResult } from "../../types.js";
import type { FocusStop, TabSequenceResult } from "./keyboard.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FocusVisibilityResult {
  /** Element selector */
  selector: string;
  /** Whether any visual change was detected on focus */
  hasVisualChange: boolean;
  /** Measured contrast ratio of focus indicator (null if no change detected).
   *  This is the legacy average-pixel contrast; prefer perimeterContrast for pass/fail. */
  contrastRatio: number | null;
  /** Whether the contrast meets the 3:1 minimum (composite algorithm) */
  meetsMinimum: boolean;
  /** Screenshot of element without focus */
  unfocusedScreenshot: Buffer;
  /** Screenshot of element with focus */
  focusedScreenshot: Buffer;
  /** Percentage of pixels that changed */
  pixelDiffPercent: number;
  /** Outer HTML */
  outerHtml: string;
  /** Composite focus metrics from the new algorithm */
  focusMetrics: {
    /** Highest contrast found at changed/unchanged pixel boundary (the "ring edge") */
    perimeterContrast: number;
    /** 90th-percentile of ring-edge contrasts (robust to anti-aliasing outliers) */
    p90PerimeterContrast: number;
    /** Estimated thickness of changed band in pixels (total_changed / perimeter_count) */
    estimatedThicknessPx: number;
    /** Whether the element interior changed colour — indicates fill-based focus state */
    hasFillChange: boolean;
  };
}

export interface FocusVisibilityCheckOptions {
  /** Minimum contrast ratio for focus indicators. Default: 3.0 (WCAG 2.4.7) */
  minContrast?: number;
  /** Minimum pixel difference percentage to count as visual change. Default: 0.5 */
  minDiffPercent?: number;
}

// ---------------------------------------------------------------------------
// Contrast computation helpers
// ---------------------------------------------------------------------------

/** Compute relative luminance per WCAG 2.0 formula */
function relativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/** Compute contrast ratio between two luminance values */
function contrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ---------------------------------------------------------------------------
// Screenshot comparison
// ---------------------------------------------------------------------------

/**
 * Compare two screenshots pixel-by-pixel.
 *
 * Returns both the legacy average-pixel metrics and a richer set of composite
 * metrics that are robust to multi-ring, boxed, and fill-based focus states:
 *
 *  perimeterContrast    — max contrast at the boundary between changed and
 *                         unchanged pixels, i.e. the "ring edge" contrast.
 *                         A black outer ring adjacent to a cream background
 *                         scores >10:1 even if the average of all ring pixels
 *                         (black + white inner ring) is gray.
 *  p90PerimeterContrast — 90th-percentile of the same boundary sample,
 *                         robust to anti-aliasing artefacts at corners.
 *  estimatedThicknessPx — rough thickness of the changed band (useful for
 *                         reporting, not used in pass/fail).
 *  hasFillChange        — true when the element's interior pixels changed
 *                         colour significantly, indicating a fill-based focus
 *                         state (background-color or text-color inversion).
 */
async function compareScreenshots(
  unfocused: Buffer,
  focused: Buffer,
): Promise<{
  diffPercent: number;
  focusIndicatorColor: { r: number; g: number; b: number } | null;
  backgroundLuminance: number;
  perimeterContrast: number;
  p90PerimeterContrast: number;
  estimatedThicknessPx: number;
  hasFillChange: boolean;
}> {
  const unfocusedImg = sharp(unfocused);
  const focusedImg = sharp(focused);

  const unfocusedMeta = await unfocusedImg.metadata();
  const focusedMeta = await focusedImg.metadata();

  const width = Math.min(unfocusedMeta.width ?? 0, focusedMeta.width ?? 0);
  const height = Math.min(unfocusedMeta.height ?? 0, focusedMeta.height ?? 0);

  if (width === 0 || height === 0) {
    return {
      diffPercent: 0,
      focusIndicatorColor: null,
      backgroundLuminance: 0,
      perimeterContrast: 0,
      p90PerimeterContrast: 0,
      estimatedThicknessPx: 0,
      hasFillChange: false,
    };
  }

  // Force 3-channel RGB so index math is always i*3.
  const unfocusedRaw = await sharp(unfocused)
    .resize(width, height, { fit: "cover" })
    .removeAlpha()
    .raw()
    .toBuffer();

  const focusedRaw = await sharp(focused)
    .resize(width, height, { fit: "cover" })
    .removeAlpha()
    .raw()
    .toBuffer();

  const totalPixels = width * height;

  // Threshold for considering a pixel "changed" (accounts for anti-aliasing).
  const threshold = 20;

  // --- Pass 1: classify each pixel as changed / unchanged ---
  const changed = new Uint8Array(totalPixels);

  let changedPixels = 0;
  let totalR = 0, totalG = 0, totalB = 0;
  let bgR = 0, bgG = 0, bgB = 0;
  let bgCount = 0;

  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 3;
    const dr = Math.abs(unfocusedRaw[idx]     - focusedRaw[idx]);
    const dg = Math.abs(unfocusedRaw[idx + 1] - focusedRaw[idx + 1]);
    const db = Math.abs(unfocusedRaw[idx + 2] - focusedRaw[idx + 2]);

    if (dr > threshold || dg > threshold || db > threshold) {
      changed[i] = 1;
      changedPixels++;
      totalR += focusedRaw[idx];
      totalG += focusedRaw[idx + 1];
      totalB += focusedRaw[idx + 2];
    } else {
      bgR += unfocusedRaw[idx];
      bgG += unfocusedRaw[idx + 1];
      bgB += unfocusedRaw[idx + 2];
      bgCount++;
    }
  }

  const diffPercent = (changedPixels / totalPixels) * 100;

  let focusIndicatorColor: { r: number; g: number; b: number } | null = null;
  if (changedPixels > 0) {
    focusIndicatorColor = {
      r: Math.round(totalR / changedPixels),
      g: Math.round(totalG / changedPixels),
      b: Math.round(totalB / changedPixels),
    };
  }

  const backgroundLuminance =
    bgCount > 0
      ? relativeLuminance(bgR / bgCount, bgG / bgCount, bgB / bgCount)
      : 0;

  // --- Pass 2: same-position contrast of changed pixels ---
  //
  // For each changed pixel compute contrastRatio(focused[i], unfocused[i]).
  // "Same-position" means we contrast the focused colour against what was at
  // that exact pixel before focus — not against an adjacent neighbour.
  //
  // Why this is more robust than the adjacent-neighbour (perimeter) approach:
  //
  // When a nav link is focused the browser draws the ring AND re-renders text
  // (subpixel hinting changes).  Those text-rendering shifts produce changed
  // pixels inside the ring.  The ring pixels then have ALL four neighbours
  // classified as "changed" (anti-aliased fringe outside + text artifacts
  // inside), so the perimeter detector misses them and instead reports only
  // the low-contrast fringe — explaining values like 2.8:1 for a clearly-
  // visible black box.
  //
  // With same-position comparison:
  //   • Black ring pixel: focused=black(0,0,0) unfocused=cream(253,245,228)
  //     → contrast ≈ 19:1 → correctly passes
  //   • Text-rendering shift: focused=teal(26,110,110) unfocused=teal(24,108,108)
  //     → contrast ≈ 1:1 → does not affect the max
  //   • Light-gray 1 px outline: focused=#e0e0e0 unfocused=white
  //     → contrast ≈ 1.3:1 → correctly fails

  let maxSamePosnContrast = 0;
  const contrastSamples: number[] = [];

  for (let i = 0; i < totalPixels; i++) {
    if (!changed[i]) continue;

    const idx = i * 3;
    const focLum = relativeLuminance(focusedRaw[idx], focusedRaw[idx + 1], focusedRaw[idx + 2]);
    const unfLum = relativeLuminance(unfocusedRaw[idx], unfocusedRaw[idx + 1], unfocusedRaw[idx + 2]);
    const c = contrastRatio(focLum, unfLum);

    if (c > maxSamePosnContrast) maxSamePosnContrast = c;
    contrastSamples.push(c);
  }

  let p90PerimeterContrast = 0;
  if (contrastSamples.length > 0) {
    contrastSamples.sort((a, b) => a - b);
    const p90idx = Math.min(
      Math.floor(contrastSamples.length * 0.9),
      contrastSamples.length - 1,
    );
    p90PerimeterContrast = contrastSamples[p90idx];
  }

  // estimatedThicknessPx: not meaningful under the same-position approach;
  // kept at 0 for API compatibility.
  const estimatedThicknessPx = 0;

  // --- Fill change detection ---
  // Sample the inner 50% of the screenshot (avoiding the focus ring itself).
  // A significant colour shift here means the element background or content
  // colour changed — characteristic of fill-based focus states.
  const cx0 = Math.floor(width * 0.25);
  const cx1 = Math.ceil(width * 0.75);
  const cy0 = Math.floor(height * 0.25);
  const cy1 = Math.ceil(height * 0.75);

  let centerDeltaSum = 0;
  let centerCount = 0;

  for (let y = cy0; y < cy1; y++) {
    for (let x = cx0; x < cx1; x++) {
      const idx = (y * width + x) * 3;
      const dr = Math.abs(unfocusedRaw[idx]     - focusedRaw[idx]);
      const dg = Math.abs(unfocusedRaw[idx + 1] - focusedRaw[idx + 1]);
      const db = Math.abs(unfocusedRaw[idx + 2] - focusedRaw[idx + 2]);
      centerDeltaSum += (dr + dg + db) / 3;
      centerCount++;
    }
  }

  // Threshold: average channel delta > 30 across the interior → fill change.
  const hasFillChange = centerCount > 0 && centerDeltaSum / centerCount > 30;

  return {
    diffPercent,
    focusIndicatorColor,
    backgroundLuminance,
    perimeterContrast: maxSamePosnContrast,
    p90PerimeterContrast,
    estimatedThicknessPx,
    hasFillChange,
  };
}

// ---------------------------------------------------------------------------
// Focus visibility checking
// ---------------------------------------------------------------------------

/**
 * Test focus visibility for each tab stop by comparing focused/unfocused screenshots.
 *
 * For each element in the tab sequence:
 * 1. Blur the element and take a screenshot of the area (with 8 px padding to
 *    capture rings that extend outside the element bounding box)
 * 2. Focus the element and take another screenshot
 * 3. Compare pixel-by-pixel for visual differences
 * 4. Use composite perimeter-contrast algorithm to determine if the indicator
 *    is perceivable.  Specifically, an element passes when:
 *      a. The max contrast at the changed/unchanged boundary ≥ minContrast, OR
 *      b. The interior of the element changed colour (fill-based focus state).
 *
 * This avoids false positives for:
 *   • Black outer ring + white inner ring (perimeter pixels are black; their
 *     contrast against the page background is high even though averaging all
 *     ring pixels produces a mid-gray).
 *   • White fill + black border (interior pixels changed → hasFillChange).
 *   • Rectangular boxed focus states on nav links and buttons.
 */
export async function checkFocusVisibility(
  page: Page,
  tabSequence: TabSequenceResult,
  options?: FocusVisibilityCheckOptions,
): Promise<FocusVisibilityResult[]> {
  const minDiffPercent = options?.minDiffPercent ?? 0.5;
  const minContrast = options?.minContrast ?? 3.0;
  const results: FocusVisibilityResult[] = [];

  for (const stop of tabSequence.focusStops) {
    if (!stop.boundingBox) continue;

    const handle = await page.$(stop.selector);
    if (!handle) continue;

    try {
      const padding = 8;
      const clip = {
        x: Math.max(0, stop.boundingBox.x - padding),
        y: Math.max(0, stop.boundingBox.y - padding),
        width: stop.boundingBox.width + padding * 2,
        height: stop.boundingBox.height + padding * 2,
      };

      await page.evaluate(() => {
        (document.activeElement as HTMLElement)?.blur?.();
      });
      await page.waitForTimeout(50);
      const unfocusedScreenshot = await page.screenshot({ clip, type: "png" });

      await handle.focus();
      await page.waitForTimeout(50);
      const focusedScreenshot = await page.screenshot({ clip, type: "png" });

      const {
        diffPercent,
        focusIndicatorColor,
        backgroundLuminance,
        perimeterContrast,
        p90PerimeterContrast,
        estimatedThicknessPx,
        hasFillChange,
      } = await compareScreenshots(unfocusedScreenshot, focusedScreenshot);

      const hasVisualChange = diffPercent >= minDiffPercent;

      // Legacy average-pixel contrast (kept for reporting, not used for pass/fail).
      let measuredContrast: number | null = null;
      if (hasVisualChange && focusIndicatorColor) {
        const focusLuminance = relativeLuminance(
          focusIndicatorColor.r,
          focusIndicatorColor.g,
          focusIndicatorColor.b,
        );
        measuredContrast = contrastRatio(focusLuminance, backgroundLuminance);
      }

      // Composite pass decision.
      // An element passes when there is a visible change AND at least one of:
      //   1. The ring edge has sufficient contrast (handles rings, borders).
      //   2. The element interior changed colour (handles fill/inversion states).
      const meetsMinimum =
        hasVisualChange &&
        (perimeterContrast >= minContrast || hasFillChange);

      results.push({
        selector: stop.selector,
        hasVisualChange,
        contrastRatio: measuredContrast,
        meetsMinimum,
        unfocusedScreenshot,
        focusedScreenshot,
        pixelDiffPercent: diffPercent,
        outerHtml: stop.outerHtml,
        focusMetrics: {
          perimeterContrast,
          p90PerimeterContrast,
          estimatedThicknessPx,
          hasFillChange,
        },
      });
    } finally {
      await handle.dispose();
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// CheckResult generation
// ---------------------------------------------------------------------------

/**
 * Run focus visibility checks and produce CheckResults for failing elements.
 *
 * Flags elements with:
 * - No visible focus change
 * - Focus indicator that fails both the perimeter-contrast test and the
 *   fill-change test
 *
 * Each failing element produces a CheckResult for WCAG 2.4.7 (Focus Visible).
 */
export async function runFocusVisibleChecks(
  page: Page,
  tabSequence: TabSequenceResult,
  options?: FocusVisibilityCheckOptions,
): Promise<CheckResult[]> {
  const minContrast = options?.minContrast ?? 3.0;
  const visibilityResults = await checkFocusVisibility(page, tabSequence, options);
  const checkResults: CheckResult[] = [];

  for (const result of visibilityResults) {
    if (result.meetsMinimum) continue;

    const failureType = !result.hasVisualChange
      ? "no_visible_focus_indicator"
      : "focus_indicator_low_contrast";

    checkResults.push({
      element_selector: result.selector,
      element_html: result.outerHtml,
      wcag_criterion: "2.4.7",
      detected_by: "playwright",
      raw_result: {
        type: failureType,
        hasVisualChange: result.hasVisualChange,
        contrastRatio: result.contrastRatio,
        minimumRequired: minContrast,
        pixelDiffPercent: result.pixelDiffPercent,
        perimeterContrast: result.focusMetrics.perimeterContrast,
        p90PerimeterContrast: result.focusMetrics.p90PerimeterContrast,
        estimatedThicknessPx: result.focusMetrics.estimatedThicknessPx,
        hasFillChange: result.focusMetrics.hasFillChange,
      },
      screenshot: result.focusedScreenshot,
      context_screenshot: result.unfocusedScreenshot,
      measured_values: {
        focus_indicator_contrast: result.contrastRatio,
        minimum_contrast_required: minContrast,
        pixel_diff_percent: result.pixelDiffPercent,
        has_visual_change: result.hasVisualChange,
        perimeter_contrast: result.focusMetrics.perimeterContrast,
        p90_perimeter_contrast: result.focusMetrics.p90PerimeterContrast,
        estimated_thickness_px: result.focusMetrics.estimatedThicknessPx,
        has_fill_change: result.focusMetrics.hasFillChange,
      },
    });
  }

  return checkResults;
}

// Export helpers for testing
export { relativeLuminance, contrastRatio, compareScreenshots };
