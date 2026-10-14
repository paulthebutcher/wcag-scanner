# Phase 1 Frozen evaluation harness and accuracy review workflow

## Mission

Build the evidence and regression infrastructure needed to improve the WCAG Engine for municipal governments using Webflow. Preserve production detection behavior throughout this phase.

Deliver a replayable corpus, a regression comparison against `baseline-2026-10-04`, a resolved Lakewood regression set, a local labeling and independent audit screen, and metrics whose denominators and limitations are explicit.

Phase 1 is complete when this infrastructure works and reports existing defects honestly. Completion does not establish that the engine is ready to sell or that a scanned website conforms to WCAG.

Implement the deliverables below. Do not implement detector fixes, a judge, production report changes, or recurring scheduling.

## Scope and evaluation claims

Use WCAG 2.1 Level A and AA as the municipal evaluation target. Record WCAG 2.2 checks separately if the engine already implements them. The DOJ identifies WCAG 2.1 Level AA as the technical standard in its [Title II web rule fact sheet](https://www.ada.gov/resources/2024-03-08-web-rule/). Do not encode compliance deadlines in this harness.

Create `eval/scope.json` before selecting evaluation cases. It must enumerate each criterion, implemented check IDs, supported failure types where known, evidence requirements, and whether coverage is full, partial, manual, or unsupported. Describe a check's actual capabilities; the existence of one check does not establish full criterion coverage. Unknown coverage remains unknown.

Freeze and hash scope for each comparison. A narrower scope cannot make a run pass by removing previously evaluated defects. Scope changes require a new evaluation contract and an explicit report of removed coverage.

The first corpus covers public Webflow HTML pages and the interactions the engine currently exercises. PDFs, office documents, authenticated services, mobile apps, and external transaction portals are outside this phase's detection evaluation. Inventory their presence privately when encountered and report the coverage limitation in aggregates. Do not infer that Webflow page coverage includes linked government services.

Use these names consistently:

| Result | What it establishes |
| --- | --- |
| Regression comparison | Whether specified known behavior worsened on identical frozen inputs |
| Reviewed finding precision | Precision among the findings actually selected and reviewed |
| Probability sample precision | Precision estimated from a documented probability sample of findings |
| Known defect recall | Recall on resolved historical or deliberately selected positive cases |
| Audited scope recall | Recall against independent annotations of a declared page and interaction sample within the frozen scope |
| Replay repeatability | Whether frozen inputs and stored model responses reproduce results |
| Model agreement | Agreement across fresh model responses to identical frozen requests |

Do not label selected-case recall as general recall. Do not label enriched queue precision as overall precision. W3C explains the need for human judgment in [Selecting Web Accessibility Evaluation Tools](https://www.w3.org/WAI/test-evaluate/tools/selecting/); use [WCAG EM](https://www.w3.org/WAI/test-evaluate/conformance/wcag-em/) as guidance for representative pages and complete processes.

## Read first and report before implementation

Read:

1. Applicable `AGENTS.md` files, `CLAUDE.md`, `CHANGELOG.md`, `KNOWN_ISSUES.md`, `package.json`, lockfile, and test configuration.
2. `eval/seed-labels.jsonl`, including schema, count, provenance, and linking fields.
3. `src/types.ts`, `src/store/db.ts`, `src/core/scanner.ts`, `src/core/prompt-runner.ts`, `src/core/crawler.ts`, `src/core/coverage.ts`, `src/core/evidence.ts`, `src/adapters/webflow.ts`, and `src/cli/`.
4. All model call sites and image paths. Search `imageBase64`, `imageProvider`, `screenshotProvider`, `createPromptRunner`, and Anthropic client use throughout `src/`.
5. `src/checks/semantic/image-fetch.ts`, `src/checks/forms/submission.ts`, `src/checks/forms/error-evaluation.ts`, and the behavioral checks. Inspect submission interception, screenshot creation, and keyboard evidence rather than relying on comments.
6. `wcag-data/baselines/2026-10-04/README.md`, the baseline tag, the baseline scanner interfaces, and its separate database.
7. Crawler URL-list handling, redirects, robots rules, pacing, user agent, noindex exclusions, and every browser/context creation path at HEAD and baseline.

Checkpoint 0 must report the exact starting SHA and clean-tree status; baseline resolution; stores and schemas; network and model entry points; vision inputs; coverage support; seed resolution gaps; and proposed transport hooks and baseline bridge.

Use these as observed starting facts to verify, not as instructions to manufacture expected results:

| Item | Expected starting state |
| --- | --- |
| Baseline tag | `baseline-2026-10-04` resolves to `ffdcd308610527525fb82ccd118a7f7b89334b66` |
| Historical baseline scan | `77a43f3b-9ec7-4dd3-9ce9-ec2fbc172fce`, 50 pages, 1,549 findings, separate older-schema store |
| Seed labels | 18 rows; no `resolved_scan_id` or `finding_ids` fields |
| Popfly tuning page list | Scan prefix `ee56b381` in the current store, 50 pages |
| Lakewood tuning page list | Scan prefix `1a6e3c3e` in the old store, 17 pages |
| Alt-text vision input | Source image fetched through Node `fetch`, resized to PNG; not necessarily a screenshot of the element |
| High-risk form vision input | Optional screenshot provider exists but is not wired by the scanner |
| Error evaluation vision input | `SubmissionState.screenshotAfter`, with an optional provider override |
| Keyboard evidence | Behavioral checks do not currently populate `CheckResult.keyboard_sequence` |
| Submission interception | Selected POST requests are blocked; the comment also mentions GET blocking that the implementation does not provide |
| Crawler | Normal discovery parses basic wildcard robots disallows; URL-list mode bypasses robots discovery; Node fetches are outside browser HAR routing |
| Cache | In-scan cache omits model ID and system prompt |

If the baseline resolves to another commit or a prefix resolves to multiple scans, stop that dependent work and report the ambiguity. Do not overwrite data or guess a scan. Other factual differences should be reported with their effect on the plan.

Checkpoint 0 is informational unless it exposes a decision that requires Paul. Continue authorized implementation when there is no unresolved decision.

## Invariants

1. **Preserve production detection.** Do not edit `src/checks/**`, `src/core/analyzer.ts`, `src/core/confidence.ts`, `src/core/evidence.ts`, or `src/prompts/**`. Eval code may import exported functions. Any transport or observation hook in `scanner.ts`, `crawler.ts`, or `prompt-runner.ts` must be explicit, default off, and avoid candidate, verdict, severity, confidence, or remediation changes.
2. **Prove the default path unchanged.** Save the pre-harness source SHA. Compare that version with the implementation using a local frozen fixture server and identical injected prompt results, with eval flags off in both. Compare normalized findings, criterion statuses, and coverage where available. Use image, form, keyboard, and DOM paths; do not rely on a fresh live model response as the oracle.
3. **Keep evidence immutable.** Captures and model response entries are immutable. Refresh creates a new corpus version. A run pins all artifact hashes and never silently uses a later label, image, or cache revision.
4. **Protect the original labels.** `eval/seed-labels.jsonl` is read-only. Human labeling is append-only in `eval/labels.jsonl`. Link historical labels using a sidecar; never repair the seed in place.
5. **Keep municipal content private.** Private files include URLs and their map, labels, cases, findings, HTML, screenshots, HARs, frames, raw requests and responses, and per-site results. Add explicit ignore rules for private files under `eval/`, including `eval/labels.jsonl`. Commit only pseudonymous corpus inventory, non-content configuration, and sanitized aggregate results. Test serialization against municipal hostnames, URL fields, and HTML leakage.
6. **Official runs require a clean tree.** Record dirty state for every run. Refuse official metrics and gate decisions on a dirty tree. Ignored private evidence is permitted only through pinned hashes. Write official outputs outside the tracked tree, then export sanitized results for a later commit.
7. **Replay fails closed.** No external site or model network access is permitted in replay. Missing required artifacts or cache responses invalidate the run. Diagnostic runs may continue to collect errors, but cannot produce an official pass.
8. **Model images come from recorded inputs.** The request sent to the model, or used for its cache key, uses recorded model image bytes or a recorded no-image state. A diagnostic screenshot rendered during replay may be retained for browser evidence, but must never substitute for a model image or influence its cache key.
9. **Separate errors from defects.** Tooling errors, unknown matches, partial checks, skipped checks, and abstentions remain visible. Excluding them from precision must not turn them into passes or remove their coverage denominators.
10. **Seal holdout content.** All commands except passive capture and checksum verification exclude holdout by default. Any later content access requires the explicit split and an unseal reason. Phase 1 must not inspect, label, scan, summarize, or run model calls on holdout content after capture.
11. **Review remains local.** Bind only to `127.0.0.1`, serve no external assets, render captured HTML as escaped text, and expose replayed pages through controlled browser actions rather than executing their HTML inside the review application. Mutating endpoints must reject cross-origin requests and use a per-session token.

Stop and report if a protected detection file must change. Do not fix the detector to make the harness pass. Existing engine defects belong in the Phase 2 ledger.

## Shared commands and storage contracts

Use `wcag eval` as a thin CLI over modules in `src/eval/`. Place tests under `test/eval/` so the existing Vitest include pattern discovers them. Keep UI files under an eval-specific directory. Do not put evaluation logic in CLI handlers.

Every producing command returns its run ID and manifest path. Every consuming command accepts a run ID or immutable corpus version. Never resolve a mutable `latest` reference during an official run.

| Command | External website access | Model access |
| --- | --- | --- |
| `pilot`, using local fixtures | None | None; injected deterministic responses |
| `admit` | Passive Webflow and page discovery under capture etiquette | None |
| `capture` | Allowed under capture etiquette | None |
| `record` | None; frozen browser inputs only | Allowed explicitly with a cost budget |
| `replay` | None | None |
| `review`, `audit`, `pace`, `compare`, `metrics`, `static` replay | None | None |
| `model-canary` | None | Allowed explicitly with a cost budget |

Use the following layout. Additional files must follow the same privacy boundary.

```text
eval/
  scope.json                         committed coverage claims
  config.json                        committed gate and sampling policy
  corpus.json                        committed pseudonymous inventory and hashes
  seed-labels.jsonl                   committed and read-only
  label-overrides.json                committed seed disputes and reasons
  lakewood-static.json                committed resolved tuning expectations
  baseline-bridge/                    committed transport-only patch or adapter
  labels.jsonl                       PRIVATE append-only labels and undo records
  cases.jsonl                        PRIVATE append-only case definitions
  seed-resolutions.jsonl              PRIVATE links into historical evidence
  sampling.private.json              PRIVATE sample membership and probabilities
  holdout-access.log                  committed access metadata without content
  phase2-defects.jsonl                committed sanitized defect summaries
  runs/<run-id>/                      committed sanitized aggregate exports
  baselines/2026-10-04/               committed sanitized reference exports

wcag-data/eval-corpus/
  sites.private.json                 domains, page URLs, groups, frozen splits
  builtwith.csv                      Paul's input
  <corpus-version>/<split>/<site-id>/<page-id>/
    page.har
    dom.html
    screenshot.png
    images/index.json
    images/<artifact-id>.png
    capture.private.json

wcag-data/eval-cache/<namespace>/     immutable model requests and responses
wcag-data/eval-runs/<run-id>/         manifests, private results, frames and logs
wcag-data/eval-worktrees/            isolated source checkouts and data
```

Assign and persist site IDs and page IDs, such as `m01` and `p001`. Stable IDs survive corpus versions; artifacts and cases remain bound to the version that supplied their evidence. URL canonicalization and redirects live in the private map. Do not use finding UUIDs or `finding_type_hash` as semantic identity.

## D8 Run manifests and evaluation contracts

Implement this first. Each manifest must include:

- Run ID, command, UTC timestamps, purpose, completion state, and any parent run IDs.
- Engine SHA, pre-harness SHA where relevant, harness SHA, dirty state, and effective source hash for a baseline bridge.
- Node, OS, lockfile hash, Playwright, browser build, axe-core and SDK versions.
- Check selection, tiers, scope hash, viewport, device scale, locale, timezone, browser settings, page ordering, concurrency, and readiness policy.
- Corpus version, split selection, exact admitted page-set hash, artifact hashes, and exclusions.
- Cache namespace, content hashes of entries read or created, resolved model IDs, template and system hashes, request parameters, and image input index hashes.
- Snapshots or hashes of labels, cases, resolutions, overrides, static expectations, sampling definitions, adjudication state, and gate configuration. Hashes alone are insufficient if the corresponding immutable input cannot be recovered.
- Coverage, tooling-error, abstention, ambiguity, image-miss, HAR-miss, cache-miss, and attempted-egress totals.
- Run validity, metric limitations, and reasons for any unavailable result.

Capture-only runs record unavailable scanner and label fields as not applicable. Do not require files that have not yet been created. Artifact and cache readers must verify pinned hashes.

Add schema validation and manifest tests. Distinguish `diagnostic`, `official-regression`, `official-accuracy`, and `model-canary` purposes. A successful command is not automatically an official valid evaluation.

## D0 Feasibility pilot and baseline bridge

Complete this before capturing the full tuning corpus or building the full review UI.

Create a local Webflow fixture with a source image, a form with client-side errors, a GET submission, POST/fetch/XHR submission attempts, links, keyboard navigation, a modal, and a request absent from its HAR. Include an external-looking fetch in the Node path. Use deterministic injected prompt responses and record fixture provenance.

Prove the sequence capture, request collection, response recording, and replay at both the pre-harness HEAD and historical baseline. Also test one subsequently captured tuning page with images, forms, and keyboard interactions; if no single permitted tuning page covers all three, use the smallest documented set.

The pilot must prove:

1. Every browser context, reload, redirect helper, Node fetch, model call, and replay browser launch goes through a controlled transport boundary.
2. Browser HTTP routing, service workers, WebSockets, and Node HTTP paths cannot escape the offline boundary. Disable service workers in eval contexts unless a tested alternative fully contains them. Add an independent egress-denial check covering both Node and the browser; record its implementation and observed attempts.
3. HAR routing composes correctly with the existing page-level submission interceptor. A non-blocked `route.continue()` must not bypass the replay route. See Playwright's [routing precedence](https://playwright.dev/docs/api/class-browsercontext#browser-context-route) and [strict HAR request matching](https://playwright.dev/docs/mock#replaying-from-har).
4. Request collection reaches image providers and submission-state images without making any model call. An absent API key must not silently skip the paths that need capturing.
5. A valid production no-image request remains a no-image request. The baseline is not enriched with HEAD images or prompts.
6. With eval flags off, the normalized production results before and after the hooks are identical on the local fixtures. Use deterministic responses and identical resources; discard timestamps, UUIDs, file locations, and timing measurements from comparison.

Use existing injection points where sufficient. The historical baseline needs a documented bridge because its crawler creates its own browser and lacks the new flags. Prefer a thin adapter; if source changes are necessary, store a minimal transport-only patch under `eval/baseline-bridge/`. It may touch only the same permitted orchestration files. Record original SHA, patch hash, effective source hash, and compatibility tests. Never merge detector or prompt changes into that checkout.

The baseline bridge must also be reusable by D10's static runner without copying HEAD check implementations into the baseline. If a required historical function is not exported, report the limitation and obtain a scoped plan amendment rather than editing protected checks.

Acceptance: both versions complete offline fixture replay; missing artifacts and attempted egress are detected; default-path equivalence passes. If the bridge or transport boundary is infeasible under the invariants, stop expansion and report the smallest required amendment.

## D1 Capture and immutable corpus versions

```text
wcag eval capture --site <id> --split tuning|dev|holdout --urls <private-file> --version <id>
wcag eval verify-corpus --version <id>
```

Only `admit` and `capture` may contact websites. `record` contacts the model provider but serves all site resources from the frozen corpus.

### Capture etiquette

- Require `EVAL_CONTACT_URL`; use `WCAGEngine-Eval/0.1 (+<EVAL_CONTACT_URL>)` for browser and Node requests.
- Allow one active page visit per host, with at least three seconds between top-level loads, including reloads and interaction-driven navigations. Use a larger applicable robots crawl delay.
- Fetch and evaluate robots before visiting a supplied URL list. Do not inherit URL-list mode's current bypass. Record robots content privately, its hash publicly, and skipped URLs privately. Define robots retrieval failure policy explicitly; do not silently assume unrestricted access on an error.
- Honor applicable user-agent groups and disallows. Test the supported parser behavior, including crawl delay. Check destination hosts for cross-host discovery or navigation.
- Never exercise a real submission endpoint during capture. Before any live capture, prove the eval transport blocks submission attempts in the local fixture for POST, GET navigation, fetch/XHR, and other mutation methods used by the fixture. Preserve ordinary page loading and read-only resources. Keep this containment in the eval transport; do not edit form check code.
- If a form's submission cannot be safely distinguished from ordinary GET navigation, do not activate it during live capture. Record that interaction as uncaptured and require a local fixture or explicit later scope decision. Do not pretend a blocked server response demonstrates server-side error handling.
- Limit each site's evaluation capture to 30 selected pages. Record all discovery and capture omissions. Include noindex public pages when selected for an accessibility-relevant task; noindex does not itself make a page out of scope.

Admission requests and passive discovery follow the same user agent, robots, concurrency, and pacing policy. Cache admission metadata so repeatedly checking Webflow does not cause unnecessary visits.

### Tuning page selection

Use Popfly scan `ee56b381` and Lakewood scan `1a6e3c3e` as candidate page lists. Resolve unique full scan IDs before selection.

Popfly has 50 candidates: choose and freeze at most 30. Lakewood has 17 candidates: retain all permitted, in-scope candidates. Select home, distinct templates, forms, and useful interactions, then fill remaining slots deterministically by canonical URL. Record the selection algorithm, candidate count, and omissions before scoring either engine. Do not select pages based on which engine performs better.

### Per-page artifacts

Record HAR with embedded response content, serialized DOM, full-page screenshot, browser storage state when needed for reproduction, request and interaction logs, and a private manifest. Include capture timestamps, versions, viewport, locale, timezone, readiness milestones, user agent, robots hash, source URL and final URL. Flush HARs by closing their recording contexts before hashing them.

Capture resources needed by the existing interactions as well as initial page loading. Check fonts and late-injected widgets. A HAR plus a DOM is not assumed to reproduce application state; D2 must verify it.

### Model input image store

During tuning/dev capture, use a request-collection runner that exercises the existing candidate paths but makes no model calls. Its synthetic results and findings are capture-only artifacts and must never enter metrics or labels.

Store the exact preprocessed image bytes that production would supply. Do not wire the unused high-risk screenshot provider or substitute an element crop for a source image. Capturing richer inputs is later detector work.

Each index entry contains corpus version, engine input variant, site/page ID, check and call-site ID, element locator or source identity, interaction scenario and step, occurrence discriminator, media type, image state, artifact path if present, and SHA-256. Use these fields to derive a collision-resistant key. Fail on an ambiguous or conflicting key; never overwrite an image.

Image states are `present`, `absent_by_design`, and `unavailable_at_capture`. The latter records the original fetch/decode failure and whether production continued text-only. A missing expected file is an image miss. A recorded no-image state is not a missing file. Report unavailable images as evidence limitations.

The HEAD and historical baseline may require different input variants. Record each version's actual request and image behavior; do not force them to share inputs they did not originally use.

At the prompt boundary, replay replaces any generated screenshot payload with the indexed image bytes, or the indexed no-image state, before building a request or key. Verify image provenance there. Existing checks may still render screenshots for their own browser evidence; those bytes are not model inputs.

Refresh requires a new version, explicit page IDs, and a reason. Preserve the old version and invalidate no past run.

### Holdout capture

In Phase 1, holdout capture is passive: acquire HAR, DOM, screenshot and capture metadata, then seal it. Do not run active scanner checks, collect model requests, or generate interaction image variants on holdout. Report only artifact checksums and capture success metadata. Full interaction and model-input preparation waits for a later logged unseal.

Acceptance: both tuning corpora are versioned, selected pages and omissions are frozen, checksums verify, and logs prove etiquette. All model images requested during D3 must resolve to their recorded states; uncovered calls invalidate that engine/corpus run.

## D2 Offline replay and capture admission

```text
wcag eval replay --engine <sha> --corpus <version> --split tuning --cache <namespace>
```

Serve browser resources through HAR replay with `notFound: 'abort'`. Route every browser context, popup, reload, and review replay launch through the same boundary. Replace Node discovery and fetch paths with recorded inputs or prevent their execution. Deny external egress independently of HAR routing.

Freeze page order, browser settings, initial storage, concurrency, and readiness rules. Record randomness/time controls if used; apply the same controls to both compared engines and do not freeze time in a way that prevents existing checks from completing.

Verify live-capture versus replay fidelity on the pilot: relevant DOM, loaded resources, rendered layout, image inputs, and interaction milestones. Document expected nondeterministic fields rather than requiring byte-identical HTML where generated IDs differ. Do not normalize away accessible names, ARIA state, focus, contrast, or meaningful content.

Distinguish intentional denied requests from unexpected HAR misses. Analytics or telemetry exclusions must be declared and versioned before the official run, with evidence that their absence does not remove evaluated functionality. Log both categories. Unexpected missing content, fonts, scripts, images or interactions invalidate replay even when the page superficially loads.

If a selected page cannot replay, repair capture or create a new candidate corpus version with an explicit exclusion. Never drop it dynamically from a completed run. Report exclusion counts and feature distribution. More than 20% excluded for replay failure on either tuning site blocks corpus acceptance. Below that threshold, all admitted evaluation pages still require complete replay; the threshold is not permission to tolerate misses inside a run.

Acceptance: full five-tier replay of the admitted tuning corpus with zero unexpected HAR, image or cache misses and zero external egress. Denial tests must prove failures are detected even when scanner error handling catches exceptions.

## D3 Persistent response cache and repeatability

```text
wcag eval record --engine <sha> --corpus <version> --split tuning --cache <namespace> --max-cost-usd <amount>
wcag eval replay --engine <sha> --corpus <version> --split tuning --cache <namespace> --repeat 3
```

`record` uses frozen site inputs and may call the model provider. Require an explicit budget, record estimated and actual usage, and stop starting new calls when the budget is exhausted. An incomplete record is not an official evaluation. `replay` never falls back to a live call.

Hash the canonical effective request: resolved model ID, template name and content hash, complete system prompt, user message, image SHA and media type or no-image sentinel, output configuration/schema, and all effective generation parameters. Record API and SDK versions in the manifest. Assert that image bytes come from the pinned store.

Store raw requests, raw responses, parsed results, usage and error metadata immutably. Preserve the response/error sequence across retries. Replay raw responses through each engine version's own parsing and retry logic; parsed results are diagnostics, not a substitute for executing the baseline parser. Failed calls remain failures; a cached error must not become a pass. New prompts, parameters, candidates, images, or messages require an explicit new record operation. Cache hits must not be synthesized from a nearby request.

Namespaces identify recording experiments. For a paired baseline/HEAD comparison, reuse the same recorded response for an identical effective request, with both manifests recording its provenance. Record changed requests separately. Separate namespaces alone must not cause identical requests to receive independent random responses and then be attributed to engine code changes.

Maintain the existing in-scan cache unchanged when eval is off. The persistent cache must use the complete key when eval is on.

Maintain an explicit per-check classification in eval configuration. Behavioral checks include `src/checks/behavioral/**`, form submission/on-input checks, and prompts derived from interaction state. DOM-only semantic checks, axe, alt-text and current high-risk classification are non-behavioral, while acknowledging their page inputs still require stable capture.

Run three replays at the same effective SHA, corpus, label snapshot and cache snapshot. Normalize UUIDs, timestamps and file paths only. Compare multisets, including multiplicity, of criterion, locator, failure type, detector, check, severity and confidence; also compare criterion statuses and coverage.

Non-behavioral differences invalidate repeatability. Investigate harness causes first; log an engine cause without fixing protected detection code. Behavioral differences produce a per-check rate: varying `(page, check)` pairs divided by applicable tested pairs across all three runs. Store input diffs and normalized finding diffs privately, and sanitized defects in `eval/phase2-defects.jsonl`.

Any cache miss still invalidates that replay, including a behavioral miss. Diagnostic continuation may quantify the input instability, but may not claim complete determinism or official accuracy. Exclude unstable behavioral cases only through a new declared evaluation contract, and report their lost coverage.

Acceptance: non-behavioral findings and statuses are identical across three complete replays; behavioral rates and blockers are explicit; a frozen-input error cannot produce an official pass.

## D4 Cases, labels, resolution and matching

Ground truth has its own identity. Model or engine output does not define the identity of the defect being evaluated.

### Case schema

Store append-only case events in private `eval/cases.jsonl`. A case definition includes:

```json
{
  "op": "create_case",
  "case_id": "C-000001",
  "site_id": "m01",
  "page_id": "p003",
  "corpus_version": "v001",
  "unit": "element",
  "target": {
    "selector": "#example",
    "html_sha256": "<hash>",
    "context_sha256": "<hash>",
    "state_id": "static"
  },
  "assertion_id": "A-000001",
  "criterion": "4.1.2",
  "issue": "Accordion control exposes no expanded state",
  "origin": "independent_audit",
  "sampling_id": "audit-001",
  "cluster_id": "G-000001",
  "evidence_refs": ["<private-artifact-ref>"],
  "source_seed_id": null
}
```

Support units `element`, `page`, `interaction`, and `scan`. A case may have multiple explicit assertions. The criterion belongs to an assertion, not the case ID. Changing a criterion requires an append-only revision and reviewer reasoning, preserving history. Engine predictions and failure-type assignments are stored separately.

### Label events

Append new judgments only to private `eval/labels.jsonl`. Use monotonic `L-000001` IDs and a single serialized writer. Each judgment includes label ID, case/assertion ID, corpus/run references, verdict, expected severity if known, reviewer identity, provenance, rationale, batch, sampling ID, active seconds, timestamp, adjudication state, and propagation group/source if any.

Verdicts are `violation`, `no_violation`, and `unsure`. Severity correction is an annotation on a violation judgment, not a mutually exclusive classification. Record provisional Paul judgments and specialist-adjudicated judgments separately. Do not describe an AI suggestion as specialist ground truth.

Undo appends `{"op":"undo","target":"L-000001","at":"<UTC>"}`. Corrections append superseding events. Readers must fold these deterministically. Undoing propagated judgments must restore the entire operation consistently. Store a sequence number to freeze the exact event prefix for a run.

### Historical seed resolution

Resolve each seed into one or more concrete cases using private `eval/seed-resolutions.jsonl`: seed ID, full scan ID, page snapshot IDs, finding IDs when available, selected element/state, artifact references, resolution method, and reviewer status. Page and element evidence is required; a scan ID alone is insufficient.

Use the scan hints in D10 only after checking their contents. Cases with no resolvable evidence remain `unresolved_fixture`; do not guess locators or score them as FN. Seed statements such as missing scope/caption or skipped headings require criterion adjudication rather than automatic acceptance of the historical wording.

Seed `eval/label-overrides.json` with reasons:

- SL-014: disputed skipped-heading-level interpretation; do not include in scored oracle expectations until adjudicated.
- SL-005 and SL-006: disputed/unresolved markup, pending evidence resolution.
- SL-011: disputed composite count; reported 516 consists of 498 API-failure rows plus 18 duplicate-link findings. Resolve the duplicate-link cases separately; never score the count as 516 independent defects.
- SL-001, SL-002 and SL-016: scan-level cases; excluded from element/criterion accuracy denominators, retained for tooling and false-pass assertions.

### Matcher

Resolve the case target using pinned page identity, interaction state, selector and contextual HTML. Use content/context matching only as a documented fallback. Produce a candidate association separately from judging whether criterion and failure type are correct. Do not match solely on page plus failure type, and never use `finding_type_hash`.

If a case can associate with several indistinguishable findings, or vice versa, report `ambiguous` and require resolution. Matching must be order-independent and prevent one prediction from satisfying multiple unrelated assertions. A finding with the wrong criterion can be associated with the target while still yielding a missed correct assertion and a separately reviewed incorrect prediction.

On a fixed version, disappearance of a previously resolved target is a replay/fixture error. Across a new live capture, a removed element may be `stale` only after resolution confirms it was removed rather than renamed. Do not silently transfer judgments to changed contexts.

Classification combines the ground-truth judgment with a separately defined engine prediction:

| Classification | Rule |
| --- | --- |
| TP | A violation assertion has a matching prediction meeting the declared view |
| FN | A violation assertion has no matching qualifying prediction |
| FP | A reviewed no-violation assertion still has a qualifying prediction |
| TN | An explicitly reviewed no-violation assertion has no qualifying prediction |
| Unlabeled | Prediction has no resolved reviewed assertion |
| Unsure or disputed | Ground truth is unsettled; excluded and counted |
| Tooling error or untested | Evaluation did not establish the prediction outcome; invalidate required coverage rather than treating absence as TN |
| Stale or unresolved fixture | Evidence cannot support the assertion in this corpus; excluded and counted |
| Ambiguous | Association cannot be resolved; excluded and counted |

Do not exclude a case merely because the engine emitted `needs_review`. In the confirmed view a known violation with only a review prediction is FN; in the inclusive view that prediction may be TP. Human `unsure` is different from engine `needs_review`.

Acceptance: tests cover every classification, wrong-criterion association, multiple predictions, duplicate multiplicity, changed selectors, ambiguity, missing fixture evidence, undo, supersession, propagation and deterministic folding.

## D9 Local review and independent audit screen

```text
wcag eval review --run <id> --batch queue|calibration|anchor|adhoc
wcag eval audit --corpus <version> --sample <sampling-id> --criterion <id>
wcag eval pace --labels <private-path>
```

Implement the minimal review and audit workflows before model-judge switches or detailed playback tools.

### Finding review

Show the pinned native screenshot or source image with its type identified, escaped surrounding HTML, associated state, engine criterion, reasoning, failure type, severity, confidence, detector and tier. If no crop exists, show the full-page screenshot and a target location; do not imply an invented crop was captured evidence.

Provide an Open in replay action through the offline boundary. Scroll and optionally outline the target. A locator outline must be visibly identified and toggleable; it must not stand in for the element's native focus indicator.

Keys: T confirms a violation, F records no violation, S corrects severity on a violation, U records unsure, N advances without judgment, and Z undoes the last judgment operation. Require an assertion criterion when adding or correcting ground truth. Keep original engine classification visible in the stored prediction history.

### Independent audit

An audit sample consists of declared pages, interactions and criteria selected before engine output is shown. Hide findings, reasoning, model judgments, and finding counts during annotation. Let Paul add cases for defects the engine never reported and explicitly record tested negative assertions. A criterion checklist and state list must permit completion, partial completion, or unable-to-evaluate with reasons.

After annotation is frozen, match engine results and reveal misses. Freeze judgments made before reveal separately from post-reveal additions. Specialist adjudication records the reviewer and evidence, and preserves the original annotation history. Audits are within the frozen scope; broader observed defects are retained as coverage gaps rather than silently discarded.

Store the audit protocol, selection seed, sample units and selection probabilities. Repeated audit use on dev is permitted for tuning and is never represented as sealed holdout evidence.

### Sampling and propagation

The queue may be enriched by uncertainty or severity; its results are reviewed-finding precision. Add a reproducible simple random sample of findings per declared criterion/view for probability sample precision, storing its population snapshot and inclusion probability. Do not mix queue and probability samples into an unweighted headline estimate. Freeze a common case set for paired comparisons; when candidate-only findings appear, report their unlabeled delta and sample them for a new labeling round before claiming candidate-wide precision. Rescore both engines against the updated frozen judgments.

Batch by criterion where useful. A proposed propagation group must show every instance and its context. Restrict automatic eligibility to structural judgments whose required context and state are equivalent. Do not propagate contextual alt-text or link-purpose judgments using identical element HTML alone. Paul must confirm the operation.

All propagated labels share one cluster and one source judgment. They are not independent samples. Primary cluster metrics count the representative judgment once and report instance coverage separately; any later disagreement breaks the group and requires fresh adjudication.

### Behavioral evidence and pace

The existing checks do not store keyboard sequences. Do not promise original tab recordings. Initially show the captured finding evidence and an offline reproduction action. If reconstructed frames are added in eval code, label them reconstructed, store replay settings and action steps, and show native focus separately from locator overlays. Never treat reconstructed frames as original ground truth.

Measure active label time from display to judgment, pause when the window is hidden, and exclude idle intervals beyond 120 seconds. N creates no judgment. `pace` reports count, median and p90 by criterion and batch. Weekly-budget recommendations, judge visibility, and elaborate frame navigation are deferred.

Acceptance: Playwright E2E tests use temporary private paths and cover T/F/S/U/N/Z, severity, case creation without a finding, audit blinding and reveal, propagation, folding, timing, and local endpoint protection. Then Paul labels 20 tuning findings and completes an independent audit of at least two frozen pages across two criteria. At least one test fixture must demonstrate creation and detection of an FN; do not require a real FN to exist on those two pages.

If Paul is unavailable, complete automated tests and continue independent infrastructure work. Report human acceptance as pending; do not fabricate labels, declare the human checkpoint passed, or claim adjudicated accuracy.

## D5 Accuracy, coverage and uncertainty metrics

```text
wcag eval metrics --run <id> --labels-through <sequence> --purpose official-accuracy
wcag eval export --run <id> --aggregates-only
```

Output per criterion and split, with optional detector and tier breakdowns:

- TP, FP, FN and TN where explicitly defined; precision denominator `TP + FP`; recall denominator `TP + FN`.
- Precision and recall values, each with its own 95% Wilson interval for the stated independent sample units. Zero denominator produces unavailable, never 0% or 100%.
- Distinct sites, site/template families, cases, clusters, labeled instances, and sampling origin. Mark a denominator below 30 as insufficient evidence; this is a reporting threshold, not a sales threshold.
- Sampled versus unsampled population, probability-sample inclusion details, and audited pages/criteria/states completed.
- Human unsure/disputed, engine needs-review rate, tooling errors, ambiguous matches, stale/unresolved cases, unlabeled findings and attrition.
- Per `(page, check)` completion outcomes: ran, partial, failed, skipped, not recorded, and independently established not applicable. Include crawl and capture failures in their own denominators.
- Known-defect misses, audited-scope misses, incorrect criterion assignments, severity disagreement, and false-pass assertions.

Produce confirmed and inclusive views using the same ground-truth positives and declared sample frame. Confirmed predictions are findings outside `needs_review`; inclusive predictions include `needs_review` findings except tooling errors. Describe these as prediction policies, not as proof that high-confidence predictions are correct.

Report selected/cluster precision separately from probability-sample instance precision. Wilson intervals on representative clusters are descriptive of those units; do not present them as population-wide customer accuracy. Report site-level results privately and a deterministic site/template-family bootstrap interval for pooled audited or probability-sample estimates where the sample supports it. Store the bootstrap seed. With too few independent families, mark generalization uncertain rather than returning an apparently precise interval.

Existing scan-wide deduplication must not inflate FN counts: use resolved aliases such as `also_found_on_urls` only when evidence establishes the same case, then retain instance and cluster counts separately.

A required failed/skipped/partial check makes coverage incomplete. Do not improve accuracy by removing its cases. Show conditional metrics with missingness explicitly, and refuse a valid official gate result for the affected required evaluation contract.

Freeze an eval-side prerequisite map connecting pass assertions to required checks. A known positive cannot coexist with a claimed criterion pass. A criterion cannot pass because its checks failed, were partial, were not run, or produced unresolved mandatory review. Checks that test only part of a criterion cannot support a full conformance claim. Evaluate the engine's current statuses and report violations; do not rewrite them to hide the defect.

Acceptance: meaningful fixture tests verify formulas, separate denominators, both prediction views, zero denominators, clustered labels, random-sample separation, insufficient evidence, missing coverage, deduplicated aliases, wrong criteria, and false passes under API failure and partial execution.

Private output is under `wcag-data/eval-runs/<run-id>/`. Export aggregates by split, criterion, tier and detector only after a privacy check. Never export site-level detail or content-bearing strings.

## D10 Lakewood static regression cases

Resolve historical cases using stored `full_dom` and evidence in `wcag-data/wcag-old.db`. Prefer verified resolution sidecars over scan hints.

| Seed labels | Scan prefix hint |
| --- | --- |
| SL-003 through SL-006, SL-009 | `352d16a6` |
| SL-007, SL-008 | `fd896cef` |
| SL-010, SL-011 | `ab75ea1b` |
| SL-012 | `f5d0954e` |
| SL-013 through SL-015 | `9aee533b` |
| SL-017, SL-018 | `a9d53405` |
| SL-001, SL-002, SL-016 | Scan-level fixtures; no element snapshot assumed |

The original seed scan IDs may be narrative references rather than database IDs. Verify each selected snapshot contains the target and the context needed for its judgment. Split composite labels into resolved cases. Keep the original seed ID as provenance.

Call exported DOM-only check functions from each engine version. Use serialized DOM directly where the check accepts it. For browser-based static checks, block all egress and prevent page scripts from changing the fixture. Use an explicit tested whitelist of axe rules whose result does not require missing CSS, layout, browser interaction, or unrecorded resources. Do not run the full axe suite against an unstyled `setContent` page and call it ground truth.

Heading, link, widget, table, landmark, input-purpose, multiple-ways and high-risk classification checks are candidates, not a blanket guaranteed list. Re-derive eligibility from each version's code and the resolved case. Distinguish raw markup classification from evaluating safeguards or rendered behavior.

Vision requests use the original model input image when recoverable. An old finding's `evidence.element_screenshot` is a candidate evidence artifact, not automatically the image that the model originally received. If using it creates a new explicit static test, record that input variant and do not call it historical reproduction. If required visual evidence is absent, mark `unresolved_fixture`; if rendering is essential, mark `requires_rendering`. Neither is a negative verdict.

Use a separate static cache experiment with explicit record then replay. Preserve request provenance for HEAD and baseline as in D3. Two complete replays must be identical.

Before writing expectations, report eligibility and disputes for all 18 seeds. SL-008 is expected to require rendered background-image evidence. SL-014 remains disputed pending adjudication. SL-005/006 remain unresolved unless evidence is found. SL-011 must separate API errors from duplicate links. SL-004 is a candidate improvement at HEAD, not an outcome to force.

Store resolved expectations in `eval/lakewood-static.json`: case ID, seed provenance, fixture hashes, criterion, expected violation/no-violation, expected severity when adjudicated, confidence in ground truth, applicability per engine, and adjudication state. Missing baseline support is a known baseline gap, not a skipped HEAD requirement.

Use synthetic scan-level fixtures for SL-016: injected API failures, partial checks, and untested relevant criteria must never produce an accepted pass assertion. Record existing engine violations as Phase 2 blockers without changing detection code.

Acceptance: every seed has a documented resolution/eligibility outcome; every runnable case has HEAD and baseline results; scored expectations are settled; two static replays agree; unresolved or disputed cases are reported without guessed outcomes.

## D6 Historical baseline and initial reference runs

Use an isolated worktree under the ignored eval worktree directory, with a distinct data directory. Never open the current production store with baseline code. Run both versions through the proven bridge and shared eval runner.

Record requests once for each distinct effective request, then replay. Use the same pinned tuning corpus, page set, browser settings, scope, labels and sampling definitions. Record dependency differences. Where possible use a common supported runtime/browser for the controlled comparison; if that is impossible, describe the comparison as versioned-system performance rather than isolating source changes alone.

Build an explicit engine capability matrix and map historical check names to canonical eval check IDs. A deliberately unimplemented historical check is an unsupported baseline capability, not a transport failure or an invented successful execution. Report missed in-scope positive cases as baseline misses where absence is established by design; reserve tooling-error/untested for outcomes that could not be established. Require actual execution for checks each engine claims to implement. New HEAD capabilities must be reported as additions and tested against their own oracle requirements.

Store sanitized baseline manifests and results under `eval/baselines/2026-10-04/`, with private details in the run store. Also create the initial pre-harness HEAD reference, so later Phase 2 changes can be compared against both historical and current behavior.

Report historical Popfly totals separately: the original scan had 50 pages and 1,549 findings; the frozen corpus uses at most 30 pages and current captured content. Explain page, content, dependency, prompt and image-input differences. Do not apply a 5% total-count reproduction threshold across different page sets.

On the exact shared page subset, report added/removed findings by criterion and failure type and compare resolved judgments. Changes in raw counts are diagnostic, not accuracy evidence.

Acceptance: both reference engines have complete replay results and static results where supported, input provenance is recoverable, determinism status is explicit, and no original database was modified.

## D7 Compare and regression gate

```text
wcag eval compare --base <reference-run-id> --head <candidate-run-id>
```

Comparison consumes pinned runs, not whatever their branch names point to now. It must verify compatible corpus, page set, scope, judgments, sampling frame, browser contract and request provenance before scoring. If labels change, rescore both stored prediction sets against the same frozen label snapshot; never compare different ground truth silently.

Report regression status separately from existing oracle failures and future commercial readiness. Use these exit codes:

| Exit | Meaning |
| --- | --- |
| 0 | Valid comparison, no regression, and no remaining required oracle blocker |
| 1 | Valid comparison with a regression |
| 2 | Invalid/incomplete comparison, including dirty source, incompatible inputs, misses, required coverage loss, or unresolvable repeatability |
| 3 | No new regression demonstrated, but existing required oracle failures still block a clean gate |

Fail for a regression when a settled labeled TP becomes FN, a settled static case newly violates its expected outcome, a settled false positive returns, a corrected severity newly regresses, or a known false-pass assertion newly fails. Apply these protections to tuning and dev; never require 30 samples to protect an individual known defect.

For a dev criterion with at least 30 usable units in the relevant denominator, flag a precision or audited-scope recall drop greater than 0.05 by default. Freeze configurable thresholds before comparison. Report counts, intervals and paired transitions; the threshold is an engineering policy, not a significance test or proof of readiness.

Coverage loss includes a required previously completed `(page, check)` becoming partial, failed, unjustifiably skipped, or not recorded. Explain justified not-applicable transitions explicitly. New tooling errors or unresolved mandatory reviews cannot improve the gate through exclusion.

Behavioral instability is a blocker for assertions that depend on the unstable path. Report stable-subset comparisons only as diagnostic unless that subset was declared before the run. No blanket waiver turns a cache miss or unstable required assertion into an official pass.

Always print and save added/removed findings, correct/incorrect criterion transitions, case status changes, severity disagreements, unlabeled delta, coverage changes, tooling errors, abstentions, ambiguities, behavioral flake rates, and existing oracle failures. Include sanitized IDs and aggregate counts publicly; keep content-bearing diffs private.

Tests must intentionally remove a true finding, reintroduce an FP, drop coverage, fail an API call, create a false pass, change a criterion incorrectly, corrupt an artifact, and alter a label snapshot. Assert the appropriate nonzero result. Do not require the current engine to pass every oracle for the harness implementation itself to be accepted.

## D1b Municipal admission and split assignment

This deliverable is blocked until Paul supplies `wcag-data/eval-corpus/builtwith.csv`. Complete tuning work first.

```text
wcag eval admit --input <private-builtwith-file> --salt-env EVAL_SPLIT_SALT
```

Normalize domains, deduplicate redirects, confirm Webflow through `detect()` using passively acquired home-page evidence, assign pseudonymous IDs, and record rejections privately. Do not contact a non-admitted site beyond what admission needs.

Group visibly related agency designs or shared template families using documented evidence available before scoring. Put a whole family in one split. Unknown relationships remain unknown; do not claim independence simply because domains differ.

For the initial admission, sort family IDs by `sha256(family-id + EVAL_SPLIT_SALT)` and assign the first `ceil(family_count / 3)` families to holdout, the rest to dev. Freeze assignment in the private map. Subsequent admission never moves existing sites or families. New families use a recorded deterministic assignment policy; a newly discovered relation spanning splits must be flagged as leakage and resolved before holdout use.

Select at most 30 pages per site using home, key public tasks, distinct CMS/template pages, forms, and complete feasible interactions. Fill remaining slots deterministically. Record omissions when there are more candidate forms/pages than the cap; do not promise every form while enforcing a smaller cap. Choose pages before engine scoring.

Report admitted sites and independent families. Fewer than 15 sites is not evidence of an unusable harness: prepare admission results and continue tuning work, but ask Paul before spending on a small municipal capture campaign. Even 15 sites does not establish statistical adequacy; report actual sample and family denominators.

Capture dev normally and holdout passively as D1 specifies. Phase 1 must not open holdout content for review, interaction preparation, scoring, or a model canary.

Any later access requires `--split holdout --unseal "<reason>"` and a committed access-log entry containing timestamp, SHA, command, run ID and reason without content or URLs. An unseal permanently marks that version's holdout as accessed; it does not remain sealed marketing evidence. Refuse Phase 1 content access even when an unseal flag is supplied unless Paul explicitly changes this phase's scope.

When dev is ready, repeat capture verification, D3, D6 and D7 on the admitted dev corpus. Holdout evaluation belongs to a later frozen evaluation phase.

## D11 Fresh model agreement canary

Implement a small optional canary after replay and labeling work. It is separate from cached repeatability and never alters stored official predictions.

```text
wcag eval model-canary --sample <sampling-id> --repeats 3 --max-cost-usd <amount>
```

Use up to 20 frozen tuning/dev effective requests, selected by a documented seed across prompt types and known violation/no-violation cases where available. Do not use holdout. Send each request three times with the same model and parameters, bypassing response reuse into a separate experiment namespace. No site access is permitted.

Report valid responses, parse/API failures, verdict disagreement, criterion/failure-type disagreement, and agreement with adjudicated cases where available. Call this a small reliability canary, not a population accuracy estimate. Fresh-call variance may create Phase 2 defects without making a correctly cached replay nondeterministic.

Acceptance: a stubbed test proves three calls really occur; the budget stops new calls; no canary response overwrites a regression response. A real run is optional until Paul supplies a budget, and pending budget must not block the core harness.

## Future commercial acceptance contract

Create `eval/commercial-readiness.json` with status `not_evaluated`. It records the declared product scope, criteria/failure types claimed, required manual review, required independent site/template coverage, unresolved critical misses, false-pass policy, and fields for later precision/recall lower-bound targets.

Do not invent customer acceptance thresholds. Leave numeric sales targets unset until Paul and an accessibility specialist agree them, before a final holdout evaluation. Define the validation so an unset target, absent adjudication, incomplete coverage, or accessed tuning-like holdout cannot produce `ready`.

Phase 1 can report tested engine behavior and known gaps. It must not emit a conformance certificate, a sales-ready flag, or a broad WCAG accuracy percentage from the historical seed set or the 20-label UI checkpoint.

## Work order and commits

1. Checkpoint 0, privacy rules, scope/config schemas, D8 manifests and recoverable input snapshots.
2. D0 local pilot, baseline bridge, egress denial, submission containment, and default-path equivalence. Do not expand capture until this passes.
3. D1/D2/D3 on the smallest tuning pilot, including exact model-image provenance and three replays.
4. Expand D1 to the frozen tuning subsets; complete D2/D3 and document exclusions and instability.
5. D4 case/label schemas, seed resolution, matcher and tests.
6. D9 minimal finding review and independent audit, E2E tests, then the human checkpoint. Continue independent work while human acceptance is pending.
7. D5 metrics and false-pass/coverage assertions, then D10 resolved static cases.
8. D6 historical and initial HEAD references, D7 compare/gate, and deliberately failing gate fixtures.
9. Optional D11 canary and the future commercial contract.
10. Final report. D1b and dev reruns proceed when the supplied list and any small-campaign decision are available.

Use cohesive commits with messages `eval(phase1): <deliverable> <summary>`. Pin source before official runs, then export and commit results. Write CHANGELOG entries after their referenced implementation commits exist; cite run IDs for measured results. Do not rewrite history merely to make a manifest point to its later results-export commit.

Run typecheck, build, appropriate eval tests, and the existing suite. Record pre-existing failures before implementation and distinguish them from new failures. Investigate and fix new harness-caused failures; protected detector failures are reported, not repaired in this phase.

## Stop conditions and incomplete work

Stop dependent work and report when baseline/source identity is ambiguous, protected code changes are required, the offline boundary cannot be proven, submission containment fails, or the baseline bridge changes detection semantics.

Do not issue official results when source is dirty, required evidence is missing, unexpected egress/misses occur, non-behavioral replay differs, required behavioral assertions are unstable, coverage is incomplete, or input contracts are incompatible. Diagnostic reports must retain those failures.

More than 20% replay exclusions blocks that site's corpus acceptance. Missing BuiltWith data blocks municipal admission only. Missing Paul judgments or specialist adjudication blocks the relevant human/accuracy claims only. Missing canary budget blocks real canary calls only. Continue unaffected authorized work.

Log existing detector defects with sanitized check IDs, case IDs, run IDs, impact and evidence references. Do not conceal them with fixture edits, retrospective exclusions, label propagation, narrower scope, or cached successful responses.

## Final report

Return a concise summary and a saved detailed report containing:

1. Implementation commits, starting SHA, harness SHA, bridge hash and baseline effective source identity.
2. Default-path equivalence, submission containment and egress-denial evidence.
3. Corpus versions, exact tuning/dev page sets, selection omissions, robots skips, capture failures and replay exclusions.
4. Baseline versus HEAD comparison, exit code, existing blockers, and historical-count context.
5. Repeatability results, behavioral instability and optional fresh-model canary results, clearly separated.
6. Accuracy metrics with both denominators, sample origin, cluster/site/family counts, uncertainty and unavailable claims.
7. Coverage, abstentions, tooling errors, false passes, wrong criteria and unlabeled deltas.
8. Outcome and adjudication/resolution status for every Lakewood seed.
9. Review/audit acceptance, actual human labels, discovered known misses, timing and propagation use; list pending human work.
10. Privacy export checks, holdout seal state and any access log entries.
11. Phase 2 defects, assumptions, blocked deliverables and commercial-readiness fields still unset.

Phase 1 succeeds by making the next engine change measurable and reviewable, including when the first honest comparison exposes failures.
