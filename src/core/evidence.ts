import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import type Database from "better-sqlite3";
import type {
  CheckResult,
  Finding,
  Evidence,
  Analysis,
  Confidence,
  Remediation,
  PlatformFix,
  Platform,
  Severity,
  Category,
  WcagLevel,
  DetectedBy,
  KeyboardEvent,
} from "../types.js";
import type { FileStore } from "../store/files.js";
import { insertFinding } from "../store/db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CreateFindingOptions {
  scanSessionId: string;
  pageSnapshotId: string;
  interactionStateId: string | null;
  platform: Platform;
  /** Specific failure type for finding_type_hash, e.g. "missing_alt" */
  failureType: string;
  /** Full-page screenshot buffer for Sharp cropping */
  fullPageScreenshot: Buffer | null;
  /** Element position on the full-page screenshot */
  boundingBox: BoundingBox | null;
  /** CSS computed styles to store in Evidence */
  computedStyles?: Record<string, string>;
  db: Database.Database;
  fileStore: FileStore;
}

// ---------------------------------------------------------------------------
// WCAG criterion → level lookup
// ---------------------------------------------------------------------------

const CRITERION_LEVELS: Record<string, WcagLevel> = {
  // Principle 1: Perceivable
  "1.1.1": "A",
  "1.2.1": "A",
  "1.2.2": "A",
  "1.2.3": "A",
  "1.2.4": "AA",
  "1.2.5": "AA",
  "1.3.1": "A",
  "1.3.2": "A",
  "1.3.3": "A",
  "1.3.4": "AA",
  "1.3.5": "AA",
  "1.4.1": "A",
  "1.4.2": "A",
  "1.4.3": "AA",
  "1.4.4": "AA",
  "1.4.5": "AA",
  "1.4.10": "AA",
  "1.4.11": "AA",
  "1.4.12": "AA",
  "1.4.13": "AA",
  // Principle 2: Operable
  "2.1.1": "A",
  "2.1.2": "A",
  "2.1.4": "A",
  "2.2.1": "A",
  "2.2.2": "A",
  "2.3.1": "A",
  "2.4.1": "A",
  "2.4.2": "A",
  "2.4.3": "A",
  "2.4.4": "A",
  "2.4.5": "AA",
  "2.4.6": "AA",
  "2.4.7": "AA",
  "2.5.1": "A",
  "2.5.2": "A",
  "2.5.3": "A",
  "2.5.4": "A",
  // Principle 3: Understandable
  "3.1.1": "A",
  "3.1.2": "AA",
  "3.2.1": "A",
  "3.2.2": "A",
  "3.2.3": "AA",
  "3.2.4": "AA",
  "3.3.1": "A",
  "3.3.2": "A",
  "3.3.3": "AA",
  "3.3.4": "AA",
  // Principle 4: Robust
  "4.1.1": "A",
  "4.1.2": "A",
  "4.1.3": "AA",
};

// ---------------------------------------------------------------------------
// WCAG criterion → category lookup
// ---------------------------------------------------------------------------

const CRITERION_CATEGORIES: Record<string, Category> = {
  // 1.1.x — images / non-text content
  "1.1.1": "images",
  // 1.2.x — time-based media (categorize as semantics)
  "1.2.1": "semantics",
  "1.2.2": "semantics",
  "1.2.3": "semantics",
  "1.2.4": "semantics",
  "1.2.5": "semantics",
  // 1.3.x — structure / adaptable
  "1.3.1": "structure",
  "1.3.2": "structure",
  "1.3.3": "structure",
  "1.3.4": "structure",
  "1.3.5": "structure",
  // 1.4.x — contrast / distinguishable
  "1.4.1": "contrast",
  "1.4.2": "contrast",
  "1.4.3": "contrast",
  "1.4.4": "contrast",
  "1.4.5": "contrast",
  "1.4.10": "contrast",
  "1.4.11": "contrast",
  "1.4.12": "contrast",
  "1.4.13": "contrast",
  // 2.1.x — keyboard
  "2.1.1": "keyboard",
  "2.1.2": "keyboard",
  "2.1.4": "keyboard",
  // 2.2.x — enough time (keyboard-adjacent)
  "2.2.1": "keyboard",
  "2.2.2": "keyboard",
  // 2.3.x — seizures (contrast-adjacent)
  "2.3.1": "contrast",
  // 2.4.x — navigable (keyboard)
  "2.4.1": "keyboard",
  "2.4.2": "keyboard",
  "2.4.3": "keyboard",
  "2.4.4": "keyboard",
  "2.4.5": "keyboard",
  "2.4.6": "keyboard",
  "2.4.7": "keyboard",
  // 2.5.x — input modalities
  "2.5.1": "keyboard",
  "2.5.2": "keyboard",
  "2.5.3": "keyboard",
  "2.5.4": "keyboard",
  // 3.1.x — readable (forms)
  "3.1.1": "forms",
  "3.1.2": "forms",
  // 3.2.x — predictable (forms)
  "3.2.1": "forms",
  "3.2.2": "forms",
  "3.2.3": "forms",
  "3.2.4": "forms",
  // 3.3.x — input assistance (forms)
  "3.3.1": "forms",
  "3.3.2": "forms",
  "3.3.3": "forms",
  "3.3.4": "forms",
  // 4.1.x — compatible (aria)
  "4.1.1": "aria",
  "4.1.2": "aria",
  "4.1.3": "aria",
};

