import { describe, it, expect, beforeEach } from "vitest";
import { Writable } from "node:stream";
import {
  ScanProgressReporter,
  QuietProgressReporter,
} from "../../src/core/progress.js";
import type { ProgressReporter } from "../../src/core/progress.js";

// ---------------------------------------------------------------------------
// Test helper: capture writes to a fake stream
// ---------------------------------------------------------------------------

class FakeWriteStream extends Writable {
  chunks: string[] = [];
  isTTY = false;

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    callback();
  }

  /** Convenience — join everything written so far */
  get output(): string {
    return this.chunks.join("");
  }
}

// Cast helper: ScanProgressReporter expects NodeJS.WriteStream
function asWriteStream(s: FakeWriteStream): NodeJS.WriteStream {
  return s as unknown as NodeJS.WriteStream;
}

// ---------------------------------------------------------------------------
// ScanProgressReporter — non-TTY mode
// ---------------------------------------------------------------------------

describe("ScanProgressReporter (non-TTY)", () => {
  let stream: FakeWriteStream;
  let reporter: ScanProgressReporter;

  beforeEach(() => {
    stream = new FakeWriteStream();
    stream.isTTY = false;
    reporter = new ScanProgressReporter(asWriteStream(stream));
  });

  it("does not write transient updates in non-TTY mode", () => {
    reporter.update("crawl", "Discovering pages... 3 found");
    expect(stream.output).toBe("");
  });

  it("writes complete messages with newlines", () => {
    reporter.complete("crawl", "Discovered 8 page(s)");
    expect(stream.output).toBe("[crawl] Discovered 8 page(s)\n");
  });

  it("writes warn messages with newlines", () => {
    reporter.warn("axe", "Failed for http://example.com: timeout");
    expect(stream.output).toBe("[axe] Failed for http://example.com: timeout\n");
  });

  it("writes multiple phases in order", () => {
    reporter.complete("crawl", "Discovered 5 page(s)");
    reporter.complete("platform", "Detected: webflow (via meta_generator)");
    reporter.complete("axe", "Checked 5 page(s), 12 finding(s)");
    reporter.complete("scan", "Complete: 12 finding(s)");

    const lines = stream.output.split("\n").filter(Boolean);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("[crawl] Discovered 5 page(s)");
    expect(lines[1]).toBe("[platform] Detected: webflow (via meta_generator)");
    expect(lines[2]).toBe("[axe] Checked 5 page(s), 12 finding(s)");
    expect(lines[3]).toBe("[scan] Complete: 12 finding(s)");
  });
});

// ---------------------------------------------------------------------------
// ScanProgressReporter — TTY mode
// ---------------------------------------------------------------------------

describe("ScanProgressReporter (TTY)", () => {
  let stream: FakeWriteStream;
  let reporter: ScanProgressReporter;

  beforeEach(() => {
    stream = new FakeWriteStream();
    stream.isTTY = true;
    reporter = new ScanProgressReporter(asWriteStream(stream));
  });

  it("writes transient updates without newline", () => {
    reporter.update("crawl", "Discovering pages... 1 found");
    // Should have written the line without a trailing newline
    expect(stream.output).toBe("[crawl] Discovering pages... 1 found");
  });

  it("overwrites previous update with complete", () => {
    reporter.update("crawl", "Discovering pages... 3 found");
    reporter.complete("crawl", "Discovered 5 page(s)");

    // The complete call should clear the previous line and write a new one
    const output = stream.output;
    expect(output).toContain("[crawl] Discovered 5 page(s)\n");
    // Should contain carriage return for clearing
    expect(output).toContain("\r");
  });

  it("overwrites previous update with another update", () => {
    reporter.update("crawl", "1 found");
    reporter.update("crawl", "2 found");

    const output = stream.output;
    // Both lines should be present, with a clear in between
    expect(output).toContain("[crawl] 1 found");
    expect(output).toContain("[crawl] 2 found");
    expect(output).toContain("\r");
  });

  it("writes warn after clearing in-progress line", () => {
    reporter.update("axe", "Running checks...");
    reporter.warn("axe", "Failed for page X");

    const output = stream.output;
    expect(output).toContain("[axe] Failed for page X\n");
    expect(output).toContain("\r");
  });
});

// ---------------------------------------------------------------------------
// QuietProgressReporter
// ---------------------------------------------------------------------------

describe("QuietProgressReporter", () => {
  it("implements ProgressReporter interface", () => {
    const reporter: ProgressReporter = new QuietProgressReporter();
    // Should not throw
    reporter.update("crawl", "test");
    reporter.complete("crawl", "test");
    reporter.warn("crawl", "test");
  });

  it("does not write anything", () => {
    const reporter = new QuietProgressReporter();
    // QuietProgressReporter has no output stream — just verify no errors
    reporter.update("crawl", "Discovering pages...");
    reporter.complete("scan", "Complete: 5 finding(s)");
    reporter.warn("axe", "Something went wrong");
    // If we got here without throwing, the test passes
  });
});

// ---------------------------------------------------------------------------
// Integration: reporter used in scan options
// ---------------------------------------------------------------------------

describe("ProgressReporter integration", () => {
  it("can be used as a scan option type", async () => {
    // This test verifies the type compatibility at runtime
    const quiet = new QuietProgressReporter();
    const scanReporter = new ScanProgressReporter(
      asWriteStream(new FakeWriteStream()),
    );

    // Both should satisfy the ProgressReporter interface
    const reporters: ProgressReporter[] = [quiet, scanReporter];
    for (const r of reporters) {
      expect(typeof r.update).toBe("function");
      expect(typeof r.complete).toBe("function");
      expect(typeof r.warn).toBe("function");
    }
  });
});
