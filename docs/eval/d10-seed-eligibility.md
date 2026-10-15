# D10 seed eligibility and disputes

Resolved 2026-10-12 against `full_dom` and stored findings in `wcag-data/wcag-old.db`. Every scan hint matched exactly one scan. No hostnames, URLs or markup appear here; targets and fixtures are private (`wcag-data/eval-static/`), and `eval/seed-resolutions.jsonl` (private) links each seed to its scan, snapshots, findings and static cases.

| Seed | Status | Static cases | Evidence | Expectation |
|---|---|---|---|---|
| SL-001 | scan level | LS-047 | No element snapshot | Synthetic: a hidden reCAPTCHA response field must not stall or fail form testing |
| SL-002 | scan level | LS-048 | "Tier 5 should emit some needs_review items"; no concrete element | Kept as a note; not testable |
| SL-003 | **disputed** (new) | LS-040 | The rendered tabs already carry `role="tab"`, `aria-selected` and a `role="tablist"` container; the label may describe pre-script template markup | Not scored until adjudicated |
| SL-004 | resolved | LS-001 | 11 identical FAQ accordion toggles with no `aria-expanded` anywhere; 11 stored 4.1.2 rows | 4.1.2 detected |
| SL-005 | disputed | LS-043 | No `<table>` in any snapshot; fee schedules are div grids | Not scored |
| SL-006 | disputed | LS-044 | No `<nav>` or `role="navigation"` in any snapshot | Not scored |
| SL-007 | resolved | LS-002…LS-009 | 8 image links with no accessible name, repeated on ~15 pages (120 rows) | 2.4.4 detected on each |
| SL-008 | requires rendering | LS-045 | Two reCAPTCHA iframes ("background color could not be determined") and one 3.05:1 button; no element screenshots stored | Not run |
| SL-009 | resolved | LS-010 | Password-gate form; one stored critical 3.3.4 row | 3.3.4 not detected |
| SL-010 | unresolved fixture | LS-046 | The labelled image is in no stored snapshot | Not run; never scored as FN |
| SL-011 | partially resolved (composite) | LS-012, LS-013 | 498 API-failure rows (tooling errors) + 18 duplicate-link rows (a navigation link on 15 pages; two form links on one page) | LS-012: 2.4.4 not detected; LS-013 pending |
| SL-012 | resolved | LS-015…LS-017 | Name, email and tel inputs with valid autocomplete tokens; the 4 stored rows were API failures | 1.3.5 not detected |
| SL-013 | **disputed** (new) | LS-041 | The empty-alt icon sits inside a link whose own visible text names it (conformant decorative use) | Not scored until adjudicated |
| SL-014 | disputed | LS-042 | Skipped heading levels; 5 stored rows, not 9; best practice since `f6389d6` | Not scored (pending Paul) |
| SL-015 | resolved | LS-101…LS-117 | Page-level multiple-ways issue on all 17 pages | 2.4.5 detected, severity advisory |
| SL-016 | scan level | LS-049 | Criteria passed after API credits ran out | Synthetic: API failures and failing checks never produce a pass |
| SL-017 | resolved | LS-014 (and LS-012) | The navigation link with self-describing text | 2.4.4 not detected |
| SL-018 | resolved | LS-011 | Same form as SL-009 in a later snapshot | 3.3.4 not detected |

Alt-text static runs send no image: production alt-text requests carry the fetched image, so the static request is a separate input variant, and an old finding's `element_screenshot` is not treated as the image the model received.
