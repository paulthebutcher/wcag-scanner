# WCAG Coverage Map — Quick Reference

Read this before working on any check module. It tells you which tier each criterion belongs to, what detection method to use, and which prompts apply.

## Tier Overview

| Tier | Method | Confidence | Criteria Count |
|------|--------|------------|----------------|
| 1 | axe-core rules against rendered DOM | definitive | ~20 |
| 2 | Playwright behavioral (keyboard, focus, interaction) | high | ~8 |
| 3 | Claude API semantic evaluation | high to moderate | ~7 |
| 4 | Playwright form submission + Claude error evaluation | high to moderate | ~5 |
| 5 | Automated indicator + human judgment | needs_review | ~9 |

Zero criteria have zero coverage. Every criterion gets touched.

## Tier 1 — axe-core (Definitive)

Module: `/src/checks/automated/`

| Criterion | Name | What axe checks |
|-----------|------|-----------------|
| 1.1.1 | Non-text Content | Presence of alt (quality checked separately in Tier 3) |
| 1.3.1 | Info and Relationships | Heading hierarchy, landmarks, table structure, label associations |
| 1.3.2 | Meaningful Sequence | DOM order vs visual order |
| 1.3.3 | Sensory Characteristics | Instructions relying solely on sensory characteristics |
| 1.3.4 | Orientation | Not locked to single orientation |
| 1.3.5 | Identify Input Purpose | Autocomplete attributes present |
| 1.4.1 | Use of Color | Partial — color-only indicators (supplemented by Claude Prompt 4) |
| 1.4.3 | Contrast Minimum | 4.5:1 normal, 3:1 large text |
| 1.4.4 | Resize Text | Usable at 200% zoom |
| 1.4.5 | Images of Text | Text rendered as images |
| 1.4.10 | Reflow | Reflows at 320px without horizontal scroll |
| 1.4.11 | Non-text Contrast | 3:1 for UI components and graphical objects |
| 1.4.12 | Text Spacing | Adapts to user text spacing overrides |
| 1.4.13 | Content on Hover or Focus | Dismissable, hoverable, persistent (also Prompt 8) |
| 2.4.1 | Bypass Blocks | Skip navigation link exists |
| 2.4.2 | Page Titled | Descriptive title exists |
| 2.4.4 | Link Purpose | Partial — generic "click here" (quality via Claude Prompt 2) |
| 3.1.1 | Language of Page | lang attribute on html |
| 3.1.2 | Language of Parts | lang on content in different languages |
| 4.1.2 | Name, Role, Value | Programmatic name/role for all UI components |

## Tier 2 — Playwright Behavioral (High)

Module: `/src/checks/behavioral/`

| Criterion | Name | Playwright test | File |
|-----------|------|-----------------|------|
| 2.1.1 | Keyboard | Tab to all interactive elements, verify reachable + activatable | keyboard.ts |
| 2.1.2 | No Keyboard Trap | Tab through entire page, detect focus cycles | keyboard.ts |
| 2.1.4 | Character Key Shortcuts | Detect single-char shortcuts, check remap | keyboard.ts |
| 2.4.3 | Focus Order | Record tab sequence, compare to visual layout | focus-order.ts |
| 2.4.7 | Focus Visible | Screenshot each tab stop, measure indicator contrast ≥3:1 | focus-visible.ts |
| 2.5.1 | Pointer Gestures | Detect swipe/pinch, verify single-pointer alternatives | (future) |
| 2.5.2 | Pointer Cancellation | Click fires on up-event not down | (future) |
| 3.2.1 | On Focus | Tab to each element, verify no unexpected context changes | keyboard.ts |

## Tier 3 — Claude Semantic (High to Moderate)

Module: `/src/checks/semantic/`

| Criterion | Name | Prompt | Vision? |
|-----------|------|--------|---------|
| 1.1.1 | Non-text Content (quality) | Prompt 1: Alt Text Quality | Yes |
| 1.4.1 | Use of Color (context) | Prompt 4: Use of Color | Yes |
| 2.4.4 | Link Purpose (quality) | Prompt 2: Link Text Quality | No |
| 2.4.6 | Headings and Labels | Prompt 3: Heading Structure | No |
| 3.2.3 | Consistent Navigation | Prompt 5: Consistent Navigation | No |
| 3.2.4 | Consistent Identification | Prompt 6: Consistent Identification | Yes |
| 3.3.2 | Labels or Instructions | Prompt 7: Labels or Instructions | Yes |

