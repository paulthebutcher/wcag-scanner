import type { CheckResult } from "../../types.js";
import type { FocusStop, TabSequenceResult } from "./keyboard.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FocusOrderIssue {
  /** The tab stop where the issue starts */
  fromStop: FocusStop;
  /** The tab stop where focus jumped to */
  toStop: FocusStop;
  /** Type of ordering issue */
  issueType: "backward_jump" | "cross_column";
  /** Vertical distance of the jump (positive = downward, negative = backward) */
  verticalDelta: number;
  /** Horizontal distance of the jump */
  horizontalDelta: number;
  /** Confidence in this being a real issue */
  confidence: "high" | "moderate";
  /** Description of the issue */
  description: string;
}

export interface FocusOrderResult {
  /** All detected focus order issues */
  issues: FocusOrderIssue[];
  /** The computed visual reading order */
  visualOrder: FocusStop[];
  /** The actual tab order */
  tabOrder: FocusStop[];
  /** Overall assessment */
  matchesVisualOrder: boolean;
}

export interface FocusOrderOptions {
  /** Threshold in pixels for a "backward jump". Default: 200 */
  backwardThresholdPx?: number;
  /** Row tolerance in pixels — elements within this vertical range are in the same "row". Default: 30 */
  rowTolerancePx?: number;
}

// ---------------------------------------------------------------------------
// Visual reading order computation
// ---------------------------------------------------------------------------

/**
 * Compute the expected visual reading order from bounding boxes.
 *
 * Groups elements into "rows" (elements with similar Y positions),
 * then sorts left-to-right within each row, rows top-to-bottom.
 * This matches natural Western reading order (LTR, top-to-bottom).
 */
export function computeVisualOrder(
  stops: FocusStop[],
  rowTolerancePx: number = 30,
): FocusStop[] {
  // Only include stops with a page position (P2-036: page coordinates, not viewport)
  const withBoxes = stops.filter((s) => s.pagePosition !== null);
  if (withBoxes.length === 0) return [];

  // Group into rows based on vertical center position
  const rows: FocusStop[][] = [];

  for (const stop of withBoxes) {
    const centerY = stop.pagePosition!.y + stop.pagePosition!.height / 2;
    let placed = false;

    for (const row of rows) {
      const rowCenterY =
        row[0].pagePosition!.y + row[0].pagePosition!.height / 2;
      if (Math.abs(centerY - rowCenterY) <= rowTolerancePx) {
        row.push(stop);
        placed = true;
        break;
      }
    }

    if (!placed) {
      rows.push([stop]);
    }
  }

  // Sort rows by Y position (top to bottom)
  rows.sort((a, b) => a[0].pagePosition!.y - b[0].pagePosition!.y);

  // Sort elements within each row by X position (left to right)
  for (const row of rows) {
    row.sort((a, b) => a.pagePosition!.x - b.pagePosition!.x);
  }

  return rows.flat();
}

// ---------------------------------------------------------------------------
// Focus order analysis
// ---------------------------------------------------------------------------

/**
 * Analyze the tab sequence against the expected visual reading order.
 *
 * Detects:
 * - Backward jumps: focus moves to an element visually above/before the current one
 * - Large gaps: focus jumps a large visual distance
 * - Cross-column jumps: focus moves across columns in a grid layout
 *
 * Catches common Webflow issues:
 * - Flexbox reordering (CSS order property changes visual but not DOM order)
 * - Absolutely positioned elements tabbed in DOM order, not visual order
 */
