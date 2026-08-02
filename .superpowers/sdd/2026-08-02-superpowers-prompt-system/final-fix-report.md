# Final fix report — Superpowers prompt system

## Outcome

All eight findings in `final-branch-review.md` are addressed in one consolidated change. The release now includes its pinned Superpowers content, fails closed at the execution-agent OS sandbox boundary, resolves synced phase skills, versions the upstream review rubric, uses a scoped CI suite, binds review-and-merge to both the reviewed head and base, snapshots the exact PR-review prompt, and restores executable worker-boundary coverage.

## Finding-by-finding resolution

### 1. Critical — missing vendored catalog and untracked update output

- Imported and committed the manifest allowlist from the real `obra/superpowers` `v4.1.0` tag at commit `19c70afc993ef7f3054ea4f91918e47093bb907b`.
- Added the deterministic catalog and its 21 allowlisted files under `skills/vendor/superpowers`.
- Catalog hash: `27eb6025ed24341594b6f633e626da2ad7fc22b50ad25d7e08dad6e6453cf301`.
- Changed the update workflow to stage the three intended artifacts before checking `git diff --cached --quiet`, so a first-time untracked import opens an update PR.
- Added a shipped-catalog bootstrap test and a workflow staging-order regression test.

### 2. Critical — editable Vitest arbitrary-code and credential boundary

- Kept the command guard only as defense in depth; it is no longer the security boundary.
- Execution sessions now require Claude Code 2.1.219 or newer and configure the native OS sandbox with `failIfUnavailable: true`, `allowUnsandboxedCommands: false`, an empty strict network allowlist plus precedence-winning wildcard domain denial, Git-metadata read/write denial, and credential-file/environment denial.
- Execution loads no user, project, or local Claude settings, denies reads from the entire real home directory, and re-allows only the worktree, materialized bundle/prompt/guard, and trusted Node/Corepack toolchain paths. This prevents lower-scope settings from widening the boundary and blocks host credentials such as the deployment user's `~/.git-credentials` while preserving test execution.
- The launcher discovers normal-repository and linked-worktree Git metadata paths, atomically hides the worktree `.git` outside the sandbox-readable workspace for the session, denies the hidden path, linked Git directory, and common Git directory, then restores `.git` before parent validation.
- Publication and other sensitive credentials are deleted from Claude's inherited environment before launch; only the required subscription token is added to the parent Claude process. Execution subprocesses additionally receive Claude's credential scrub/PID-namespace mode, all Unix sockets remain disabled, and background tasks are disabled.
- Tests assert the fail-closed version gate, closed setting sources, home-deny/workspace-allow policy, restored hidden Git metadata, strict network/Unix-socket denial, credential denial, removed publication credential, and scrubbed subprocess environment.

Operational note: this host has `/usr/bin/bwrap`, but its current AppArmor/user-namespace policy prevents an actual Bubblewrap sandbox and `socat` is absent. Because the launcher is fail closed, execution will refuse to start rather than run unsandboxed until the deployment host is provisioned for Claude Code sandboxing. No dependency or host-policy change was made in this branch.

### 3. Important — synced phase skills not resolved

- Synced Superpowers rows now store manifest phases in `phases`, `required_phases`, and `allowed_phases`, matching the existing resolver contract.
- Added an integration-style regression from imported catalog rows through configuration, phase resolution, and snapshot selection.

### 4. Important — review rubric ignored by updater

- The updater now requires the manifest `review_rubric`, validates that it is a regular non-symlink file inside the verified checkout, imports its exact bytes to `prompts/global/code-reviewer.md`, and records its path/hash in the catalog.
- Sync bootstrap verifies the imported rubric path and current source hash.
- The update workflow stages the rubric artifact.
- Pinned rubric hash: `7f5328dca12cb200005ae9d4386f63a9b0acb735ece57f82db206b4a3189ccae`.
- Added changed-rubric and stale-rubric regression coverage.

### 5. Important — unrestricted Vitest discovery in CI/update workflow

