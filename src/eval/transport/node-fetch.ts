import { sha256 } from "../util.js";

// ---------------------------------------------------------------------------
// Node-side fetch boundary. The engine's crawler (root redirect, robots,
// sitemaps) and alt-text image fetcher call the global `fetch`. The harness
// replaces it for the duration of a run:
//
//   capture: adds the eval user agent, paces top-level loads, maps pilot
//            hostnames to the local fixture, and records every response.
//   replay:  serves the recorded responses (and declared synthetic ones such
//            as the baseline bridge's sitemap); anything else is denied and
//            counted as a miss, even if the caller swallows the error.
// ---------------------------------------------------------------------------

export type FetchFn = typeof globalThis.fetch;

/** One recorded Node fetch: enough to rebuild the Response the engine saw. */
export interface NodeFetchRecord {
  method: string;
  url: string;
  /** "response" (any HTTP status) or "error" (network failure, timeout) */
  outcome: "response" | "error";
  status: number;
  status_text: string;
  final_url: string;
  redirected: boolean;
  headers: Record<string, string>;
  body_sha256: string | null;
  body_bytes: number;
  error: string | null;
  recorded_at: string;
  /** Why the fetch happened: "root-redirect", "robots", "image", … */
  purpose: string;
}

export interface FetchEvent {
  method: string;
  url: string;
  decision: "recorded" | "served" | "synthetic" | "miss";
  purpose: string;
}

let installedFetch: { original: FetchFn; depth: number } | null = null;

/** Replace globalThis.fetch until the returned function is called. */
export function installFetch(impl: FetchFn): () => void {
  const original = installedFetch?.original ?? globalThis.fetch;
  installedFetch = { original, depth: (installedFetch?.depth ?? 0) + 1 };
  const previous = globalThis.fetch;
  globalThis.fetch = impl;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    globalThis.fetch = previous;
    if (installedFetch) {
      installedFetch.depth--;
      if (installedFetch.depth === 0) installedFetch = null;
    }
  };
}

export function originalFetch(): FetchFn {
  return installedFetch?.original ?? globalThis.fetch;
}

function requestParts(input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]): { url: string; method: string } {
  if (typeof input === "string") return { url: input, method: (init?.method ?? "GET").toUpperCase() };
  if (input instanceof URL) return { url: input.href, method: (init?.method ?? "GET").toUpperCase() };
  const req = input as Request;
  return { url: req.url, method: (init?.method ?? req.method ?? "GET").toUpperCase() };
}

/** Normalise a URL for record lookup (fragment dropped, nothing else). */
export function fetchKey(method: string, url: string): string {
  let u = url;
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    u = parsed.href;
  } catch {
    // keep as is
  }
  return `${method.toUpperCase()} ${u}`;
}

function buildResponse(record: NodeFetchRecord, body: Buffer | null): Response {
  // 1xx/204/304 must not carry a body
  const nullBody = record.status === 204 || record.status === 304 || record.status < 200;
  const response = new Response(nullBody ? null : (body ? new Uint8Array(body) : null), {
    status: record.status,
    statusText: record.status_text,
    headers: record.headers,
  });
  Object.defineProperty(response, "url", { value: record.final_url });
  Object.defineProperty(response, "redirected", { value: record.redirected });
  return response;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export interface CaptureFetchOptions {
  userAgent: string;
  /** Called before a request that counts as a top-level load (pacing). */
  beforeTopLevel?: (url: string) => Promise<void>;
  /** Decide whether a URL is a top-level load (default: never) */
  isTopLevel?: (url: string) => boolean;
  /** Pilot only: hostname → "127.0.0.1:port" so external-looking hosts resolve locally */
  hostMap?: Record<string, string>;
  /** Persist a body; returns its sha256 */
  storeBody: (body: Buffer) => string;
  onRecord: (record: NodeFetchRecord) => void;
  purposeOf?: (url: string) => string;
  /** Allowed URL predicate (robots). A disallowed fetch is refused and recorded as an error. */
  allowed?: (url: string) => boolean;
}

export function createCaptureFetch(options: CaptureFetchOptions): FetchFn {
  const real = originalFetch();
  return (async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    const { url, method } = requestParts(input, init);
    const purpose = options.purposeOf?.(url) ?? "other";
    const base: Omit<NodeFetchRecord, "outcome" | "status" | "status_text" | "final_url" | "redirected" | "headers" | "body_sha256" | "body_bytes" | "error"> = {
      method, url, recorded_at: new Date().toISOString(), purpose,
    };
    if (method !== "GET" && method !== "HEAD") {
      const error = `eval capture: Node ${method} refused`;
      options.onRecord({ ...base, outcome: "error", status: 0, status_text: "", final_url: url, redirected: false, headers: {}, body_sha256: null, body_bytes: 0, error });
      throw new TypeError(error);
    }
    if (options.allowed && !options.allowed(url)) {
      const error = "eval capture: disallowed by robots.txt";
      options.onRecord({ ...base, outcome: "error", status: 0, status_text: "", final_url: url, redirected: false, headers: {}, body_sha256: null, body_bytes: 0, error });
      throw new TypeError(error);
    }
    if (options.isTopLevel?.(url) && options.beforeTopLevel) await options.beforeTopLevel(url);

    let target = url;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("user-agent", options.userAgent);
    if (options.hostMap) {
      const parsed = new URL(url);
      const mapped = options.hostMap[parsed.hostname];
      if (mapped) {
        headers.set("host", parsed.host);
        parsed.host = mapped;
        target = parsed.href;
      }
    }
    try {
      const res = await real(target, { ...init, method, headers, redirect: init?.redirect ?? "follow" });
      const body = method === "HEAD" ? Buffer.alloc(0) : Buffer.from(await res.arrayBuffer());
      const bodySha = options.storeBody(body);
      const record: NodeFetchRecord = {
        ...base,
        outcome: "response",
        status: res.status,
        status_text: res.statusText,
        final_url: unmapUrl(res.url || target, url, options.hostMap),
        redirected: res.redirected,
        headers: Object.fromEntries(res.headers.entries()),
        body_sha256: bodySha,
        body_bytes: body.length,
        error: null,
      };
      options.onRecord(record);
      return buildResponse(record, body);
    } catch (err) {
      const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      options.onRecord({ ...base, outcome: "error", status: 0, status_text: "", final_url: url, redirected: false, headers: {}, body_sha256: null, body_bytes: 0, error });
      throw err;
    }
  }) as FetchFn;
}

