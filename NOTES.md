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

Post-merge scans 2026-10-14 (observed): `cd0f789b` and `3193607f` (the 50 pinned pages of 8e03985c, back to back) and `667305ae` (75 pages, `--include-noindex`). No render alert, `bypass` and `missing_skip_navigation` 0 on the pinned pages, no logo-link `image_link_no_alt`, no Top fixes row from page-level summaries, 0 differing 1.4.3 findings between the pinned scans (definitive 1/1, undetermined 527/527). The review's fix-1 contrast acceptance is blocked by P2-030 (axe incomplete results stored as definitive), not by these fixes.

Checkpoint 0 changed the plan (observed): scan 8e03985c captured the unclosed-style break on all 50 pages, so review fixes 1 (animation settle) and 4 (names read before scripts) targeted the wrong causes; see the Corrections in the review's resolution log. With Paul's approval they were replaced by P2-011 (render health) and P2-012 (raw-text elements). Fixes 2 and 3 are P2-013 and P2-014.

### Fix 1: pages that render broken or blank (P2-011)

- Observed: all 50 snapshots of 8e03985c contain the broken `/style>`. 47 full-page screenshots are a blank 800 px viewport; `/` and `/for-agencies` lost the header and their top sections; `/start/new` lost only a `<style>` tag and rendered normally. Every check ran on what rendered, and the DOM-text checks also read the swallowed markup.
- Cause (observed): an unclosed `<style>` in head custom code turns the following markup into CSS text. The review inferred animations; the 37 definitive contrast failures were accurate measurements of the broken render, and none recurs on the healthy render 27 minutes later (0705da2d) or live.
- Change: `src/core/render-health.ts` (new: `assessRenderHealth`, `classifyRenderHealth`, `measureServedHtml`, `isUniformImage`). `crawler.ts` `visit()` measures each page on its own load: markup inside `<style>` text, rendered vs served section/landmark count, visible text, a flat screenshot. In `scanner.ts` a failed page is persisted but not checked: `CoverageRecorder.renderFailure` records every check that would have run as `failed` (`render_failed: …`), `blockPassesOnRenderFailure` turns `passed` and `not_applicable` criteria into `not_tested`, and an ALERT is printed after the crawl and at completion. `coverage.json` lists `render_failed` pages; findings.md and the HTML report open the coverage section with the ALERT.
- Validation on stored data (offline, network blocked; observed): 8e03985c 49 of 50 pages fail (`/start/new` passes); 0705da2d 0 of 50.

| Run (tuning-v4, 47 pages) | Pre-fix `5b7a06` | Post-fix `225cfc` | Live |
|---|---|---|---|
| Pages render_failed | — | 0 | 0 in cd0f789b, 3193607f, 667305ae |
| Findings (predictions, repeat 1) | 867 | 867 | 997 / 992 (pinned 50 pages), 1,306 (75 pages): stored rows, different pages and engine path from the eval predictions |
| Coverage ran / skipped | 926 / 270 | 926 / 270 | 1,068 / 231, 1 partial (cd0f789b and 3193607f); 667305ae 1,593 / 356, 1 partial |
| Gate `compare-20261015T024600Z-492054` | | exit 0: 0 added, 0 removed, 0 criterion or coverage changes; static unchanged | |

- Tests: `test/unit/render-health.test.ts` (17) with fixtures `render-broken-blank`, `render-broken-partial`, `render-near-normal`, `render-healthy` (hand-built on the 8e03985c structure; provenance in `test/fixtures/metadata.json`). Suite 1,427 → 1,444.
- Assumptions: a failed page produces no findings (its checks are skipped) rather than quarantined findings; "counted separately" is the alert's page count (assumed reading of the request). No tuning page renders broken, so the frozen delta is zero by design; the effect is shown on the 8e03985c snapshots.

### Fix 2: markup inside style, script, noscript and template (P2-012)

