import type { LlmInput, LlmOutput } from "../../types.js";
import type { PromptInput, PromptResult } from "../../core/prompt-runner.js";

/**
 * Build LlmInput and LlmOutput records from a prompt input/result pair.
 *
 * Used by semantic check modules to attach the full rendered prompt and raw
 * LLM response to each CheckResult, so the analyzer can surface them on the
 * Finding's Analysis for audit/debug dumps.
 */
export function buildLlmCapture(
  input: PromptInput,
  result: PromptResult<unknown>,
): { llm_input: LlmInput; llm_output: LlmOutput } {
  const llm_input: LlmInput = {
    // Store the full rendered prompt — system + user concatenated — so
    // readers can reproduce exactly what Claude saw.
    prompt: `# System\n${input.template.systemPrompt}\n\n# User\n${input.userMessage}`,
    dom_snippet: input.userMessage.slice(0, 2000),
    screenshot_provided: input.template.vision && Boolean(input.imageBase64),
  };

  const llm_output: LlmOutput = {
    raw_response: result.rawResponse,
    model: result.model,
    tokens_used: result.tokensUsed,
  };

  return { llm_input, llm_output };
}
