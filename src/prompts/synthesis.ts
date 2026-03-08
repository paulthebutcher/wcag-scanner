import type { PromptTemplate, ModelRoute } from "../core/prompt-runner.js";
import type { ConfidenceCalibration } from "./element-evaluation.js";

// ---------------------------------------------------------------------------
// Synthesis family system prompt
// ---------------------------------------------------------------------------

const SYNTHESIS_BASE_SYSTEM = `You are a WCAG 2.1 AA accessibility expert producing analysis and summary reports.
You synthesize findings from automated scans into actionable insights.

Rules:
- Be specific about which user groups are affected and how.
- Prioritize findings by severity and user impact.
- Use plain language accessible to non-technical stakeholders.
- Return your response as a single JSON object (no markdown code fences).
- Do not include explanations outside the JSON.`;

// ---------------------------------------------------------------------------
// Impact Description output schema (Prompt 14)
// ---------------------------------------------------------------------------

export const IMPACT_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["impact_description", "affected_users", "severity_justification", "user_story"],
  properties: {
    impact_description: { type: "string" },
    affected_users: {
      type: "array",
      items: { type: "string" },
    },
    severity_justification: { type: "string" },
    user_story: { type: "string" },
    workaround_exists: { type: "boolean" },
    workaround_description: { type: ["string", "null"] },
  },
};

// ---------------------------------------------------------------------------
// Executive Summary output schema (Prompt 15)
// ---------------------------------------------------------------------------

export const EXECUTIVE_SUMMARY_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["summary", "overall_grade", "critical_findings", "priority_actions", "positive_aspects"],
  properties: {
    summary: { type: "string" },
    overall_grade: { type: "string", enum: ["A", "B", "C", "D", "F"] },
    critical_findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          criterion: { type: "string" },
          description: { type: "string" },
          affected_users: { type: "array", items: { type: "string" } },
          fix_effort: { type: "string" },
        },
      },
    },
    priority_actions: {
      type: "array",
      items: { type: "string" },
    },
    positive_aspects: {
      type: "array",
      items: { type: "string" },
    },
    compliance_percentage: { type: "number" },
    estimated_total_effort: { type: "string" },
    recommended_timeline: { type: "string" },
  },
};

// ---------------------------------------------------------------------------
// Prompt 14: Impact Description
// ---------------------------------------------------------------------------

export const impactDescription: PromptTemplate = {
  name: "impact_description",
  family: "synthesis",
  model: "sonnet" as ModelRoute,
  vision: false,
  systemPrompt: `${SYNTHESIS_BASE_SYSTEM}

You are generating a human-readable impact description for an accessibility finding.

For each finding, explain:
1. What specific user groups are affected (screen reader, keyboard-only, low vision, cognitive, etc.)
2. How the violation affects them in practical terms (what can't they do?)
3. A brief user story illustrating the impact
4. Whether a workaround exists

Write from the user's perspective. Avoid jargon.

Output format:
{
  "impact_description": "When a screen reader user encounters this image...",
  "affected_users": ["screen_reader", "low_vision"],
  "severity_justification": "This is critical because...",
  "user_story": "A blind user navigating the product page...",
  "workaround_exists": true/false,
  "workaround_description": "The user could..." or null
}

You will receive: WCAG criterion, violation type, element context, and severity level.`,
  outputSchema: IMPACT_OUTPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Prompt 15: Executive Summary (Opus)
// ---------------------------------------------------------------------------

export const executiveSummary: PromptTemplate = {
  name: "executive_summary",
  family: "synthesis",
  model: "opus" as ModelRoute,
  vision: false,
  systemPrompt: `${SYNTHESIS_BASE_SYSTEM}

You are generating an executive summary of a WCAG 2.1 AA accessibility audit.

This summary will be read by stakeholders, project managers, and business owners.
It must be clear, actionable, and honest.

Grade the site:
- A: Meets or exceeds WCAG 2.1 AA. Minor advisory findings only.
- B: Mostly compliant. A few minor/moderate issues. No critical barriers.
- C: Partially compliant. Several issues affecting some users. Fix plan needed.
- D: Significant gaps. Multiple barriers affecting disabled users. Priority remediation required.
- F: Major non-compliance. Critical barriers across the site. Immediate action required.

Output format:
{
  "summary": "2-3 sentence overview",
  "overall_grade": "A" | "B" | "C" | "D" | "F",
  "critical_findings": [
    { "criterion": "2.4.7", "description": "...", "affected_users": [...], "fix_effort": "..." }
  ],
  "priority_actions": ["action 1", "action 2", ...],
  "positive_aspects": ["aspect 1", "aspect 2"],
  "compliance_percentage": 0-100,
  "estimated_total_effort": "X hours",
  "recommended_timeline": "2-4 weeks"
}

You will receive: scan summary statistics, finding counts by severity/category/criterion, and passed criteria.`,
  outputSchema: EXECUTIVE_SUMMARY_OUTPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// User prompt template functions
// ---------------------------------------------------------------------------

export function buildImpactUserPrompt(params: {
  wcagCriterion: string;
  failureType: string;
  severity: string;
  elementHtml: string;
  reasoning: string;
  instanceCount: number;
}): string {
  return `Generate an impact description for this accessibility finding.

WCAG Criterion: ${params.wcagCriterion}
Failure Type: ${params.failureType}
Severity: ${params.severity}
Instances on site: ${params.instanceCount}

Element HTML:
${params.elementHtml}

Violation analysis:
${params.reasoning}`;
}

export function buildExecutiveSummaryUserPrompt(params: {
  siteUrl: string;
  totalPages: number;
  totalFindings: number;
  bySeverity: { critical: number; major: number; minor: number; advisory: number };
  byCategory: Record<string, number>;
  criteriaFailed: string[];
  criteriaPassed: string[];
  criteriaTested: number;
}): string {
  const severityStr = Object.entries(params.bySeverity)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");

  const categoryStr = Object.entries(params.byCategory)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");

  return `Generate an executive summary for this WCAG 2.1 AA accessibility audit.

Site: ${params.siteUrl}
Pages scanned: ${params.totalPages}
Total findings: ${params.totalFindings}
WCAG criteria tested: ${params.criteriaTested}

Findings by severity:
${severityStr}

Findings by category:
${categoryStr}

Failed criteria: ${params.criteriaFailed.join(", ") || "(none)"}
Passed criteria: ${params.criteriaPassed.join(", ") || "(none)"}`;
}

// ---------------------------------------------------------------------------
// Confidence calibration
// ---------------------------------------------------------------------------

export const IMPACT_CALIBRATION: ConfidenceCalibration[] = [
  { failureType: "impact_generated", minConfidence: 0.80, maxConfidence: 0.95, requiresHuman: false, falsePositiveRisk: "low" },
];

export const EXECUTIVE_SUMMARY_CALIBRATION: ConfidenceCalibration[] = [
  { failureType: "summary_generated", minConfidence: 0.85, maxConfidence: 0.95, requiresHuman: true, falsePositiveRisk: "low" },
];

// ---------------------------------------------------------------------------
// Prompt registry for Synthesis family
// ---------------------------------------------------------------------------

export const SYNTHESIS_PROMPTS: Record<string, PromptTemplate> = {
  impact_description: impactDescription,
  executive_summary: executiveSummary,
};

export const SYNTHESIS_CALIBRATIONS: Record<string, ConfidenceCalibration[]> = {
  impact_description: IMPACT_CALIBRATION,
  executive_summary: EXECUTIVE_SUMMARY_CALIBRATION,
};
