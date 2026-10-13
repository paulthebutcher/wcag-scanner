import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Independent egress denial (D0). Replay must never reach a site or a model.
// Routing is the first line; these are the backstops that see anything the
// routing missed, and they record the attempt out of band so a scanner that
// swallows the resulting error still produces an invalid run.
//
//   Browser: Chromium is launched with a proxy pointing at a local server
//            that refuses and logs every request, CONNECT and upgrade.
//            Loopback is proxied too (--proxy-bypass-list=<-loopback>).
//   Node:    net.Socket.prototype.connect refuses every TCP connection.
// ---------------------------------------------------------------------------

export interface EgressAttempt {
  source: "browser" | "node";
  kind: string;
  target: string;
  at: string;
}

export class EgressLog {
  readonly attempts: EgressAttempt[] = [];

  record(source: EgressAttempt["source"], kind: string, target: string): void {
    this.attempts.push({ source, kind, target, at: new Date().toISOString() });
  }

  count(): number {
    return this.attempts.length;
  }
}

export interface DenyProxy {
  port: number;
  /** Launch options that route every browser request through the proxy. */
  launchOptions: { proxy: { server: string; bypass: string }; args: string[] };
  close(): Promise<void>;
}

export async function startDenyProxy(log: EgressLog): Promise<DenyProxy> {
  const server = http.createServer((req, res) => {
    log.record("browser", `http-${(req.method ?? "GET").toLowerCase()}`, req.url ?? "");
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("eval egress denied");
  });
  server.on("connect", (req, socket) => {
    log.record("browser", "connect", req.url ?? "");
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  server.on("upgrade", (req, socket) => {
    log.record("browser", "upgrade", req.url ?? "");
    socket.destroy();
  });
  // A socket that is torn down mid-request must not crash the harness
  server.on("clientError", (_err, socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    launchOptions: {
      proxy: { server: `http://127.0.0.1:${port}`, bypass: "" },
      // Chromium never proxies loopback unless told to; the pilot fixture
      // and anything "external-looking" on 127.0.0.1 must hit the proxy too.
      args: ["--proxy-bypass-list=<-loopback>"],
    },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

// ---------------------------------------------------------------------------
// Node socket denial
// ---------------------------------------------------------------------------

type ConnectFn = (this: net.Socket, ...args: unknown[]) => net.Socket;

let installed: { original: ConnectFn; depth: number; logs: Set<EgressLog>; allow: Set<string> } | null = null;

function describeTarget(args: unknown[]): { tcp: boolean; target: string } {
  const first = args[0];
  // connect(options, cb) — options may itself be wrapped in an array by
  // internal callers (normalized args)
  const opts = Array.isArray(first) ? first[0] : first;
  if (opts && typeof opts === "object") {
    const o = opts as { path?: string; host?: string; port?: number | string };
    if (o.path) return { tcp: false, target: o.path };
    return { tcp: true, target: `${o.host ?? "localhost"}:${o.port ?? "?"}` };
  }
  if (typeof first === "string" && Number.isNaN(Number(first))) return { tcp: false, target: first };
  const host = typeof args[1] === "string" ? args[1] : "localhost";
  return { tcp: true, target: `${host}:${String(first)}` };
}

/**
 * Refuse every outbound TCP connection from this process until the returned
 * function is called. Unix-domain sockets (local IPC) are allowed; specific
 * loopback `host:port` targets can be allowed for in-process test servers.
 * Nested installs share one patch.
 */
export function installNodeEgressDenial(log: EgressLog, allow: string[] = []): () => void {
  if (!installed) {
    const original = net.Socket.prototype.connect as unknown as ConnectFn;
    const state = { original, depth: 0, logs: new Set<EgressLog>(), allow: new Set<string>() };
    installed = state;
    (net.Socket.prototype as unknown as { connect: ConnectFn }).connect = function patched(this: net.Socket, ...args: unknown[]): net.Socket {
      const { tcp, target } = describeTarget(args);
      if (!tcp || state.allow.has(target)) return state.original.apply(this, args);
      for (const l of state.logs) l.record("node", "tcp-connect", target);
      const err = Object.assign(new Error(`eval egress denied: ${target}`), { code: "ECONNREFUSED" });
      process.nextTick(() => this.destroy(err));
      return this;
    };
  }
  const state = installed;
  state.depth++;
  state.logs.add(log);
  for (const a of allow) state.allow.add(a);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.logs.delete(log);
    for (const a of allow) state.allow.delete(a);
    state.depth--;
    if (state.depth === 0) {
      (net.Socket.prototype as unknown as { connect: ConnectFn }).connect = state.original;
      installed = null;
    }
  };
}
