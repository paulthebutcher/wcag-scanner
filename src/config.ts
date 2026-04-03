import { config as dotenvConfig } from "dotenv";
import type { PromptMode } from "./types.js";

export interface Config {
  anthropicApiKey: string;
  dataDir: string;
  maxPages: number;
  concurrency: number;
  promptMode: PromptMode;
}

const VALID_PROMPT_MODES: readonly string[] = ["realtime", "batch"];

function parsePositiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got "${value}".`);
  }
  return n;
}

/**
 * Load configuration with the following precedence (highest → lowest):
 *   1. CLI flag overrides (passed as `overrides`)
 *   2. Environment variables (including those loaded from .env)
 *   3. Built-in defaults
 */
export function loadConfig(overrides?: Partial<Config>): Config {
  // Load .env file into process.env (override existing vars — avoids issues
  // when the shell exports an empty ANTHROPIC_API_KEY)
  dotenvConfig({ override: true });

  // --- anthropicApiKey (required) ---
  const apiKey = overrides?.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is required. Set it in .env or pass --api-key.",
    );
  }

  // --- dataDir ---
  const dataDir =
    overrides?.dataDir ?? process.env.WCAG_DATA_DIR ?? "./wcag-data";

  // --- maxPages ---
  let maxPages: number;
  if (overrides?.maxPages !== undefined) {
    maxPages = overrides.maxPages;
  } else if (process.env.WCAG_MAX_PAGES !== undefined) {
    maxPages = parsePositiveInt(process.env.WCAG_MAX_PAGES, "WCAG_MAX_PAGES");
  } else {
    maxPages = 50;
  }
  if (!Number.isInteger(maxPages) || maxPages <= 0) {
    throw new Error(
      `maxPages must be a positive integer, got "${String(maxPages)}".`,
    );
  }

  // --- concurrency ---
  let concurrency: number;
  if (overrides?.concurrency !== undefined) {
    concurrency = overrides.concurrency;
  } else if (process.env.WCAG_CONCURRENCY !== undefined) {
    concurrency = parsePositiveInt(
      process.env.WCAG_CONCURRENCY,
      "WCAG_CONCURRENCY",
    );
  } else {
    concurrency = 5;
  }
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error(
      `concurrency must be a positive integer, got "${String(concurrency)}".`,
    );
  }

  // --- promptMode ---
  let promptMode: PromptMode;
  if (overrides?.promptMode !== undefined) {
    promptMode = overrides.promptMode;
  } else if (process.env.WCAG_PROMPT_MODE !== undefined) {
    const raw = process.env.WCAG_PROMPT_MODE;
    if (!VALID_PROMPT_MODES.includes(raw)) {
      throw new Error(
        `WCAG_PROMPT_MODE must be "realtime" or "batch", got "${raw}".`,
      );
    }
    promptMode = raw as PromptMode;
  } else {
    promptMode = "realtime";
  }

  return { anthropicApiKey: apiKey, dataDir, maxPages, concurrency, promptMode };
}