export function analyzeFocusOrder(
  tabSequence: TabSequenceResult,
  options?: FocusOrderOptions,
): FocusOrderResult {
  const backwardThreshold = options?.backwardThresholdPx ?? 200;
  const rowTolerance = options?.rowTolerancePx ?? 30;

  // Embed stops (third-party content the sweep stepped over) have no position of their own
  const ownStops = tabSequence.focusStops.filter((s) => !s.embed);
  const tabOrder = ownStops.filter((s) => s.pagePosition !== null);
  const visualOrder = computeVisualOrder(ownStops, rowTolerance);
  const issues: FocusOrderIssue[] = [];

  // Analyze consecutive tab stops for ordering issues
  for (let i = 0; i < tabOrder.length - 1; i++) {
    const current = tabOrder[i];
    const next = tabOrder[i + 1];

    if (!current.pagePosition || !next.pagePosition) continue;

    const currentCenterY = current.pagePosition.y + current.pagePosition.height / 2;
    const nextCenterY = next.pagePosition.y + next.pagePosition.height / 2;
    const currentCenterX = current.pagePosition.x + current.pagePosition.width / 2;
    const nextCenterX = next.pagePosition.x + next.pagePosition.width / 2;

    const verticalDelta = nextCenterY - currentCenterY;
    const horizontalDelta = nextCenterX - currentCenterX;

    // Check for backward jump: focus moves significantly upward
    if (verticalDelta < -backwardThreshold) {
      const confidence = verticalDelta < -(backwardThreshold * 2) ? "high" : "moderate";
      issues.push({
        fromStop: current,
        toStop: next,
        issueType: "backward_jump",
        verticalDelta,
        horizontalDelta,
        confidence,
        description: `Focus jumps ${Math.abs(Math.round(verticalDelta))}px backward (upward) from "${current.outerHtml.slice(0, 60)}" to "${next.outerHtml.slice(0, 60)}"`,
      });
    }
    // Check for same-row backward jump: significant leftward jump on same row
    else if (
      Math.abs(verticalDelta) <= rowTolerance &&
      horizontalDelta < -backwardThreshold
    ) {
      issues.push({
        fromStop: current,
        toStop: next,
        issueType: "backward_jump",
        verticalDelta,
        horizontalDelta,
        confidence: "moderate",
        description: `Focus jumps ${Math.abs(Math.round(horizontalDelta))}px backward (leftward) on the same row`,
      });
    }
    // A large downward distance between consecutive stops is not reported:
    // in page coordinates (P2-036) it only means a stretch of the page with
    // no focusable content, which is not a focus-order defect. The former
    // "large_gap" rule produced 106 such issues on 23 of 48 corpus pages.
  }

  return {
    issues,
    visualOrder,
    tabOrder,
    matchesVisualOrder: issues.length === 0,
  };
}

// ---------------------------------------------------------------------------
// CheckResult generation
// ---------------------------------------------------------------------------

/**
 * Run focus order validation and produce a single CheckResult per page.
 *
 * Criterion 2.4.3 (Focus Order): focus order should preserve meaning and operability.
 * Produces one CheckResult per page summarizing all ordering issues.
 */
export function runFocusOrderChecks(
  tabSequence: TabSequenceResult,
  options?: FocusOrderOptions,
): CheckResult[] {
  const result = analyzeFocusOrder(tabSequence, options);

  if (result.issues.length === 0) return [];

  // Determine overall confidence from worst issue
  const hasHighConfidence = result.issues.some((i) => i.confidence === "high");

  return [{
    element_selector: "html",
    element_html: `<focus-order-summary issues="${result.issues.length}" tab-stops="${result.tabOrder.length}"/>`,
    wcag_criterion: "2.4.3",
    detected_by: "playwright",
    raw_result: {
      type: "focus_order_mismatch",
      totalIssues: result.issues.length,
      issues: result.issues.map((i) => ({
        issueType: i.issueType,
        fromSelector: i.fromStop.selector,
        toSelector: i.toStop.selector,
        verticalDelta: i.verticalDelta,
        horizontalDelta: i.horizontalDelta,
        confidence: i.confidence,
        description: i.description,
      })),
      matchesVisualOrder: result.matchesVisualOrder,
      tabOrderLength: result.tabOrder.length,
      visualOrderLength: result.visualOrder.length,
    },
    measured_values: {
      total_issues: result.issues.length,
      backward_jumps: result.issues.filter((i) => i.issueType === "backward_jump").length,
      confidence: hasHighConfidence ? "high" : "moderate",
      tab_stops_with_positions: result.tabOrder.length,
      divergence_index: result.issues[0]?.fromStop.sequenceIndex ?? null,
      // Page-coordinate distance of each jump (negative = upward), in sequence order
      jump_distances_px: result.issues.map((i) => ({
        from_index: i.fromStop.sequenceIndex,
        to_index: i.toStop.sequenceIndex,
        vertical: Math.round(i.verticalDelta),
        horizontal: Math.round(i.horizontalDelta),
      })),
    },
  }];
}

// Export analyzeFocusOrder for direct use by downstream modules
export { computeVisualOrder as _computeVisualOrder };
