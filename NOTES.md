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
| Elements with the fix-1 classes (`.c-green-h`, `.c-subtitle`, `.c-p-gray` on / and /for-agencies; not the case elements) | 8 rows definitive/major | 8 rows needs_review/major | 8 rows needs_review/major |

- Gate transitions (expected from this fix): 1.4.3 failed → needs_review; 1.2.2 failed → needs_review; 493 predictions definitive → needs_review. No finding added or removed, no case change, no new pass, no coverage change; the 11 existing blockers are unchanged; static set unchanged (30 pass, 7 fail).
- The 37 provisional no_violation contrast cases (the elements of the review's fix-1 table) were TN before and after because the engine reports none of those 37 elements on the healthy tuning-v4 pages: no prediction carries their selector or element HTML (observed). Correction (2026-10-15): an earlier note said their selectors came from the broken 8e03985c render; that holds for one case only. All 37 element HTMLs occur verbatim in the tuning-v4 DOMs, and 36 stored selectors equal the selector axe computes on the healthy page; C-000028 was anchored at `#main-content` from the broken render and resolved to nothing, so it got a revision with axe's tuning-v4 selector (revision 2, reason recorded). The matcher would associate any of them if reported (selector or HTML), so they remain regression guards; the new anchoring check in `compare` lists judged cases whose page or element is not in the corpus (on these runs only C-000040, the logo case on excluded p047).
- The "Fix-1 elements" row in the table counts other elements with the same classes on the same pages (for example `.c-green-h > strong` "start owning"), not the 37 case elements (observed).
- Tests: `test/unit/needs-review.test.ts` (12, including a scan of a page with text over a background image: needs-review contrast, 1.4.3 needs_review, 1.1.1 still failed) and one report-arithmetic test in `html-template.test.ts`. Suite 1,470 → 1,483.
- Assumptions:
  - Lakewood delivered-report scan 1a6e3c3e (2026-05-20, `wcag-data/wcag-old.db`): 31 findings (12 Claude, 19 Playwright) and no axe findings at all, so no incomplete result was stored as a failure; 1.4.3 passed ("Passed 1 axe-core rule(s): color-contrast (122 elements tested)") (observed). The delivered report is not affected by P2-030.
  - The manual-review line of the effort estimate still counts undetermined contrast elements (2–4 minutes each, capped); they add no fix hours (assumed to be the intended "out of effort estimates").
  - Older scans stored before this fix show needs_review_findings 0 until they are reprocessed (assumed acceptable; their stored tiers are unchanged).

## Fix batch 2 (2026-10-15 →)

Seven fixes in sequence, each gated against the previous fix's run on tuning-v5 (reference: `replay-20261016T032955Z-2e7486` at 4b80ed5, the embed fix). Starting SHA 2752253. Budget $8.00.

### Fix 1: production scan safety (P2-006, P2-007)

Branch `fix/p2-006-p2-007`, commit 4d84335. Gate: `replay-20261016T042641Z-1a9ef5`, `compare-20261016T043851Z-d630b1` exit 0; static `static-20261016T042644Z-8d2724` (30 pass, 7 fail, the same seven). Tests 1,505 → 1,518. Spend: $0.00 (replay from cache).

- Observed before: `--urls` mode skipped robots.txt (`robotsTxt = fixedList ? null : …`); production contexts used Chromium's default user agent; loads ran four pages at a time with no gap; the submission interceptor continued every non-POST request, so a GET form navigated the live site (code, P2-006/P2-007).
- Change:
  - `src/core/etiquette.ts`: `productionEtiquette()` builds the user agent `WCAGEngine/<package version> (+<contact URL>)` from `WCAG_CONTACT_URL` (else `EVAL_CONTACT_URL`) and a `Pacer` (`src/core/pacer.ts`, moved from the eval transport; one promise chain per host, interval = max(`--min-delay-ms`, robots `Crawl-delay`)). `wcag scan` and `wcag verify` refuse to run without a contact URL. `scan()` installs the pacer for the process; the crawl's loads and every check load (`pacedGoto`/`pacedReload` in scanner.ts, submission.ts, on-input.ts, keyboard.ts) wait on it. The scan log shows "User agent: …", the robots.txt summary, and at the end "Pacing: N top-level load(s), smallest gap … (minimum … ms)"; `ScanResult.etiquette` carries the same numbers.
  - `src/core/robots.ts` (moved from `src/eval/robots.ts`, which now re-exports with its own product token): RFC 9309 groups, Allow/Disallow longest match, `*`/`$`, Crawl-delay; `fetchRobots` sends the user agent. The crawler fetches it in both modes. `robots: "strict"` (production, set by `scan()` when etiquette is present): a network error or any status other than 2xx/4xx throws `…/robots.txt: … Refusing to scan until robots.txt can be read.`; a disallowed URL in a fixed list is skipped with `Skipped by robots.txt: <url>` and listed in `CrawlResult.excludedByRobots` / `ScanResult.excludedByRobots`. Without etiquette: `"skip"` for a pinned list (the offline eval harness enforces robots at capture and must not fetch during replay) and `"lenient"` for discovery (errors mean no restrictions), which is the previous behaviour. The crawler's old wildcard-only parser remains exported for its tests but is no longer used.
  - `src/core/containment.ts` (moved from the eval transport): `setupRequestInterception` opens a CDP session on the page, records `Page.frameRequestedNavigation` with reason `formSubmissionGet`/`formSubmissionPost` as pending, and classifies each request with `classifyRequest`: a pending navigation (GET included) is fulfilled with 204 so the page stays put and `detectErrors` runs on it; unsafe-method requests (POST document/fetch/XHR) are aborted; the engine's own `page.goto` passes (the transport test that loads a page under the interceptor still passes). Without CDP the previous behaviour applies.
- Gate: 897 → 894 rows; 0 criterion transitions, 0 case changes, 0 coverage changes, no unanchored case. Row changes: `focus_order_mismatch` p012 re-keyed and p017 gone (P2-036 timing, as in the previous two gates) and 2 `image-alt` rows on p047 inside Instagram embeds (tagged third-party; the P2-023 per-load variation). None attributable to this fix; the replay runs without etiquette, so pacing and the user agent are not exercised offline, and the eval transport's containment counts are unchanged (2,362 contained submissions in both runs).
- Live (scan `14f55391`, 52 pages, at c74922c): log lines "User agent: WCAGEngine/0.1.0 (+<contact URL>)", "robots.txt: 0 rule(s) for the none group; loads paced 3000 ms apart" (Popfly's robots.txt has no group that applies to this scanner) and "Pacing: 117 top-level load(s), smallest gap 2999 ms (minimum 3000 ms)". Total 9 m 52 s (crawl 2 m 58 s, behavioral 3 m 29 s, forms 3 m 22 s) against 8 m 26 s for e6f7aa27. Counted findings 788 (260 confirmed: critical 3, major 99, minor 43, advisory 115; 528 needs review) against 790, within ±10; criteria identical. Raw rows 1,034 against 1,089: third-party rows 246 against 299 (Instagram/TikTok iframe content: 33 `color-contrast` on the athletes post, 22 `link-in-text-block` on two posts; the embeds' own per-load rendering, P2-023 pattern, inferred) and 7 `missing_autocomplete` rows stored against the other embed post (P2-005 canonical-page assignment, observed). Model: 96 calls, 149,073 tokens, about $0.78. Batch spend so far: $0.78 of $8.00.
- Assumptions:
  - The contact URL in the user agent is the operator's page, read from the environment; it is never written to a committed file (assumed to be the privacy rule in force; the hook enforces `EVAL_CONTACT_URL`).
  - Pacing serialises loads per host, so a 52-page scan with four-way page concurrency runs its loads 3 s apart in effect; the live scan reports the resulting time (assumed acceptable for a municipal scan; `--min-delay-ms` lowers it when a site allows).
  - A GET navigation that CDP does not announce as a form submission (for example a script that sets `location` after submit) still passes; that is the eval transport's rule too (observed), kept for parity.

### Fix 2: focus-order sampling (P2-036; P2-027 and P2-029 closed as symptoms)

Branch `fix/p2-036`, commits b2ae509 (page coordinates) and 1799c22 (large_gap removed). Gate: `replay-20261016T151847Z-f03013` (3 repeats), `compare-20261016T155615Z-74efc6` against the fix-1 run `replay-…1a9ef5`, exit 0; static `static-20261016T151850Z-ea71c3` (30 pass, 7 fail, the same seven). A first gate at b2ae509 (`replay-20261016T045426Z-19c656`, `compare-20261016T053137Z-4ca1d2`) was invalid for 5 refused `CONNECT cdn.prod.website-files.com:443` attempts in repeat 1 (P2-037, a pre-existing harness flake also in `replay-…b67ec8` and both record runs) and showed the large_gap effect below. Tests 1,518 → 1,520. Spend: $0.00.

- Observed before: `recordTabSequence` read each stop's `boundingBox()` (viewport-relative) right after the Tab press; on a smooth-scrolling site the next control is sampled mid-scroll, so "backward jumps" were artefacts of the scroll phase and moved whenever per-stop timing changed (14 findings moved under the embed fix; p004/p017 had identical sweeps and different results).
- Change (candidate fix (a) from the entry): each `FocusStop` records `pagePosition` — `getBoundingClientRect()` plus `scrollX`/`scrollY` in one evaluate, re-read once per animation frame until it holds still (bounded at 20 frames, usually one) — alongside the viewport `boundingBox` focus-visible uses for its crops. `analyzeFocusOrder` and `computeVisualOrder` use `pagePosition`. Page coordinates do not change while the viewport scrolls, so the sampling phase no longer matters.
- Under correct positions (first gate, 19c656): backward jumps fell from 33 to 2 across tuning-v5, and `large_gap` (> 500 px downward, "skipping visual content") went from 2 to 106 issues on 23 of 48 pages. In page coordinates that rule only measures a stretch of page with no focusable content — on `/company/jobs` the nav's last button (y ≈ 37) to the first job link (y ≈ 1361), 1,324 px, with nothing focusable between — which is not a focus-order defect. The rule was removed (1799c22); backward jumps (> 200 px upward) and same-row leftward jumps (> 200 px) stay, and `measured_values.jump_distances_px` records each jump's page distance.
- Gate (f03013 vs 1a9ef5): 894 → 881 rows; `focus_order_mismatch` removed on 16 pages, added on 2 (`/company/events`, `/company/press`: one same-row leftward jump of 834 px each, vertical −26 px, at the end of the sweep — the footer's last row, inferred); 2 Instagram `image-alt` rows on p047 moved between embeds (P2-023, tagged). 0 criterion transitions (2.4.3 stays failed on the two pages), 0 case changes, 0 coverage changes, no unanchored case, no egress in any repeat. Focus-order identical in r1 = r2 = r3; no flaky check; the pages of P2-027/P2-029 (p003, p004, p012) have no focus-order finding, so both are closed as symptoms.
- Tests: `test/fixtures/keyboard-smooth-scroll-test.html` (six links 350 px apart under `scroll-behavior: smooth`): positions identical across two loads and equal to the document offsets, viewport boxes still recorded, no issue; `focus-order.test.ts`: the removed rule reports nothing on the nav-to-job-link layout, a 500 px upward jump is still reported with its distance; existing tests moved from `boundingBox` to `pagePosition`.
- Live (scan `d8624ab9`, 52 pages, at 450aa3e): `focus_order_mismatch` on 3 pages against 16 in 14f55391 — `/start/new` (one upward jump of 514 px between stops 3 and 4), `/company/events` and `/company/press` (one same-row leftward jump of 834 px each, the footer's last row); each finding carries `jump_distances_px`. Other counted findings 787 against 788 (truncated_tab_sweep +1, style_not_structure −2, custom_interactive_no_role −1, one semantic finding +1: page-assignment and behavioral noise, observed). Criteria identical (2.4.3 failed). 118 top-level loads paced ≥ 2999 ms; total 10 m 18 s; 96 model calls, 149,676 tokens, about $0.78. Batch spend so far: $1.57 of $8.00.
- Assumptions:
  - A control whose layout keeps moving for more than 20 frames (a looping animation) is read at frame 20 (assumed rare; the sweep fixtures and the corpus pages settle within one frame).
  - The remaining same-row leftward jumps on two pages are a real DOM-versus-visual order difference in the footer (inferred from the distances; not checked visually).

### Fix 3: criterion status integrity (P2-010, P2-033, P2-004, P2-032, stored-criteria gap)

Branch `fix/p2-010-criterion-status`, commits 541a037 and 401b12a. Gate: `replay-20261016T162145Z-2870fd`, `compare-20261016T163429Z-4effef` against the fix-2 run `replay-…f03013`, exit 1 (accepted, see below); static `static-20261016T162151Z-010e96` run with `--synthetic` (30 pass, 7 fail, the same seven; SL-016 pass). Pre-fix synthetic baseline `static-20261016T151948Z-6ce5dc` (diagnostic): SL-016 fail, 4 false passes. Tests 1,520 → 1,528. Spend: $0.00.

- Observed before: a model-based check that threw left its criteria passed (1.1.1, 2.4.4 from the semantic tier's blanket "attempted" set; 1.3.5, 3.3.4 from the form tier's "no violation recorded" pass) — the SL-016 synthetic case; the report turned a failed criterion into a pass when its findings were filtered as possibly noisy; the Tier 1 loop upserted each page's axe passes and then its inapplicables, so the last upsert on each page decided the stored status and only a rule's first WCAG tag counted; the report counted 51 criteria (1.3.6 is AAA); 44 of 50 criteria had a stored row on tuning-v5 (none for 1.2.1, 1.2.3, 1.2.4, 1.2.5, 2.5.3, 4.1.1, 4.1.3).
- Change — one rule set, `src/core/criterion-status.ts`, applied after reconciliation (`settleCriterionResults`) and tested as a unit:
  - `withholdPassesOnFailedChecks`: a `passed` or `not_applicable` row becomes `not_tested` with "Not established: <check> failed on N page(s): <first line of the error>" when any check addressing the criterion (`CHECK_CRITERIA` in `check-registry.ts`, the same map as `eval/config.json`) recorded a `failed` coverage entry on any page. Findings-backed `failed` and `needs_review` stand. (P2-010)
  - `completeCriterionRows`: exactly the 50 A/AA criteria of `src/core/wcag-criteria.ts` — the single list the scanner, the report (`ALL_CRITERIA`, `CRITERION_NAMES`) and the untested table now share; out-of-scope rows (1.3.6) are dropped from the result and the database; a criterion with no row is `not_tested`, tested_by `manual`, reason `no_check: <name> is not covered by any automated check; needs a manual check`. The scorecard lists every not-tested criterion with its stored reason ("Not tested (N)"). (P2-032, stored gap)
  - `aggregateAxeCriteria` (`checks/automated/index.ts`): `runAxeChecks` now returns every rule's outcome with all of its WCAG tags; the scanner collects them per page and settles each criterion once over all pages: `passed` only when every mapped rule passed or was inapplicable on every page and at least one passed somewhere ("Passed k axe-core rule(s) on m of n page(s), inapplicable elsewhere: …"); a violation or incomplete result on any page, in any order, leaves the status to the findings; all inapplicable everywhere is `not_applicable`. (P2-004)
  - `reconcileInMemory`: `failed` with every finding filtered → `needs_review` ("N finding(s) filtered from this view as possibly noisy; needs a manual check"), never `passed`. (P2-033)
  - 3.3.4 is `not_applicable` when no form is legal, financial or data-changing: the high-risk check returns before any model call then, so a "pass" there rested on nothing (the one false pass left after the first commit).
- Gate (2870fd vs f03013): 881 → 881 rows (the p047 Instagram `image-alt` swap only, tagged); 0 case changes, 0 coverage changes, no unanchored. Criterion rows 44 → 50: 1.3.6 absent; 1.2.1, 1.2.3, 1.2.4, 1.2.5, 2.5.3, 4.1.1, 4.1.3 added as `not_tested`/`no_check`. Two criteria newly `passed`, accepted as the P2-004 correction: **3.1.1** `not_applicable` → `passed` — `html-has-lang` and `html-lang-valid` passed on 47 of 47 pages, `html-xml-lang-mismatch` inapplicable; before, each page's inapplicable row overwrote its pass a moment after it was written. **3.3.2** `not_applicable` → `passed` — `form-field-multiple-labels` passed on 2 of 47 pages (the pages with forms), inapplicable on the other 45; same mechanism. The compare's two `false_pass` flags on these criteria (`axe-core:not_recorded` on 1 page) are the p051 condition: tuning-v5 lists `/overland` (p051) but no replay has ever loaded it (48 listed, 47 observed, no crawl failure, no record), so the harness counts it as unestablished for every passed criterion — the same condition behind the seven existing blockers (1.4.1, 1.4.4, 1.4.12, 2.1.1, 2.1.2, 2.4.2, 3.2.3). Registered as P2-038, handled in fix 3b.
- SL-016 synthetic (static `--synthetic`): before, "model-based checks throw" produced 4 false passes (1.1.1, 1.3.5, 2.4.4, 3.3.4); after 541a037, 1 (3.3.4); after 401b12a, 0 in all three variants (HTTP 400 for every call, every check throws, deterministic control).
- Tests: `test/unit/criterion-status.test.ts` (8: the withhold rule with and without a failure, the 50 rows and `no_check` reasons, the settle order, the P2-033 flip, the check→criteria map, axe aggregation across pages incl. page order and multi-tag rules, and a scan of a one-page site storing exactly 50 rows with the report's counts adding up to 50 and the not-tested list rendered); `html-template.test.ts` (50, not 51), `needs-review.test.ts` (filtered failure → needs_review).
- Live (scan `6869792f`, 52 pages, at 07fc27c): 50 rows stored (8 passed, 15 failed, 4 needs_review, 4 not_applicable, 19 not_tested), none for 1.3.6; the seven uncovered criteria stored `not_tested` / `no_check`; no `failed` coverage entry in this scan, so no pass was withheld; 3.1.1 `passed` (html-has-lang, html-lang-valid on 51 of 51 pages) where d8624ab9 stored `not_applicable` by upsert order; 3.3.4 `failed` on its finding. Report `report-6869792f.html`: scorecard 8 + 15 + 4 + 4 + 19 = 50, executive summary 27 criteria tested, "Not tested (19)" with every reason. Counted findings 775 against 774; 118 loads paced ≥ 2999 ms; 10 m 16 s; 96 model calls, 149,107 tokens, about $0.78. Batch spend so far: $2.35 of $8.00.
- Assumptions:
  - `partial` and `skipped` coverage entries do not withhold a pass: a skipped check recorded its reason (no forms on the page, no API key) and a partial keyboard sweep still ran on the page (assumed; the eval evaluator counts `partial` as unestablished, so a pass over a partial sweep still shows as an existing blocker there — 2.1.1 and 2.1.2 today).
  - `tested_by: manual` for `no_check` rows reuses the existing enum value; it means "needs a manual check", not that a person checked it (assumed acceptable; the reason string says so).

### Fix 3b: unscanned pages are recorded with their reason (P2-038)

Branch `fix/p2-038`, commit 5ad8107. Gate: `replay-20261016T165653Z-972b63`, `compare-20261016T170919Z-042a7a` against the fix-3 run `replay-…2870fd`, exit 0; static `static-20261016T165704Z-225e6b` (30 pass, 7 fail, the same seven). Tests 1,528 → 1,529. Spend: $0.00.

- The actual reason for `/overland` (p051): its captured DOM has `<meta name="robots" content="noindex">` and its HAR response is a plain 200 (observed). The crawler excluded it as noindex in every replay and recorded that in `ScanResult.excludedByNoindex`, but the eval engine result did not carry the record, so the harness saw 48 listed pages and 47 observed and treated the page as `not_recorded` for every check. The 2026-10-14 note was right; the fix-3 note's "resolves to an already-captured page" was a wrong inference, corrected in P2-038. Live, `/overland` was never in the pinned verification list, so no live scan had a record either.
- Change: `CrawlResult.excluded` records every page the crawl does not scan — `noindex` (detail: the source), `redirect_to <url>` (off-site), `duplicate_of <url>` (a page already in the scan), `robots_disallowed`, `load_failed` (detail: the first line of the error) — with a log line `Not scanned: <url> (<reason>: <detail>)`; the redirect and duplicate cases were previously silent returns. The scan session stores the list (`excluded_pages`), the CLI prints "Not scanned: N page(s)" with each reason, the JSON output carries `excluded_pages`, and the report's scope section lists them under "Not Scanned" with the reason in words; older sessions' `{ url, source }` noindex entries still render. `ScanResult.excludedPages`; `excludedByNoindex`, `excludedByRobots` and `failedPages` are kept. Eval: `EngineRunResult.excludedPages` → each replay site record's `pages_excluded` (page id, reason, detail) in `summary.json` → `loadRunInputs` drops those pages from the site's page set, so a recorded exclusion establishes nothing either way.
- Gate (972b63 vs 2870fd): 881 → 881 rows (the p047 Instagram `image-alt` swap, tagged); shared pages 47 (p051 recorded `noindex / meta-robots` and left out of the denominator); 0 transitions, 0 case changes, 0 coverage changes, no unanchored. Existing blockers 11 → 4: the seven `pass_with_unestablished_checks` (1.4.1, 1.4.4, 1.4.12, 2.1.1, 2.1.2, 2.4.2, 3.2.3) and the two from fix 3 (3.1.1, 3.3.2) are gone, so p051 was their only cause; the four left are the `static_broken` cases LS-010, LS-011, LS-012, LS-014 (fail in both runs, unrelated).
- Tests: `crawler-etiquette.test.ts`: a pinned list with a redirect onto a listed page (`duplicate_of`), a redirect to another origin (`redirect_to`), a noindex page, a robots-disallowed path and a connection the server drops (`load_failed`) records all five with the log lines; the robots test reads the new wording.
- Live (scan `098a527c`, the 52-entry list plus `/overland`, at 21fbd8b): crawl log `[crawl] Not scanned: https://www.popfly.com/overland (noindex: meta-robots)`; CLI summary `Not scanned: 1 page(s)` with the entry and its reason; the session's `excluded_pages` holds `{ url, reason: noindex, detail: meta-robots }`; the report's scope section lists it under "Not Scanned" with the reason in words and the `--include-noindex` hint. 51 pages scanned; criteria (8/15/4/4/19) and counted findings (775) as in 6869792f; 119 loads paced ≥ 2999 ms; 10 m 10 s; 96 model calls, 148,785 tokens, about $0.78. Batch spend so far: $3.13 of $8.00.
- Assumptions:
  - In discovery mode only noindex pages and load failures are recorded; a discovered link that redirects onto a known page is routine deduplication and stays unrecorded (assumed; the user-facing promise is for `--urls` entries).
  - A pinned entry that redirects to an off-site host the browser cannot resolve is `load_failed` (the navigation throws), not `redirect_to` (observed in the test; acceptable, the error names the host).

### Fix 4: in-scan cache key (P2-002)

Branch `fix/p2-002`, commit 68ad1ff. Gate: `replay-20261016T172357Z-f9d36a`, `compare-20261016T173623Z-ff700c` against the fix-3b run `replay-…972b63`, exit 0; static `static-20261016T172406Z-81a576` (30 pass, 7 fail, the same seven). No live scan (gate only, as planned). Tests 1,529 → 1,531. Spend: $0.00.

- Observed before: `cacheKey()` was `sha1(template name, user message, image)`: two inputs with different model ids (an env override), system prompts, template content or output schemas shared one in-scan cache entry; the eval cache keyed on the full `EffectiveRequest`, so the two caches did not agree on what "the same request" is.
- Change: `src/core/request-key.ts` holds `EffectiveRequest`, `requestKey`, `sha256`/`canonicalJson` and the template hashes; `src/eval/util.ts` and `src/eval/model/cache.ts` re-export them (one implementation). `PromptRunner.cacheKey(input)` = `requestKey(effectiveRequestOf(input))` with the model id from `resolveModelId`, the template's content hash, its system prompt, the user text, the image hash and media type, the output-schema hash and the request parameters (`MAX_TOKENS` 4096, `TEMPERATURE` 0, now constants shared with `buildMessages`). The eval client's `templateContext` uses the same hash functions.
- Gate (f9d36a vs 972b63): 881 = 881 rows, no row differs; 0 criterion transitions, 0 case changes, 0 coverage changes; 73 cache reads, 0 misses, 0 recorded — the eval key composition is unchanged, so every request hit the existing cache.
- Tests: `prompt-runner.test.ts`: the engine key equals `requestKey` over the eval client's `effectiveRequest` for the same input, with and without an image; the key changes with the model id (`WCAG_MODEL_SONNET`), the system prompt, the output schema, the route and the image, and not with insertion order.
- Assumption: a scan still reuses a response only within one runner (one scan); cross-scan reuse is the eval cache's job (unchanged).

### Fix 5: the error-message prompt gets the form (P2-001, P2-022)

Branch `fix/p2-001`, commit 837988d. Corpus: `tuning-v6` derived from tuning-v5 with p018 (`/insights`) and p050 (`/jobs/head-of-gtm`) restored (`derive-corpus-20261016T173952Z-47a546`; 50 captured, p016 still excluded for fix 6). Record: `record-20261016T174007Z-68ddf9` on tuning-v6, 79 reads, 2 recorded, ~$0.05 — the corpus has exactly two error-message prompts, both on the restored pages. Acceptance: `replay-20261016T175418Z-66fd1f` (tuning-v6, 3 repeats): non-behavioral identical, every form check (error-messages, form-submission, input-purpose, on-input, high-risk-forms) identical across repeats, 81 model requests per repeat, 0 cache misses. Gate: `replay-20261016T183438Z-130745` on tuning-v5, `compare-20261016T184713Z-14fd9f` against the fix-4 run, exit 0, identical (tuning-v5 has no error-message prompt). A compare of the tuning-v6 run against the tuning-v5 base (`compare-20261016T183405Z-dba755`) is invalid by construction (different page sets and artifact hashes) and is kept only as a record: its coverage and criterion movements (p023's form checks `ran → skipped` because the restored pages now host the first occurrence of the shared form; 3.2.2/3.3.1/3.3.3 `not_tested → failed/passed` because forms are exercised again) are the corpus change, not the fix. Static `static-20261016T174014Z-6942af` (30 pass, 7 fail, the same seven). Tests 1,531 → 1,534. Spend: $0.05; batch so far $3.18 of $8.00.

- Observed before: `evaluateErrorMessages` sent `truncateHtml(state.domAfter, 8000)` — the first 8,000 characters of the whole post-submission page, i.e. the `<html>` element and head (P2-001); Webflow's font loader adds `wf-<family>-<variant>-active` classes to `<html>` in load order, so the prompt differed per load (P2-022) and the two pages were excluded from tuning-v2.
- Change: `captureFormMarkup(page, formSelector, errorSelectors)` runs in the page right after `detectErrors`: the form's `outerHTML`; the outerHTML of each detected error element plus every `[role=alert]`, `[aria-live]` and `[aria-invalid="true"]` element inside the form (deduplicated); and the form's parent `outerHTML` with the form replaced by `<!-- the form, shown above -->`. Stored as `SubmissionState.formMarkup`. `composeErrorPromptMarkup(state)` builds the prompt input: a header `[sent: form N chars (truncated?), k of K error region(s) M chars (truncated?), context C chars (bounded)]`, then the form (cap 8,000), the error regions (cap 2,000 in total) and the context bounded to 1,500 characters each side of the placeholder. The header and the markup are what `llm_input.prompt` stores. A state without a capture (older recordings) falls back to the form's discovery-time markup with a header saying so — never the page head. The prompt template's lead-in names the three parts.
- Observed after (record run): the Careers Application prompt is `[sent: form 3670 chars, 0 of 0 error region(s) 0 chars, context 558 chars]` + the `<form id="wf-form-Careers-Application" …>` element; the CMS Filter prompt `[sent: form 2456 chars, …, context 379 chars]`; neither contains `<head` or a `wf-…-active` class. Both forms are `method="get"`, so their submissions were contained by fix 1 and produced no visible error region on the empty submission.
- Tests: `test/unit/error-prompt-input.test.ts`: the composition under the caps with the header, head absent; the fallback; a served page captured on two loads whose `<html>` classes differ gives identical prompts, with the error regions and the bounded context, and null for a missing form.
- Live (scan `8ffa9859`, 53 entries, at 2b5c33f): the three error-message prompts (`/start/new`, `/insights`, `/jobs/head-of-gtm`) each begin `[sent: form 5138 | 2456 | 3670 chars, 0 of 0 error region(s) 0 chars, context 393 | 379 | 558 chars]` followed by the form element; none contains `<html` or `<head`, where every prompt in 098a527c began with `<!DOCTYPE html><html …>` and held no form element. Findings (775 own) and criteria unchanged; 118 loads paced ≥ 2999 ms; 10 m 23 s; 97 model calls (3 fresh error-message calls, 13,746 tokens), 144,642 tokens, about $0.76. Batch spend so far: $3.94 of $8.00.
- Assumptions:
  - The caps (8,000 / 2,000 / 1,500 each side, about 12,000 characters at most) keep the prompt within the previous size; a form larger than 8,000 characters is truncated with a marker (assumed rare; the corpus forms are 2,456 and 3,670 characters).
  - Error regions outside the form that no detector found (a toast elsewhere on the page) are not sent (assumed; `detectErrors` already looks beyond the form for live regions, and those selectors are included).

### Fix 6: volatile values out of prompts (P2-021, P2-020 remainder)

Branch `fix/p2-021`, commit 410d312. Corpus: `tuning-v7` derived from tuning-v6 with p016 (`/start/new`) restored (`derive-corpus-20261016T190209Z-f9e5a8`; 51 captured, nothing excluded). Record: `record-20261016T190224Z-b5d2b7` on tuning-v7, 87 reads, 7 re-recorded (~$0.14): 3 error-message, 3 high-risk-form and 1 link-text prompt had carried a redactable value. The static set's two model-backed cases changed text too (`static-20261016T190230Z-c92cac`: 2 unavailable, 2 cache misses); re-recorded (`static-20261016T190332Z-a7cda1`, $0.016) and the official run `static-20261016T190359Z-58f7bc` is 30 pass / 7 fail, the same seven. Acceptance: `replay-20261016T191844Z-55867a` (tuning-v7, 3 repeats): non-behavioral identical, every form check identical across repeats with `/start/new`'s rows included, 94 requests per repeat, 0 cache misses. Gate: `replay-20261016T200037Z-bb6975` on tuning-v6, `compare-20261016T201416Z-bb99ec` against the fix-5 acceptance run, exit 0 (the p047 Instagram `image-alt` swap only). Tests 1,534 → 1,537. Spend: $0.16; batch so far $4.10 of $8.00.

- Observed before: `/start/new`'s form carries a hidden `visitor_id` (a UUID from `crypto.randomUUID`) and a hidden `landing_timestamp` (the current time), so its high-risk and error-message prompts differed on every load (P2-021); link-text and alt-text contexts had carried GrowSurf's `grsf-unique-<random>` class until P2-012 removed style text (P2-020).
- Change: `src/core/redact.ts` `redactVolatile(text)`: hidden inputs keep name and type, their value becomes `[hidden-value]`; UUIDs → `[uuid]`; ISO timestamps and attribute values that are Unix times → `[timestamp]`; tracking query parameters (`utm_*`, `gclid`, `fbclid`, `msclkid`, `_ga`, `visitor_id`, `session_id`, …) → `[tracking]`; `grsf-unique-<id>` → `grsf-unique-[id]`. Text, visible inputs' values, labels and href paths are untouched. Every `build*UserPrompt` in `src/prompts` wraps its text in it, so the in-scan cache key (fix 4), the eval cache key and `llm_input.prompt` all see the redacted prompt.
- Observed after: the re-recorded `/start/new` prompts hold 15 `[hidden-value]` placeholders and one `[uuid]`, no raw `visitor_id` or `landing_timestamp`; none of the seven re-recorded prompts contains a UUID, an ISO timestamp or a raw hidden value.
- Tests: `test/unit/redact.test.ts`: each pattern and what stays; two loads of the same form differing only in per-load values give the same high-risk and error-message prompts and the same cache key; semantic prompts drop tracking parameters and the vendor class and keep the link's text and path.
- Live (scan `c78f487b`, 53 entries, at 86470ae): of the 62 model prompts stored in `llm_input`, none contains a UUID or an ISO timestamp; the 23 form-related prompts contain no raw hidden-input value and carry 32 `[hidden-value]` and 6 `[uuid]` placeholders. Findings (775 own) and criteria unchanged; 118 loads paced ≥ 2999 ms; 10 m 16 s; 96 model calls, 142,769 tokens, about $0.75. Batch spend so far: $4.85 of $8.00.
- Assumptions:
  - A 10-digit number is treated as a Unix time only as a whole attribute value in the range 2017–2033, and 13-digit values as milliseconds; a bare number in text is left alone (assumed to avoid touching prices or counts).
  - `[tracking]` keeps the parameter name, so a link-text verdict can still see that a link carries campaign parameters (assumed harmless to the verdict).

## Scanner fixes (2026-10-15, third-party embeds)

P2-017 (Instagram embeds not third-party), P2-023 (axe results inside Instagram iframes vary per load) and P2-034 (keyboard sweep stuck in an embed reports unreachable controls), fixed as one change. Branch `fix/third-party-embeds` from main c157a07; fix commit 098dd72, corpus tooling f45a303. Tuning-v4 reference: `replay-20261015T230944Z-7f0f3b` (3 repeats, at 951a4a0; detection unchanged to c157a07). Tuning-v4 fix run: `replay-20261016T003757Z-a16306`; gate `compare-20261016T004948Z-6d030c`, exit 0. Tuning-v5 (p047 restored): reference `replay-20261016T004003Z-84c628` at c157a07, fix run `replay-20261016T004954Z-fcb1d7` (3 repeats); gate `compare-20261016T012602Z-885d85`, exit 0. Static: `static-20261015T230948Z-ce7e49` → `static-20261016T003801Z-337721` (30 pass, 7 fail, the same seven). Tests before: 1,483; after: 1,505. Model spend for the gates: $0.00 (every replay read from the cache; no semantic prompt input changed).

### Fix: third-party embed contents are tagged, listed apart, and stepped over by the keyboard sweep (P2-017, P2-023, P2-034)

- Observed before the fix (782f7078, pinned 50 pages): findings inside Instagram iframes (`#instagram-embed-N`, about 50 rows) counted as the site's own; the report's third-party exclusion knew GrowSurf only (159 rows by marker) plus 27 frame-content rows by an iframe-prefix rule. The keyboard sweep on `/post/5-fall-reel-trend-you-need-to-try-right-now` cycled inside `#instagram-embed-0` and reported 30 `unreachable_interactive_element` findings (definitive, critical). Embed inventory (tuning-v4): 11 Instagram reel iframes on 7 `/platform/*` pages, 5 YouTube iframes, GrowSurf on all 47 pages, no TikTok; p047 (excluded since tuning-v2) has 9 `iframe.instagram-media#instagram-embed-N`; 667305ae adds one TikTok (`blockquote.tiktok-embed` → `iframe[name^="__tt_embed__"]`) on the athletes post, which also has 36 Instagram iframes. Instagram's footer social links (`a[href*=instagram.com]`) are not embeds; an early matcher keyed on hrefs over-matched them, so the detector keys on containers only.
- Change:
  - `config/third-party-embeds.json` (override with `WCAG_THIRD_PARTY_CONFIG`): per vendor, the container selectors (compound selectors only). Instagram `blockquote.instagram-media`, `iframe[src*="instagram.com"]`, `[id^="instagram-embed-"]`; TikTok `blockquote.tiktok-embed`, `iframe[src*="tiktok.com"]`, `iframe[name^="__tt_embed__"]`; YouTube, Vimeo and X iframes/blockquotes; GrowSurf `div.grsf-global`, `#grsf-window` plus its element markers (`data-grsf-*`, `grsf-` tokens, `growsurf` URLs), which the report's GrowSurf rule now reads from.
  - `src/core/third-party.ts`: finds the containers in the stored DOM (nested containers count once), classifies a check result as inside one by marker, by position in the DOM, or by a selector path through a container's id, and sets `measured_values.third_party = { vendor, vendor_name, container, via }` when findings are created (`processCheckResults`). axe results from inside an embed iframe are tagged by their frame (`tagAxeResults` resolves each node in the page: a node inside a container's frame or strictly inside a container in the main document; the container element itself is never tagged, so `frame-title` on the iframe stays the site's finding). A per-scan record `<dataDir>/<scan>/third-party.json` lists each page's containers and the sweep's embed stops.
  - Counting: tagged findings are left out of `total_findings`, `by_severity`, the effort estimate, Top fixes and criterion status (`criterionStatusFromFindings` ignores them; a criterion with only tagged findings keeps its stored status and is never passed on them). `ScanSummary.third_party_findings` and `third_party_by_vendor` are new (columns migrated); CLI table, report cover and findings.md show them as "listed separately".
  - Report: new "Third-party content" section (`src/report/third-party-report.ts`), per page and vendor: embed count, the findings inside with check, criterion, severity, tier and element, and the sweep note ("stepped over N embed(s), K focusable control(s) inside; M kept focus"). Wording: "Issues inside third-party embeds are listed for awareness. The site owner may still be responsible for embedded content; they are not counted in this report's findings." The old third-party table in the excluded sections is gone.
  - Keyboard sweep (`recordTabSequence`): when focus lands inside a container, one stop is recorded for the container (no position), the focusable controls inside are counted (not for iframes), and the sweep continues from the first keyboard-reachable control after the container. Controls inside embeds are neither candidates nor unreachable (`candidates_inside_embeds`). An embed that keeps focus 50 ms after the step, or is re-entered more than three times, ends the sweep with exit `embed_focus`, reported as `possible_embed_focus_trap` (2.1.2, needs_review, score 0.4); its internals are not trap candidates. `isTruncatedSweep` now also treats a `cycle` that closes before the page's last candidate as truncated (`truncated_tab_sweep`, needs_review), tested without any embed. Focus-visible and focus-order ignore embed stops.
  - Eval: `FindingKey.third_party`; tagged keys are left out of the non-behavioral identity comparison and counted per repeat (`third_party_per_repeat`); `compare` treats a key that is tagged in the head and untagged in the base as reclassified, not removed. `derive-corpus --restore <page>` brings an excluded page back (artifacts must exist).
- Tuning-v4 gate (`compare-20261016T004948Z-6d030c`): 867 → 862 predictions; 187 tagged (Instagram 25, YouTube 15, GrowSurf 147); 176 keys reclassified: GrowSurf 147 by marker (`animated_content_no_pause` and the input-purpose, alt-text, link-text and heading rows the old rule caught), Instagram 11 `image-alt` + 3 `color-contrast` by frame, YouTube 5 each `aria-allowed-attr`, `aria-prohibited-attr`, `button-name` by frame. Confirmed own findings critical 33 → 1, major 51 → 42, minor 44 → 31, advisory 246 → 111; needs review 493 → 490; criteria unchanged (13 failed, 2 needs_review, 7 passed, 6 N/A, 16 not tested); 0 transitions, 0 case changes, 0 coverage changes; the 11 existing blockers unchanged; C-000040 unanchored (p047 excluded; anchored again on tuning-v5). Removed 11 / added 6 `focus_order_mismatch` (see P2-036 below). No other finding added or removed; the 5 `frame-title` rows on p049's Instagram iframes stay in the main findings, untagged.
- Tuning-v5 gate (`compare-20261016T012602Z-885d85`, 48 pages): 901 → 896 rows; 211 tagged rows (191 unique keys: Instagram 46, YouTube 15, GrowSurf 150; 20 rows repeat a key, the same element HTML in several embeds of one page); 190 keys reclassified (GrowSurf 150: 138 `animated_content_no_pause`, 6 `missing_autocomplete`, 3 `alt_not_descriptive`, 1 `empty_link`, 2 headings; Instagram 22 `image-alt` + 3 `color-contrast`; YouTube 15 as above); 1 Instagram `image-alt` on p047 moved from `#instagram-embed-0` to `#instagram-embed-3` (same HTML; the P2-023 variation, now tagged). Confirmed own findings critical 54 → 1, major 60 → 51, minor 44 → 31, advisory 250 → 112; needs review 493 → 490; criteria unchanged; 0 transitions, 0 case changes, 0 coverage changes, no unanchored case. p047: 44 → 45 rows, 27 tagged (21 `image-alt`, 3 `missing_autocomplete`, 3 `animated_content_no_pause`); its 9 `frame-title` rows stay. Repeatability of the fix run: non-behavioral results identical across 3 repeats, flake rate 0 on every behavioral check, third-party rows 211 / 212 / 210 per repeat, so p047 returns to the corpus.
- The 14 `focus_order_mismatch` changes on tuning-v5 (12 removed, 7 added; the tuning-v4 gate's 11/6 are the same pages less p004, p017 and p047): **re-sampled: timing artefact of P2-036, not a change in what the check detects.**
  - Re-keyed (5): p008 `/platform/user-generated-content-ugc` (3 issues, 49 stops → 2, 48), p009 `/platform/sponsored-content` (2, 48 → 2, 47), p013 `/platform/affiliate-program` (2, 50 → 2, 49), p021 `/platform/travel-tourism` (2, 41 → 1, 40), p025 `/platform/adventures` (3, 51 → 2, 50). The finding's `element_html` is `<focus-order-summary issues=… tab-stops=…/>`, so the embed stop losing its position (tab-stops −1) re-keys it.
  - Gone (7): p010 `/company`, p014 `/platform/ambassadorship`, p022 `/platform/storefronts`, p027 `/platform/evergreens`, p049 `/post/5-fall-reel-trend-you-need-to-try-right-now` (embed pages) and p004 `/platform`, p017 `/company/jobs` (no embed).
  - New (2): p012 `/brands/track` (YouTube), p047 (Instagram).
  - Evidence that the sweep did not change: on p004 and p017 the coverage message is identical in base and head ("sweep ended by cycle after 43 stops, last focused body > a, retried no" and 41 stops respectively), neither page has a container, and only the focus-order result differs (base 2 issues / 1 issue, head none in 3 of 3 repeats). Offline sweeps of both pages from the tuning-v5 HAR at c157a07 and f45a303 read viewport-relative y values that vary by up to 80 px between runs for stops beyond the first viewport (p004 stops 7–13: 355..435) and a −283 px "backward jump" on p017 that is the next stop appearing higher in the viewport after the smooth scroll. Popfly sets `scroll-behavior: smooth`; `recordTabSequence` reads `handle.boundingBox()` right after each Tab with no settle wait; the fix adds one in-page evaluate per stop (the embed check), which shifts the sampling phase. Stable within each commit (7f0f3b and 84c628 agree; fcb1d7 3 of 3), so systematic, not flake. Registered as P2-036 with two candidate fixes; P2-027 and P2-029 linked as likely symptoms.

| | Tuning-v4 ref `7f0f3b` | Tuning-v4 fix `a16306` | Tuning-v5 ref `84c628` | Tuning-v5 fix `fcb1d7` (r1) | Live |
|---|---|---|---|---|---|
| Prediction rows | 867 | 862 | 901 | 896 | 1,089 rows (e6f7aa27, 52 pages; 782f7078 1,025 on 50) |
| Third-party rows (listed, not counted) | 0 | 187 (Instagram 25, YouTube 15, GrowSurf 147) | 0 | 211 (Instagram 46, YouTube 15, GrowSurf 150) | 299 (Instagram 101, GrowSurf 161, TikTok 22, YouTube 15) |
| Confirmed own, by severity | critical 33, major 51, minor 44, advisory 246 | critical 1, major 42, minor 31, advisory 111 | critical 54, major 60, minor 44, advisory 250 | critical 1, major 51, minor 31, advisory 112 | critical 3, major 99, minor 45, advisory 115 (782f7078: 83, 93, 57, 261) |
| Needs review (own) | 493 | 490 | 493 | 490 | 528 (782f7078: 531) |
| Criteria | 13 failed, 2 needs_review, 7 passed, 6 N/A, 16 not tested | same | same | same | 15 failed, 4 needs_review (1.2.2, 1.4.3, 2.1.1, 3.3.2), 7 passed, 5 N/A, 13 not tested (782f7078: 17 failed, 3 needs_review, 6 passed): 2.1.1 failed → needs_review, 1.4.1 failed → passed |
| `unreachable_interactive_element` / `truncated_tab_sweep` / `possible_embed_focus_trap` | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 1 / 0 (782f7078: 30 / 1 / 0) |
| `frame-title` (container-level, kept) | 11 | 11 | 20 | 20 | 57 (37 on the athletes post) |

- Live verification (scan `42407010`, then `e6f7aa27`, each the pinned 50 pages plus `/post/10-female-mountain-bike-creators` and `/post/athletes-who-win-in-sport-and-storytelling-fishers`, 52 pages, about 8.5 minutes each):
  - `42407010` (at 7095c11): 0 `unreachable_interactive_element` on `/post/5-fall-reel-trend-you-need-to-try-right-now` (30 in 782f7078); 300 rows tagged (Instagram 101, GrowSurf 162, TikTok 22, YouTube 15); the embed iframes' 57 `frame-title` rows stay in the main findings; pinned-page rows 992 against 995 (782f7078 less its 30 P2-034 rows). One bullet failed: two confirmed `color-contrast` rows on the athletes post (Instagram's `#3897f0` "View this post on Instagram" text and a `#c9c8cd` link) were untagged and made 1.4.3 `failed` (needs_review in 782f7078). Cause (observed in the stored DOM): the post's 37th Instagram embed is a `blockquote class=" instagram-media-registered"` with `data-instgrm-permalink`; Instagram's embed.js renames `instagram-media` to `instagram-media-registered` when it registers a blockquote and this `/tv/` post was never replaced by an iframe, so no container selector matched. Fix 4b80ed5: the Instagram list also matches `blockquote.instagram-media-registered` and `blockquote[data-instgrm-permalink]` (config and a unit test). Gate at 4b80ed5: `replay-20261016T032955Z-2e7486` (tuning-v5, 1 repeat, $0.00), `compare-20261016T034211Z-58581c` exit 0, 0 transitions, no case, coverage or unanchored change; against `fcb1d7` only p012/p017 `focus_order_mismatch` (P2-036) and the p047 Instagram `image-alt` moving between embeds (P2-023, tagged) differ; no corpus page has a registered blockquote. Static `static-20261016T032959Z-1f548d`: 30 pass, 7 fail, the same seven.
  - `e6f7aa27` (at 4b80ed5): every acceptance bullet passes. 0 `unreachable_interactive_element` on the fall-reel post; 299 rows tagged (Instagram 101, GrowSurf 161, TikTok 22, YouTube 15; 136 by frame, 161 by marker, 2 by DOM position: the registered blockquote's two rows, container `#instagram-media-payload-18`), none inside an Instagram or TikTok container left untagged; 57 `frame-title` rows kept; pinned-page rows 990 against 995 (−5, within ±10); 1.4.3 back to needs_review. Embed posts: fall-reel 36 rows (14 own: 5 `frame-title`, 4 `missing_autocomplete`, skip link, heading style, custom control; 22 tagged), mountain-bike 51 rows (11 own, 40 tagged; one `truncated_tab_sweep` needs_review, so 2.1.1 is needs_review instead of failed), athletes 99 rows (38 own, 37 of them `frame-title`; 61 tagged). Sweep notes: one embed stop on each of 10 `/platform/*` and `/company` pages, 2 on `/platform/storefronts` and the athletes post, 5 on the mountain-bike post; no embed kept focus. 1.4.1 moved failed → passed: its only rows were Instagram content, and axe's passes for it elsewhere stand (the designed outcome; recorded here as a visible change).
  - Model spend: scan 42407010 96 API calls, 149,103 tokens; e6f7aa27 96 calls, 150,150 tokens (411 served from the prompt cache each). At the per-token rate used for 782f7078 (about $0.77 for 147,012 tokens, P2-035 method) that is about $0.78 + $0.79 = $1.57 of the $3.00 cap; the gates read every model result from the cache ($0.00). Inferred: the scanner still records no input/output token split (P2-035).
- Tests: `test/unit/third-party.test.ts` (9: config, compound selectors, container discovery, classification, record), `test/unit/keyboard-embeds.test.ts` (3, HTTP-served fixtures: step-over of an iframe and a blockquote embed; a cycle that closes early is truncated without an embed; an embed that keeps focus is a possible trap and its internals are not trap candidates), `test/unit/axe-third-party.test.ts` (2: frame and blockquote tagging; a scan lists tagged findings apart and sets no status on them), `test/unit/third-party-report.test.ts` (5), `test/eval/runs.test.ts` and `derive-corpus.test.ts` additions; `clustering.test.ts` updated for the new section. Suite 1,483 → 1,505.
- Assumptions:
  - A finding inside an embed is attributed to the vendor whose container encloses it; for nested vendors (a TikTok iframe inside its blockquote) the outer container counts once (observed in tests; assumed to be the useful grouping).
  - 50 ms is enough for an embed that takes focus back from a timer to do so (assumed; the fixtures use 0 ms timers, Instagram and TikTok embeds on Popfly did not keep focus in any gate run).
  - "Focusable controls inside" is counted from the DOM for blockquote embeds and reported as "contents not inspected" for iframes, since cross-origin frames cannot be read (observed).
  - The live acceptance for pinned-page totals is read against 782f7078 after subtracting its 30 P2-034 findings and the rows that are now third-party (assumed: the task's ±10 applies to the site's own findings).

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
