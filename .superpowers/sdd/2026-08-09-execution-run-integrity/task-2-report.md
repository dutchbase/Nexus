# Task 2 report: Enable guarded Claude execution tools

## Implementation

- Changed the execution-level Claude tool allowlist to `Read,Glob,Grep,Edit,Write,Bash,Skill,Agent`.
- Added a top-level `PreToolUse` hook for `Bash` with the existing `hookCommand(guardPath)`.
- Reused the existing file hook, Agent hook, Bash guard, session-agent tool lists, and sandbox settings without change.

## Files

- `packages/claude-runner/src/index.ts`
- `packages/claude-runner/src/index.test.ts`

## TDD evidence

### RED

Command: `pnpm exec vitest run packages/claude-runner/src/index.test.ts`

Output: `34 tests | 1 failed`; `buildExecutionArguments > enables skills and agents with session-local role definitions` failed because the arguments did not contain `Read,Glob,Grep,Edit,Write,Bash,Skill,Agent`.

Reason: the production execution-level tool list still excluded `Edit`, `Write`, and `Bash`.

### GREEN

Command: `pnpm exec vitest run packages/claude-runner/src/index.test.ts`

Output: `1 passed`, `34 passed`.

## Self-review

- Exact global allowlist is `Read,Glob,Grep,Edit,Write,Bash,Skill,Agent`.
- The Bash `PreToolUse` hook is top-level and uses `hookCommand(guardPath)`.
- The test proves `pnpm exec vitest packages/claude-runner/src/index.test.ts` is allowed by the existing guard.
- The test proves unrelated `git show` is denied by the existing guard.
- Session-agent lists and sandbox configuration remain unchanged.

## Concerns

None.
