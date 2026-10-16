// ---------------------------------------------------------------------------
// The identity of a model request (P2-002): everything that makes two
// requests the same request. The in-scan prompt cache and the eval
// harness's persistent response cache key on the same EffectiveRequest, so
// a scan reuses a response only for an identical request (same model id,
// system prompt, template content, user text, image, output schema and
// sampling parameters), exactly as replay does.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * JSON with object keys sorted at every level, so equal values always
 * serialise (and hash) the same way regardless of insertion order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && !(value instanceof Buffer)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export const NO_IMAGE = "no-image";

/** Everything that makes two requests the same request. */
export interface EffectiveRequest {
  model: string;
  template_name: string;
  template_sha256: string;
  system: string;
  user_text: string;
  image: { sha256: string; media_type: string } | typeof NO_IMAGE;
  output_schema_sha256: string;
  parameters: { max_tokens: number; temperature: number | null };
}

export function requestKey(req: EffectiveRequest): string {
  return sha256(canonicalJson({ v: 1, ...req }));
}

/** A prompt template as the engine defines it, for hashing. */
export interface TemplateLike {
  name: string;
  family?: string;
  model?: string;
  vision?: boolean;
  systemPrompt?: string;
  outputSchema?: unknown;
}

/** Hash of a template's full definition (name, routing, system prompt, schema). */
export function templateSha256(template: TemplateLike): string {
  return sha256(canonicalJson(template));
}

export function outputSchemaSha256(template: TemplateLike): string {
  return sha256(canonicalJson(template.outputSchema ?? null));
}

/** The effective request the engine will send for a prompt input. */
export function effectiveRequestFor(input: {
  template: TemplateLike;
  modelId: string;
  userMessage: string;
  imageBase64?: string;
  imageMediaType?: string;
  maxTokens: number;
  temperature: number | null;
}): EffectiveRequest {
  const image = input.template.vision && input.imageBase64
    ? { sha256: sha256(Buffer.from(input.imageBase64, "base64")), media_type: input.imageMediaType ?? "image/png" }
    : NO_IMAGE;
  return {
    model: input.modelId,
    template_name: input.template.name,
    template_sha256: templateSha256(input.template),
    system: input.template.systemPrompt ?? "",
    user_text: input.userMessage,
    image,
    output_schema_sha256: outputSchemaSha256(input.template),
    parameters: { max_tokens: input.maxTokens, temperature: input.temperature },
  };
}
