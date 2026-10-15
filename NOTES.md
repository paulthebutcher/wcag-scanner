# Notes: coverage, Top fixes, fix verification

Working notes for the three-phase change (per-check coverage, component-grouped "Top fixes", `wcag verify`).

## Assumptions

- `npm run lint` failed before this work: the repo had no ESLint config (ESLint 9 needs `eslint.config.js`). Added a minimal flat config that parses `src/**/*.ts` with `typescript-eslint`'s parser (new dev dependency) and enables four rules that cannot misfire on TypeScript. It does not enable the recommended rule sets; see Out of scope.
- The focus-visibility rewrite from the previous session was uncommitted at the start; it was committed on its own (`fix: focus check uses real Tab presses ...`) before Phase 1 so it does not mix with phase commits.

### Phase 1: coverage

- Coverage is persisted as `<dataDir>/<scanId>/coverage.json`, next to `timings.json` and the findings dump. The SQLite tables hold the CLAUDE.md data-model entities; coverage is per-run diagnostics in the same category as timings, so it follows the JSON-file pattern.
- "Pages crawled" (the denominator) means pages the crawl captured. URLs the crawl could not load are listed separately as `crawl_failures` and shown as a warning; no check ran on them.
- When a check reports several times for one page (one per form), the page's status is the most significant: failed, then ran, then skipped. A check that ran and found nothing to test (a page with no images) counts as ran.
- Check ids are the scanner's existing checks: `axe-core`; `keyboard`, `focus-visible`, `focus-order`, `keyboard-trap`, `skip-nav`, `modal`; `alt-text`, `link-text`, `headings`, `landmark-labels`, `widget-aria`, `table-structure`, `duplicate-links`, `consistent-nav`; `form-discovery`, `high-risk-forms`, `form-submission`, `error-messages`, `input-purpose`, `on-input`, `error-quality`; `pause-stop-hide`, `three-flashes`, `multiple-ways`, `motion-actuation`. Site-level checks (`consistent-nav`, `error-quality`) record the same outcome for every page. Media criteria (1.2.x) are a DOM scan, not a check, and are not recorded.
- If a behavioral page fails to load, all six behavioral checks are recorded as failed for it ("page load failed: ..."). If the keyboard check fails, focus visible and focus order are recorded as skipped (they need its tab sequence).
- The full URL list (`measured_values.also_found_on_urls`) is persisted wherever findings are folded across pages: the behavioral dedup (as asked), and also the semantic dedup and shared-form annotation, which use the same `also_found_on_pages` field. Phase 2 needs every folded page for cluster page counts. The URL list is left out of the generated reasoning text.
- "Unique elements · page occurrences" is shown on a report card when any finding in it was folded from other pages, and findings.md has a "Deduplicated findings" table. Page occurrences = 1 + `also_found_on_pages`.
- The reference scan `e779c8b0` predates coverage recording and URL lists: its Coverage section says "not recorded", and its folded findings have counts but not URLs, so card page counts only include pages that are known. Validated by regenerating its HTML report and findings dump.

### Phase 2: Top fixes

