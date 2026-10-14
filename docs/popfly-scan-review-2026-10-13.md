# Popfly scan review: scanner issues to fix (handoff)

Date: 2026-10-13
Site: https://www.popfly.com (Webflow)
Purpose: input for a scanner-improvement prompt. Records what was observed on real scans, what we chose to fix, and how each fix improves the scanner. Labels: **observed** (verified in data or on the live site), **inferred** (best explanation, not proven).

## Scans referenced

| Scan | When (UTC) | Notes |
|---|---|---|
| e779c8b0-03f2-44fd-87cc-b960bc230785 | 2026-10-04 | Original baseline, 1,342 findings |
| ee56b381-8743-4b24-9b09-9654a63b1614 | 2026-10-12 03:0x | First scan after scanner Fixes 1–5 (commits 7494e90..86d750d), 830 findings |
| 6d4e82fe-11bc-4d17-a415-a36230af6614 | 2026-10-12 22:49 | Different 11 pages crawled, 1,008 findings |
| 8e03985c-68c3-4649-adb3-9aee4f0ed72d | 2026-10-14 03:06–03:13 | Same 50 pages as 6d4e82fe, 457 findings |

## Site-side context (ground truth for regression fixtures)

Fixed on the live site between Oct 10 and Oct 13 and verified live with real key presses:
- Link color `#286140` → `#419e69` on dark backgrounds; blog rich text links (`.article-detail-rtf.blog a`) use `#286140` on white.
- `.p-gray-large` opacity 0.7 replaced by color `#aeafb0` (links inside no longer inherit opacity).
- Skip link injected by script as first body element, target = first element after `.header-wrapper` (id `main-content`, or the element's existing id, e.g. `#win`), `tabindex="-1"`. Webflow's smooth-scroll moves focus to the target 400–800 ms after activation.
- `.btn.modal` divs get `role="button"` + `tabindex="0"`; a document-level keydown handler maps Enter/Space to click for non-native `[role="button"]`.
- FAQ (`.faq-question` / `.faq-answer-wrapper`): `role="button"`, `aria-expanded`, `aria-controls`, closed answers `inert`.
- Demo modal (`.cta-popup`): `role="dialog"`, `aria-modal`, focus moved in on open, Tab trapped, Escape closes, focus returned to trigger; close icon is `role="button"` with `aria-label="Close"`.

These are good real-world patterns for fixtures: delayed focus after skip link, `inert` accordions, Webflow IX2 entrance animations, script-added ARIA.

## Chosen to fix now (priority order)

### 1. Contrast measured before Webflow animations settle (false failures)
- **Observed:** all 37 definitive contrast failures in 8e03985c are false. Scanner recorded colors that do not exist on the settled page. Live values measured after scrolling each element into view and waiting 2 s:

  | Element (page) | Scanner recorded | Live, settled |
  |---|---|---|
  | `.partner-stat-single .stat-h`, `.patner-sub` (/) | `#2d2f31` on `#1e252b`, 1.15:1 | `#efefef` at 0.7 opacity on `#1e252b`, ~7:1 |
  | `.c-brand-ftr-card .c-ftr-h`, `.c-p-gray` (/, /for-agencies) | `#333333` / `#2d2f31` on `#1e252b` | `#efefef` on `#1e252b` |
  | `.c-subtitle > strong`, `.c-green-h` (/, /for-agencies) | `#6cc24a` on `#ffffff`, 2.22:1 | `#6cc24a` on `#17191e`, ~8:1 |
  | `.p-gray-large`, `.testimonial` (/for-agencies) | `#aeafb0` on `#ffffff`, 2.19:1 | `#aeafb0` on `#17191e`, ~8:1 |
  | `._4-col-single .faq-h`, `.footer-cr-center > div` (/) | `#efefef` on white; `#333333` on `#17191e` | `#efefef` on `#17191e` |

- **Observed:** axe runs inside the crawl's `onPage` callback (`src/core/scanner.ts` ~line 803, `runAxeChecks(page, scanId)`), i.e. on the crawl's own page load.
- **Inferred:** these elements use Webflow IX2 page-load and scroll-into-view animations (start dark/transparent, or before section backgrounds paint). axe measured the pre-animation state; 1.15:1 is text mid-fade.
- **Fix direction:** before running axe, scroll the page top to bottom in viewport steps, wait for animations to finish (e.g. `document.getAnimations()` idle plus a short settle timeout), return to top, then run axe. Alternatively or additionally, re-verify each contrast failure on the settled page (scroll element into view, wait, recompute colors) and drop or route to needs_review when the settled result passes.
- **Improves:** removes the largest remaining false-positive class on animated sites (all Webflow IX2 sites). Contrast counts become trustworthy for client reports.

### 2. Skip-link check rejects valid targets not named like "main"
- **Observed:** `broken_skip_navigation` on /start/new and /overland in ee56b381 and 6d4e82fe. Live: skip link is first in body, `href="#win"`, target `section#win.section-convert-header` with `tabindex="-1"`, focus moves correctly.
- **Observed:** `src/checks/behavioral/skip-nav.ts` ~line 228 `isMainContent` accepts only `<main>`, `role="main"`, ids `main|content|main-content|maincontent|primary`, or class `main-content`.
- **Fix direction:** also accept a target that is the first content element after the header/nav landmark (or contains the page's first `h1`), and any target where focus lands past all header/nav focus stops.
- **Improves:** removes false 2.4.1 failures on sites whose skip targets reuse existing ids.

### 3. Page-level findings clustered as one "fix"
- **Observed:** Top fixes in 6d4e82fe/8e03985c show "html: focus order mismatch" (cluster `79dc811ae6ad`), 20 pages, estimated 0.1–0.2 h. These are 20 different per-page focus-order problems grouped because the element is `<html>`/a summary node.
- **Fix direction:** in `src/report/clustering.ts`, page-level summary findings (e.g. `focus_order_mismatch` summaries) cluster per page, or are excluded from Top fixes and shown in a per-page section. Site-level findings that really are one fix (e.g. `insufficient_navigation_methods`, one sitemap/search addition) can stay grouped.
- **Improves:** Top fixes only lists things that one change actually clears; hour estimates stop understating work.

### 4. Accessible names read before Webflow scripts run
- **Observed:** 8e03985c reports `image_link_no_alt` on `a.header-logo-link.w-nav-brand` on 48 pages. The stored DOM snapshot has `<a href="/" class="header-logo-link w-nav-brand"><img alt="" ...></a>` with no `aria-label`. Live, the link has `aria-label="home"` (added at runtime by webflow.js).
- **Inferred:** the semantic/LLM check uses the snapshot DOM captured before webflow.js finishes, not the settled live DOM.
- **Fix direction:** capture the DOM used for name/role checks after `load` plus network/animation idle, or compute accessible names in the live page (Playwright accessibility snapshot) instead of from serialized HTML.
- **Improves:** removes false name/role findings on any site that adds ARIA via script (Webflow nav, our own sitewide scripts).
- Note: `alt="Popfly"` on the logo is still a real site improvement ("home" is a weak name). The scanner issue stands independently.

## Recommended next (not yet chosen)

5. **Rotating page set.** `maxPages` default 50 is below Popfly's ~54 static pages + CMS samples (sitemap: 168 URLs, 111 `/post/*`, 3 `/jobs/*`). Each run drops a different handful (6 `/archive/*` pages in ee56b381 vs 11 industry/blog pages in 6d4e82fe), so totals swing without site changes. Options: size the default from the sitemap (all non-CMS pages + N samples per collection), report the page-set diff against the baseline in every report, and support pinning a baseline's page list for before/after comparisons.
6. **Instagram embeds not excluded as third-party.** 6d4e82fe: 22 `link-in-text-block` findings on two blog posts, link color `#00376b` vs text `#1c1e21` (Instagram's own styles) inside Instagram embeds (`blockquote.instagram-media` / its iframe). Extend the third-party matcher (same function as the GrowSurf fix, commit 2165340).
7. **Human verdicts do not carry forward.** `.new-cta-test` image (`alt=""`, decorative lifestyle photo in a CTA card) is flagged "informative" by the AI on 49 pages every scan. Persist review verdicts by cluster signature and apply them to later scans, so a reviewed false positive stays resolved.
8. **`truncated_tab_sweep` still fails 2.1.1.** Recorded as out of scope in NOTES.md after Fix 2: any finding fails its criterion during reconciliation. needs_review findings should leave the criterion `not_tested`, not `failed`.
9. **Empty-render guard.** On 2026-10-13 an unclosed `<style>` in head custom code (`/style>`) blanked every page in browsers (body held only footer scripts). The 8e03985c scan ran just before the break, so it did not see it. A scan during the break would have reported a large drop in findings, which looks like progress. Add a per-page sanity check (visible text length / landmark or section count vs baseline, or body with no rendered content) that raises a loud "page rendered empty" alert instead of fewer findings.

## Watch item (unresolved)

- **Skip link missing on 48 of 50 pages in 8e03985c** (`missing_skip_navigation` + axe `bypass`, 47 each). Live, the skip link is present on every page checked. The scan ran 03:06–03:13 UTC, around when the site owner was publishing CSS changes. Inferred: a publish mid-scan. If the next scan still misses it, investigate script timing (skip link is injected on DOMContentLoaded by a separate inline script).

## Acceptance for the next full scan (popfly.com, 75 pages)

- 0 contrast failures on the elements in the table under #1.
- No `broken_skip_navigation` on /start/new or /overland.
- No Top fixes row built from `<html>` summary findings.
- No `image_link_no_alt` on `a.header-logo-link` while the live link has a name.
