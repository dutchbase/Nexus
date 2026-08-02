# Task 7 report — repo-aware PR AI review

## Scope

- PR review now tells Claude to inspect the detached PR checkout with only
  `Read`, `Glob`, and `Grep`; the pinned rubric and JSON-escaped untrusted PR
  envelope remain in use.
- The complete Markdown review is posted to GitHub. The database retains only
  the validated compact verdict and trimmed summary; merging remains conditional
  on an approved verdict.
- Verdict parsing rejects malformed or ambiguous multiple JSON blocks.

## TDD evidence

Red:

```text
pnpm exec vitest run packages/domain/src/pr-review.test.ts apps/worker/src/task-7.test.ts

2 failures: ambiguous JSON verdicts were accepted and the worker did not
instruct repository inspection or post the full Markdown review.
```

Green:

```text
pnpm exec vitest run packages/domain/src/pr-review.test.ts apps/worker/src/task-7.test.ts packages/github-provider/src/index.test.ts packages/claude-runner/src/index.test.ts packages/git-runner/src/index.test.ts

5 files passed, 23 tests passed.

pnpm exec tsc --noEmit
git diff --check
```

## Coverage

- Prompt-injection escaping is retained in `pr-review.test.ts`.
- The new parser test covers malformed and multiple verdict blocks.
- The GitHub-provider integration test verifies the full Markdown payload and
  issue-comment endpoint.
- The detached `refs/pull/<number>/head` worktree test covers fork PR refs and
  cleanup; the worker test verifies cleanup and that rejected verdicts cannot
  enter the merge branch.
