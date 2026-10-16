# WCAG Engine Changelog

Unified from the supplied Claude chat reconstruction, all reachable repository history, read-only scan artifacts and matching local agent transcripts on 2026-10-12. Snapshot: main HEAD 86d750d; first commit 783f4b9 on March 3; timeline starts with the March 1 concept. [repo:783f4b9] [repo:86d750d] [chat:14115d46]

## Conventions

- **Date** is the local (America/Denver) date the source chat was last active. Work inside a long chat may have happened a few days earlier. Repo commit dates win on merge; scan times are initiated_at converted to Denver. [chat:14115d46] [repo:783f4b9]
- **Source tags:** `[chat:<id8>]` = Claude chat; `[repo:<short-sha>]` = commit; `[scan:<id8>]` = stored scan or explicitly identified historical scan; `[cc:<session-id8>]` / `[codex:<session-id8>]` = local Claude Code / Codex transcript; `[run:<run-id>]` = eval harness run (manifest under wcag-data/eval-runs, aggregate export under eval/runs). A tag identifies evidence, not a guarantee that its artifact survives locally. [chat:5dd53c0b] [repo:86d750d]
- **Status tags:** `shipped` = confirmed working in a later scan or test run (historical evidence, not a new test run here). `prompted` = fix prompt written and Paul reported running it, no later verification found. `planned` = proposed, no evidence it was built. Chat-only claims retain their reported status alongside any unresolved caveat; branch-only work is explicitly labelled. Observations/decisions/results may have no status. [chat:5dd53c0b] [repo:e78d715]
- **Epistemic labels:** (observed) stated in chat, (inferred) reading of evidence, (assumed) filled gap. `(no commit found)` preserves a claim/proposal with no matching implementation; `(commit not found)` would mark an explicitly attributed but absent hash. All five hashes in the Popfly chat exist. [chat:5dd53c0b] [repo:d0421be] [repo:9e2321a] [repo:849ebe0] [repo:60d9b45] [repo:53f87d5]
- **Merge rules:** one line per meaningful change, repo wording/date with all matched sources; independently meaningful parts of a bundled chat line are split. Numeric contradictions are retained as caveats, and plans are upgraded only where the repository proves the matching behavior. [chat:98edf333] [repo:f0e97b9]

Chat index:
| id8 | Title | Last active | Source |
|---|---|---|---|
| 14115d46 | Building a Webflow accessibility compliance tool | 2026-03-01  | [chat:14115d46] |
| 9ce63b91 | WCAG tool migration to Linear and Claude Code | 2026-03-09  | [chat:9ce63b91] |
| f67d0e54 | WCAG tool status and readiness | 2026-03-25  | [chat:f67d0e54] |
| a3d5e773 | Document readiness check | 2026-03-26  | [chat:a3d5e773] |
| 98edf333 | WCAG audit criteria mismatch | 2026-04-02 to 2026-04-16  | [chat:98edf333] |
| cb403267 | Before and after fixes comparison | 2026-04-03  | [chat:cb403267] |
| 607b026a | WCAG compliance for Lakewood Court file conversion | 2026-05-05  | [chat:607b026a] |
| 1d0bb3c3 | Prioritizing between Plinth, WCAG tool, and freelance work | 2026-05-06  | [chat:1d0bb3c3] |
| dc864a9a | Job search exploration | 2026-08-05  | [chat:dc864a9a] |
| 5dd53c0b | WCAG accessibility fixes (Popfly Project) | 2026-10-04 to 2026-10-13  | [chat:5dd53c0b] |

---

## 2026-10-15

### Fixed

- Third-party embed contents are listed for awareness, not counted. `config/third-party-embeds.json` names each vendor's containers (Instagram, TikTok, YouTube, Vimeo, X, GrowSurf); findings inside one are tagged `third_party` with the vendor (axe results inside an embed iframe by their frame), listed with details in the report's new "Third-party content" section per page and vendor, and left out of the main findings, severity totals, effort, Top fixes and criterion status. Container-level findings the site controls (iframe title) stay. The keyboard sweep steps over embeds (one stop per container, continues after it, counts the controls inside), reports an embed that keeps focus as `possible_embed_focus_trap` (2.1.2, needs review), and a sweep whose cycle closes before the page's last control is a `truncated_tab_sweep` (needs review) instead of per-control unreachable failures. Replay leaves tagged findings out of the identity comparison and counts them per repeat; p047 is back in the corpus (tuning-v5). Gates passed on tuning-v4 (176 keys reclassified, none removed) and tuning-v5 (190 reclassified; 14 `focus_order_mismatch` rows re-sampled by P2-036, not a detection change). Live (e6f7aa27, pinned 50 pages plus two embed posts): 0 unreachable findings on the fall-reel post (30 before), 299 rows listed as third-party, the embed iframes' 57 missing titles still reported, pinned-page rows 990 vs 995, 1.4.3 and 2.1.1 needs_review. The first verification scan (42407010) found one gap: an Instagram blockquote that embed.js had registered (class renamed to `instagram-media-registered`) but never rendered was not a container, so its placeholder text failed 1.4.3; the vendor list now matches that class and `data-instgrm-permalink`. P2-017, P2-023, P2-034. [repo:098dd72] [repo:f45a303] [repo:4b80ed5] [run:replay-20261016T003757Z-a16306] [run:compare-20261016T004948Z-6d030c] [run:replay-20261016T004954Z-fcb1d7] [run:compare-20261016T012602Z-885d85] [run:replay-20261016T032955Z-2e7486] [run:compare-20261016T034211Z-58581c] [scan:42407010] [scan:e6f7aa27] [cc:e8a46994] `shipped`
- axe "incomplete" results (axe could not decide, e.g. text over an image) are needs-review findings, not confirmed failures: counted separately from confirmed findings everywhere (CLI, summary, report, findings.md), and undetermined-background contrast checks are grouped per page and reason in the report. A criterion with only needs-review findings gets the new status needs_review and is never passed or failed on them; a truncated tab sweep no longer fails 2.1.1. Frozen gate passed (1.4.3 and 1.2.2 failed → needs_review; 493 predictions definitive → needs_review; no finding added or removed). Live: all 528 contrast findings needs_review, 1.4.3 needs_review, 494 confirmed / 531 needs review; the scan's total (1,025 vs 997) is outside the ±10 acceptance only because of 30 unrelated unreachable findings (P2-034). P2-030, P2-019. [repo:951a4a0] [run:replay-20261015T230944Z-7f0f3b] [run:compare-20261015T232120Z-572b81] [scan:782f7078] [cc:e8a46994] `shipped`

### Results

- Lakewood delivered-report scan 1a6e3c3e (2026-05-20) has no axe findings, so no incomplete result was stored as a failure; 1.4.3 passed with 122 elements tested. The delivered report is not affected by P2-030. (observed)

### Known issues

- The report's criterion list has 51 entries (the 50 WCAG 2.1 A/AA criteria plus 1.3.6, which is AAA). P2-032, not fixed. (observed) [repo:72fe14b]
- A keyboard sweep that ends in a focus cycle inside a third-party iframe is not treated as truncated, so the controls after the embed are reported unreachable (definitive, critical) and 2.1.1 fails: 30 such findings on one blog post with Instagram embeds. P2-034, not fixed. (observed) [scan:782f7078]
- Focus-order positions are viewport-relative boxes read right after each Tab, so on a smooth-scrolling site (popfly.com) a stop beyond the first viewport is sampled mid-scroll and `focus_order_mismatch` depends on round-trip timing: the embed step-over's extra evaluate per stop moved 14 such rows on tuning-v5, two of them on pages with no embed (p004, p017: identical sweeps, different focus-order result). Two candidate fixes recorded (page coordinates after the scroll settles; `scroll-behavior: auto` injected during the sweep, to be checked against the skip-link check first). P2-036 (P2-027, P2-029 likely symptoms), not fixed. (observed; cause inferred) [run:compare-20261016T012602Z-885d85]
- False pass: when every finding for a criterion is filtered from the client report as possibly noisy, the report turns a failed criterion into a pass (since f0e97b9). needs_review criteria are protected from this since P2-030. P2-033 (related P2-010), not fixed. (observed) [repo:f0e97b9]

## 2026-10-14

### Observations

