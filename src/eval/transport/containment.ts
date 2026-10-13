// ---------------------------------------------------------------------------
// Submission containment (D0 item 4). Lives in eval code; the engine's own
// form interceptor is untouched. Every eval context, in capture and replay,
// classifies each request before anything else sees it:
//
//   - any method other than GET/HEAD/OPTIONS is a submission: a navigation is
//     answered 204 (the page stays put, as it would on a blocked submit),
//     anything else is aborted;
//   - a GET navigation that Chromium reports as a form submission
//     (Page.frameRequestedNavigation reason formSubmissionGet/Post) is
//     answered 204;
//   - everything else passes on to capture (live) or replay (HAR).
// ---------------------------------------------------------------------------

export type ContainmentDecision = "pass" | "contain-navigation" | "contain-abort";

export interface RequestFacts {
  method: string;
  isNavigation: boolean;
  url: string;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function classifyRequest(req: RequestFacts, isPendingFormSubmission: boolean): ContainmentDecision {
  if (!SAFE_METHODS.has(req.method.toUpperCase())) return req.isNavigation ? "contain-navigation" : "contain-abort";
  if (req.isNavigation && isPendingFormSubmission) return "contain-navigation";
  return "pass";
}

/** Normalise a URL the way CDP and the network layer may differ ("…/self?" vs "…/self"). */
export function submissionKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    let s = u.href;
    if (s.endsWith("?")) s = s.slice(0, -1);
    return s;
  } catch {
    return url;
  }
}

export const FORM_SUBMISSION_REASONS = new Set(["formSubmissionGet", "formSubmissionPost"]);

/**
 * Form-submission navigations announced by CDP, waiting for their network
 * request. Entries expire so a submission that never produced a request
 * cannot later contain an ordinary navigation to the same URL.
 */
export class PendingSubmissions {
  private readonly pending = new Map<string, number[]>();

  constructor(private readonly ttlMs = 15_000, private readonly now: () => number = Date.now) {}

  add(url: string): void {
    const key = submissionKey(url);
    const list = this.pending.get(key) ?? [];
    list.push(this.now());
    this.pending.set(key, list);
  }

  /** Consume a pending submission for `url`, if one is live. */
  take(url: string): boolean {
    const key = submissionKey(url);
    const list = this.pending.get(key);
    if (!list) return false;
    const cutoff = this.now() - this.ttlMs;
    while (list.length > 0 && list[0] < cutoff) list.shift();
    if (list.length === 0) {
      this.pending.delete(key);
      return false;
    }
    list.shift();
    if (list.length === 0) this.pending.delete(key);
    return true;
  }
}
