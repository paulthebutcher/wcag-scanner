import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Frame, type Page, type Request, type Route, type CDPSession } from "playwright";
import { EgressLog, startDenyProxy, type DenyProxy } from "./egress.js";
import { classifyRequest, FORM_SUBMISSION_REASONS, PendingSubmissions } from "./containment.js";
import { bodyOf, FuzzyIndex } from "./har.js";
import type { Pacer } from "./pacer.js";

// ---------------------------------------------------------------------------
// The controlled browser: the one transport boundary every engine browser
// context, page, reload and popup goes through in eval runs.
//
// The harness launches Chromium itself and hands engines a proxy object.
// Each newContext() is created with the eval browser contract (blocked
// service workers, fixed locale/timezone/user agent) and routed:
//
//   priority  handler
//   highest   containment (submissions answered 204 or aborted)
//             [capture] pacing, robots, then live network (HAR recorded)
//             [replay]  Playwright routeFromHAR (redirect-aware), then
//   lowest    [replay]  miss handler: cache-buster fuzzy match, declared
//                       exclusion, or an unexpected miss (logged, aborted)
//
// Engine page.route() handlers run before context routes; their
// route.continue() is turned into route.fallback() so it reaches the eval
// routes instead of the network. WebSockets are refused in both modes.
// In replay Chromium also runs through a deny-and-log proxy, so anything
// that slips past routing is still caught and counted.
// ---------------------------------------------------------------------------

export type TransportMode = "capture" | "replay";

export type Decision =
  | "live"
  | "har"
  | "fuzzy"
  | "declared-exclusion"
  | "miss"
  | "contained-submission"
  | "robots-blocked"
  | "websocket-blocked";

export interface TransportEvent {
  at: string;
  context: number;
  page_url: string | null;
  method: string;
  url: string;
  resource_type: string;
  frame: "main" | "sub" | "none";
  navigation: boolean;
  decision: Decision;
  detail?: string;
}

export interface BrowserContract {
  viewport: { width: number; height: number; deviceScaleFactor: number };
  locale: string;
  timezone: string;
  userAgent: string;
}

export interface ControlledBrowserOptions {
  mode: TransportMode;
  contract: BrowserContract;
  /** Replay: the merged HAR to serve */
  harPath?: string;
  /** Replay: entries for cache-buster fuzzy matching */
  fuzzy?: FuzzyIndex;
  /** Replay: host suffixes (optionally with a path prefix) whose misses are declared */
  declaredExclusions?: string[];
  /** Capture: pacing for main-frame navigations */
  pacer?: Pacer;
  /** Capture: robots check; a disallowed request is aborted */
  isAllowed?: (url: string) => boolean;
  onEvent?: (event: TransportEvent) => void;
  /** Extra launch args (tests) */
  launchArgs?: string[];
}

export interface TransportCounters {
  contexts: number;
  pages: number;
  popups: number;
  cdp_attached: number;
  cdp_failed: number;
  by_decision: Record<Decision, number>;
}

export interface ControlledBrowser {
  /** Hand this to engines (scan(options, browser) or the launch interception) */
  browser: Browser;
  raw: Browser;
  mode: TransportMode;
  egress: EgressLog;
  events: TransportEvent[];
  counters: TransportCounters;
  browserVersion: string;
  /**
   * True when form-submission navigations on this page are tracked (its CDP
   * session is attached). Capture never activates a form on a page where
   * submissions cannot be told apart from ordinary navigation.
   */
  isTracked(page: Page): boolean;
  close(): Promise<void>;
}

function emptyCounters(): TransportCounters {
  return {
    contexts: 0, pages: 0, popups: 0, cdp_attached: 0, cdp_failed: 0,
    by_decision: {
      "live": 0, "har": 0, "fuzzy": 0, "declared-exclusion": 0, "miss": 0,
      "contained-submission": 0, "robots-blocked": 0, "websocket-blocked": 0,
    },
  };
}

export function matchesDeclaredExclusion(url: string, patterns: string[]): boolean {
  let host: string;
  let path: string;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname;
  } catch {
    return false;
  }
  return patterns.some((p) => {
    const slash = p.indexOf("/");
    const hostPart = (slash === -1 ? p : p.slice(0, slash)).toLowerCase();
    const pathPart = slash === -1 ? "" : p.slice(slash);
    const hostOk = host === hostPart || host.endsWith(`.${hostPart}`);
    return hostOk && (pathPart === "" || path.startsWith(pathPart));
  });
}