- `/local`: the footer copyright line has a 1:1 contrast ratio (same colour as its background on that page only; not a visually-hidden pattern), and the page shows a large empty area between the hero and the footer (cause not checked). (observed) [scan:cd0f789b]
- `/fit-assessment` has no skip link. (observed) [scan:667305ae]
- Real contrast failures: `/archive/pricing` list items 3.38:1; `/fit-assessment` `.phase-label` 3.88:1 and a white-on-green label 3.3:1; `/post/athletes-who-win-in-sport-and-storytelling-fishers` text 3.35:1. (observed) [scan:667305ae]
- Instagram and TikTok embeds produce 22 `link-in-text-block` and 41 `color-contrast` findings on blog posts (third-party; P2-017, P2-023). (observed) [scan:667305ae]
- The two pinned scans differ in 29 and 24 finding rows; 19 are the same element stored against a different canonical page (P2-005); the rest are behavioral flakes and model verdict variation (inferred). (observed) [scan:cd0f789b] [scan:3193607f]

### Results

- Post-merge acceptance: no render alert; `bypass` and `missing_skip_navigation` 0 on the pinned pages; no logo-link `image_link_no_alt`; no Top fixes row from page-level summaries; 0 differing 1.4.3 findings between the pinned scans (definitive 1/1, undetermined 527/527). The fix-1 contrast bullet is blocked by P2-030; `/overland` was not reached, so P2-013's `#win` rule is not verified live. (observed) [scan:cd0f789b] [scan:3193607f] [scan:667305ae]

### Known issues

- axe incomplete results are stored as confirmed failures (definitive, severity from axe impact, triage fix_now) and fail their criterion: all 528 color-contrast findings in cd0f789b, plus `video-caption` and `form-field-multiple-labels`. Same as seed SL-008 (Lakewood, March); Lakewood scans from 2026-03-25 to 2026-04-03 store 2 such findings each as Major (inferred report impact). P2-030, not fixed. [scan:cd0f789b] [chat:a3d5e773]
- The crawler follows links inside hidden elements (`display:none` via a `hide` class, `hidden`, `aria-hidden` containers), so a scan can audit pages users cannot reach: 73 of 75 pages in 667305ae link `/archive/pricing` only through a hidden mobile-menu link. P2-031, not fixed. (observed) [scan:667305ae]
- Correction: the `/archive/pricing` contrast failures listed under Observations come from a noindex page that entered 667305ae only because of `--include-noindex`, reached through hidden links (one visible path: the older footer on `/schedule-a-demo`). They are site observations, not default-scan results. (observed) [scan:667305ae]

## 2026-10-13

### Observations

- Site-side changes verified live 2026-10-11 to 2026-10-13: skip link injected by script as the first body element (target the first element after `.header-wrapper`, `tabindex="-1"`); `.btn.modal` divs get `role="button"` and `tabindex="0"`; FAQ items get `role="button"`, `aria-expanded` and `inert` closed answers; the demo modal is a dialog with focus moved in, trapped, Escape and return; cookie link text "Opt out here."; `.p-gray-large` colour `#aeafb0` replaces opacity 0.7; blog rich-text links `#286140`; "Learn more" `c-btn` links removed after 6d4e82fe. (observed) [chat:5dd53c0b] [scan:6d4e82fe]
- The crawl page set rotates under the 50-page cap: about 54 static pages plus CMS samples against 168 sitemap URLs; 11 pages differed between ee56b381 and 6d4e82fe. (observed) [chat:5dd53c0b] [scan:ee56b381] [scan:6d4e82fe]
- Blank-site incident: a `/style>` typo (missing `<`) in head custom code left a `<style>` unclosed and every page rendered blank or broken in browsers. The break was live during scan 8e03985c, 21:06–21:13 MDT (all 50 snapshots contain the broken `/style>`; 47 screenshots blank), and fixed by about 21:33, when 0705da2d started clean (observed). The chat timeline placed it after 21:13; the stored snapshots win. Its start was probably one of the 20:14–21:04 blog-CSS publishes (inferred). [chat:5dd53c0b] [scan:8e03985c] [scan:0705da2d]
- Contrast review: the 37 definitive contrast failures in 8e03985c were accurate measurements of the broken render, not scanner false positives; none fails on the healthy render (0705da2d) or live after settling. (observed) [chat:5dd53c0b] [scan:8e03985c] [scan:0705da2d]

### Fixed

- Pages that render broken or blank are detected on the crawl's own load and not checked; every check is recorded failed on them, no criterion can pass, and the scan and report raise an ALERT with the page list. Replaces review fix 1 (animation settle), whose cause was disproved. Frozen acceptance passed; post-merge scans show no render alert. The review's fix-1 contrast acceptance is blocked by P2-030, not by this fix. docs/popfly-scan-review-2026-10-13.md, P2-011. [repo:264d43f] [run:replay-20261015T021053Z-225cfc] [scan:cd0f789b] [scan:3193607f] [scan:667305ae] [cc:e8a46994] `shipped`
- Checks that read the serialized DOM no longer treat markup inside `<style>`, `<script>`, `<noscript>` or `<template>` as elements (one helper used by every such check). Replaces review fix 4 (names read before scripts), whose cause was disproved. Frozen acceptance passed; post-merge scans have no logo-link `image_link_no_alt`. docs/popfly-scan-review-2026-10-13.md, P2-012. [repo:95e1b44] [run:replay-20261015T030044Z-477ab3] [scan:cd0f789b] [scan:3193607f] [scan:667305ae] [cc:e8a46994] `shipped`
- The skip-link check accepts a target placed where main content starts (after every header and nav focus stop, at or before the first h1 or content section), e.g. `section#win`. Frozen acceptance passed (fixtures and stored ee56b381 snapshots). Post-merge: no `broken_skip_navigation` on `/start/new`, but it now targets `#main-content` and `/overland` was not reached, so the new rule is not yet exercised live; 667305ae's `/overlanding` is a different page, with skip target `#main-content`. docs/popfly-scan-review-2026-10-13.md, P2-013. [repo:6190de2] [run:replay-20261015T031355Z-1eb75b] [scan:cd0f789b] [scan:3193607f] [scan:667305ae] [cc:e8a46994] `prompted`
- Page-level summary findings (focus order on `<html>`) cluster per page and are listed under "Per-page fixes" instead of one Top fix; site-level findings stay grouped. Report layer only. Frozen acceptance passed (regenerated reports); the report for cd0f789b has no Top fixes row from page-level summaries and 24 per-page fixes. docs/popfly-scan-review-2026-10-13.md, P2-014. [repo:56f7550] [scan:cd0f789b] [cc:e8a46994] `shipped`
- `wcag scan --urls <file>` scans a pinned page list (before/after scans of the same pages); used for the post-merge pinned scans. [repo:8913736] [scan:cd0f789b] [scan:3193607f] [cc:e8a46994] `shipped`
- Eval harness, first real-site corpus: capture scroll pass and per-site page cap; provisional labels; `static --record` reaches the model API; declared exclusions v2 (beacons, embed internals, media); deny-proxy socket errors; replay randomness seeded per calling script (Math.random and crypto); `derive-corpus` and `supplement-corpus`; variation logged per run instead of appended to the defect file; pre-commit privacy check of staged exports. (observed) [repo:36f420a] [repo:8e07099] [repo:4054e19] [repo:bf43f80] [repo:e49f11f] [repo:6981638] [repo:51e5605] [repo:c3df176] [repo:12bd16b] [repo:9796c41] [cc:e8a46994] `shipped`

### Results

