# G01 Workflow-State Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate only G01-F01, G01-F02, G01-F03, and G01-F04 with durable ownership, immutable reruns, retryable publication, and truthful worker capacity.

**Architecture:** Add narrowly scoped PostgreSQL state for leases, rerun lineage, and execution publication. Enforce ownership in the existing domain queue functions, reconcile abandoned or authentication-blocked state in a testable worker helper, and keep the worker sequential while reporting capacity honestly.

**Tech Stack:** TypeScript 5.8, PostgreSQL, pg, pnpm, Vitest.

## Global Constraints

- Read `docs/audit/dev-control-audit.json` and revalidate G01-F01 through G01-F04 against the task's current HEAD before editing.
- Work only in the isolated `agent/g01-workflow-state` worktree; never commit, merge, or push directly on main/master.
- Use TDD: add a focused failing regression, observe the expected failure, then implement the minimum passing change.
- Apply ponytail full: reuse existing code and dependencies, add no generic workflow framework, no new dependency, and no worker concurrency.
- Preserve unrelated user work and avoid every other audit finding and roadmap item.
- Lease duration is 60 seconds; renewal interval is 20 seconds; recovery batches are limited to 100 rows.
- `jobs.id` is the immutable attempt identity and is exposed as `attempt_id`; do not add a redundant attempt UUID.
- Run focused tests per task, then `pnpm exec tsc --noEmit` and `pnpm exec vitest run apps packages` before completion.

---

### Task 1: Durable workflow schema

**Files:**
- Create: `packages/database/migrations/037_workflow_state.sql`
- Modify: `packages/database/src/migrate.test.ts`

**Interfaces:**
- Produces nullable `jobs.rerun_of`, `jobs.lease_expires_at`, `jobs.recovery_reason`.
- Produces nullable `notification_deliveries.claimed_by`, `lease_expires_at`, `recovery_reason`.
- Produces `execution_publications` with one row per execution attempt; statuses are `pending`, `publishing`, `published`, `failed`.

- [ ] Write database migration tests for rerun foreign keys, unique publication identity/idempotency, publication status validation, and lease metadata.
- [ ] Run `pnpm exec vitest run packages/database/src/migrate.test.ts` and confirm the new test fails because migration 037 is absent.
- [ ] Add migration 037 with the exact columns and constraints above. `execution_publications` contains `id`, `execution_attempt_id`, `idempotency_key`, `status`, `last_job_id`, `pull_request_id`, `attempt_count`, `error_message`, `created_at`, `updated_at`, and `published_at`; use `ON DELETE RESTRICT` for the execution attempt and `ON DELETE SET NULL` for job/PR references.
- [ ] Re-run the focused test and confirm it passes; database-backed cases may skip when `DCC_TEST_DATABASE_URL` is unset.
- [ ] Commit on the feature branch with `git commit -m "feat: add durable workflow state"`.

### Task 2: Lease-safe queue primitives

