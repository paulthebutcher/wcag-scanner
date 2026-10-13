# Phase 1 report: frozen eval harness, regression gate and review workflow

2026-10-12. Branch `eval/phase1`, 15 commits on top of main. No detection code was changed: nothing under `src/checks/**`, `src/prompts/**`, `analyzer.ts`, `confidence.ts` or `evidence.ts`; `scanner.ts` gained one eval-only hook (default off).

**Headline:** the harness is built and verified end to end on a local fixture, at HEAD and at the baseline. Nothing has been measured on real pages yet: capture needs `EVAL_CONTACT_URL` and your go-ahead, recording needs a budget, and accuracy needs your labels.

## 1. Commits and provenance

| | |
|---|---|
| Starting SHA | `5d7a46777178ef67dd715e4bf2dd249f4c9fc182` (main; clean apart from the untracked earlier plan draft) |
| Harness SHA (code) | `91eb47b`; docs and evidence through `d89b36c` |
| Baseline | `baseline-2026-10-04` → `ffdcd308610527525fb82ccd118a7f7b89334b66` |
| Bridge patch | `eval/baseline-bridge/ffdcd30.patch`, sha256 `6f224841b57697ab92c74b388c7d006bf312ea16be9fe0c7cea88d2188a456ef` (scanner.ts, two hunks) |
| Bridge adapter | `src/eval/engine/legacy.ts`, sha256 `b3a48ab1308af577f7ed05f2bcc134611084c51edca8a9100937c49948702bed` |
| Baseline effective source | sha256 `12d6837b58aff1f0d47a3b3713c130e2413319005e4648dac8cddd7d1218c369` |

Commits: `a72248f` checkpoint 0, privacy, config, manifests · `b921a95` D0 · `80327af` D0 evidence · `513fe47` D2/D3 · `67c0256` D4 · `def7e96` D9 · `8963964` attribution and manifest fixes · `4e6472e` D5 · `0c4dc84` D10 · `34534e5` D6/D7 · `e4ee5dd` D1b tooling · `52bfd6c` static export, guide · `91eb47b` dirty-tree rule, evidence · `d89b36c` changelog.

Checks: `tsc --noEmit` and `eslint src/` clean; `vitest run` 1,408 tests pass (1,305 pre-existing, all passing before the work; 103 new).

## 2. Default path, containment, egress (pilot `pilot-20261013T011517Z-e56772`, clean tree, 37/37)

- **Default-path equivalence (invariant 2):** pre-harness `5d7a467` and the current code, eval off, injected deterministic responses, local fixture: 62 findings, 48 criterion statuses, 78 coverage entries, no difference.
- **Submission containment:** GET form (click and `form.submit()`), POST navigation, fetch, XHR and `sendBeacon` contained live and offline; the fixture server saw 0 submission requests during capture. GET forms are recognised from Chromium's own navigation reason (`formSubmissionGet`), so no fixture form had to be left uncaptured.
- **Egress:** clean replays at HEAD and the baseline had 0 HAR, Node-fetch, image and cache misses and 0 egress. An engine-style `route.continue()` on a wrapped page is served from the HAR; on an unwrapped page the deny proxy catches it; a context created outside the boundary is caught; Node socket denial records attempts even when the caller swallows the error; service workers are unavailable in eval contexts; WebSockets are refused.
- **Detection of failures:** the trap page produced HAR misses, Node-fetch misses, a declared exclusion counted separately, and refused WebSockets at both engines; a replay-rendered screenshot was refused at the model boundary; a missing cached response was a counted miss, never a live call.

## 3. Corpus

No real corpus exists yet. Capture, verification, robots handling, pacing and image-store collection are proven only on the synthetic pilot fixture. Tuning selections (≤30 of the 50 Popfly pages in `ee56b381`; the 17 Lakewood pages of `1a6e3c3e`) are not frozen, because selection happens at capture. Robots skips, capture failures and replay exclusions: none yet.

## 4. Baseline vs HEAD

Not run on real pages (needs §3 and a record). The gate itself is tested: 13 failing-fixture tests produce exit 1 for a removed true finding, a returning FP, dropped coverage, an API failure that loses a TP, a new false pass, a changed criterion, a severity regression, a broken static case and a gated metric drop; exit 2 for a corrupted artifact, a changed label snapshot, dirty trees, misses, unresolved repeatability and contract changes. A smoke comparison on pilot replays correctly returned exit 2 (diagnostic runs, injected responses). The original `77a43f3b` totals (50 pages, 1,549 findings) are read from its own store and reported as context only.

## 5. Repeatability

Pilot corpus only (diagnostic): three HEAD replays, non-behavioral identical, no flaky checks. Real flake rates need real corpora.

## 6. Metrics