- Frozen corpus tuning-v4: 47 popfly.com pages from the tuning-v1 capture (51 pages, 21.3 min, 3 s pacing), 4 pages excluded for per-load variation (P2-021, P2-022, P2-023), one supplemented asset (one live request). Pre-fix reference and final run each 3 repeats with 0 HAR, image and cache misses, 0 egress and identical non-behavioral results. Final gate exit 0: one focus-order flake swapped, no other change; static set unchanged (30 pass, 7 fail as before). (observed) [run:capture-20261014T223021Z-db47cc] [run:replay-20261015T013504Z-5b7a06] [run:replay-20261015T032725Z-bd7aa1] [run:compare-20261015T040242Z-1816bd]
- Frozen deltas are zero for P2-011, P2-012 and P2-013 by design (no tuning page renders broken, no rendered phantom on healthy pages, the `#win` pages are excluded or noindex); their acceptance is shown on stored scans: 8e03985c 49 of 50 pages flagged render-failed and 240 phantom finding occurrences removed; 0705da2d 0 and 0; both ee56b381 `#win` pages pass offline. P2-014: 0705da2d Top fixes lose the `html: focus order mismatch` row; 24 per-page fixes (2.8–6.1 h); headline unchanged. (observed) [scan:8e03985c] [scan:0705da2d] [scan:ee56b381]
- Reconciliation 8e03985c vs 0705da2d: every difference is the site break and its repair, not engine nondeterminism (bypass 47 → 0, contrast 85 on 3 pages → 528 on 45 pages, image-alt, frame-title and link-in-text-block present only once pages rendered). (observed) [scan:8e03985c] [scan:0705da2d]
- Model spend for this work: $4.76 of the $10.00 cap (HEAD records $1.36, baseline records $2.93, static cache $0.47). The baseline cache predates per-script seeding and is stale; D6 is deferred. (observed) [run:record-20261014T233843Z-b10cba]

### Known issues

- Rotating page set (P2-016), Instagram embeds not third-party (P2-017, with P2-023), review verdicts not carried forward (P2-018), needs-review `truncated_tab_sweep` failing 2.1.1 (P2-019) and skip links reported broken when focus moves late (P2-015) remain open; see KNOWN_ISSUES.md. [chat:5dd53c0b] [cc:e8a46994]
- The watch item (skip link missing on 48 pages in 8e03985c) is resolved: not a publish mid-scan but the same break (P2-011). [scan:8e03985c]
- Prompts can differ per load (P2-020 volatile page text, P2-021 hidden-input values, P2-022 error-message prompt from the page head), so AI verdicts can vary between scans; with /insights, /jobs/head-of-gtm and /start/new excluded, the tuning corpus has no form-submission or error-message coverage (3.3.1, 3.3.3, 3.2.2) until P2-021 and P2-022 are fixed. [cc:e8a46994]

## 2026-10-12

### Added

- Chat-derived eval/seed-labels.jsonl preserves 18 Lakewood labels. No eligible local-transcript findings or human_review verdicts can be appended; Popfly findings are excluded and Lakewood scan/finding references remain unresolved in the current Popfly-only store. [chat:f67d0e54] [chat:cb403267] [chat:98edf333] [codex:01a131fd] `shipped`
- Phase 1 eval harness (`wcag eval`, src/eval): run manifests with dirty-tree refusal for official runs, privacy rules and a committed-export test, eval/config.json with coverage notes for all 50 WCAG 2.1 A/AA criteria. [repo:a72248f] [repo:91eb47b] `shipped`
- Offline transport boundary: one controlled browser for every engine context, page, reload and popup (blocked service workers, submission containment, HAR replay, engine `route.continue()` turned into fallback, WebSockets refused, deny-and-log proxy), recorded Node fetches with socket denial, and an eval model client with an immutable response cache and image-store check. Baseline runs through a worktree bridge (adapter plus a two-hunk transport patch, sha256 6f224841…). One eval-only scanner hook, default off. [repo:b921a95] `shipped`
- Capture, corpus verification, replay/record with budget and repeatability, cases/labels/matcher, review and blind audit screens with pace, metrics and aggregate export, Lakewood static set, compare/gate and reference export, municipal admission. [repo:513fe47] [repo:67c0256] [repo:def7e96] [repo:4e6472e] [repo:0c4dc84] [repo:34534e5] [repo:e4ee5dd] `shipped`

### Results

- D0 pilot on the local fixture, clean tree at 52bfd6c: 37/37 checks; HEAD and baseline replay offline with 0 HAR, Node-fetch, image and cache misses and 0 egress; GET-form, POST, fetch, XHR and beacon submissions contained live and offline with 0 fixture submission hits; trap misses, declared exclusions and WebSockets detected; default path identical to pre-harness 5d7a467 (62 findings, 48 criterion statuses, 78 coverage entries, no diff). [repo:52bfd6c] [run:pilot-20261013T011517Z-e56772]
- Lakewood static set: 18 seeds resolved to 44 cases (37 runnable, 3 unresolved, 3 scan level, 1 requiring rendering); new disputes SL-003 and SL-013. With an empty static cache, clean tree at 91eb47b: head 29 pass / 3 fail / 5 unavailable, baseline 30 / 3 / 4; replays identical; synthetic SL-001 passes at both. [repo:0c4dc84] [run:static-20261013T012446Z-674fb3] [run:static-20261013T012705Z-4d5436]

- History reconciliation covers 88 implementation commits through snapshot HEAD 86d750d and all 12 main-folder scan directories. Every timeline line has provenance; original chat and repo working halves are merged into this file. Seed JSONL parses and excludes Popfly; unavailable Lakewood ids remain unguessed. [codex:01a131fd] [repo:86d750d]

### Known issues

- Static set: the duplicate-link rule still flags a self-describing navigation link at HEAD and the baseline (LS-012, LS-014; P2-009), and a throwing model-based check still lets 1.1.1, 2.4.4, 1.3.5 and 3.3.4 pass at both versions (SL-016 synthetic; P2-010). Logged in eval/phase2-defects.jsonl, not fixed in Phase 1. [run:static-20261013T012446Z-674fb3] [run:static-20261013T012705Z-4d5436]

### Planned

- Eval harness: frozen snapshots, ACT/BAD known-answer pages, public Webflow and municipal CMS corpus, seeded-defect recall tests, Paul labels, calibrated per-criterion LLM judge, precision/recall scorecard and nightly loop; 70/30 tune/report split. Originating chat id was omitted in the supplied reconstruction; recorded here from the provided artifact. (no commit found) [codex:01a131fd] `planned`

## 2026-10-11

### Added

- Remediation estimates cost fix units once per site, class, colour, component, copy item or page, with QA, manual review and coordination line items and advisory fixes separate. CLI, reports, Top fixes and findings.md share the model; reference estimate ~2,949 h to ~27–47 h. [repo:95da8a2] [cc:e8a46994] `shipped`

### Changed

- Embedded-frame findings are excluded as third-party content, avoiding estimate inflation and unstable verification additions. [repo:95da8a2] `shipped`

### Fixed

- Skip-link checks poll up to 1.5 s for delayed focus on or inside the fragment target, replacing the 100 ms wait; commit/transcript report 50 false page occurrences on 0b7d5e28 (chat says 48; unresolved count difference). [repo:7494e90] [chat:5dd53c0b] [cc:e8a46994] [scan:0b7d5e28] `shipped`
- Truncated tab sweeps record exit reason, last focus and candidate count, retry once after reloading, then emit one needs-review note and partial coverage instead of false unreachable findings (39 in 0b7d5e28; 40 in 4d008e9e). The retry was verified in fixtures; the intermittent failure did not reproduce in nine keyboard-only live sweeps. [repo:ac0d0f8] [chat:5dd53c0b] [cc:e8a46994] [scan:0b7d5e28] [scan:4d008e9e] `shipped`
- Widget ARIA receives the whole element’s accessible name, suppresses name/role/focus failures contradicted by deterministic checks, and ignores missing aria-expanded on modal openers. Uncertain verdicts stay needs-review and out of Top fixes/counts. Stored-answer replay removes spurious button findings without a live rescan. [repo:95dcb0c] [chat:5dd53c0b] [cc:e8a46994] [scan:0b7d5e28] [scan:4d008e9e] `shipped`
- GrowSurf detection now recognises data-grsf-* attributes, grsf- ids/classes in selector ancestors, and GrowSurf resource URLs; three images (144 occurrences) move from Top fixes into Third-party on stored scan 0b7d5e28. [repo:2165340] [chat:5dd53c0b] [cc:e8a46994] [scan:0b7d5e28] `shipped`
- Cluster signatures retain element text only for alt, link and heading content failures; structural failures hash the opening tag. Stored FAQ findings in 4d008e9e collapse from 17 clusters to one; all clusters 254 to 123 (0b7d5e28: 239 to 130). [repo:86d750d] [cc:e8a46994] [scan:4d008e9e] [scan:0b7d5e28] `shipped`

### Decisions

