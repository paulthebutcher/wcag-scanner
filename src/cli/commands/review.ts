import { Command } from "commander";
import path from "node:path";
import { openDatabase, getFinding, updateFinding, listFindingsByScan } from "../../store/db.js";
import type { Finding, Verdict, Severity, HumanReview } from "../../types.js";

// ---------------------------------------------------------------------------
// Verdict / severity validation
// ---------------------------------------------------------------------------

const VALID_VERDICTS: Verdict[] = ["confirmed", "false_positive", "downgraded", "escalated"];
const VALID_SEVERITIES: Severity[] = ["critical", "major", "minor", "advisory"];

// ---------------------------------------------------------------------------
// Formatting helpers (exported for testing)
// ---------------------------------------------------------------------------

export function formatFindingSummary(finding: Finding): string {
  const lines: string[] = [];
  lines.push(`Finding: ${finding.id}`);
  lines.push(`  WCAG ${finding.wcag_criterion} (${finding.wcag_level}) — ${finding.severity}`);
  lines.push(`  Category: ${finding.category}`);
  lines.push(`  Element: ${finding.evidence.element_selector}`);
  lines.push(`  Reasoning: ${finding.analysis.reasoning.slice(0, 120)}`);
  lines.push(`  Confidence: ${finding.confidence.tier} (${finding.confidence.score})`);
  if (finding.human_review) {
    lines.push(`  Reviewed: ${finding.human_review.verdict} by ${finding.human_review.reviewer} at ${finding.human_review.reviewed_at}`);
  } else {
    lines.push("  Status: pending review");
  }
  return lines.join("\n");
}

export function formatPendingList(findings: Finding[]): string {
  if (findings.length === 0) return "No findings pending review.";

  const lines: string[] = [];
  lines.push(`${findings.length} finding(s) pending review:\n`);

  for (const f of findings) {
    lines.push(`  ${f.id.slice(0, 8)}...  WCAG ${f.wcag_criterion}  ${f.severity.padEnd(9)}  ${f.confidence.tier.padEnd(12)}  ${f.evidence.element_selector.slice(0, 40)}`);
  }

  return lines.join("\n");
}

export function formatReviewStats(findings: Finding[]): string {
  const total = findings.length;
  const reviewed = findings.filter((f) => f.human_review !== null);
  const pending = total - reviewed.length;

  const byVerdict: Record<string, number> = {};
  for (const f of reviewed) {
    const v = f.human_review!.verdict;
    byVerdict[v] = (byVerdict[v] ?? 0) + 1;
  }

  const lines: string[] = [];
  lines.push("Review Statistics:");
  lines.push(`  Total findings: ${total}`);
  lines.push(`  Reviewed: ${reviewed.length} (${total > 0 ? Math.round((reviewed.length / total) * 100) : 0}%)`);
  lines.push(`  Pending: ${pending}`);
  if (reviewed.length > 0) {
    lines.push("  By verdict:");
    for (const [verdict, count] of Object.entries(byVerdict).sort()) {
      lines.push(`    ${verdict}: ${count}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

export function createReviewCommand(): Command {
  const cmd = new Command("review")
    .description("Review findings from a completed scan")
    .argument("[finding-id]", "Finding ID to review")
    .option("--scan <scan-id>", "Scan session ID (for --pending and --stats)")
    .option("--pending", "List findings pending human review")
    .option("--stats", "Show review statistics")
    .option("--verdict <verdict>", "Set verdict: confirmed, false_positive, downgraded, escalated")
    .option("--severity <level>", "Override severity: critical, major, minor, advisory")
    .option("--notes <text>", "Reviewer notes")
    .option("--reviewer <name>", "Reviewer name", "cli-user")
    .option("--data-dir <path>", "Data directory for results", "./wcag-data")
    .action(async (findingId: string | undefined, opts: Record<string, string>) => {
      const dataDir = opts["dataDir"] ?? "./wcag-data";
      const dbPath = path.join(dataDir, "wcag.db");

      try {
        const db = openDatabase(dbPath);

        // --pending: list findings needing review
        if ("pending" in opts) {
          const scanId = opts["scan"];
          if (!scanId) {
            console.error("Error: --pending requires --scan <scan-id>");
            process.exitCode = 1;
            return;
          }
          const findings = listFindingsByScan(db, scanId);
          const pending = findings.filter((f) => f.human_review === null);
          process.stdout.write(formatPendingList(pending) + "\n");
          return;
        }

        // --stats: show review statistics
        if ("stats" in opts) {
          const scanId = opts["scan"];
          if (!scanId) {
            console.error("Error: --stats requires --scan <scan-id>");
            process.exitCode = 1;
            return;
          }
          const findings = listFindingsByScan(db, scanId);
          process.stdout.write(formatReviewStats(findings) + "\n");
          return;
        }

        // Single finding review
        if (!findingId) {
          console.error("Error: finding-id is required (or use --pending/--stats with --scan)");
          process.exitCode = 1;
          return;
        }

        const finding = getFinding(db, findingId);
        if (!finding) {
          console.error(`Error: Finding not found: ${findingId}`);
          process.exitCode = 1;
          return;
        }

        // If no verdict provided, just show the finding
        const verdict = opts["verdict"] as Verdict | undefined;
        if (!verdict) {
          process.stdout.write(formatFindingSummary(finding) + "\n");
          return;
        }

        // Validate verdict
        if (!VALID_VERDICTS.includes(verdict)) {
          console.error(`Error: --verdict must be one of: ${VALID_VERDICTS.join(", ")}`);
          process.exitCode = 1;
          return;
        }

        // Validate severity override if provided
        const severityOverride = opts["severity"] as Severity | undefined;
        if (severityOverride && !VALID_SEVERITIES.includes(severityOverride)) {
          console.error(`Error: --severity must be one of: ${VALID_SEVERITIES.join(", ")}`);
          process.exitCode = 1;
          return;
        }

        // Build human review
        const review: HumanReview = {
          reviewer: opts["reviewer"] ?? "cli-user",
          reviewed_at: new Date().toISOString(),
          verdict,
          notes: opts["notes"] ?? "",
          severity_override: severityOverride ?? null,
          remediation_override: null,
        };

        // Update the finding
        const updates: Parameters<typeof updateFinding>[2] = {
          human_review: review,
        };
        if (severityOverride) {
          updates.severity = severityOverride;
        }

        updateFinding(db, findingId, updates);

        process.stdout.write(`Reviewed ${findingId}: ${verdict}\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exitCode = 1;
      }
    });

  return cmd;
}
