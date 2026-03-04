// TODO: C1-06 — full config with .env loading and CLI flag overrides
import type { PromptMode } from "./types.js";

export interface Config {
  anthropicApiKey: string;
  dataDir: string;
  maxPages: number;
  concurrency: number;
  promptMode: PromptMode;
}

export function loadConfig(overrides?: Partial<Config>): Config {
  const apiKey = overrides?.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is required. Set it in .env or pass --api-key."
    );
  }

  return {
    anthropicApiKey: apiKey,
    dataDir: overrides?.dataDir ?? process.env.WCAG_DATA_DIR ?? "./wcag-data",
    maxPages: overrides?.maxPages ?? parseInt(process.env.WCAG_MAX_PAGES ?? "50"),
    concurrency: overrides?.concurrency ?? parseInt(process.env.WCAG_CONCURRENCY ?? "5"),
    promptMode: (overrides?.promptMode ?? process.env.WCAG_PROMPT_MODE ?? "realtime") as PromptMode,
  };
}
