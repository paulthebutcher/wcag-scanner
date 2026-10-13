// ---------------------------------------------------------------------------
// List prices used to enforce `record --max-cost-usd`. Anthropic first-party
// rates in USD per million tokens, as published for these model ids on
// 2026-10-06. Image tokens are billed as input and are already included in
// the usage the API returns; the pre-call estimate uses width×height/750.
// ---------------------------------------------------------------------------

export interface ModelPrice {
  input_per_mtok: number;
  output_per_mtok: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-sonnet-4-6": { input_per_mtok: 3, output_per_mtok: 15 },
  "claude-opus-4-6": { input_per_mtok: 5, output_per_mtok: 25 },
};

export const PRICES_AS_OF = "2026-10-06";

export function priceFor(model: string): ModelPrice {
  const price = MODEL_PRICES[model];
  // Unknown models are priced at the most expensive known rate so a budget
  // can only be under-spent, never exceeded.
  if (price) return price;
  return Object.values(MODEL_PRICES).reduce((a, b) => (b.output_per_mtok > a.output_per_mtok ? b : a));
}

export function costOf(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  return (inputTokens * p.input_per_mtok + outputTokens * p.output_per_mtok) / 1_000_000;
}

/**
 * Worst-case cost of a call before it is made: text at ~4 characters per
 * token, images at width×height/750, and the full max_tokens of output.
 */
export function worstCaseCost(model: string, textChars: number, imagePixels: number, maxTokens: number): number {
  const inputTokens = Math.ceil(textChars / 4) + Math.ceil(imagePixels / 750);
  return costOf(model, inputTokens, maxTokens);
}
