import { describe, it, expect, beforeEach } from "vitest";
import {
  WebflowAdapter,
  hasWebflowGenerator,
  hasWebflowClasses,
  hasWebflowScripts,
  hasWebflowDomain,
  hasWebflowDataAttributes,
} from "../../src/adapters/webflow.js";

// ---------------------------------------------------------------------------
// Fixture DOMs
// ---------------------------------------------------------------------------

/**
 * Realistic Webflow DOM with all typical signals present.
 */
const WEBFLOW_DOM = `<!DOCTYPE html>
<html lang="en" data-wf-page="64a12bc" data-wf-site="5f3abc">
<head>
  <meta charset="UTF-8">
  <meta name="generator" content="Webflow">
  <title>My Webflow Site</title>
  <link rel="stylesheet" href="https://assets.website-files.com/5f3abc/css/site.css">
</head>
<body>
  <div class="w-nav" data-collapse="medium" role="banner">
    <a href="/" class="w-nav-brand"><img src="logo.png" alt="Logo"></a>
    <nav class="w-nav-menu" role="navigation">
      <a href="/about" class="w-nav-link">About</a>
      <a href="/blog" class="w-nav-link">Blog</a>
    </nav>
    <div class="w-nav-button" aria-label="menu" role="button">
      <div class="w-icon-nav-menu"></div>
    </div>
  </div>
  <main>
    <div class="w-container">
      <h1>Welcome</h1>
      <div class="w-form">
        <form><input class="w-input" type="email" placeholder="Email"></form>
        <div class="w-form-done">Thank you!</div>
        <div class="w-form-fail">Something went wrong.</div>
      </div>
    </div>
  </main>
  <script src="https://assets.website-files.com/5f3abc/js/webflow.abc123.js"></script>
</body>
</html>`;

/**
 * Realistic WordPress DOM — should NOT match Webflow detection.
 */
const WORDPRESS_DOM = `<!DOCTYPE html>
<html lang="en-US">
<head>
  <meta charset="UTF-8">
  <meta name="generator" content="WordPress 6.4.2">
  <title>My WordPress Blog</title>
  <link rel="stylesheet" href="https://example.com/wp-content/themes/twentytwenty/style.css">
  <link rel="stylesheet" href="https://example.com/wp-includes/css/dist/block-library/style.min.css">
</head>
<body class="home blog wp-custom-logo">
  <header id="masthead" class="site-header">
    <div class="site-branding">
      <a href="/" class="custom-logo-link"><img src="logo.png" alt="Logo" class="custom-logo"></a>
    </div>
    <nav id="site-navigation" class="main-navigation" aria-label="Primary menu">
      <ul id="primary-menu" class="menu">
        <li class="menu-item"><a href="/about">About</a></li>
        <li class="menu-item"><a href="/blog">Blog</a></li>
      </ul>
    </nav>
  </header>
  <main id="primary" class="site-main">
    <article class="post type-post status-publish hentry">
      <h2 class="entry-title"><a href="/hello-world">Hello World</a></h2>
      <div class="entry-content"><p>Welcome to WordPress.</p></div>
    </article>
  </main>
  <script src="https://example.com/wp-includes/js/jquery/jquery.min.js"></script>
</body>
</html>`;

/**
 * Unknown/custom platform DOM — should NOT match Webflow detection.
 */
const UNKNOWN_DOM = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Custom Site</title>
  <link rel="stylesheet" href="/css/main.css">
</head>
<body>
  <header>
    <nav aria-label="Main navigation">
      <a href="/">Home</a>
      <a href="/about">About</a>
    </nav>
  </header>
  <main>
    <h1>Welcome to our site</h1>
    <p>This is a custom-built website with no specific platform.</p>
    <form action="/submit" method="POST">
      <label for="email">Email</label>
      <input id="email" type="email" name="email" required>
      <button type="submit">Subscribe</button>
    </form>
  </main>
  <script src="/js/app.js"></script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Detection helper tests