- Popfly findings are engine-tuning data and excluded from eval/seed-labels.jsonl. [chat:5dd53c0b]
- Coding-agent prompts follow anti-drift rules: extend existing code (`review.ts` verdicts, `test/fixtures/metadata.json`), no out-of-scope refactors, commit per phase with typecheck, lint and tests green, notes in `NOTES.md`. (no commit found) [chat:5dd53c0b] [cc:e8a46994]

### Known issues

- Clustering over-merges page-level findings (17 pages of focus-order mismatch grouped as one fix because they attach to `<html>`); tag-only grouping may also merge unrelated `<a>` links (inferred). [chat:5dd53c0b] [repo:86d750d]
- Skip-link check only accepts targets named like `main` / `#main-content`; /start/new and /overland use `#win` and work. [chat:5dd53c0b] [repo:7494e90]
- A needs-review finding marks its criterion failed, so one truncated sweep fails 2.1.1 for the client. Should count as not tested. [chat:5dd53c0b] [repo:ac0d0f8]
- Custom-interactive check only matches divs carrying `data-w-id`, so it misses copies of the same button (observed on 2 of 4 homepage CTAs). [chat:5dd53c0b] [repo:95dcb0c]

### Results

- Popfly full-scan series (50 pages): e779c8b0 (Oct 4) 1,342; 8b301074 (Oct 10) 963; 46bcdc42 (Oct 10) 964; 4d008e9e (Oct 11) 994; 0b7d5e28 (Oct 11) 984; final ee56b381 (Oct 11) 830. Definitive contrast 187 to 9 is chat-reported; mixed site/engine/coverage changes prevent treating the total reduction as engine precision. [chat:5dd53c0b] [scan:e779c8b0] [scan:8b301074] [scan:46bcdc42] [scan:4d008e9e] [scan:0b7d5e28] [scan:ee56b381]
- The final five scanner fixes reported typecheck, lint and 1,305 tests green, up from 1,288; historical test evidence only, no suite or live scan run for this documentation task. [chat:5dd53c0b] [cc:e8a46994] [repo:86d750d]
- Popfly engine-change cycle: before 0b7d5e28 (20:10 MDT, 984 findings) → after ee56b381 (20:47 MDT, 830), after the five 20:27–20:41 fixes. Same target and 50-page manifests; code-version association is (inferred) from commit/scan chronology because manifests omit commit hashes; changing model answers and DOM still confound total counts. [scan:0b7d5e28] [scan:ee56b381] [repo:7494e90] [repo:ac0d0f8] [repo:95dcb0c] [repo:2165340] [repo:86d750d]
- Popfly scan-review cycle: 4d008e9e (994 findings) → 0b7d5e28 (984), both before the five evening fixes, exposed truncated sweeps, modal-name contradictions and GrowSurf/clustering issues; diagnosis used stored results, followed by the separate engine-change cycle. [scan:4d008e9e] [scan:0b7d5e28] [cc:e8a46994] [repo:ac0d0f8]

## 2026-10-10

### Added

- ESLint flat config parses TypeScript sources so npm run lint runs; stricter recommended rules remain deferred. [repo:9e2321a] [chat:5dd53c0b] [cc:e8a46994] `shipped`
- Per-check/page coverage records ran / failed / skipped with reasons in coverage.json and report sections; deduplicated findings retain full page lists, unique-element and occurrence counts. Crawler also records pages it could not load. [repo:849ebe0] [chat:5dd53c0b] [cc:e8a46994] `shipped`
- Top fixes clusters deterministic element signatures and ranks occurrences cleared per change; unmeasurable contrast goes to Needs manual check and GrowSurf to Third-party, outside failure counts. Finding-specific Webflow fixes cover contrast (computed passing replacement), custom_interactive_no_role, no_visible_focus_indicator and aria-prohibited-attr. Reference report cover 1,301 to 673. [repo:60d9b45] [chat:5dd53c0b] [chat:98edf333] [cc:e8a46994] `shipped`
- `wcag verify --baseline <id> [--cluster <id> ...] [--all]` rescans selected cluster URLs/checks, links the normal rescan through baseline_scan_id, and reports fixed / still broken / newly broken / not verified by cluster and page in verify.md, verify.json and HTML. Tests reported 1,230 to 1,277 across the coverage/Top fixes/verify phases. [repo:53f87d5] [chat:5dd53c0b] [cc:e8a46994] `shipped`

### Fixed

- Focus checks use real Tab presses with recorded script-focus fallback, wait for entrance/focus animations, and capture focus before blur; hidden/clipped focus gets its own failure type and Webflow fix, native replacement controls get focus-within advice, cross-origin embeds are skipped. Most of the earlier 112 footer false findings came from stale crops already fixed in 1f72a1f; script focus matters after mouse interaction. [repo:d0421be] [chat:5dd53c0b] [cc:e8a46994] `shipped`

### Results

- Popfly site-change verification cycle: before e779c8b0 → after 69271047, linked by baseline_scan_id; selected axe-core/widget-ARIA checks cover 50 pages, contrast #286140 174 → 0 and div.btn.modal 49 → 0. Stored verify.json marks both clusters fixed; 12 new issues were attributed in the transcript to dynamic embeds/AI naming/review notes, not demonstrated site regressions. [chat:5dd53c0b] [scan:e779c8b0] [scan:69271047] [repo:53f87d5] [cc:e8a46994]
- Popfly site-change/review cycle: before e779c8b0 (Oct 4, 1,342) → after 8b301074 (963) and 46bcdc42 (964). Transcript reports role/tabindex and contrast site fixes; the scanner repository does not contain the site-edit commits. Keep attribution distinct from the simultaneous engine fixes. [scan:e779c8b0] [scan:8b301074] [scan:46bcdc42] [cc:e8a46994]

## 2026-10-04

### Added

- README documents the engine, architecture, CLI tools and scan limitations. This is the first README addition in available history (October 4); chat reports one on March 26 without a matching earlier commit. [repo:ffdcd30] [cc:e8a46994] `shipped`
- Per-phase and per-prompt timing/cache/token statistics are written to timings.json and printed; docs/speed-accuracy-plan.md records implementation status and measured comparisons. [repo:27fe24a] [cc:e8a46994] `shipped`

### Changed

- Crawler uses load plus capped idle wait (initially 5 s), four-page concurrency, queue dedup, shared-template CMS sampling and root redirect normalisation; axe runs during crawl, behavioral pages run in parallel, and semantic evaluation overlaps other tiers. [repo:27fe24a] [cc:e8a46994] `shipped`
- One global prompt runner caches identical inputs, honours concurrency, backs off on rate/server errors and stops retrying invalid 4xx requests; alt-text prompts receive images, and WCAG_MODEL_SONNET / WCAG_MODEL_OPUS override model ids. [repo:27fe24a] [cc:e8a46994] `shipped`

### Fixed

- Untested heuristic passed/not-applicable stamps become not_tested; four unwired semantic prompts remain unwired. [repo:27fe24a] `shipped`
- Tab recording uses ids only when unique and tolerates repeated iframe focus, avoiding false early cycles; live checks removed 146 false unreachable findings across eight Popfly pages. [repo:06cf882] [cc:e8a46994] `shipped`
- Only empty/non-descriptive headings (2.4.6) and body text marked as headings (1.3.1) fail; skipped levels/multiple h1/long or missing headings become best-practice annotations. Acceptable hedged semantic verdicts pass; decorative empty-alt images in named role-based controls skip evaluation. Idle cap increases to 15 s for late widgets. [repo:f6389d6] [cc:e8a46994] `shipped`
- Focus screenshots use fresh bounds after scrolling elements to viewport centre, removing 31 false /insights findings in a live check; semantic cross-page dedup extends to 1.3.1, 2.4.6 and 4.1.2 by exact element HTML. [repo:1f72a1f] [cc:e8a46994] [scan:e779c8b0] `shipped`

### Removed

- Example environment file removed and ignore rules tightened after exposed-key cleanup; Paul reported key rotation. Historical transcript describes repository setup, not a new scan-engine feature. [repo:561cfe7] [cc:e8a46994] `shipped`

### Results

