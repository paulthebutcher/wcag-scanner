# Phase 1 Checkpoint 0

Read-only investigation, 2026-10-12. No municipal hostnames or URLs appear in this file; sites are named by pseudonymous id (`t01` Popfly tuning, `t02` Lakewood tuning).

## Starting state

- Starting SHA `5d7a46777178ef67dd715e4bf2dd249f4c9fc182` (main). Tree clean apart from the untracked earlier plan draft `docs/phase1-eval-harness-plan.md` (left untouched; the pasted plan is authoritative).
- Pre-existing checks at the starting SHA: `tsc --noEmit` exit 0, `eslint src/` exit 0, `vitest run` 49 files, 1,305 tests, all passing. No pre-existing failures to separate from new ones.
- Node v24.2.0, Playwright 1.58.2 (Chromium 145.0.7632.6, revision 1208), axe-core 4.11.1, @anthropic-ai/sdk 0.39.0.

## Starting facts

| Item | Expected | Observed | Effect |
|---|---|---|---|
| Baseline tag | `ffdcd30…` | Annotated tag object `4321c68…` peels to `ffdcd308610527525fb82ccd118a7f7b89334b66` | None. Always resolve with `^{commit}`. |
| Baseline scan | `77a43f3b`, 50 pages, 1,549 findings, older schema | Confirmed. Baseline store lacks `baseline_scan_id`; manifest records tiers 1–5 and API key present | None |
| `wcag.db` | Popfly from Oct 4 | 14 sessions, Oct 4 to Oct 12. Two Popfly scans (`9801974a`, `6d4e82fe`) were made after the 2026-10-12 observation and after the HEAD commit | None; they are not used |
| `wcag-old.db` | 38 Lakewood sessions Mar 25 to May 20, early Popfly | 38 Lakewood + 4 Popfly sessions; every snapshot has `full_dom` | None |
| Seed labels | 18 rows, no resolution fields | Confirmed. Seed scan ids `43baee52` (SL-003–006) and `75b64562` (SL-001, 002) exist in no store | Resolution must use the hints |
| Tuning page lists | `ee56b381` 50 pages; `1a6e3c3e` 17 pages | Confirmed, each prefix matches exactly one scan | None |
| Scan hints | `352d16a6`, `fd896cef`, `ab75ea1b`, `f5d0954e`, `9aee533b`, `a9d53405` | Each matches exactly one session in `wcag-old.db` | None |
| Alt-text vision input | Node `fetch` + resize | Confirmed (`image-fetch.ts`: fetch, ≤8 MB, sharp resize to 800 px PNG). At the baseline, alt text sends **no image** (no provider wired) | Baseline alt-text requests are no-image by construction |
| High-risk vision input | Provider exists, unwired | Confirmed at HEAD and baseline | Production requests are no-image; left unwired |
| Error-evaluation vision input | `screenshotAfter` | Confirmed at HEAD and baseline (`checks/forms` is byte-identical between the two) | Needs substitution in replay at both versions |
| Keyboard evidence | No check populates `keyboard_sequence` | Confirmed (only `evidence.ts` passes it through) | Review shows captured evidence plus replay |
| Submission interception | POST document/fetch/XHR only | Confirmed; everything else gets a page-level `route.continue()` | `continue()` would bypass context-level replay; eval wraps it as `fallback()` |
| Crawler | Wildcard robots; URL-list skips robots; Node fetch bypasses HAR | Confirmed. Also: HEAD URL-list mode still Node-fetches the root to resolve redirects; no user agent or pacing; snapshots are pushed in completion order, so page order varies with page concurrency > 1 | Replay uses page concurrency 1 and serves Node fetches from the record |
| In-scan cache key | Template, user message, image | Confirmed: sha1(template name, user message, image base64 when vision); omits model id and system prompt | Persistent cache uses its own key |
| Clustering key | Tier constants | Confirmed: `finding_type_hash` = sha256(criterion, tier constant such as `semantic`, platform) | Never used as identity |
| API failures | needs_review, "Prompt evaluation failed" | Confirmed: 622 such rows in `ab75ea1b`, all "…after 3 retries: 400" | SL-011 split is supported by evidence |

## Differences that shape the plan

1. **The baseline has no URL-list mode.** `ffdcd30`'s crawler always fetches robots and sitemaps with Node `fetch`, BFS-follows links, waits for `networkidle` with a hard 30 s timeout, runs sequentially and samples CMS collections with `Math.random`. It also launches its own Chromium (scan calls `crawl()` without a browser).
2. **Same models and SDK at both versions.** `claude-sonnet-4-6` / `claude-opus-4-6`, SDK 0.39.0, `temperature: 0`, `max_tokens: 4096`. Identical effective requests can share recorded responses.
3. **Baseline has no coverage recording** (added in `849ebe0`). Baseline coverage is "not recorded" for every check; HEAD-vs-baseline coverage deltas are unavailable rather than zero.
4. **Error-message prompts receive the first 8,000 characters of the whole post-submission page DOM** as `formHtml`, usually `<head>` content rather than the form. Logged as a Phase 2 defect; not changed.