// ---------------------------------------------------------------------------
// Pure helper functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic SHA-256 hash for grouping identical violation patterns.
 * Same inputs always produce the same hash regardless of key insertion order.
 */
export function computeFindingTypeHash(
  wcagCriterion: string,
  failureType: string,
  platform: string,
): string {
  // Sorted keys for determinism
  const payload = JSON.stringify({
    failure_type: failureType,
    platform,
    wcag_criterion: wcagCriterion,
  });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Map a WCAG criterion code to its conformance level.
 * Defaults to "AA" for unknown criteria (safe for an AA-targeted engine).
 */
export function mapCriterionToLevel(wcagCriterion: string): WcagLevel {
  return CRITERION_LEVELS[wcagCriterion] ?? "AA";
}

/**
 * Map a WCAG criterion code to its finding category.
 * Uses exact match first, then prefix-based fallback:
 * 1.1.x→images, 1.3.x→structure, 1.4.x→contrast, 2.1.x→keyboard,
 * 2.4.x→keyboard, 3.x→forms, 4.1.x→aria.
 * Defaults to "semantics" only for truly unknown criteria.
 */
export function mapCriterionToCategory(wcagCriterion: string): Category {
  // Exact match first
  const exact = CRITERION_CATEGORIES[wcagCriterion];
  if (exact) return exact;

  // Prefix-based fallback for unmapped criteria
  if (wcagCriterion.startsWith("1.1.")) return "images";
  if (wcagCriterion.startsWith("1.3.")) return "structure";
  if (wcagCriterion.startsWith("1.4.")) return "contrast";
  if (wcagCriterion.startsWith("2.1.")) return "keyboard";
  if (wcagCriterion.startsWith("2.4.")) return "keyboard";
  if (wcagCriterion.startsWith("3.")) return "forms";
  if (wcagCriterion.startsWith("4.1.")) return "aria";

  return "semantics";
}

// Severity ordering for floor comparison (lower number = higher severity)
const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  advisory: 3,
};

/**
 * Per-criterion severity floor for Tier 3 (Claude API) findings.
 * Confidence can promote severity upward but never below the floor.
 * This prevents scan-to-scan severity drift when Claude confidence
 * fluctuates near threshold boundaries.
 */
export const CRITERION_SEVERITY_FLOOR: Record<string, Severity> = {
  "1.1.1": "minor",      // Alt text — at least minor
  "1.3.1": "minor",      // Info & relationships — at least minor
  "2.4.4": "major",      // Link purpose — at least major
  "2.4.6": "advisory",   // Headings & labels — advisory floor (no forced promotion)
  "3.2.3": "minor",      // Consistent navigation — at least minor
  "3.2.4": "minor",      // Consistent identification — at least minor
  "3.3.2": "minor",      // Labels or instructions — at least minor
  "4.1.2": "major",      // Name, Role, Value — at least major
};

/**
 * Map detection results to our Severity enum using tier-specific rules.
 *
 * - Tier 1 (axe-core):  violation.impact → critical/major/minor/minor
 * - Tier 2 (behavioral): wcag_criterion → critical/major/minor per criterion
 * - Tier 3 (semantic):   Claude confidence → major/minor/advisory (with per-criterion floor)
 * - Tier 4 (forms):      failureType + issue → critical/major/minor
 * - Tier 5 (indicators): always advisory
 */