**Files:**
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/domain/src/notifications.ts`
- Create: `packages/domain/src/workflow-state.test.ts`

**Interfaces:**
- `JobInput` adds `rerunOf?: string`.
- Add `renewJobLease(id: string, workerId: string): Promise<boolean>`.
- Change `completeJob` and `failJob` to return `Promise<boolean>` and require an unexpired matching lease.
- Add notification claim, renewal, completion, and failure functions with the same live-owner contract.

- [ ] Write tests for active duplicate suppression, linked terminal rerun insertion, lease assignment/renewal, and rejection of completion/failure by an expired or different owner.
- [ ] Run `pnpm exec vitest run packages/domain/src/workflow-state.test.ts packages/domain/src/notifications.test.ts` and confirm expected failures.
- [ ] Persist `rerun_of`; keep the unique idempotency key behavior so an identical active enqueue returns the existing row.
- [ ] Set a 60-second lease when claiming, renew only the live owner, and gate completion/failure on matching owner plus `lease_expires_at > now()`.
- [ ] Move delivery claim/result ownership SQL into `notifications.ts`; failed delivery retries clear owner/lease while retaining recovery metadata.
- [ ] Re-run the focused tests and commit with `git commit -m "fix: enforce renewable workflow ownership"`.

### Task 3: Recovery, authentication refusal, and rerun state

**Files:**
- Create: `apps/worker/src/workflow-state.ts`
- Create: `apps/worker/src/workflow-state.test.ts`
- Modify: `apps/worker/src/worker.ts`
- Modify: `apps/web/src/server.ts`
- Modify: `apps/web/src/approval-route-regressions.test.ts`

**Interfaces:**
- Worker recovery accepts the existing pool/client boundary and processes at most 100 expired rows transactionally.
- Review/conflict routes return an existing active attempt, or create a new row/job linked with `rerunOf` after terminal history.

- [ ] Write failing behavior tests for one-time job/delivery recovery audits, exhausted-job state, authentication-refusal matrices, active duplicate suppression, and terminal linked reruns.
- [ ] Run `pnpm exec vitest run apps/worker/src/workflow-state.test.ts apps/web/src/approval-route-regressions.test.ts` and confirm expected failures.
- [ ] Recover expired rows using `FOR UPDATE SKIP LOCKED LIMIT 100`; requeue jobs with attempts left, fail exhausted jobs, clear ownership, set `recovery_reason='lease_expired'`, and append one audit event in the same transaction.
- [ ] Mark related running agent runs failed with `worker_lease_expired`; reconcile planning, execution/repair, AI-review, and conflict-resolution terminal states, inserting ticket history only for real status changes. Reuse this matrix for authentication refusal.
- [ ] Renew claimed job/delivery leases every 20 seconds while work is active and always clear timers. A lost owner must not complete or fail the row.
- [ ] Set AI-review and conflict jobs to `maxAttempts: 1`; suppress active duplicates and link a new terminal rerun without mutating prior records. Link publication/repair retries to `agent_runs.metadata_json.job_id`.
- [ ] Re-run focused tests and commit with `git commit -m "fix: recover abandoned workflow attempts"`.

### Task 4: Durable publication transitions

**Files:**
- Modify: `apps/worker/src/worker.ts`
- Modify: `apps/worker/src/publish-artifact-atomicity.test.ts`
- Modify: `apps/web/src/server.ts`
- Modify: `apps/web/src/approval-route-regressions.test.ts`

**Interfaces:**
- Publication uses one `execution_publications` record keyed by execution attempt and external idempotency key.
- Publication failures propagate to `failJob` without rewriting `PR Creation Failed` as `Execution Failed`.

- [ ] Write failing behavior tests for intent-before-provider ordering, retryable provider failure, duplicate reconciliation, and one final database transaction.
- [ ] Run `pnpm exec vitest run apps/worker/src/publish-artifact-atomicity.test.ts apps/web/src/approval-route-regressions.test.ts` and confirm expected failures.
- [ ] After the local commit, transactionally persist validated attempt state, commit audit, and pending publication intent before push/PR creation.
- [ ] Move the intent to `publishing`, increment attempts, attach the current job, and record `execution.publication.requested` before provider calls.
- [ ] Keep `findOpenPullRequestForHead` as duplicate reconciliation. On success, one transaction upserts the PR and atomically writes artifact, ticket/history, notification, completed attempt, published record, and `execution.publication.published` audit.
- [ ] On failure, preserve a `failed` publication and prior history, set `PR Creation Failed`, record failure, then throw a publication-specific error that bypasses the generic execution-failure rewrite.
- [ ] Require a failed publication for retry; reset the same record to pending and enqueue a linked rerun without changing its external idempotency key.
- [ ] Re-run focused tests and commit with `git commit -m "fix: make publication transitions durable"`.

### Task 5: Truthful operator state and capacity

**Files:**
- Modify: `apps/web/src/pages/queue.ts`
- Modify: `apps/web/src/server.ts`
- Create: `apps/web/src/queue-workflow-state.test.ts`

**Interfaces:**
- `GET /api/admin/jobs` retains `jobs` and adds `capacity: { configured: 1, observed_running: number }`.

- [ ] Write a failing route/page test for configured capacity 1, observed running count, lease owner/expiry, rerun origin, and recovery reason.
- [ ] Run `pnpm exec vitest run apps/web/src/queue-workflow-state.test.ts` and confirm the expected failure.
- [ ] Label capacity `1 total · sequential`, display observed running and ownership/recovery data, and derive heartbeat from renewed running-job state rather than a stale claim timestamp.
- [ ] Extend the jobs API with the capacity object; do not add concurrency or capacity configuration.
- [ ] Re-run the focused test and commit with `git commit -m "fix: report truthful worker capacity"`.

### Task 6: Final verification and review

**Files:** No production changes unless review finds a scoped defect.

- [ ] Run all focused tests from Tasks 1–5 together.
- [ ] Run `pnpm exec tsc --noEmit`.
- [ ] Run `pnpm exec vitest run apps packages`.
- [ ] Review the full branch against G01-F01 through G01-F04 and confirm no unrelated audit or roadmap work entered the diff.
- [ ] Use `superpowers:finishing-a-development-branch`; do not land or push without the user's selected finish action.