// ---------------------------------------------------------------------------

describe("hasWebflowGenerator", () => {
  it("detects standard meta generator tag", () => {
    expect(hasWebflowGenerator('<meta name="generator" content="Webflow">')).toBe(true);
  });

  it("detects meta generator with reversed attributes", () => {
    expect(hasWebflowGenerator('<meta content="Webflow" name="generator">')).toBe(true);
  });

  it("detects case-insensitive", () => {
    expect(hasWebflowGenerator('<META NAME="generator" CONTENT="Webflow">')).toBe(true);
  });

  it("rejects WordPress generator", () => {
    expect(hasWebflowGenerator('<meta name="generator" content="WordPress 6.4">')).toBe(false);
  });

  it("rejects missing generator", () => {
    expect(hasWebflowGenerator("<html><head></head></html>")).toBe(false);
  });
});

describe("hasWebflowClasses", () => {
  it("detects multiple w- classes", () => {
    expect(hasWebflowClasses('<div class="w-nav"><div class="w-container">')).toBe(true);
  });

  it("rejects single w- class (needs 2 for confidence)", () => {
    expect(hasWebflowClasses('<div class="w-nav">')).toBe(false);
  });

  it("rejects non-Webflow w- prefixed classes", () => {
    // A class like "w-full" (Tailwind) should not trigger detection
    expect(hasWebflowClasses('<div class="w-full w-1/2">')).toBe(false);
  });
});

describe("hasWebflowScripts", () => {
  it("detects webflow.js script", () => {
    expect(hasWebflowScripts('<script src="webflow.abc123.js">')).toBe(true);
  });

  it("detects assets.website-files.com", () => {
    expect(hasWebflowScripts('<script src="https://assets.website-files.com/abc/js/site.js">')).toBe(true);
  });

  it("rejects unrelated scripts", () => {
    expect(hasWebflowScripts('<script src="/js/app.js">')).toBe(false);
  });
});

describe("hasWebflowDomain", () => {
  it("detects .webflow.io domain", () => {
    expect(hasWebflowDomain('<link rel="canonical" href="https://mysite.webflow.io">')).toBe(true);
  });

  it("rejects non-webflow domains", () => {
    expect(hasWebflowDomain('<link rel="canonical" href="https://example.com">')).toBe(false);
  });
});

