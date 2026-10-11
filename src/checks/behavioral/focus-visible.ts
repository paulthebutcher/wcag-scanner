import sharp from "sharp";
import type { ElementHandle, Page } from "playwright";
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
  /** How focus reached the element: a real Tab press, or element.focus() as a fallback */
  focusMethod: "keyboard" | "script";
  /**
   * Set when the element takes keyboard focus but cannot be seen (inside a
   * collapsed container, clipped away, zero size, visibility: hidden).
   */
  hiddenReason: string | null;
  /**
   * The element itself is transparent (opacity 0), typically a native
   * control under a custom-styled replacement. Any focus indicator has to
   * appear on the replacement.
   */
  transparent: boolean;
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

// ---------------------------------------------------------------------------
// Focus helpers
// ---------------------------------------------------------------------------

/** Element state relevant to whether a focus indicator could be seen. */
interface RenderState {
  box: { x: number; y: number; width: number; height: number };
  /** Product of the element's and its ancestors' opacity */
  opacity: number;
  /** Why the element can't be seen, or null */
  hiddenReason: string | null;
  /** Fully transparent after entrance animations had time to finish */
  transparent: boolean;
}

async function readRenderState(handle: ElementHandle): Promise<RenderState | null> {
  return handle.evaluate((target) => {
    const el = target as Element;
    const r = el.getBoundingClientRect();
    let opacity = 1;
    let hiddenReason: string | null = null;
    let node: Element | null = el;
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node);
      opacity *= Number(style.opacity);
      if (style.visibility === "hidden" || style.visibility === "collapse") {
        hiddenReason ??= "visibility: hidden";
      }
      if (node !== el && style.overflow !== "visible") {
        const nr = node.getBoundingClientRect();
        const clippedAway =
          nr.width < 1 || nr.height < 1 ||
          r.bottom <= nr.top || r.top >= nr.bottom || r.right <= nr.left || r.left >= nr.right;
        if (clippedAway) {
          const cls = typeof node.className === "string" && node.className ? `.${node.className.trim().split(/\s+/)[0]}` : "";
          hiddenReason ??= `inside a collapsed or clipped container (${node.tagName.toLowerCase()}${cls}, ${Math.round(nr.height)}px tall, overflow: ${style.overflow})`;
        }
      }
      node = node.parentElement;
    }
    if (r.width < 1 || r.height < 1) hiddenReason ??= "zero size";
    return { box: { x: r.x, y: r.y, width: r.width, height: r.height }, opacity, hiddenReason, transparent: false };
  }).catch(() => null);
}

/**
 * Wait for the element to finish rendering in place: scroll-triggered
 * entrance animations (opacity 0 → 1, slide-ins) and layout shifts. Returns
 * the settled state; if the element is still transparent after the cap it
 * is marked transparent.
 */
async function waitForRenderedState(page: Page, handle: ElementHandle, capMs = 2000): Promise<RenderState | null> {
  const deadline = Date.now() + capMs;
  let previous = await readRenderState(handle);
  while (previous && Date.now() < deadline) {
    await page.waitForTimeout(100);
    const current = await readRenderState(handle);
    if (!current) return previous;
    const stable =
      Math.abs(current.box.x - previous.box.x) < 0.5 &&
      Math.abs(current.box.y - previous.box.y) < 0.5 &&
      Math.abs(current.opacity - previous.opacity) < 0.01;
    previous = current;
    if (stable && (current.opacity >= 0.99 || current.hiddenReason)) break;
  }
  if (previous && previous.opacity < 0.05) {
    previous.transparent = true;
  }
  return previous;
}

/** Wait for CSS transitions/animations on the element itself (e.g. a focus ring fading in). */
async function waitForOwnAnimations(handle: ElementHandle, capMs = 1000): Promise<void> {
  await handle.evaluate((el, cap) => Promise.race([
    Promise.all((el as Element).getAnimations().map((a: Animation) => a.finished.catch(() => undefined))),
    new Promise((resolve) => setTimeout(resolve, cap)),
  ]).then(() => undefined), capMs).catch(() => {});
}

