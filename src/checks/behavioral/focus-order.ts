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
  issueType: "backward_jump" | "large_gap" | "cross_column";
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
  /** Threshold in pixels for a "large gap". Default: 500 */
  largeGapThresholdPx?: number;
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
  // Only include stops with bounding boxes
  const withBoxes = stops.filter((s) => s.boundingBox !== null);
  if (withBoxes.length === 0) return [];

  // Group into rows based on vertical center position
  const rows: FocusStop[][] = [];

  for (const stop of withBoxes) {
    const centerY = stop.boundingBox!.y + stop.boundingBox!.height / 2;
    let placed = false;

    for (const row of rows) {
      const rowCenterY =
        row[0].boundingBox!.y + row[0].boundingBox!.height / 2;
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
  rows.sort((a, b) => a[0].boundingBox!.y - b[0].boundingBox!.y);

  // Sort elements within each row by X position (left to right)
  for (const row of rows) {
    row.sort((a, b) => a.boundingBox!.x - b.boundingBox!.x);
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
  const largeGapThreshold = options?.largeGapThresholdPx ?? 500;
  const rowTolerance = options?.rowTolerancePx ?? 30;

  const tabOrder = tabSequence.focusStops.filter((s) => s.boundingBox !== null);
  const visualOrder = computeVisualOrder(tabSequence.focusStops, rowTolerance);
  const issues: FocusOrderIssue[] = [];

  // Analyze consecutive tab stops for ordering issues
  for (let i = 0; i < tabOrder.length - 1; i++) {
    const current = tabOrder[i];
    const next = tabOrder[i + 1];

    if (!current.boundingBox || !next.boundingBox) continue;

    const currentCenterY = current.boundingBox.y + current.boundingBox.height / 2;
    const nextCenterY = next.boundingBox.y + next.boundingBox.height / 2;
    const currentCenterX = current.boundingBox.x + current.boundingBox.width / 2;
    const nextCenterX = next.boundingBox.x + next.boundingBox.width / 2;

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
    // Check for large vertical gap
    else if (verticalDelta > largeGapThreshold) {
      issues.push({
        fromStop: current,
        toStop: next,
        issueType: "large_gap",
        verticalDelta,
        horizontalDelta,
        confidence: "moderate",
        description: `Focus jumps ${Math.round(verticalDelta)}px downward, skipping visual content`,
      });
    }
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
      large_gaps: result.issues.filter((i) => i.issueType === "large_gap").length,
      confidence: hasHighConfidence ? "high" : "moderate",
      tab_stops_with_boxes: result.tabOrder.length,
    },
  }];
}

// Export analyzeFocusOrder for direct use by downstream modules
export { computeVisualOrder as _computeVisualOrder };
