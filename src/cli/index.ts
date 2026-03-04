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