None: there are no labels yet. Metrics, intervals, separate origins (queue precision, random-audit precision, audit recall, known-defect recall), confirmed and inclusive views and false-pass rules are implemented and tested on fixtures.

## 7. Coverage, tooling errors, false passes

- Static SL-016 synthetic: with every model call failing (HTTP 400), no false pass at either engine. With model-based checks throwing, both engines still report 1.1.1, 1.3.5, 2.4.4 and 3.3.4 as passed (P2-010).
- Failed model evaluations are counted as tooling errors, never detections or passes.

## 8. Lakewood seeds (static runs `static-20261013T012446Z-674fb3` head, `static-20261013T012705Z-4d5436` baseline; empty static cache; replays identical)

| Seed | Status | Head | Baseline |
|---|---|---|---|
| SL-001 | scan level, synthetic | pass | pass |
| SL-002 | scan level, not testable | — | — |
| SL-003 | disputed (new evidence) | needs recording | detected (not scored) |
| SL-004 | resolved | pass | pass |
| SL-005, 006 | disputed, markup absent | — | — |
| SL-007 | resolved (8 cases) | 8 pass | 8 pass |
| SL-008 | requires rendering | — | — |
| SL-009, 018 | resolved | needs recording | needs recording |
| SL-010 | unresolved fixture | — | — |
| SL-011 | composite: tooling errors + 2 cases | LS-012 fail; LS-013 (pending) fail | same |
| SL-012 | resolved (3 cases) | 3 pass | 3 pass |
| SL-013 | disputed (new evidence) | needs recording | needs recording |
| SL-014 | disputed (plan) | needs recording | needs recording |
| SL-015 | resolved (17 page cases, severity advisory) | 17 pass | 17 pass |
| SL-016 | scan level, synthetic | fail (P2-010) | fail (P2-010) |
| SL-017 | resolved | LS-014 fail (P2-009) | fail |

Totals: head 29 pass / 3 fail / 5 unavailable; baseline 30 / 3 / 4. Full evidence: `docs/eval/d10-seed-eligibility.md`.

## 9. Review and audit

Built and covered by 10 Playwright end-to-end tests (T/F/S/U/N/Z, case creation with no finding, criterion required, propagation and group undo, offline replay with outline, endpoint protection, calibration hides any judge, active-time rules, audit blinding, freeze and reveal with an FN created and detected, pre/post-reveal phases, pace). **Human checkpoint pending:** 0 labels recorded; no pages audited; pace has no data.

## 10. Privacy and holdout

The committed-export privacy test passes. Exports are refused if they contain a URL, markup, a seed-label hostname or a public-sector hostname. The Lakewood hostname already appears in tracked files that predate this work (seed labels, CHANGELOG, four scripts, one source comment, three tests); left as is. Holdout: no holdout exists yet; access is sealed behind `--unseal` with a committed log (0 entries).

## 11. Defects, assumptions, blocked work

**Phase 2 defects** (`eval/phase2-defects.jsonl`): P2-001 error-message prompt gets the page head, not the form · P2-002 in-scan cache key omits model and system prompt · P2-003 `finding_type_hash` merges failure types · P2-004 axe criterion passes from one rule, last page wins · P2-005 page order varies with page concurrency · P2-006 GET form submissions go live in production scans · P2-007 URL-list mode skips robots; no UA or pacing · P2-008 registry misattributes model-evaluated error-message findings · P2-009 duplicate-link inflation persists · P2-010 throwing checks still yield passes.

**Assumptions**
- (observed) The baseline has no page-list option and no coverage recording; both engines use the same models and SDK.
- (observed) Webflow's runtime adds tab roles in rendered DOMs; static fixtures use the stored rendered DOM.
- (inferred) A 50-page Popfly scan costs about $1 in model calls (149 calls, ~194k tokens in `ee56b381`); recording both engines plus the static set should fit within $10.
- (assumed) "Pre-harness HEAD reference" (D6) means a HEAD run at the harness SHA, which invariant 2 shows detects identically to `5d7a467`; a bridged run of `5d7a467` is also available (`--engine pre-harness`).
- (assumed) Capture runs HEAD's own interactions to fill the HAR. If baseline-only interactions request resources HEAD's do not, baseline replays will show misses and the capture will need a new version.
- (assumed) robots.txt 4xx means "no restrictions" (RFC 9309); network errors and 5xx skip the site.

**Blocked**
- D1/D2/D3 on real pages, D6 reference runs, real repeatability: `EVAL_CONTACT_URL`, your approval to capture, and a record budget.
- D5 numbers and the D9 human checkpoint: your labels.
- D10 model-dependent cases (5 at head, 4 at baseline): a record of the static cache.
- D1b admission: the BuiltWith list.
