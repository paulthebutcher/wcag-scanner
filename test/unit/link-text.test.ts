import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  collectLinks,
  deduplicateCmsLinks,
  hasDescriptiveAriaLabel,
  runLinkTextChecks,
  type LinkContext,
  type LinkTextEvaluation,
} from "../../src/checks/semantic/link-text.js";
import { PromptRunner } from "../../src/core/prompt-runner.js";

// ---------------------------------------------------------------------------
// Test HTML
// ---------------------------------------------------------------------------

const BASIC_HTML = `
<html>
<body>
  <nav>
    <a href="/" class="nav-link">Home</a>
    <a href="/about" class="nav-link">About Us</a>
    <a href="/contact" class="nav-link">Contact</a>
  </nav>
  <main>
    <p>Welcome to our site. <a href="/products">Click here</a> to see products.</p>
    <p>Read about our <a href="/services" aria-label="Our professional services page">services</a>.</p>
    <p>Visit <a href="https://example.com/very/long/url">https://example.com/very/long/url</a> for more.</p>
    <a href="/gallery"><img src="gallery-icon.png" alt=""></a>
    <a href="/signup" id="signup-link">Sign up for a free trial</a>
    <a href="/download" aria-label="Download our whitepaper"><img src="download.svg" alt="download icon">Download</a>
  </main>
</body>
</html>
`;

