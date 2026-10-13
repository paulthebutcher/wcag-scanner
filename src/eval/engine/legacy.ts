import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser } from "playwright";
import Anthropic from "@anthropic-ai/sdk";
import { detectCMSCollections, normalizeUrl } from "../../core/crawler.js";
import { hashTree } from "../corpus.js";
import { canonicalJson, sha256, sha256File } from "../util.js";
import type { EvalPaths } from "../paths.js";
import type { BridgeInfo } from "../manifest.js";
import type { SyntheticResponse } from "../transport/node-fetch.js";
import { fetchKey } from "../transport/node-fetch.js";
import { CollectingReporter, type EngineHandle, type EngineRunOptions } from "./types.js";

// ---------------------------------------------------------------------------
// Baseline bridge (D0). Older engines run from a git worktree under
// wcag-data/eval-worktrees, sharing node_modules (so `playwright` and the
// Anthropic SDK are the same module instances as the harness's), built with
// the repository's tsc.
//
// Adapter (no source change):
//   - chromium.launch is answered with the controlled browser while the
//     engine runs (the baseline crawler launches its own browser);
//   - an engine without a page-list option gets a synthetic sitemap listing
//     exactly the frozen pages, in an order its CMS grouping preserves, with
//     maxPages and cmsSamples set to the page count;
//   - the eval runner is injected through the existing promptRunner option.
// Patch (eval/baseline-bridge/<sha7>.patch, transport only): the same
// submission-state image hook HEAD has. The manifest records the original
// SHA, the patch hash and the effective source hash.
// ---------------------------------------------------------------------------

export const BASELINE_SHA = "ffdcd308610527525fb82ccd118a7f7b89334b66";

/** The 26 check ids, present at the baseline under the same names (verified in its scanner). */
const ALL_CHECKS = [
  "axe-core", "keyboard", "focus-visible", "focus-order", "keyboard-trap", "skip-nav", "modal",
  "alt-text", "link-text", "headings", "landmark-labels", "widget-aria", "table-structure", "duplicate-links", "consistent-nav",
  "form-discovery", "high-risk-forms", "form-submission", "error-messages", "input-purpose", "on-input", "error-quality",
  "pause-stop-hide", "three-flashes", "multiple-ways", "motion-actuation",
];

export interface LegacyEngineOptions {
  paths: EvalPaths;
  sha: string;
  label: string;
  /** Patch to apply (null: run the pristine source, e.g. the pre-harness reference) */
  patchPath: string | null;
  /** Whether the engine accepts a page list (HEAD-era) or needs the sitemap adapter */
  supportsUrlList: boolean;
  log?: (message: string) => void;
}

