// Moved to src/core/containment.ts so the engine's form interceptor and the
// eval transport classify submissions the same way (P2-006).
export { classifyRequest, submissionKey, FORM_SUBMISSION_REASONS, PendingSubmissions, type ContainmentDecision, type RequestFacts } from "../../core/containment.js";
