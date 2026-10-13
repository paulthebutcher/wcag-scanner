import { AsyncLocalStorage } from "node:async_hooks";
import { canonicalJson, sha256 } from "../util.js";
import { requestKey, ResponseCache, NO_IMAGE, type CachedAttempt, type EffectiveRequest, type RecordedError } from "./cache.js";
import { costOf, worstCaseCost } from "./pricing.js";

// ---------------------------------------------------------------------------
// The eval model client: replaces the Anthropic client inside the engine's
// own PromptRunner, so every response — recorded, replayed or injected —
// still goes through that engine's parsing, retry and fallback logic.
//
//   inject:  deterministic responses from a function (pilot, equivalence)
//   collect: no model calls; requests (and their images) are logged and
//            answered with a non-retryable error
//   record:  replay what is cached; call the live API only for missing
//            attempts, within a dollar budget
//   replay:  cached attempts only; a miss is answered with a non-retryable
//            error and counted (the run is then invalid)
//
// Vision requests are checked against the image store: an image that is not
// a recorded production input is never sent and never matched to a cached
// response.
// ---------------------------------------------------------------------------

export type ClientMode = "inject" | "collect" | "record" | "replay";

export interface TemplateContext {
  name: string;
  family: string;
  sha256: string;
  output_schema_sha256: string;
}

const templateStore = new AsyncLocalStorage<TemplateContext>();

export function runWithTemplate<T>(ctx: TemplateContext, fn: () => T): T {
  return templateStore.run(ctx, fn);
}

export function currentTemplate(): TemplateContext | undefined {
  return templateStore.getStore();
}

/** Minimal shape of the Anthropic SDK module the client needs (errors). */
export interface AnthropicErrors {
  APIError: {
    generate(status: number | undefined, body: object | undefined, message: string | undefined, headers: Record<string, string> | undefined): Error;
  };
  APIConnectionError: new (opts: { message?: string }) => Error;
}

export interface LiveMessages {
  create(params: MessageParams): Promise<unknown>;
}

export interface MessageParams {
  model: string;
  max_tokens: number;
  temperature?: number;
  system?: string | Array<{ type: string; text?: string }>;
  messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
}

export interface InjectedOutcome {
  text?: string;
  error?: { status: number; message: string };
}

export type Injector = (req: EffectiveRequest, image: Buffer | null) => InjectedOutcome;

export interface ImagePolicy {
  /** sha256 of every recorded production input image; null = no check */
  allowed: Set<string> | null;
}

export interface CollectedRequest {
  key: string;
  template: string;
  model: string;
  image_sha256: string | null;
  image_bytes: Buffer | null;
  media_type: string | null;
  user_text: string;
}

export interface ClientStats {
  requests: number;
  by_template: Record<string, number>;
  entries_read: number;
  entries_created: number;
  shared_responses: number;
  cache_misses: number;
  image_misses: number;
  budget_refusals: number;
  vision_requests: number;
  no_image_requests: number;
  vision_by_template: Record<string, number>;
  cost_usd: number;
  model_ids: string[];
  template_hashes: Record<string, string>;
  system_prompt_hashes: Record<string, string>;
  miss_keys: string[];
}

export interface EvalClientOptions {
  mode: ClientMode;
  errors: AnthropicErrors;
  engineLabel: string;
  runId: string;
  cache?: ResponseCache;
  injector?: Injector;
  live?: LiveMessages;
  images?: ImagePolicy;
  /** record: stop starting live calls once this much has been spent */
  maxCostUsd?: number;
  onCollect?: (req: CollectedRequest) => void;
}