- Observed: 8e03985c reports `image_link_no_alt` on the header logo link on 49 pages (2 rows), although the header sat inside the unclosed `<style>` and never rendered. Checks that read `snapshot.full_dom` with regular expressions treat raw-text element contents as elements.
- Cause (observed): regex extraction does not respect raw-text elements. The review inferred that names were read before webflow.js ran; disproved: webflow.js sets `aria-label="home"` 5–12 ms after DOMContentLoaded (live, 2026-10-14) and the label is in all 50 healthy snapshots of 0705da2d.
- Real-world effect before the fix, by element location in the stored snapshots (observed): 8e03985c has 240 phantom finding occurrences (elements only inside raw-text elements), among them `image_link_no_alt` 49, `semantic` 49, `animated_content_no_pause` 47, `style_not_structure` 40, `generic_link_text` 23, `missing_autocomplete` 11; the healthy scan 0705da2d has 0 (its 161 `missing_autocomplete` occurrences are rendered inputs). The one `image_link_no_alt` left in 0705da2d is the footer Instagram link on `/case-studies`, the only page whose copy has no `aria-label` (inferred true positive). On 0705da2d the helper removes 100 alt-text candidates (LinkedIn and Facebook tracking pixels inside `<noscript>`) and changes the surrounding context of 1,608 images (CSS and script text no longer included).
- Change: `src/core/markup.ts` (new, `withoutRawTextContent`) used by alt-text, link-text, headings, landmark-labels, widget-aria, table-structure, duplicate-links, consistent-nav, form discovery, multiple-ways, the GIF/video/carousel/pause-control/inline-animation parts of pause-stop-hide and three-flashes, and the scanner's media check. CSS animation rules, `prefers-reduced-motion` and motion listeners are still read from style and script text by design. Platform detection and the error-message prompt (P2-001) are unchanged.

| Run (tuning-v4, 47 pages) | Pre-fix `5b7a06` | Post-fix `477ab3` | Live |
|---|---|---|---|
| Findings (predictions) | 867 | 867 | 997 / 992 / 1,306; 0 logo-link `image_link_no_alt` in all three |
| Model requests changed | — | 3 (re-record `646e00`, $0.01); static 1 ($0.013) | |
| Gate `compare-20261015T031239Z-44c3ba` | | exit 0: 0 added, 0 removed, 0 criterion or coverage changes; static unchanged | |

- Tests: `test/unit/markup.test.ts` (12): the helper, and each converted check on swallowed vs rendered markup, including a nameless logo link that is still evaluated. Suite 1,444 → 1,456.
- Assumptions: HTML comments are not stripped (not requested; not checked for phantoms); nested `<template>` is cut at the first closing tag.

### Fix 3: skip-link targets not named like "main" (P2-013)

- Observed: scan ee56b381 reports `broken_skip_navigation` on `/start/new` and `/overland` with `focus_moved: true`, `target_is_main_content: false`; the target is `section#win` (`tabindex="-1"`), the first section after `.header-wrapper`, and focus moves there live (review).
- Cause (observed): `isMainContent` accepted only `main`, `role="main"`, ids main/content/main-content/maincontent/primary or class main-content. The review's cause is confirmed.
- Change: `src/checks/behavioral/skip-nav.ts`, the target evaluation in `activateAndVerifySkipLink`: a target also counts when it is not inside header, nav or footer, comes after every header and nav focus stop in DOM order, and is at or before the first `h1` or first content section. Name matches still pass on their own; the focus checks and the late-focus wait (7494e90) are unchanged. The rule used is recorded as `targetRule` in the raw result.
- Corpus: the `#win` pages are not exercised on tuning-v4 (`/start/new` is excluded for P2-021; `/overland` is noindex and not scanned), so acceptance rests on the fixtures and the stored ee56b381 snapshots. Offline (scripts stripped, network blocked) both ee56b381 pages go from `broken_skip_navigation` (`focus_moved=true main=false`) to pass (observed).