/** Undo the pilot host mapping on a final URL so records hold the logical URL. */
function unmapUrl(finalUrl: string, logicalUrl: string, hostMap?: Record<string, string>): string {
  if (!hostMap) return finalUrl;
  try {
    const final = new URL(finalUrl);
    for (const [host, mapped] of Object.entries(hostMap)) {
      if (final.host === mapped) {
        final.host = new URL(logicalUrl).hostname === host ? new URL(logicalUrl).host : host;
        return final.href;
      }
    }
  } catch {
    // fall through
  }
  return finalUrl;
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export interface SyntheticResponse {
  status: number;
  contentType: string;
  body: string;
  reason: string;
}

export interface ReplayFetchOptions {
  records: NodeFetchRecord[];
  loadBody: (sha: string) => Buffer;
  synthetic?: Map<string, SyntheticResponse>;
  onEvent: (event: FetchEvent) => void;
  /** Called for every request with no record (counts toward invalidity) */
  onMiss: (method: string, url: string) => void;
}

export function createReplayFetch(options: ReplayFetchOptions): FetchFn {
  const byKey = new Map<string, NodeFetchRecord>();
  for (const r of options.records) {
    const key = fetchKey(r.method, r.url);
    if (!byKey.has(key)) byKey.set(key, r);
  }
  return (async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    const { url, method } = requestParts(input, init);
    const key = fetchKey(method, url);
    const synthetic = options.synthetic?.get(key);
    if (synthetic) {
      options.onEvent({ method, url, decision: "synthetic", purpose: synthetic.reason });
      const res = new Response(synthetic.body, { status: synthetic.status, headers: { "content-type": synthetic.contentType } });
      Object.defineProperty(res, "url", { value: url });
      return res;
    }
    const record = byKey.get(key);
    if (!record) {
      options.onEvent({ method, url, decision: "miss", purpose: "unrecorded" });
      options.onMiss(method, url);
      throw new TypeError(`fetch failed (eval replay: no recorded response for ${method} ${url})`);
    }
    options.onEvent({ method, url, decision: "served", purpose: record.purpose });
    if (record.outcome === "error") {
      // A recorded failure stays a failure
      throw new TypeError(`fetch failed (recorded: ${record.error ?? "error"})`);
    }
    const body = record.body_sha256 ? options.loadBody(record.body_sha256) : null;
    if (record.body_sha256 && body && sha256(body) !== record.body_sha256) {
      throw new Error(`eval replay: body for ${url} does not match its recorded hash`);
    }
    return buildResponse(record, body);
  }) as FetchFn;
}

/** A fetch that refuses everything (used where no Node fetch is expected). */
export function createDenyFetch(onMiss: (method: string, url: string) => void): FetchFn {
  return (async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    const { url, method } = requestParts(input, init);
    onMiss(method, url);
    throw new TypeError(`fetch failed (eval: Node fetch denied for ${method} ${url})`);
  }) as FetchFn;
}
