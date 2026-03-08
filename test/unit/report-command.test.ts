import { describe, it, expect } from "vitest";
import { createReportCommand } from "../../src/cli/commands/report.js";

// ---------------------------------------------------------------------------
// createReportCommand structure tests
// ---------------------------------------------------------------------------

describe("createReportCommand", () => {
  const cmd = createReportCommand();

  it("has name 'report'", () => {
    expect(cmd.name()).toBe("report");
  });

  it("has a description", () => {
    expect(cmd.description()).toContain("report");
  });

  it("accepts a scan-id argument", () => {
    const args = cmd.registeredArguments;
    expect(args.length).toBe(1);
    expect(args[0].name()).toBe("scan-id");
    expect(args[0].required).toBe(true);
  });

  it("has --compare option", () => {
    const opt = cmd.options.find((o) => o.long === "--compare");
    expect(opt).toBeDefined();
    expect(opt!.description).toContain("Compare");
  });

  it("has --severity option", () => {
    const opt = cmd.options.find((o) => o.long === "--severity");
    expect(opt).toBeDefined();
  });

  it("has --output option", () => {
    const opt = cmd.options.find((o) => o.long === "--output");
    expect(opt).toBeDefined();
  });

  it("has --format option with default pdf", () => {
    const opt = cmd.options.find((o) => o.long === "--format");
    expect(opt).toBeDefined();
    expect(opt!.defaultValue).toBe("pdf");
  });

  it("has --data-dir option with default ./wcag-data", () => {
    const opt = cmd.options.find((o) => o.long === "--data-dir");
    expect(opt).toBeDefined();
    expect(opt!.defaultValue).toBe("./wcag-data");
  });

  it("has --quiet option", () => {
    const opt = cmd.options.find((o) => o.long === "--quiet");
    expect(opt).toBeDefined();
  });
});
