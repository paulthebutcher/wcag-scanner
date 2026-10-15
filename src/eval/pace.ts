import { CaseStore, LabelStore, type LabelEvent } from "./labels.js";
import type { EvalPaths } from "./paths.js";

// ---------------------------------------------------------------------------
// Labelling pace (D9). Active seconds are measured in the review screen from
// display to judgment, paused while the window is hidden and while idle for
// more than 120 s. Propagated copies carry no time of their own and are left
// out; a judgment with no recorded time is counted but not timed.
// ---------------------------------------------------------------------------

export interface PaceStats {
  count: number;
  timed: number;
  median_seconds: number | null;
  p90_seconds: number | null;
}

export interface PaceReport {
  labels: number;
  overall: PaceStats;
  by_criterion: Record<string, PaceStats>;
  by_batch: Record<string, PaceStats>;
  weekly_budget: number;
  first_label_at: string | null;
  days_of_labels: number;
  /** Labels that fit 150 minutes at the measured median, after 14 days of labels */
  fit_150_minutes: number | null;
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function stats(events: LabelEvent[]): PaceStats {
  const times = events.map((e) => e.active_seconds).filter((s): s is number => typeof s === "number").sort((a, b) => a - b);
  const median = times.length === 0 ? null : times.length % 2 === 1 ? times[(times.length - 1) / 2] : (times[times.length / 2 - 1] + times[times.length / 2]) / 2;
  return { count: events.length, timed: times.length, median_seconds: median, p90_seconds: quantile(times, 0.9) };
}

export function paceReport(paths: EvalPaths, now = new Date(), weeklyBudget = Number(process.env.EVAL_WEEKLY_LABELS ?? 125)): PaceReport {
  const events = new LabelStore(paths.labels).events().filter((e) => e.kind === "judgment" && !e.propagation_source);
  const cases = new CaseStore(paths.cases).current();
  const criterionOf = (e: LabelEvent) => cases.get(e.case_id ?? "")?.assertions.find((a) => a.assertion_id === e.assertion_id)?.criterion ?? "unknown";
  const group = (key: (e: LabelEvent) => string) => {
    const m = new Map<string, LabelEvent[]>();
    for (const e of events) m.set(key(e), [...(m.get(key(e)) ?? []), e]);
    return Object.fromEntries(Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([k, v]) => [k, stats(v)]));
  };
  const first = events.length ? events.map((e) => e.timestamp).sort()[0] : null;
  const days = first ? (now.getTime() - Date.parse(first)) / 86_400_000 : 0;
  const overall = stats(events);
  return {
    labels: events.length,
    overall,
    by_criterion: group(criterionOf),
    by_batch: group((e) => e.batch),
    weekly_budget: weeklyBudget,
    first_label_at: first,
    days_of_labels: Math.floor(days),
    fit_150_minutes: days >= 14 && overall.median_seconds ? Math.floor((150 * 60) / overall.median_seconds) : null,
  };
}

export function formatPace(r: PaceReport): string {
  const fmt = (s: PaceStats) => `${String(s.count).padStart(5)}  median ${s.median_seconds === null ? "  n/a" : `${s.median_seconds.toFixed(1)}s`.padStart(6)}  p90 ${s.p90_seconds === null ? "  n/a" : `${s.p90_seconds.toFixed(1)}s`.padStart(6)}`;
  const lines = [`labels ${r.labels} (budget ${r.weekly_budget}/week); first label ${r.first_label_at ?? "none"}; ${r.days_of_labels} day(s)`, `overall      ${fmt(r.overall)}`, "by criterion:"];
  for (const [k, v] of Object.entries(r.by_criterion)) lines.push(`  ${k.padEnd(10)} ${fmt(v)}`);
  lines.push("by batch:");
  for (const [k, v] of Object.entries(r.by_batch)) lines.push(`  ${k.padEnd(10)} ${fmt(v)}`);
  lines.push(r.fit_150_minutes === null ? "150-minute fit: available after 14 days of labels" : `150-minute fit at the measured median: ${r.fit_150_minutes} labels`);
  return lines.join("\n");
}