- Popfly performance cycle: before 7033a623 (13m 51s, 1,619) → after d391ed89 (4m 3s, 1,506); both had failed Claude API calls, so the 3.4× comparison excludes successful LLM time. Forty-two pages overlap and 13 untested criteria become not_tested. [scan:7033a623] [scan:d391ed89] [repo:27fe24a] [cc:e8a46994]
- Popfly working-key comparison: before 1d4f7d24 (48m 42s, 1,543) → after ba241ce6 (6m 46s, 1,430), run concurrently. Review found 146 false unreachable findings, cookie-banner animation noise, hedged alt verdicts and late widgets; fixes are 06cf882/f6389d6. [scan:1d4f7d24] [scan:ba241ce6] [repo:06cf882] [repo:f6389d6] [cc:e8a46994]
- Popfly isolated comparison: before 77a43f3b (44m 55s, 1,549; transcript/docs only, baseline worktree data absent from the main store) → after e779c8b0 (6m 37s, 1,342). Review then found stale focus crops and repeated heading/widget findings; 1f72a1f fixes them after this scan, without a stored full post-fix scan that day. [scan:77a43f3b] [scan:e779c8b0] [repo:1f72a1f] [repo:27fe24a] [cc:e8a46994]

### Planned

- Speed-plan work still deferred: multi-element prompt batching, browser candidate extraction, structured outputs, worked examples/second verification, high-risk-form screenshots, wiring four unused prompts and golden-set precision/recall runner. The later check registry supports verification (Oct 10), not a full scheduler. [repo:27fe24a] [repo:53f87d5] `planned`

## 2026-10-03

### Fixed

- better-sqlite3 upgrades to v12 for Node 24 prebuilt binaries after the move to ~/Developer/WCAG Scanner; package remains wcag-engine. [repo:9e3b5fc] [cc:c874ed56] `shipped`

## 2026-10-02

### Results

- Popfly scan a518b4a6 has 968 findings at https://popfly.com (36 pages per transcript), followed by 7033a623 on Oct 4 at www.popfly.com (50 pages). Only 14 pages overlap; redirect/sitemap selection explains most count changes. October 2 date is transcript-supported, while exact creation time is unavailable because the session is absent from SQLite. [scan:a518b4a6] [scan:7033a623] [cc:e8a46994] [cc:d53e75c3]

## 2026-09-23

### Changed

- Forms are fingerprinted and interaction-tested once per unique form, with cross-page annotations; hidden fields skip interaction, no visible forms means 3.3.1/3.3.3/3.2.2 not_tested, and form action timeouts become 5 s. Browser contexts get a __name shim and Webflow checkbox-overlay handling. [repo:f07b430] [cc:d53e75c3] `shipped`

### Fixed

- Focus-ring contrast uses perimeter/p90, thickness and fill change; semantic alt/link findings deduplicate across pages, relative duplicate-link URLs resolve against page URL, named-link decorative images skip LLM evaluation, Webflow navbars satisfy Multiple Ways, and focus-order evidence records divergence. [repo:0b8a985] `shipped`

### Known issues

- Forms hidden at page load (modal/panel/third-party widget) are not submission/on-input tested; DOM input-purpose/high-risk checks still run. Trigger discovery to open the container is a possible follow-up, not shipped. [repo:f07b430]

### Results

- Popfly review prompted unique-form testing after an interrupted scan f6f39209 never reached Tier 5/reconciliation; a separate September reference PDF 9810857f covered 41 pages. No stored after-scan id for the form-speed fix is established; later Oct 4 baselines use different coverage and cannot isolate this change. [cc:d53e75c3] [cc:e8a46994] [scan:f6f39209] [scan:9810857f] [repo:f07b430]

## 2026-08-05

### Decisions

- Engine positioned as the productized revenue line; legal exposure handled via contract language that reports technical conformance findings and avoids legal compliance conclusions, plus insurance and attorney review. (observed) (no commit found) [chat:dc864a9a]
- Recommended a direct comparison test of engine output against manual testing before scaling sales. (observed) Not run as of this file. (no commit found) [chat:dc864a9a] `planned`
- The strategy chat cited Title II deadlines of April 26, 2027 (50,000+) and April 26, 2028 (smaller entities). Historical context only; the March Codex transcript cited different dates, and no present legal-date determination is made here. [chat:dc864a9a] [codex:019fd366] [codex:019d25b9]
- Codex strategy discussion broadened the proposed municipal ceiling from 50k to 125k, retained Webflow-only remediation scope, and explored preferred/white-label agency partnerships. These are historical business options, with no implementation or contract demonstrated. (no commit found) [codex:019fd366]

## 2026-05-06

### Added

- Findings review UI designed in Claude Design using the Lakewood findings JSONL as fixture: 76 findings, 16 pages, 44 `claude_api` / 32 `playwright`. Triage-first master-detail layout, top filter bars, "Start here" card with shared-component leverage, findings grouped by failure type. Intended for Lakewood delivery and a paulb.pro prototype. (design done; build status unknown) (no commit found) [chat:1d0bb3c3] `planned`

### Known issues

- Confidence semantics undefined in UI: rule-based confidence is hardcoded per rule; LLM confidence is self-reported and poorly calibrated. Open question. (no commit found) [chat:1d0bb3c3]

## 2026-05-05

### Decisions

- PDF/.docx remediation for Lakewood's 22 court forms outsourced to a vendor; not built into the engine. (no commit found) [chat:607b026a]

### Planned

- Document inventory + PDF/UA basics scoring (crawl, find PDFs/Word docs, score tagged/title/lang/labeled fields). Parked. (no commit found) [chat:607b026a] `planned`

## 2026-04-24

### Added

- Noindex exclusion recognises robots/googlebot meta and X-Robots-Tag, follows outbound links, stores excluded_pages and displays exclusions in scan scope; --include-noindex restores coverage. Webflow internal site-search exclusion has no detectable public signal. [repo:cc95a8e] `shipped`

## 2026-04-22

### Fixed

- Skip-nav candidate discovery enumerates early keyboard-reachable elements in DOM order and focuses a candidate before Enter, eliminating polluted-focus-anchor false missing_skip_navigation findings on Lakewood Court. [repo:a73b984] `shipped`

## 2026-04-17

### Fixed

- Keyboard reachability checks Playwright visibility and hidden/inert/aria-hidden/disabled ancestors plus tabindex, removing false desktop findings on hidden mobile navigation. [repo:3b79f96] `shipped`
- Tab recorder resets the autofocus anchor with Shift+Tab and continues through body focus until a true revisit/cap; Lakewood /court-docket-search password field and pre-anchor /contact controls were false unreachable findings. [repo:02de1e2] `shipped`

## 2026-04-16

### Added

- Verbose per-finding Markdown plus findings.md/findings.jsonl keep every triage bucket (Fix now / Verify manually / Possibly noisy / Advisory), evidence, model inputs/outputs and remediation through buildLlmCapture. This supplies capture, not the chat’s proposed PromptLogger wiring in scanner/analyzer. [repo:f0e97b9] [chat:98edf333] `shipped`
- Chat proposed PromptLogger wiring through scanner.ts/analyzer.ts for llm_input/llm_output. The April implementation instead uses buildLlmCapture; per-prompt timing/logger wiring in the scanner lands October 4. The exact claimed wiring in both files is not found. (no commit found) [chat:98edf333] [repo:f0e97b9] [repo:27fe24a] `prompted`

### Changed

- B1: client HTML/PDF excludes possibly-noisy findings and recomputes counts, effort, diff and criterion status; a criterion with only filtered findings becomes no issues detected. [repo:f0e97b9] [chat:98edf333] `shipped`
- B4: 3.3.4 Error Prevention skips forms with purpose search/login/subscribe/contact; requires 2+ distinct legal/financial signals to flag. (no commit found) [chat:98edf333] `prompted`

### Fixed

- B2: Multiple Ways is advisory; B3: named landmark nav links of at least three characters auto-pass unless generic; B5: valid type-compatible autocomplete tokens skip API evaluation and pass. [repo:f0e97b9] [chat:98edf333] `shipped`
- Empty shell environment values allow dotenv to supply configured values. [repo:f0e97b9] `shipped`

### Decisions

- Two outputs by design: clean client report (noisy findings filtered out entirely) and a full internal dump. Rationale: litigation risk for municipal clients. [chat:98edf333] [repo:f0e97b9]
- Developer tooling split from accuracy fixes and deferred. (no commit found) [chat:98edf333]
- Lakewood report delivered to client (Court Administrator) with a casual direct email. (no commit found) [chat:98edf333]

## 2026-04-03

