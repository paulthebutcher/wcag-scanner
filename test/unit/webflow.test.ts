import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  WebflowAdapter,
  hasWebflowGenerator,
  hasWebflowClasses,
  hasWebflowScripts,
  hasWebflowDomain,
  hasWebflowDataAttributes,
  getCachedRemediation,
  setCachedRemediation,
  clearRemediationCache,
  getTemplateKey,
  getTemplateCount,
  generateLlmRemediation,
  verifyRemediation,
  type RemediationOutput,
  type VerificationOutput,
} from "../../src/adapters/webflow.js";
import type { Finding, PlatformFix } from "../../src/types.js";
import type { PromptRunner, PromptResult } from "../../src/core/prompt-runner.js";

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
    beforeEach(() => { clearRemediationCache(); });

    it("returns template-based fix for missing_alt finding", () => {
      const finding = makeFinding("1.1.1", "missing_alt", "hash-alt");
      const fix = adapter.getRemediationSteps(finding);
      expect(fix.platform).toBe("webflow");
      expect(fix.platform_version).toBe("2024.1");
      expect(fix.generated_by).toBe("template");
      expect(fix.steps.length).toBeGreaterThan(0);
      expect(fix.designer_path).toContain("Alt Text");
    });

    it("returns template-based fix for insufficient_contrast", () => {
      const finding = makeFinding("1.4.3", "insufficient_contrast", "hash-contrast");
      const fix = adapter.getRemediationSteps(finding);
      expect(fix.steps.length).toBeGreaterThan(0);
      expect(fix.designer_path).toContain("Style panel");
    });

    it("returns generic fallback for unknown failure type", () => {
      const finding = makeFinding("9.9.9", "unknown_failure", "hash-unknown");
      const fix = adapter.getRemediationSteps(finding);
      expect(fix.platform).toBe("webflow");
      expect(fix.platform_version).toBe("2024.1");
      expect(fix.steps.length).toBeGreaterThan(0);
      expect(fix.steps[0]).toContain("9.9.9");
      expect(fix.designer_path).toContain("Custom Attributes");
    });

    it("returns generic fallback when no failure_type in evidence", () => {
      const finding = makeFinding("1.1.1", undefined, "hash-no-ft");
      const fix = adapter.getRemediationSteps(finding);
      expect(fix.platform).toBe("webflow");
      expect(fix.steps[0]).toContain("1.1.1");
    });

    it("caches result by finding_type_hash", () => {
      const finding = makeFinding("2.4.7", "no_focus_indicator", "hash-focus");
      const fix1 = adapter.getRemediationSteps(finding);
      const fix2 = adapter.getRemediationSteps(finding);
      expect(fix1).toBe(fix2); // same reference from cache
      expect(getCachedRemediation("hash-focus")).toBe(fix1);
    });

    it("returns cached result even with different finding", () => {
      const finding1 = makeFinding("2.4.7", "no_focus_indicator", "hash-shared");
      const fix1 = adapter.getRemediationSteps(finding1);

      const finding2 = makeFinding("1.1.1", "missing_alt", "hash-shared");
      const fix2 = adapter.getRemediationSteps(finding2);
      expect(fix1).toBe(fix2); // same hash → same cached result
    });

    it("includes steps for skip_link template", () => {
      const finding = makeFinding("2.4.1", "missing_skip_link", "hash-skip");
      const fix = adapter.getRemediationSteps(finding);
      expect(fix.steps.some(s => s.includes("Link Block"))).toBe(true);
    });

    it("includes platform_version on all returned fixes", () => {
      const templates = [
        makeFinding("1.1.1", "missing_alt", "h1"),
        makeFinding("2.4.7", "no_focus_indicator", "h2"),
        makeFinding("3.1.1", "missing_lang", "h3"),
        makeFinding("9.9.9", "unknown", "h4"),
      ];
      for (const f of templates) {
        const fix = adapter.getRemediationSteps(f);
        expect(fix.platform_version).toBe("2024.1");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Helper for creating mock findings
// ---------------------------------------------------------------------------

function makeFinding(
  criterion: string,
  failureType: string | undefined,
  hash: string,
): Finding {
  return {
    id: `f-${hash}`,
    page_snapshot_id: "ps-1",
    interaction_state_id: null,
    wcag_criterion: criterion,
    wcag_level: "A",
    severity: "major",
    category: "images",
    finding_type_hash: hash,
    evidence: {
      element_selector: "#el",
      element_html: '<img src="photo.jpg">',
      element_screenshot: "",
      element_computed_styles: {},
      context_screenshot: "",
      measured_values: failureType ? { failure_type: failureType } : {},
      keyboard_sequence: null,
      aria_attributes: {},
      detected_by: "axe_core",
    },
    analysis: {
      method: "rule_based",
      reasoning: "Test reasoning",
      llm_input: null,
      llm_output: null,
      impact_description: "Test impact",
      affected_users: ["screen_reader"],
    },
    confidence: { score: 0.95, tier: "definitive", basis: "axe", requires_human: false, false_positive_risk: "low" },
    remediation: {
      generic_fix: "Fix it",
      platform_fix: { platform: "webflow", platform_version: "", steps: [], designer_path: "", screenshots: [], generated_by: "template", platform_docs_url: null },
      code_fix: null,
      estimated_effort: "trivial",
      fix_verified: false,
    },
    human_review: null,
  };
}

// Mock PromptRunner
function createMockRunner(responses: Map<string, PromptResult>): PromptRunner {
  const runPrompt = vi.fn(async (input: { template: { name: string }; userMessage: string }) => {
    const key = input.template.name;
    return responses.get(key) ?? { success: false, data: null, rawResponse: "", model: "test", tokensUsed: 0, latencyMs: 0, retries: 0, error: "no mock" };
  });
  return { runPrompt, runPrompts: vi.fn(), flushBatch: vi.fn(), getBatchQueueSize: vi.fn(() => 0), getConfig: vi.fn() } as unknown as PromptRunner;
}

// ---------------------------------------------------------------------------
// Remediation cache tests
// ---------------------------------------------------------------------------

describe("remediation cache", () => {
  beforeEach(() => { clearRemediationCache(); });

  it("setCachedRemediation / getCachedRemediation round-trips", () => {
    const fix: PlatformFix = {
      platform: "webflow", platform_version: "2024.1", steps: ["Step 1"],
      designer_path: "path", screenshots: [], generated_by: "template", platform_docs_url: null,
    };
    setCachedRemediation("hash-a", fix);
    expect(getCachedRemediation("hash-a")).toBe(fix);
  });

  it("returns undefined for missing cache entry", () => {
    expect(getCachedRemediation("nonexistent")).toBeUndefined();
  });

  it("clearRemediationCache removes all entries", () => {
    setCachedRemediation("hash-a", {} as PlatformFix);
    clearRemediationCache();
    expect(getCachedRemediation("hash-a")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Template key + count tests
// ---------------------------------------------------------------------------

describe("getTemplateKey", () => {
  it("returns criterion:failure_type for finding with failure_type", () => {
    const f = makeFinding("1.1.1", "missing_alt", "h1");
    expect(getTemplateKey(f)).toBe("1.1.1:missing_alt");
  });

  it("returns null when no failure_type in measured_values", () => {
    const f = makeFinding("1.1.1", undefined, "h1");
    expect(getTemplateKey(f)).toBeNull();
  });
});

describe("getTemplateCount", () => {
  it("has at least 15 templates", () => {
    expect(getTemplateCount()).toBeGreaterThanOrEqual(15);
  });

  it("has exactly 20 templates", () => {
    expect(getTemplateCount()).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// generateLlmRemediation tests
// ---------------------------------------------------------------------------

describe("generateLlmRemediation", () => {
  beforeEach(() => { clearRemediationCache(); });

  it("calls Prompt 12 and returns PlatformFix", async () => {
    const llmResult: PromptResult<RemediationOutput> = {
      success: true,
      data: {
        generic_fix: "Add alt text",
        platform_steps: ["Step A", "Step B"],
        designer_path: "Element Settings → Alt Text",
        code_fix: null,
        estimated_effort: "trivial",
        fix_category: "attribute",
        platform_docs_url: "https://docs.example.com",
      },
      rawResponse: "{}", model: "sonnet", tokensUsed: 300, latencyMs: 200, retries: 0,
    };
    const runner = createMockRunner(new Map([["remediation_generation", llmResult as PromptResult]]));

    const finding = makeFinding("1.1.1", "missing_alt", "hash-llm-1");
    const fix = await generateLlmRemediation(finding, runner);

    expect(runner.runPrompt).toHaveBeenCalledTimes(1);
    expect(fix.platform).toBe("webflow");
    expect(fix.platform_version).toBe("2024.1");
    expect(fix.generated_by).toBe("llm");
    expect(fix.steps).toEqual(["Step A", "Step B"]);
    expect(fix.designer_path).toBe("Element Settings → Alt Text");
    expect(fix.platform_docs_url).toBe("https://docs.example.com");
  });

  it("caches LLM result by finding_type_hash", async () => {
    const llmResult: PromptResult<RemediationOutput> = {
      success: true,
      data: {
        generic_fix: "Fix", platform_steps: ["S1"], code_fix: null,
        estimated_effort: "minor", fix_category: "attribute",
      },
      rawResponse: "{}", model: "sonnet", tokensUsed: 300, latencyMs: 200, retries: 0,
    };
    const runner = createMockRunner(new Map([["remediation_generation", llmResult as PromptResult]]));

    const finding = makeFinding("2.4.7", "no_focus_indicator", "hash-llm-cache");
    await generateLlmRemediation(finding, runner);

    const cached = getCachedRemediation("hash-llm-cache");
    expect(cached).toBeDefined();
    expect(cached!.generated_by).toBe("llm");
  });

  it("returns cached LLM result without calling API", async () => {
    setCachedRemediation("hash-llm-cached", {
      platform: "webflow", platform_version: "2024.1", steps: ["Cached"],
      designer_path: "cached", screenshots: [], generated_by: "llm", platform_docs_url: null,
    });

    const runner = createMockRunner(new Map());
    const finding = makeFinding("1.1.1", "missing_alt", "hash-llm-cached");
    const fix = await generateLlmRemediation(finding, runner);

    expect(runner.runPrompt).not.toHaveBeenCalled();
    expect(fix.steps).toEqual(["Cached"]);
  });

  it("falls back to template on LLM failure", async () => {
    const failResult: PromptResult = {
      success: false, data: null, rawResponse: "", model: "sonnet",
      tokensUsed: 0, latencyMs: 0, retries: 2, error: "API error",
    };
    const runner = createMockRunner(new Map([["remediation_generation", failResult]]));

    const finding = makeFinding("1.1.1", "missing_alt", "hash-llm-fail");
    const fix = await generateLlmRemediation(finding, runner);

    expect(fix.platform).toBe("webflow");
    expect(fix.generated_by).toBe("template");
    expect(fix.steps.length).toBeGreaterThan(0);
  });

  it("includes platform context in user message", async () => {
    const llmResult: PromptResult<RemediationOutput> = {
      success: true,
      data: {
        generic_fix: "Fix", platform_steps: ["S1"], code_fix: null,
        estimated_effort: "minor", fix_category: "attribute",
      },
      rawResponse: "{}", model: "sonnet", tokensUsed: 300, latencyMs: 200, retries: 0,
    };
    const runner = createMockRunner(new Map([["remediation_generation", llmResult as PromptResult]]));

    const finding = makeFinding("1.1.1", "missing_alt", "hash-llm-ctx");
    await generateLlmRemediation(finding, runner, "## Custom Context");

    const call = (runner.runPrompt as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.userMessage).toContain("## Custom Context");
    expect(call.userMessage).toContain("1.1.1");
    expect(call.userMessage).toContain("webflow");
  });
});

// ---------------------------------------------------------------------------
// verifyRemediation tests
// ---------------------------------------------------------------------------

describe("verifyRemediation", () => {
  it("calls Prompt 13 and returns verification result", async () => {
    const verifyResult: PromptResult<VerificationOutput> = {
      success: true,
      data: {
        fix_applied: true, violation_resolved: true, confidence: 0.95,
        reasoning: "Alt text added correctly", remaining_issues: [], new_issues_introduced: [],
      },
      rawResponse: "{}", model: "sonnet", tokensUsed: 200, latencyMs: 150, retries: 0,
    };
    const runner = createMockRunner(new Map([["remediation_verification", verifyResult as PromptResult]]));

    const finding = makeFinding("1.1.1", "missing_alt", "hash-verify");
    const result = await verifyRemediation(finding, "Added alt text", '<img alt="Photo">', runner);

    expect(result).not.toBeNull();
    expect(result!.fix_applied).toBe(true);
    expect(result!.violation_resolved).toBe(true);
    expect(result!.confidence).toBe(0.95);
  });

  it("returns null on verification failure", async () => {
    const failResult: PromptResult = {
      success: false, data: null, rawResponse: "", model: "sonnet",
      tokensUsed: 0, latencyMs: 0, retries: 2, error: "API error",
    };
    const runner = createMockRunner(new Map([["remediation_verification", failResult]]));

    const finding = makeFinding("1.1.1", "missing_alt", "hash-verify-fail");
    const result = await verifyRemediation(finding, "Added alt", '<img alt="Photo">', runner);

    expect(result).toBeNull();
  });
});