describe("hasWebflowDataAttributes", () => {
  it("detects data-wf-site", () => {
    expect(hasWebflowDataAttributes('<html data-wf-site="abc123">')).toBe(true);
  });

  it("detects data-wf-page", () => {
    expect(hasWebflowDataAttributes('<html data-wf-page="xyz789">')).toBe(true);
  });

  it("detects data-wf-domain", () => {
    expect(hasWebflowDataAttributes('<html data-wf-domain="example.com">')).toBe(true);
  });

  it("rejects non-wf data attributes", () => {
    expect(hasWebflowDataAttributes('<div data-id="123">')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WebflowAdapter integration tests
// ---------------------------------------------------------------------------

describe("WebflowAdapter", () => {
  let adapter: WebflowAdapter;

  beforeEach(() => {
    adapter = new WebflowAdapter();
  });

  // -----------------------------------------------------------------------
  // detect()
  // -----------------------------------------------------------------------
  describe("detect", () => {
    it("returns true for Webflow DOM", () => {
      expect(adapter.detect(WEBFLOW_DOM)).toBe(true);
    });

    it("returns false for WordPress DOM", () => {
      expect(adapter.detect(WORDPRESS_DOM)).toBe(false);
    });

    it("returns false for unknown/custom DOM", () => {
      expect(adapter.detect(UNKNOWN_DOM)).toBe(false);
    });

    it("detects via meta_generator for full Webflow DOM", () => {
      adapter.detect(WEBFLOW_DOM);
      expect(adapter.getPlatformInfo().detected_via).toBe("meta_generator");
    });

    it("detects via class_patterns when no generator tag", () => {
      const domWithClasses = `<html><body>
        <div class="w-nav"><div class="w-container">Content</div></div>
      </body></html>`;
      expect(adapter.detect(domWithClasses)).toBe(true);
      expect(adapter.getPlatformInfo().detected_via).toBe("class_patterns");
    });

    it("detects via script_tags when no classes or generator", () => {
      const domWithScript = `<html><body>
        <script src="https://assets.website-files.com/abc/webflow.js"></script>
      </body></html>`;
      expect(adapter.detect(domWithScript)).toBe(true);
      expect(adapter.getPlatformInfo().detected_via).toBe("script_tags");
    });

    it("detects via webflow_domain", () => {
      const domWithDomain = `<html><head>
        <link rel="canonical" href="https://mysite.webflow.io/about">
      </head><body><p>Hello</p></body></html>`;
      expect(adapter.detect(domWithDomain)).toBe(true);
      expect(adapter.getPlatformInfo().detected_via).toBe("webflow_domain");
    });

    it("detects via data_attributes", () => {
      const domWithDataAttrs = `<html data-wf-site="5f3abc" data-wf-page="64a12bc">
        <body><p>Hello</p></body></html>`;
      expect(adapter.detect(domWithDataAttrs)).toBe(true);
      expect(adapter.getPlatformInfo().detected_via).toBe("data_attributes");
    });
  });

  // -----------------------------------------------------------------------
  // getPlatformInfo()
  // -----------------------------------------------------------------------
  describe("getPlatformInfo", () => {
    it("returns correct platform info after detection", () => {
      adapter.detect(WEBFLOW_DOM);
      const info = adapter.getPlatformInfo();
      expect(info.platform).toBe("webflow");
      expect(info.version).toBeNull();
      expect(info.detected_via).toBe("meta_generator");
    });

    it("returns empty detected_via when detect() not called", () => {
      const info = adapter.getPlatformInfo();
      expect(info.platform).toBe("webflow");
      expect(info.detected_via).toBe("");
    });
  });

  // -----------------------------------------------------------------------
  // getCMSPattern()
  // -----------------------------------------------------------------------
  describe("getCMSPattern", () => {
    it("returns null (CMS detection done via DOM analysis)", () => {
      expect(adapter.getCMSPattern()).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // getPlatformContext()
  // -----------------------------------------------------------------------
  describe("getPlatformContext", () => {
    it("returns non-empty context string", () => {
      const context = adapter.getPlatformContext();
      expect(context.length).toBeGreaterThan(100);
      expect(context).toContain("Webflow");
    });

    it("includes key UI paths", () => {
      const context = adapter.getPlatformContext();
      expect(context).toContain("Element Settings");
      expect(context).toContain("aria-label");
    });

    it("includes platform limitations", () => {
      const context = adapter.getPlatformContext();
      expect(context).toContain("Platform Limitations");
      expect(context).toContain("aria-live");
    });
  });

  // -----------------------------------------------------------------------
  // getRemediationSteps()
  // -----------------------------------------------------------------------
  describe("getRemediationSteps", () => {
    it("returns stub PlatformFix with webflow platform", () => {
      const mockFinding = {
        id: "test-id",
        page_snapshot_id: "ps-1",
        interaction_state_id: null,
        wcag_criterion: "1.1.1",
        wcag_level: "A" as const,
        severity: "major" as const,
        category: "images" as const,
        finding_type_hash: "abc",
        evidence: {} as any,
        analysis: {} as any,
        confidence: {} as any,
        remediation: {} as any,
        human_review: null,
      };

      const fix = adapter.getRemediationSteps(mockFinding);
      expect(fix.platform).toBe("webflow");
      expect(fix.steps).toEqual([]);
      expect(fix.generated_by).toBe("template");
      expect(fix.platform_docs_url).toBeNull();
    });
  });
});
