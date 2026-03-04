import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalFileStore } from "../../src/store/files.js";
import type { FileStore } from "../../src/store/files.js";

describe("LocalFileStore", () => {
  let tmpDir: string;
  let store: FileStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wcag-files-test-"));
    store = new LocalFileStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("store writes file and returns relative path", () => {
    const buf = Buffer.from("hello");
    const relPath = store.store("scan-1", "screenshot.png", buf);
    expect(relPath).toBe(join("scan-1", "screenshot.png"));
  });

  it("retrieve returns the stored buffer", () => {
    const buf = Buffer.from("test-data-1234");
    store.store("scan-2", "element.png", buf);
    const retrieved = store.retrieve("scan-2", "element.png");
    expect(Buffer.compare(retrieved, buf)).toBe(0);
  });

  it("creates nested directories recursively", () => {
    const buf = Buffer.from("nested");
    const relPath = store.store("scan-3", "pages/page1/thumb.jpg", buf);
    expect(relPath).toBe(join("scan-3", "pages/page1/thumb.jpg"));
    const retrieved = store.retrieve("scan-3", "pages/page1/thumb.jpg");
    expect(Buffer.compare(retrieved, buf)).toBe(0);
  });

  it("handles binary data correctly", () => {
    const buf = Buffer.from([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47]);
    store.store("scan-4", "binary.bin", buf);
    const retrieved = store.retrieve("scan-4", "binary.bin");
    expect(Buffer.compare(retrieved, buf)).toBe(0);
  });

  it("retrieve throws on missing file", () => {
    expect(() => store.retrieve("no-scan", "missing.png")).toThrow();
  });

  it("uses configurable base directory", () => {
    const customDir = join(tmpDir, "custom", "data");
    const customStore = new LocalFileStore(customDir);
    const buf = Buffer.from("custom-dir");
    customStore.store("scan-5", "file.dat", buf);
    const retrieved = customStore.retrieve("scan-5", "file.dat");
    expect(Buffer.compare(retrieved, buf)).toBe(0);
  });

  it("satisfies FileStore interface", () => {
    const fileStore: FileStore = store;
    expect(fileStore.store).toBeTypeOf("function");
    expect(fileStore.retrieve).toBeTypeOf("function");
  });
});
