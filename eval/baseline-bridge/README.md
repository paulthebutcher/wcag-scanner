# Baseline bridge

The baseline engine (`baseline-2026-10-04` = `ffdcd308610527525fb82ccd118a7f7b89334b66`) predates the eval hooks. Its crawler launches its own Chromium, it has no page-list option, and it sends the replay-time post-submission screenshot to the error-message prompt. The bridge runs it behind the same transport boundary as HEAD without changing what it detects.

## Adapter (no source change; `src/eval/engine/legacy.ts`)

- The engine runs from a git worktree under `wcag-data/eval-worktrees/`, with `node_modules` symlinked to the repository's, so `playwright` and `@anthropic-ai/sdk` are the same module instances as the harness's. It is built with the repository's `tsc`.
- While the engine runs, `chromium.launch` returns the controlled browser (its `close()` is a no-op).
- The engine discovers pages from robots.txt and sitemaps. Replay serves the recorded robots.txt and a synthetic sitemap that lists exactly the frozen pages, in an order its CMS grouping keeps (`baselineCompatibleOrder`); `maxPages` and `cmsSamples` are set to the page count. Synthetic responses are declared in each run's output.
- The eval prompt runner is injected through the existing `promptRunner` option, built from the baseline's own `PromptRunner` so its parsing, retries and in-scan cache are used unchanged.

## Patch (`ffdcd30.patch`, transport only)

| Field | Value |
|---|---|
| Original SHA | `ffdcd308610527525fb82ccd118a7f7b89334b66` |
| Patch sha256 | `6f224841b57697ab92c74b388c7d006bf312ea16be9fe0c7cea88d2188a456ef` |
| Files | `src/core/scanner.ts` only (two hunks) |

The patch adds the same `evalHooks.submissionStates` option HEAD has and applies it to the states passed to `evaluateErrorMessages`, so the model receives the screenshot recorded at capture time (or no image for a recorded no-image state) instead of one rendered during replay. With the option unset, the code path is unchanged.

The effective source hash (sha256 over the hashes of every file in the patched `src/`) is computed when the worktree is built and recorded in every run manifest that uses the bridge, together with the adapter source hash.

## Reproduce

```bash
git worktree add --detach wcag-data/eval-worktrees/baseline-ffdcd3086105 baseline-2026-10-04
git -C wcag-data/eval-worktrees/baseline-ffdcd3086105 apply ../../../eval/baseline-bridge/ffdcd30.patch
```

The harness does this itself (`prepareWorktree`) and refuses a worktree whose diff is not exactly the patch.
