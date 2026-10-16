// The parser now lives in src/core/robots.ts (shared with production scans,
// P2-007); the eval harness keeps its own product token.
import { parseRobots as parseCore, decideRobots as decideCore, type RobotsFetchOutcome, type RobotsDecision, type RobotsPolicy } from "../core/robots.js";

export { isAllowed, type RobotsFetchOutcome, type RobotsDecision, type RobotsPolicy } from "../core/robots.js";

export const EVAL_PRODUCT_TOKEN = "wcagengine-eval";

export function decideRobots(outcome: RobotsFetchOutcome, productToken = EVAL_PRODUCT_TOKEN): RobotsDecision {
  return decideCore(outcome, productToken);
}

export function parseRobots(content: string, productToken = EVAL_PRODUCT_TOKEN): RobotsPolicy {
  return parseCore(content, productToken);
}
