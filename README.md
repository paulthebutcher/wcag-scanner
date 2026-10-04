# WCAG Engine

AI-powered WCAG 2.x AA compliance scanner. It crawls a site, runs automated, behavioral, semantic and form checks, scores every finding for confidence, and produces a report with platform-specific (Webflow) remediation steps. CLI-first.

## What it does

Point it at a URL and it:

1. **Crawls** the site (sitemap, robots.txt, link discovery), several pages at a time, skipping `noindex` pages by default and sampling CMS collection pages (sections whose pages share a template) rather than crawling hundreds of near-identical ones.
2. **Detects the platform** (currently Webflow) so fixes can be given in the platform's own terms.
3. **Runs five tiers of checks** against every page (see below).
4. **Analyzes and scores** each result: what it means for real users, how confident the scanner is, and how to fix it.
5. **Stores everything** in a local SQLite database, with screenshots and DOM snapshots on disk.
6. **Reports** as PDF or HTML, with optional before/after comparison against an earlier scan.
7. **Supports human review**, so a person can confirm, downgrade or dismiss findings.

## How it works

### Check tiers

| Tier | What | How | Needs API key |
|------|------|-----|---------------|
| 1 | Rule-based WCAG detection (contrast, alt attributes, labels, ARIA validity, ...) | axe-core via Playwright | No |
| 2 | Keyboard reachability, focus order, focus visibility, skip links, keyboard traps, modals | Playwright driving a real browser | No |
| 3 | Quality judgements: alt text, link text, headings, consistent navigation, landmark labels, tables, widget ARIA | Claude API | Yes |
| 4 | Form discovery, submission, error-message quality, input purpose, high-risk forms (3.3.x) | Playwright + Claude API | Partly |
| 5 | Human-judgment triage indicators: pause/stop/hide, multiple ways to find pages, on-input changes | Heuristics that flag items for review | No |

Without `ANTHROPIC_API_KEY`, Tiers 3 and 4's LLM checks are skipped and those criteria are reported as `not_tested`, never as passed. Criteria that no check exercises are also reported as `not_tested`.

axe-core runs on the crawl's own page load, and the Tier 3 LLM checks run in the background while the browser-based tiers work through the pages.

### Design principles

- **Evidence is immutable.** Screenshots, DOM snapshots and measured values are captured once and never altered. Analysis, confidence and remediation are layered on top.
- **Detection is separate from interpretation.** "The contrast ratio is 3.2" (evidence) is stored apart from "this violates 1.4.3" (analysis).
- **Every check returns `CheckResult[]`.** `scanner.ts` collects them and `evidence.ts` wraps them into Findings.
- **Platform adapters never leak into core.** `src/core` and `src/checks` do not import from `src/adapters`; adapters are injected.
- **Never crash mid-scan.** Errors are logged, the finding is marked `needs_review`, and the scan continues.

### Layout

```
src/
  core/       crawler, scanner (orchestration), evidence, analyzer, confidence, prompt-runner
  checks/     automated/ behavioral/ semantic/ forms/ indicators/
  adapters/   PlatformAdapter interface + Webflow adapter
  prompts/    Claude prompt templates (element evaluation, forms, remediation, synthesis)
  store/      SQLite (db.ts) and binary file storage (files.ts)
  report/     findings dump, synthesis, PDF renderer, HTML template
  cli/        commander wiring: scan, report, review
test/
  unit/       vitest suites
  fixtures/   saved DOM snapshots and test pages for offline testing
```

The CLI is a thin wrapper. All logic lives in `core`, `checks`, `adapters` and `report`, so a web server or serverless function can call the same modules.

### Prompt runner

Claude calls go through `prompt-runner.ts`: temperature 0, up to 2 retries on parse failure, configurable concurrency, and every call logged with prompt name, tokens and latency. If retries fail, the finding falls back to `needs_review`. Sonnet handles element evaluation, forms and remediation; Opus handles the executive summary.

## Setup

Requires Node.js 18+ (developed on Node 24).

```bash
npm install
npx playwright install chromium
```

Create a `.env` file (it is git-ignored; never commit it):

