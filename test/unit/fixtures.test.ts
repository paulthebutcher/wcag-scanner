import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import http from "node:http";
import {
  loadFixture,
  loadAllFixtures,
  FIXTURE_NAMES,
  type FixtureName,
} from "../fixtures/load-fixture.js";
import { detectPlatform } from "../../src/core/scanner.js";
import { runAxeChecks } from "../../src/checks/automated/index.js";
import {
  hasWebflowGenerator,
  hasWebflowClasses,
  hasWebflowDataAttributes,
} from "../../src/adapters/webflow.js";

// ---------------------------------------------------------------------------
// loadFixture helper tests
// ---------------------------------------------------------------------------

describe("loadFixture", () => {
  it("loads all named fixtures without error", () => {
    for (const name of FIXTURE_NAMES) {
      const fixture = loadFixture(name);
      expect(fixture.dom).toBeTruthy();
      expect(fixture.snapshot).toBeDefined();
      expect(fixture.metadata).toBeDefined();
    }
  });

  it("returns unique IDs per invocation", () => {
    const a = loadFixture("webflow-landing");
    const b = loadFixture("webflow-landing");
    expect(a.snapshot.id).not.toBe(b.snapshot.id);
    expect(a.snapshot.scan_session_id).not.toBe(b.snapshot.scan_session_id);
  });

  it("snapshot has correct URL and title from metadata", () => {
    const fixture = loadFixture("webflow-contact-form");
    expect(fixture.snapshot.url).toBe("https://acme-corp.webflow.io/contact");
    expect(fixture.snapshot.title).toBe("Contact Us — Acme Corp");
  });

  it("snapshot full_dom matches raw HTML", () => {
    const fixture = loadFixture("webflow-blog-post");
    expect(fixture.snapshot.full_dom).toBe(fixture.dom);
  });

  it("snapshot has default viewport", () => {
    const fixture = loadFixture("webflow-landing");
    expect(fixture.snapshot.viewport).toEqual({
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
    });
  });

  it("throws for unknown fixture name", () => {
    expect(() => loadFixture("nonexistent" as FixtureName)).toThrow(
      "Unknown fixture",
    );
  });

  it("loadAllFixtures returns all fixtures", () => {
    const all = loadAllFixtures();
    expect(all.size).toBe(FIXTURE_NAMES.length);
    for (const name of FIXTURE_NAMES) {
      expect(all.has(name)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Fixture metadata accuracy
// ---------------------------------------------------------------------------

describe("fixture metadata", () => {
  it("webflow-landing has violations flagged", () => {
    const { metadata } = loadFixture("webflow-landing");
    expect(metadata.has_violations).toBe(true);
    expect(metadata.violation_types).toContain("missing-alt");
    expect(metadata.violation_types).toContain("low-contrast");
    expect(metadata.violation_types).toContain("empty-link");
    expect(metadata.has_navigation).toBe(true);
    expect(metadata.has_form).toBe(false);
  });

  it("webflow-contact-form has form flagged", () => {
    const { metadata } = loadFixture("webflow-contact-form");
    expect(metadata.has_form).toBe(true);
    expect(metadata.has_violations).toBe(true);
    expect(metadata.violation_types).toContain("missing-label");
  });

  it("webflow-blog-post is clean", () => {
    const { metadata } = loadFixture("webflow-blog-post");
    expect(metadata.has_violations).toBe(false);
    expect(metadata.violation_types).toHaveLength(0);
  });

  it("webflow-portfolio has missing-lang violation", () => {
    const { metadata } = loadFixture("webflow-portfolio");
    expect(metadata.has_violations).toBe(true);
    expect(metadata.violation_types).toContain("missing-lang");
    expect(metadata.violation_types).toContain("missing-alt");
  });
});

// ---------------------------------------------------------------------------
// Platform detection using fixtures
// ---------------------------------------------------------------------------

describe("platform detection with fixtures", () => {
  it("detects Webflow on landing page fixture", () => {
    const { dom } = loadFixture("webflow-landing");
    const result = detectPlatform(dom);
    expect(result.platform).toBe("webflow");
    expect(result.detected_via).toBe("meta_generator");
  });

  it("detects Webflow on contact form fixture", () => {
    const { dom } = loadFixture("webflow-contact-form");
    const result = detectPlatform(dom);
    expect(result.platform).toBe("webflow");
  });

  it("detects Webflow on portfolio fixture", () => {
    const { dom } = loadFixture("webflow-portfolio");
    const result = detectPlatform(dom);
    expect(result.platform).toBe("webflow");
  });

  it("detects Webflow meta generator on all Webflow fixtures", () => {
    for (const name of FIXTURE_NAMES) {
      const { dom } = loadFixture(name);
      expect(hasWebflowGenerator(dom)).toBe(true);
    }
  });

  it("detects Webflow classes on fixtures with w- classes", () => {
    const { dom } = loadFixture("webflow-landing");
    expect(hasWebflowClasses(dom)).toBe(true);
  });

  it("detects data-wf attributes on fixtures", () => {
    const { dom } = loadFixture("webflow-landing");
    expect(hasWebflowDataAttributes(dom)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// axe-core checks using fixtures (integration with real browser)
// ---------------------------------------------------------------------------

describe("axe-core with fixtures", () => {
  let browser: Browser;
  let server: http.Server;
  let port: number;

  // Serve fixture HTML via HTTP
  const fixtureContent: Record<string, string> = {};

  beforeAll(async () => {
    // Load all fixture DOMs
    for (const name of FIXTURE_NAMES) {
      const { dom } = loadFixture(name);
      fixtureContent[name] = dom;
    }

    browser = await chromium.launch({ headless: true });

    server = http.createServer((req, res) => {
      const name = req.url?.slice(1); // strip leading /
      const html = name ? fixtureContent[name] : undefined;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (html) {
        res.end(html);
      } else {
        res.statusCode = 404;
        res.end("<html><body>Not found</body></html>");
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          port = addr.port;
        }
        resolve();
      });
    });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  it("finds violations on webflow-landing fixture", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/webflow-landing`, {
        waitUntil: "load",
      });

      const result = await runAxeChecks(page, "test-landing");

      // Should find violations — missing alt, low contrast, empty link
      expect(result.violations.length).toBeGreaterThan(0);

      const criteria = result.violations.map((v) => v.wcag_criterion);
      // Missing alt → 1.1.1
      expect(criteria).toContain("1.1.1");
    } finally {
      await page.close();
      await context.close();
    }
  });

  it("finds form violations on webflow-contact-form fixture", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/webflow-contact-form`, {
        waitUntil: "load",
      });

      const result = await runAxeChecks(page, "test-form");

      // Should find the unlabeled phone input
      expect(result.violations.length).toBeGreaterThan(0);

      // Verify there are some passes too
      expect(result.passes.length).toBeGreaterThan(0);
    } finally {
      await page.close();
      await context.close();
    }
  });

  it("finds missing-lang on webflow-portfolio fixture", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/webflow-portfolio`, {
        waitUntil: "load",
      });

      const result = await runAxeChecks(page, "test-portfolio");

      expect(result.violations.length).toBeGreaterThan(0);

      const criteria = result.violations.map((v) => v.wcag_criterion);
      // Missing lang → 3.1.1
      expect(criteria).toContain("3.1.1");
    } finally {
      await page.close();
      await context.close();
    }
  });

  it("has fewer violations on webflow-blog-post (well-structured fixture)", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/webflow-blog-post`, {
        waitUntil: "load",
      });

      const result = await runAxeChecks(page, "test-blog");

      // Blog post fixture is well-structured — fewer or no violations
      // It has proper lang, alt texts, and labels
      expect(result.passes.length).toBeGreaterThan(0);
    } finally {
      await page.close();
      await context.close();
    }
  });

  it("maps violations to correct WCAG criteria", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/webflow-landing`, {
        waitUntil: "load",
      });

      const result = await runAxeChecks(page, "test-mapping");

      for (const v of result.violations) {
        // All violations should have a valid WCAG criterion
        expect(v.wcag_criterion).toMatch(/^\d+\.\d+\.\d+$/);
        // All should be detected by axe_core
        expect(v.detected_by).toBe("axe_core");
        // All should have element HTML
        expect(v.element_html).toBeTruthy();
      }
    } finally {
      await page.close();
      await context.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Fixture DOM structure validation
// ---------------------------------------------------------------------------

describe("fixture DOM structure", () => {
  it("webflow-landing contains Webflow navbar markup", () => {
    const { dom } = loadFixture("webflow-landing");
    expect(dom).toContain("w-nav");
    expect(dom).toContain("w-nav-menu");
    expect(dom).toContain("w-nav-link");
    expect(dom).toContain("w-container");
  });

  it("webflow-contact-form contains form elements", () => {
    const { dom } = loadFixture("webflow-contact-form");
    expect(dom).toContain("<form");
    expect(dom).toContain("w-input");
    expect(dom).toContain("w-select");
    expect(dom).toContain("w-form");
    expect(dom).toContain('type="submit"');
  });

  it("webflow-blog-post contains CMS content markers", () => {
    const { dom } = loadFixture("webflow-blog-post");
    expect(dom).toContain("w-richtext");
    expect(dom).toContain("w-dyn-list");
    expect(dom).toContain("w-dyn-item");
  });

  it("webflow-portfolio contains tabs and grid", () => {
    const { dom } = loadFixture("webflow-portfolio");
    expect(dom).toContain("w-tabs");
    expect(dom).toContain("w-tab-menu");
    expect(dom).toContain("w-tab-link");
    expect(dom).toContain("w-layout-grid");
    expect(dom).toContain("w-dropdown");
  });

  it("all fixtures include Webflow script references", () => {
    for (const name of FIXTURE_NAMES) {
      const { dom } = loadFixture(name);
      expect(dom).toContain("webflow.js");
    }
  });
});
