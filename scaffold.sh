#!/usr/bin/env bash
# WCAG Engine — Project Scaffolding
# Run this once to create the full directory structure.
# Usage: bash scaffold.sh

set -e

echo "🛡️  WCAG Engine — Creating project structure..."

# Root config files
cat > package.json << 'EOF'
{
  "name": "wcag-engine",
  "version": "0.1.0",
  "type": "module",
  "description": "AI-powered WCAG AA compliance engine with platform-specific remediation",
  "bin": {
    "wcag": "./dist/cli/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/cli/index.ts",
    "test": "vitest",
    "test:run": "vitest run",
    "lint": "eslint src/",
    "typecheck": "tsc --noEmit"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "@axe-core/playwright": "^4.10.0",
    "better-sqlite3": "^11.0.0",
    "commander": "^12.0.0",
    "playwright": "^1.48.0",
    "sharp": "^0.33.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "eslint": "^9.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.0.0"
  }
}
EOF

cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "test"]
}
EOF

cat > .env.example << 'EOF'
ANTHROPIC_API_KEY=sk-ant-...
WCAG_DATA_DIR=./wcag-data
WCAG_MAX_PAGES=50
WCAG_CONCURRENCY=5
WCAG_PROMPT_MODE=realtime
EOF

cat > .gitignore << 'EOF'
node_modules/
dist/
wcag-data/
.env
*.tgz
coverage/
.DS_Store
EOF

cat > vitest.config.ts << 'EOF'
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});
EOF

# Source directories
mkdir -p src/core
mkdir -p src/checks/automated
mkdir -p src/checks/behavioral
mkdir -p src/checks/semantic
mkdir -p src/checks/forms
mkdir -p src/checks/indicators
mkdir -p src/adapters
mkdir -p src/store
mkdir -p src/prompts
mkdir -p src/report/templates
mkdir -p src/cli/commands
mkdir -p src/server

# Test directories
mkdir -p test/fixtures
mkdir -p test/unit
mkdir -p test/integration

# Create placeholder modules with exports

# --- Types ---
cat > src/types.ts << 'EOF'
// Generated from Data Model spec — see CLAUDE.md for full field reference
// TODO: C1-03 — populate all entity interfaces

export type Platform = "webflow" | "squarespace" | "shopify" | "wordpress" | "framer" | "unknown";
export type Severity = "critical" | "major" | "minor" | "advisory";
export type ConfidenceTier = "definitive" | "high" | "moderate" | "needs_review";
export type DetectedBy = "axe_core" | "playwright" | "claude_api" | "manual";
export type AnalysisMethod = "rule_based" | "llm_semantic" | "llm_visual" | "human";
export type Verdict = "confirmed" | "false_positive" | "downgraded" | "escalated";
export type ScanType = "initial" | "rescan" | "monitoring";
export type CriterionStatus = "passed" | "failed" | "not_applicable" | "not_tested";
export type WcagLevel = "A" | "AA" | "AAA";
export type Category = "contrast" | "semantics" | "keyboard" | "forms" | "images" | "aria" | "structure";
export type Effort = "trivial" | "minor" | "moderate" | "significant";
export type FalsePositiveRisk = "low" | "medium" | "high";
export type GeneratedBy = "template" | "llm" | "human";
export type PromptMode = "realtime" | "batch";

export interface CheckResult {
  element_selector: string;
  element_html: string;
  wcag_criterion: string;
  detected_by: DetectedBy;
  raw_result: unknown;
  screenshot?: Buffer;
  context_screenshot?: Buffer;
  measured_values?: Record<string, unknown>;
  keyboard_sequence?: unknown[];
  aria_attributes?: Record<string, string>;
}

export interface PlatformAdapter {
  detect(dom: string): boolean;
  getRemediationSteps(finding: Finding): PlatformFix;
  getPlatformInfo(): PlatformInfo;
  getPlatformContext(): string;
  getCMSPattern(): RegExp | null;
}

export interface PlatformInfo {
  platform: Platform;
  version: string | null;
  detected_via: string;
}

export interface PromptRunnerConfig {
  mode: PromptMode;
  max_retries: number;
  concurrency: number;
  fallback_on_failure: "needs_review" | "skip";
}

// TODO: Full entity interfaces (ScanSession, PageSnapshot, etc.) — C1-03
export interface ScanSession { id: string; }
export interface PageSnapshot { id: string; }
export interface InteractionState { id: string; }
export interface Finding { id: string; }
export interface Evidence {}
export interface Analysis {}
export interface Confidence {}
export interface Remediation {}
export interface PlatformFix { platform: Platform; }
export interface HumanReview {}
export interface ScanSummary {}
export interface CriterionResult {}
EOF

# --- Config ---
cat > src/config.ts << 'EOF'
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
EOF

