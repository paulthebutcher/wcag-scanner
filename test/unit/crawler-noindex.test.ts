import { describe, it, expect } from "vitest";
import { detectNoindex } from "../../src/core/crawler.js";

describe("detectNoindex", () => {
  describe("meta robots", () => {
    it("detects noindex directive", () => {
      const dom = `<html><head><meta name="robots" content="noindex"></head></html>`;
      expect(detectNoindex(dom, {})).toEqual({ noindex: true, source: "meta-robots" });
    });

    it("detects noindex in multi-directive list", () => {
      const dom = `<html><head><meta name="robots" content="noindex, nofollow"></head></html>`;
      expect(detectNoindex(dom, {})).toEqual({ noindex: true, source: "meta-robots" });
    });

    it("is case-insensitive on directive name and value", () => {
      const dom = `<html><head><meta NAME="Robots" CONTENT="NOINDEX, NOFOLLOW"></head></html>`;
      expect(detectNoindex(dom, {})).toEqual({ noindex: true, source: "meta-robots" });
    });

    it("ignores non-noindex directives", () => {
      const dom = `<html><head><meta name="robots" content="index, follow"></head></html>`;
      expect(detectNoindex(dom, {})).toEqual({ noindex: false, source: null });
    });

    it("ignores noindex appearing inside another token", () => {
      // "noindexing" is not a valid directive; must match the whole token
      const dom = `<html><head><meta name="robots" content="noindexing"></head></html>`;
      expect(detectNoindex(dom, {})).toEqual({ noindex: false, source: null });
    });

    it("tolerates single quotes and attribute order", () => {
      const dom = `<html><head><meta content='noindex' name='robots'></head></html>`;
      expect(detectNoindex(dom, {})).toEqual({ noindex: true, source: "meta-robots" });
    });
  });

  describe("meta googlebot", () => {
    it("detects googlebot noindex", () => {
      const dom = `<html><head><meta name="googlebot" content="noindex"></head></html>`;
      expect(detectNoindex(dom, {})).toEqual({ noindex: true, source: "meta-googlebot" });
    });

    it("detects googlebot noindex alongside non-noindex robots", () => {
      const dom = `<html><head>
        <meta name="robots" content="index, follow">
        <meta name="googlebot" content="noindex">
      </head></html>`;
      expect(detectNoindex(dom, {})).toEqual({ noindex: true, source: "meta-googlebot" });
    });
  });

  describe("X-Robots-Tag header", () => {
    it("detects bare noindex", () => {
      expect(detectNoindex("<html></html>", { "x-robots-tag": "noindex" }))
        .toEqual({ noindex: true, source: "x-robots-tag" });
    });

    it("detects noindex in multi-directive header", () => {
      expect(detectNoindex("<html></html>", { "x-robots-tag": "noindex, nofollow" }))
        .toEqual({ noindex: true, source: "x-robots-tag" });
    });

    it("detects bot-scoped directive", () => {
      expect(detectNoindex("<html></html>", { "x-robots-tag": "googlebot: noindex" }))
        .toEqual({ noindex: true, source: "x-robots-tag" });
    });

    it("ignores 'all' directive", () => {
      expect(detectNoindex("<html></html>", { "x-robots-tag": "all" }))
        .toEqual({ noindex: false, source: null });
    });

    it("ignores 'none' despite meaning roughly the same — we only match the explicit token", () => {
      // Conservative: only match literal "noindex". "none" could be added later.
      expect(detectNoindex("<html></html>", { "x-robots-tag": "none" }))
        .toEqual({ noindex: false, source: null });
    });
  });

  describe("precedence and absence", () => {
    it("returns header source when both HTML and header say noindex", () => {
      const dom = `<html><head><meta name="robots" content="noindex"></head></html>`;
      expect(detectNoindex(dom, { "x-robots-tag": "noindex" }))
        .toEqual({ noindex: true, source: "x-robots-tag" });
    });

    it("returns false when nothing is present", () => {
      expect(detectNoindex("<html><head><title>hi</title></head></html>", {}))
        .toEqual({ noindex: false, source: null });
    });

    it("returns false for empty inputs", () => {
      expect(detectNoindex("", {})).toEqual({ noindex: false, source: null });
    });
  });
});
