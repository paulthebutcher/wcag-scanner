# Speed and accuracy plan

Written 2026-10-04 from a read of the code (scanner, crawler, prompt runner, semantic and form checks, prompts). Nothing here was measured; step 1 exists to replace these inferences with timings.

Goal: make scans faster and make the LLM-based findings more accurate, and prove both by comparing a scan from before the changes with one from after.

## Before/after comparison

The baseline is the scan that was running when this plan was written (started 2026-10-04, before any of these changes).

Baseline record:

- Scan ID: `7033a623-fdb7-464f-92d4-6ee1e708bd1d`
- Start URL and tiers: `https://www.popfly.com`, tiers 1–5, API key present. Other flags were not recorded; the 50-page count matches the default `--max-pages 50`.
- Wall-clock duration: 13m 51s (17:40:04 to 17:53:55 UTC). No per-phase timing exists for the baseline.
- Pages: 50 captured (the page cap), 5 excluded as noindex. Pages skipped for timeouts were not stored.
- Findings: 1,619 total.
  - By severity: 118 critical, 1,172 major, 45 minor, 284 advisory.
  - By confidence: 1,028 definitive, 439 high, 63 moderate, 89 needs review.
  - By detector: 924 axe-core, 543 Playwright, 152 Claude API.
- Criteria: 20 failed, 17 passed, 7 not applicable, 0 not tested.

**Caveat found after the fact:** every Claude API call in the baseline failed (`400 This API key is not scoped to a workspace`), so all 152 Claude findings are error placeholders and Tier 3 never really ran. The first post-change scan had the same problem, so the speed comparison below is like-for-like but neither number includes real LLM time.

First post-change scan (`d391ed89-5664-48b6-b3cd-1e4889bdc8f1`, same URL, same failing key):

- Wall-clock: 4m 3s, against 13m 51s (3.4x faster). Phases: crawl 52 s (axe included), behavioral 2m 8s, forms 1m 3s, semantic 5 s (overlapped; calls failed fast).
- LLM: 99 distinct requests, each tried 3 times because the 400 was retried; 405 more were shared with an identical request already in flight.
- Pages: 42 of 50 the same. The new crawl added the static `/platform/*` pages the baseline capped (`adventures`, `affiliate-program`, `sponsored-content`, `storefronts`) and `/company/*`, and dropped 8 activity landing pages at the cap.
- Findings: 1,506 against 1,619; on the 42 shared pages, 1,265 against 1,324.
  - 34 fewer cookie-banner contrast failures. The banner fades in; at `load` it is at 30% opacity, which axe measured as 4.35:1. Once the fade finishes it is light text on dark green and passes. The baseline findings were false positives from checking mid-animation.
  - Playwright issues on shared pages match closely (225 identical, 3 only in the baseline, 10 only in the new scan, mostly focus-visibility on content links), so parallel tabs did not distort the keyboard checks. Per-page counts for nav and footer issues move because shared elements are credited to whichever page is processed first.
- Criteria: 13 moved from passed or not applicable to `not_tested` (step 6, intended).

Each post-change scan writes `<data-dir>/<scan-id>/timings.json` (per-phase times, per-prompt API calls, cache hits, tokens) and prints a timing summary.

Rules for a fair comparison:

- Keep the baseline's data directory untouched. Run post-change scans with the same URL and flags.
- Compare with `wcag report <new-id> --compare <baseline-id>` and by diffing `<data-dir>/<scan-id>/findings.jsonl`.
- Both scans stop at the page cap, and the new crawler picks pages differently (static sections are no longer capped at five, pages that never go network-idle are no longer skipped, and pages finish in a different order). Compare per page where the two scans share a URL before comparing totals.
- For every finding that appears or disappears, decide whether the change is correct. Fewer findings is not automatically better: step 6 will turn some false "passed" criteria into `not_tested`, and step 2 will add pages that the baseline skipped.
- Re-scan after each step where practical, so a regression can be traced to one change.

## What is slow today

- **Each page is loaded three or more times, serially.** The crawl (`src/core/crawler.ts`, loop near line 534), the axe pass (`src/core/scanner.ts` near line 709) and the behavioral pass (near line 816) each `goto` every page in a one-at-a-time loop. Forms add one load per form (near line 1345).
- **The crawl waits for `networkidle`** (`crawler.ts` near line 572). Pages with background requests (video, Lottie, analytics, chat widgets) use the full 30 s timeout and are then skipped.
- **LLM checks wait on each other.** Tier 3 starts only after Tiers 1 and 2 finish, then runs page by page and check by check (`scanner.ts` near line 1005). The concurrency limit of 5 only applies within one check on one page.
- **Shared elements are re-evaluated on every page.** Cross-page dedup runs after the LLM calls (`scanner.ts` near line 1094), so footer and nav links and images are sent once per page.
- **One API call per element** (`runPrompts` in `alt-text.ts`, `link-text.ts`, `widget-aria.ts`, `error-evaluation.ts`).

## What hurts LLM accuracy today

