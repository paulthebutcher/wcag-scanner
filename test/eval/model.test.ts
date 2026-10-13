import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { createPromptRunner, type PromptRunner, type PromptTemplate } from "../../src/core/prompt-runner.js";
import { EvalAnthropicClient, type MessageParams } from "../../src/eval/model/client.js";
import { ResponseCache, requestKey } from "../../src/eval/model/cache.js";
import { buildEvalRunner } from "../../src/eval/model/runner.js";
import { deterministicOutcome } from "../../src/eval/model/injector.js";
import { costOf, worstCaseCost } from "../../src/eval/model/pricing.js";
import { sha256 } from "../../src/eval/util.js";

const TEMPLATE: PromptTemplate = {
  name: "link_text_quality", family: "element_evaluation", model: "sonnet", vision: true,
  systemPrompt: "Evaluate link text.", outputSchema: { type: "object" },
};
const PASS = '{"verdict":"pass","confidence":0.9,"reasoning":"ok","wcag_criterion":"2.4.4","failure_type":null,"suggestion":null,"affected_users":[],"requires_human_verification":false}';
const IMG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "eval-model-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function message(text: string) {
  return { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } };
}

function runnerWith(client: EvalAnthropicClient): PromptRunner {
  return buildEvalRunner<PromptRunner>({ createPromptRunner }, client, 2);
}

describe("eval client through the engine's own PromptRunner", () => {
  it("record stores raw attempts (including retries) and replay serves them in order", async () => {
    const cache = new ResponseCache(dir, "ns1");
    const live = { calls: 0, create: async (_p: MessageParams) => { live.calls++; return live.calls === 1 ? message("not json") : message(PASS); } };
    const recordClient = new EvalAnthropicClient({ mode: "record", errors: Anthropic, engineLabel: "head", runId: "r1", cache, live, maxCostUsd: 1 });
    const r1 = await runnerWith(recordClient).runPrompt({ template: TEMPLATE, userMessage: "Link: click here" });
    expect(r1.success).toBe(true);
    expect(r1.retries).toBe(1); // the parse failure was retried by the engine
    expect(recordClient.stats.entries_created).toBe(2);
    expect(live.calls).toBe(2);

    const replayClient = new EvalAnthropicClient({ mode: "replay", errors: Anthropic, engineLabel: "baseline", runId: "r2", cache });
    const r2 = await runnerWith(replayClient).runPrompt({ template: TEMPLATE, userMessage: "Link: click here" });
    expect(r2.success).toBe(true);
    expect(r2.retries).toBe(1);
    expect(r2.rawResponse).toBe(PASS);
    expect(replayClient.stats.entries_read).toBe(2);
    expect(replayClient.stats.shared_responses).toBe(2);
    expect(replayClient.stats.cache_misses).toBe(0);
  });

  it("a cached error stays an error and keeps its class (no retry for 4xx)", async () => {
    const cache = new ResponseCache(dir, "ns2");
    const live = { create: async () => { throw Anthropic.APIError.generate(400, { type: "error", error: { type: "invalid_request_error", message: "bad" } }, undefined, {}); } };
    const rec = new EvalAnthropicClient({ mode: "record", errors: Anthropic, engineLabel: "head", runId: "r1", cache, live, maxCostUsd: 1 });
    const a = await runnerWith(rec).runPrompt({ template: TEMPLATE, userMessage: "x" });
    expect(a.success).toBe(false);
    expect(a.error).toContain("400");
    const rep = new EvalAnthropicClient({ mode: "replay", errors: Anthropic, engineLabel: "head", runId: "r2", cache });
    const b = await runnerWith(rep).runPrompt({ template: TEMPLATE, userMessage: "x" });
    expect(b.success).toBe(false);
    expect(b.error).toBe(a.error);
    expect((b.data as { verdict?: string } | null)?.verdict).toBe("needs_review");
  });

  it("replay never falls back to live and counts the miss", async () => {
    const rep = new EvalAnthropicClient({ mode: "replay", errors: Anthropic, engineLabel: "head", runId: "r", cache: new ResponseCache(dir, "empty") });
    const r = await runnerWith(rep).runPrompt({ template: TEMPLATE, userMessage: "never recorded" });
    expect(r.success).toBe(false);
    expect(rep.stats.cache_misses).toBe(1);
    expect(r.error).toContain("no cached response");
  });

  it("refuses images that are not recorded production inputs, before any cache lookup", async () => {
    const rep = new EvalAnthropicClient({ mode: "inject", errors: Anthropic, engineLabel: "head", runId: "r", injector: () => ({ text: PASS }), images: { allowed: new Set([sha256(Buffer.from("other"))]) } });
    const r = await runnerWith(rep).runPrompt({ template: TEMPLATE, userMessage: "x", imageBase64: IMG.toString("base64") });
    expect(r.success).toBe(false);
    expect(rep.stats.image_misses).toBe(1);
    const ok = new EvalAnthropicClient({ mode: "inject", errors: Anthropic, engineLabel: "head", runId: "r", injector: () => ({ text: PASS }), images: { allowed: new Set([sha256(IMG)]) } });
    expect((await runnerWith(ok).runPrompt({ template: TEMPLATE, userMessage: "x", imageBase64: IMG.toString("base64") })).success).toBe(true);
    expect(ok.stats.vision_by_template.link_text_quality).toBe(1);
  });

  it("collect mode makes no call, logs the request with its image and returns a non-retryable error", async () => {
    const collected: string[] = [];
    const c = new EvalAnthropicClient({ mode: "collect", errors: Anthropic, engineLabel: "capture", runId: "r", onCollect: (q) => collected.push(`${q.template}:${q.image_sha256?.slice(0, 8)}`) });
    const r = await runnerWith(c).runPrompt({ template: TEMPLATE, userMessage: "x", imageBase64: IMG.toString("base64") });
    expect(r.success).toBe(false);
    expect(r.retries).toBe(1);
    expect(collected).toEqual([`link_text_quality:${sha256(IMG).slice(0, 8)}`]);
  });

  it("record stops starting calls when the budget is spent", async () => {
    const cache = new ResponseCache(dir, "budget");
    let calls = 0;
    const live = { create: async () => { calls++; return message(PASS); } };
    const rec = new EvalAnthropicClient({ mode: "record", errors: Anthropic, engineLabel: "head", runId: "r", cache, live, maxCostUsd: 0.001 });
    const r = await runnerWith(rec).runPrompt({ template: TEMPLATE, userMessage: "x" });
    expect(r.success).toBe(false);
    expect(calls).toBe(0);
    expect(rec.stats.budget_refusals).toBe(1);
  });
});