function systemText(system: MessageParams["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.map((b) => b.text ?? "").join("");
}

function splitContent(params: MessageParams): { text: string; image: { data: Buffer; media_type: string } | null } {
  const user = params.messages.find((m) => m.role === "user");
  if (!user) return { text: "", image: null };
  if (typeof user.content === "string") return { text: user.content, image: null };
  const texts: string[] = [];
  let image: { data: Buffer; media_type: string } | null = null;
  for (const block of user.content) {
    if (block.type === "text") texts.push(String(block.text ?? ""));
    if (block.type === "image") {
      const source = block.source as { type: string; data?: string; media_type?: string };
      if (source?.type === "base64" && source.data) image = { data: Buffer.from(source.data, "base64"), media_type: source.media_type ?? "image/png" };
    }
  }
  return { text: texts.join("\n"), image };
}

function pngPixels(buf: Buffer): number {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return buf.readUInt32BE(16) * buf.readUInt32BE(20);
  return 1_150_000;
}

export class EvalAnthropicClient {
  readonly stats: ClientStats = {
    requests: 0, by_template: {}, entries_read: 0, entries_created: 0, shared_responses: 0,
    cache_misses: 0, image_misses: 0, budget_refusals: 0, vision_requests: 0, no_image_requests: 0, vision_by_template: {},
    cost_usd: 0, model_ids: [], template_hashes: {}, system_prompt_hashes: {}, miss_keys: [],
  };
  /** Attempts served or recorded so far in this run, per key */
  private readonly attemptCounter = new Map<string, number>();
  readonly messages: { create: (params: MessageParams) => Promise<unknown> };

  constructor(private readonly options: EvalClientOptions) {
    if ((options.mode === "record" || options.mode === "replay") && !options.cache) throw new Error(`${options.mode} mode needs a response cache`);
    if (options.mode === "record" && !options.live) throw new Error("record mode needs a live client");
    if (options.mode === "inject" && !options.injector) throw new Error("inject mode needs an injector");
    this.messages = { create: (params) => this.create(params) };
  }

  private harnessError(message: string): Error {
    return this.options.errors.APIError.generate(400, { type: "error", error: { type: "eval_harness", message } }, undefined, {});
  }

  private rebuildError(err: RecordedError): Error {
    if (err.status === null) return new this.options.errors.APIConnectionError({ message: err.message });
    return this.options.errors.APIError.generate(err.status, (err.body ?? undefined) as object | undefined, undefined, err.headers ?? {});
  }

  effectiveRequest(params: MessageParams): { req: EffectiveRequest; image: Buffer | null } {
    const template = currentTemplate();
    const { text, image } = splitContent(params);
    const system = systemText(params.system);
    return {
      req: {
        model: params.model,
        template_name: template?.name ?? "(unknown)",
        template_sha256: template?.sha256 ?? sha256(system),
        system,
        user_text: text,
        image: image ? { sha256: sha256(image.data), media_type: image.media_type } : NO_IMAGE,
        output_schema_sha256: template?.output_schema_sha256 ?? sha256("null"),
        parameters: { max_tokens: params.max_tokens, temperature: params.temperature ?? null },
      },
      image: image?.data ?? null,
    };
  }

  private async create(params: MessageParams): Promise<unknown> {
    const { req, image } = this.effectiveRequest(params);
    const key = requestKey(req);
    const s = this.stats;
    s.requests++;
    s.by_template[req.template_name] = (s.by_template[req.template_name] ?? 0) + 1;
    if (!s.model_ids.includes(req.model)) s.model_ids.push(req.model);
    s.template_hashes[req.template_name] = req.template_sha256;
    s.system_prompt_hashes[req.template_name] = sha256(req.system);
    if (image) {
      s.vision_requests++;
      s.vision_by_template[req.template_name] = (s.vision_by_template[req.template_name] ?? 0) + 1;
    } else {
      s.no_image_requests++;
    }

    if (this.options.mode === "collect") {
      this.options.onCollect?.({
        key, template: req.template_name, model: req.model,
        image_sha256: image ? sha256(image) : null, image_bytes: image,
        media_type: req.image === NO_IMAGE ? null : req.image.media_type, user_text: req.user_text,
      });
      throw this.harnessError("eval collect mode: model calls are disabled");
    }

    // Images must be recorded production inputs (never a replay render)
    if (image && this.options.images?.allowed && !this.options.images.allowed.has(sha256(image))) {
      s.image_misses++;
      throw this.harnessError(`eval: image ${sha256(image).slice(0, 12)} is not in the image store`);
    }

    if (this.options.mode === "inject") {
      const outcome = this.options.injector!(req, image);
      if (outcome.error) {
        throw this.options.errors.APIError.generate(outcome.error.status, { type: "error", error: { type: "injected", message: outcome.error.message } }, undefined, {});
      }
      return this.message(key, req.model, outcome.text ?? "", Math.ceil(req.user_text.length / 4), Math.ceil((outcome.text ?? "").length / 4));
    }

    const cache = this.options.cache!;
    const attempt = this.attemptCounter.get(key) ?? 0;
    this.attemptCounter.set(key, attempt + 1);
    const cached = cache.get(key, attempt);
    if (cached) {
      s.entries_read++;
      // Responses another engine recorded (paired comparisons share them)
      if (cached.engine_label !== this.options.engineLabel) s.shared_responses++;
      return this.serve(cached);
    }

    if (this.options.mode === "replay") {
      s.cache_misses++;
      if (s.miss_keys.length < 200) s.miss_keys.push(`${req.template_name}:${key.slice(0, 12)}#${attempt}`);
      throw this.harnessError(`eval replay: no cached response (${req.template_name} ${key.slice(0, 12)} attempt ${attempt})`);
    }

    // record: a live call, if the budget allows it
    const budget = this.options.maxCostUsd ?? 0;
    const worst = worstCaseCost(req.model, req.system.length + req.user_text.length, image ? pngPixels(image) : 0, req.parameters.max_tokens);
    if (s.cost_usd + worst > budget) {
      s.budget_refusals++;
      throw this.harnessError("eval record: budget exhausted, call not started");
    }
    cache.putRequest(key, req, this.options.runId);
    const started = Date.now();
    let record: CachedAttempt;
    try {
      const response = await this.options.live!.create(params) as { usage?: { input_tokens?: number; output_tokens?: number } };
      const usage = { input_tokens: response.usage?.input_tokens ?? 0, output_tokens: response.usage?.output_tokens ?? 0 };
      const cost = costOf(req.model, usage.input_tokens, usage.output_tokens);
      s.cost_usd += cost;
      record = {
        key, attempt, recorded_at: new Date().toISOString(), recorded_by_run: this.options.runId, engine_label: this.options.engineLabel,
        outcome: "response", response: JSON.parse(JSON.stringify(response)), error: null, usage, latency_ms: Date.now() - started, cost_usd: cost,
      };
    } catch (err) {
      const e = err as { constructor?: { name?: string }; status?: number; error?: unknown; headers?: Record<string, string>; message?: string };
      record = {
        key, attempt, recorded_at: new Date().toISOString(), recorded_by_run: this.options.runId, engine_label: this.options.engineLabel,
        outcome: "error", response: null,
        error: {
          class_name: e.constructor?.name ?? "Error",
          status: typeof e.status === "number" ? e.status : null,
          body: e.error ?? null,
          headers: e.headers ? Object.fromEntries(Object.entries(e.headers).filter(([k]) => /^(retry-after|x-should-retry|request-id|content-type)$/i.test(k))) : null,
          message: e.message ?? String(err),
        },
        usage: null, latency_ms: Date.now() - started, cost_usd: 0,
      };
    }
    cache.put(record);
    s.entries_created++;
    return this.serve(record);
  }

  private serve(attempt: CachedAttempt): unknown {
    if (attempt.outcome === "error") throw this.rebuildError(attempt.error!);
    return attempt.response;
  }

  private message(key: string, model: string, text: string, inTokens: number, outTokens: number): unknown {
    return {
      id: `msg_eval_${key.slice(0, 16)}`,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: inTokens, output_tokens: outTokens },
    };
  }
}

/** Hash of a prompt template as the engine defines it (for the cache key). */
export function templateContext(template: { name: string; family?: string; model?: string; vision?: boolean; systemPrompt?: string; outputSchema?: unknown }): TemplateContext {
  return {
    name: template.name,
    family: template.family ?? "",
    sha256: sha256(canonicalJson(template)),
    output_schema_sha256: sha256(canonicalJson(template.outputSchema ?? null)),
  };
}