### Added

- Alt-text pre-filter skips clearly acceptable non-empty descriptions (5–250 characters, excluding filenames/generic/placeholder text); chat reports 1.1.1 findings 102 to 16. [repo:83944e5] [chat:cb403267] `shipped`
- ScanSession detection_manifest records engine/axe versions, disabled rules, active tiers/checks and API-key presence; full autocomplete token list added to the input-purpose prompt. [repo:83944e5] [chat:cb403267] `shipped`

### Changed

- Chat reports replacing 516 Playwright duplicate-link instances with 40 Claude Ambiguous Without Context findings. Available history retains runDuplicateLinkChecks with detected_by=playwright; no replacement commit is found. Preserve this as an unresolved chat claim. (no commit found) [chat:cb403267] [repo:d4c7423] [repo:0b8a985] `shipped`

### Fixed

- When API evaluation is unavailable, attempted-versus-violated tracking avoids false passed criteria; per-criterion severity floors make confidence promote only, and tested_by reflects the actual detector. [repo:83944e5] [chat:cb403267] `shipped`
- DOM capture waits for network idle to retain JS attributes, and dotenv override handling loads the API key reliably. The idle policy is superseded October 4. [repo:83944e5] `shipped`
- Existing SQLite stores migrate detection_manifest via ALTER TABLE; CREATE TABLE IF NOT EXISTS alone did not upgrade old stores. [repo:881b7a9] [chat:cb403267] `shipped`

### Known issues

- 1.3.5 Input Purpose still flagged on fields with `autocomplete="name"` / `"email"` (scan `f5d0954e-8590-48af-894f-da6714017d15` diagnostic). Addressed by B5 later. [chat:cb403267] [repo:f0e97b9] [scan:f5d0954e]

### Results

- Lakewood scan series: 2026-03-26 baseline 551 instances; 2026-04-02 scan 2: 807; scan 3: 705; 2026-04-03 scan 4: 222. Advisory 634 to 19. [chat:cb403267]

## 2026-04-02

### Added

- Each finding-type card lists affected page paths. [repo:75b4cf8] `shipped`

### Results

- Reference deliverable: scan `f90a1d27-c1ad-42b1-8701-4feed9c37728`, 18h remediation estimate, 31 tested = 19 passed + 12 failed, 17 N/A, 3 not tested. 1,079 tests passing. [chat:98edf333] [scan:f90a1d27]

### Planned

- Remaining report proposals: per-finding litigation-risk framing and a quantified “template fixes clear ~80%” summary. Ranked fixes, before/after diff and plain-English impacts are merged into their landed repo entries; these remaining promises have no implementation evidence. (no commit found) [chat:98edf333] `planned`

## 2026-03-26

### Added

- Chat reports a project README by March 26; available history first adds README on October 4. No earlier README commit is found; retain the earlier observation without redating the actual addition. (no commit found) [chat:a3d5e773] [repo:ffdcd30]

### Fixed

- Criteria tested equals passed + failed; Not Applicable is shown separately in the summary. [repo:d4294d6] [chat:98edf333] `shipped`
- Not Tested card is restored conditionally to the executive-summary grid. Executive-summary cards use five columns to avoid orphan cards. [repo:22d1dc6] [chat:98edf333] [repo:cafa83b] `shipped`
- On claude/mystifying-margulis only: string-built __name shims repair browser-evaluate callbacks, and 429/server errors back off with jitter; defaults become concurrency 3/retries 3. This commit is outside main’s ancestry; comparable context shim/backoff reaches main later in f07b430/27fe24a. Chat’s April 2 shipped claim does not establish an earlier main landing. [repo:e78d715] [chat:98edf333] `shipped`

### Known issues

- Focus Visible reported 176 unique fixes at 1h; unique-fix count and hours disagree when one global CSS rule fixes all instances. [chat:a3d5e773] [repo:6790bed]
- Browser __name errors suppressed modal/form scenarios. A repair exists on unmerged claude/mystifying-margulis on March 26, rather than a verified April 2 main landing; browser-context shimming reaches main September 23. [chat:a3d5e773] [repo:e78d715] [repo:f07b430]

## 2026-03-25

### Added

- Lakewood-driven semantic checks cover duplicate/unlabelled nav landmarks, widget/accordion/tab ARIA, table captions/scope/headers and duplicate link text; 16 adapter remediation templates cover actual failure types. [repo:d4c7423] [chat:f67d0e54] `shipped`
- Manual ground-truth audit of lakewoodcourtoh.gov by Claude: 5 templates (Home, List/Index, Accordion/FAQ, Data Table/Fee Schedules, Basic Content); failures in landmarks, alt text, accordion ARIA, table semantics, tab controls, duplicate link text. [chat:f67d0e54] [repo:d4c7423]

### Changed

- Report consolidates same-criterion/subtype and shared-template fixes, computes effort per unique type (chat’s 43baee52: 502 findings, 1,004 h to 26 h), replaces per-page repetition with a summary appendix, removes dead PDF controls/raw platform text and synthetic-element leakage, and gives human-readable categories plus actionable platform fixes. [repo:d4c7423] [chat:a3d5e773] [chat:f67d0e54] [scan:43baee52] `shipped`
- Municipal reports use Assessment and no issues detected, with disclaimers and scope disclosures. The March 25 Codex review preceded these narrower claims (inferred relationship); no certification is implied. [repo:d4c7423] [codex:019d25b9] `shipped`

### Fixed

- Default scans enable all five tiers instead of omitting later checks. [repo:c5b7a22] `shipped`
- Template-aware effort is recalibrated from 29 h to 17 h on the 17-page reference site; global focus/skip-navigation CSS counts as one fix, grammar and scan-diff text are corrected, and password-page 3.3.4 findings become advisory. [repo:6790bed] [chat:a3d5e773] [scan:352d16a6] `shipped`

### Decisions

- Primary product value: a compliance baseline for before/after comparison. (no commit found) [chat:f67d0e54]
- Guardrail: do not modify `src/checks/`, `src/core/scanner.ts`, `src/core/crawler.ts`; scanner.ts later allowed minimal edits for check registration and criterion result logic. (no commit found) [chat:f67d0e54]

### Known issues

- Codex code review identified heuristic criterion passes, sampled coverage, strong compliance wording and missing data-governance controls. Report wording/scope changes land later that day; broader manual-validation, retention/redaction and government-safe-mode proposals have no implementation evidence. (no commit found) [codex:019d25b9] [repo:d4c7423]

### Results

- Chat reports a full-five-tier Lakewood scan 352d16a6 moving from 123 findings / 2 issue types to 557 / 13 types / four severities after API-key loading was corrected. Default-five-tier wiring is committed March 25; later dotenv repairs are April 3. The named scan is absent from the current store. [chat:a3d5e773] [scan:352d16a6] [repo:c5b7a22] [repo:83944e5]

### Planned

- One-page summary output mode. (no commit found) [chat:f67d0e54] `planned`

## 2026-03-09

### Fixed

- Report screenshots are inline base64 and findings expose failure-type labels. [repo:ca0ebb3] [chat:9ce63b91] `shipped`
- Shared behavioral findings deduplicate across pages; chat reports 170 fewer findings and passing criteria 4 to 18. [repo:952b77b] [chat:9ce63b91] `shipped`
- Remediation enters the scan pipeline; reports gain findings-by-page and findings-by-type views, with issue-type/instance/page counts. [repo:9353688] [chat:f67d0e54] [chat:9ce63b91] `shipped`

### Decisions

- Workflow: prompts with acceptance criteria, "don't commit until ALL pass", typecheck + tests before commit, one commit per issue to master, smoke scan every 3 to 4 issues. (no commit found) [chat:9ce63b91]
- C4 defined as real client audits reviewed for false positives, missing findings, remediation quality, and severity accuracy. (no commit found) [chat:9ce63b91]

### Known issues

- reCAPTCHA hidden field (`g-recaptcha-response`) times out in form testing. (no commit found) [chat:9ce63b91]
- `needs_review: 0` on scan `75b64562-44eb-4e7a-b7b0-fa8f8ae11f30`; Tier 5 indicators expected to produce some. Unresolved in chat history. [chat:9ce63b91] [scan:75b64562]

## 2026-03-08

### Added

