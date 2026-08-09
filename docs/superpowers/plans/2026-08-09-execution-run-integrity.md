# Execution Run Integrity Implementation Plan

## Goal

Make execution runs edit the private execution clone and reject runs that produce only empty file artifacts. This fixes the confirmed failures in RUN-8412 and RUN-4293 without adding an AI compliance gate.

## Global Constraints

- Use test-driven development: add one focused regression test, confirm that it fails for the expected reason, then write the minimum code that passes it.
- Keep prompt snapshots stable and use `.` as the runtime worktree path because the executor process already runs with the private clone as its current directory.
- Keep Claude execution fail-closed: enable `Edit`, `Write`, and `Bash` globally, protect file access with the existing file hook, and protect top-level Bash with the existing Bash guard.
- Reject only contentless changes. Do not reject whitespace changes because whitespace can be semantic. Count binary diffs as content and require untracked files to contain at least one byte.
- Add no dependencies, new abstraction layers, or extra AI calls.

### Task 1: Point execution prompts at the private clone

**Files:** `apps/worker/src/worker-boundary.ts`, `apps/worker/src/task-7.test.ts`

Change the runtime worktree JSON built by `approvedExecutionInput` so `path` is `.` instead of `details.worktreePath`. Keep the branch, base commit, repair diff, validation output, administrator feedback, and approved snapshot behavior unchanged. Add a focused test that proves the generated prompt contains `"path": "."` and does not contain the supplied host worktree path.

Run the focused worker test and commit as `fix(worker): target the private execution clone`.

### Task 2: Enable guarded Claude execution tools

**Files:** `packages/claude-runner/src/index.ts`, `packages/claude-runner/src/index.test.ts`

Change the execution-level Claude tool list to `Read,Glob,Grep,Edit,Write,Bash,Skill,Agent`. Add a top-level `PreToolUse` Bash hook that runs `hookCommand(guardPath)`, in addition to the current file and Agent hooks. Keep the session-agent tool lists and sandbox rules unchanged. Update the focused tests to prove the global tools are available, the Bash hook exists, an allowed validation command passes, and an unrelated shell command is denied by the existing guard.

Run the Claude runner tests and commit as `fix(claude-runner): enable guarded execution tools`.

### Task 3: Reject contentless execution diffs

**Files:** `packages/git-runner/src/index.ts`, `packages/git-runner/src/index.test.ts`

Extend `validateEffectiveWorktree` after changed-file detection with a `content-change inspection` check. Reject a worktree when tracked changes have zero inserted and deleted lines and all untracked files have zero bytes. Treat a binary diff as content. Preserve the existing protected-path and secret checks and their order after this new check. On failure, use `execution produced only contentless file changes`.

Add focused tests for: only empty untracked files (reject), empty tracked files (reject), a non-empty untracked file (pass), a normal text edit (pass), and a binary edit (pass). Reuse existing Git helpers and Node standard-library APIs.

Run the Git runner tests and commit as `fix(git-runner): reject contentless execution diffs`.

## Final Verification and Release

- Run the three focused test files after all tasks.
- Run `pnpm verify` from the repository root.
- Complete a whole-branch review against the starting commit.
- Push `agent/fix-execution-run-integrity` and create a draft GitHub pull request with the failure evidence, root causes, changes, and verification results.
- Production acceptance after merge: repair DCC-1014 through the normal workflow; keep the contentless DCC-1016 PR unmerged and retry DCC-1016 through the normal workflow.
