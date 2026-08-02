# Task 4 report

## Scope

- Registered and rendered `{{superpowers.code-reviewer}}` from the repository-backed review rubric.
- Preserved the existing source-template sync behavior: it publishes immutable global versions and leaves project overrides selected by the existing resolver.
- Passed local skill bundles with `--add-dir`, generated plugins with repeatable `--plugin-dir`, and supplied them to planning and execution worker runs.
- Enabled `Skill` only for planning, `Skill` and `Agent` for execution, and neither for PR review.
- Added session-local execution agents: Haiku `dcc-mechanical`; configured `dcc-implementer`, `dcc-repair`, and read-only `dcc-reviewer`.

## TDD evidence

Red:

```text
pnpm exec vitest run packages/claude-runner/src/index.test.ts apps/web/src/pages/shared.test.ts packages/domain/src/pr-review.test.ts

4 tests failed as expected: planning lacked Skill/plugin flags, execution lacked Skill/Agent/session agents, the PR-review rubric remained unresolved, and the placeholder was not allowed.
```

Green:

```text
pnpm exec vitest run packages/claude-runner/src/index.test.ts apps/web/src/pages/shared.test.ts packages/domain/src/pr-review.test.ts scripts/superpowers-content.test.ts

4 files passed, 16 tests passed.
```

## Verification

```text
pnpm exec tsc --noEmit
exit 0

git diff --check
exit 0
```

## Commit

Recorded after commit.

## Concerns

None. The pre-existing untracked implementation plan remains excluded.

## Fix round 1

- Local snapshots now materialize as a generated `dcc-local` plugin and every selected skill reaches Claude through repeatable `--plugin-dir` flags; `--add-dir` is no longer used for skills.
- Added an invocation-level runner test that launches a fixture Claude executable and verifies a materialized local plugin manifest and skill are available through the CLI invocation.
- Added the exact `obra/superpowers` `v4.1.0` `requesting-code-review/code-reviewer.md` source as `prompts/global/code-reviewer.md`, pinned its source path in the manifest, catalog-hashed it, and load its synchronized global prompt version for PR review rendering.
- Added `disallowedTools` command patterns to every session-local agent for git commit/push/merge and GitHub/GitLab PR creation, while implementer/repair agents retain Edit, Write, and Bash for normal work and tests.

### TDD evidence

```text
pnpm exec vitest run packages/skill-registry/src/index.test.ts packages/claude-runner/src/index.test.ts scripts/agent-content.test.ts

5 tests failed as expected: the local plugin did not exist, runner still used --add-dir, agent JSON lacked denials, and the pinned rubric manifest/source were absent.
```

### Verification

```text
pnpm exec vitest run packages/skill-registry/src/index.test.ts packages/claude-runner/src/index.test.ts scripts/agent-content.test.ts scripts/superpowers-content.test.ts packages/domain/src/pr-review.test.ts apps/web/src/pages/shared.test.ts

6 files passed, 22 tests passed.

pnpm exec tsc --noEmit
exit 0

git diff --check
exit 0
```

## Fix round 2

Execution subagents no longer receive unrestricted `Bash`. Mechanical, implementation, and repair roles receive only explicit `git status`/`diff`/`log` and `pnpm` test/typecheck command patterns, plus Edit and Write. Chained shell forms are denied; absolute git and provider API commands are outside the allowlist. The reviewer remains Bash-free.

### TDD evidence

```text
pnpm exec vitest run packages/claude-runner/src/index.test.ts

FAIL: generated execution agents exposed unrestricted Bash instead of the status/test command allowlist.
```

### Verification

```text
pnpm exec vitest run packages/skill-registry/src/index.test.ts packages/claude-runner/src/index.test.ts scripts/agent-content.test.ts scripts/superpowers-content.test.ts packages/domain/src/pr-review.test.ts apps/web/src/pages/shared.test.ts

6 files passed, 22 tests passed.

pnpm exec tsc --noEmit
exit 0

git diff --check
exit 0
```

## Fix round 3

Execution roles now have a Claude `PreToolUse` hook for every Bash invocation. The checked-in guard parses the requested command as a strict argv form and allows only direct `git status`/`diff`/`log` and `pnpm exec vitest`/`tsc` invocations. It denies command substitutions, shell metacharacters and redirects, aliases/functions, absolute executable paths, provider commands, and editable package-script entrypoints such as `pnpm test`. Review remains Bash-free; execution roles retain Edit and Write.

### TDD evidence

```text
pnpm exec vitest run packages/claude-runner/src/bash-guard.test.mjs packages/claude-runner/src/index.test.ts

FAIL: generated execution agents lacked a PreToolUse Bash hook and still exposed pattern-only command permissions.
```

### Verification

```text
pnpm exec vitest run packages/skill-registry/src/index.test.ts packages/claude-runner/src/bash-guard.test.mjs packages/claude-runner/src/index.test.ts scripts/agent-content.test.ts scripts/superpowers-content.test.ts packages/domain/src/pr-review.test.ts apps/web/src/pages/shared.test.ts

7 files passed, 24 tests passed.

pnpm exec tsc --noEmit
exit 0

git diff --check
exit 0
```