- Added `test:unit`, backed by `vitest.config.ts` and Vitest's default excludes plus `.lfd/**`.
- CI and the Superpowers update workflow now invoke this scoped suite; provisioned evaluation and Playwright harnesses are not discovered as unit tests.

### 6. Important — review base differs from merge base

- `review_and_merge` establishes the requested target base before creating the detached worktree and fetching the review diff.
- The worker captures the provider's immutable head and base SHAs, fetches those refs into the disposable worktree, rejects any fetch-time mismatch, and computes the reviewed diff locally from the exact `base...head` pair.
- The approved merge binding and immutable prompt snapshot carry the detached reviewed head SHA, reviewed base branch, and reviewed base SHA.
- Immediately before merge, the domain layer refetches the provider PR and rejects a changed base branch or base SHA; GitHub's merge precondition also rejects a changed expected head.
- Added executable real-Git binding/diff coverage and a domain regression proving that base-tip advancement prevents merge.

### 7. Moderate — PR-review prompt not snapshotted immutably

- PR review now requires active versions for both `pr-review` and `code-reviewer`.
- It stores the exact rendered prompt using the existing immutable `prompt_snapshots` mechanism, including content hash, both prompt-version IDs, PR ID, reviewed head SHA, reviewed base branch, and reviewed base SHA, then links the agent run to the snapshot.
- Migration `018_pr_review_prompt_snapshot.sql` permits a review snapshot without inventing a ticket relationship.
- Added byte-exact null-ticket PR-review snapshot coverage and worker-boundary metadata assertions.

### 8. Moderate — nonexistent/source-text-only Task 7 coverage

- Restored `apps/worker/src/task-7.test.ts` as an executable test of approved ticket-bound phase snapshots, publication gating, reviewed head/base binding, exact review snapshot input, real detached PR worktree creation, and cleanup.
- Existing source-contract checks remain as lightweight wiring checks, while the restored test executes the boundary helpers and real Git worktree lifecycle.

## TDD evidence

Initial focused regression command:

```text
pnpm exec vitest run packages/claude-runner/src/index.test.ts packages/domain/src/pr-merge.test.ts packages/domain/src/prompts.test.ts scripts/superpowers-content.test.ts scripts/agent-content.test.ts scripts/task-8.test.ts apps/worker/src/task-7.test.ts --reporter=verbose
```

RED result: 6 files failed with 7 expected new failures and 25 existing tests passed. The failures covered sandbox/environment isolation, missing shipped vendor bootstrap, rubric import, phase configuration, staged/scoped automation, base-change merge rejection, and the missing executable worker boundary. Separate red tests demonstrated rejection was missing for an old Claude version and that the real upstream tagged checkout has no package metadata to validate.

A final adversarial review exposed two narrower boundary gaps. Their focused RED run failed 3 tests while 10 existing tests passed: inherited settings/home reads were not closed, the merge binding omitted the reviewed base SHA, and an advanced base SHA was still accepted. The focused GREEN rerun passed all 13 tests and TypeScript after adding the home isolation and immutable base-SHA/diff boundary.

A separate publication-credential RED assertion then proved the Claude launcher still inherited `GITHUB_TOKEN`; it passed after the launcher began deleting the complete sensitive-variable set before spawning Claude.

GREEN result after the smallest implementation changes:

```text
pnpm test:unit
Test Files  27 passed (27)
Tests       100 passed (100)
```

Additional final checks:

```text
pnpm exec tsc --noEmit
git diff --cached --check
```

## Scope and residual concerns

- No push, merge, PR creation, deployment, database mutation, host package installation, or host security-policy change was performed.
- Database-backed content sync was not executed because it mutates the configured database; shipped-catalog bootstrap, rubric verification, deterministic import, resolution, and snapshot selection are covered without that external mutation.
- The pre-existing untracked `docs/superpowers/plans/2026-08-02-superpowers-prompt-system.md` is user-owned workspace content and is intentionally excluded from this commit.
- Deployment must provide a working Claude Code OS sandbox backend (including its platform prerequisites). Failure is safe: execution-agent work stops before running when the sandbox is unavailable.