| Run (tuning-v4, 47 pages) | Pre-fix `5b7a06` | Post-fix `1eb75b` | Live |
|---|---|---|---|
| `broken_skip_navigation` | 1 (/post/5-fall-reel-trend-you-need-to-try-right-now, focus not moved, P2-015) | 1 (same, unchanged) | 1 row per pinned scan, 1 row on 5 `/post/*` pages in 667305ae, all the P2-015 pattern; none on `/start/new` (now `#main-content`); `/overland` not reached, so the `#win` rule is not exercised live |
| Findings (predictions) | 867 | 867 | 997 / 992 / 1,306 |
| Gate `compare-20261015T032556Z-dec27e` | | exit 0: 1 `focus_order_mismatch` swapped (the known focus-order flake); 0 criterion or case changes; static unchanged | |

- Tests: `test/unit/skip-nav.test.ts` +7 with fixture `skip-link-targets.html` (shape of `/overland`): `#win` passes by position, `#main-content` by name; a target inside the header, in the footer, missing, without `tabindex` (focus does not move) or wrapping the header fails. Suite 1,456 → 1,463.
- Assumptions: header and nav stops are focusables inside `header`, `nav`, `[role=banner]` or `[role=navigation]`; content sections are `main`, `section` and `article` outside header, nav and footer.

### Fix 4: page-level findings clustered as one Top fix (P2-014)

- Observed: Top fixes row 5 "html: focus order mismatch" (cluster `79dc811ae6ad`, 0.1–0.2 h) spans 17 pages in ee56b381 and 20 in 6d4e82fe and 0705da2d: every page's own focus-order summary is reported on `<html>` and shares one signature.
- Cause (observed): the cluster signature has no page component for page-level summary findings. The review's cause is confirmed.
- Change: `src/report/clustering.ts`: `isPageLevelSummary` (selector `html` or a `<…-summary>` node, unless the failure type is on the explicit `SITE_LEVEL_FAILURE_TYPES` allowlist: `insufficient_navigation_methods`, `missing_skip_navigation`, `bypass`, `html-has-lang`, `html-lang-valid`, `html-xml-lang-mismatch`); such findings cluster per page (signature plus the stored page URL) and carry `page_level`. `src/report/top-fixes-report.ts`: `topFixClusters` leaves them out of Top fixes; new "Per-page fixes" section (`renderPageLevelMarkdown`, `renderPageLevelHtml`) with each page's estimate, in findings.md and the HTML report. `finding_type_hash` (P2-003) is unchanged.
- Detection is unchanged: this is the report layer only, so it was gated by unit tests and by regenerating Top fixes from stored data instead of a replay (approved).

| Stored scan | Top fixes before | Top fixes after | Per-page fixes after | Headline estimate | Live |
|---|---|---|---|---|---|
| 0705da2d | 9 estimated rows, 4.7–9.4 h, incl. `html: focus order mismatch` | 9 rows, 5.1–10.2 h, no html row | 24 pages (23 focus order, 1 truncated tab sweep), 2.8–6.1 h | 27–46 h (unchanged) | cd0f789b (same pages, healthy): no html summary row; 24 per-page fixes |
| 8e03985c | 9 rows, 3.95–7.9 h (no html row: 2 pages) | unchanged | 2 pages, 0.2–0.4 h | 16–29 h (unchanged) | — |

- The headline estimate does not move because the effort model already counted focus order per page (`KIND_BY_FAILURE_TYPE`); only Top fixes understated it.
- Tests: `test/unit/page-level-clusters.test.ts` (4). Suite 1,463 → 1,467.
- Assumptions: a deduplicated summary row keeps its "also found on" pages in its own per-page row (identical summaries on one template are one change).

## Scanner fixes (2026-10-15)

