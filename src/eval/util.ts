import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Hashing and canonical JSON
// ---------------------------------------------------------------------------

export { sha256, canonicalJson } from "../core/request-key.js";

export function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

import { sha256, canonicalJson } from "../core/request-key.js";

export function hashJson(value: unknown): string {
  return sha256(canonicalJson(value));
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Write JSON atomically (temp file + rename) so readers never see half a file. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/** Write a file that must never be overwritten (immutable evidence). */
export function writeOnce(path: string, data: string | Buffer): void {
  if (existsSync(path)) {
    const existing = readFileSync(path);
    const incoming = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    if (existing.equals(incoming)) return;
    throw new Error(`Refusing to overwrite immutable file ${path}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, i) => {
      try {
        return JSON.parse(line) as T;
      } catch (err) {
        throw new Error(`${path}:${i + 1}: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
      }
    });
}

// ---------------------------------------------------------------------------
// Ids and time
// ---------------------------------------------------------------------------

export function utcNow(): string {
  return new Date().toISOString();
}

/** Run id: `<command>-<UTC yyyymmddThhmmssZ>-<6 hex>`, sortable by time. */
export function newRunId(command: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${command}-${stamp}-${randomBytes(3).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Repository state
// ---------------------------------------------------------------------------

/** Paths whose uncommitted changes can affect what an eval run executes. */
const EXECUTION_PATHS = ["src/", "test/", "eval/", "scripts/", "package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts"];
/** Committed export outputs: a new, untracked export never makes the tree dirty. */
const OUTPUT_PATHS = ["eval/runs/", "eval/baselines/"];

export function dirtyingPath(status: string, path: string): boolean {
  if (status !== "??") return true;
  if (OUTPUT_PATHS.some((p) => path.startsWith(p))) return false;
  return EXECUTION_PATHS.some((p) => path === p || path.startsWith(p));
}

export interface RepoState {
  sha: string;
  dirty: boolean;
  /** Every uncommitted path, including ones that do not make the tree dirty */
  changed_paths: string[];
}

export function repoRoot(cwd = process.cwd()): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
}

export function gitSha(rev = "HEAD", cwd = process.cwd()): string {
  return execFileSync("git", ["rev-parse", `${rev}^{commit}`], { cwd, encoding: "utf8" }).trim();
}

/**
 * Commit SHA and dirty state. Tracked changes always make the tree dirty;
 * untracked files only when they sit in a path that affects execution (an
 * untracked note under docs/, or a new export under eval/runs/, cannot
 * change a run's results).
 */
export function repoState(cwd = process.cwd()): RepoState {
  const sha = gitSha("HEAD", cwd);
  const porcelain = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, encoding: "utf8" });
  const changed: string[] = [];
  let dirty = false;
  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    const path = line.slice(3);
    changed.push(path);
    if (dirtyingPath(status, path)) dirty = true;
  }
  return { sha, dirty, changed_paths: changed.sort() };
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export function joinAll(base: string, ...parts: string[]): string {
  return join(base, ...parts);
}