describe("cache keys and storage", () => {
  const base = {
    model: "claude-sonnet-4-6", template_name: "t", template_sha256: "a".repeat(64), system: "s", user_text: "u",
    image: "no-image" as const, output_schema_sha256: "b".repeat(64), parameters: { max_tokens: 4096, temperature: 0 },
  };
  it("include model, system prompt, image and parameters", () => {
    const k = requestKey(base);
    expect(requestKey({ ...base, model: "claude-opus-4-6" })).not.toBe(k);
    expect(requestKey({ ...base, system: "s2" })).not.toBe(k);
    expect(requestKey({ ...base, image: { sha256: "c".repeat(64), media_type: "image/png" } })).not.toBe(k);
    expect(requestKey({ ...base, parameters: { max_tokens: 1024, temperature: 0 } })).not.toBe(k);
    expect(requestKey({ ...base })).toBe(k);
  });
  it("attempt files are immutable", () => {
    const cache = new ResponseCache(dir, "imm");
    const att = { key: "k".repeat(64), attempt: 0, recorded_at: "t", recorded_by_run: "r", engine_label: "head", outcome: "response" as const, response: { a: 1 }, error: null, usage: null, latency_ms: 1, cost_usd: 0 };
    cache.put(att);
    expect(() => cache.put({ ...att, response: { a: 2 } })).toThrow(/immutable/);
    expect(cache.get("k".repeat(64), 0)?.response).toEqual({ a: 1 });
    expect(cache.attempts("k".repeat(64))).toBe(1);
  });
});

describe("injector and pricing", () => {
  it("injected outcomes depend only on the request", () => {
    const req = { model: "m", template_name: "alt_text_quality", template_sha256: "", system: "", user_text: "abc", image: "no-image" as const, output_schema_sha256: "", parameters: { max_tokens: 1, temperature: 0 } };
    expect(deterministicOutcome(req)).toEqual(deterministicOutcome({ ...req, model: "other" }));
  });
  it("prices from usage and bounds the worst case", () => {
    expect(costOf("claude-sonnet-4-6", 1_000_000, 0)).toBe(3);
    expect(costOf("claude-opus-4-6", 0, 1_000_000)).toBe(25);
    expect(worstCaseCost("claude-sonnet-4-6", 4000, 0, 4096)).toBeCloseTo((1000 * 3 + 4096 * 15) / 1e6);
  });
});
