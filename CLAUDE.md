# WCAG Engine

AI-powered WCAG AA compliance engine. Crawl → detect → analyze → generate platform-specific remediation. CLI-first MVP targeting Webflow sites.

## Architecture Rules

- **CLI is a thin caller.** All logic in `/src/core`, `/src/checks`, `/src/adapters`. CLI just wires commands to functions. A web server or serverless function calls the same modules.
- **Evidence is immutable.** Once captured, screenshots, DOM snapshots, and measured values never change. Analysis, confidence, and remediation are interpretation layered on top.
- **Detection is separated from interpretation.** "The contrast ratio is 3.2" (evidence) ≠ "this violates 1.4.3" (analysis). Keep them in different entities.
- **Every check module returns `CheckResult[]`.** scanner.ts collects them, evidence.ts wraps them into Findings.
- **Platform adapters never leak into core.** `/core` and `/checks` never import from `/adapters`. Adapters are injected.

## Tech Stack

| Package | Purpose |
|---------|---------|
| playwright | Browser automation, crawling, keyboard testing, screenshots |
| @axe-core/playwright | Rule-based WCAG detection |
| @anthropic-ai/sdk | Claude API for semantic evaluation |
| better-sqlite3 | Evidence storage (single file, zero config) |
| sharp | Image processing, element cropping, contrast measurement |
| commander | CLI argument parsing |

**Build tooling:** TypeScript 5.x, tsx (dev runner), vitest (tests), eslint 9.x
**Module system:** ESM (`"type": "module"` in package.json)
**tsconfig:** strict mode, target ES2022, module NodeNext

## Project Structure

```
/src
  /core
    crawler.ts          — page discovery, sitemap, robots.txt, CMS sampling
    scanner.ts          — orchestrates all check tiers per page
    evidence.ts         — wraps CheckResult → Finding with Evidence entity
    analyzer.ts         — rule-based or LLM analysis → Analysis entity
    confidence.ts       — scores each finding → Confidence entity
    prompt-runner.ts    — Claude API execution with retry, batching, rate limiting
  /checks
    /automated          — axe-core wrapper, maps axe results → CheckResult[]
    /behavioral         — Playwright keyboard, focus, interaction tests
    /semantic           — Claude API quality evaluations (alt text, links, headings)
    /forms              — form discovery, submission, error evaluation
    /indicators         — human-judgment triage helpers (Tier 5)
  /adapters
    types.ts            — PlatformAdapter interface
    webflow.ts          — Webflow detection + remediation
  /store
    db.ts               — SQLite schema + CRUD for all entities
    files.ts            — binary storage (local fs, interface for future S3)
  /prompts
    element-evaluation.ts — Prompts 1-8
    form-interaction.ts   — Prompts 9-11
    remediation.ts        — Prompts 12-13
    synthesis.ts          — Prompts 14-15
  /report
    generator.ts        — queries findings, groups by finding_type_hash
    templates/          — HTML report template (inline CSS, single file)
  /cli
    index.ts            — commander setup
    commands/
      scan.ts           — crawl + analyze a URL
      report.ts         — generate report from scan
      review.ts         — human review workflow
  /server               — (empty, future Express/Hono)
/test
  /fixtures             — saved Webflow DOM snapshots + screenshots for offline testing
```

## Key Interfaces

```typescript
// Every check module returns this
interface CheckResult {
  element_selector: string;
  element_html: string;
  wcag_criterion: string;
  detected_by: "axe_core" | "playwright" | "claude_api";
  raw_result: any;
  screenshot?: Buffer;
  context_screenshot?: Buffer;
  measured_values?: Record<string, any>;
  keyboard_sequence?: any[];
  aria_attributes?: Record<string, string>;
}

// Platform adapters implement this
interface PlatformAdapter {
  detect(dom: string): boolean;
  getRemediationSteps(finding: Finding): PlatformFix;
  getPlatformInfo(): PlatformInfo;
  getPlatformContext(): string;
  getCMSPattern(): RegExp | null;
}

// Prompt runner configuration
interface PromptRunnerConfig {
  mode: "realtime" | "batch";
  max_retries: number;          // default 2
  concurrency: number;          // default 5
  fallback_on_failure: "needs_review" | "skip";
}
```

## Data Model — All Entities

### ScanSession
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | Primary key |
| url | string | Root URL crawled |
| platform | enum | webflow \| squarespace \| shopify \| wordpress \| framer \| unknown |
| platform_detected_via | string | How platform was identified |
| initiated_at | timestamp | Scan start |
| completed_at | timestamp | Scan end |
| comparison_scan_id | uuid \| null | Links to previous scan for before/after |
| scan_type | enum | initial \| rescan \| monitoring |

