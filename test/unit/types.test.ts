import { describe, it, expect } from "vitest";

describe("types", () => {
  it("placeholder — types module exists", async () => {
    const types = await import("../../src/types.js");
    expect(types).toBeDefined();
  });
});