P2-030 (axe incomplete results stored as failures) with P2-019 (needs-review findings fail their criterion). Branch `fix/p2-030` from main 8eaf7c5. Reference: `replay-20261015T032725Z-bd7aa1` (tuning-v4, 3 repeats, at 56f7550; detection unchanged since). Fix run: `replay-20261015T230944Z-7f0f3b` at 951a4a0. Gate: `compare-20261015T232120Z-572b81`, exit 0. Live: scan `782f7078` (pinned 50 pages, 2026-10-15). Static: `static-20261015T032729Z-e52b7a` → `static-20261015T230948Z-ce7e49`. Tests before: 1,470.

### Fix: axe incomplete results become needs-review findings; needs-review criterion status (P2-030, P2-019)

- Observed: in scan cd0f789b all 528 color-contrast findings were axe incomplete results (axe could not decide) stored definitive, major, triage fix_now; 527 say "background color could not be determined", 1 is a 1:1 ratio on `/local`. `video-caption` (1.2.2, critical) and `form-field-multiple-labels` (3.3.2, minor) were stored the same way. 1.4.3 was recorded failed with no axe violation behind it. A `truncated_tab_sweep` (needs review) failed 2.1.1 the same way (P2-019).
- Cause (observed): `nodeToCheckResult` built incomplete CheckResults identical to violations; the scanner's `axe_incomplete` label only fed `finding_type_hash`; `confidence.ts` `isIncompleteResult` looked for a marker that was never set, so every incomplete result was scored definitive. Criterion reconciliation failed a criterion on any finding, including needs-review findings.
- Change:
  - `src/checks/automated/index.ts`: `nodeToCheckResult(…, { incomplete: true })` sets `measured_values.axe_incomplete` for incomplete nodes (violations unchanged). `analyzer.ts` says axe could not decide and keeps axe's message. `confidence.ts` then takes its existing path: tier needs_review, score 0.5, `requires_human`; triage `verify_manually`; severity keeps axe's impact.
  - Criterion status: new `needs_review` status (`types.ts`). `criterionStatusFromFindings` (scanner.ts) is used by both reconcilers: failed when at least one finding is confirmed (tier above needs_review), needs_review when every finding needs review. A criterion with needs-review findings is never passed. `reconcileInMemory` (client report) never turns a stored needs_review into a pass; its separate failed → passed flip when every finding is filtered as possibly noisy is unchanged and registered as P2-033 (false pass, related to P2-010), so needs_review is protected from it but failed is not.
  - Counts: `ScanSummary.by_severity` counts confirmed findings only; `needs_review_findings`, `needs_review_by_severity` and `wcag_criteria_needs_review` are new (scan_summaries columns migrated). Shown in the CLI table, the report cover, the scorecard and executive summary (both counted from criterion results over the same criterion list, so the statuses add up) and findings.md.
  - Report: undetermined-background contrast findings are grouped into one "Needs manual contrast check" entry per page and reason (image node, gradient, overlap, background image, partial overlap) with the element list behind it (`groupManualContrastChecks`). They stay out of Top fixes and add no fix hours. findings.md and findings.jsonl keep every finding with its new tier and bucket.

| Tuning-v4 (47 pages) | Reference `bd7aa1` (repeat 1) | Fix `7f0f3b` | Live |
|---|---|---|---|
| Predictions (findings) | 867 | 867 (none removed) | 1,025 (782f7078; cd0f789b 997): +30 `unreachable_interactive_element` on one page from a keyboard sweep stuck in an Instagram embed (P2-034, unrelated); without them 995; no contrast finding removed (528 = 528) |
| Confirmed, by severity | 867: critical 34, major 543, minor 44, advisory 246 | 374: critical 33, major 51, minor 44, advisory 246 | 494: critical 83, major 93, minor 57, advisory 261 |
| Needs review | 0 | 493: 492 color-contrast (major), 1 video-caption (critical) | 531: 528 color-contrast (major), video-caption (critical), truncated_tab_sweep (critical), form-field-multiple-labels (minor) |
| Criteria | 15 failed, 7 passed, 6 N/A, 16 not tested | 13 failed, 2 needs_review, 7 passed, 6 N/A, 16 not tested | 17 failed, 3 needs_review (1.2.2, 1.4.3, 3.3.2), 6 passed, 5 N/A, 13 not tested |
| 1.4.3 | failed | needs_review | needs_review (528 need a manual check; none confirmed) |
| Fix-1 elements (`.c-green-h`, `.c-subtitle`, `.c-p-gray` on / and /for-agencies) | 8 rows definitive/major | 8 rows needs_review/major | 8 rows needs_review/major |