- **The alt-text prompt never sees the image.** The template is marked `vision: true` and tells the model it will get a screenshot, but the scanner calls `runAltTextChecks` without a `screenshotProvider`. `evaluateHighRiskForms` has the same gap.
- **Candidates come from regex over serialized HTML.** The semantic checks cannot tell whether an element is visible or what its computed accessible name is.
- **Criteria are marked passed without being tested.**
  - `semanticExtra` (`scanner.ts` near line 1198) stamps 3.2.4 and 3.3.2 as passed by `claude_api` with no check run.
  - `axeCoveredExtra` (near line 781) stamps 1.3.2, 1.3.3, 1.3.4, 1.3.6, 1.4.5, 1.4.10, 1.4.11, 1.4.12, 1.4.13 and 3.1.2 as passed whenever axe did not report on them.
  - `behavioralExtra` (near line 954) does the same for 2.5.2 and 3.2.1, and marks 2.1.4 and 2.5.1 not applicable without detection.
  - Prompts for use of color, consistent identification, labels or instructions, and content on hover or focus exist in `src/prompts/element-evaluation.ts` but are not wired into the scanner.
- **Parse failures retry the same input at temperature 0**, which mostly reproduces the same output.
- **Nothing is measured.** The scanner creates the prompt runner without a logger, and there is no labelled set to score prompts against.

## Steps, in order

### 1. Instrument

- Time each phase (crawl, axe, behavioral, semantic, forms, indicators) and each page within it.
- Pass a `PromptLogger` to `createPromptRunner` and write per-prompt call counts, tokens, latency and retries to the scan's data directory.
- Print a short timing summary at the end of the scan.

### 2. Fix the crawler

- Replace `networkidle` with `load` plus a capped idle wait (about 5 s), and scan the page anyway when the cap is hit.
- Dedupe the queue so each URL is queued once and the progress counts are real.
- Treat a section as a CMS collection only when its pages share a template structure, not for every two-segment URL (`getCollectionPrefix`, `crawler.ts` near line 67). Static sections such as `/platform/*` must not be capped at the sample size.
- Normalise the start URL through its redirect (for example `popfly.com` to `www.popfly.com`) once, up front.

### 3. Per-page pipeline with a worker pool

- Process 3–4 pages concurrently (configurable).
- Run axe on the crawl's page load, removing one load per page.
- Start a page's LLM checks as soon as its DOM and axe results exist, while its behavioral checks run in a separate tab.
- Verify that parallel tabs do not disturb focus-visibility screenshots or keyboard tests; if they do, give behavioral checks their own browser context or keep that pass at lower concurrency.
- Enabler: have each check declare its criteria, what it needs (DOM, live page, prompt runner) and its dedup key, so a scheduler replaces the hard-coded order inside `scan()`.

### 4. Cut LLM calls

- Dedupe before calling: a scan-wide cache keyed on criterion, element HTML and context. Keep the `also_found_on_pages` annotation.
- Batch 10–15 elements per call within one criterion, returning a JSON array. Do not mix criteria in one call.
- Use one shared prompt runner for the whole scan so the concurrency limit is global, and add backoff on rate-limit errors.

### 5. Better LLM inputs and outputs

- Extract candidates in the browser during the page visit: visibility, computed accessible name, role, and an image crop.
- Send the image to the alt-text prompt and a form screenshot to the high-risk prompt.
- Use structured outputs in place of parsing JSON out of free text.
- Add a few worked examples to each prompt, drawn from reviewed findings.
- Add a second verification call for "fail" verdicts only.

### 6. Honest criterion status

- Change the untested "passed" and "not applicable" stamps listed above to `not_tested`.
- Wire in the four unused prompts one at a time, each with its own candidate extraction, and only then report those criteria as tested.

### 7. Golden set

- Export human verdicts from the `review` command as labelled cases (element, context, criterion, correct verdict).
- Add a script that runs a prompt against the set and reports precision and recall.
- Require a golden-set run before and after any prompt or model change.

## Smaller items

- `flushBatch` in `src/core/prompt-runner.ts` is a stub that runs calls in realtime. The real batch API would cut cost, not wall-clock time; leave it until speed work is done.
- Model IDs are hard-coded in `prompt-runner.ts` (`claude-sonnet-4-6`, `claude-opus-4-6`). Make them configurable so the golden set can compare models.
- The known issue with forms hidden at page load (`KNOWN_ISSUES.md`) is unchanged by this plan.

## Suggested starting point

Steps 1 and 2 together (both small), then the dedupe-before-call part of step 4, then step 3.

## Status (2026-10-04)

Done, with tests passing (1,218 tests):

