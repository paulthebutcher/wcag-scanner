import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  collectImages,
  deduplicateCmsImages,
  runAltTextChecks,
  extractAttr,
  type ImageContext,
  type AltTextEvaluation,
} from "../../src/checks/semantic/alt-text.js";
import { PromptRunner } from "../../src/core/prompt-runner.js";

// ---------------------------------------------------------------------------
// Test HTML snippets
// ---------------------------------------------------------------------------

const BASIC_HTML = `
<html>
<body>
  <nav>
    <a href="/">Home</a>
    <a href="/about">About</a>
  </nav>
  <main>
    <h1>Welcome</h1>
    <p>We provide great services.</p>
    <img id="hero" src="hero.jpg" alt="Team working together in an office" class="hero-img">
    <img src="decoration.png" alt="" role="presentation">
    <img src="product.jpg" alt="IMG_20230415.jpg" class="product-img">
    <a href="/signup">
      <img src="cta-arrow.svg" alt="" class="cta-icon">
    </a>
    <img src="chart.png" class="chart-img">
    <p>Learn more about our <a href="/products"><img src="icon.png" alt="">products</a>.</p>
  </main>
</body>
</html>
`;

const CMS_COLLECTION_HTML = `
<html>
<body>
  <div class="w-dyn-items">
    <div class="w-dyn-item">
      <img src="/uploads/post-1.jpg" alt="Blog post thumbnail" class="blog-thumb">
      <h3>First Post</h3>
    </div>
    <div class="w-dyn-item">
      <img src="/uploads/post-2.jpg" alt="Blog post thumbnail" class="blog-thumb">
      <h3>Second Post</h3>
    </div>
    <div class="w-dyn-item">
      <img src="/uploads/post-3.jpg" alt="Blog post thumbnail" class="blog-thumb">
      <h3>Third Post</h3>
    </div>
    <div class="w-dyn-item">
      <img src="/uploads/post-4.jpg" alt="" class="blog-thumb">
      <h3>Fourth Post</h3>
    </div>
  </div>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// extractAttr
// ---------------------------------------------------------------------------

describe("extractAttr", () => {
  it("extracts double-quoted attribute", () => {
    expect(extractAttr('<img alt="hello world">', "alt")).toBe("hello world");
  });

  it("extracts single-quoted attribute", () => {
    expect(extractAttr("<img alt='hello'>", "alt")).toBe("hello");
  });

  it("extracts empty attribute", () => {
    expect(extractAttr('<img alt="">', "alt")).toBe("");
  });

  it("returns null when attribute is absent", () => {
    expect(extractAttr("<img src='test.jpg'>", "alt")).toBeNull();
  });

  it("extracts src attribute", () => {
    expect(extractAttr('<img src="test.jpg" alt="test">', "src")).toBe("test.jpg");
  });
});

// ---------------------------------------------------------------------------
// collectImages
// ---------------------------------------------------------------------------

describe("collectImages", () => {
  it("collects all images from DOM", () => {
    const images = collectImages(BASIC_HTML);
    expect(images.length).toBe(6);
  });

  it("extracts alt text correctly", () => {
    const images = collectImages(BASIC_HTML);
    const hero = images.find((i) => i.html.includes("hero.jpg"));
    expect(hero).toBeDefined();
    expect(hero!.alt).toBe("Team working together in an office");
  });

  it("detects empty alt", () => {
    const images = collectImages(BASIC_HTML);
    const decorative = images.find((i) => i.html.includes("decoration.png"));
    expect(decorative).toBeDefined();
    expect(decorative!.alt).toBe("");
  });

  it("detects missing alt (no attribute at all)", () => {
    const images = collectImages(BASIC_HTML);
    const chart = images.find((i) => i.html.includes("chart.png"));
    expect(chart).toBeDefined();
    expect(chart!.alt).toBeNull();
  });

  it("detects filename as alt", () => {
    const images = collectImages(BASIC_HTML);
    const product = images.find((i) => i.html.includes("product.jpg"));
    expect(product).toBeDefined();
    expect(product!.alt).toBe("IMG_20230415.jpg");
  });

  it("detects images inside links", () => {
    const images = collectImages(BASIC_HTML);
    const ctaIcon = images.find((i) => i.html.includes("cta-arrow.svg"));
    expect(ctaIcon).toBeDefined();
    expect(ctaIcon!.isInsideFunctional).toBe(true);
  });

  it("marks non-functional images correctly", () => {
    const images = collectImages(BASIC_HTML);
    const hero = images.find((i) => i.html.includes("hero.jpg"));
    expect(hero).toBeDefined();
    expect(hero!.isInsideFunctional).toBe(false);
  });

  it("marks axe-flagged images", () => {
    const flagged = new Set(["img.chart-img"]);
    const images = collectImages(BASIC_HTML, flagged);
    const chart = images.find((i) => i.html.includes("chart.png"));
    expect(chart).toBeDefined();
    expect(chart!.axeFlagged).toBe(true);
  });

  it("collects surrounding context", () => {
    const images = collectImages(BASIC_HTML);
    const hero = images.find((i) => i.html.includes("hero.jpg"));
    expect(hero).toBeDefined();
    expect(hero!.surroundingContext.length).toBeGreaterThan(0);
  });

  it("extracts src for dedup", () => {
    const images = collectImages(BASIC_HTML);
    const hero = images.find((i) => i.html.includes("hero.jpg"));
    expect(hero!.src).toBe("hero.jpg");
  });
});

// ---------------------------------------------------------------------------
// deduplicateCmsImages
// ---------------------------------------------------------------------------

describe("deduplicateCmsImages", () => {
  it("deduplicates images with identical alt patterns", () => {
    const images = collectImages(CMS_COLLECTION_HTML);
    // Should have 4 images
    expect(images.length).toBe(4);

    const deduped = deduplicateCmsImages(images);
    // "Blog post thumbnail" appears 3 times → 1 kept
    // "" appears 1 time → 1 kept
    expect(deduped.length).toBe(2);
  });

  it("keeps distinct alt patterns", () => {
    const images: ImageContext[] = [
      { selector: "img.a", html: '<img alt="Cat">', alt: "Cat", surroundingContext: "", isInsideFunctional: false, axeFlagged: false, src: "a.jpg" },
      { selector: "img.b", html: '<img alt="Dog">', alt: "Dog", surroundingContext: "", isInsideFunctional: false, axeFlagged: false, src: "b.jpg" },
      { selector: "img.c", html: '<img alt="Cat">', alt: "Cat", surroundingContext: "", isInsideFunctional: false, axeFlagged: false, src: "c.jpg" },
    ];
    const deduped = deduplicateCmsImages(images);
    expect(deduped.length).toBe(2);
  });

  it("treats null alt differently from empty alt", () => {
    const images: ImageContext[] = [
      { selector: "img.a", html: '<img>', alt: null, surroundingContext: "", isInsideFunctional: false, axeFlagged: false, src: "a.jpg" },
      { selector: "img.b", html: '<img alt="">', alt: "", surroundingContext: "", isInsideFunctional: false, axeFlagged: false, src: "b.jpg" },
    ];
    const deduped = deduplicateCmsImages(images);
    expect(deduped.length).toBe(2);
  });

  it("returns empty for empty input", () => {
    expect(deduplicateCmsImages([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runAltTextChecks — mocked PromptRunner
// ---------------------------------------------------------------------------

describe("runAltTextChecks", () => {
  let mockRunner: PromptRunner;
  let runPromptsSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRunner = new PromptRunner("test-key", { max_retries: 0 });

    // Default mock: returns fail for all prompts
    runPromptsSpy = vi.fn().mockResolvedValue([]);
    mockRunner.runPrompts = runPromptsSpy;
  });

  it("skips images flagged by axe-core", async () => {
    const html = '<html><body><img src="no-alt.jpg" class="flagged"></body></html>';
    const axeFlagged = new Set(["img.flagged"]);

    runPromptsSpy.mockResolvedValue([]);
    const results = await runAltTextChecks(html, mockRunner, {
      axeFlaggedSelectors: axeFlagged,
    });

    // Should not call Claude for flagged images — runPrompts not called at all
    expect(runPromptsSpy).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("returns CheckResult for failed images", async () => {
    const html = '<html><body><img src="test.jpg" alt="IMG_001.jpg"></body></html>';

    const failResult = {
      success: true,
      data: {
        verdict: "fail" as const,
        confidence: 0.9,
        reasoning: "Alt text appears to be a filename",
        wcag_criterion: "1.1.1",
        failure_type: "filename_as_alt",
        suggestion: "Replace with descriptive alt text",
        affected_users: ["screen_reader"],
        requires_human_verification: false,
      },
      rawResponse: "{}",
      model: "claude-sonnet-4-6",
      tokensUsed: 100,
      latencyMs: 500,
      retries: 0,
    };

    runPromptsSpy.mockResolvedValue([failResult]);

    const results = await runAltTextChecks(html, mockRunner);
    expect(results.length).toBe(1);
    expect(results[0].wcag_criterion).toBe("1.1.1");
    expect(results[0].detected_by).toBe("claude_api");
    expect(results[0].measured_values?.failure_type).toBe("filename_as_alt");
  });

  it("does not return CheckResult for passing images", async () => {
    const html = '<html><body><img src="test.jpg" alt="A team meeting in progress"></body></html>';

    const passResult = {
      success: true,
      data: {
        verdict: "pass" as const,
        confidence: 0.95,
        reasoning: "Alt text is descriptive",
        wcag_criterion: "1.1.1",
        failure_type: null,
        suggestion: null,
        affected_users: [],
        requires_human_verification: false,
      },
      rawResponse: "{}",
      model: "claude-sonnet-4-6",
      tokensUsed: 100,
      latencyMs: 500,
      retries: 0,
    };

    runPromptsSpy.mockResolvedValue([passResult]);

    const results = await runAltTextChecks(html, mockRunner);
    expect(results.length).toBe(0);
  });

  it("returns needs_review for API failures", async () => {
    const html = '<html><body><img src="test.jpg" alt="test"></body></html>';

    const failedResult = {
      success: false,
      data: null,
      rawResponse: "",
      model: "claude-sonnet-4-6",
      tokensUsed: 0,
      latencyMs: 0,
      retries: 2,
      error: "API error",
    };

    runPromptsSpy.mockResolvedValue([failedResult]);

    const results = await runAltTextChecks(html, mockRunner);
    expect(results.length).toBe(1);
    expect((results[0].raw_result as AltTextEvaluation).verdict).toBe("needs_review");
  });

  it("deduplicates CMS images by default", async () => {
    runPromptsSpy.mockResolvedValue([
      {
        success: true,
        data: {
          verdict: "fail",
          confidence: 0.85,
          reasoning: "Generic thumbnail alt text",
          wcag_criterion: "1.1.1",
          failure_type: "alt_not_descriptive",
          suggestion: "Use unique alt text per image",
          affected_users: ["screen_reader"],
          requires_human_verification: false,
        },
        rawResponse: "{}",
        model: "claude-sonnet-4-6",
        tokensUsed: 100,
        latencyMs: 500,
        retries: 0,
      },
      {
        success: true,
        data: {
          verdict: "fail",
          confidence: 0.8,
          reasoning: "Empty alt on informative image",
          wcag_criterion: "1.1.1",
          failure_type: "empty_alt_on_informative",
          suggestion: "Add descriptive alt text",
          affected_users: ["screen_reader"],
          requires_human_verification: true,
        },
        rawResponse: "{}",
        model: "claude-sonnet-4-6",
        tokensUsed: 100,
        latencyMs: 500,
        retries: 0,
      },
    ]);

    const results = await runAltTextChecks(CMS_COLLECTION_HTML, mockRunner);

    // CMS dedup: 3 "Blog post thumbnail" → 1, 1 "" → 1 = 2 prompts sent
    expect(runPromptsSpy).toHaveBeenCalledTimes(1);
    const promptInputs = runPromptsSpy.mock.calls[0][0];
    expect(promptInputs.length).toBe(2);
  });

  it("skips deduplication when disabled", async () => {
    // Return pass for all
    runPromptsSpy.mockImplementation((inputs: unknown[]) =>
      Promise.resolve(
        (inputs as unknown[]).map(() => ({
          success: true,
          data: {
            verdict: "pass",
            confidence: 0.9,
            reasoning: "OK",
            wcag_criterion: "1.1.1",
            failure_type: null,
            suggestion: null,
            affected_users: [],
            requires_human_verification: false,
          },
          rawResponse: "{}",
          model: "claude-sonnet-4-6",
          tokensUsed: 100,
          latencyMs: 500,
          retries: 0,
        })),
      ),
    );

    await runAltTextChecks(CMS_COLLECTION_HTML, mockRunner, {
      deduplicateCms: false,
    });

    const promptInputs = runPromptsSpy.mock.calls[0][0];
    expect(promptInputs.length).toBe(4); // All 4 images
  });

  it("handles empty DOM with no images", async () => {
    const results = await runAltTextChecks("<html><body></body></html>", mockRunner);
    expect(results).toEqual([]);
    expect(runPromptsSpy).not.toHaveBeenCalled();
  });

  it("sends correct prompt template", async () => {
    const html = '<html><body><img src="test.jpg" alt="test alt"></body></html>';

    runPromptsSpy.mockResolvedValue([{
      success: true,
      data: { verdict: "pass", confidence: 0.9, reasoning: "OK", wcag_criterion: "1.1.1", failure_type: null, suggestion: null, affected_users: [], requires_human_verification: false },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    }]);

    await runAltTextChecks(html, mockRunner);

    const inputs = runPromptsSpy.mock.calls[0][0];
    expect(inputs[0].template.name).toBe("alt_text_quality");
    expect(inputs[0].template.vision).toBe(true);
    expect(inputs[0].userMessage).toContain("test alt");
    expect(inputs[0].userMessage).toContain("1.1.1");
  });

  it("detects all 8 failure modes via Claude evaluation", async () => {
    // Verify all failure modes are handled by checking they appear in raw_result
    const failureModes = [
      "missing_alt", "empty_alt_on_informative", "decorative_not_marked",
      "filename_as_alt", "placeholder_alt", "alt_too_long",
      "alt_not_descriptive", "redundant_alt",
    ];

    for (const mode of failureModes) {
      runPromptsSpy.mockResolvedValue([{
        success: true,
        data: {
          verdict: "fail",
          confidence: 0.85,
          reasoning: `Failure: ${mode}`,
          wcag_criterion: "1.1.1",
          failure_type: mode,
          suggestion: "Fix it",
          affected_users: ["screen_reader"],
          requires_human_verification: false,
        },
        rawResponse: "{}",
        model: "claude-sonnet-4-6",
        tokensUsed: 100,
        latencyMs: 500,
        retries: 0,
      }]);

      const html = `<html><body><img src="test.jpg" alt="test"></body></html>`;
      const results = await runAltTextChecks(html, mockRunner);
      expect(results.length).toBe(1);
      expect(results[0].measured_values?.failure_type).toBe(mode);
    }
  });

  it("includes screenshot in prompt when provided", async () => {
    const html = '<html><body><img id="myimg" src="test.jpg" alt="test"></body></html>';

    runPromptsSpy.mockResolvedValue([{
      success: true,
      data: { verdict: "pass", confidence: 0.9, reasoning: "OK", wcag_criterion: "1.1.1", failure_type: null, suggestion: null, affected_users: [], requires_human_verification: false },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    }]);

    await runAltTextChecks(html, mockRunner, {
      screenshotProvider: async () => "base64screenshot",
    });

    const inputs = runPromptsSpy.mock.calls[0][0];
    expect(inputs[0].imageBase64).toBe("base64screenshot");
    expect(inputs[0].imageMediaType).toBe("image/png");
  });

  it("returns needs_review result when runner returns fallback data", async () => {
    const html = '<html><body><img src="test.jpg" alt="test"></body></html>';

    runPromptsSpy.mockResolvedValue([{
      success: false,
      data: {
        verdict: "needs_review",
        confidence: 0.0,
        reasoning: "Prompt evaluation failed after 2 retries",
        requires_human_verification: true,
        wcag_criterion: "1.1.1",
        failure_type: null,
        suggestion: null,
        affected_users: [],
      },
      rawResponse: "",
      model: "claude-sonnet-4-6",
      tokensUsed: 0,
      latencyMs: 0,
      retries: 2,
      error: "Parse error",
    }]);

    const results = await runAltTextChecks(html, mockRunner);
    expect(results.length).toBe(1);
    expect((results[0].raw_result as AltTextEvaluation).verdict).toBe("needs_review");
  });
});
