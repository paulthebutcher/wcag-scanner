import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { PromptRunnerConfig, PromptMode } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Identifies which model to use for a given prompt */
export type ModelRoute = "sonnet" | "opus";

/** A prompt template definition that the runner knows how to execute */
export interface PromptTemplate {
  /** Unique prompt name, e.g. "alt_text_quality" */
  name: string;
  /** Prompt family for grouping, e.g. "element_evaluation" */
  family: string;
  /** Which model to route to */
  model: ModelRoute;
  /** Whether the prompt uses vision (image content blocks) */
  vision: boolean;
  /** System prompt text */
  systemPrompt: string;
  /** JSON schema for the expected output (for documentation / validation) */
  outputSchema: Record<string, unknown>;
}

/** Input for a single prompt invocation */
export interface PromptInput {
  /** The prompt template to use */
  template: PromptTemplate;
  /** User message text */
  userMessage: string;
  /** Optional base64-encoded image for vision prompts */
  imageBase64?: string;
  /** Image media type (default: "image/png") */
  imageMediaType?: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

/** Result from a single prompt invocation */
export interface PromptResult<T = unknown> {
  /** Whether the call succeeded */
  success: boolean;
  /** Parsed output (null on failure) */
  data: T | null;
  /** Raw response text from the model */
  rawResponse: string;
  /** Model used */
  model: string;
  /** Total tokens used (input + output) */
  tokensUsed: number;
  /** Latency in milliseconds */
  latencyMs: number;
  /** Number of retries attempted */
  retries: number;
  /** Error message if failed */
  error?: string;
}

/** Entry for the batch queue */
export interface BatchEntry {
  input: PromptInput;
  resolve: (result: PromptResult) => void;
  reject: (error: Error) => void;
}

/** Logger interface for prompt runner events */
export interface PromptLogger {
  log(entry: PromptLogEntry): void;
}

export interface PromptLogEntry {
  promptName: string;
  model: string;
  tokensUsed: number;
  latencyMs: number;
  success: boolean;
  retries: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Model ID resolution
// ---------------------------------------------------------------------------

const MODEL_IDS: Record<ModelRoute, string> = {
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
};

const MODEL_ENV_OVERRIDES: Record<ModelRoute, string> = {
  sonnet: "WCAG_MODEL_SONNET",
  opus: "WCAG_MODEL_OPUS",
};

/**
 * Resolve a model route to a model ID. `WCAG_MODEL_SONNET` / `WCAG_MODEL_OPUS`
 * override the defaults so models can be compared without a code change.
 * Requests send `temperature: 0`; a model that rejects sampling parameters
 * will fail every call.
 */
export function resolveModelId(route: ModelRoute): string {
  return process.env[MODEL_ENV_OVERRIDES[route]] || MODEL_IDS[route];
}

/** Aggregate call statistics for one prompt name. */
export interface PromptStats {
  /** API requests made, including retries */
  calls: number;
  /** runPrompt invocations answered from the in-scan cache */
  cacheHits: number;
  failures: number;
  retries: number;
  tokensUsed: number;
  totalLatencyMs: number;
}

function cacheKey(input: PromptInput): string {
  const hash = createHash("sha1");
  hash.update(input.template.name);
  hash.update("\0");
  hash.update(input.userMessage);
  hash.update("\0");
  if (input.template.vision && input.imageBase64) hash.update(input.imageBase64);
  return hash.digest("hex");
}

function isRetryableApiError(err: unknown): boolean {
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.APIConnectionError) return true;
  return err instanceof Anthropic.APIError && typeof err.status === "number" && err.status >= 500;
}

// ---------------------------------------------------------------------------
// Message building (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Build the messages array for an Anthropic API call from a PromptInput.
 * Handles text-only and vision (image + text) prompts.
 */
export function buildMessages(
  input: PromptInput,
): Anthropic.Messages.MessageCreateParamsNonStreaming {
  const contentBlocks: Anthropic.Messages.ContentBlockParam[] = [];

  // Add image block first if this is a vision prompt
  if (input.template.vision && input.imageBase64) {
    contentBlocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: input.imageMediaType ?? "image/png",
        data: input.imageBase64,
      },
    });
  }

  // Add text block
  contentBlocks.push({
    type: "text",
    text: input.userMessage,
  });

  return {
    model: resolveModelId(input.template.model),
    max_tokens: 4096,
    temperature: 0,
    system: input.template.systemPrompt,
    messages: [
      {
        role: "user",
        content: contentBlocks,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Response parsing (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Parse the Claude response into a structured evaluation result.
 * Extracts JSON from the response text (handles markdown code blocks).
 * Throws if JSON is invalid or missing.
 */
export function parseEvaluation<T = unknown>(rawText: string): T {
  // Try to extract JSON from markdown code block first
  const codeBlockMatch = rawText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : rawText.trim();

  try {
    return JSON.parse(jsonStr) as T;
  } catch {
    // Try to find JSON object or array in the text
    const jsonMatch = jsonStr.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1]) as T;
    }
    throw new Error(`Failed to parse evaluation response as JSON: ${rawText.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Semaphore for concurrency control
// ---------------------------------------------------------------------------

class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly maxConcurrency: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) {
      this.active++;
      next();
    }
  }
}

// ---------------------------------------------------------------------------
// PromptRunner class
// ---------------------------------------------------------------------------

export class PromptRunner {
  private readonly client: Anthropic;
  private readonly config: PromptRunnerConfig;
  private readonly semaphore: Semaphore;
  private readonly logger: PromptLogger | null;
  private readonly batchQueue: BatchEntry[] = [];
  /** In-flight and completed results keyed by prompt + input, per runner */
  private readonly cache = new Map<string, Promise<PromptResult>>();
  private readonly stats = new Map<string, PromptStats>();

  constructor(
    apiKey: string,
    config: Partial<PromptRunnerConfig> = {},
    logger?: PromptLogger,
  ) {
    this.client = new Anthropic({ apiKey });
    this.config = {
      mode: config.mode ?? "realtime",
      max_retries: config.max_retries ?? 2,
      concurrency: config.concurrency ?? 5,
      fallback_on_failure: config.fallback_on_failure ?? "needs_review",
    };
    this.semaphore = new Semaphore(this.config.concurrency);
    this.logger = logger ?? null;
  }

  /** Get the current config (for testing) */
  getConfig(): PromptRunnerConfig {
    return { ...this.config };
  }

  /**
   * Run a single prompt with retry logic and rate limiting.
   *
   * In "batch" mode, the call is queued for later batch submission.
   * In "realtime" mode (default), the call is made immediately with
   * concurrency-limited parallelism.
   */
  async runPrompt<T = unknown>(input: PromptInput): Promise<PromptResult<T>> {
    if (this.config.mode === "batch") {
      return this.queueForBatch<T>(input);
    }

    // Identical inputs (the same footer link or logo on every page) are
    // evaluated once per runner; later callers share the first result.
    const key = cacheKey(input);
    const cached = this.cache.get(key);
    if (cached) {
      this.statsFor(input.template.name).cacheHits++;
      return cached as Promise<PromptResult<T>>;
    }
    const pending = this.executeWithRetry<T>(input);
    this.cache.set(key, pending as Promise<PromptResult>);
    // Don't pin a failure: a later identical input gets a fresh attempt.
    void pending.then((result) => {
      if (!result.success) this.cache.delete(key);
    });
    return pending;
  }

  /** Per-prompt call statistics accumulated since the runner was created. */
  getStats(): Record<string, PromptStats> {
    return Object.fromEntries(this.stats);
  }

  private statsFor(promptName: string): PromptStats {
    let entry = this.stats.get(promptName);
    if (!entry) {
      entry = { calls: 0, cacheHits: 0, failures: 0, retries: 0, tokensUsed: 0, totalLatencyMs: 0 };
      this.stats.set(promptName, entry);
    }
    return entry;
  }

  private record(entry: PromptLogEntry): void {
    const stats = this.statsFor(entry.promptName);
    stats.calls++;
    stats.tokensUsed += entry.tokensUsed;
    stats.totalLatencyMs += entry.latencyMs;
    if (!entry.success) {
      stats.failures++;
      stats.retries++;
    }
    this.logger?.log(entry);
  }

  /**
   * Run multiple prompts in parallel, respecting concurrency limits.
   */
  async runPrompts<T = unknown>(inputs: PromptInput[]): Promise<PromptResult<T>[]> {
    return Promise.all(inputs.map((input) => this.runPrompt<T>(input)));
  }

  /**
   * Flush the batch queue — submits all queued prompts to the Anthropic
   * batch API. Returns when the batch is created (not when it completes).
   *
   * In a real implementation, this would use the Anthropic batch API.
   * For now, it executes all queued prompts in parallel with rate limiting.
   */
  async flushBatch(): Promise<{ batchId: string; count: number }> {
    const entries = this.batchQueue.splice(0);
    if (entries.length === 0) {
      return { batchId: "", count: 0 };
    }

    const batchId = `batch_${Date.now()}`;

    // Execute all queued prompts (in real impl, this would be a batch API call)
    for (const entry of entries) {
      this.executeWithRetry(entry.input)
        .then(entry.resolve)
        .catch(entry.reject);
    }

    return { batchId, count: entries.length };
  }

  /**
   * Get the number of prompts currently queued for batch submission.
   */
  getBatchQueueSize(): number {
    return this.batchQueue.length;
  }

  // -------------------------------------------------------------------------
  // Private methods
  // -------------------------------------------------------------------------

  private queueForBatch<T>(input: PromptInput): Promise<PromptResult<T>> {
    return new Promise<PromptResult<T>>((resolve, reject) => {
      this.batchQueue.push({
        input,
        resolve: resolve as (result: PromptResult) => void,
        reject,
      });
    });
  }

  private async executeWithRetry<T>(input: PromptInput): Promise<PromptResult<T>> {
    let lastError: Error | undefined;
    let retries = 0;

    let backoffMs = 0;

    for (let attempt = 0; attempt <= this.config.max_retries; attempt++) {
      if (backoffMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        backoffMs = 0;
      }
      await this.semaphore.acquire();
      const start = Date.now();

      try {
        const params = buildMessages(input);
        const response = await this.client.messages.create(params);

        const latencyMs = Date.now() - start;
        const rawText = response.content
          .filter((block): block is Anthropic.Messages.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join("");

        const tokensUsed = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);

        try {
          const data = parseEvaluation<T>(rawText);

          const logEntry: PromptLogEntry = {
            promptName: input.template.name,
            model: params.model,
            tokensUsed,
            latencyMs,
            success: true,
            retries,
          };
          this.record(logEntry);

          return {
            success: true,
            data,
            rawResponse: rawText,
            model: params.model,
            tokensUsed,
            latencyMs,
            retries,
          };
        } catch (parseError) {
          // Parse failure — retry with same input
          lastError = parseError instanceof Error ? parseError : new Error(String(parseError));
          retries++;

          const logEntry: PromptLogEntry = {
            promptName: input.template.name,
            model: params.model,
            tokensUsed,
            latencyMs,
            success: false,
            retries,
            error: lastError.message,
          };
          this.record(logEntry);

          continue; // retry
        }
      } catch (apiError) {
        const latencyMs = Date.now() - start;
        lastError = apiError instanceof Error ? apiError : new Error(String(apiError));
        retries++;

        const logEntry: PromptLogEntry = {
          promptName: input.template.name,
          model: resolveModelId(input.template.model),
          tokensUsed: 0,
          latencyMs,
          success: false,
          retries,
          error: lastError.message,
        };
        this.record(logEntry);

        // Don't retry on auth errors or other client errors (400, 403, 404,
        // ...): the same request will be rejected the same way.
        const isClientError =
          apiError instanceof Anthropic.APIError &&
          typeof apiError.status === "number" &&
          apiError.status >= 400 && apiError.status < 500 &&
          apiError.status !== 408 && apiError.status !== 409 && apiError.status !== 429;
        if (
          isClientError ||
          apiError instanceof Anthropic.AuthenticationError ||
          lastError.message.includes("401") ||
          lastError.message.includes("authentication")
        ) {
          break;
        }

        // Rate limits and server errors: wait before the next attempt (the
        // SDK has already done its own short retries by this point).
        if (isRetryableApiError(apiError)) {
          backoffMs = 2_000 * 2 ** attempt;
        }

        continue; // retry
      } finally {
        this.semaphore.release();
      }
    }

    // All retries exhausted — return fallback result
    const errorMsg = lastError?.message ?? "Unknown error";

    if (this.config.fallback_on_failure === "skip") {
      return {
        success: false,
        data: null,
        rawResponse: "",
        model: resolveModelId(input.template.model),
        tokensUsed: 0,
        latencyMs: 0,
        retries,
        error: errorMsg,
      };
    }

    // "needs_review" fallback: return a result that signals human review needed
    return {
      success: false,
      data: {
        verdict: "needs_review",
        confidence: 0.0,
        reasoning: `Prompt evaluation failed after ${retries} retries: ${errorMsg}`,
        requires_human_verification: true,
      } as T,
      rawResponse: "",
      model: resolveModelId(input.template.model),
      tokensUsed: 0,
      latencyMs: 0,
      retries,
      error: errorMsg,
    };
  }
}

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

/**
 * Create a PromptRunner with the given API key and optional configuration.
 */
export function createPromptRunner(
  apiKey: string,
  options?: {
    mode?: PromptMode;
    maxRetries?: number;
    concurrency?: number;
    fallbackOnFailure?: "needs_review" | "skip";
    logger?: PromptLogger;
  },
): PromptRunner {
  return new PromptRunner(
    apiKey,
    {
      mode: options?.mode ?? "realtime",
      max_retries: options?.maxRetries ?? 2,
      concurrency: options?.concurrency ?? 5,
      fallback_on_failure: options?.fallbackOnFailure ?? "needs_review",
    },
    options?.logger,
  );
}
