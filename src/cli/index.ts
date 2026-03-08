#!/usr/bin/env node
import { config as dotenvConfig } from "dotenv";
dotenvConfig();

import { Command } from "commander";
import { createScanCommand } from "./commands/scan.js";
import { createReportCommand } from "./commands/report.js";
import { createReviewCommand } from "./commands/review.js";

const program = new Command();

program
  .name("wcag")
  .description("AI-powered WCAG AA compliance engine")
  .version("0.1.0");

program.addCommand(createScanCommand());
program.addCommand(createReportCommand());
program.addCommand(createReviewCommand());

program.parse();
