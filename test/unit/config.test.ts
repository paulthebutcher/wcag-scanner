import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Keep the developer's local .env out of these tests.
vi.mock("dotenv", () => ({ config: () => ({}) }));

import { loadConfig } from "../../src/config.js";

/**
 * Helper: snapshot and restore the env vars we touch so tests don't leak.
 */
const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "WCAG_DATA_DIR",
  "WCAG_MAX_PAGES",
  "WCAG_CONCURRENCY",
  "WCAG_PROMPT_MODE",
] as const;

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe("loadConfig", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
    }
    clearEnv();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  });

  // -----------------------------------------------------------------------
  // Defaults
  // -----------------------------------------------------------------------
  describe("defaults", () => {
    it("returns correct defaults when only API key is provided", () => {
      const cfg = loadConfig({ anthropicApiKey: "sk-test" });
      expect(cfg).toEqual({
        anthropicApiKey: "sk-test",
        dataDir: "./wcag-data",
        maxPages: 50,
        concurrency: 5,
        promptMode: "realtime",
      });
    });
  });

  // -----------------------------------------------------------------------
  // Environment variable overrides
  // -----------------------------------------------------------------------
  describe("env var overrides", () => {
    it("reads ANTHROPIC_API_KEY from env", () => {
      process.env.ANTHROPIC_API_KEY = "sk-env";
      const cfg = loadConfig();
      expect(cfg.anthropicApiKey).toBe("sk-env");
    });

    it("reads WCAG_DATA_DIR from env", () => {
      process.env.ANTHROPIC_API_KEY = "sk-test";
      process.env.WCAG_DATA_DIR = "/custom/dir";
      const cfg = loadConfig();
      expect(cfg.dataDir).toBe("/custom/dir");
    });

    it("reads WCAG_MAX_PAGES from env", () => {
      process.env.ANTHROPIC_API_KEY = "sk-test";
      process.env.WCAG_MAX_PAGES = "100";
      const cfg = loadConfig();
      expect(cfg.maxPages).toBe(100);
    });

    it("reads WCAG_CONCURRENCY from env", () => {
      process.env.ANTHROPIC_API_KEY = "sk-test";
      process.env.WCAG_CONCURRENCY = "10";
      const cfg = loadConfig();
      expect(cfg.concurrency).toBe(10);
    });

    it("reads WCAG_PROMPT_MODE from env", () => {
      process.env.ANTHROPIC_API_KEY = "sk-test";
      process.env.WCAG_PROMPT_MODE = "batch";
      const cfg = loadConfig();
      expect(cfg.promptMode).toBe("batch");
    });
  });

  // -----------------------------------------------------------------------
  // CLI overrides take precedence over env
  // -----------------------------------------------------------------------
  describe("CLI override precedence", () => {
    it("overrides env with CLI flags", () => {
      process.env.ANTHROPIC_API_KEY = "sk-env";
      process.env.WCAG_DATA_DIR = "/env/dir";
      process.env.WCAG_MAX_PAGES = "100";
      process.env.WCAG_CONCURRENCY = "10";
      process.env.WCAG_PROMPT_MODE = "batch";

      const cfg = loadConfig({
        anthropicApiKey: "sk-cli",
        dataDir: "/cli/dir",
        maxPages: 25,
        concurrency: 3,
        promptMode: "realtime",
      });

      expect(cfg).toEqual({
        anthropicApiKey: "sk-cli",
        dataDir: "/cli/dir",
        maxPages: 25,
        concurrency: 3,
        promptMode: "realtime",
      });
    });
  });

  // -----------------------------------------------------------------------
  // Validation errors
  // -----------------------------------------------------------------------
  describe("validation errors", () => {
    it("throws when ANTHROPIC_API_KEY is missing", () => {
      expect(() => loadConfig()).toThrow("ANTHROPIC_API_KEY is required");
    });

    it("throws when WCAG_MAX_PAGES is not a positive integer", () => {
      process.env.ANTHROPIC_API_KEY = "sk-test";
      process.env.WCAG_MAX_PAGES = "0";
      expect(() => loadConfig()).toThrow("WCAG_MAX_PAGES must be a positive integer");
    });

    it("throws when WCAG_MAX_PAGES is negative", () => {
      process.env.ANTHROPIC_API_KEY = "sk-test";
      process.env.WCAG_MAX_PAGES = "-5";
      expect(() => loadConfig()).toThrow("WCAG_MAX_PAGES must be a positive integer");
    });

    it("throws when WCAG_MAX_PAGES is not a number", () => {
      process.env.ANTHROPIC_API_KEY = "sk-test";
      process.env.WCAG_MAX_PAGES = "abc";
      expect(() => loadConfig()).toThrow("WCAG_MAX_PAGES must be a positive integer");
    });

    it("throws when WCAG_MAX_PAGES is a float", () => {
      process.env.ANTHROPIC_API_KEY = "sk-test";
      process.env.WCAG_MAX_PAGES = "3.5";
      expect(() => loadConfig()).toThrow("WCAG_MAX_PAGES must be a positive integer");
    });

    it("throws when WCAG_CONCURRENCY is not a positive integer", () => {
      process.env.ANTHROPIC_API_KEY = "sk-test";
      process.env.WCAG_CONCURRENCY = "0";
      expect(() => loadConfig()).toThrow("WCAG_CONCURRENCY must be a positive integer");
    });

    it("throws when WCAG_CONCURRENCY is not a number", () => {
      process.env.ANTHROPIC_API_KEY = "sk-test";
      process.env.WCAG_CONCURRENCY = "xyz";
      expect(() => loadConfig()).toThrow("WCAG_CONCURRENCY must be a positive integer");
    });

    it("throws when WCAG_PROMPT_MODE is invalid", () => {
      process.env.ANTHROPIC_API_KEY = "sk-test";
      process.env.WCAG_PROMPT_MODE = "turbo";
      expect(() => loadConfig()).toThrow(
        'WCAG_PROMPT_MODE must be "realtime" or "batch"',
      );
    });

    it("validates maxPages passed via overrides", () => {
      expect(() =>
        loadConfig({ anthropicApiKey: "sk-test", maxPages: -1 }),
      ).toThrow("maxPages must be a positive integer");
    });

    it("validates concurrency passed via overrides", () => {
      expect(() =>
        loadConfig({ anthropicApiKey: "sk-test", concurrency: 0 }),
      ).toThrow("concurrency must be a positive integer");
    });
  });
});