export async function launchControlledBrowser(options: ControlledBrowserOptions): Promise<ControlledBrowser> {
  const egress = new EgressLog();
  const events: TransportEvent[] = [];
  const counters = emptyCounters();
  let proxy: DenyProxy | null = null;
  if (options.mode === "replay") proxy = await startDenyProxy(egress);

  const raw = await chromium.launch({
    headless: true,
    ...(proxy ? { proxy: proxy.launchOptions.proxy } : {}),
    args: [...(proxy?.launchOptions.args ?? []), ...(options.launchArgs ?? [])],
  });
  let contextSeq = 0;
  const tracked = new WeakSet<object>();

  const emit = (event: Omit<TransportEvent, "at">): void => {
    const full = { at: new Date().toISOString(), ...event };
    events.push(full);
    counters.by_decision[event.decision]++;
    options.onEvent?.(full);
  };

  const describe = (ctxId: number, request: Request): Omit<TransportEvent, "at" | "decision"> => {
    let frame: Frame | null = null;
    try { frame = request.frame(); } catch { frame = null; }
    let pageUrl: string | null = null;
    let main = false;
    try {
      const page = frame?.page();
      pageUrl = page ? page.url() : null;
      main = frame ? frame === page?.mainFrame() : false;
    } catch {
      // Service-worker or detached-frame requests have no page
    }
    return {
      context: ctxId,
      page_url: pageUrl,
      method: request.method(),
      url: request.url(),
      resource_type: request.resourceType(),
      frame: frame ? (main ? "main" : "sub") : "none",
      navigation: request.isNavigationRequest(),
    };
  };

  const setUpContext = async (ctx: BrowserContext, ctxId: number): Promise<void> => {
    const pending = new PendingSubmissions();
    const attaching = new WeakMap<object, Promise<void>>();
    const watched = new WeakSet<Page>();

    // Idempotent: concurrent callers share one attach, so newPage() never
    // returns a page whose submission tracking is still being set up.
    const attachCdp = (target: Page | Frame): Promise<void> => {
      const existing = attaching.get(target);
      if (existing) return existing;
      const promise = doAttach(target);
      attaching.set(target, promise);
      return promise;
    };
    const doAttach = async (target: Page | Frame): Promise<void> => {
      let session: CDPSession;
      try {
        session = await ctx.newCDPSession(target as Page);
      } catch {
        // In-process frames share their page's session; only OOPIFs get one
        if ("mainFrame" in target) counters.cdp_failed++;
        return;
      }
      try {
        session.on("Page.frameRequestedNavigation", (e: { reason: string; url: string }) => {
          if (FORM_SUBMISSION_REASONS.has(e.reason)) pending.add(e.url);
        });
        await session.send("Page.enable");
        counters.cdp_attached++;
        tracked.add(target);
      } catch {
        counters.cdp_failed++;
      }
    };

    const watchPage = (page: Page): void => {
      if (watched.has(page)) return;
      watched.add(page);
      page.on("frameattached", (frame) => { void attachCdp(frame); });
    };

    ctx.on("page", (page) => {
      // Pages from newPage() are also attached before they are returned;
      // this covers popups and window.open targets.
      watchPage(page);
      void attachCdp(page);
      void page.opener().then((opener) => { if (opener) counters.popups++; }, () => {});
    });

    // --- WebSockets: refused in both modes ---------------------------------
    await ctx.routeWebSocket(/.*/, (ws) => {
      emit({ context: ctxId, page_url: null, method: "GET", url: ws.url(), resource_type: "websocket", frame: "none", navigation: false, decision: "websocket-blocked" });
      ws.close({ code: 1008, reason: "eval transport: websockets refused" }).catch(() => {});
    });

    // Requests handed to the HAR, and those that fell through it, so a
    // finished request can be counted as served from the HAR exactly once.
    const handedToHar = new WeakSet<Request>();
    const fellThrough = new WeakSet<Request>();
    ctx.on("requestfinished", (request) => {
      if (handedToHar.has(request) && !fellThrough.has(request)) {
        emit({ ...describe(ctxId, request), decision: "har" });
      }
    });

    // --- Replay: lowest priority miss handler, then the HAR ------------------
    if (options.mode === "replay") {
      if (!options.harPath) throw new Error("replay transport needs a HAR");
      await ctx.route("**/*", async (route: Route, request: Request) => {
        fellThrough.add(request);
        const facts = describe(ctxId, request);
        const fuzzy = options.fuzzy?.lookup(request.method(), request.url());
        if (fuzzy) {
          emit({ ...facts, decision: "fuzzy", detail: fuzzy.request.url });
          await route.fulfill({
            status: fuzzy.response.status,
            headers: Object.fromEntries(fuzzy.response.headers.filter((h) => !/^content-length$|^content-encoding$/i.test(h.name)).map((h) => [h.name, h.value])),
            body: bodyOf(fuzzy),
          }).catch(() => {});
          return;
        }
        const declared = matchesDeclaredExclusion(request.url(), options.declaredExclusions ?? []);
        emit({ ...facts, decision: declared ? "declared-exclusion" : "miss" });
        await route.abort("blockedbyclient").catch(() => {});
      });
      await ctx.routeFromHAR(options.harPath, { notFound: "fallback" });
    }

    // --- Highest priority: containment (+ capture pacing and robots) --------
    await ctx.route("**/*", async (route: Route, request: Request) => {
      const facts = describe(ctxId, request);
      let isPending = false;
      if (facts.navigation) {
        isPending = pending.take(request.url());
        if (!isPending && request.method().toUpperCase() === "GET") {
          // CDP announces form navigations before the request; allow a
          // short grace period for the event to be processed.
          await new Promise((r) => setTimeout(r, 30));
          isPending = pending.take(request.url());
        }
      }
      const decision = classifyRequest({ method: request.method(), isNavigation: facts.navigation, url: request.url() }, isPending);
      if (decision === "contain-navigation") {
        emit({ ...facts, decision: "contained-submission", detail: isPending ? "form-submission-navigation" : "unsafe-method-navigation" });
        await route.fulfill({ status: 204, body: "" }).catch(() => {});
        return;
      }
      if (decision === "contain-abort") {
        emit({ ...facts, decision: "contained-submission", detail: `unsafe-method-${request.resourceType()}` });
        await route.abort("blockedbyclient").catch(() => {});
        return;
      }
      if (options.mode === "capture") {
        if (options.isAllowed && !options.isAllowed(request.url())) {
          emit({ ...facts, decision: "robots-blocked" });
          await route.abort("blockedbyclient").catch(() => {});
          return;
        }
        if (facts.navigation && facts.frame === "main" && options.pacer) {
          await options.pacer.beforeTopLevel(request.url());
        }
        emit({ ...facts, decision: "live" });
        await route.continue().catch(() => {});
        return;
      }
      // Replay: hand on to the HAR; a miss falls through to the miss handler
      handedToHar.add(request);
      await route.fallback().catch(() => {});
    });

    // Context-level wrappers so engine code can never get an unwrapped page
    (ctx as unknown as { __evalAttach: typeof attachCdp; __evalWatch: typeof watchPage }).__evalAttach = attachCdp;
    (ctx as unknown as { __evalWatch: typeof watchPage }).__evalWatch = watchPage;
  };

  const wrapContext = (ctx: BrowserContext): BrowserContext => {
    const internals = ctx as unknown as { __evalAttach: (p: Page) => Promise<void>; __evalWatch: (p: Page) => void };
    return new Proxy(ctx, {
      get(target, prop) {
        if (prop === "newPage") {
          return async () => {
            const page = await target.newPage();
            counters.pages++;
            internals.__evalWatch(page);
            await internals.__evalAttach(page);
            return wrapPage(page);
          };
        }
        if (prop === "pages") return () => target.pages().map(wrapPage);
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };

  const newContext = async (engineOptions: BrowserContextOptions = {}): Promise<BrowserContext> => {
    const ctxId = ++contextSeq;
    counters.contexts++;
    const ctx = await raw.newContext({
      ...engineOptions,
      viewport: engineOptions.viewport ?? { width: options.contract.viewport.width, height: options.contract.viewport.height },
      deviceScaleFactor: engineOptions.deviceScaleFactor ?? options.contract.viewport.deviceScaleFactor,
      locale: options.contract.locale,
      timezoneId: options.contract.timezone,
      userAgent: options.contract.userAgent,
      serviceWorkers: "block",
    });
    await setUpContext(ctx, ctxId);
    return wrapContext(ctx);
  };

  const browserProxy = new Proxy(raw, {
    get(target, prop) {
      if (prop === "newContext") return newContext;
      if (prop === "newPage") {
        return async (pageOptions: BrowserContextOptions = {}) => {
          const ctx = await newContext(pageOptions);
          return ctx.newPage();
        };
      }
      // Engines close "their" browser when they launched it; the harness
      // owns this one, so close() is a no-op from engine code.
      if (prop === "close") return async () => {};
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    browser: browserProxy,
    raw,
    mode: options.mode,
    egress,
    events,
    counters,
    browserVersion: raw.version(),
    isTracked: (page) => tracked.has(rawPages.get(page) ?? page),
    close: async () => {
      await raw.close().catch(() => {});
      await proxy?.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Page wrapper: engine route handlers keep working, but their
// route.continue() falls back to the eval routes instead of the network.
// ---------------------------------------------------------------------------

const wrappedPages = new WeakMap<Page, Page>();
/** wrapper → underlying page */
const rawPages = new WeakMap<Page, Page>();

type RouteHandler = (route: Route, request: Request) => unknown;

export function wrapPage(page: Page): Page {
  const existing = wrappedPages.get(page);
  if (existing) return existing;
  const handlers = new Map<RouteHandler, RouteHandler>();
  const proxy = new Proxy(page, {
    get(target, prop) {
      if (prop === "route") {
        return (url: Parameters<Page["route"]>[0], handler: RouteHandler, opts?: Parameters<Page["route"]>[2]) => {
          const wrapped: RouteHandler = (route, request) => handler(wrapRoute(route), request);
          handlers.set(handler, wrapped);
          return target.route(url, wrapped, opts);
        };
      }
      if (prop === "unroute") {
        return (url: Parameters<Page["unroute"]>[0], handler?: RouteHandler) => {
          const wrapped = handler ? handlers.get(handler) : undefined;
          if (handler) handlers.delete(handler);
          return target.unroute(url, wrapped ?? handler);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  wrappedPages.set(page, proxy);
  rawPages.set(proxy, page);
  return proxy;
}

function wrapRoute(route: Route): Route {
  return new Proxy(route, {
    get(target, prop) {
      if (prop === "continue") {
        return (overrides?: Parameters<Route["fallback"]>[0]) => target.fallback(overrides);
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