export function mapToSeverity(
  detectedBy: DetectedBy,
  rawResult: unknown,
  failureType?: string,
  wcagCriterion?: string,
): Severity {
  const raw = (rawResult && typeof rawResult === "object")
    ? rawResult as Record<string, unknown>
    : undefined;

  // --- Tier 1: axe-core — use impact directly ---
  if (detectedBy === "axe_core" && raw) {
    const impact = raw.impact as string | undefined;
    switch (impact) {
      case "critical":
        return "critical";
      case "serious":
        return "major";
      case "moderate":
        return "minor";
      case "minor":
        return "minor";
      default:
        return "major";
    }
  }

  // --- Tier 5: indicators — always advisory ---
  if (failureType === "indicator" || failureType === "error_quality") {
    return "advisory";
  }

  // --- Tier 4: forms — map by failureType and issue (before Tier 2 since forms also use playwright) ---
  if (failureType === "high_risk_form") {
    return "critical";
  }
  if (failureType === "form_submission") {
    const issue = raw?.issue as string | undefined;
    switch (issue) {
      case "no_errors_on_required_fields":
      case "error_not_associated":
      case "color_only_indicator":
      case "error_not_visible":
      default:
        return "major";
    }
  }
  if (failureType === "error_message") {
    return "major";
  }
  if (failureType === "input_purpose" || failureType === "on_input") {
    return "minor";
  }

  // --- Tier 3: semantic (Claude API) — use confidence with per-criterion floor ---
  if (detectedBy === "claude_api" && raw) {
    const confidence = raw.confidence as number | undefined;
    let severity: Severity;
    if (typeof confidence === "number") {
      if (confidence > 0.85) severity = "major";
      else if (confidence >= 0.65) severity = "minor";
      else severity = "advisory";
    } else {
      // Semantic checks without confidence default to minor
      severity = "minor";
    }
    // Apply per-criterion severity floor — confidence can only promote
    // upward, never demote below the floor for that criterion.
    const floor = wcagCriterion ? CRITERION_SEVERITY_FLOOR[wcagCriterion] : undefined;
    if (floor && SEVERITY_ORDER[severity] > SEVERITY_ORDER[floor]) {
      severity = floor;
    }
    return severity;
  }

  // --- Tier 2: behavioral (playwright) — map by criterion ---
  if (detectedBy === "playwright" && wcagCriterion) {
    switch (wcagCriterion) {
      case "2.1.1": // Keyboard accessible
      case "2.1.2": // No keyboard trap
        return "critical";
      case "2.4.7": // Focus visible
      case "2.4.1": // Bypass blocks (skip nav)
        return "major";
      case "2.4.3": // Focus order
        return "minor";
      default:
        return "major";
    }
  }

  return "major";
}

/**
 * Extract a descriptive failure_type label from a CheckResult's raw_result.
 *
 * Each detection tier stores different fields:
 * - axe-core:    raw_result.ruleId  (e.g. "image-alt", "color-contrast")
 * - behavioral:  raw_result.type    (e.g. "keyboard_trap", "no_visible_focus_indicator")
 * - semantic:    raw_result.failure_type (e.g. "missing_alt", "generic_link_text")
 * - forms:       raw_result.issue or raw_result.failure_type
 * - indicators:  raw_result.animationType or raw_result.changeType
 *
 * Falls back to the scanner-level failureType (e.g. "behavioral", "semantic").
 */
