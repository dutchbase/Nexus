# Task 7 repair 1 report — review race and prompt boundaries

## Fixed findings

- The disposable review worktree now returns its detached `HEAD` SHA. An
  approved `review_and_merge` run passes that SHA to GitHub's merge endpoint,
  which rejects a head changed after review with HTTP 409; no local approval is
  recorded after that failure.
- Every JSON-serialized untrusted prompt field encodes `<` as `\\u003c`, so a
  PR cannot inject the `</untrusted-json>` envelope delimiter.
- `renderPrReviewPrompt` appends the pinned immutable rubric when an active
  project override does not include the rubric placeholder.

## TDD evidence

Red:

```text
pnpm exec vitest run packages/domain/src/pr-review.test.ts packages/github-provider/src/index.test.ts

4 failures: closing delimiter escaped the envelope, override omitted the
rubric, merge policy was absent, and GitHub merge payload lacked reviewed SHA.
```

Green:

```text
pnpm exec vitest run packages/domain/src/pr-review.test.ts packages/domain/src/pr-merge.test.ts packages/github-provider/src/index.test.ts packages/git-runner/src/index.test.ts

4 files passed, 20 tests passed.

pnpm exec tsc --noEmit
git diff --check
```

## Coverage

- The prompt test parses the envelope after a literal closing-tag attack and
  exercises a placeholder-free project override.
- The GitHub-provider and domain merge tests simulate a 409 changed-head
  response, assert the reviewed SHA is sent, and confirm no approval write.
- The detached-worktree test asserts the returned SHA equals its checked-out
  `HEAD`.