- Signature (`elementSignature` in `src/report/clustering.ts`): WCAG criterion | failure type | selector with `:nth-child`/`:nth-of-type`/`:nth-last-*` removed | the element's own class list, sorted | `data-w-id` | SHA-1 of `element_html` with `src`, `href`, `srcset` and `style` values removed. The criterion is included as well as the failure type because some failure types are shared across criteria (`semantic` appears under 1.1.1 and 4.1.2) and would otherwise merge unrelated problems.
- Exception: measured axe colour-contrast results are keyed by foreground colour (`1.4.3|color-contrast|fg:#286140`). The sanity target is one #286140 cluster of about 174 occurrences, but those occurrences span four components (footer terms links, the cookie-banner "here" link, legal-page links), so an element signature cannot produce it. One colour change fixes all of them, which is what a Top fix is.
- The HTML hash keeps text content, as specified, so links that share a class but differ in text (footer links) are separate clusters. The footer focus clusters rank 12th and 13th on the reference scan (24 occurrences and 11 pages each), just outside the top 10. Grouping class-level style fixes by class would merge them; see Out of scope.
- A cluster's pages are every page of every finding in it, using Phase 1's `also_found_on_urls`. Occurrences = sum of page occurrences. The reference scan predates the URL lists, so its folded findings contribute their count but not their URLs; such clusters are marked `*` and the page count is the larger of known URLs and the largest single finding's occurrences.
- Ranking: occurrences cleared per fix (each cluster is one fix), then pages, then severity, then cluster id, so the order is deterministic.
- Exclusions apply where the client report already filters noisy findings (`queryFindings`), so the HTML, PDF and comparison reports all get them. Failure counts (total instances and severity counts) are recomputed without them. Criterion pass/fail status is reconciled before exclusion, so excluding a third-party finding never turns a failed criterion into a pass. findings.md lists excluded findings in their own sections instead of the buckets; findings.jsonl keeps every finding and marks excluded ones.
- Needs manual check = axe colour-contrast findings whose message says the background colour could not be determined (image node, gradient, background image, overlap, partial overlap). Third-party = the element's own id/class, or a class/id in its selector, starting `grsf-`. The three GrowSurf landing-page images (ranks 5 to 7) carry only `data-grsf-lazy-applied`, so under this narrow rule they stay counted; see Out of scope.
- Finding-specific remediation (`buildSpecificRemediation` in `src/adapters/webflow.ts`) covers only `color-contrast`, `custom_interactive_no_role`, `no_visible_focus_indicator` and `aria-prohibited-attr`. It is used for new scans, and at report time for older scans through the existing Webflow remediation backfill. Other types are unchanged. The contrast replacement keeps hue and saturation and moves lightness away from the background in 0.5% steps until it reaches the ratio axe expects (4.5:1, or 3:1 for large text) against every background the colour was measured on.
- On the reference scan, exclusions take 629 findings out of the client counts: 480 occurrences need a manual check and 337 are GrowSurf. The cover goes from 1,301 instances to 673 (major 976 to 495).

#### Top fixes, reference scan `e779c8b0`

| # | Fix | WCAG | Severity | Occurrences | Pages | Example element | Cluster |
|---|---|---|---|---|---|---|---|
| 1 | Text colour #286140 contrast | 1.4.3 | major | 174 | 50 | `.tos-footer-link:nth-child(2)` | `8337cc8d1cc1` |
| 2 | html: missing skip navigation | 2.4.1 | major | 50 | 50* | `html` | `5f71945e52ce` |
| 3 | div.btn.full.modal: custom interactive no role | 4.1.2 | major | 49 | 49 | `div#ff1fba9b-c373-5725-91ea-e26e90dbbe5c` | `a3a4bb7a9bee` |
| 4 | a[href="https://app.retention.com/optout"]: generic link text | 2.4.4 | major | 48 | 48* | `a[href="https://app.retention.com/optout"]` | `233407bcb2ea` |
| 5 | img[src="https://res.cloudinary.com/growsurf-prod/image/upload/v1763678713/landing_pages/"]: alt not descriptive | 1.1.1 | major | 48 | 48* | `img[src="https://res.cloudinary.com/growsurf-prod/image/upload/v1763678713/landing_pages/"]` | `5ccb69d94be0` |
| 6 | img[src="https://res.cloudinary.com/growsurf-prod/image/upload/v1763678796/landing_pages/"]: alt not descriptive | 1.1.1 | major | 48 | 48* | `img[src="https://res.cloudinary.com/growsurf-prod/image/upload/v1763678796/landing_pages/"]` | `64710eed859a` |
| 7 | img[src="https://res.cloudinary.com/growsurf-prod/image/upload/v1763678699/landing_pages/"]: alt not descriptive | 1.1.1 | major | 48 | 48* | `img[src="https://res.cloudinary.com/growsurf-prod/image/upload/v1763678699/landing_pages/"]` | `b25c492ceb09` |
| 8 | div.main-menu-back: custom interactive no role | 4.1.2 | major | 46 | 46 | `div#5b5eb103-a4a7-5f26-357b-8fb9a07c0e1c` | `a76a98790bc3` |
| 9 | img.full-img.new-cta-test: empty alt on informative | 1.1.1 | minor | 46 | 46* | `img.full-img.new-cta-test` | `464056496781` |
| 10 | a.btn.secondary: generic link text | 2.4.4 | major | 26 | 24* | `a.btn.secondary.w-button` | `80178b033aa7` |

Cluster 1 remediation: "Text colour #286140 on #17191e and #1e252b measures 2.12:1; normal text needs 4.5:1. Change the text colour to #409b66 (same hue, lighter), which measures 4.50:1 on every background above."

### Phase 3: fix verification