## Network and model entry points

| Path | HEAD | Baseline |
|---|---|---|
| Browser launch | `scanner.ts` (unless injected), `crawler.ts` (unless injected), `report/pdf-renderer.ts` (report only) | `scanner.ts` and `crawler.ts` each launch their own |
| Contexts | Crawl context; one shared Tier 2/4 context; pages per behavioral page and per form | Same shape; axe re-loads each page in the shared context |
| Page routes | `submission.ts` `page.route("**/*")` | Same |
| Node fetch | crawler root redirect, robots, sitemaps; `image-fetch.ts` | crawler robots, sitemaps |
| Model | One shared `PromptRunner` (`createPromptRunner`), injectable via `options.promptRunner`; `new Anthropic()` only in `PromptRunner` | Separate runners for Tier 3 and Tier 4, both injectable |
| Vision inputs | `alt_text_quality` (fetched image), `error_message_quality` (`screenshotAfter`), `high_risk_form_detection` (none: provider unwired) | `error_message_quality` only |

## Proposed transport hooks

- **Browser:** one harness-launched Chromium wrapped in a controlled browser. Every `newContext` gets blocked service workers, fixed UA/locale/timezone, a context router (submission containment → HAR or declared exclusion → logged miss; in capture: pacing and live), a page wrapper that turns engine `route.continue()` into `route.fallback()`, and CDP navigation-reason tracking for GET form submissions. Replay launches Chromium through a deny-and-log proxy that also covers loopback and WebSockets. HEAD receives it through the existing `scan(options, browser)` parameter.
- **Node:** a process-level `fetch` shim (capture: UA, pacing, recording; replay: serve the recorded Node-fetch log; otherwise deny) plus a socket-connect denial that logs attempts even when engine code swallows the error.
- **Model:** the engine's own `createPromptRunner`, with its `client` replaced by an eval client (inject, collect, record, replay). Raw responses pass through each engine's own parsing and retry.
- **Images:** alt-text source bytes are served to the engine's own fetcher from the record; the model boundary verifies that every request image is a recorded production input and fails closed otherwise. Error-evaluation images need one scanner hook (`options.eval`, default off) that replaces `screenshotAfter` with the recorded capture-time bytes, or with nothing for a recorded no-image state.

## Proposed baseline bridge

A worktree at `ffdcd30` under `wcag-data/eval-worktrees/`, sharing `node_modules` (runtime dependencies are identical), built with `tsc`. Adapter: substitute the controlled browser for `chromium.launch`, serve the recorded robots file and a synthetic sitemap listing exactly the frozen pages (in an order the baseline's CMS grouping preserves), set `maxPages` and `cmsSamples` to the page count, inject the eval runner. Patch: one hunk in `scanner.ts` adding the same submission-image hook. The manifest records original SHA, patch hash and effective source hash.

## Seed resolution gaps

| Seeds | Hint | What the store shows |
|---|---|---|
| SL-001, 002 | scan level | Seed scan absent from every store |
| SL-003–006, 009 | `352d16a6` | 26 `custom_interactive_no_role` and 1 `missing_aria_selected` rows, but no `missing_tab_role`; SL-005/006 markup still to be searched; one critical `high_risk_form` row (SL-009) |
| SL-007, 008 | `fd896cef` | 120 `link-name` rows; 3 `color-contrast` rows stored as definitive, major |
| SL-010, 011 | `ab75ea1b` | 498 API-failure `2.4.4` rows plus 18 `duplicate_link_text` = 516; 102 `1.1.1` rows are needs_review |
| SL-012 | `f5d0954e` | 4 `1.3.5` rows, all needs_review |
| SL-013–015 | `9aee533b` | No axe `1.1.1` rows (10 `empty_alt_on_informative` from the model); 5 `skipped_level` rows, not 9; multiple-ways already advisory |
| SL-016 | scan level | Synthetic fixtures |
| SL-017, 018 | `a9d53405` | One critical `high_risk_form` row; link rows to be matched |

## Decisions for Paul (none block local work)

1. `EVAL_CONTACT_URL` value. Blocks live capture (D1).
2. Approval and a `--max-cost-usd` budget for `record`. Blocks recorded model responses (D3, D6, D10 record step).
3. SL-014 adjudication (already in the plan as pending).
4. The Lakewood hostname is already committed in `eval/seed-labels.jsonl`, `CHANGELOG.md`, four `scripts/`, `src/checks/semantic/duplicate-links.ts` and three tests. The privacy test covers eval exports and new eval files only. Whether to scrub history is your call.
