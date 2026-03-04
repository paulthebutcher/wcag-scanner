# Evidence Envelope — Trust Chain & Validation Rules

Read this before working on `/src/core/evidence.ts`, `/src/core/confidence.ts`, or any code that creates/modifies Findings.

## Trust Chain

Every finding flows through five stages. Each is a separate entity because they're produced by different systems at different times.

```
Detect (Evidence) → Analyze (Analysis) → Score (Confidence) → Fix (Remediation) → Verify (HumanReview)
```

## Immutability Rules

**Evidence is immutable.** Once `evidence.ts` creates an Evidence sub-entity, it is NEVER modified. No update function should exist for Evidence fields.

- Screenshots: stored once via `files.ts`, path never changes
- DOM snapshots: captured once, stored as string
- Measured values: recorded at capture time, never recalculated
- ARIA attributes: snapshot of DOM state at detection time

**Everything else is mutable.** Analysis, Confidence, Remediation, and HumanReview can be updated. This is intentional — you should be able to re-analyze findings with a new prompt version without touching evidence.

## Finding Creation Flow

`evidence.ts` is the only module that creates Findings. The flow:

1. Receive `CheckResult` from a check module
2. Capture element screenshot — crop from full-page screenshot using bounding box (via Sharp)
3. Capture context screenshot — wider area around element
4. Collect computed styles for relevant CSS properties
5. Collect ARIA attributes from element and ancestors (walk up DOM)
6. Generate `finding_type_hash` from `{wcag_criterion, failure_type, platform}`
7. Assemble Finding with Evidence sub-entity
8. Persist via `store/db.ts` and `store/files.ts`
9. Return Finding (without Analysis, Confidence, Remediation — those are added later by other modules)

## finding_type_hash

Groups identical violation patterns. A site with 50 missing alt texts = 50 Findings with the SAME hash.

```
hash = deterministic_hash({
  wcag_criterion: "1.1.1",
  failure_type: "empty_alt_on_informative",
  platform: "webflow"
})
```

Used for:
- Report rollup: "50 images missing alt text" with expandable instances
- Remediation caching: generate fix once per hash, apply to all instances
- Before/after diff: same hash in two scans = persistent vs resolved

Use a stable hash function (e.g., SHA-256 of sorted JSON). Must be deterministic — same inputs always produce same hash.

## Confidence Scoring Rules

`confidence.ts` scores each Finding based on detection method and criterion:

### Tier Assignment

| Detection method | Default tier | Score range |
|-----------------|-------------|-------------|
| axe_core | definitive | 0.95-1.0 |
| playwright (behavioral) | high | 0.80-0.94 |
| claude_api (semantic) | high or moderate | 0.50-0.89 |
| indicators (Tier 5) | needs_review | 0.30-0.60 |

### Specific Calibration

**axe-core findings → definitive (0.95+)**
- axe rules are binary: element has or doesn't have the attribute/value
- Exception: axe `incomplete[]` results → needs_review (0.40-0.60)

**Playwright behavioral → high (0.80-0.94)**
- Keyboard reachability: definitive (element is or isn't reachable)
- Focus visible: high (screenshot comparison is reliable)
- Focus order: moderate to high (visual order comparison has edge cases)
- Keyboard traps: high (cycle detection is reliable)

**Claude semantic → varies by prompt**
- Prompt 1 (alt text): 0.50-0.89 depending on failure mode
  - filename_as_alt: 0.85+ (obvious)
  - decorative_vs_informative: 0.50-0.64 (subjective)
- Prompt 2 (link text): 0.65-0.90+
  - "click here": 0.90+ (definitive)
  - ambiguous_without_context: 0.65-0.84 (contextual)
- Prompt 3 (headings): 0.50-0.95+
  - skipped_level: 0.95+ (structural fact)
  - style_not_structure: 0.50-0.64 (hard to prove)
- Prompt 4 (color): 0.50-0.85+
  - link_color_only: 0.85+
  - chart_color_only: almost always needs_review
- Prompts 5-6 (consistency): 0.70-0.95+
  - order_changed: 0.95+ (structural fact)
  - similar but not identical labels: 0.70-0.84

### requires_human Flag

Set `requires_human = true` when:
- confidence.tier === "needs_review"
- confidence.tier === "moderate" AND severity === "critical" or "major"
- criterion is in Tier 5 (indicators)
- Claude returned `requires_human_verification: true` in prompt response
- false_positive_risk === "high"

### false_positive_risk

| Detection | Criterion type | Risk |
|-----------|---------------|------|
| axe_core | Any | low |
| playwright | Keyboard reachability | low |
| playwright | Focus order | medium |
| claude_api | Alt text quality | medium |
| claude_api | Link text quality | low-medium |
| claude_api | Heading structure (skipped_level) | low |
| claude_api | Heading structure (style_not_structure) | high |
| claude_api | Use of color | medium-high |
| claude_api | Consistent navigation | low |
| indicator | Any | high |

## Severity Definitions

Used in Analysis.impact_description and Prompt 14 (Impact Description):

| Severity | Definition | Example |
|----------|-----------|---------|
| critical | Completely blocks access for one or more disability groups | No keyboard access to primary navigation |
| major | Significantly impairs access, workaround possible but difficult | Form errors not programmatically associated with fields |
| minor | Creates friction, user can still complete task | Link text says "Read more" but context makes destination clear |
| advisory | Best practice, not a WCAG AA failure | Heading is descriptive but could be more specific |

## Affected Users Categories

Standard categories for Analysis.affected_users:

- `screen_reader` — blind or low vision users using NVDA, JAWS, VoiceOver
- `keyboard_only` — motor impairments, can't use mouse
- `low_vision` — use magnification, need high contrast, large text
- `cognitive` — processing disorders, need clear labels, consistent navigation
- `deaf_hard_of_hearing` — need captions, visual alternatives to audio
- `motor_limited` — limited dexterity, need large touch targets, no complex gestures
- `photosensitive` — seizure risk from flashing content

## Report Grouping Rules

When generating reports, findings group by `finding_type_hash`:
- Each group shows: criterion, failure type, instance count, severity, remediation
- Individual instances are expandable with page URL, element screenshot, HTML snippet
- Remediation generated once per group, not per instance
- Sorting: groups by severity (critical first), then instance count (descending)
- Before/after diff uses hash to classify: resolved (in old not new), new (in new not old), persistent (in both)

## CriterionResult Rules

Every WCAG criterion tested gets a CriterionResult entry, regardless of pass/fail:

- **passed**: tested, no violations found. Evidence summary says what was checked.
- **failed**: tested, violations found. finding_ids links to specific Findings.
- **not_applicable**: criterion doesn't apply (e.g., no video = 1.2.x not applicable)
- **not_tested**: criterion exists but wasn't tested in this scan (e.g., --tiers flag excluded it)

"We tested 2.4.1 using Playwright and found a functional skip-to-content link" is legally stronger than just not listing it as a failure. Always create CriterionResult entries.
