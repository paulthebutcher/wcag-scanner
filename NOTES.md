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

## Out of scope

- Enabling `typescript-eslint` recommended rules. They would flag existing code across the repo (unused vars, `any`), and fixing that is a refactor outside these phases.
