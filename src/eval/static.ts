import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { chromium, type Browser } from "playwright";
import type { CheckResult, Finding, PageSnapshot } from "../types.js";
import { canonicalJson, readJson, readJsonl, sha256, writeJson } from "./util.js";
import { EvalAnthropicClient, type Injector, type LiveMessages } from "./model/client.js";
import { buildEvalRunner } from "./model/runner.js";
import type { ResponseCache } from "./model/cache.js";
import { buildPredictions, type Prediction } from "./predictions.js";
import { EgressLog, installNodeEgressDenial, startDenyProxy } from "./transport/egress.js";
import { createDenyFetch, installFetch } from "./transport/node-fetch.js";
import { falsePasses, type RunInputs } from "./metrics.js";
import { criterionStatuses, coverageRows } from "./normalize.js";
import type { EngineHandle } from "./engine/types.js";
import type { EvalConfig } from "./config.js";
import type { EvalPaths } from "./paths.js";
import type { ResolutionStatus, SeedResolution, Severity } from "./labels.js";
import type { RunManifest } from "./manifest.js";
import { assertExportSafe, knownPrivateHosts } from "./privacy.js";
import { startFixtureServer } from "./pilot/fixture-server.js";
import { deterministicInjector } from "./model/injector.js";
import { CHECK_TIERS } from "../core/check-registry.js";

// ---------------------------------------------------------------------------
// D10 Lakewood static regression set. Seeds are resolved against stored
// full_dom and evidence in wcag-old.db (scan hints verified to match exactly
// one scan). Each runnable case becomes a private DOM fixture plus a private
// target; eval/lakewood-static.json (committed) holds only ids, provenance,
// fixture hashes, criteria, expected outcomes, adjudication and
// applicability. Static runs execute each engine version's own DOM-only
// checks offline (axe limited to a tested whitelist, page scripts stripped,
// every request refused), with model calls from a separate cache namespace.
// ---------------------------------------------------------------------------

export type Expected = "detected" | "not_detected";
export type Adjudication = "settled" | "pending" | "disputed";
export type CaseStatus = "runnable" | "requires_rendering" | "unresolved_fixture" | "scan_level";

type TargetPlan =
  | { kind: "page" }
  | { kind: "dom"; regex: string }
  | { kind: "finding"; failure_type: string; selector: string }
  | { kind: "none" };

export interface StaticCasePlan {
  id: string;
  seeds: string[];
  scan: string | null;
  page: string | null;
  criterion: string;
  expected: Expected | null;
  severity: Severity | null;
  adjudication: Adjudication;
  status: CaseStatus;
  target: TargetPlan;
  note: string;
}