- **Step 1.** Per-phase timings and per-prompt statistics, written to `timings.json` and printed at the end of the scan.
- **Step 2.** `load` plus an idle cap (5 s at first, now 15 s, see below); queue deduped; a URL prefix is sampled only after two of its pages share a template (`data-wf-page` on Webflow, a structural hash elsewhere); the root URL is resolved through its redirect first.
- **Step 3, in part.** Crawl and behavioral checks run 4 pages at a time (`--page-concurrency`). axe runs on the crawl's page load. Tier 3 starts as soon as axe results are processed and overlaps Tiers 2, 4 and 5. Forms are still tested one at a time. The check registry was not built.
- **Step 4, in part.** One prompt runner per scan with a cache keyed on prompt and input, so identical elements across pages cost one call. All pages and checks share the global concurrency limit (`WCAG_CONCURRENCY` is now honoured). Rate-limit and server errors back off before retrying.
- **Step 5, in part.** The alt-text prompt receives the image (fetched by `src`, downsized), and says so explicitly when no image could be fetched.
- **Step 6, in part.** The untested "passed" and "not applicable" stamps are now `not_tested`.
- Model IDs can be overridden with `WCAG_MODEL_SONNET` and `WCAG_MODEL_OPUS`.

Not done, and why:

- **Batching several elements per call (step 4).** It changes what the model sees per element; wait for the golden set so the accuracy effect can be measured. `timings.json` will show whether call volume still justifies it.
- **In-browser candidate extraction, worked examples, verification pass (step 5).** Same reason: each changes verdicts and needs the golden set. Filtering by visibility also risks dropping elements that are hidden at load but shown later (menus, dropdowns).
- **Structured outputs (step 5).** Needs an SDK upgrade from 0.39. Check the `failures` count per prompt in `timings.json` first; if parse failures are rare this is low value.
- **Screenshot for the high-risk form prompt (step 5).**
- **Wiring the four unused prompts (step 6).**
- **Golden set (step 7).** No findings have been human-reviewed yet, so there is nothing to export.

## Second comparison and follow-up fixes (2026-10-04)

Old code `1d4f7d24` against new code `ba241ce6`, both with a working key, run at the same time: 48m 42s against 6m 46s. Findings matched closely; the differences were page selection and the items below.

- **Keyboard false positives (fixed in `06cf882`).** The tab recorder stopped early on duplicate ids and on iframes, reporting 146 critical 2.1.1 findings on 8 pages that were all reachable.
- **Hedged alt-text verdicts.** The base element prompt now says that a verdict whose reasoning concludes "acceptable" is `pass`, and that `needs_review` is only for evidence that cannot settle the question. Empty-alt images inside an element with `role="button"`, `link`, `menuitem` or `tab` and visible text are now skipped like images inside `<a>` and `<button>`.
- **Heading findings.** Only WCAG failures fail a page: empty headings and non-descriptive headings (2.4.6), and body text marked up as a heading (1.3.1). Skipped levels, multiple `h1`, long headings and missing headings are best practice and are recorded in `measured_values.best_practice_issues` without creating a finding. The failure type and the heading are chosen in code (the most serious type; the heading the model names), so reruns produce the same finding.
- **Late-loading widgets.** GrowSurf injects its widget 2–3 s after load, just before the network goes quiet. With two scans running at once, 8 pages hit the 5 s cap first. The cap is now 15 s; pages that go quiet are captured as soon as they do, so normal pages are unaffected. The crawl reports how many pages hit the cap.

## Third comparison (2026-10-04)

Old code alone with a working key (`77a43f3b`, run from the baseline worktree) against new code alone with all fixes (`e779c8b0`):

- **Speed:** 44m 55s against 6m 37s. 101 Claude calls (407 more answered from the in-scan cache), 154k tokens. Phases: crawl 61 s, behavioral 2m 16s, semantic 2m 33s, forms 3m 19s (semantic and forms overlap the others). Forms are now the longest phase: forms are tested one at a time and the error-message prompt averages 23 s per call.
- **Findings:** 1,342 against 1,549; critical 22 against 121. 2.1.1 now passes (107 false "unreachable" findings gone); 0 cookie-banner contrast false positives (33 before).
- **Headings:** 41 findings under 1.3.1 (body text marked up as a heading) and 3 under 2.4.6 (empty headings), against 50 mixed findings under 2.4.6. Spot-checked: the headings named are correct; 13 are an `h3.feature-card-title` holding a paragraph (captured mid fade-in, opacity 0), 12 are one hero subtitle repeated across pages. All 41 land in "possibly noisy" because the confidence calibration rates `style_not_structure` as high false-positive risk.
- **Focus visibility (fixed after this scan):** 2.4.7 rose from 67 to 97 on shared pages, mostly 31 "Read the Post" buttons on `/insights` that the keyboard check can now reach. They have a visible white ring. The check cropped its screenshots with the position recorded during the tab sweep, after the page had scrolled, and the last button sat under the fixed cookie banner. It now scrolls each element to the middle of the viewport and measures it fresh: `/insights` goes from 31 findings to 0 on the live page.
- **Real issue found:** links inside collapsed FAQ answers on `/platform/affiliate-program` (`.faq-answer-wrapper`, height 0, overflow hidden) stay in the tab order, so keyboard focus lands on invisible links. Reported as 2.4.7 "no visible focus indicator"; the message could say why.
- **Repeated LLM findings:** cross-page dedup now covers 1.3.1, 2.4.6 and 4.1.2 as well as 1.1.1 and 2.4.4 (exact element HTML only). On this scan that would take 1.3.1 from 41 to 30 and 4.1.2 from 17 to 5.
