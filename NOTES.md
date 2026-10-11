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

## Out of scope

- Grouping class-level style fixes (focus indicators, colours set on a class) by class instead of per element. It would merge the per-link footer focus clusters into one Top fix, but needs a different signature from the one specified.
- Recognising GrowSurf by `data-grsf-*` attributes or `growsurf-prod` image URLs, which would move the three GrowSurf images (Top fixes 5 to 7) to Third-party.
- The report's "Findings by Type" cards merge different axe rules that share a `finding_type_hash` (for example `aria-prohibited-attr` inside the "aria allowed attr" card), and a card shows one remediation for the whole group. Top fixes keeps them apart. Fixing the card grouping changes report structure beyond these phases.
- Leaving hedged Claude verdicts (`needs_review` with no failure type, shown as `semantic`) out of "newly broken", and making Claude's failure-type names stable across runs. Both change signatures between scans without the site changing.
- Enabling `typescript-eslint` recommended rules. They would flag existing code across the repo (unused vars, `any`), and fixing that is a refactor outside these phases.
