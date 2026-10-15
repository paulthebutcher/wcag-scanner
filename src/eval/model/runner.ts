import { runWithTemplate, templateContext, type EvalAnthropicClient } from "./client.js";

// ---------------------------------------------------------------------------
// Build an engine's own PromptRunner with the eval client in place of the
// Anthropic client. The engine module is passed in so the baseline bridge
// can use the baseline's PromptRunner (its parsing, retries, in-scan cache
// and fallback), not HEAD's.
// ---------------------------------------------------------------------------

/** The slice of an engine's prompt-runner module the harness uses. */
export interface EnginePromptModule {
  createPromptRunner(apiKey: string, options?: { concurrency?: number }): unknown;
}

interface RunnerLike {
  client: unknown;
  runPrompt(input: { template: { name: string } }): Promise<unknown>;
}

export function buildEvalRunner<T>(engine: EnginePromptModule, client: EvalAnthropicClient, concurrency: number): T {
  // The key is never used: the SDK client it builds is replaced below.
  const runner = engine.createPromptRunner("eval-harness-offline", { concurrency }) as RunnerLike;
  if (!("client" in runner)) throw new Error("engine PromptRunner has no client field to replace");
  runner.client = client;
  const original = runner.runPrompt.bind(runner);
  // runPrompts calls this.runPrompt, so an own property covers both paths.
  runner.runPrompt = (input) => runWithTemplate(templateContext(input.template), () => original(input));
  return runner as unknown as T;
}
