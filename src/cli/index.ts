#!/usr/bin/env node
import { Command } from "commander";
import { createScanCommand } from "./commands/scan.js";

const program = new Command();

program
  .name("wcag")
  .description("AI-powered WCAG AA compliance engine")
  .version("0.1.0");

program.addCommand(createScanCommand());

// TODO: add report, review commands

program.parse();