```
ANTHROPIC_API_KEY=your-key-here
WCAG_DATA_DIR=./wcag-data
WCAG_MAX_PAGES=50
WCAG_CONCURRENCY=5
WCAG_PROMPT_MODE=realtime
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | none | Required for Tier 3 and Tier 4 LLM checks |
| `WCAG_DATA_DIR` | `./wcag-data` | Where the database, screenshots and reports go |
| `WCAG_MAX_PAGES` | `50` | Page cap for a crawl |
| `WCAG_CONCURRENCY` | `5` | Parallel Claude API calls |
| `WCAG_PROMPT_MODE` | `realtime` | `realtime` or `batch` |
| `WCAG_MODEL_SONNET` | `claude-sonnet-4-6` | Model for element, form and remediation prompts |
| `WCAG_MODEL_OPUS` | `claude-opus-4-6` | Model for the executive summary |

Build the CLI (or run it directly with `tsx`):

```bash
npm run build
npx wcag --help                    # after build
npx tsx src/cli/index.ts --help    # without building
```

## Commands

### `wcag scan <url>`

Crawl and scan a site. Prints the scan ID first (so it can be piped), then a summary.

```bash
npx wcag scan https://example.com
npx wcag scan https://example.com --max-pages 20 --output json --quiet
npx wcag scan https://example.com --tiers 1,2          # no API key needed
```

| Option | Default | Description |
|--------|---------|-------------|
| `--max-pages <n>` | `50` | Maximum pages to crawl |
| `--output <format>` | `table` | `table` or `json` |
| `--tiers <list>` | `1,2,3,4,5` | Comma-separated tiers to run |
| `--cms-samples <n>` | `5` | CMS collection pages sampled per collection |
| `--data-dir <path>` | `./wcag-data` | Where results are stored |
| `--page-concurrency <n>` | `4` | Pages loaded and tested in parallel |
| `--include-noindex` | off | Also scan pages marked `noindex` |
| `--quiet` | off | Suppress progress output |

Each scan also writes a verbose findings dump to `<data-dir>/<scan-id>/` (`findings.md`, `findings.jsonl`, and one markdown file per finding), grouped into triage buckets: fix now, verify manually, possibly noisy, advisory. The same directory gets `timings.json`: time per phase, and API calls, cache hits and tokens per prompt.

### `wcag report <scan-id>`

Generate a report from a completed scan.

```bash
npx wcag report <scan-id>
npx wcag report <scan-id> --format html --output audit.html
npx wcag report <scan-id> --compare <earlier-scan-id>        # before/after
npx wcag report <scan-id> --severity critical,major
npx wcag report <scan-id> --dump                              # regenerate findings dump
```

| Option | Default | Description |
|--------|---------|-------------|
| `--format <type>` | `pdf` | `pdf` or `html` |
| `--output <path>` | `<data-dir>/report-<id>.pdf` | Output file |
| `--compare <scan-id>` | none | Compare against a previous scan |
| `--severity <levels>` | all | Filter: `critical,major,minor,advisory` |
| `--dump` | off | Regenerate `findings.md`, `findings.jsonl` and per-finding files |
| `--data-dir <path>` | `./wcag-data` | Data directory |
| `--quiet` | off | Suppress progress output |

PDF output uses headless Chromium via Playwright.

### `wcag review [finding-id]`

Record human review of findings.

```bash
npx wcag review --scan <scan-id> --pending            # list unreviewed findings
npx wcag review --scan <scan-id> --stats              # review progress
npx wcag review <finding-id>                          # show one finding
npx wcag review <finding-id> --verdict false_positive --notes "Decorative image" --reviewer paul
npx wcag review <finding-id> --verdict downgraded --severity minor
```

| Option | Description |
|--------|-------------|
| `--scan <scan-id>` | Scan to use with `--pending` / `--stats` |
| `--pending` | List findings awaiting review |
| `--stats` | Show review statistics |
| `--verdict <v>` | `confirmed`, `false_positive`, `downgraded`, `escalated` |
| `--severity <level>` | Override severity (`critical`, `major`, `minor`, `advisory`) |
| `--notes <text>` | Reviewer notes |
| `--reviewer <name>` | Reviewer name (default `cli-user`) |
| `--data-dir <path>` | Data directory |

## Development

```bash
npm run test:run     # run the vitest suite once
npm test             # watch mode
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run dev          # tsx watch on the CLI
```

Tests run offline against saved fixtures in `test/fixtures/`. The `scripts/` directory holds ad-hoc keyboard-debugging scripts, run with `npx tsx scripts/<name>.ts`.

## Known issues

See [KNOWN_ISSUES.md](KNOWN_ISSUES.md). In particular, forms that are hidden at page load (modals, collapsed panels, third-party embeds) are not interaction-tested.

## Limitations

Automated testing cannot establish full WCAG conformance. Tier 5 and low-confidence findings are explicitly flagged for human review, and a manual audit is still needed for a conformance claim.
