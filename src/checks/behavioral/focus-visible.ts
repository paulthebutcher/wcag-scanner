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
  /** Measured contrast ratio of focus indicator (null if no change detected) */
  contrastRatio: number | null;
  /** Whether the contrast meets the 3:1 minimum */
  meetsMinimum: boolean;
  /** Screenshot of element without focus */
  unfocusedScreenshot: Buffer;
  /** Screenshot of element with focus */
  focusedScreenshot: Buffer;
  /** Percentage of pixels that changed */
  pixelDiffPercent: number;
  /** Outer HTML */
  outerHtml: string;
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
 * Returns the percentage of pixels that differ and the dominant color of changed pixels.
 */
async function compareScreenshots(
  unfocused: Buffer,
  focused: Buffer,
): Promise<{
  diffPercent: number;
  focusIndicatorColor: { r: number; g: number; b: number } | null;
  backgroundLuminance: number;
}> {
  // Normalize both images to same dimensions using raw pixel data
  const unfocusedImg = sharp(unfocused);
  const focusedImg = sharp(focused);

  const unfocusedMeta = await unfocusedImg.metadata();
  const focusedMeta = await focusedImg.metadata();

  // Use the smaller dimensions to compare
  const width = Math.min(unfocusedMeta.width ?? 0, focusedMeta.width ?? 0);
  const height = Math.min(unfocusedMeta.height ?? 0, focusedMeta.height ?? 0);

  if (width === 0 || height === 0) {
    return { diffPercent: 0, focusIndicatorColor: null, backgroundLuminance: 0 };
  }

  const unfocusedRaw = await sharp(unfocused)
    .resize(width, height, { fit: "cover" })
    .raw()
    .toBuffer();

  const focusedRaw = await sharp(focused)
    .resize(width, height, { fit: "cover" })
    .raw()
    .toBuffer();

  const totalPixels = width * height;
  let changedPixels = 0;
  let totalR = 0, totalG = 0, totalB = 0;
  let bgR = 0, bgG = 0, bgB = 0;
  let bgCount = 0;

  // Threshold for considering a pixel "changed" (accounts for anti-aliasing)
  const threshold = 20;

  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 3;
    const dr = Math.abs(unfocusedRaw[idx] - focusedRaw[idx]);
    const dg = Math.abs(unfocusedRaw[idx + 1] - focusedRaw[idx + 1]);
    const db = Math.abs(unfocusedRaw[idx + 2] - focusedRaw[idx + 2]);

    if (dr > threshold || dg > threshold || db > threshold) {
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

  const backgroundLuminance = bgCount > 0
    ? relativeLuminance(bgR / bgCount, bgG / bgCount, bgB / bgCount)
    : 0;

  return { diffPercent, focusIndicatorColor, backgroundLuminance };
}

// ---------------------------------------------------------------------------
// Focus visibility checking
// ---------------------------------------------------------------------------

/**
 * Test focus visibility for each tab stop by comparing focused/unfocused screenshots.
 *
 * For each element in the tab sequence:
 * 1. Blur the element and take a screenshot of the area
 * 2. Focus the element and take a screenshot of the area
 * 3. Compare the two images for visual differences
 * 4. Measure focus indicator contrast ratio against background
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
      // Expand the clip area to capture focus rings/outlines outside the element
      const padding = 8;
      const clip = {
        x: Math.max(0, stop.boundingBox.x - padding),
        y: Math.max(0, stop.boundingBox.y - padding),
        width: stop.boundingBox.width + padding * 2,
        height: stop.boundingBox.height + padding * 2,
      };

      // Blur element and screenshot
      await page.evaluate(() => {
        (document.activeElement as HTMLElement)?.blur?.();
      });
      // Small delay for CSS transitions to complete
      await page.waitForTimeout(50);
      const unfocusedScreenshot = await page.screenshot({ clip, type: "png" });

      // Focus element and screenshot
      await handle.focus();
      await page.waitForTimeout(50);
      const focusedScreenshot = await page.screenshot({ clip, type: "png" });

      // Compare screenshots
      const { diffPercent, focusIndicatorColor, backgroundLuminance } =
        await compareScreenshots(unfocusedScreenshot, focusedScreenshot);

      const hasVisualChange = diffPercent >= minDiffPercent;

      let measuredContrast: number | null = null;
      let meetsMinimum = false;

      if (hasVisualChange && focusIndicatorColor) {
        const focusLuminance = relativeLuminance(
          focusIndicatorColor.r,
          focusIndicatorColor.g,
          focusIndicatorColor.b,
        );
        measuredContrast = contrastRatio(focusLuminance, backgroundLuminance);
        meetsMinimum = measuredContrast >= minContrast;
      }

      results.push({
        selector: stop.selector,
        hasVisualChange,
        contrastRatio: measuredContrast,
        meetsMinimum,
        unfocusedScreenshot,
        focusedScreenshot,
        pixelDiffPercent: diffPercent,
        outerHtml: stop.outerHtml,
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
 * - Focus indicator contrast below 3:1
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
      },
      screenshot: result.focusedScreenshot,
      context_screenshot: result.unfocusedScreenshot,
      measured_values: {
        focus_indicator_contrast: result.contrastRatio,
        minimum_contrast_required: minContrast,
        pixel_diff_percent: result.pixelDiffPercent,
        has_visual_change: result.hasVisualChange,
      },
    });
  }

  return checkResults;
}

// Export helpers for testing
export { relativeLuminance, contrastRatio, compareScreenshots };
