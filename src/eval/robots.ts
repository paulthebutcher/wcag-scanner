// ---------------------------------------------------------------------------
// robots.txt for capture etiquette (RFC 9309). Unlike the engine's parser
// (wildcard group, Disallow prefixes only) this honours our own product
// token, Allow rules with longest-match precedence, `*` and `$` patterns and
// Crawl-delay. Fetch outcomes follow the RFC, except that anything other
// than a clean response or a 4xx means the site is skipped, never "allowed".
// ---------------------------------------------------------------------------

export const EVAL_PRODUCT_TOKEN = "wcagengine-eval";

interface Rule {
  allow: boolean;
  pattern: string;
}

export interface RobotsPolicy {
  /** "parsed" | "absent" (4xx: no restrictions) */
  source: "parsed" | "absent";
  group: "product" | "wildcard" | "none";
  rules: Rule[];
  crawlDelaySeconds: number | null;
  sitemaps: string[];
}

export type RobotsFetchOutcome =
  | { kind: "ok"; status: number; body: string }
  | { kind: "http-error"; status: number }
  | { kind: "network-error"; error: string };

export type RobotsDecision =
  | { usable: true; policy: RobotsPolicy }
  | { usable: false; reason: string };

/** Turn a robots.txt fetch outcome into a policy, or a reason to skip the site. */
export function decideRobots(outcome: RobotsFetchOutcome, productToken = EVAL_PRODUCT_TOKEN): RobotsDecision {
  if (outcome.kind === "network-error") return { usable: false, reason: `robots.txt fetch failed: ${outcome.error}` };
  if (outcome.kind === "http-error") {
    if (outcome.status >= 400 && outcome.status < 500) {
      return { usable: true, policy: { source: "absent", group: "none", rules: [], crawlDelaySeconds: null, sitemaps: [] } };
    }
    return { usable: false, reason: `robots.txt returned HTTP ${outcome.status}` };
  }
  return { usable: true, policy: parseRobots(outcome.body, productToken) };
}

export function parseRobots(content: string, productToken = EVAL_PRODUCT_TOKEN): RobotsPolicy {
  type Group = { agents: string[]; rules: Rule[]; crawlDelay: number | null };
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      // An empty Disallow allows everything; an empty Allow means nothing
      if (value) current.rules.push({ allow: key === "allow", pattern: value });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }

  const token = productToken.toLowerCase();
  const product = groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
  const wildcard = groups.filter((g) => g.agents.includes("*"));
  const chosen = product.length > 0 ? product : wildcard;
  const delays = chosen.map((g) => g.crawlDelay).filter((d): d is number => d !== null);
  return {
    source: "parsed",
    group: product.length > 0 ? "product" : wildcard.length > 0 ? "wildcard" : "none",
    rules: chosen.flatMap((g) => g.rules),
    crawlDelaySeconds: delays.length > 0 ? Math.max(...delays) : null,
    sitemaps,
  };
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** Longest matching rule wins; on a tie, Allow wins; no match means allowed. */
export function isAllowed(policy: RobotsPolicy, url: string): boolean {
  let path: string;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    return false;
  }
  if (path === "/robots.txt") return true;
  let best: Rule | null = null;
  for (const rule of policy.rules) {
    if (!patternToRegex(rule.pattern).test(path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}