/** The resolution plan, written from the evidence report (docs/eval/d10-seed-eligibility.md). */
export const STATIC_PLAN: StaticCasePlan[] = [
  { id: "LS-001", seeds: ["SL-004"], scan: "352d16a6", page: "/faq", criterion: "4.1.2", expected: "detected", severity: null, adjudication: "settled", status: "runnable",
    target: { kind: "dom", regex: '<div[^>]*class="q-wrap"[^>]*>' }, note: "FAQ accordion toggles without aria-expanded; 11 identical instances on the page, one case" },
  ...[
    '.home-logo-link.w--current[href="/"]', '.nav-cta-wrap > .w--current[href="/"][aria-current="page"]', '.nav-cta-wrap > .icon-link.w-inline-block[target="_blank"]',
    ".nav-cta-wrap > .icon-link.w-inline-block:nth-child(3)", '.home-logo-link.w-inline-block[href$="court-forms"]', '.icon-link-wrap > .w--current[href="/"][aria-current="page"]',
    '.icon-link-wrap > .icon-link.w-inline-block[target="_blank"]', ".icon-link-wrap > .icon-link.w-inline-block:nth-child(3)",
  ].map((selector, i): StaticCasePlan => ({
    id: `LS-${String(2 + i).padStart(3, "0")}`, seeds: ["SL-007"], scan: "fd896cef", page: "/", criterion: "2.4.4", expected: "detected", severity: null,
    adjudication: "settled", status: "runnable", target: { kind: "finding", failure_type: "link-name", selector },
    note: `Image link with no accessible name (link-name), one of 8 repeated header/footer links`,
  })),
  { id: "LS-010", seeds: ["SL-009"], scan: "352d16a6", page: "/court-docket-search", criterion: "3.3.4", expected: "not_detected", severity: null, adjudication: "settled", status: "runnable",
    target: { kind: "dom", regex: '<form[^>]*id="email-form"[^>]*>' }, note: "Password gate form; no legal, financial or data commitment" },
  { id: "LS-011", seeds: ["SL-018"], scan: "a9d53405", page: "/court-docket-search", criterion: "3.3.4", expected: "not_detected", severity: null, adjudication: "settled", status: "runnable",
    target: { kind: "dom", regex: '<form[^>]*id="email-form"[^>]*>' }, note: "Same form as LS-010 in a later snapshot" },
  { id: "LS-012", seeds: ["SL-011", "SL-017"], scan: "ab75ea1b", page: "/", criterion: "2.4.4", expected: "not_detected", severity: null, adjudication: "settled", status: "runnable",
    target: { kind: "dom", regex: '<a[^>]*class="nav-text-link"[^>]*>(?=Jury Duty<)' }, note: "Navigation link whose text states its purpose; flagged as a duplicate link on every page (inflation)" },
  { id: "LS-013", seeds: ["SL-011"], scan: "ab75ea1b", page: "/court-forms", criterion: "2.4.4", expected: "not_detected", severity: null, adjudication: "pending", status: "runnable",
    target: { kind: "finding", failure_type: "duplicate_link_text", selector: "a.cta.form.w-inline-block" }, note: "Two form links with the same accessible name on one page; whether they share a purpose is not settled" },
  { id: "LS-014", seeds: ["SL-017"], scan: "a9d53405", page: "/", criterion: "2.4.4", expected: "not_detected", severity: null, adjudication: "settled", status: "runnable",
    target: { kind: "dom", regex: '<a[^>]*class="nav-text-link"[^>]*>(?=Jury Duty<)' }, note: "Same navigation link as LS-012 in a later snapshot" },
  ...["name", "email", "Phone-Number"].map((id, i): StaticCasePlan => ({
    id: `LS-${String(15 + i).padStart(3, "0")}`, seeds: ["SL-012"], scan: "f5d0954e", page: "/contact", criterion: "1.3.5", expected: "not_detected", severity: null,
    adjudication: "settled", status: "runnable", target: { kind: "dom", regex: `<input[^>]*id="${id}"[^>]*>` },
    note: id === "Phone-Number" ? "Input with a valid autocomplete token (tel); same class as the seed's name and email inputs" : "Input with a valid autocomplete token",
  })),
  // Expanded at resolution into one case per page of the hinted scan, in path order (LS-101…)
  { id: "LS-1xx", seeds: ["SL-015"], scan: "9aee533b", page: "*", criterion: "2.4.5", expected: "detected", severity: "advisory",
    adjudication: "settled", status: "runnable", target: { kind: "page" }, note: "No second way to find pages; issue real, severity advisory" },
  { id: "LS-040", seeds: ["SL-003"], scan: "352d16a6", page: "/fee-schedules", criterion: "4.1.2", expected: "detected", severity: null, adjudication: "disputed", status: "runnable",
    target: { kind: "dom", regex: '<div[^>]*class="[^"]*w-tabs[^"]*"[^>]*>' }, note: "Rendered tabs already carry tab roles and states; label may describe pre-script template markup" },
  { id: "LS-041", seeds: ["SL-013"], scan: "9aee533b", page: "/", criterion: "1.1.1", expected: "detected", severity: null, adjudication: "disputed", status: "runnable",
    target: { kind: "dom", regex: '<img[^>]*icons8-money-transfer[^>]*>' }, note: "Empty-alt icon inside a link named by its own visible text" },
  { id: "LS-042", seeds: ["SL-014"], scan: "9aee533b", page: "/rules-of-the-court/signature", criterion: "2.4.6", expected: "detected", severity: "major", adjudication: "disputed", status: "runnable",
    target: { kind: "page" }, note: "Skipped heading level; best-practice since f6389d6; awaiting adjudication" },
  { id: "LS-043", seeds: ["SL-005"], scan: "352d16a6", page: "/fee-schedules", criterion: "1.3.1", expected: "detected", severity: null, adjudication: "disputed", status: "unresolved_fixture",
    target: { kind: "none" }, note: "No table elements in any snapshot; fee schedules are div grids" },
  { id: "LS-044", seeds: ["SL-006"], scan: "352d16a6", page: null, criterion: "1.3.1", expected: "detected", severity: null, adjudication: "disputed", status: "unresolved_fixture",
    target: { kind: "none" }, note: "No navigation landmarks in any snapshot" },
  { id: "LS-045", seeds: ["SL-008"], scan: "fd896cef", page: "/contact", criterion: "1.4.3", expected: null, severity: null, adjudication: "settled", status: "requires_rendering",
    target: { kind: "none" }, note: "Contrast over a background image needs rendered evidence; none stored" },
  { id: "LS-046", seeds: ["SL-010"], scan: null, page: null, criterion: "1.1.1", expected: "not_detected", severity: null, adjudication: "settled", status: "unresolved_fixture",
    target: { kind: "none" }, note: "Labelled image not present in any stored snapshot" },
  { id: "LS-047", seeds: ["SL-001"], scan: null, page: null, criterion: "scan", expected: null, severity: null, adjudication: "settled", status: "scan_level",
    target: { kind: "none" }, note: "Synthetic: a hidden reCAPTCHA response field must not stall or fail form testing" },
  { id: "LS-048", seeds: ["SL-002"], scan: null, page: null, criterion: "scan", expected: null, severity: null, adjudication: "settled", status: "scan_level",
    target: { kind: "none" }, note: "Suspected Tier 5 false negative without a concrete element; kept as a note, not testable" },
  { id: "LS-049", seeds: ["SL-016"], scan: null, page: null, criterion: "scan", expected: null, severity: null, adjudication: "settled", status: "scan_level",
    target: { kind: "none" }, note: "Synthetic: API failures and partial checks must never produce a criterion pass" },
];

export interface StaticCase {
  case_id: string;
  seeds: string[];
  fixture_sha256: string | null;
  criterion: string;
  expected_outcome: Expected | null;
  expected_severity: Severity | null;
  adjudication: Adjudication;
  status: CaseStatus;
  applicability: Record<string, "applicable" | "not_applicable">;
  note: string;
}

export interface StaticFile {
  schema_version: 1;
  source_store: "wcag-old.db";
  cases: StaticCase[];
}

interface PrivateTarget {
  case_id: string;
  scan_id: string;
  snapshot_id: string;
  page: string;
  title: string;
  selector: string | null;
  opening_tag: string | null;
  finding_ids: string[];
}

