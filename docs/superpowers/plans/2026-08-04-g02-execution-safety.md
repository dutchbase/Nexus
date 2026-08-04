# G02 Execution Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close G02-F01 through G02-F06 with fresh attempt identity, scoped child authority, safe worktree lifecycle, and atomic planning finalization.

**Architecture:** Keep the existing worker and runner boundaries. Add immutable repair-attempt lineage and lifecycle fields, harden the existing Git/Claude helpers, and reuse artifact/workflow recovery rather than introducing new frameworks.

**Tech Stack:** TypeScript, PostgreSQL migrations, Node child processes, Vitest, pnpm.

## Global Constraints

- Start from current `master` in a new isolated worktree/branch; preserve the unrelated untracked `docs/CODEMAPS/` in the source checkout.
- Never commit, merge, or push on `main`/`master`; branch commits only.
- Remediate only G02-F01–F06. Add no dependencies or UI/config surface.
- Terminal worktrees expire after a fixed 24 hours.
- Use sequential fresh subagents with per-task review; choose the least capable model that can handle each task.

### Task 1: Fresh, immutable execution and repair attempts (G02-F01, G02-F04)

**Files:** `apps/web/src/server.ts`, `apps/worker/src/worker.ts`, `apps/worker/src/execution-handoff.ts`, `apps/worker/src/execution-publication.ts`, `packages/git-runner/src/index.ts`, a new database migration, and focused tests.

- [ ] Add `source_execution_attempt_id`, `worktree_lifecycle_status`, `worktree_expires_at`, and `worktree_reclaimed_at` to execution attempts. Set worktree expiry to 24 hours after a terminal attempt; preserve earlier attempt fields as history.
- [ ] Make repair queueing create a new attempt and job bound to the source attempt. Both execution and repair must create a fresh worktree from fetched `origin/<defaultBranch>`, persist that fetched SHA, and require a clean repository and configured remote.
- [ ] Publication/retry must require the attempt result commit to equal worktree `HEAD`, descend from its recorded base, and have passed validation. Remove repair reuse of the old result commit.
- [ ] Replace no-op worktree cleanup with a bounded, idempotent reaper for expired terminal attempts without queued/running jobs; never remove a live or uncontrolled worktree.
- [ ] Add stale-repair, immutable-history, fresh-base, stale-repository, live-worktree, and expired-reclamation regressions.

### Task 2: Classify staged changes before secret inspection (G02-F02)

**Files:** `packages/git-runner/src/index.ts`, `packages/git-runner/src/index.test.ts`.

- [ ] Classify NUL-delimited cached name-status output. Scan blobs only for added, modified, copied, and rename-destination paths; retain protected-path checks for all paths and treat deletions as content-free.
- [ ] Add staged deletion, added/modified secret, rename, and binary regressions.

### Task 3: Explicit child authority and conflict-path enforcement (G02-F03, G02-F05)

**Files:** `packages/claude-runner/src/index.ts`, `packages/claude-runner/src/bash-guard.mjs`, `apps/worker/src/worker.ts`, related runner/worker tests.

- [ ] Give planning children an explicit minimal environment and timeout; never inherit worker credentials. Record only profile names, not values.
- [ ] Add `allowedWritePaths?: readonly string[]` to execution invocation. Enforce it in both sandbox settings and file hook, while preserving whole-private-worktree execution by default.
- [ ] Run conflict resolution through the execution sandbox with only original conflicted files writable. The trusted worker stages those exact paths, rejects remaining conflicts/markers, validates, then publishes.
- [ ] Add credential-canary, outside-worktree/path refusal, conflicted edit, unrelated write refusal, and remaining-marker regressions.

### Task 4: Bounded, atomic planning finalization (G02-F06)

**Files:** `packages/claude-runner/src/index.ts`, `apps/worker/src/worker.ts`, `apps/worker/src/workflow-state.ts`, focused tests.

- [ ] Add planning timeout (`planning_timeout_ms`, default 30 minutes) and typed timeout outcome.
- [ ] Finalize planning success in one lease-fenced transaction: plan/version, pointers, ticket/history/notification, and completed run. Finalize failure/timeout and `Planning Failed` atomically too.
- [ ] Reuse existing workflow recovery for stranded planning jobs. Do not add a plan artifact: plans are already database content and temporary prompt files are removed.
- [ ] Add timeout, pre-finalization failure, and idempotent recovery regressions.

## Final Verification

- [ ] Run focused tests for each task.
- [ ] Run `pnpm exec tsc --noEmit`.
- [ ] Run `pnpm exec vitest run apps packages`.
- [ ] Perform a whole-branch review against G02-F01–F06 only.