# --- Core stubs ---
cat > src/core/crawler.ts << 'EOF'
// TODO: C1-07, C1-08, C1-09
export {};
EOF

cat > src/core/scanner.ts << 'EOF'
// TODO: C2-15
export {};
EOF

cat > src/core/evidence.ts << 'EOF'
// TODO: C1-10
export {};
EOF

cat > src/core/analyzer.ts << 'EOF'
// TODO: C2-13
export {};
EOF

cat > src/core/confidence.ts << 'EOF'
// TODO: C2-14
export {};
EOF

cat > src/core/prompt-runner.ts << 'EOF'
// TODO: C2-07
export {};
EOF

# --- Check stubs ---
cat > src/checks/automated/index.ts << 'EOF'
// TODO: C1-12 — axe-core integration
export {};
EOF

cat > src/checks/behavioral/keyboard.ts << 'EOF'
// TODO: C2-01, C2-02
export {};
EOF

cat > src/checks/behavioral/focus-visible.ts << 'EOF'
// TODO: C2-03
export {};
EOF

cat > src/checks/behavioral/focus-order.ts << 'EOF'
// TODO: C2-04
export {};
EOF

cat > src/checks/semantic/alt-text.ts << 'EOF'
// TODO: C2-09
export {};
EOF

cat > src/checks/semantic/link-text.ts << 'EOF'
// TODO: C2-10
export {};
EOF

cat > src/checks/semantic/headings.ts << 'EOF'
// TODO: C2-11
export {};
EOF

cat > src/checks/semantic/consistent-nav.ts << 'EOF'
// TODO: C2-12
export {};
EOF

cat > src/checks/forms/discovery.ts << 'EOF'
// TODO: C3-01
export {};
EOF

cat > src/checks/forms/submission.ts << 'EOF'
// TODO: C3-02
export {};
EOF

cat > src/checks/forms/error-evaluation.ts << 'EOF'
// TODO: C3-03
export {};
EOF

cat > src/checks/indicators/index.ts << 'EOF'
// TODO: C3-05, C3-06, C3-07
export {};
EOF

# --- Adapter stubs ---
cat > src/adapters/types.ts << 'EOF'
// Re-export adapter interface from types
export type { PlatformAdapter, PlatformInfo, PlatformFix } from "../types.js";
EOF

cat > src/adapters/webflow.ts << 'EOF'
// TODO: C1-11
export {};
EOF

# --- Store stubs ---
cat > src/store/db.ts << 'EOF'
// TODO: C1-04
export {};
EOF

cat > src/store/files.ts << 'EOF'
// TODO: C1-05
export {};
EOF

# --- Prompt stubs ---
cat > src/prompts/element-evaluation.ts << 'EOF'
// TODO: C2-08 — Prompts 1-8
export {};
EOF

cat > src/prompts/form-interaction.ts << 'EOF'
// TODO: C2-08 — Prompts 9-11
export {};
EOF

cat > src/prompts/remediation.ts << 'EOF'
// TODO: C2-08 — Prompts 12-13
export {};
EOF

cat > src/prompts/synthesis.ts << 'EOF'
// TODO: C2-08 — Prompts 14-15
export {};
EOF

# --- Report stubs ---
cat > src/report/generator.ts << 'EOF'
// TODO: C3-08, C3-09, C3-10
export {};
EOF

# --- CLI ---
cat > src/cli/index.ts << 'EOF'
#!/usr/bin/env node
// TODO: C1-13 — wire up commander
import { Command } from "commander";

const program = new Command();

program
  .name("wcag")
  .description("AI-powered WCAG AA compliance engine")
  .version("0.1.0");

// TODO: add scan, report, review commands

program.parse();
EOF

cat > src/cli/commands/scan.ts << 'EOF'
// TODO: C1-13
export {};
EOF

cat > src/cli/commands/report.ts << 'EOF'
// TODO: C3-13
export {};
EOF

cat > src/cli/commands/review.ts << 'EOF'
// TODO: C3-14
export {};
EOF

# --- Test placeholder ---
cat > test/unit/types.test.ts << 'EOF'
import { describe, it, expect } from "vitest";

describe("types", () => {
  it("placeholder — types module exists", async () => {
    const types = await import("../../src/types.js");
    expect(types).toBeDefined();
  });
});
EOF

cat > test/fixtures/.gitkeep << 'EOF'
EOF

echo ""
echo "✓ Project structure created"
echo ""
echo "Next steps:"
echo "  1. npm install"
echo "  2. npm run build        # should compile with zero errors"
echo "  3. npm run test         # should run 1 placeholder test"
echo "  4. npm run lint         # should pass with zero warnings"
echo ""
echo "Then start C1-03 (TypeScript types) — CLAUDE.md has the full data model."
