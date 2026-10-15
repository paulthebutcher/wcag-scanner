# Eval harness (Phase 1)

`wcag eval` measures and protects detection accuracy on Webflow sites (WCAG 2.1 A/AA) without changing detection. Code lives in `src/eval/`, tests in `test/eval/`. Private data (corpus, caches, runs, labels, cases) stays under `wcag-data/` and in gitignored files under `eval/`; only pseudonymous configuration and aggregate exports are committed.

## Commands

| Command | Site access | Model access | Purpose |
|---|---|---|---|
| `pilot` | none (local fixture) | none (injected) | D0 proofs: transport boundary, containment, egress denial, both engines offline, default-path equivalence |
| `capture --site --split --urls --version` | yes, under etiquette | none | D1: freeze pages (HAR, DOM, screenshot, image store) |
| `verify-corpus --version` | none | none | Recompute every checksum |
| `admit --input --salt-env [--select-pages]` | yes, under etiquette | none | D1b: admit municipal Webflow sites, freeze splits |
| `record --engine --corpus --split --cache --max-cost-usd` | none | yes, budgeted | D3: record model responses for missing cache entries |
| `replay --engine --corpus --split --cache [--repeat N]` | none | none | D2/D3: offline replay, repeatability |
| `review --run --batch` / `audit --corpus --pages --criteria` | none | none | D9: local review and blind audit screens |
| `pace` | none | none | Labelling speed |
| `metrics --run [--labels-through]` / `export --run --aggregates-only` | none | none | D5 |
| `static --resolve` / `static --engine [--record]` | none | static cache | D10 Lakewood static set |
| `compare --base --head` / `reference --base --head` | none | none | D7 gate (exit 0/1/2), D6 export |

Committed exports (under `eval/`: runs, baselines, `phase2-defects.jsonl`, overrides, the holdout log, the bridge) are privacy-checked on write, and a pre-commit hook re-checks their staged content: enable it once per clone with `git config core.hooksPath .githooks`. `wcag eval privacy` scans the working tree; `--staged` scans the next commit.

Every producing command prints its run id and manifest path (`wcag-data/eval-runs/<run-id>/manifest.json`). Consumers take explicit run ids. Official purposes are refused on a dirty tree. The holdout split is sealed: any access needs `--unseal "<reason>"` and is logged to `eval/holdout-access.log`.

## Capture etiquette

`EVAL_CONTACT_URL` is required and goes into the user agent `WCAGEngine-Eval/0.1 (+<url>)`. robots.txt is fetched and applied before any URL list (a fetch error or 5xx skips the site), top-level loads are at least 3 s apart per host (a larger crawl-delay wins), one page is active per host, at most 30 pages per site, and every submission path is contained (unsafe methods and Chromium-announced form navigations are answered 204 or aborted).

## Typical flow

```bash
export EVAL_CONTACT_URL=https://example.org/wcag-eval-contact
wcag eval capture --site t01 --split tuning --urls wcag-data/eval-corpus/urls/t01.txt --version tuning-v1
wcag eval verify-corpus --version tuning-v1
wcag eval record --engine head --corpus tuning-v1 --split tuning --cache tuning-v1 --max-cost-usd 25
wcag eval record --engine baseline --corpus tuning-v1 --split tuning --cache tuning-v1 --max-cost-usd 10
wcag eval replay --engine head --corpus tuning-v1 --split tuning --cache tuning-v1 --repeat 3 --purpose official-regression
wcag eval replay --engine baseline --corpus tuning-v1 --split tuning --cache tuning-v1 --purpose official-regression
wcag eval reference --base <baseline-run> --head <head-run>
wcag eval review --run <head-run> --batch calibration
```

Paired runs share recorded responses wherever the baseline and HEAD send an identical request, so recording the baseline second only pays for the requests that differ.