async function isFocused(handle: ElementHandle): Promise<boolean> {
  return handle.evaluate((el) => document.activeElement === el).catch(() => false);
}

/**
 * Move focus to the element with a real Tab key press, the way a keyboard
 * user reaches it, so :focus-visible styles apply exactly as they would for
 * that user. Tabs forward from the previous stop when it is known, otherwise
 * Shift+Tab then Tab from the element itself. Falls back to element.focus()
 * only when neither lands on the element.
 */
async function focusWithKeyboard(
  page: Page,
  handle: ElementHandle,
  previous: ElementHandle | null,
): Promise<"keyboard" | "script"> {
  if (previous) {
    await previous.evaluate((el) => (el as HTMLElement).focus({ preventScroll: true })).catch(() => {});
    await page.keyboard.press("Tab");
    if (await isFocused(handle)) return "keyboard";
  }
  await handle.evaluate((el) => (el as HTMLElement).focus({ preventScroll: true })).catch(() => {});
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  if (await isFocused(handle)) return "keyboard";

  await handle.focus().catch(() => {});
  return "script";
}

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

  const stops = tabSequence.focusStops;
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    if (!stop.boundingBox) continue;

    const handle = await page.$(stop.selector);
    if (!handle) continue;

    // Focus inside a cross-origin iframe (video players, social embeds) is
    // drawn by third-party content the site cannot style; the report scope
    // excludes third-party embedded content.
    const thirdPartyFrame = await handle.evaluate((el) => {
      if (el.tagName !== "IFRAME") return false;
      try {
        return new URL((el as HTMLIFrameElement).src, location.href).origin !== location.origin;
      } catch {
        return false;
      }
    }).catch(() => false);
    if (thirdPartyFrame) {
      await handle.dispose();
      continue;
    }

    const previous = i > 0 ? await page.$(stops[i - 1].selector) : null;

    try {
      // Reach the element with the keyboard first, then bring it to the
      // middle of the viewport (clear of fixed headers and bottom banners)
      // and let entrance animations finish. Scrolling does not move focus.
      const focusMethod = await focusWithKeyboard(page, handle, previous);
      await handle.evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" })).catch(() => {});
      const state = await waitForRenderedState(page, handle);
      await waitForOwnAnimations(handle);

      const box = state?.box ?? stop.boundingBox;
      const padding = 8;
      const clip = {
        x: Math.max(0, box.x - padding),
        y: Math.max(0, box.y - padding),
        width: Math.max(1, box.width + padding * 2),
        height: Math.max(1, box.height + padding * 2),
      };

      // Focused first, then blur and capture the same area unfocused.
      // Blurring does not scroll, so both images cover the same pixels.
      const focusedScreenshot = await page.screenshot({ clip, type: "png" });
      await page.evaluate(() => {
        (document.activeElement as HTMLElement)?.blur?.();
      });
      await waitForOwnAnimations(handle);
      const unfocusedScreenshot = await page.screenshot({ clip, type: "png" });

      const hiddenReason = state?.hiddenReason ?? null;

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
      // This holds for transparent elements too: a native control under a
      // styled replacement passes if the replacement visibly shows focus.
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
        focusMethod,
        hiddenReason,
        transparent: state?.transparent ?? false,
        focusMetrics: {
          perimeterContrast,
          p90PerimeterContrast,
          estimatedThicknessPx,
          hasFillChange,
        },
      });
    } finally {
      await handle.dispose();
      await previous?.dispose();
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

    // Hidden and nothing visible changed: focus is on invisible content.
    const failureType = result.hiddenReason && !result.hasVisualChange
      ? "focus_on_hidden_element"
      : !result.hasVisualChange
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
        focusMethod: result.focusMethod,
        hiddenReason: result.hiddenReason,
        transparent: result.transparent,
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
        focus_method: result.focusMethod,
        ...(result.hiddenReason ? { hidden_reason: result.hiddenReason } : {}),
        ...(result.transparent ? { transparent_control: true } : {}),
      },
    });
  }

  return checkResults;
}

// Export helpers for testing
export { relativeLuminance, contrastRatio, compareScreenshots };