- `wcag verify` selects clusters by `--cluster` (full id or a unique prefix, repeatable or comma-separated), `--all`, or by default the baseline's Top fixes (top 10), using the same client view as the report (noisy findings filtered, exclusions removed).
- Checks per cluster come from `src/core/check-registry.ts` (axe findings → `axe-core`; others by failure type, then by criterion for Claude API findings), plus prerequisites: focus visible and focus order need `keyboard`; form checks need `form-discovery`.
- Smallest scanner change: `ScanOptions.urls` (the crawler gets `urlList`: those URLs only, with no robots.txt/sitemap, link following or CMS sampling), `ScanOptions.checks` (each check's execution is gated; coverage keeps only the selected checks) and `ScanOptions.baselineScanId`. Tiers come from the selected checks.
- `baseline_scan_id` is a new `scan_sessions` column, added through the existing add-column-if-missing migration in `openDatabase`; the rescan's `scan_type` is `rescan`. `comparison_scan_id` stays null: setting it makes the report diff the partial rescan against the whole baseline, so every issue on unscanned pages and checks would show as resolved.
- Diff is by `elementSignature` (Phase 2), per cluster and per page, using Phase 1 coverage. A page counts as verified only if every check the cluster needs has status `ran` on it; otherwise it is "not verified" with the reason, and a cluster with any not-verified page and no still-broken page is "not verified", never "fixed". Newly broken = rescan signature on a rescanned page where the baseline did not have it; signatures whose baseline pages are known only by count are not reported as new.
- Output: `verify.md` and `verify.json` in the rescan's folder, and `report.html` (the rescan's HTML report with a "Fix verification" section; `wcag report <rescan-id>` also picks up `verify.json`). The client summary uses plain descriptions per failure type and never prints cluster or scan ids; the per-cluster table below it does.

#### Live verify results (2026-10-11)

`wcag verify --baseline e779c8b0-03f2-44fd-87cc-b960bc230785 --cluster 8337cc8d1cc1 --cluster a3a4bb7a9bee`. Rescan `69271047-f1b0-4813-9cdb-32ff79817d0c`: 50 pages, checks `axe-core` and `widget-aria`, 1m 15s, 8 Claude calls.

| Cluster | Issue | Status | Pages fixed / still broken / not verified | Occurrences before → after |
|---|---|---|---|---|
| `8337cc8d1cc1` | Text colour #286140 contrast | fixed | 50 / 0 / 0 | 174 → 0 |
| `a3a4bb7a9bee` | div.btn.full.modal: custom interactive no role | fixed | 49 / 0 / 0 | 49 → 0 |

- The contrast cluster is fixed on every page, as expected after the link colour change.
- `div.btn.modal` is fixed too: the element now has `role="button"` and `tabindex="0"`. On that same element the widget-ARIA check now returns a hedged Claude verdict (`needs_review`, failure type `semantic`: it cannot tell from the DOM snippet whether the button has an accessible name). That is reported as newly broken on 49 pages.
- 12 newly broken items in total. Apart from the one above: 8 are inside YouTube and Instagram embeds (axe results reported against the `iframe` selector, whose content changes between loads); 2 Instagram embeds are missing a frame title (a newly embedded reel); 1 is a different Claude-chosen failure type for the same dropdown (`missing_button_role_and_keyboard_focusability` instead of `custom_interactive_no_role`); 1 is an Instagram footer link in text colour #347653 on one page.
- No page was "not verified": both checks ran on all 50 pages.

### Coverage tables

Reference scan `e779c8b0`: coverage was not recorded (the scan predates Phase 1), so the report section says "not recorded". The only scans with coverage are the live verify rescan and the test fixtures. Rescan `69271047` (a check-subset scan):

| Check | Tier | Ran | Failed | Skipped | Not recorded |
|---|---|---|---|---|---|
| axe-core rules | 1 | 50/50 | 0 | 0 | 0 |
| Widget ARIA (4.1.2) | 3 | 50/50 | 0 | 0 | 0 |

### Effort estimate from fix units (2026-10-11)

The old estimates were wrong in opposite directions. The scan summary and CLI table added 0.25–4 h per finding instance (the reference scan stored ~2,949 h). The report counted one fix per failure type (~37 h), whatever the number of components.

Now `src/report/effort.ts` groups findings into fix units, one change each in Webflow, and costs those:

