import type { Finding } from "../types.js";
import { checkForFinding } from "../core/check-registry.js";

// ---------------------------------------------------------------------------
// Which check produced a finding, for per-check metrics and repeatability.
// The engine's registry (core/check-registry.ts, used by `wcag verify`) cannot
// attribute model-evaluated error-message findings: their failure types are
// shared with the rule-based submission check or missing from its table
// (logged as P2-008). The harness corrects that here instead of changing
// production code.
// ---------------------------------------------------------------------------

export function evalCheckFor(finding: Finding): string | null {
  if (finding.evidence.detected_by === "claude_api" && (finding.wcag_criterion === "3.3.1" || finding.wcag_criterion === "3.3.3")) {
    return "error-messages";
  }
  return checkForFinding(finding);
}
