#!/usr/bin/env node
import { config as dotenvConfig } from "dotenv";
// Treat empty-string env vars as unset so .env can fill them in (handles
// shells that export ANTHROPIC_API_KEY="").
for (const key of ["ANTHROPIC_API_KEY", "WCAG_DATA_DIR", "WCAG_MAX_PAGES", "WCAG_CONCURRENCY", "WCAG_PROMPT_MODE"]) {
  if (process.env[key] === "") delete process.env[key];
}
dotenvConfig();

import { Command } from "commander";
import { createScanCommand } from "./commands/scan.js";
import { createReportCommand } from "./commands/report.js";
import { createReviewCommand } from "./commands/review.js";

const program = new Command();

program
  .name("wcag")
  .description("AI-powered WCAG AA accessibility scanner")
  .version("0.1.0");

program.addCommand(createScanCommand());
program.addCommand(createReportCommand());
program.addCommand(createReviewCommand());

program.parse();