export function extractFailureTypeLabel(
  detectedBy: DetectedBy,
  rawResult: unknown,
  scannerFailureType?: string,
): string {
  const raw = (rawResult && typeof rawResult === "object")
    ? rawResult as Record<string, unknown>
    : undefined;

  if (!raw) return scannerFailureType ?? "unknown";

  // axe-core: use ruleId (e.g. "image-alt", "color-contrast", "link-name")
  if (detectedBy === "axe_core") {
    if (typeof raw.ruleId === "string") return raw.ruleId;
    if (typeof raw.id === "string") return raw.id;
    return scannerFailureType ?? "axe_violation";
  }

  // Semantic (claude_api): use failure_type from Claude response
  if (detectedBy === "claude_api") {
    if (typeof raw.failure_type === "string" && raw.failure_type) return raw.failure_type;
    return scannerFailureType ?? "semantic";
  }

  // Behavioral / forms / indicators (playwright): use type or issue
  if (detectedBy === "playwright") {
    if (typeof raw.type === "string") return raw.type;
    if (typeof raw.issue === "string") return raw.issue;
    if (typeof raw.failure_type === "string" && raw.failure_type) return raw.failure_type;
    if (typeof raw.animationType === "string") return raw.animationType;
    if (typeof raw.changeType === "string") return raw.changeType;
    return scannerFailureType ?? "behavioral";
  }

  // Manual / other: use verdict or scannerFailureType
  if (typeof raw.verdict === "string") return raw.verdict;
  return scannerFailureType ?? "unknown";
}

// ---------------------------------------------------------------------------
// Stub factories for sub-entities filled by later modules
// ---------------------------------------------------------------------------

/**
 * Placeholder Analysis — populated by analyzer.ts later.
 */
export function stubAnalysis(): Analysis {
  return {
    method: "rule_based",
    reasoning: "",
    llm_input: null,
    llm_output: null,
    impact_description: "",
    affected_users: [],
  };
}

/**
 * Placeholder Confidence with defaults appropriate to the detection method.
 * Refined by confidence.ts later.
 */
export function stubConfidence(detectedBy: DetectedBy): Confidence {
  switch (detectedBy) {
    case "axe_core":
      return {
        score: 0.95,
        tier: "definitive",
        basis: "Awaiting analysis",
        requires_human: false,
        false_positive_risk: "low",
      };
    case "playwright":
      return {
        score: 0.8,
        tier: "high",
        basis: "Awaiting analysis",
        requires_human: false,
        false_positive_risk: "low",
      };
    case "claude_api":
      return {
        score: 0.5,
        tier: "moderate",
        basis: "Awaiting analysis",
        requires_human: true,
        false_positive_risk: "medium",
      };
    case "manual":
      return {
        score: 0.5,
        tier: "needs_review",
        basis: "Awaiting analysis",
        requires_human: true,
        false_positive_risk: "medium",
      };
  }
}

/**
 * Placeholder Remediation — populated by remediation module later.
 */
export function stubRemediation(platform: Platform): Remediation {
  const platformFix: PlatformFix = {
    platform,
    platform_version: "",
    steps: [],
    designer_path: "",
    screenshots: [],
    generated_by: "template",
    platform_docs_url: null,
  };
  return {
    generic_fix: "",
    platform_fix: platformFix,
    code_fix: null,
    estimated_effort: "moderate",
    fix_verified: false,
  };
}

// ---------------------------------------------------------------------------
// Screenshot cropping (internal)
// ---------------------------------------------------------------------------

/**
 * Crop a region from a full-page screenshot using Sharp.
 * Clamps coordinates to image boundaries.
 */
async function cropScreenshot(
  fullPage: Buffer,
  bbox: BoundingBox,
): Promise<Buffer> {
  const metadata = await sharp(fullPage).metadata();
  const imgWidth = metadata.width ?? 0;
  const imgHeight = metadata.height ?? 0;

  // Clamp to image bounds
  const left = Math.max(0, Math.round(bbox.x));
  const top = Math.max(0, Math.round(bbox.y));
  const width = Math.min(Math.round(bbox.width), imgWidth - left);
  const height = Math.min(Math.round(bbox.height), imgHeight - top);

  if (width <= 0 || height <= 0) {
    // Element is outside the viewport — return a 1x1 transparent PNG
    return sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toBuffer();
  }

  return sharp(fullPage)
    .extract({ left, top, width, height })
    .png()
    .toBuffer();
}

/**
 * Crop a wider context region around an element from the full-page screenshot.
 */
async function cropContextScreenshot(
  fullPage: Buffer,
  bbox: BoundingBox,
  padding = 150,
): Promise<Buffer> {
  const expandedBox: BoundingBox = {
    x: bbox.x - padding,
    y: bbox.y - padding,
    width: bbox.width + padding * 2,
    height: bbox.height + padding * 2,
  };
  return cropScreenshot(fullPage, expandedBox);
}

// ---------------------------------------------------------------------------
// Main factory functions
// ---------------------------------------------------------------------------

