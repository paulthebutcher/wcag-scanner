import type { PromptTemplate, ModelRoute } from "../core/prompt-runner.js";
import type { ConfidenceCalibration } from "./element-evaluation.js";

// ---------------------------------------------------------------------------
// Remediation family system prompt
// ---------------------------------------------------------------------------

const REMEDIATION_BASE_SYSTEM = `You are a WCAG 2.1 AA remediation expert generating platform-specific fix instructions.
You produce actionable step-by-step remediation guides for accessibility violations.

Rules:
- Fixes must target the specific platform (Webflow, Squarespace, Shopify, WordPress, Framer).
- Include exact UI paths in the platform's designer/editor interface.
- Distinguish between fixes achievable via the platform UI vs. custom code.
- Return your response as a single JSON object (no markdown code fences).
- Do not include explanations outside the JSON.`;

// ---------------------------------------------------------------------------
// Remediation output schema
// ---------------------------------------------------------------------------

export const REMEDIATION_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["generic_fix", "platform_steps", "code_fix", "estimated_effort", "fix_category"],
  properties: {
    generic_fix: { type: "string" },
    platform_steps: {
      type: "array",
      items: { type: "string" },
    },
    designer_path: { type: "string" },
    code_fix: { type: ["string", "null"] },
    estimated_effort: { type: "string", enum: ["trivial", "minor", "moderate", "significant"] },
    fix_category: { type: "string", enum: ["attribute", "structure", "style", "script", "content"] },
    platform_docs_url: { type: ["string", "null"] },
    notes: { type: "string" },
  },
};

// ---------------------------------------------------------------------------
// Verification output schema
// ---------------------------------------------------------------------------

export const VERIFICATION_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["fix_applied", "violation_resolved", "confidence", "reasoning"],
  properties: {
    fix_applied: { type: "boolean" },
    violation_resolved: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reasoning: { type: "string" },
    remaining_issues: {
      type: "array",
      items: { type: "string" },
    },
    new_issues_introduced: {
      type: "array",
      items: { type: "string" },
    },
  },
};

// ---------------------------------------------------------------------------
// Prompt 12: Remediation Generation
// ---------------------------------------------------------------------------

export const remediationGeneration: PromptTemplate = {
  name: "remediation_generation",
  family: "remediation",
  model: "sonnet" as ModelRoute,
  vision: true,
  systemPrompt: `${REMEDIATION_BASE_SYSTEM}

You are generating remediation instructions for an accessibility violation.

For each finding, produce:
1. A generic platform-agnostic fix description.
2. Platform-specific step-by-step instructions with exact UI paths.
3. Custom code fix if the platform UI cannot resolve the issue.
4. Effort estimate: trivial (<5 min), minor (5-15 min), moderate (15-60 min), significant (1+ hour).

Platform UI path format:
- Webflow: "Element Settings → Custom Attributes → Add [attribute]"
- WordPress: "Block Editor → Select Block → Advanced → Additional CSS classes"
- Shopify: "Theme Editor → Sections → [section] → Settings"

Output format:
{
  "generic_fix": "Add descriptive alt text to the image",
  "platform_steps": ["Step 1...", "Step 2..."],
  "designer_path": "Element Settings → Image Settings → Alt Text",
  "code_fix": null or "code string",
  "estimated_effort": "trivial" | "minor" | "moderate" | "significant",
  "fix_category": "attribute" | "structure" | "style" | "script" | "content",
  "platform_docs_url": null or "url",
  "notes": "Additional context"
}

You will receive: the violation details, element HTML, WCAG criterion, platform name, and a screenshot.`,
  outputSchema: REMEDIATION_OUTPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Prompt 13: Remediation Verification
// ---------------------------------------------------------------------------

export const remediationVerification: PromptTemplate = {
  name: "remediation_verification",
  family: "remediation",
  model: "sonnet" as ModelRoute,
  vision: false,
  systemPrompt: `${REMEDIATION_BASE_SYSTEM}

You are verifying that a remediation fix was correctly applied and resolved the violation.

Compare the before and after states:
1. Was the fix actually applied? (check DOM attributes, styles, or structure)
2. Does the element now pass the relevant WCAG criterion?
3. Are there any new issues introduced by the fix?

Output format:
{
  "fix_applied": true/false,
  "violation_resolved": true/false,
  "confidence": 0.0 to 1.0,
  "reasoning": "explanation",
  "remaining_issues": ["issue1", "issue2"],
  "new_issues_introduced": ["issue1"]
}

You will receive: original violation details, applied fix description, and the element HTML/attributes after the fix.`,
  outputSchema: VERIFICATION_OUTPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// User prompt template functions
// ---------------------------------------------------------------------------

export function buildRemediationUserPrompt(params: {
  wcagCriterion: string;
  failureType: string;
  elementHtml: string;
  reasoning: string;
  platform: string;
  platformVersion: string;
}): string {
  return `Generate remediation instructions for this accessibility violation.

WCAG Criterion: ${params.wcagCriterion}
Failure Type: ${params.failureType}
Platform: ${params.platform} (version: ${params.platformVersion})

Element HTML:
${params.elementHtml}

Violation reasoning:
${params.reasoning}`;
}

export function buildVerificationUserPrompt(params: {
  wcagCriterion: string;
  originalHtml: string;
  fixDescription: string;
  fixedHtml: string;
}): string {
  return `Verify that this accessibility fix was correctly applied.

WCAG Criterion: ${params.wcagCriterion}

Original element (violation):
${params.originalHtml}

Applied fix:
${params.fixDescription}

Element after fix:
${params.fixedHtml}`;
}

// ---------------------------------------------------------------------------
// Confidence calibration
// ---------------------------------------------------------------------------

export const REMEDIATION_CALIBRATION: ConfidenceCalibration[] = [
  { failureType: "attribute_fix", minConfidence: 0.90, maxConfidence: 0.98, requiresHuman: false, falsePositiveRisk: "low" },
  { failureType: "structure_fix", minConfidence: 0.75, maxConfidence: 0.90, requiresHuman: true, falsePositiveRisk: "medium" },
  { failureType: "style_fix", minConfidence: 0.80, maxConfidence: 0.95, requiresHuman: false, falsePositiveRisk: "low" },
  { failureType: "script_fix", minConfidence: 0.60, maxConfidence: 0.80, requiresHuman: true, falsePositiveRisk: "medium" },
  { failureType: "content_fix", minConfidence: 0.50, maxConfidence: 0.75, requiresHuman: true, falsePositiveRisk: "high" },
];

export const VERIFICATION_CALIBRATION: ConfidenceCalibration[] = [
  { failureType: "fix_verified", minConfidence: 0.85, maxConfidence: 0.98, requiresHuman: false, falsePositiveRisk: "low" },
  { failureType: "fix_partial", minConfidence: 0.60, maxConfidence: 0.80, requiresHuman: true, falsePositiveRisk: "medium" },
  { failureType: "fix_not_applied", minConfidence: 0.90, maxConfidence: 0.98, requiresHuman: false, falsePositiveRisk: "low" },
];

// ---------------------------------------------------------------------------
// Prompt registry for Remediation family
// ---------------------------------------------------------------------------

export const REMEDIATION_PROMPTS: Record<string, PromptTemplate> = {
  remediation_generation: remediationGeneration,
  remediation_verification: remediationVerification,
};

export const REMEDIATION_CALIBRATIONS: Record<string, ConfidenceCalibration[]> = {
  remediation_generation: REMEDIATION_CALIBRATION,
  remediation_verification: VERIFICATION_CALIBRATION,
};
