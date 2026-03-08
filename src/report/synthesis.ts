import type { PromptRunner, PromptResult } from "../core/prompt-runner.js";
import type { ProgressReporter } from "../core/progress.js";
import type { ScanSummary, CriterionResult } from "../types.js";
import type { ReportData, FindingGroup } from "./generator.js";
import {
  impactDescription,
  executiveSummary,
  buildImpactUserPrompt,
  buildExecutiveSummaryUserPrompt,
} from "../prompts/synthesis.js";

// ---------------------------------------------------------------------------
// Impact description output type (from Prompt 14)
// ---------------------------------------------------------------------------

export interface ImpactOutput {
  impact_description: string;
  affected_users: string[];
  severity_justification: string;
  user_story: string;
  workaround_exists: boolean;
  workaround_description: string | null;
}

// ---------------------------------------------------------------------------
// Executive summary output type (from Prompt 15)
// ---------------------------------------------------------------------------

export interface ExecutiveSummaryOutput {
  summary: string;
  overall_grade: string;
  critical_findings: Array<{
    criterion: string;
    description: string;
    affected_users: string[];
    fix_effort: string;
  }>;
  priority_actions: string[];
  positive_aspects: string[];
  compliance_percentage: number;
  estimated_total_effort: string;
  recommended_timeline: string;
}

// ---------------------------------------------------------------------------
// Impact description cache
// ---------------------------------------------------------------------------

const impactCache = new Map<string, ImpactOutput>();

export function getCachedImpact(hash: string): ImpactOutput | undefined {
  return impactCache.get(hash);
}

export function setCachedImpact(hash: string, impact: ImpactOutput): void {
  impactCache.set(hash, impact);
}

export function clearImpactCache(): void {
  impactCache.clear();
}

// ---------------------------------------------------------------------------
// Generate impact descriptions (Prompt 14 — Sonnet)
// ---------------------------------------------------------------------------

/**
 * Generate impact descriptions for each unique finding_type_hash.
 * Calls Prompt 14 once per hash, caches results.
 * Returns a map of hash → impact description string.
 */
export async function generateImpactDescriptions(
  groups: FindingGroup[],
  runner: PromptRunner,
  reporter?: ProgressReporter,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const toGenerate: FindingGroup[] = [];

  // Check cache first
  for (const group of groups) {
    const cached = getCachedImpact(group.hash);
    if (cached) {
      result.set(group.hash, cached.impact_description);
    } else {
      toGenerate.push(group);
    }
  }

  if (toGenerate.length === 0) return result;

  reporter?.update("synthesis", `Generating impact descriptions for ${toGenerate.length} finding types...`);

  const promises = toGenerate.map(async (group, idx) => {
    const first = group.findings[0];
    const userMessage = buildImpactUserPrompt({
      wcagCriterion: group.criterion,
      failureType: group.failureType,
      severity: group.severity,
      elementHtml: first.evidence.element_html,
      reasoning: first.analysis.reasoning,
      instanceCount: group.instanceCount,
    });

    const promptResult: PromptResult<ImpactOutput> = await runner.runPrompt<ImpactOutput>({
      template: impactDescription,
      userMessage,
    });

    if (promptResult.success && promptResult.data) {
      setCachedImpact(group.hash, promptResult.data);
      result.set(group.hash, promptResult.data.impact_description);
    } else {
      result.set(group.hash, first.analysis.impact_description || "Impact assessment unavailable.");
    }

    reporter?.update("synthesis", `Impact descriptions: ${idx + 1}/${toGenerate.length}`);
  });

  await Promise.all(promises);

  reporter?.complete("synthesis", `Generated ${toGenerate.length} impact description(s)`);
  return result;
}

// ---------------------------------------------------------------------------
// Generate executive summary (Prompt 15 — Opus)
// ---------------------------------------------------------------------------

/**
 * Generate an executive summary for the scan.
 * Calls Prompt 15 once (Opus model).
 */
export async function generateExecutiveSummary(
  data: ReportData,
  pageCount: number,
  runner: PromptRunner,
  reporter?: ProgressReporter,
): Promise<ExecutiveSummaryOutput | null> {
  reporter?.update("synthesis", "Generating executive summary...");

  const summary = data.summary;
  const userMessage = buildExecutiveSummaryUserPrompt({
    siteUrl: data.scanSession.url,
    totalPages: pageCount,
    totalFindings: summary?.total_findings ?? data.groups.reduce((s, g) => s + g.instanceCount, 0),
    bySeverity: summary?.by_severity ?? { critical: 0, major: 0, minor: 0, advisory: 0 },
    byCategory: (summary?.by_category ?? {}) as Record<string, number>,
    criteriaFailed: summary?.wcag_criteria_failed ?? data.groups.map(g => g.criterion),
    criteriaPassed: summary?.wcag_criteria_passed ?? [],
    criteriaTested: data.criterionResults.length,
  });

  const promptResult: PromptResult<ExecutiveSummaryOutput> = await runner.runPrompt<ExecutiveSummaryOutput>({
    template: executiveSummary,
    userMessage,
  });

  if (promptResult.success && promptResult.data) {
    reporter?.complete("synthesis", "Executive summary generated");
    return promptResult.data;
  }

  reporter?.warn("synthesis", "Executive summary generation failed — using fallback");
  return null;
}

// ---------------------------------------------------------------------------
// Format executive summary as HTML
// ---------------------------------------------------------------------------

function esc(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function formatExecutiveSummaryHtml(output: ExecutiveSummaryOutput): string {
  const gradeColors: Record<string, string> = {
    A: "#16a34a",
    B: "#65a30d",
    C: "#ca8a04",
    D: "#ea580c",
    F: "#dc2626",
  };
  const gradeColor = gradeColors[output.overall_grade] ?? "#6b7280";

  const criticalSection = output.critical_findings.length > 0
    ? `<h3>Critical Findings</h3>
       <ul>${output.critical_findings.map(f =>
         `<li><strong>${esc(f.criterion)}:</strong> ${esc(f.description)} <em>(${esc(f.fix_effort)})</em></li>`
       ).join("")}</ul>`
    : "";

  const prioritySection = output.priority_actions.length > 0
    ? `<h3>Priority Actions</h3>
       <ol>${output.priority_actions.map(a => `<li>${esc(a)}</li>`).join("")}</ol>`
    : "";

  const positiveSection = output.positive_aspects.length > 0
    ? `<h3>Positive Aspects</h3>
       <ul>${output.positive_aspects.map(a => `<li>${esc(a)}</li>`).join("")}</ul>`
    : "";

  return `
    <div class="executive-summary-content">
      <div class="summary-grid">
        <div class="summary-card" style="border-color:${gradeColor}">
          <div class="summary-number" style="color:${gradeColor};font-size:3rem">${esc(output.overall_grade)}</div>
          <div class="summary-label">Overall Grade</div>
        </div>
        <div class="summary-card">
          <div class="summary-number">${output.compliance_percentage}%</div>
          <div class="summary-label">Compliance</div>
        </div>
        <div class="summary-card">
          <div class="summary-number" style="font-size:1.2rem">${esc(output.estimated_total_effort)}</div>
          <div class="summary-label">Est. Effort</div>
        </div>
        <div class="summary-card">
          <div class="summary-number" style="font-size:1.2rem">${esc(output.recommended_timeline)}</div>
          <div class="summary-label">Timeline</div>
        </div>
      </div>
      <p>${esc(output.summary)}</p>
      ${criticalSection}
      ${prioritySection}
      ${positiveSection}
    </div>`;
}
