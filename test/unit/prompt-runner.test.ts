import { describe, it, expect, vi } from "vitest";
import {
  buildMessages,
  parseEvaluation,
  resolveModelId,
  PromptRunner,
  createPromptRunner,
  type PromptTemplate,
  type PromptInput,
  type PromptLogEntry,
} from "../../src/core/prompt-runner.js";

// ---------------------------------------------------------------------------
// Test prompt template
// ---------------------------------------------------------------------------

const testTemplate: PromptTemplate = {
  name: "test_prompt",
  family: "element_evaluation",
  model: "sonnet",
  vision: false,
  systemPrompt: "You are a WCAG accessibility evaluator.",
  outputSchema: {
    type: "object",
    properties: {
      verdict: { type: "string" },
      confidence: { type: "number" },
    },
  },
};

const visionTemplate: PromptTemplate = {
  ...testTemplate,
  name: "vision_prompt",
  vision: true,
};

const opusTemplate: PromptTemplate = {
  ...testTemplate,
  name: "opus_prompt",
  model: "opus",
  family: "synthesis",
};

// ---------------------------------------------------------------------------
// resolveModelId
// ---------------------------------------------------------------------------

describe("resolveModelId", () => {
  it("resolves sonnet to claude-sonnet-4-6", () => {
    expect(resolveModelId("sonnet")).toBe("claude-sonnet-4-6");
  });

  it("resolves opus to claude-opus-4-6", () => {
    expect(resolveModelId("opus")).toBe("claude-opus-4-6");
  });
});

// ---------------------------------------------------------------------------
// buildMessages
// ---------------------------------------------------------------------------

describe("buildMessages", () => {
  it("builds text-only messages", () => {
    const input: PromptInput = {
      template: testTemplate,
      userMessage: "Evaluate this alt text",
    };

    const params = buildMessages(input);

    expect(params.model).toBe("claude-sonnet-4-6");
    expect(params.temperature).toBe(0);
    expect(params.max_tokens).toBe(4096);
    expect(params.system).toBe("You are a WCAG accessibility evaluator.");
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0].role).toBe("user");

    const content = params.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(1);
    expect((content as Array<{ type: string }>)[0].type).toBe("text");
  });

  it("builds vision messages with image block", () => {
    const input: PromptInput = {
      template: visionTemplate,
      userMessage: "Evaluate this element",
      imageBase64: "iVBORw0KGgo=",
      imageMediaType: "image/png",
    };

    const params = buildMessages(input);

    const content = params.messages[0].content as Array<{ type: string }>;
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe("image");
    expect(content[1].type).toBe("text");
  });

  it("skips image block when no imageBase64 provided", () => {
    const input: PromptInput = {
      template: visionTemplate,
      userMessage: "Evaluate this element",
      // no imageBase64
    };

    const params = buildMessages(input);

    const content = params.messages[0].content as Array<{ type: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
  });

  it("uses opus model for opus templates", () => {
    const input: PromptInput = {
      template: opusTemplate,
      userMessage: "Generate executive summary",
    };

    const params = buildMessages(input);
    expect(params.model).toBe("claude-opus-4-6");
  });

  it("always sets temperature to 0", () => {
    const input: PromptInput = {
      template: testTemplate,
      userMessage: "Test",
    };

    const params = buildMessages(input);
    expect(params.temperature).toBe(0);
  });

  it("defaults image media type to image/png", () => {
    const input: PromptInput = {
      template: visionTemplate,
      userMessage: "Evaluate",
      imageBase64: "abc123",
    };

    const params = buildMessages(input);
    const content = params.messages[0].content as Array<Record<string, unknown>>;
    const imageBlock = content[0] as { source: { media_type: string } };
    expect(imageBlock.source.media_type).toBe("image/png");
  });
});

// ---------------------------------------------------------------------------
// parseEvaluation
// ---------------------------------------------------------------------------

describe("parseEvaluation", () => {
  it("parses plain JSON", () => {
    const json = '{"verdict": "fail", "confidence": 0.85}';
    const result = parseEvaluation<{ verdict: string; confidence: number }>(json);
    expect(result.verdict).toBe("fail");
    expect(result.confidence).toBe(0.85);
  });

  it("parses JSON from markdown code block", () => {
    const response = '```json\n{"verdict": "pass", "confidence": 0.95}\n```';
    const result = parseEvaluation<{ verdict: string }>(response);
    expect(result.verdict).toBe("pass");
  });

  it("parses JSON from code block without language tag", () => {
    const response = '```\n{"verdict": "needs_review"}\n```';
    const result = parseEvaluation<{ verdict: string }>(response);
    expect(result.verdict).toBe("needs_review");
  });

  it("extracts JSON object from mixed text", () => {
    const response = 'Here is my analysis:\n{"verdict": "fail", "reasoning": "missing alt"}\nEnd.';
    const result = parseEvaluation<{ verdict: string }>(response);
    expect(result.verdict).toBe("fail");
  });

  it("throws on non-JSON text", () => {
    expect(() => parseEvaluation("This is not JSON at all.")).toThrow(
      /Failed to parse evaluation response/,
    );
  });

  it("parses arrays", () => {
    const json = '[{"id": 1}, {"id": 2}]';
    const result = parseEvaluation<Array<{ id: number }>>(json);
    expect(result).toHaveLength(2);
  });

  it("parses complex nested objects", () => {
    const json = JSON.stringify({
      verdict: "fail",
      confidence: 0.8,
      reasoning: "The alt text is a filename",
      failure_type: "filename_as_alt",
      affected_users: ["screen_reader", "low_vision"],
      requires_human_verification: false,
    });
    const result = parseEvaluation<{ verdict: string; affected_users: string[] }>(json);
    expect(result.verdict).toBe("fail");
    expect(result.affected_users).toContain("screen_reader");
  });
});