interface BuiltWorktree {
  dir: string;
  bridge: BridgeInfo;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Hash of the adapter code itself (this module's source in the repository). */
export function adapterHash(paths: EvalPaths): string {
  const src = join(paths.repo, "src", "eval", "engine", "legacy.ts");
  return existsSync(src) ? sha256File(src) : sha256("adapter-source-unavailable");
}

export function prepareWorktree(options: LegacyEngineOptions): BuiltWorktree {
  const { paths, sha, label } = options;
  const log = options.log ?? (() => {});
  const resolved = git(["rev-parse", `${sha}^{commit}`], paths.repo).trim();
  if (resolved !== sha) throw new Error(`Engine ${label}: ${sha} resolves to ${resolved}`);
  const dir = join(paths.worktreesDir, `${label}-${sha.slice(0, 12)}`);
  if (!existsSync(dir)) {
    log(`[bridge] creating worktree for ${label} at ${sha.slice(0, 12)}`);
    git(["worktree", "add", "--detach", dir, sha], paths.repo);
  }
  const head = git(["rev-parse", "HEAD"], dir).trim();
  if (head !== sha) throw new Error(`Worktree ${dir} is at ${head}, expected ${sha}`);

  const patch = options.patchPath ? readFileSync(options.patchPath, "utf8") : "";
  const patchSha = options.patchPath ? sha256(patch) : null;
  // Bring the worktree to exactly pristine + patch
  const currentDiff = git(["diff", "--binary"], dir);
  if (currentDiff !== patch) {
    git(["checkout", "--", "."], dir);
    if (patch) {
      execFileSync("git", ["apply", "--whitespace=nowarn", options.patchPath!], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    }
    if (git(["diff", "--binary"], dir) !== patch) throw new Error(`Worktree ${dir} does not match its patch after applying it`);
  }
  const untracked = git(["status", "--porcelain", "--untracked-files=all"], dir)
    .split("\n").filter((l) => l.startsWith("??") && !/^\?\? (dist|node_modules)/.test(l));
  if (untracked.length > 0) throw new Error(`Worktree ${dir} has unexpected untracked files: ${untracked.slice(0, 3).join(", ")}`);

  const nm = join(dir, "node_modules");
  if (!existsSync(nm)) symlinkSync(join(paths.repo, "node_modules"), nm, "dir");
  else if (!lstatSync(nm).isSymbolicLink()) throw new Error(`${nm} must be a symlink to the repository's node_modules`);

  const effective = sha256(canonicalJson(hashTree(join(dir, "src"))));
  const marker = join(dir, "dist", ".eval-build.json");
  const built = existsSync(marker) ? (JSON.parse(readFileSync(marker, "utf8")) as { effective_source_sha256?: string }) : {};
  if (built.effective_source_sha256 !== effective) {
    log(`[bridge] building ${label} (${sha.slice(0, 12)})`);
    execFileSync(process.execPath, [join(paths.repo, "node_modules", "typescript", "bin", "tsc"), "-p", join(dir, "tsconfig.json")], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    writeFileSync(marker, JSON.stringify({ effective_source_sha256: effective, built_at: new Date().toISOString() }, null, 2));
  }
  return {
    dir,
    bridge: { original_sha: sha, patch_sha256: patchSha, adapter_sha256: adapterHash(paths), effective_source_sha256: effective },
  };
}

/**
 * Page order an engine with sitemap-driven discovery reproduces exactly:
 * the root first, then pages outside any CMS-style prefix group, then each
 * group (two or more two-segment URLs under one prefix) in first-seen order.
 */
export function baselineCompatibleOrder(urls: string[], rootUrl: string): string[] {
  const root = normalizeUrl(rootUrl, rootUrl) ?? rootUrl;
  const rest = urls.filter((u) => u !== root);
  const queue = [root, ...rest];
  const collections = detectCMSCollections(queue, null);
  const inCollection = new Set(collections.flatMap((c) => c.urls));
  return [...queue.filter((u) => !inCollection.has(u)), ...collections.flatMap((c) => c.urls)];
}

function sitemapXml(urls: string[]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join("\n")}\n</urlset>\n`;
}

let launchLock: Promise<void> = Promise.resolve();

/** Answer chromium.launch with `browser` while `fn` runs (engines that launch their own). */
export async function withLaunchInterception<T>(browser: Browser, fn: () => Promise<T>): Promise<T> {
  const prior = launchLock;
  let release!: () => void;
  launchLock = new Promise((r) => { release = r; });
  await prior;
  const original = chromium.launch;
  (chromium as { launch: unknown }).launch = async () => browser;
  try {
    return await fn();
  } finally {
    (chromium as { launch: unknown }).launch = original;
    release();
  }
}

export async function legacyEngine(options: LegacyEngineOptions): Promise<EngineHandle> {
  const { dir, bridge } = prepareWorktree(options);
  const dist = join(dir, "dist");
  const scanner = await import(pathToFileURL(join(dist, "core", "scanner.js")).href) as { scan: (opts: Record<string, unknown>, browser?: Browser) => Promise<Record<string, unknown>> };
  const promptModule = await import(pathToFileURL(join(dist, "core", "prompt-runner.js")).href) as { createPromptRunner: (key: string, o?: { concurrency?: number }) => unknown };
  return {
    label: options.label,
    sha: options.sha,
    bridge,
    promptModule,
    errors: Anthropic,
    checks: ALL_CHECKS,
    supportsUrlList: options.supportsUrlList,
    syntheticFetches: (rootUrl, pageUrls) => {
      const map = new Map<string, SyntheticResponse>();
      if (options.supportsUrlList) return map;
      const origin = new URL(rootUrl).origin;
      const body = sitemapXml(pageUrls);
      map.set(fetchKey("GET", `${origin}/sitemap.xml`), { status: 200, contentType: "application/xml", body, reason: "bridge: frozen page list as sitemap" });
      return map;
    },
    run: async (run: EngineRunOptions) => {
      const reporter = new CollectingReporter();
      const scanOptions: Record<string, unknown> = {
        url: run.rootUrl,
        dataDir: run.dataDir,
        tiers: run.tiers,
        viewport: run.viewport,
        concurrency: run.llmConcurrency,
        promptRunner: run.runner,
        includeNoindex: false,
        reporter,
      };
      if (options.supportsUrlList) {
        Object.assign(scanOptions, { urls: run.pageUrls, pageConcurrency: run.pageConcurrency });
      } else {
        Object.assign(scanOptions, { maxPages: run.pageUrls.length, cmsSamples: run.pageUrls.length });
      }
      if (run.submissionStates) {
        if (!options.patchPath) throw new Error(`Engine ${options.label} has no eval hooks (unpatched)`);
        scanOptions.evalHooks = { submissionStates: run.submissionStates };
      }
      const exec = () => scanner.scan(scanOptions, run.browser);
      const result = run.browser ? await withLaunchInterception(run.browser, exec) : await exec();
      const session = result.scanSession as { id: string };
      return {
        scanId: session.id,
        findings: result.findings as EngineHandleResult["findings"],
        criterionResults: result.criterionResults as EngineHandleResult["criterionResults"],
        coverage: (result.coverage as EngineHandleResult["coverage"]) ?? null,
        pageSnapshots: result.pageSnapshots as EngineHandleResult["pageSnapshots"],
        warnings: reporter.warnings,
      };
    },
  };
}

type EngineHandleResult = Awaited<ReturnType<EngineHandle["run"]>>;