- Gate transitions (expected from this fix): 1.4.3 failed → needs_review; 1.2.2 failed → needs_review; 493 predictions definitive → needs_review. No finding added or removed, no case change, no new pass, no coverage change; the 11 existing blockers are unchanged; static set unchanged (30 pass, 7 fail).
- The 37 provisional no_violation contrast cases on the fix-1 elements were TN before and after: their selectors come from the broken 8e03985c render and match no tuning-v4 prediction (observed), so they do not exercise this fix; the same elements are shown directly in the table.
- Tests: `test/unit/needs-review.test.ts` (12, including a scan of a page with text over a background image: needs-review contrast, 1.4.3 needs_review, 1.1.1 still failed) and one report-arithmetic test in `html-template.test.ts`. Suite 1,470 → 1,483.
- Assumptions:
  - Lakewood delivered-report scan 1a6e3c3e (2026-05-20, `wcag-data/wcag-old.db`): 31 findings (12 Claude, 19 Playwright) and no axe findings at all, so no incomplete result was stored as a failure; 1.4.3 passed ("Passed 1 axe-core rule(s): color-contrast (122 elements tested)") (observed). The delivered report is not affected by P2-030.
  - The manual-review line of the effort estimate still counts undetermined contrast elements (2–4 minutes each, capped); they add no fix hours (assumed to be the intended "out of effort estimates").
  - Older scans stored before this fix show needs_review_findings 0 until they are reprocessed (assumed acceptable; their stored tiers are unchanged).

## Out of scope

- Resolving axe incomplete contrast results by sampling screenshot pixels (P2-030 follow-up).
- Popfly review items 5–8 and P2-015 (registered as P2-016..P2-019 and P2-015; see KNOWN_ISSUES.md), and the residual per-load variation sources P2-020..P2-023 beyond the eval-harness side.
- The animation-settle pass proposed for review fix 1: not reproduced (0 definitive contrast failures live before and after settling), so not built.
- Stripping HTML comments in `withoutRawTextContent` (not requested; comments were not checked for phantoms).
- Re-recording the baseline engine on tuning-v4 (stale cache; D6 deferred).
- Grouping class-level style fixes (focus indicators, colours set on a class) by class instead of per element. It would merge the per-link footer focus clusters into one Top fix, but needs a different signature from the one specified.
- Recognising GrowSurf by `data-grsf-*` attributes or `growsurf-prod` image URLs, which would move the three GrowSurf images (Top fixes 5 to 7) to Third-party.
- The report's "Findings by Type" cards merge different axe rules that share a `finding_type_hash` (for example `aria-prohibited-attr` inside the "aria allowed attr" card), and a card shows one remediation for the whole group. Top fixes keeps them apart. Fixing the card grouping changes report structure beyond these phases.
- Leaving hedged Claude verdicts (`needs_review` with no failure type, shown as `semantic`) out of "newly broken", and making Claude's failure-type names stable across runs. Both change signatures between scans without the site changing.
- A `truncated_tab_sweep` finding still marks 2.1.1 as failed in the criterion results, because any finding fails its criterion during reconciliation. A needs-review note arguably should not. Changing criterion reconciliation is outside these fixes.
- Finding what steals focus in full scans: needs a full scan that truncates (see the Fix 2 table).
- Enabling `typescript-eslint` recommended rules. They would flag existing code across the repo (unused vars, `any`), and fixing that is a refactor outside these phases.
