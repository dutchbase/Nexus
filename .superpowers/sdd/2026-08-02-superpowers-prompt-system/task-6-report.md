# Task 6 report — Git validation and disposable PR worktrees

## Scope

- Effective validation now compares the recorded base with the complete current
  worktree, including committed, staged, unstaged, and untracked changes.
- Execution histories must descend linearly from that base. Empty effective
  changes and merge commits are rejected. The worker rescans immediately before
  its commit and immediately before pushing, while preserving valid agent commits.
- Repair prompts receive the same base-relative effective diff. PR reviews now
  use a detached `refs/pull/<number>/head` worktree that is removed in `finally`.

## TDD evidence

Red:

```text
pnpm exec vitest run packages/git-runner/src/index.test.ts

4 failures: committed changes missing from repair diff, committed task rejected
as empty, merge history accepted, and missing PR review worktree helper.
```

Green:

```text
pnpm exec tsc --noEmit
pnpm exec vitest run packages/git-runner/src/index.test.ts apps/worker/src/task-5.test.ts apps/worker/src/task-6.test.ts

3 files passed, 16 tests passed.
```