const CMS_LINKS_HTML = `
<html>
<body>
  <div class="w-dyn-items">
    <div class="w-dyn-item"><a href="/blog/post-1" class="blog-link">Read more</a></div>
    <div class="w-dyn-item"><a href="/blog/post-2" class="blog-link">Read more</a></div>
    <div class="w-dyn-item"><a href="/blog/post-3" class="blog-link">Read more</a></div>
    <div class="w-dyn-item"><a href="/blog/post-4" class="blog-link">Learn more</a></div>
  </div>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// collectLinks
// ---------------------------------------------------------------------------

describe("collectLinks", () => {
  it("collects all links from DOM", () => {
    const links = collectLinks(BASIC_HTML);
    expect(links.length).toBe(9);
  });

  it("extracts visible text", () => {
    const links = collectLinks(BASIC_HTML);
    const home = links.find((l) => l.href === "/");
    expect(home).toBeDefined();
    expect(home!.visibleText).toBe("Home");
  });

  it("extracts href", () => {
    const links = collectLinks(BASIC_HTML);
    const about = links.find((l) => l.visibleText === "About Us");
    expect(about!.href).toBe("/about");
  });

  it("extracts aria-label", () => {
    const links = collectLinks(BASIC_HTML);
    const services = links.find((l) => l.href === "/services");
    expect(services).toBeDefined();
    expect(services!.ariaLabel).toBe("Our professional services page");
  });

  it("detects image-only links", () => {
    const links = collectLinks(BASIC_HTML);
    const gallery = links.find((l) => l.href === "/gallery");
    expect(gallery).toBeDefined();
    expect(gallery!.isImageLink).toBe(true);
    expect(gallery!.imageAlt).toBe("");
  });

  it("detects non-image links with images inside", () => {
    const links = collectLinks(BASIC_HTML);
    const download = links.find((l) => l.href === "/download");
    expect(download).toBeDefined();
    // Has visible text "Download" alongside the image
    expect(download!.isImageLink).toBe(false);
    expect(download!.visibleText).toContain("Download");
  });

  it("extracts surrounding context", () => {
    const links = collectLinks(BASIC_HTML);
    const clickHere = links.find((l) => l.visibleText === "Click here");
    expect(clickHere).toBeDefined();
    expect(clickHere!.surroundingContext.length).toBeGreaterThan(0);
    expect(clickHere!.surroundingContext).toContain("products");
  });

  it("builds selectors from id", () => {
    const links = collectLinks(BASIC_HTML);
    const signup = links.find((l) => l.href === "/signup");
    expect(signup!.selector).toBe("a#signup-link");
  });

  it("builds selectors from class", () => {
    const links = collectLinks(BASIC_HTML);
    const nav = links.find((l) => l.href === "/");
    expect(nav!.selector).toBe("a.nav-link");
  });
});

// ---------------------------------------------------------------------------
// deduplicateCmsLinks
// ---------------------------------------------------------------------------

describe("deduplicateCmsLinks", () => {
  it("deduplicates links with identical visible text", () => {
    const links = collectLinks(CMS_LINKS_HTML);
    expect(links.length).toBe(4);

    const deduped = deduplicateCmsLinks(links);
    // "Read more" x3 → 1, "Learn more" x1 → 1
    expect(deduped.length).toBe(2);
  });

  it("keeps distinct text patterns", () => {
    const links: LinkContext[] = [
      { selector: "a.a", html: '<a href="/a">View</a>', visibleText: "View", href: "/a", ariaLabel: null, surroundingContext: "", isImageLink: false, imageAlt: null },
      { selector: "a.b", html: '<a href="/b">Details</a>', visibleText: "Details", href: "/b", ariaLabel: null, surroundingContext: "", isImageLink: false, imageAlt: null },
      { selector: "a.c", html: '<a href="/c">View</a>', visibleText: "View", href: "/c", ariaLabel: null, surroundingContext: "", isImageLink: false, imageAlt: null },
    ];
    const deduped = deduplicateCmsLinks(links);
    expect(deduped.length).toBe(2);
  });

  it("returns empty for empty input", () => {
    expect(deduplicateCmsLinks([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// hasDescriptiveAriaLabel
// ---------------------------------------------------------------------------

describe("hasDescriptiveAriaLabel", () => {
  it("returns true for descriptive aria-label", () => {
    const link: LinkContext = {
      selector: "a", html: "<a>x</a>", visibleText: "Read more", href: "/x",
      ariaLabel: "Read more about our accessibility services",
      surroundingContext: "", isImageLink: false, imageAlt: null,
    };
    expect(hasDescriptiveAriaLabel(link)).toBe(true);
  });

  it("returns false when no aria-label", () => {
    const link: LinkContext = {
      selector: "a", html: "<a>x</a>", visibleText: "Click here", href: "/x",
      ariaLabel: null,
      surroundingContext: "", isImageLink: false, imageAlt: null,
    };
    expect(hasDescriptiveAriaLabel(link)).toBe(false);
  });

  it("returns false for generic aria-labels", () => {
    const genericLabels = ["click here", "Read more", "Learn more", "link", "here", "more", "Go"];
    for (const label of genericLabels) {
      const link: LinkContext = {
        selector: "a", html: "<a>x</a>", visibleText: "x", href: "/x",
        ariaLabel: label,
        surroundingContext: "", isImageLink: false, imageAlt: null,
      };
      expect(hasDescriptiveAriaLabel(link)).toBe(false);
    }
  });

  it("returns false for empty aria-label", () => {
    const link: LinkContext = {
      selector: "a", html: "<a>x</a>", visibleText: "x", href: "/x",
      ariaLabel: "",
      surroundingContext: "", isImageLink: false, imageAlt: null,
    };
    expect(hasDescriptiveAriaLabel(link)).toBe(false);
  });

  it("returns false for whitespace-only aria-label", () => {
    const link: LinkContext = {
      selector: "a", html: "<a>x</a>", visibleText: "x", href: "/x",
      ariaLabel: "   ",
      surroundingContext: "", isImageLink: false, imageAlt: null,
    };
    expect(hasDescriptiveAriaLabel(link)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runLinkTextChecks — mocked PromptRunner
// ---------------------------------------------------------------------------

describe("runLinkTextChecks", () => {
  let mockRunner: PromptRunner;
  let runPromptsSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRunner = new PromptRunner("test-key", { max_retries: 0 });
    runPromptsSpy = vi.fn().mockResolvedValue([]);
    mockRunner.runPrompts = runPromptsSpy;
  });

  it("sends links to Claude for evaluation", async () => {
    const html = '<html><body><a href="/test">Click here</a></body></html>';

    runPromptsSpy.mockResolvedValue([{
      success: true,
      data: {
        verdict: "fail",
        confidence: 0.92,
        reasoning: "Generic link text",
        wcag_criterion: "2.4.4",
        failure_type: "generic_link_text",
        suggestion: "Use descriptive text",
        affected_users: ["screen_reader"],
        requires_human_verification: false,
      },
      rawResponse: "{}",
      model: "claude-sonnet-4-6",
      tokensUsed: 100,
      latencyMs: 500,
      retries: 0,
    }]);

    const results = await runLinkTextChecks(html, mockRunner);
    expect(results.length).toBe(1);
    expect(results[0].wcag_criterion).toBe("2.4.4");
    expect(results[0].detected_by).toBe("claude_api");
    expect(results[0].measured_values?.failure_type).toBe("generic_link_text");
  });

  it("skips links with descriptive aria-labels", async () => {
    const html = '<html><body><a href="/x" aria-label="View our complete product catalog">Read more</a></body></html>';

    const results = await runLinkTextChecks(html, mockRunner);
    expect(runPromptsSpy).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("does NOT skip links with generic aria-labels", async () => {
    const html = '<html><body><a href="/x" aria-label="click here">Go</a></body></html>';

    runPromptsSpy.mockResolvedValue([{
      success: true,
      data: {
        verdict: "fail",
        confidence: 0.9,
        reasoning: "Generic text",
        wcag_criterion: "2.4.4",
        failure_type: "generic_link_text",
        suggestion: "Fix",
        affected_users: ["screen_reader"],
        requires_human_verification: false,
      },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    }]);

    const results = await runLinkTextChecks(html, mockRunner);
    expect(runPromptsSpy).toHaveBeenCalled();
    expect(results.length).toBe(1);
  });

  it("does not return CheckResult for passing links", async () => {
    const html = '<html><body><a href="/products">View all products</a></body></html>';

    runPromptsSpy.mockResolvedValue([{
      success: true,
      data: {
        verdict: "pass",
        confidence: 0.95,
        reasoning: "Descriptive link text",
        wcag_criterion: "2.4.4",
        failure_type: null,
        suggestion: null,
        affected_users: [],
        requires_human_verification: false,
      },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    }]);

    const results = await runLinkTextChecks(html, mockRunner);
    expect(results.length).toBe(0);
  });

  it("detects all 5 failure modes", async () => {
    const failureModes = [
      "generic_link_text",
      "url_as_link_text",
      "ambiguous_without_context",
      "empty_link",
      "image_link_no_alt",
    ];

    for (const mode of failureModes) {
      runPromptsSpy.mockResolvedValue([{
        success: true,
        data: {
          verdict: "fail",
          confidence: 0.85,
          reasoning: `Failure: ${mode}`,
          wcag_criterion: "2.4.4",
          failure_type: mode,
          suggestion: "Fix it",
          affected_users: ["screen_reader"],
          requires_human_verification: false,
        },
        rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
      }]);

      const html = '<html><body><a href="/x">test</a></body></html>';
      const results = await runLinkTextChecks(html, mockRunner);
      expect(results.length).toBe(1);
      expect(results[0].measured_values?.failure_type).toBe(mode);
    }
  });

  it("deduplicates CMS links by default", async () => {
    runPromptsSpy.mockImplementation((inputs: unknown[]) =>
      Promise.resolve(
        (inputs as unknown[]).map(() => ({
          success: true,
          data: {
            verdict: "fail",
            confidence: 0.9,
            reasoning: "Generic",
            wcag_criterion: "2.4.4",
            failure_type: "generic_link_text",
            suggestion: "Fix",
            affected_users: ["screen_reader"],
            requires_human_verification: false,
          },
          rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
        })),
      ),
    );

    await runLinkTextChecks(CMS_LINKS_HTML, mockRunner);

    // "Read more" x3 → 1, "Learn more" x1 → 1 = 2 prompts
    const inputs = runPromptsSpy.mock.calls[0][0];
    expect(inputs.length).toBe(2);
  });

  it("handles empty DOM with no links", async () => {
    const results = await runLinkTextChecks("<html><body></body></html>", mockRunner);
    expect(results).toEqual([]);
    expect(runPromptsSpy).not.toHaveBeenCalled();
  });

  it("returns needs_review for API failures", async () => {
    const html = '<html><body><a href="/x">test</a></body></html>';

    runPromptsSpy.mockResolvedValue([{
      success: false,
      data: null,
      rawResponse: "",
      model: "claude-sonnet-4-6",
      tokensUsed: 0,
      latencyMs: 0,
      retries: 2,
      error: "API error",
    }]);

    const results = await runLinkTextChecks(html, mockRunner);
    expect(results.length).toBe(1);
    expect((results[0].raw_result as LinkTextEvaluation).verdict).toBe("needs_review");
  });

  it("sends correct prompt template", async () => {
    const html = '<html><body><a href="/test">Click here</a></body></html>';

    runPromptsSpy.mockResolvedValue([{
      success: true,
      data: { verdict: "pass", confidence: 0.9, reasoning: "OK", wcag_criterion: "2.4.4", failure_type: null, suggestion: null, affected_users: [], requires_human_verification: false },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    }]);

    await runLinkTextChecks(html, mockRunner);

    const inputs = runPromptsSpy.mock.calls[0][0];
    expect(inputs[0].template.name).toBe("link_text_quality");
    expect(inputs[0].template.vision).toBe(false);
    expect(inputs[0].userMessage).toContain("Click here");
    expect(inputs[0].userMessage).toContain("2.4.4");
  });

  it("includes aria_attributes in CheckResult when present", async () => {
    const html = '<html><body><a href="/x" aria-label="go">test</a></body></html>';

    runPromptsSpy.mockResolvedValue([{
      success: true,
      data: {
        verdict: "fail",
        confidence: 0.9,
        reasoning: "Generic",
        wcag_criterion: "2.4.4",
        failure_type: "generic_link_text",
        suggestion: "Fix",
        affected_users: ["screen_reader"],
        requires_human_verification: false,
      },
      rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
    }]);

    const results = await runLinkTextChecks(html, mockRunner);
    expect(results[0].aria_attributes).toEqual({ "aria-label": "go" });
  });

  it("passes full link list to prompt for duplicate detection across page", async () => {
    const html = `<html><body>
      <a href="/a">Click here</a>
      <a href="/b">Click here</a>
      <a href="/c">Learn more</a>
    </body></html>`;

    runPromptsSpy.mockImplementation((inputs: unknown[]) =>
      Promise.resolve(
        (inputs as unknown[]).map(() => ({
          success: true,
          data: { verdict: "pass", confidence: 0.9, reasoning: "OK", wcag_criterion: "2.4.4", failure_type: null, suggestion: null, affected_users: [], requires_human_verification: false },
          rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
        })),
      ),
    );

    // With dedup enabled (default), "Click here" x2 → 1
    await runLinkTextChecks(html, mockRunner);
    const inputs = runPromptsSpy.mock.calls[0][0];
    expect(inputs.length).toBe(2); // "Click here" and "Learn more"

    // With dedup disabled, all 3 links sent
    runPromptsSpy.mockClear();
    runPromptsSpy.mockImplementation((inputs: unknown[]) =>
      Promise.resolve(
        (inputs as unknown[]).map(() => ({
          success: true,
          data: { verdict: "pass", confidence: 0.9, reasoning: "OK", wcag_criterion: "2.4.4", failure_type: null, suggestion: null, affected_users: [], requires_human_verification: false },
          rawResponse: "{}", model: "claude-sonnet-4-6", tokensUsed: 100, latencyMs: 500, retries: 0,
        })),
      ),
    );
    await runLinkTextChecks(html, mockRunner, { deduplicateCms: false });
    const inputs2 = runPromptsSpy.mock.calls[0][0];
    expect(inputs2.length).toBe(3);
  });
});