/**
 * Create a Finding with a fully populated immutable Evidence sub-entity.
 *
 * This is the sole entry point for Finding creation. Once the Evidence is
 * assembled it is never modified — Analysis, Confidence, and Remediation
 * are populated by later modules via updateFinding().
 */
export async function createFinding(
  checkResult: CheckResult,
  options: CreateFindingOptions,
): Promise<Finding> {
  const findingId = randomUUID();

  // --- Screenshots -----------------------------------------------------------
  let elementScreenshotPath = "";
  let contextScreenshotPath = "";

  try {
    if (options.fullPageScreenshot && options.boundingBox) {
      // Crop from full-page screenshot
      const elementBuf = await cropScreenshot(
        options.fullPageScreenshot,
        options.boundingBox,
      );
      elementScreenshotPath = options.fileStore.store(
        options.scanSessionId,
        `findings/${findingId}-element.png`,
        elementBuf,
      );

      const contextBuf = await cropContextScreenshot(
        options.fullPageScreenshot,
        options.boundingBox,
      );
      contextScreenshotPath = options.fileStore.store(
        options.scanSessionId,
        `findings/${findingId}-context.png`,
        contextBuf,
      );
    } else {
      // Use pre-cropped screenshots from CheckResult if available
      if (checkResult.screenshot) {
        elementScreenshotPath = options.fileStore.store(
          options.scanSessionId,
          `findings/${findingId}-element.png`,
          checkResult.screenshot,
        );
      }
      if (checkResult.context_screenshot) {
        contextScreenshotPath = options.fileStore.store(
          options.scanSessionId,
          `findings/${findingId}-context.png`,
          checkResult.context_screenshot,
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[evidence] Screenshot capture failed for ${checkResult.element_selector}: ${msg}`);
  }

  // --- Evidence (immutable after this point) ---------------------------------
  const measuredValues: Record<string, unknown> = {
    ...(checkResult.measured_values ?? {}),
  };

  // Ensure failure_type is stored in measured_values for report rendering
  if (!measuredValues.failure_type) {
    measuredValues.failure_type = extractFailureTypeLabel(
      checkResult.detected_by,
      checkResult.raw_result,
      options.failureType,
    );
  }

  const evidence: Evidence = {
    element_selector: checkResult.element_selector,
    element_html: checkResult.element_html,
    element_screenshot: elementScreenshotPath,
    element_computed_styles: options.computedStyles ?? {},
    context_screenshot: contextScreenshotPath,
    measured_values: measuredValues,
    keyboard_sequence: (checkResult.keyboard_sequence as KeyboardEvent[] | undefined) ?? null,
    aria_attributes: checkResult.aria_attributes ?? {},
    detected_by: checkResult.detected_by,
  };

  // --- Finding ---------------------------------------------------------------
  const finding: Finding = {
    id: findingId,
    page_snapshot_id: options.pageSnapshotId,
    interaction_state_id: options.interactionStateId,
    wcag_criterion: checkResult.wcag_criterion,
    wcag_level: mapCriterionToLevel(checkResult.wcag_criterion),
    severity: mapToSeverity(
      checkResult.detected_by,
      checkResult.raw_result,
      options.failureType,
      checkResult.wcag_criterion,
    ),
    category: mapCriterionToCategory(checkResult.wcag_criterion),
    finding_type_hash: computeFindingTypeHash(
      checkResult.wcag_criterion,
      options.failureType,
      options.platform,
    ),
    evidence,
    analysis: stubAnalysis(),
    confidence: stubConfidence(checkResult.detected_by),
    remediation: stubRemediation(options.platform),
    human_review: null,
  };

  // --- Persist ---------------------------------------------------------------
  insertFinding(options.db, finding);

  return finding;
}

/**
 * Create Findings for a batch of CheckResults.
 * Errors on individual results are logged and skipped — never crashes the batch.
 */
export async function createFindings(
  checkResults: CheckResult[],
  options: CreateFindingOptions,
): Promise<Finding[]> {
  const findings: Finding[] = [];

  for (const result of checkResults) {
    try {
      const finding = await createFinding(result, options);
      findings.push(finding);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[evidence] Failed to create finding for ${result.element_selector} (${result.wcag_criterion}): ${msg}`,
      );
    }
  }

  return findings;
}