### PageSnapshot
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | Primary key |
| scan_session_id | uuid | FK → ScanSession |
| url | string | Page URL |
| title | string | Document title |
| captured_at | timestamp | Snapshot time |
| full_dom | string | Serialized DOM |
| screenshot | binary | Full-page screenshot (stored via files.ts) |
| viewport | object | { width, height, deviceScaleFactor } |

### InteractionState
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | Primary key |
| page_snapshot_id | uuid | FK → PageSnapshot |
| trigger | object | { type: click\|hover\|keypress\|scroll, target: selector, key?: string } |
| dom_diff | string | What changed |
| screenshot | binary | Screenshot after trigger |
| new_elements_visible | string[] | Selectors of newly visible elements |
| focus_element | string | Where focus moved |

### Finding
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | Primary key |
| page_snapshot_id | uuid | FK → PageSnapshot |
| interaction_state_id | uuid \| null | FK → InteractionState |
| wcag_criterion | string | e.g. "2.4.7" |
| wcag_level | enum | A \| AA \| AAA |
| severity | enum | critical \| major \| minor \| advisory |
| category | enum | contrast \| semantics \| keyboard \| forms \| images \| aria \| structure |
| finding_type_hash | string | Hash of {wcag_criterion, failure_type, platform} for grouping |
| evidence | Evidence | Sub-entity (stored as JSON column) |
| analysis | Analysis | Sub-entity |
| confidence | Confidence | Sub-entity |
| remediation | Remediation | Sub-entity |
| human_review | HumanReview \| null | Sub-entity |

### Evidence (sub-entity of Finding)
| Field | Type | Notes |
|-------|------|-------|
| element_selector | string | CSS selector |
| element_html | string | Outer HTML |
| element_screenshot | binary | Cropped element screenshot |
| element_computed_styles | object | { color, background-color, font-size, outline, border } |
| context_screenshot | binary | Wider area screenshot |
| measured_values | object | { contrast_ratio?, focus_visible?, touch_target_px? } |
| keyboard_sequence | KeyboardEvent[] \| null | For keyboard findings |
| aria_attributes | object | ARIA attrs on element + ancestors |
| detected_by | enum | axe_core \| playwright \| claude_api \| manual |

### Analysis (sub-entity of Finding)
| Field | Type | Notes |
|-------|------|-------|
| method | enum | rule_based \| llm_semantic \| llm_visual \| human |
| reasoning | string | Plain English explanation |
| llm_input | object \| null | { prompt, dom_snippet, screenshot_provided } |
| llm_output | object \| null | { raw_response, model, tokens_used } |
| impact_description | string | How this affects real users |
| affected_users | string[] | ["screen_reader", "keyboard_only", "low_vision", "cognitive"] |

### Confidence (sub-entity of Finding)
| Field | Type | Notes |
|-------|------|-------|
| score | float | 0.0–1.0 |
| tier | enum | definitive \| high \| moderate \| needs_review |
| basis | string | Why this confidence level |
| requires_human | boolean | Triggers consulting engagement |
| false_positive_risk | enum | low \| medium \| high |

### Remediation (sub-entity of Finding)
| Field | Type | Notes |
|-------|------|-------|
| generic_fix | string | Platform-agnostic fix description |
| platform_fix | PlatformFix | Platform-specific steps |
| code_fix | string \| null | Custom code if needed |
| estimated_effort | enum | trivial \| minor \| moderate \| significant |
| fix_verified | boolean | Whether fix was confirmed to work |

### PlatformFix (sub-entity of Remediation)
| Field | Type | Notes |
|-------|------|-------|
| platform | enum | webflow \| squarespace \| shopify \| wordpress \| framer |
| platform_version | string | Platform version at fix generation time |
| steps | string[] | Ordered human-readable instructions |
| designer_path | string | e.g. "Element Settings → Custom Attributes → Add aria-label" |
| screenshots | binary[] | Optional UI screenshots |
| generated_by | enum | template \| llm \| human |
| platform_docs_url | string \| null | Link to platform docs |

### HumanReview (sub-entity of Finding)
| Field | Type | Notes |
|-------|------|-------|
| reviewer | string | Who reviewed |
| reviewed_at | timestamp | When |
| verdict | enum | confirmed \| false_positive \| downgraded \| escalated |
| notes | string | Reviewer notes |
| severity_override | enum \| null | If severity changed |
| remediation_override | string \| null | Custom fix instructions |

### ScanSummary
| Field | Type | Notes |
|-------|------|-------|
| scan_session_id | uuid | FK → ScanSession |
| total_findings | int | Total violations |
| by_severity | object | { critical, major, minor, advisory } |
| by_confidence | object | { definitive, high, moderate, needs_review } |
| by_category | object | { contrast, keyboard, semantics, ... } |
| human_reviewed_pct | float | Percentage verified |
| estimated_total_effort | string | Rough remediation hours |
| wcag_criteria_failed | string[] | Unique criteria violated |
| wcag_criteria_passed | string[] | Criteria tested and passed |