## Tier 4 — Form Testing (High to Moderate)

Module: `/src/checks/forms/`

| Criterion | Name | Prompt | Vision? |
|-----------|------|--------|---------|
| 3.3.1 | Error Identification | Prompt 9: Error Message Quality | Yes |
| 3.3.3 | Error Suggestion | Prompt 9: Error Message Quality | Yes |
| 3.3.4 | Error Prevention | Prompt 10: High-Risk Form Detection | Yes |
| 3.2.2 | On Input | Playwright behavioral (no prompt) | — |
| 1.3.5 | Identify Input Purpose (deep) | Prompt 11: Input Purpose Matching | No |

## Tier 5 — Human Judgment Indicators (needs_review)

Module: `/src/checks/indicators/`

| Criterion | Name | What to surface |
|-----------|------|-----------------|
| 1.3.6 | Identify Purpose | Check autocomplete values, Claude guesses correct value |
| 2.2.2 | Pause, Stop, Hide | Detect CSS animations, carousels, check for pause mechanism |
| 2.3.1 | Three Flashes | Flag animations <350ms, GIFs, videos. Auto-pass if none. |
| 2.4.5 | Multiple Ways | Pattern-match for nav, search, sitemap, TOC, breadcrumbs. Pass if 2+. |
| 2.5.4 | Motion Actuation | Scan JS for devicemotion/deviceorientation. Pass if none. |
| 3.2.2 | On Input (complex) | Change every input, check for unexpected state changes |
| 3.3.1 | Error ID (semantic) | Claude evaluates if error messages make sense |
| 3.3.3 | Error Suggestion (quality) | Claude evaluates if errors suggest how to fix |
| 3.3.4 | Error Prevention | Claude classifies form risk, checks safeguards |

## Prompt Index

| # | Name | Family | Model | Vision | Calls/site |
|---|------|--------|-------|--------|------------|
| 1 | Alt Text Quality | Element Eval | Sonnet | Yes | 30-100 |
| 2 | Link Text Quality | Element Eval | Sonnet | No | 30-100 |
| 3 | Heading Structure | Element Eval | Sonnet | No | 30 (1/page) |
| 4 | Use of Color | Element Eval | Sonnet | Yes | 10-30 |
| 5 | Consistent Navigation | Element Eval | Sonnet | No | 1 |
| 6 | Consistent Identification | Element Eval | Sonnet | Yes | 1-5 |
| 7 | Labels or Instructions | Element Eval | Sonnet | Yes | 5-15 |
| 8 | Content on Hover/Focus | Element Eval | Sonnet | Yes | 5-20 |
| 9 | Error Message Quality | Form | Sonnet | Yes | 5-15 |
| 10 | High-Risk Form Detection | Form | Sonnet | Yes | 2-5 |
| 11 | Input Purpose Matching | Form | Sonnet | No | 5-10 |
| 12 | Remediation Generation | Remediation | Sonnet | Yes | 20-50 |
| 13 | Remediation Verification | Remediation | Sonnet | No | 20-50 |
| 14 | Impact Description | Synthesis | Sonnet | No | 20-50 |
| 15 | Executive Summary | Synthesis | Opus | No | 1 |

**Total per 30-page site:** ~360 Sonnet + 1 Opus. Estimated cost: $5-15 ($3-8 with batch API).

## Shared Prompt Output Schema (Element Evaluation Family)

All 8 element evaluation prompts return:
```json
{
  "verdict": "pass | fail | needs_review",
  "confidence": 0.0-1.0,
  "reasoning": "string",
  "wcag_criterion": "string",
  "failure_type": "string | null",
  "suggestion": "string | null",
  "affected_users": ["string"],
  "requires_human_verification": true/false
}
```

## Pipeline Execution Order

1. Crawl + capture (no Claude calls)
2. Tier 1: axe-core automated (no Claude calls)
3. Tier 2: Playwright behavioral (no Claude calls)
4. Tier 3: Claude semantic evaluation (~300 calls)
5. Tier 4: Form testing + Claude evaluation (~20 calls)
6. Tier 5: Indicator gathering + flagging
7. Confidence scoring (rule-based, no Claude)
8. Remediation generation (~20 calls, 1 per finding_type_hash)
9. Report synthesis (~20 impact + 1 summary)
10. Human review (no Claude)
11. Re-scan + verification (~20 calls)
