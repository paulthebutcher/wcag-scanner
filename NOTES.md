# Notes: coverage, Top fixes, fix verification

Working notes for the three-phase change (per-check coverage, component-grouped "Top fixes", `wcag verify`).

## Assumptions

- `npm run lint` failed before this work: the repo had no ESLint config (ESLint 9 needs `eslint.config.js`). Added a minimal flat config that parses `src/**/*.ts` with `typescript-eslint`'s parser (new dev dependency) and enables four rules that cannot misfire on TypeScript. It does not enable the recommended rule sets; see Out of scope.
- The focus-visibility rewrite from the previous session was uncommitted at the start; it was committed on its own (`fix: focus check uses real Tab presses ...`) before Phase 1 so it does not mix with phase commits.

## Out of scope

- Enabling `typescript-eslint` recommended rules. They would flag existing code across the repo (unused vars, `any`), and fixing that is a refactor outside these phases.