### CriterionResult
| Field | Type | Notes |
|-------|------|-------|
| scan_session_id | uuid | FK → ScanSession |
| wcag_criterion | string | e.g. "2.4.1" |
| status | enum | passed \| failed \| not_applicable \| not_tested |
| tested_by | enum | axe_core \| playwright \| claude_api \| manual |
| evidence_summary | string | Brief description of what was checked |
| finding_ids | uuid[] | Links to Findings if failed |

## Entity Relationships

- ScanSession → many PageSnapshot
- ScanSession → many Finding
- ScanSession → one ScanSummary
- ScanSession → many CriterionResult
- PageSnapshot → many InteractionState
- Finding → one each: Evidence, Analysis, Confidence, Remediation
- Finding → zero or one HumanReview
- Remediation → one PlatformFix
- CriterionResult → many Finding (if failed)
- Finding grouped by finding_type_hash (report rollup + remediation caching)

## Enums Reference

```typescript
type Platform = "webflow" | "squarespace" | "shopify" | "wordpress" | "framer" | "unknown";
type Severity = "critical" | "major" | "minor" | "advisory";
type ConfidenceTier = "definitive" | "high" | "moderate" | "needs_review";
type DetectedBy = "axe_core" | "playwright" | "claude_api" | "manual";
type AnalysisMethod = "rule_based" | "llm_semantic" | "llm_visual" | "human";
type Verdict = "confirmed" | "false_positive" | "downgraded" | "escalated";
type ScanType = "initial" | "rescan" | "monitoring";
type CriterionStatus = "passed" | "failed" | "not_applicable" | "not_tested";
type WcagLevel = "A" | "AA" | "AAA";
type Category = "contrast" | "semantics" | "keyboard" | "forms" | "images" | "aria" | "structure";
type Effort = "trivial" | "minor" | "moderate" | "significant";
type FalsePositiveRisk = "low" | "medium" | "high";
type GeneratedBy = "template" | "llm" | "human";
```

## Conventions

- **UUIDs** for all entity IDs (use `crypto.randomUUID()`)
- **Timestamps** as ISO 8601 strings
- **File paths** relative to configurable data dir (default `./wcag-data/`)
- **Binary files** stored via `files.ts`, referenced by path in SQLite
- **Sub-entities** (Evidence, Analysis, Confidence, Remediation, HumanReview) stored as JSON columns in the Finding table
- **Error handling**: never crash mid-scan. Log errors, mark findings as needs_review, continue.
- **Imports**: use `.js` extensions in import paths (required for ESM with NodeNext)

## Environment Variables

```
ANTHROPIC_API_KEY    — Required. Claude API key.
WCAG_DATA_DIR        — Default: ./wcag-data
WCAG_MAX_PAGES       — Default: 50
WCAG_CONCURRENCY     — Default: 5 (parallel Claude API calls)
WCAG_PROMPT_MODE     — "realtime" | "batch"
```

## Skills

Additional context files for specific domains:

- `.claude/skills/wcag-rules.md` — Coverage map: which criteria are Tier 1-5, detection methods, prompts
- `.claude/skills/webflow-adapter.md` — Webflow-specific patterns, class conventions, CMS templates, IX2
- `.claude/skills/evidence-envelope.md` — Trust chain, Finding validity rules, confidence calibration

Read the relevant skill file before working on any check module, adapter, or evidence-related code.

## axe-core Result Mapping

axe-core returns a different structure than our data model:
- One axe **violation rule** (e.g. "image-alt") → one WCAG criterion (1.1.1)
- One axe **node** within a violation → one **CheckResult** → one **Finding**
- `node.html` → CheckResult.element_html
- `node.target[0]` → CheckResult.element_selector
- `node.failureSummary` → used in Analysis.reasoning
- `violation.impact` (minor/moderate/serious/critical) → mapped to Severity enum
- `violation.tags` → parsed for WCAG criterion codes
- `incomplete[]` → CheckResult with detected_by "axe_core", routed to needs_review
- `passes[]` → CriterionResult with status "passed"

## CMS Crawling Strategy

Webflow CMS sites can have 500+ collection pages sharing a template. Strategy:
1. Detect CMS collections by URL pattern + shared template class structure
2. Crawl 1 full template + 3-5 samples per collection (configurable `--cms-samples`)
3. `--full-crawl` overrides sampling
4. `--max-pages N` with default 50

## Prompt Runner

- **Retry**: max 2 retries on parse failure, same input
- **Fallback**: after retries fail → Finding with confidence "needs_review"
- **Rate limiting**: configurable concurrency (default 5 parallel)
- **Batch mode**: Anthropic batch API at 50% cost for element evaluation calls
- **Logging**: every call logged with prompt name, token count, latency
- **Temperature**: 0 on all calls
- **Model routing**: Sonnet for element eval/forms/remediation, Opus for executive summary
