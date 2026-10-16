import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256, writeOnce } from "../util.js";

// ---------------------------------------------------------------------------
// Persistent model response cache (D3). One directory per effective request
// key; each attempt the engine made for that request (first try, retries,
// fresh attempts after a failure) is its own immutable file, served back in
// the same order on replay. A cached error stays an error.
//
//   <cacheDir>/<namespace>/<key[0:2]>/<key>/request.json
//   <cacheDir>/<namespace>/<key[0:2]>/<key>/attempt-000.json
// ---------------------------------------------------------------------------

// The request identity and its key live in core (P2-002): the in-scan
// prompt cache and this persistent cache key the same way.
import type { EffectiveRequest } from "../../core/request-key.js";
export { NO_IMAGE, requestKey, type EffectiveRequest } from "../../core/request-key.js";

export interface RecordedError {
  class_name: string;
  status: number | null;
  /** The API error body (err.error), used to rebuild an identical error */
  body: unknown;
  headers: Record<string, string> | null;
  message: string;
}

export interface CachedAttempt {
  key: string;
  attempt: number;
  recorded_at: string;
  recorded_by_run: string;
  engine_label: string;
  outcome: "response" | "error";
  /** The full Message JSON the SDK returned */
  response: unknown | null;
  error: RecordedError | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  latency_ms: number;
  cost_usd: number;
}

export interface StoredRequest {
  key: string;
  request: Omit<EffectiveRequest, "system" | "user_text"> & { system_sha256: string; user_text_sha256: string };
  /** Full text, kept for audit (private: the cache lives under wcag-data) */
  system: string;
  user_text: string;
  first_recorded_by_run: string;
}

export class ResponseCache {
  readonly dir: string;

  constructor(cacheRoot: string, readonly namespace: string) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(namespace)) throw new Error(`Invalid cache namespace "${namespace}"`);
    this.dir = join(cacheRoot, namespace);
  }

  private keyDir(key: string): string {
    return join(this.dir, key.slice(0, 2), key);
  }

  get(key: string, attempt: number): CachedAttempt | null {
    const path = join(this.keyDir(key), `attempt-${String(attempt).padStart(3, "0")}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as CachedAttempt;
  }

  attempts(key: string): number {
    const dir = this.keyDir(key);
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter((f) => f.startsWith("attempt-")).length;
  }

  putRequest(key: string, req: EffectiveRequest, runId: string): void {
    const path = join(this.keyDir(key), "request.json");
    if (existsSync(path)) return;
    const stored: StoredRequest = {
      key,
      request: {
        model: req.model,
        template_name: req.template_name,
        template_sha256: req.template_sha256,
        image: req.image,
        output_schema_sha256: req.output_schema_sha256,
        parameters: req.parameters,
        system_sha256: sha256(req.system),
        user_text_sha256: sha256(req.user_text),
      },
      system: req.system,
      user_text: req.user_text,
      first_recorded_by_run: runId,
    };
    writeOnce(path, JSON.stringify(stored, null, 2) + "\n");
  }

  put(attempt: CachedAttempt): void {
    const path = join(this.keyDir(attempt.key), `attempt-${String(attempt.attempt).padStart(3, "0")}.json`);
    writeOnce(path, JSON.stringify(attempt, null, 2) + "\n");
  }

  /** Every key in the namespace (for verification and hashing). */
  keys(): string[] {
    if (!existsSync(this.dir)) return [];
    const out: string[] = [];
    for (const prefix of readdirSync(this.dir).sort()) {
      const sub = join(this.dir, prefix);
      if (prefix.length !== 2) continue;
      for (const key of readdirSync(sub).sort()) out.push(key);
    }
    return out;
  }
}
