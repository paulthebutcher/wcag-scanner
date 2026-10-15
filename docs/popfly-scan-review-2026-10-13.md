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

## Resolution log (2026-10-14)

Work on branch `eval/phase1`, gated on the frozen corpus tuning-v4 (47 popfly.com pages). Pre-fix reference `replay-20261015T013504Z-5b7a06`; final run `replay-20261015T032725Z-bd7aa1`. Verifying scans (2026-10-14): `cd0f789b` and `3193607f` (pinned 50 pages) and `667305ae` (75 pages, `--include-noindex`).

| Item | Status | P2 id | Commit | Eval run | Verifying scan | Result |
|---|---|---|---|---|---|---|
| 1. Contrast before animations settle | Replaced (cause disproved) | P2-011 | 264d43f | replay-20261015T021053Z-225cfc | cd0f789b, 3193607f, 667305ae | The 37 failures were a broken render, not animations; pages that render broken are now not checked, no criterion passes, and the scan raises an ALERT. Offline on 8e03985c: 49 of 50 pages flagged; 0705da2d 0 of 50. Live: no render alert. The fix-1 contrast acceptance is blocked by P2-030 (the table's elements appear as axe incomplete results stored as definitive). |
| 2. Skip-link target rule | Fixed | P2-013 | 6190de2 | replay-20261015T031355Z-1eb75b | cd0f789b, 3193607f, 667305ae (partial) | A target after the header and navigation, at or before the first h1 or content section, passes (`#win`). Not exercised by tuning-v4 (`/start/new` excluded, `/overland` noindex); fixtures and the ee56b381 snapshots pass. P2-015 unchanged. Live: no `broken_skip_navigation` on `/start/new` (now `#main-content`); `/overland` not reached by any scan, so the `#win` rule is not exercised live. |
| 3. Page-level findings as one fix | Fixed | P2-014 | 56f7550 | unit tests + regenerated reports (report layer only) | report for cd0f789b | No Top fixes row from `<html>` summaries; 0705da2d lists 24 per-page fixes (2.8–6.1 h). |
| 4. Names read before scripts | Replaced (cause disproved) | P2-012 | 95e1b44 | replay-20261015T030044Z-477ab3 | cd0f789b, 3193607f, 667305ae | webflow.js labels the logo before the snapshot; the 49 findings came from regex extraction of markup inside the unclosed style. Raw-text contents are no longer read as elements (8e03985c: 240 phantom occurrences; 0705da2d: 0). |
| 5. Rotating page set | Open | P2-016 | — | — | — | Recorded in KNOWN_ISSUES.md. |
| 6. Instagram embeds not third-party | Open | P2-017 (with P2-023) | — | — | — | Recorded; the Instagram blog post is excluded from tuning-v4 until fixed. |
| 7. Verdicts not carried forward | Open | P2-018 | — | — | — | Recorded in KNOWN_ISSUES.md. |
| 8. `truncated_tab_sweep` fails 2.1.1 | Open | P2-019 | — | — | — | Recorded in KNOWN_ISSUES.md. |
| 9. Empty-render guard | Fixed | P2-011 | 264d43f | replay-20261015T021053Z-225cfc | cd0f789b, 3193607f, 667305ae | Delivered as fix 1's replacement. |
| Watch: skip link missing on 48 pages | Resolved (not a publish) | P2-011 | — | — | cd0f789b, 3193607f | The skip-link script found no target in the swallowed markup; same root cause as item 9. Live: skip link present on all 50 pinned pages; on the 75-page scan only `/fit-assessment` lacks one (see observations). |

### Post-merge scans (2026-10-14)

| Acceptance bullet | Result |
|---|---|
| 0 contrast failures on the fix-1 table elements | Blocked by P2-030: no element is measured failing, but `.c-green-h`, `.c-p-gray` and `.c-subtitle` on `/` and `/for-agencies` appear as axe incomplete results ("element contains an image node") stored as definitive/major. All 528 color-contrast findings in cd0f789b come from axe incomplete. |
| No `broken_skip_navigation` on `/start/new` or `/overland` | Pass for `/start/new`; `/overland` was not reached by any scan. The remaining rows are the P2-015 pattern on `/post/*`. |
| No Top fixes row built from `<html>` summaries | Pass (report for cd0f789b: 24 per-page fixes; the `html: insufficient navigation methods` row is the site-level allowlist). |
| No `image_link_no_alt` on `a.header-logo-link` | Pass in all three scans. |
| 1.4.3 difference between the pinned scans | 0 (definitive 1/1, undetermined 527/527). |
| Skip link on every page (watch item) | Pass on the 50 pinned pages (`bypass` 0, `missing_skip_navigation` 0); see `/fit-assessment` below. |
| No render alert | Pass (render_failed 0 in all three). |

Observations (registered, not fixed):

- `/local` `.footer-cr-center > div` ("© Popfly 2026 All Rights Reserved") has a 1:1 contrast ratio on `/local` only. It is not a visually-hidden pattern (no hiding class; identical markup on other pages); the text is invisible in the screenshot, i.e. the same colour as its background on that page (observed). The same screenshot shows a large empty area between the hero and the footer (observed; cause not checked).
- `/fit-assessment` has no skip link (`missing_skip_navigation` in 667305ae; observed). Site-side: the skip-link script did not add one on that page (cause not checked).
- Real contrast failures (observed, 667305ae): `/archive/pricing` list items `#9fb6a9` on `#286140`, 3.38:1 (3); `/fit-assessment` `.phase-label` `#6b7078` on `#0c0e10`, 3.88:1 (3) and white on `#2ea15a`, 3.3:1 (1); `/post/athletes-who-win-in-sport-and-storytelling-fishers` `#8b8c91` on white, 3.35:1 (3).
- Embed findings (observed, 667305ae): 22 `link-in-text-block` inside Instagram embeds on two posts and 41 `color-contrast` inside Instagram/TikTok embeds on two posts. Third-party (P2-017, P2-023).
- Pinned-scan differences: 29 rows only in cd0f789b and 24 only in 3193607f; 19 are the same element stored against a different canonical page (P2-005, observed); the rest are behavioral flakes (focus order, truncated tab sweep), model verdict variation on Tier 3 checks and 2 `image-alt` rows (inferred; not investigated).

### Corrections

1. **Item 9 timing: 8e03985c did not run before the break.** All 50 of its stored snapshots contain the broken `/style>` (observed). On 47 pages the swallowed text holds the `<body>` tag, the header and every section; their full-page screenshots are a blank 800 px viewport. `/` and `/for-agencies` lost the header and their top sections; `/start/new` lost only a `<style>` tag and rendered normally. The break was therefore live from at least 21:06 to 21:13 MDT and repaired by about 21:33, when 0705da2d started with no broken tag on any page. Its start is inferred to be one of the 20:14–21:04 blog-CSS publishes. [scan:8e03985c] [scan:0705da2d]
2. **Item 1 cause: not animations.** The 37 definitive contrast failures in 8e03985c are all on `/` (20) and `/for-agencies` (17), the two pages that rendered partly. They are accurate measurements of that broken render (the screenshot shows the recorded colours), not scanner false positives. On the healthy render 27 minutes later (0705da2d, same engine) none of these elements is a definitive failure; the 0705da2d set has 1 definitive and 527 undetermined. Live on 2026-10-14, `/` and `/for-agencies` had 0 definitive contrast failures at the crawler's capture point and 0 after a full scroll and settle (observed). The animation-settle hypothesis was not reproduced and has no defect entry.
3. **Item 4 cause: not snapshot timing.** webflow.js (`webflow.schunk` chunk, through jQuery `attr`) sets `aria-label="home"` on the logo link 5–12 ms after DOMContentLoaded on `/`, `/for-agencies` and a blog post, well before the crawler's snapshot (load plus network idle); the label is in all 50 snapshots of 0705da2d (observed). The 49 `image_link_no_alt` occurrences in 8e03985c came from the alt-text check reading the header markup inside the unclosed `<style>` with regular expressions (P2-012). The one `image_link_no_alt` in 0705da2d is the footer Instagram link on `/case-studies`, the only page whose copy of that link has no `aria-label` (inferred true positive).
4. **Watch item: not a publish mid-scan.** The skip-link script ran on every page but found no target (the header, `#main-content` and every section were inside the style text), so it added no link. `bypass` 47 → 0 and `missing_skip_navigation` 47 → 0 are the break and its repair. The snapshot and axe agree in both scans (axe runs on the same page load, after `page.content()`). The prompt's "7 of 50" snapshot count matched only `class="skip-link"`; 43 more pages have `class="skip-link w--current"`.
5. **Item 2 counts.** `broken_skip_navigation` on `/start/new` and `/overland` (target `#win`) is in ee56b381 only. In 6d4e82fe the two rows are on two `/post/*` pages with a different failure (focus not moved, target `#main-content`), registered as P2-015. By 6d4e82fe `/start/new` targets `#main-content`, and `/overland` was not crawled again until tuning-v1.
6. **Item 3 counts.** Cluster `79dc811ae6ad` spans 17 pages in ee56b381 and 20 in 6d4e82fe and 0705da2d; in 8e03985c it has 2 pages and no Top fixes row.
7. **Item 4 count.** 2 rows, 49 occurrences on 49 pages (48 pages plus `/` with `w--current`).
