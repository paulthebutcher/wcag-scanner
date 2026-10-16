// ---------------------------------------------------------------------------
// Scan and capture etiquette: at least N seconds between top-level loads per host
// (reloads and interaction-driven navigations included); a larger robots
// crawl-delay wins. Calls for one host are serialised.
// ---------------------------------------------------------------------------

export interface PaceRecord {
  host: string;
  url: string;
  at: string;
  waited_ms: number;
}

export class Pacer {
  private readonly last = new Map<string, number>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly crawlDelayMs = new Map<string, number>();
  readonly log: PaceRecord[] = [];

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  setCrawlDelay(host: string, seconds: number): void {
    if (Number.isFinite(seconds) && seconds > 0) this.crawlDelayMs.set(host, seconds * 1000);
  }

  intervalFor(host: string): number {
    return Math.max(this.minIntervalMs, this.crawlDelayMs.get(host) ?? 0);
  }

  beforeTopLevel(url: string): Promise<void> {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return Promise.resolve();
    }
    const prior = this.chains.get(host) ?? Promise.resolve();
    const next = prior.then(async () => {
      const last = this.last.get(host);
      const wait = last === undefined ? 0 : Math.max(0, last + this.intervalFor(host) - this.now());
      if (wait > 0) await this.sleep(wait);
      this.last.set(host, this.now());
      this.log.push({ host, url, at: new Date().toISOString(), waited_ms: wait });
    });
    this.chains.set(host, next.catch(() => {}));
    return next;
  }

  /** Smallest observed gap between consecutive loads per host (for verification). */
  minObservedGapMs(): Record<string, number> {
    const byHost = new Map<string, number[]>();
    for (const r of this.log) {
      const list = byHost.get(r.host) ?? [];
      list.push(Date.parse(r.at));
      byHost.set(r.host, list);
    }
    const out: Record<string, number> = {};
    for (const [host, times] of byHost) {
      let min = Infinity;
      for (let i = 1; i < times.length; i++) min = Math.min(min, times[i] - times[i - 1]);
      out[host] = min;
    }
    return out;
  }
}
