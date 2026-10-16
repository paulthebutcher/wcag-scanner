// ---------------------------------------------------------------------------
// finding_type_hash: the key that groups findings of one kind for the
// report's cards, remediation caching and before/after comparison. It is
// built from the finding's real failure type (P2-003) — an axe rule id, a
// measured failure_type, or the model's failure_type — never from the tier
// constant the scanner passes around (axe_violation, semantic, behavioral…),
// which made every failure type under one criterion share a card.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

/** The hash scheme stored findings carry; bumped when the inputs change */
export const FINDING_HASH_VERSION = 1;

/**
 * Deterministic SHA-256 over { failure_type, platform, wcag_criterion }
 * with sorted keys, so equal inputs always hash the same way.
 */
export function computeFindingTypeHash(wcagCriterion: string, failureType: string, platform: string): string {
  const payload = JSON.stringify({ failure_type: failureType, platform, wcag_criterion: wcagCriterion });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * The real failure type of a check result, in order of preference: the
 * measured failure_type (every check sets one: the axe rule id, the
 * behavioral or indicator type, the model's verdict), then the raw result's
 * rule id, type or failure_type, then the caller's fallback (the tier
 * constant, kept only so a result that names nothing still hashes).
 */
export function realFailureType(
  result: { measured_values?: Record<string, unknown>; raw_result?: unknown },
  fallback: string,
): string {
  const mv = result.measured_values?.failure_type;
  if (typeof mv === "string" && mv) return mv;
  const raw = result.raw_result;
  if (raw && typeof raw === "object") {
    for (const key of ["ruleId", "type", "failure_type"]) {
      const v = (raw as Record<string, unknown>)[key];
      if (typeof v === "string" && v) return v;
    }
  }
  return fallback;
}
