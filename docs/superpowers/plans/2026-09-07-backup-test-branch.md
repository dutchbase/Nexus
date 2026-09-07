# Backup Test Branch Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the backup test from blocking automated deploys when the global Git hook protects `master` and `main`.

**Architecture:** Initialize the temporary test repository on `trunk`. Keep the existing commit, detached worktree, backup operation, and assertions.

**Tech Stack:** TypeScript, Vitest, Git, pnpm.

**Spec:** The user request in this conversation, “Fix scripts/backup.test.ts so it stops blocking automated deploys.” Its requirements and acceptance checks are recorded below.

## Global Constraints

- Use a normal branch/worktree workflow; do not commit, merge, or push directly on `master` or `main`.
- Keep the global Git hook enabled.
- Apply the existing fixture pattern: use `trunk` instead of `master` or `main`.
- Run the backup tests, then full `pnpm verify`.
- Preserve unrelated working tree changes.

---

### Task 1: Set the backup fixture branch to trunk

**Files:**
- Modify: `scripts/backup.test.ts:269`, the Git initialization in `archives a finalized Git worktree without retaining its live checkout metadata`.
- Test: `scripts/backup.test.ts`.
- Reference: `packages/project-config/src/index.test.ts:15` and `apps/worker/src/project-validate-job.test.ts:19`, which initialize fixtures on `trunk`.

**Interfaces:**
- Consumes: the existing local `git(cwd: string, args: string[])` helper, which throws when a Git command fails.
- Produces: no new interface; the temporary repository starts on `trunk` and its detached worktree still uses `HEAD`.

- [ ] **Step 1: Prepare a working branch**

Use the using-git-worktrees skill if isolation is needed. Otherwise, create a branch in this checkout and preserve its existing untracked files:

```bash
git switch -c fix/backup-test-trunk
```

- [ ] **Step 2: Run the existing regression test before the change**

```bash
pnpm exec vitest run scripts/backup.test.ts -t "archives a finalized Git worktree without retaining its live checkout metadata"
```

Expected on this machine: failure at the fixture commit with `BLOCKED: direct git operations on master/main are not allowed`. The current source explicitly sets `main`; it does not rely on Git's default branch setting. If the failure does not reproduce, record the result and keep the explicit branch fix because both protected names are unsuitable for this fixture.

- [ ] **Step 3: Change the initial branch**

Apply this one-line patch:

```diff
-    git(repository, ["init", "--initial-branch=main"]);
+    git(repository, ["init", "--initial-branch=trunk"]);
```

No extra test is needed: the existing test creates a commit, adds the detached worktree, and checks that the archive contains `result.txt` but not `.git`.

- [ ] **Step 4: Run all backup tests**

```bash
pnpm exec vitest run scripts/backup.test.ts
```

Expected: all tests pass, including the worktree archive test, with no branch protection error.

- [ ] **Step 5: Run the deploy verification command**

```bash
pnpm verify
```

Expected: TypeScript checking and the full Vitest suite pass. The package script is `tsc --noEmit && vitest run --config vitest.config.ts --reporter=verbose`. Report any other failure with its test name and error; do not claim verification passed if it failed.

- [ ] **Step 6: Review and commit on the working branch**

```bash
git diff --check
git diff -- scripts/backup.test.ts
git add scripts/backup.test.ts docs/superpowers/plans/2026-09-07-backup-test-branch.md
git commit -m "fix: initialize backup test repository on trunk"
```

The test source diff must contain only the initial branch change. Do not deploy or merge as part of this task.

## Plan Review

The single task covers the fixture change, the existing regression check, the complete backup test file, and full deploy verification. No dependency, production script, hook setting, or new helper needs to change.