- C2-01: tab sequence recording with focus capture. [repo:5c8a9fd] [chat:9ce63b91] `shipped`
- C2-02: keyboard trap detection. [repo:ffafc0b] [chat:9ce63b91] `shipped`
- C2-03: focus visibility testing with contrast measurement. [repo:3f6091d] [chat:9ce63b91] `shipped`
- C2-04: focus order validation against visual layout. [repo:82474f6] [chat:9ce63b91] `shipped`
- C2-05: skip navigation verification. [repo:de5eb06] [chat:9ce63b91] `shipped`
- C2-06: modal focus management testing. [repo:5d7af46] [chat:9ce63b91] `shipped`
- C2-07: prompt runner with retry, batching, and rate limiting. Batch-mode interface is present; flushBatch still executes realtime calls rather than the Anthropic batch API. [repo:219425c] [chat:9ce63b91] `shipped`
- C2-08: all 15 prompt templates across 4 families. [repo:7f5952e] [chat:9ce63b91] `shipped`
- C2-09: alt text quality check via Claude API. [repo:27cf2aa] [chat:9ce63b91] `shipped`
- C2-10: link text quality check via Claude API. [repo:ac48323] [chat:9ce63b91] `shipped`
- C2-11: heading structure check via Claude API. [repo:a1c3625] [chat:9ce63b91] `shipped`
- C2-12: consistent navigation check via Claude API. [repo:1ca831d] [chat:9ce63b91] `shipped`
- C2-13: analyzer routing logic for rule-based and LLM analysis. [repo:f677fcf] [chat:9ce63b91] `shipped`
- C2-14: confidence scoring with calibrated tiers. [repo:1332b1f] [chat:9ce63b91] `shipped`
- C2-15: scanner orchestrator for full check pipeline. Cycle 2 completion was reported in chat as 611 tests / 24 files. [repo:688b62e] [chat:9ce63b91] `shipped`
- C3-01: form discovery and cataloging. [repo:e729857] [chat:9ce63b91] `shipped`
- C3-02: form submission testing with error detection. [repo:f9ba52b] [chat:9ce63b91] `shipped`
- C3-03: error message evaluation via Claude API. [repo:51bbfb4] [chat:9ce63b91] `shipped`
- C3-04: high-risk form detection and safeguard evaluation. [repo:edb8b9a] [chat:9ce63b91] `shipped`
- C3-05: pause-stop-hide and three-flashes indicators. [repo:2fc7773] [chat:9ce63b91] `shipped`
- C3-06: multiple-ways and motion-actuation indicators. [repo:3cecfca] [chat:9ce63b91] `shipped`
- C3-07: on-input and error quality indicators. [repo:ba4f06a] [chat:9ce63b91] `shipped`
- C3-08: report query and finding grouping by type hash. [repo:1d9e8b3] [chat:9ce63b91] `shipped`
- C3-09: HTML report template with evidence chains. [repo:14a6b50] [chat:9ce63b91] `shipped`
- C3-10: impact descriptions and executive summary via Claude API. [repo:8e5dffb] [chat:9ce63b91] [chat:98edf333] `shipped`
- C3-11: before/after PDF report with diff badges. [repo:5246a48] [chat:9ce63b91] [chat:98edf333] `shipped`
- C3-12: Webflow remediation templates with verification. [repo:6e9ccd8] [chat:9ce63b91] `shipped`
- C3-13: report CLI command with PDF generation. [repo:bd6a84b] [chat:9ce63b91] `shipped`
- C3-14: review CLI command for human verification. Cycle 3 completion was reported in chat as 943+ tests / 32+ files. [repo:a8bbe68] [chat:9ce63b91] `shipped`

### Fixed

- Severity and category mapping from axe-core results. [repo:7dc7757] `shipped`
- CLI loads dotenv and scanner executes Tiers 4 and 5. [repo:ec5e0fb] [chat:9ce63b91] `shipped`
- CriterionResult reconciliation and NOT TESTED coverage. [repo:d4190ae] [chat:9ce63b91] `shipped`
- Criterion names, media not_applicable, and axe pass coverage. [repo:b97ac0e] [chat:9ce63b91] `shipped`
- Comprehensive CriterionResult pass coverage for all 50 criteria. [repo:dc51538] [chat:9ce63b91] `shipped`
- Severity calibration across all 5 tiers. [repo:dab2d87] [chat:9ce63b91] `shipped`

## 2026-03-04

### Added

- C1-06: config module with env loading and validation. [repo:989855e] [chat:9ce63b91] `shipped`
- C1-07: crawler basic page discovery with Playwright. [repo:4182e35] [chat:9ce63b91] `shipped`
- C1-08: crawler sitemap.xml and robots.txt support. [repo:bd540a0] [chat:9ce63b91] `shipped`
- C1-09: CMS collection detection and sampling. [repo:c1c2af9] [chat:9ce63b91] `shipped`
- C1-10: evidence capture with immutable envelope. [repo:b1ad7c0] [chat:9ce63b91] `shipped`
- C1-11: Webflow platform detection adapter. [repo:8f9b2a9] [chat:9ce63b91] `shipped`
- C1-12: axe-core integration with result mapping. [repo:e9c837b] [chat:9ce63b91] `shipped`
- C1-13: scan CLI command wiring full Cycle 1 pipeline. [repo:43c4c2d] [chat:9ce63b91] `shipped`
- C1-14: CLI progress output with phases and quiet mode. [repo:7844e0e] [chat:9ce63b91] `shipped`
- C1-15: test fixtures from real Webflow sites with loadFixture helper. [repo:e5e7488] [chat:9ce63b91] `shipped`

### Fixed

- Wire scan command into CLI. [repo:3776bd2] [chat:9ce63b91] `shipped`

## 2026-03-03

### Added

- C1-01 + C1-02: scaffold wcag-engine with strict TypeScript/ESM, Playwright, axe-core, Claude SDK, SQLite, sharp, commander, vitest, architecture/data model and domain guidance. First available commit: March 3. [repo:783f4b9] [chat:9ce63b91] `shipped`
- C1-03: TypeScript entity interfaces from data model. [repo:2501d44] [chat:9ce63b91] `shipped`
- C1-04: SQLite schema and CRUD for all entities. [repo:354c697] [chat:9ce63b91] `shipped`
- C1-05: binary file storage with swappable interface. [repo:539631e] [chat:9ce63b91] `shipped`

## 2026-03-01

### Added

- Concept: Webflow-specific WCAG 2.1 AA audit tool; Paul has prior manual audit experience and two paying client sites as the first targets. (no commit found) [chat:14115d46]
- Spec in Notion (WCAG Engine hub): data model, stack architecture, coverage map, prompt library (15 prompts, 4 families), build plan (draft dated Mar 1, 2026). (no commit found) [chat:14115d46]
- Initial architecture spec: five detection tiers, CheckResult, immutable evidence entities, SQLite, CMS template sampling (3–5 samples, 50-page default) and retry/needs_review fallback; these are specifications at this date, subsequently implemented across Cycles 1–3. [chat:14115d46] [repo:783f4b9]
- Initial stack choice: Playwright, axe-core, Anthropic SDK, better-sqlite3, sharp, commander, strict TypeScript ESM, tsx and vitest; scaffold lands March 3. [chat:14115d46] [repo:783f4b9]

### Decisions

- Coverage estimate revised from 80% target to roughly 70 to 75% usable automated coverage (about 28 definitive, 13 partial, 9 human-judgment criteria of 50). (no commit found) [chat:14115d46]
- Sonnet for element evaluation, Opus for synthesis; uncertain evidence returns needs_review instead of fail. Prompt runner/templates implement the split March 8. [chat:14115d46] [repo:219425c] [repo:7f5952e]
- Pre-production test plan: each prompt against 10 known-good and 10 known-bad Webflow elements. Not found as run in later chats. (no commit found) [chat:14115d46] `planned`
- Deliverable framed as documented audit methodology; no compliance certification. (no commit found) [chat:14115d46]

---

## Scan index

Full UUIDs and created/start timestamps for every main-folder scan directory; finding counts are stored rows (or the disk JSONL count for a518b4a6), not client-visible occurrence counts. Every stored directory manifest declares engine 0.1.0 and axe 4.11.1; all tiers 1–5 except the 69271047 verify scan (1 and 3). Manifest API-key presence does not prove successful calls. [scan:7033a623] [scan:69271047] [scan:a518b4a6]