function staticDir(paths: EvalPaths): string {
  return join(paths.dataDir, "eval-static");
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolveResult {
  file: StaticFile;
  targets: PrivateTarget[];
  resolutions: SeedResolution[];
  problems: string[];
}

export function resolveStatic(paths: EvalPaths, config: EvalConfig, engines: Record<string, string[]>): ResolveResult {
  const store = join(paths.dataDir, "wcag-old.db");
  if (!existsSync(store)) throw new Error(`Old store not found at ${store}`);
  const db = new Database(store, { readonly: true, fileMustExist: true });
  const problems: string[] = [];
  const targets: PrivateTarget[] = [];
  const cases: StaticCase[] = [];
  const fixturesDir = join(staticDir(paths), "fixtures");
  mkdirSync(fixturesDir, { recursive: true });
  const scanIds = new Map<string, string>();
  const findingIdsBySeed = new Map<string, Set<string>>();
  const snapshotsBySeed = new Map<string, Set<string>>();

  try {
    // Expand page wildcards into one case per page of the hinted scan
    const expanded: StaticCasePlan[] = [];
    for (const plan of STATIC_PLAN) {
      if (plan.page !== "*") { expanded.push(plan); continue; }
      const scan = (db.prepare("select id from scan_sessions where id like ?").all(`${plan.scan}%`) as Array<{ id: string }>);
      if (scan.length !== 1) { problems.push(`${plan.id}: scan hint ${plan.scan} matches ${scan.length} scans`); continue; }
      const pagePaths = (db.prepare("select url from page_snapshots where scan_session_id = ?").all(scan[0].id) as Array<{ url: string }>)
        .map((r) => { const p = new URL(r.url).pathname; return p === "/" ? "/" : p.replace(/\/$/, ""); })
        .sort();
      pagePaths.forEach((page, i) => expanded.push({ ...plan, id: `LS-${101 + i}`, page }));
    }
    for (const plan of expanded) {
      let fixture: string | null = null;
      if (plan.scan && plan.page !== null && plan.status !== "unresolved_fixture") {
        const matches = db.prepare("select id from scan_sessions where id like ?").all(`${plan.scan}%`) as Array<{ id: string }>;
        if (matches.length !== 1) {
          problems.push(`${plan.id}: scan hint ${plan.scan} matches ${matches.length} scans`);
          continue;
        }
        const scanId = matches[0].id;
        scanIds.set(plan.scan, scanId);
        const snaps = db.prepare("select id, url, title, full_dom from page_snapshots where scan_session_id = ?").all(scanId) as Array<{ id: string; url: string; title: string; full_dom: string }>;
        const snap = snaps.find((s) => {
          try {
            const p = new URL(s.url).pathname;
            return (p === "/" ? "/" : p.replace(/\/$/, "")) === plan.page;
          } catch { return false; }
        });
        if (!snap) {
          problems.push(`${plan.id}: no snapshot for its page in ${plan.scan}`);
          continue;
        }
        fixture = sha256(snap.full_dom);
        const fixturePath = join(fixturesDir, `${fixture}.html`);
        if (!existsSync(fixturePath)) writeFileSync(fixturePath, snap.full_dom);
        let selector: string | null = null;
        let tag: string | null = null;
        let findingIds: string[] = [];
        const storedFor = (match: (html: string) => boolean): string[] =>
          (db.prepare("select id, wcag_criterion, evidence from findings where page_snapshot_id = ?").all(snap.id) as Array<{ id: string; wcag_criterion: string; evidence: string }>)
            .filter((r) => r.wcag_criterion === plan.criterion && match((JSON.parse(r.evidence) as { element_html?: string }).element_html ?? ""))
            .map((r) => r.id);
        if (plan.target.kind === "dom") {
          const m = snap.full_dom.match(new RegExp(plan.target.regex, "i"));
          if (!m) problems.push(`${plan.id}: target markup not found in the snapshot`);
          tag = m ? m[0] : null;
          if (tag) findingIds = storedFor((html) => html.includes(tag!) || (html.length > 0 && tag!.startsWith(html.slice(0, html.indexOf(">") + 1))));
        } else if (plan.target.kind === "page") {
          findingIds = storedFor(() => true);
        } else if (plan.target.kind === "finding") {
          const rows = db.prepare("select id, evidence from findings where page_snapshot_id = ?").all(snap.id) as Array<{ id: string; evidence: string }>;
          const hits = rows.filter((r) => {
            const ev = JSON.parse(r.evidence) as { element_selector: string; measured_values?: { failure_type?: string } };
            return ev.element_selector === (plan.target as { selector: string }).selector && ev.measured_values?.failure_type === (plan.target as { failure_type: string }).failure_type;
          });
          if (hits.length === 0) problems.push(`${plan.id}: no stored finding for the target`);
          selector = (plan.target as { selector: string }).selector;
          const html = hits.length ? (JSON.parse(hits[0].evidence) as { element_html: string }).element_html : "";
          tag = html ? html.slice(0, html.indexOf(">") + 1) : null;
          findingIds = hits.map((h) => h.id);
        }
        for (const seed of plan.seeds) {
          if (!findingIdsBySeed.has(seed)) findingIdsBySeed.set(seed, new Set());
          if (!snapshotsBySeed.has(seed)) snapshotsBySeed.set(seed, new Set());
          for (const id of findingIds) findingIdsBySeed.get(seed)!.add(id);
          snapshotsBySeed.get(seed)!.add(snap.id);
        }
        targets.push({ case_id: plan.id, scan_id: scanId, snapshot_id: snap.id, page: plan.page, title: snap.title, selector, opening_tag: tag, finding_ids: findingIds });
      }
      const crit = config.criteria.find((c) => c.id === plan.criterion);
      cases.push({
        case_id: plan.id,
        seeds: plan.seeds,
        fixture_sha256: fixture,
        criterion: plan.criterion,
        expected_outcome: plan.expected,
        expected_severity: plan.severity,
        adjudication: plan.adjudication,
        status: plan.status,
        applicability: Object.fromEntries(Object.entries(engines).map(([label, checks]) => [label, crit && crit.checks.some((c) => checks.includes(c)) ? "applicable" : "not_applicable"])),
        note: plan.note,
      });
    }

    // API-failure rows of the composite seed are tooling errors, recorded on the resolution
    const composite = scanIds.get("ab75ea1b");
    const apiFailures = composite
      ? (db.prepare("select count(*) as n from findings f join page_snapshots p on f.page_snapshot_id = p.id where p.scan_session_id = ? and json_extract(f.analysis, '$.reasoning') like 'Prompt evaluation failed%'").get(composite) as { n: number }).n
      : 0;

    const seeds = readJsonl<{ id: string }>(paths.seedLabels).map((s) => s.id);
    const statusOf = (seed: string): { status: ResolutionStatus; notes: string } => {
      const plans = expanded.filter((p) => p.seeds.includes(seed));
      if (plans.some((p) => p.status === "scan_level")) return { status: "scan_level", notes: plans[0].note };
      if (plans.some((p) => p.status === "requires_rendering")) return { status: "requires_rendering", notes: plans[0].note };
      if (plans.every((p) => p.status === "unresolved_fixture")) return { status: plans.some((p) => p.adjudication === "disputed") ? "disputed" : "unresolved_fixture", notes: plans[0].note };
      if (plans.some((p) => p.adjudication === "disputed")) return { status: "disputed", notes: plans[0].note };
      if (seed === "SL-011") return { status: "partially_resolved", notes: `Composite: ${apiFailures} API-failure rows are tooling errors; the duplicate-link rows are resolved as cases` };
      return { status: "resolved", notes: plans.map((p) => p.note).filter((v, i, a) => a.indexOf(v) === i).join("; ") };
    };
    const existing = readJsonl<SeedResolution>(paths.seedResolutions);
    let seq = existing.reduce((m, r) => Math.max(m, r.seq), 0);
    const latest = new Map(existing.sort((a, b) => a.seq - b.seq).map((r) => [r.seed_id, r]));
    const resolutions: SeedResolution[] = [];
    for (const seed of seeds) {
      const plans = expanded.filter((p) => p.seeds.includes(seed));
      const { status, notes } = statusOf(seed);
      const t = targets.filter((x) => plans.some((p) => p.id === x.case_id));
      const firstTarget = t[0];
      const scanHint = plans.find((p) => p.scan)?.scan;
      const record: Omit<SeedResolution, "seq" | "resolved_at"> = {
        seed_id: seed, status, store: "wcag-old.db", scan_id: scanHint ? scanIds.get(scanHint) ?? null : null,
        snapshot_ids: Array.from(snapshotsBySeed.get(seed) ?? []), finding_ids: Array.from(findingIdsBySeed.get(seed) ?? []),
        case_ids: plans.map((p) => p.id),
        element: firstTarget ? { selector: firstTarget.selector, html_sha256: firstTarget.opening_tag ? sha256(firstTarget.opening_tag) : null } : null,
        state: firstTarget ? "load" : null,
        method: plans.some((p) => p.target.kind === "finding") ? "stored-finding match" : plans.some((p) => p.target.kind === "dom") ? "full_dom search" : plans.some((p) => p.target.kind === "page") ? "page-level snapshot" : "none",
        notes,
      };
      const prior = latest.get(seed);
      const same = prior && canonicalJson({ ...prior, seq: 0, resolved_at: "" }) === canonicalJson({ ...record, seq: 0, resolved_at: "" });
      if (!same) {
        seq++;
        resolutions.push({ ...record, seq, resolved_at: new Date().toISOString() });
      }
    }
    return { file: { schema_version: 1, source_store: "wcag-old.db", cases }, targets, resolutions, problems };
  } finally {
    db.close();
  }
}

export function writeResolution(paths: EvalPaths, r: ResolveResult): void {
  assertExportSafe(r.file, "lakewood-static.json", knownPrivateHosts(paths));
  writeJson(paths.lakewoodStatic, r.file);
  writeJson(join(staticDir(paths), "targets.private.json"), r.targets);
  if (r.resolutions.length > 0) {
    mkdirSync(paths.evalDir, { recursive: true });
    writeFileSync(paths.seedResolutions, (existsSync(paths.seedResolutions) ? readFileSync(paths.seedResolutions, "utf8") : "") + r.resolutions.map((x) => JSON.stringify(x)).join("\n") + "\n");
  }
}

// ---------------------------------------------------------------------------
// axe whitelist: rules whose verdict on a visible element needs no CSS,
// layout or external resources. Tested (static.test.ts) by comparing results
// with and without stylesheets on visible elements.
// ---------------------------------------------------------------------------

export const AXE_STATIC_WHITELIST = [
  "image-alt", "input-image-alt", "area-alt", "object-alt", "role-img-alt", "svg-img-alt",
  "link-name", "button-name", "input-button-name", "label", "select-name", "frame-title", "frame-title-unique",
  "html-has-lang", "html-lang-valid", "html-xml-lang-mismatch", "valid-lang", "document-title",
  "aria-allowed-attr", "aria-valid-attr", "aria-valid-attr-value", "aria-roles", "aria-required-attr", "aria-prohibited-attr", "aria-deprecated-role",
  "list", "listitem", "dlitem", "definition-list", "autocomplete-valid", "form-field-multiple-labels",
];

/** Remove what could run or fetch: scripts, inline handlers, base, preloads, iframes' src. */
export function sanitizeFixture(dom: string): string {
  return dom
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/<link\b[^>]*rel=["']?(?:preload|prefetch|modulepreload|preconnect|dns-prefetch)[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(<iframe\b[^>]*?)\ssrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "$1");
}

// ---------------------------------------------------------------------------
// Static runs
// ---------------------------------------------------------------------------

interface CheckRun {
  check: string;
  failureType: string;
  criteria: string[];
  run: (ctx: { dom: string; title: string; url: string; snapshot: PageSnapshot; runner: unknown; axeFlagged: Set<string> }) => Promise<CheckResult[]>;
}

type Mod = Record<string, (...args: unknown[]) => unknown>;

async function checkRuns(engine: EngineHandle): Promise<CheckRun[]> {
  const link = await engine.importModule<Mod>("checks/semantic/link-text");
  const headings = await engine.importModule<Mod>("checks/semantic/headings");
  const landmarks = await engine.importModule<Mod>("checks/semantic/landmark-labels");
  const widget = await engine.importModule<Mod>("checks/semantic/widget-aria");
  const tables = await engine.importModule<Mod>("checks/semantic/table-structure");
  const dup = await engine.importModule<Mod>("checks/semantic/duplicate-links");
  const alt = await engine.importModule<Mod>("checks/semantic/alt-text");
  const discovery = await engine.importModule<Mod>("checks/forms/discovery");
  const highRisk = await engine.importModule<Mod>("checks/forms/high-risk");
  const errEval = await engine.importModule<Mod>("checks/forms/error-evaluation");
  const ways = await engine.importModule<Mod>("checks/indicators/multiple-ways");
  const asResults = (v: unknown) => v as Promise<CheckResult[]> | CheckResult[];
  return [
    { check: "link-text", failureType: "semantic", criteria: ["2.4.4"], run: async (c) => asResults(link.runLinkTextChecks(c.dom, c.runner)) },
    { check: "duplicate-links", failureType: "semantic", criteria: ["2.4.4"], run: async (c) => asResults(dup.runDuplicateLinkChecks(c.dom, c.url)) },
    { check: "headings", failureType: "semantic", criteria: ["1.3.1", "2.4.6"], run: async (c) => asResults(headings.runHeadingChecks(c.dom, c.title, c.runner)) },
    { check: "landmark-labels", failureType: "semantic", criteria: ["1.3.1"], run: async (c) => asResults(landmarks.runLandmarkLabelChecks(c.dom)) },
    { check: "table-structure", failureType: "semantic", criteria: ["1.3.1"], run: async (c) => asResults(tables.runTableStructureChecks(c.dom)) },
    { check: "widget-aria", failureType: "semantic", criteria: ["4.1.2"], run: async (c) => asResults(widget.runWidgetAriaChecks(c.dom, c.runner)) },
    // Static variant: no image (production alt-text requests carry the fetched image)
    { check: "alt-text", failureType: "semantic", criteria: ["1.1.1"], run: async (c) => asResults(alt.runAltTextChecks(c.dom, c.runner, { axeFlaggedSelectors: c.axeFlagged })) },
    { check: "high-risk-forms", failureType: "high_risk_form", criteria: ["3.3.4"], run: async (c) => asResults(highRisk.evaluateHighRiskForms(discovery.discoverForms(c.snapshot), c.runner)) },
    {
      check: "input-purpose", failureType: "input_purpose", criteria: ["1.3.5"], run: async (c) => {
        const out: CheckResult[] = [];
        for (const form of discovery.discoverForms(c.snapshot) as unknown[]) out.push(...await asResults(errEval.evaluateInputPurpose(form, c.runner)));
        return out;
      },
    },
    { check: "multiple-ways", failureType: "indicator", criteria: ["2.4.5"], run: async (c) => asResults(ways.checkMultipleWays(c.snapshot)) },
  ];
}

export interface StaticCaseOutcome {
  case_id: string;
  engine: string;
  outcome: "pass" | "fail" | "unavailable" | "not_run";
  reason: string;
  confirmed_detected: boolean | null;
  inclusive_detected: boolean | null;
  severity_ok: boolean | null;
  matched: Array<{ check: string | null; severity: string; confidence: string; failure_type: string | null }>;
}

export interface StaticClientOptions {
  mode: "replay" | "record" | "inject";
  cache?: ResponseCache;
  live?: LiveMessages;
  injector?: Injector;
  maxCostUsd?: number;
}

export interface StaticRunResult {
  engine: string;
  outcomes: StaticCaseOutcome[];
  predictions: Record<string, Prediction[]>;
  model: { requests: number; cache_misses: number; entries_read: number; entries_created: number; cost_usd: number; attempts_used: string[] };
  egress: number;
  static_resources_refused: number;
  synthetic: { sl001: SyntheticOutcome; sl016: SyntheticOutcome } | null;
}

export interface SyntheticOutcome {
  outcome: "pass" | "fail" | "unavailable";
  detail: string;
}

function matchesTarget(p: Prediction, target: PrivateTarget | undefined, criterion: string): boolean {
  if (p.criterion !== criterion) return false;
  if (!target) return false;
  if (!target.selector && !target.opening_tag) return true; // page-level
  if (target.selector && p.selector === target.selector) return true;
  if (target.opening_tag) {
    const tag = target.opening_tag;
    const ptag = p.element_html.slice(0, p.element_html.indexOf(">") + 1);
    return p.element_html.includes(tag) || (ptag.length > 0 && ptag === tag);
  }
  return false;
}

export async function runStatic(options: {
  paths: EvalPaths;
  config: EvalConfig;
  engine: EngineHandle;
  client: StaticClientOptions;
  runId: string;
  includeSynthetic: boolean;
  log: (m: string) => void;
}): Promise<StaticRunResult> {
  const { paths, engine, log } = options;
  const file = readJson<StaticFile>(paths.lakewoodStatic);
  const targets = new Map(readJson<PrivateTarget[]>(join(staticDir(paths), "targets.private.json")).map((t) => [t.case_id, t]));
  const runs = await checkRuns(engine);
  const evidence = await engine.importModule<Mod>("core/evidence");
  const analyzer = await engine.importModule<Mod>("core/analyzer");
  const confidence = await engine.importModule<Mod>("core/confidence");
  const dbMod = await engine.importModule<Mod>("store/db");
  const filesMod = await engine.importModule<{ LocalFileStore: new (dir: string) => unknown }>("store/files");
  const axeMod = await engine.importModule<Mod>("checks/automated/index");

  const runnable = file.cases.filter((c) => c.status === "runnable" && c.fixture_sha256);
  const fixtures = Array.from(new Set(runnable.map((c) => c.fixture_sha256!)));
  const model = { requests: 0, cache_misses: 0, entries_read: 0, entries_created: 0, cost_usd: 0, attempts_used: [] as string[] };
  const predictions: Record<string, Prediction[]> = {};
  const fixtureMisses = new Map<string, Set<string>>(); // fixture → checks with cache misses
  const work = mkdtempSync(join(tmpdir(), "eval-static-"));
  const egress = new EgressLog();
  const releaseNode = installNodeEgressDenial(egress);
  const releaseFetch = installFetch(createDenyFetch((m, u) => egress.record("node", `fetch-${m.toLowerCase()}`, u)));
  const proxy = await startDenyProxy(egress);
  let browser: Browser | null = null;
  let refused = 0;
  try {
    browser = await chromium.launch({ headless: true, proxy: proxy.launchOptions.proxy, args: proxy.launchOptions.args });
    const db = dbMod.openDatabase(join(work, "static.db")) as { close(): void };
    const fileStore = new filesMod.LocalFileStore(join(work, "files"));
    const scanId = `static-${options.runId}`;
    dbMod.insertScanSession(db, { id: scanId, url: "static://fixtures", platform: "webflow", platform_detected_via: "static", initiated_at: new Date().toISOString(), completed_at: "", comparison_scan_id: null, scan_type: "initial", detection_manifest: null, excluded_pages: null });

    for (const fx of fixtures) {
      const casesHere = runnable.filter((c) => c.fixture_sha256 === fx);
      const t0 = targets.get(casesHere[0].case_id)!;
      const dom = readFileSync(join(staticDir(paths), "fixtures", `${fx}.html`), "utf8");
      const url = `https://static-fixture.invalid/${fx.slice(0, 12)}`;
      const snapshot: PageSnapshot = { id: `snap-${fx.slice(0, 16)}`, scan_session_id: scanId, url, title: t0.title, captured_at: new Date().toISOString(), full_dom: dom, screenshot: "", viewport: options.config.replay.viewport };
      dbMod.insertPageSnapshot(db, snapshot);
      const wanted = new Set(casesHere.map((c) => c.criterion));

      // axe (whitelisted rules) on the sanitised fixture, every request refused
      const axeResults: { violations: CheckResult[]; incomplete: CheckResult[] } = { violations: [], incomplete: [] };
      {
        const ctx = await browser.newContext({ serviceWorkers: "block" });
        await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((fn) => fn);" });
        await ctx.route("**/*", (route) => { refused++; return route.abort("blockedbyclient"); });
        const page = await ctx.newPage();
        await page.setContent(sanitizeFixture(dom), { waitUntil: "domcontentloaded" });
        const allRules = (await import("axe-core")).default.getRules().map((r: { ruleId: string }) => r.ruleId);
        const out = await (axeMod.runAxeChecks as (p: unknown, id: string, o: unknown) => Promise<{ violations: CheckResult[]; incomplete: CheckResult[] }>)(page, scanId, { disableRules: allRules.filter((r: string) => !AXE_STATIC_WHITELIST.includes(r)) });
        axeResults.violations = out.violations;
        axeResults.incomplete = out.incomplete;
        await ctx.close();
      }
      const axeFlagged = new Set(axeResults.violations.map((v) => v.element_selector));

      const findings: Finding[] = [];
      const toFindings = async (results: CheckResult[], failureType: string) => {
        const created = await (evidence.createFindings as (r: CheckResult[], o: unknown) => Promise<Finding[]>)(results, {
          scanSessionId: scanId, pageSnapshotId: snapshot.id, interactionStateId: null, platform: "webflow", failureType,
          fullPageScreenshot: null, boundingBox: null, db, fileStore,
        });
        created.forEach((f, i) => {
          try {
            f.analysis = analyzer.analyze(results[i]) as Finding["analysis"];
            f.confidence = confidence.scoreConfidence(f) as Finding["confidence"];
          } catch { /* stub analysis stays, as in the scanner */ }
        });
        findings.push(...created);
      };
      await toFindings(axeResults.violations, "axe_violation");
      await toFindings(axeResults.incomplete, "axe_incomplete");
      for (const cr of runs.filter((r) => r.criteria.some((c) => wanted.has(c)))) {
        const client = new EvalAnthropicClient({
          mode: options.client.mode, errors: engine.errors, engineLabel: engine.label, runId: options.runId,
          cache: options.client.cache, live: options.client.live, injector: options.client.injector, maxCostUsd: options.client.maxCostUsd, images: { allowed: new Set() },
        });
        const runner = buildEvalRunner(engine.promptModule, client, options.config.replay.llm_concurrency);
        try {
          await toFindings(await cr.run({ dom, title: t0.title, url, snapshot, runner, axeFlagged }), cr.failureType);
        } catch (err) {
          log(`[static] ${engine.label} ${cr.check} failed on fixture ${fx.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
        }
        model.requests += client.stats.requests;
        model.cache_misses += client.stats.cache_misses;
        model.entries_read += client.stats.entries_read;
        model.entries_created += client.stats.entries_created;
        model.cost_usd += client.stats.cost_usd;
        model.attempts_used.push(...client.stats.attempts_used);
        if (client.stats.cache_misses > 0) {
          const s = fixtureMisses.get(fx) ?? new Set<string>();
          s.add(cr.check);
          fixtureMisses.set(fx, s);
        }
      }
      predictions[fx] = buildPredictions("s01", findings, [snapshot], () => fx.slice(0, 12), CHECK_TIERS);
    }
    (db as { close(): void }).close();
  } finally {
    await browser?.close();
    await proxy.close();
    releaseFetch();
    releaseNode();
    rmSync(work, { recursive: true, force: true });
  }

  const outcomes: StaticCaseOutcome[] = file.cases.map((c) => {
    const base = { case_id: c.case_id, engine: engine.label, confirmed_detected: null, inclusive_detected: null, severity_ok: null, matched: [] };
    if (c.status !== "runnable" || !c.fixture_sha256) return { ...base, outcome: "not_run" as const, reason: c.status };
    if (c.applicability[engine.label] === "not_applicable") return { ...base, outcome: "not_run" as const, reason: "no check in this engine addresses the criterion" };
    const preds = (predictions[c.fixture_sha256] ?? []).filter((p) => matchesTarget(p, targets.get(c.case_id), c.criterion));
    const real = preds.filter((p) => !p.tooling_error);
    const confirmed = real.some((p) => p.confidence_tier !== "needs_review");
    const inclusive = real.length > 0;
    const misses = fixtureMisses.get(c.fixture_sha256);
    const crit = options.config.criteria.find((x) => x.id === c.criterion);
    const missed = misses && crit ? crit.checks.filter((ch) => misses.has(ch)) : [];
    const matched = preds.map((p) => ({ check: p.check, severity: p.severity, confidence: p.confidence_tier, failure_type: p.failure_type }));
    if (missed.length > 0 && !confirmed) return { ...base, matched, outcome: "unavailable" as const, reason: `model responses not recorded for ${missed.join(", ")} (static cache)`, confirmed_detected: confirmed, inclusive_detected: inclusive };
    if (preds.some((p) => p.tooling_error) && !confirmed) return { ...base, matched, outcome: "unavailable" as const, reason: "model evaluation failed for the target", confirmed_detected: confirmed, inclusive_detected: inclusive };
    const detected = confirmed;
    const pass = c.expected_outcome === "detected" ? detected : !detected;
    const severityOk = c.expected_severity && detected ? real.some((p) => p.severity === c.expected_severity && p.confidence_tier !== "needs_review") : null;
    return {
      ...base, matched, confirmed_detected: confirmed, inclusive_detected: inclusive, severity_ok: severityOk,
      outcome: pass && severityOk !== false ? "pass" as const : "fail" as const,
      reason: pass ? (severityOk === false ? `detected but severity is not ${c.expected_severity}` : "matches the expected outcome") : c.expected_outcome === "detected" ? "expected violation not detected" : "flagged although expected clean",
    };
  });

  const synthetic = options.includeSynthetic ? { sl001: await syntheticHiddenRecaptcha(engine, log), sl016: await syntheticFalsePass(options.paths, options.config, engine, log) } : null;
  return { engine: engine.label, outcomes, predictions, model, egress: egress.count(), static_resources_refused: refused, synthetic };
}

// ---------------------------------------------------------------------------
// Synthetic scan-level fixtures
// ---------------------------------------------------------------------------

/** SL-001: form testing must not stall or fail on a hidden reCAPTCHA response field. */
async function syntheticHiddenRecaptcha(engine: EngineHandle, log: (m: string) => void): Promise<SyntheticOutcome> {
  const discovery = await engine.importModule<Mod>("checks/forms/discovery");
  const submission = await engine.importModule<Mod>("checks/forms/submission");
  const html = `<!doctype html><html lang="en"><body><form id="f" action="/x" method="post"><label for="n">Name</label><input id="n" name="name" required>
    <textarea id="g-recaptcha-response" name="g-recaptcha-response" class="g-recaptcha-response" style="display:none" required></textarea>
    <button type="submit">Send</button></form><script>document.getElementById('f').addEventListener('submit',function(e){e.preventDefault();if(!document.getElementById('n').value){var d=document.createElement('div');d.setAttribute('role','alert');d.textContent='Name is required';document.body.appendChild(d);}});</script></body></html>`;
  const server = http.createServer((_q, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(html); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((fn) => fn);" });
    const page = await ctx.newPage();
    page.setDefaultTimeout(5_000);
    await page.goto(url);
    const forms = discovery.discoverForms({ id: "s", scan_session_id: "s", url, title: "", captured_at: "", full_dom: await page.content(), screenshot: "", viewport: { width: 1280, height: 800, deviceScaleFactor: 1 } }) as unknown[];
    const t0 = Date.now();
    const out = await (submission.testFormSubmission as (p: unknown, f: unknown) => Promise<{ states: unknown[] }>)(page, forms[0]);
    const ms = Date.now() - t0;
    const ok = out.states.length > 0 && ms < 15_000;
    log(`[static] ${engine.label} SL-001: ${out.states.length} state(s) in ${ms} ms`);
    return { outcome: ok ? "pass" : "fail", detail: `${out.states.length} submission state(s) in ${ms} ms` };
  } catch (err) {
    return { outcome: "fail", detail: `form testing failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  } finally {
    await browser.close();
    server.close();
  }
}

/**
 * SL-016: with every model call failing, and with model-based checks failing
 * outright, no criterion those checks address may be reported as passed.
 * Runs the engine's scanner on the pilot fixture's clean pages (default
 * browser path, local server). Violations are reported, not fixed.
 */
async function syntheticFalsePass(paths: EvalPaths, config: EvalConfig, engine: EngineHandle, log: (m: string) => void): Promise<SyntheticOutcome> {
  const fixture = await startFixtureServer(join(paths.repo, "test", "fixtures", "eval-pilot"));
  const origin = `http://127.0.0.1:${fixture.port}`;
  const urls = [`${origin}/`, `${origin}/contact`, `${origin}/about`];
  const work = mkdtempSync(join(tmpdir(), "eval-sl016-"));
  const details: string[] = [];
  let worst: SyntheticOutcome["outcome"] = "pass";
  try {
    const variants: Array<{ name: string; runner: unknown }> = [
      { name: "all model calls fail (HTTP 400)", runner: buildEvalRunner(engine.promptModule, new EvalAnthropicClient({ mode: "inject", errors: engine.errors, engineLabel: engine.label, runId: "sl016", injector: () => ({ error: { status: 400, message: "credit balance too low (synthetic)" } }) }), 5) },
      { name: "model-based checks throw", runner: new Proxy({}, { get: () => () => { throw new Error("synthetic check failure"); } }) },
      { name: "control: deterministic responses", runner: buildEvalRunner(engine.promptModule, new EvalAnthropicClient({ mode: "inject", errors: engine.errors, engineLabel: engine.label, runId: "sl016", injector: deterministicInjector }), 5) },
    ];
    for (const [i, v] of variants.entries()) {
      const result = await engine.run({
        rootUrl: urls[0], pageUrls: urls, dataDir: join(work, `v${i}`), runner: v.runner, tiers: [1, 2, 3, 4, 5],
        pageConcurrency: 1, llmConcurrency: 5, viewport: config.replay.viewport,
      });
      const pageId = (u: string) => ({ [urls[0]]: "p001", [urls[1]]: "p002", [urls[2]]: "p003" } as Record<string, string>)[u] ?? u;
      const preds = buildPredictions("x01", result.findings, result.pageSnapshots, pageId, CHECK_TIERS);
      const run: RunInputs = {
        manifest: { run_id: "synthetic", corpus: { version: "synthetic", split: "pilot" } } as unknown as RunManifest,
        runDir: work,
        sites: [{ site: "x01", predictions: preds, coverage: coverageRows(result.coverage, pageId), criteria: criterionStatuses(result.criterionResults), pages: ["p001", "p002", "p003"] }],
      };
      const fp = falsePasses(config, run, []).filter((f) => f.rule !== "pass_without_checks");
      const modelCriteria = new Set(["1.1.1", "2.4.4", "2.4.6", "4.1.2", "3.2.3", "1.3.5", "3.3.4", "3.3.1", "3.3.3"]);
      let relevant = i < 2 ? fp.filter((f) => modelCriteria.has(f.criterion)) : [];
      if (i === 1) {
        // Every model-based check threw by construction, so a pass on a
        // criterion one of them addresses is a false pass whether or not the
        // engine records coverage.
        const modelChecks = new Set(["alt-text", "link-text", "headings", "widget-aria", "consistent-nav", "input-purpose", "high-risk-forms", "error-messages"]);
        const passedNow = criterionStatuses(result.criterionResults).filter((c) => c.status === "passed").map((c) => c.criterion);
        const direct = passedNow.filter((c) => config.criteria.find((x) => x.id === c)?.checks.some((ch) => modelChecks.has(ch)))
          .map((criterion) => ({ rule: "pass_with_unestablished_checks" as const, site: "x01", criterion, detail: "a model-based check addressing it threw" }));
        const seen = new Set(relevant.map((f) => f.criterion));
        relevant = [...relevant, ...direct.filter((d) => !seen.has(d.criterion))];
      }
      const summary = `${v.name}: ${relevant.length} false pass(es)${relevant.length ? ` (${Array.from(new Set(relevant.map((f) => `${f.criterion} ${f.rule}`))).join(", ")})` : ""}`;
      details.push(summary);
      log(`[static] ${engine.label} SL-016 ${summary}`);
      if (relevant.length > 0) worst = "fail";
    }
    return { outcome: worst, detail: details.join("; ") };
  } catch (err) {
    return { outcome: "unavailable", detail: `synthetic run failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  } finally {
    await fixture.close();
    rmSync(work, { recursive: true, force: true });
  }
}

/** Compare two static runs of one engine (the record-once, replay-twice rule). */
export function staticRunsMatch(a: StaticRunResult, b: StaticRunResult): { identical: boolean; differences: string[] } {
  const differences: string[] = [];
  const key = (o: StaticCaseOutcome) => canonicalJson({ outcome: o.outcome, c: o.confirmed_detected, i: o.inclusive_detected, s: o.severity_ok, m: o.matched });
  for (const o of a.outcomes) {
    const other = b.outcomes.find((x) => x.case_id === o.case_id);
    if (!other || key(other) !== key(o)) differences.push(o.case_id);
  }
  for (const fx of Object.keys(a.predictions)) {
    const ka = a.predictions[fx].map((p) => p.prediction_key).sort().join(",");
    const kb = (b.predictions[fx] ?? []).map((p) => p.prediction_key).sort().join(",");
    if (ka !== kb) differences.push(`fixture ${fx.slice(0, 8)}`);
  }
  return { identical: differences.length === 0, differences };
}