| Kind | One unit is | Hours per unit |
|---|---|---|
| site | one site-wide addition (skip link; Enter/Space snippet for div buttons, added once) | 0.5–1 (snippet 1) |
| class-style | one class's style, or one text colour | 0.15–0.3 |
| component | one component's settings (tag + Designer classes) | 0.25–0.5 |
| content | one unique piece of copy or alt text | 0.05–0.1 |
| page | one page (focus order) | 0.1–0.2 |
| structural | one component reworked (a form's error handling, captions, animation controls) | 0.5–1 (captions 0.5–2) |

Line items: fixes; QA and re-test (20% + 1 h for a verify run); manual review (3–6 min per component with unmeasurable contrast, 5–15 min per advisory item, capped at 5 h); client coordination (10% + 3 min per copy change, capped at 4 h). Advisory fixes are an add-on outside the headline. Third-party findings cost nothing.

The 40–60 h engagements this is calibrated against also include non-accessibility work, so the accessibility part should usually land below that. Results:

| Scan | Estimate | Fixes | QA | Review | Coordination | Advisory add-on |
|---|---|---|---|---|---|---|
| `e779c8b0` (reference) | ~27–47 h | 102 changes, 15–31 h | 4–7.2 h | 4.5–5 h | 3.6–4 h | 9–18.5 h |
| `7033a623` (old code) | ~28–50 h | 89 changes, 16.3–33.5 h | 4.3–7.7 h | 5 h | 2.4–4 h | 9.9–20.2 h |
| `ba241ce6` (new code, before the keyboard fix) | ~42–88 h | 135 changes | | | | |

`ba241ce6` is inflated by 146 false "unreachable" keyboard findings (29 phantom component units), fixed in `06cf882`.

Also: axe results inside embedded frames (the `iframe` selector with the frame's own markup: YouTube, Instagram) are now excluded as third-party. This was on the out-of-scope list; it matters here because those findings were adding component units the site cannot fix. On the reference scan it moves the third-party count to 171.

Retuning: all hours are in `EFFORT_MODEL`. findings.md lists every unit with its hours under "Effort estimate", so the list can be compared with a timesheet.

## Scanner bug fixes (2026-10-12)

Reference scans: `0b7d5e28` (latest) and `4d008e9e`. Tests before these fixes: 1,288.

### Fix 1: skip links that move focus late

- After Enter on a `#fragment` skip link, the check now polls (every 50 ms, up to 1,500 ms) for focus on or inside the target, instead of reading focus after a fixed 100 ms. The failure path is unchanged when the wait times out. Non-fragment skip links keep the 100 ms wait (narrowest reading: the reported problem is webflow.js handling of same-page anchors).
- Fixture `test/fixtures/skip-link-delayed-focus.html`: focus after 600 ms passes (it fails on the old code); `data-focus="never"` still reports `broken_skip_navigation`.
- Before, scan `0b7d5e28`: 3 `broken_skip_navigation` findings, 50 page occurrences (48 for `#main-content`, plus 2 pages whose skip link points at `#win`). Scan `4d008e9e` had none.
- After, live rescan of `/brands` and `/creators` with the `skip-nav` check only: 0 `broken_skip_navigation`, 2.4.1 passed, the check ran on both pages. The `#win` pages were not in the allowed URL list and were not rescanned.

### Fix 2: truncated tab sweeps

- `recordTabSequence` now returns `exitReason` (`cycle` | `max` | `body_focus` | `repeat_cap`), `lastFocusedSelector` (the last element with focus before the sweep stopped) and `candidateCount` (keyboard-reachable controls on the page). All of them, plus `retried` and, after a retry, the first sweep's exit reason, stops and last focused element, are in the keyboard findings' `measured_values`. `MAX_CONSECUTIVE_BODY` and the cycle logic are unchanged.
- A sweep that ends by `body_focus` or `repeat_cap` with fewer than 50% of candidate controls reached is reloaded and swept once more. If it is still truncated, no `unreachable_interactive_element` findings are emitted for the page. Instead there is one `truncated_tab_sweep` finding (2.1.1), and the keyboard check is recorded as `partial` in coverage.json with the reason.
- Coverage gains a `partial` status (ranked between failed and ran). The Coverage section shows a Partial column, the grouped reasons, and a warning.
- Every keyboard coverage entry now carries a one-line sweep summary (exit reason, stops, last focused, retried), so intermittent truncation can be diagnosed from coverage.json without findings.
- To make the truncated-sweep finding a needs-review item rather than a failure, files outside the brief's list changed by one line or case each:
  - `confidence.ts`: `truncated_tab_sweep` → needs_review, 0.4.
  - `evidence.ts`: advisory severity.
  - `analyzer.ts`: readable reasoning.
  - `check-registry.ts`: maps it to the `keyboard` check.
  - `verify.ts`: a `partial` page counts as not verified.
- Fixture `test/fixtures/tab-sweep-focus-steal.html`: after the fourth link, the next three focus events are blurred, so three Tab presses land on `<body>`. The result is partial with zero unreachable findings, and `data-steal="once"` shows a successful retry.
- Before: scan `0b7d5e28` had 39 `unreachable_interactive_element` findings (all `/platform/storefronts`, sweep 8 stops / 12 presses). Scan `4d008e9e` had 40 (`/platform/user-generated-content-ugc` 33, `/platform/affiliate-program` 7; 6 stops / 10 presses each).

#### Live keyboard-only rescans (2026-10-12, 3 runs)

| Run | Page | Exit reason | Stops reached | Retry used | Unreachable | Last focused before stop |
|---|---|---|---|---|---|---|
| 1 | /platform/storefronts | cycle | 49 | n | 0 | n/a (full lap) |
| 1 | /platform/user-generated-content-ugc | cycle | 48 | n | 0 | n/a (full lap) |
| 1 | /platform/affiliate-program | cycle | 49 | n | 0 | n/a (full lap) |
| 2 | /platform/storefronts | cycle | 49 | n | 0 | n/a (full lap) |
| 2 | /platform/user-generated-content-ugc | cycle | 48 | n | 0 | n/a (full lap) |
| 2 | /platform/affiliate-program | cycle | 49 | n | 0 | n/a (full lap) |
| 3 | /platform/storefronts | cycle | 49 | n | 0 | n/a (full lap) |
| 3 | /platform/user-generated-content-ugc | cycle | 48 | n | 0 | n/a (full lap) |
| 3 | /platform/affiliate-program | cycle | 49 | n | 0 | n/a (full lap) |

The truncation did not reproduce in 9 keyboard-only sweeps, so the retry path ran only in the fixture tests, and what stole focus on the truncated runs is still unknown: the reference scans predate `lastFocusedSelector`. The truncated runs were full scans (all checks, 4 pages at a time); these were keyboard-only subset scans. The next full scan that truncates will record the element in `first_sweep_last_focused` and in the coverage message.

### Fix 3: AI findings that contradict their own reasoning

- Root cause: for `data-w-id` elements the check sent the model only the opening tag (`<div tabindex="0" role="button" … class="btn modal full">`), so it never saw the visible text "Request a Demo". It then flagged a missing name while saying the element had a valid role and focus.
- Changes in `src/checks/semantic/widget-aria.ts`:
  - Each candidate gets its role, tabindex, accessible name (aria-label, aria-labelledby target text, or visible text of the whole element, found by tag balancing) and whether it opens a modal (`aria-haspopup="dialog"` or a modal/popup/lightbox/dialog class).
  - The name is passed to the model.
  - Deterministic pre-check: with a valid widget role, focusable (tabindex ≥ 0, or a native link/button) and a non-empty name, failure types about name, label, role, focus, tabindex or keyboard are dropped. A pre-check-passing modal opener is not sent to the model at all.
  - `mapWidgetVerdict`: the prompt asks for `fail` | `pass` | `uncertain` (`needs_review` is read as uncertain; `possible_`/`possibly_`/`potentially_` failure types are uncertain). Only `fail` is a failure. `uncertain` is stored with `measured_values.verdict = "uncertain"`, which `confidence.ts` scores needs_review (one added branch). The existing client-report filter (`possibly_noisy`) then keeps it out of Top fixes and failure counts, while it stays in findings.md.
  - `missing_aria_expanded` is dropped for modal openers. The prompt says aria-expanded applies only to controls that show or hide content in place.
- Assumption: the widget prompt is defined in `widget-aria.ts`, not `src/prompts/`. The shared `ELEMENT_EVAL_BASE_SYSTEM` in `src/prompts/element-evaluation.ts` is used by every element prompt and was left unchanged; the widget prompt adds a verdict override.
- Before/after (stored model answers replayed through the new pre-check and mapping, using each page's stored DOM; no live scan for this fix):

| Scan | Finding | Before | After |
|---|---|---|---|
| `0b7d5e28` | missing_aria_expanded on div.btn.modal.full | 1 finding, 49 occurrences | none (modal opener, not sent to the model) |
| `0b7d5e28` | missing_accessible_name on div.btn.modal | 2 findings, 2 occurrences | none |
| `0b7d5e28` | potentially_missing_accessible_name (named, focusable button) | 1 finding, 46 occurrences | none |
| `0b7d5e28` | semantic (hedged) | 1, 1 | uncertain: review only, out of counts |
| `0b7d5e28` | custom_interactive_no_role (model `fail`) | 4, 16 | unchanged |
| `4d008e9e` | missing_accessible_name on div.btn.modal.full | 1, 49 | none |
| `4d008e9e` | potentially_missing_accessible_name | 1, 46 | none |
| `4d008e9e` | custom_interactive_no_role / missing_aria_role_on_custom_interactive_element (`fail`) | 4, 16 | unchanged |

### Fix 4: GrowSurf images not tagged third-party

- `isGrowSurfElement()` in `src/report/clustering.ts` is now the one place GrowSurf is recognised:
  - the element's own `data-grsf-*` attribute;
  - a `grsf-` id or class on the element, or on any ancestor named in its selector path;
  - a `[data-grsf…]` attribute selector;
  - a `src`/`href`/`srcset` (or an attribute selector on one) containing "growsurf".

  `exclusionFor` uses it; the old `THIRD_PARTY_EMBEDS` prefix list is removed.
- Assumption: stored findings keep only the element's own markup and its selector, not ancestor markup, so "any ancestor" is checked through the ids and classes in the selector path. A `data-grsf-*` attribute on an ancestor that is not in the selector is not seen.
- Before/after, regenerating the `0b7d5e28` report from stored data:
  - Before: the 3 GrowSurf landing-page images (`alt="1"`, `"2"`, `"3"`, 144 page occurrences) were Top fixes #4–6; GrowSurf third-party occurrences 338.
  - After: no GrowSurf rows in Top fixes or Findings by Type; the images are in the Third-party section; GrowSurf third-party occurrences 482.

### Fix 5: cluster signature included element text

- `elementSignature` now hashes the whole element, including its text, only for content failure types where the wording is the problem (`signatureKeepsText`):
  - alt-text quality: `alt_not_descriptive`, `empty_alt_on_informative`, `decorative_with_alt`, `missing_alt`, `image-alt`, `filename_as_alt`, `placeholder_alt`, `alt_too_long`, `redundant_alt`, `redundant_with_context`;
  - link text: `generic_link_text`, `duplicate_link_text`, `ambiguous_without_context`, `url_as_link_text`, `non_descriptive_link`, `empty_link`, `image_link_no_alt`, `link-name`;
  - heading text: `non_descriptive`, `heading_too_generic`, `empty_heading`, `heading_too_long`, `style_not_structure`;
  - Claude's generic `semantic` type under 1.1.1, 2.4.4 or 2.4.6.

  For every other failure type the hash covers only the element's own opening tag (volatile attributes removed).
- Assumptions:
  - "Keep text only for content types" is applied literally: the brief's structural list (focus, role, keyboard, contrast, landmarks, skip nav, hidden focus) is covered, and so is any other non-content type.
  - Inline formatting inside an element counts as content too. Removing only text nodes left the FAQ in two clusters, because 4 of its 17 links wrap the text in `<strong>`.
  - Measured colour contrast was already keyed by text colour, so it is unaffected.
- Before/after, reclustering stored data:

| Scan | Measure | Before | After |
|---|---|---|---|
| `4d008e9e` | focus_on_hidden_element (FAQ) clusters | 17 (1 occurrence each) | 1 (17 occurrences) |
| `4d008e9e` | all clusters | 254 | 123 |
| `0b7d5e28` | all clusters | 239 | 130 |
| both | generic_link_text clusters (text kept) | 4 / 3 | 4 / 3 |

Tests after all five fixes: 1,305 (1,288 before).

## Scanner fixes (2026-10-13, Popfly review)

Review: `docs/popfly-scan-review-2026-10-13.md`. Frozen corpus tuning-v4: 47 popfly.com pages from the tuning-v1 capture (`capture-20261014T223021Z-db47cc`), with 4 pages excluded for per-load variation and one supplemented asset. Pre-fix reference: `replay-20261015T013504Z-5b7a06` (3 repeats, valid, non-behavioral identical; focus-order flake 2/46). Static pre-fix reference: `static-20261015T013516Z-072ff9` (30 pass, 7 fail). Tests before these fixes: 1,427.

Checkpoint 0 changed the plan (observed): scan 8e03985c captured the unclosed-style break on all 50 pages, so review fixes 1 (animation settle) and 4 (names read before scripts) targeted the wrong causes; see the Corrections in the review's resolution log. With Paul's approval they were replaced by P2-011 (render health) and P2-012 (raw-text elements). Fixes 2 and 3 are P2-013 and P2-014.

### Fix 1: pages that render broken or blank (P2-011)

- Observed: all 50 snapshots of 8e03985c contain the broken `/style>`. 47 full-page screenshots are a blank 800 px viewport; `/` and `/for-agencies` lost the header and their top sections; `/start/new` lost only a `<style>` tag and rendered normally. Every check ran on what rendered, and the DOM-text checks also read the swallowed markup.
- Cause (observed): an unclosed `<style>` in head custom code turns the following markup into CSS text. The review inferred animations; the 37 definitive contrast failures were accurate measurements of the broken render, and none recurs on the healthy render 27 minutes later (0705da2d) or live.
- Change: `src/core/render-health.ts` (new: `assessRenderHealth`, `classifyRenderHealth`, `measureServedHtml`, `isUniformImage`). `crawler.ts` `visit()` measures each page on its own load: markup inside `<style>` text, rendered vs served section/landmark count, visible text, a flat screenshot. In `scanner.ts` a failed page is persisted but not checked: `CoverageRecorder.renderFailure` records every check that would have run as `failed` (`render_failed: …`), `blockPassesOnRenderFailure` turns `passed` and `not_applicable` criteria into `not_tested`, and an ALERT is printed after the crawl and at completion. `coverage.json` lists `render_failed` pages; findings.md and the HTML report open the coverage section with the ALERT.
- Validation on stored data (offline, network blocked; observed): 8e03985c 49 of 50 pages fail (`/start/new` passes); 0705da2d 0 of 50.

| Run (tuning-v4, 47 pages) | Pre-fix `5b7a06` | Post-fix `225cfc` | Live |
|---|---|---|---|
| Pages render_failed | — | 0 | pending |
| Findings (predictions, repeat 1) | 867 | 867 | pending |
| Coverage ran / skipped | 926 / 270 | 926 / 270 | pending |
| Gate `compare-20261015T024600Z-492054` | | exit 0: 0 added, 0 removed, 0 criterion or coverage changes; static unchanged | |

- Tests: `test/unit/render-health.test.ts` (17) with fixtures `render-broken-blank`, `render-broken-partial`, `render-near-normal`, `render-healthy` (hand-built on the 8e03985c structure; provenance in `test/fixtures/metadata.json`). Suite 1,427 → 1,444.
- Assumptions: a failed page produces no findings (its checks are skipped) rather than quarantined findings; "counted separately" is the alert's page count (assumed reading of the request). No tuning page renders broken, so the frozen delta is zero by design; the effect is shown on the 8e03985c snapshots.

## Out of scope

- Grouping class-level style fixes (focus indicators, colours set on a class) by class instead of per element. It would merge the per-link footer focus clusters into one Top fix, but needs a different signature from the one specified.
- Recognising GrowSurf by `data-grsf-*` attributes or `growsurf-prod` image URLs, which would move the three GrowSurf images (Top fixes 5 to 7) to Third-party.
- The report's "Findings by Type" cards merge different axe rules that share a `finding_type_hash` (for example `aria-prohibited-attr` inside the "aria allowed attr" card), and a card shows one remediation for the whole group. Top fixes keeps them apart. Fixing the card grouping changes report structure beyond these phases.
- Leaving hedged Claude verdicts (`needs_review` with no failure type, shown as `semantic`) out of "newly broken", and making Claude's failure-type names stable across runs. Both change signatures between scans without the site changing.
- A `truncated_tab_sweep` finding still marks 2.1.1 as failed in the criterion results, because any finding fails its criterion during reconciliation. A needs-review note arguably should not. Changing criterion reconciliation is outside these fixes.
- Finding what steals focus in full scans: needs a full scan that truncates (see the Fix 2 table).
- Enabling `typescript-eslint` recommended rules. They would flag existing code across the repo (unused vars, `any`), and fixing that is a refactor outside these phases.