// ---------------------------------------------------------------------------
// PromptRunner — unit tests (mocked API)
// ---------------------------------------------------------------------------

describe("PromptRunner", () => {
  it("creates with default config", () => {
    const runner = new PromptRunner("test-key");
    const config = runner.getConfig();
    expect(config.mode).toBe("realtime");
    expect(config.max_retries).toBe(2);
    expect(config.concurrency).toBe(5);
    expect(config.fallback_on_failure).toBe("needs_review");
  });

  it("creates with custom config", () => {
    const runner = new PromptRunner("test-key", {
      mode: "batch",
      max_retries: 3,
      concurrency: 10,
      fallback_on_failure: "skip",
    });
    const config = runner.getConfig();
    expect(config.mode).toBe("batch");
    expect(config.max_retries).toBe(3);
    expect(config.concurrency).toBe(10);
    expect(config.fallback_on_failure).toBe("skip");
  });

  it("queues prompts in batch mode", async () => {
    const runner = new PromptRunner("test-key", { mode: "batch" });
    const input: PromptInput = {
      template: testTemplate,
      userMessage: "Test",
    };

    // Start the prompt (it will be queued, not executed)
    const promise = runner.runPrompt(input);
    expect(runner.getBatchQueueSize()).toBe(1);

    // Add another
    const promise2 = runner.runPrompt(input);
    expect(runner.getBatchQueueSize()).toBe(2);

    // Note: we can't flush without a real API key, so just verify queuing works
    // In a real test we'd mock the Anthropic client
  });

  it("returns empty batch on flush with no queued items", async () => {
    const runner = new PromptRunner("test-key", { mode: "batch" });
    const result = await runner.flushBatch();
    expect(result.count).toBe(0);
    expect(result.batchId).toBe("");
  });
});

// ---------------------------------------------------------------------------
// createPromptRunner factory
// ---------------------------------------------------------------------------

describe("createPromptRunner", () => {
  it("creates a runner with default options", () => {
    const runner = createPromptRunner("test-key");
    const config = runner.getConfig();
    expect(config.mode).toBe("realtime");
    expect(config.max_retries).toBe(2);
    expect(config.concurrency).toBe(5);
  });

  it("creates a runner with custom options", () => {
    const runner = createPromptRunner("test-key", {
      mode: "batch",
      maxRetries: 1,
      concurrency: 3,
      fallbackOnFailure: "skip",
    });
    const config = runner.getConfig();
    expect(config.mode).toBe("batch");
    expect(config.max_retries).toBe(1);
    expect(config.concurrency).toBe(3);
    expect(config.fallback_on_failure).toBe("skip");
  });

  it("accepts a logger", () => {
    const logs: PromptLogEntry[] = [];
    const runner = createPromptRunner("test-key", {
      logger: { log: (entry) => logs.push(entry) },
    });
    // Logger is attached — we'd verify it during actual API calls
    expect(runner).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// PromptRunner — retry behavior (mocked)
// ---------------------------------------------------------------------------

describe("PromptRunner retry behavior", () => {
  it("returns needs_review fallback when API key is invalid", async () => {
    const runner = new PromptRunner("invalid-key", {
      max_retries: 0, // don't retry
      fallback_on_failure: "needs_review",
    });

    const input: PromptInput = {
      template: testTemplate,
      userMessage: "Test",
    };

    const result = await runner.runPrompt(input);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns skip fallback when configured", async () => {
    const runner = new PromptRunner("invalid-key", {
      max_retries: 0,
      fallback_on_failure: "skip",
    });

    const input: PromptInput = {
      template: testTemplate,
      userMessage: "Test",
    };

    const result = await runner.runPrompt(input);
    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
  });

  it("logs failed attempts", async () => {
    const logs: PromptLogEntry[] = [];
    const runner = new PromptRunner("invalid-key", {
      max_retries: 0,
    }, { log: (entry) => logs.push(entry) });

    const input: PromptInput = {
      template: testTemplate,
      userMessage: "Test",
    };

    await runner.runPrompt(input);

    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].promptName).toBe("test_prompt");
    expect(logs[0].success).toBe(false);
  });
});
