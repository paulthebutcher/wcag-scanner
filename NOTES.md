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

## Out of scope

- Grouping class-level style fixes (focus indicators, colours set on a class) by class instead of per element. It would merge the per-link footer focus clusters into one Top fix, but needs a different signature from the one specified.
- Recognising GrowSurf by `data-grsf-*` attributes or `growsurf-prod` image URLs, which would move the three GrowSurf images (Top fixes 5 to 7) to Third-party.
- The report's "Findings by Type" cards merge different axe rules that share a `finding_type_hash` (for example `aria-prohibited-attr` inside the "aria allowed attr" card), and a card shows one remediation for the whole group. Top fixes keeps them apart. Fixing the card grouping changes report structure beyond these phases.
- Enabling `typescript-eslint` recommended rules. They would flag existing code across the repo (unused vars, `any`), and fixing that is a refactor outside these phases.
