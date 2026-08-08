# Task 2 report: provider usage normalization

## TDD evidence

- RED: added parser tests for Claude final result usage, malformed/no-final usage, OpenCode final step usage, and duplicate step IDs; `npx vitest run packages/claude-runner/src/index.test.ts apps/worker/src/opencode.test.ts` failed because both exported parsers were absent.
- GREEN: added minimal final-result/final-step normalizers and optional runner result fields; the same focused command passes 49 tests.

## Files

- `packages/claude-runner/src/index.ts` and `index.test.ts`: normalize Claude final usage and expose it on planning/execution results.
- `apps/worker/src/opencode.ts` and `opencode.test.ts`: normalize and deduplicate OpenCode final step usage, exposing it on planning/execution results.
- `packages/claude-runner/package.json` and `pnpm-lock.yaml`: declare the existing `@dcc/domain` type dependency.

## Verification

- `npx vitest run packages/claude-runner/src/index.test.ts apps/worker/src/opencode.test.ts` — 49 passed.
- `git diff --check` — passed.

## Commit

- `feat(ai): normalize provider usage`

## Concerns

- `npx tsc --noEmit` currently cannot resolve `@dcc/domain` from the runner because this checkout's pre-existing pnpm modules directory was not relinked after the new workspace dependency. `pnpm install --lockfile-only --offline` updated the lockfile successfully; a full install requires clearing the shared modules directory and was not performed.

## Fix round 1

- RED: the focused suite failed three reviewed regressions: Claude accepted reasoning above output, OpenCode accepted reasoning above output, and a non-newline-terminated Claude final result was not returned or delivered to `onEvent` (the cache regression is asserted in the same OpenCode malformed-usage test).
- GREEN: `npx vitest run packages/claude-runner/src/index.test.ts apps/worker/src/opencode.test.ts` — 49 passed; `git diff --check` — passed.
- Typecheck: `npx tsc --noEmit` still exits non-zero with `TS2307: Cannot find module '@dcc/domain'` in `packages/claude-runner/src/index.ts`, due to the existing unlinked workspace modules state above.