| Created/start (Denver) | Scan UUID | Target URL | Findings | detection_manifest | Coverage / verify | baseline_scan_id | Source |
|---|---|---|---:|---|---|---|---|
| 2026-10-11T20:47:18-06:00 | ee56b381-8743-4b24-9b09-9654a63b1614 | https://www.popfly.com | 830 | yes | coverage.json | — | [scan:ee56b381] |
| 2026-10-11T20:10:43-06:00 | 0b7d5e28-4c86-47a5-8982-6b95ae9c762a | https://www.popfly.com | 984 | yes | coverage.json | — | [scan:0b7d5e28] |
| 2026-10-11T11:52:42-06:00 | 4d008e9e-c06a-4de9-966b-2c530ae62b6b | https://www.popfly.com | 994 | yes | coverage.json | — | [scan:4d008e9e] |
| 2026-10-10T20:47:01-06:00 | 46bcdc42-78c1-412b-9c31-dced843ea242 | https://www.popfly.com | 964 | yes | coverage.json | — | [scan:46bcdc42] |
| 2026-10-10T20:37:01-06:00 | 69271047-f1b0-4813-9cdb-32ff79817d0c | https://www.popfly.com | 571 | yes | coverage.json, verify.json | e779c8b0-03f2-44fd-87cc-b960bc230785 | [scan:69271047] |
| 2026-10-10T19:36:56-06:00 | 8b301074-1b31-4630-8321-b765f51474ad | https://www.popfly.com | 963 | yes | absent | — | [scan:8b301074] |
| 2026-10-04T15:28:04-06:00 | e779c8b0-03f2-44fd-87cc-b960bc230785 | https://www.popfly.com | 1342 | yes | absent | — | [scan:e779c8b0] |
| 2026-10-04T12:23:33-06:00 | ba241ce6-5373-4285-ba8c-d51d0ef23134 | https://www.popfly.com | 1430 | yes | absent | — | [scan:ba241ce6] |
| 2026-10-04T12:23:25-06:00 | 1d4f7d24-22db-4938-a0b4-21ba186f2484 | https://www.popfly.com | 1543 | yes | absent | — | [scan:1d4f7d24] |
| 2026-10-04T12:12:42-06:00 | d391ed89-5664-48b6-b3cd-1e4889bdc8f1 | https://www.popfly.com | 1506 | yes | absent | — | [scan:d391ed89] |
| 2026-10-04T11:40:03-06:00 | 7033a623-fdb7-464f-92d4-6ee1e708bd1d | https://www.popfly.com | 1619 | yes | absent | — | [scan:7033a623] |
| 2026-10-02; exact time unknown | a518b4a6-94e0-4f63-beb4-c26751d280bc | https://popfly.com | 968 | unavailable (no store session) | absent | unknown | [scan:a518b4a6] [cc:e8a46994] |

## Commit and local-session index

- All 88 unique commits in git log --all are represented above; 87 are ancestors of the snapshot HEAD. No tags exist. Merged Claude branches: busy-maxwell (e5e7488), charming-noyce (1ca831d), clever-davinci (edb8b9a), crazy-allen (688b62e), elastic-hertz (9353688), pensive-booth (1d9e8b3). claude/mystifying-margulis (e78d715) is unmerged and identified as branch-only. [repo:e5e7488] [repo:1ca831d] [repo:edb8b9a] [repo:688b62e] [repo:9353688] [repo:1d9e8b3] [repo:e78d715] [repo:86d750d]
- Claude Code e8a46994-7392-47b5-a389-b597b4f26c85 covers October 4–11 implementation/review; c874ed56-e953-4b63-ab85-eb9f73e8c692 covers October 3 relocation/SQLite; d53e75c3-662c-4af6-b3e9-ef238b95dd55 covers September 23–October 2 form/crawl discussions. Matching legacy project directory is present but empty. [cc:e8a46994] [cc:c874ed56] [cc:d53e75c3]
- Codex 019d25b9-c24a-7c30-b5e3-6e88bb58eccd (March 25) is a code/product review; 019fd366-9b38-75a0-84f7-57962f77fb8d (August 5) is strategy. Both identify the legacy repo as cwd; neither supplies additional non-Popfly finding verdicts suitable for this seed set. [codex:019d25b9] [codex:019fd366]

## Gaps

- Repo history fills the original chat gap from April 16 to October 4: April 17 keyboard, April 22 skip-nav, April 24 noindex, September 23 focus/forms, October 3 SQLite, October 4 performance. No engine commits are available between April 24 and September 23; the May review UI and document plans remain unverified. [repo:3b79f96] [repo:02de1e2] [repo:a73b984] [repo:cc95a8e] [repo:0b8a985] [repo:f07b430] [repo:9e3b5fc] [repo:27fe24a] [chat:1d0bb3c3] [chat:607b026a]
- B4’s search/login/subscribe/contact exclusion and two-signal high-risk threshold have no matching implementation. Current high-risk classification still uses broad keyword signals. The password-page advisory downgrade is narrower and does not prove B4. [chat:98edf333] [repo:edb8b9a] [repo:6790bed] (no commit found)
- Chat says the Playwright duplicate-link rule was replaced by Claude; available history retains the deterministic rule. Chat’s PromptLogger explanation also differs from April’s actual buildLlmCapture implementation; later scanner timing/logging is not proof of the exact earlier scanner/analyzer claim. [chat:cb403267] [chat:98edf333] [repo:d4c7423] [repo:f0e97b9] [repo:0b8a985] [repo:27fe24a]
- e78d715 exists only on claude/mystifying-margulis, so the April 2 chat runtime-fix claim cannot establish a main landing. README’s March 26 chat observation likewise precedes the first repository addition on October 4. Both original observations remain in the timeline. [chat:98edf333] [chat:a3d5e773] [repo:e78d715] [repo:ffdcd30]
- Skip-link clearance differs: chat says 48; the committed notes/local transcript say three findings across 50 page occurrences. Preserve the discrepancy rather than silently treating findings and occurrences as the same measure. Script focus also explains only part of the 112 historical focus false positives; stale cropping was already fixed. [chat:5dd53c0b] [cc:e8a46994] [repo:7494e90] [repo:d0421be] [repo:1f72a1f]
- SL-014 preserves the original Lakewood label treating skipped heading levels as a true-positive 2.4.6 failure; the later engine change treats skipped levels as best practice. This is an unresolved labeling conflict, not authority to relabel a historical human-accepted case. [chat:cb403267] [repo:f6389d6]
- Current SQLite holds only Popfly sessions and zero non-null human_review verdicts. All main-folder findings dumps are Popfly. Eighteen input labels are preserved; zero eligible labels added (SL-019 remains next). Unknown/placeholder Lakewood scan ids and absent finding ids remain unresolved, including aggregate/non-finding rows; no date/criterion match can establish a Lakewood UUID from this store. [scan:7033a623] [scan:ee56b381] [chat:9ce63b91] [chat:cb403267] [chat:98edf333]
- a518b4a6 survives only as a disk dump; exact creation timestamp, manifest and baseline link are unavailable. Store-only 78425a63 is a zero-page session with no scan directory. 77a43f3b belongs to the separate baseline-worktree scan mentioned in transcripts, not the main store; 9810857f survives as a reference PDF. Earlier Lakewood sessions are absent. [scan:a518b4a6] [scan:78425a63] [scan:77a43f3b] [scan:9810857f] [cc:e8a46994]
- Before/after site edits are not committed in this scanner repository. Page selection, dynamic widgets, model outputs and post-hoc report regeneration vary across scans; no repository version is recorded in the detection manifests beyond engine 0.1.0. Scan adjacency alone does not prove which commit produced an artifact. [scan:7033a623] [scan:d391ed89] [scan:69271047] [scan:ee56b381]
- The second paying client is referenced but never named/scanned in supplied chat history; other Popfly Project chats may contain further evidence. No complete non-Popfly review transcript survives locally in the matching project directories. [chat:14115d46] [chat:5dd53c0b] [cc:e8a46994]
- Historical strategy transcripts cite different legal deadlines. They are retained as dated discussions, not current legal guidance; no outside research or deadline reconciliation was performed for this repo-sourced changelog. [chat:dc864a9a] [codex:019d25b9] [codex:019fd366]
