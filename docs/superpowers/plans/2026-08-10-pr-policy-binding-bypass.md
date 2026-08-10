# Configurable PR Merge Policy Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an administrator disable the local GitHub policy-snapshot requirement while always keeping the GitHub head-SHA merge check.

**Architecture:** Add a global merge setting that defaults to disabled. When disabled, the web UI and worker need only the approved head SHA. GitHub still applies repository rules. When enabled, the current snapshot, freshness, review, and check enforcement remains unchanged.

**Tech Stack:** TypeScript, PostgreSQL, Vitest.

## Global Constraints

- Work only on this feature branch. Do not commit, merge, or push directly to `master`.
- No new dependency, no per-project setting, and no branch-protection fetch in the disabled merge path.
- `require_fresh_policy_binding` defaults to `false`.
- Keep GitHub head-SHA compare-and-merge safety in both modes.

---

### Task 1: Add the global setting and allow unbound merge records

**Files:**
- Create: `packages/database/migrations/051_pull_request_merge_settings.sql`
- Modify: `packages/database/src/migrate.test.ts`

**Produces:** `pull_request_merge_settings(id=1, require_fresh_policy_binding boolean NOT NULL DEFAULT false)` and merge attempts whose policy snapshot IDs can be null.

- [ ] Write a migration integration test that asserts the seeded value is false and a `merged` attempt may have null expected and verified policy snapshot IDs.
- [ ] Run `pnpm exec vitest run packages/database/src/migrate.test.ts` and confirm it fails for the new behaviour.
- [ ] Add the singleton setting table and seed row. Drop only the existing `pull_request_merge_attempts` check that requires `verified_policy_snapshot_id` for a merged row, then replace it with a named check that requires only `merged_head_sha` and `merged_sha`. Drop `NOT NULL` from `expected_policy_snapshot_id`.
- [ ] Re-run `pnpm exec vitest run packages/database/src/migrate.test.ts`.
- [ ] Commit with `feat: add configurable PR merge policy gate`.

### Task 2: Make the merge worker use the setting at execution time

**Files:**
- Create: `packages/domain/src/pull-request-merge-settings.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/domain/src/pr-merge.ts`
- Modify: `packages/domain/src/pr-merge.test.ts`
- Modify: `apps/worker/src/provider-jobs.ts`
- Modify: `apps/worker/src/provider-jobs.test.ts`

**Produces:** `getPullRequestMergeSettings(client): Promise<{ requireFreshPolicyBinding: boolean }>` and an optional `expectedPolicySnapshotId` in merge jobs.

- [ ] Add failing domain tests for disabled enforcement: a matching head merges without policy input fetch or snapshot, and a changed head refuses before the merge request. Keep tests that prove enabled enforcement still blocks changed policy, checks, reviews, and incomplete policy.
- [ ] Run `pnpm exec vitest run packages/domain/src/pr-merge.test.ts` and confirm the new disabled-path test fails.
- [ ] Implement the setting helper. Read it in `approveAndMergePullRequest` when the worker executes. In disabled mode, load only PR/project data, fetch the PR with `getPullRequest`, refuse a head mismatch, call `mergePullRequest` with the expected head, preserve retry reconciliation, write merge attempt evidence with null policy IDs, mark the cached PR merged, and complete its linked ticket. Do not call `getPullRequestPolicyInputs` or `syncPullRequest` in this mode. In enabled mode, retain the current policy-binding implementation.
- [ ] Update provider jobs so `expected_head_sha` stays required and `policy_snapshot_id` is optional. Omit an absent snapshot from the audit payload.
- [ ] Run `pnpm exec vitest run packages/domain/src/pr-merge.test.ts apps/worker/src/provider-jobs.test.ts`.
- [ ] Commit with `feat: allow head-bound PR merges without policy snapshots`.

### Task 3: Add the administrator control and align the approval UI

**Files:**
- Modify: `apps/web/src/server.ts`
- Modify: `apps/web/src/approval-route-regressions.test.ts`
- Modify: `apps/web/src/pages/operate.ts`
- Modify: `apps/web/src/pages/settings-github.test.ts`
- Modify: `apps/web/src/pages/prs.ts`
- Modify: `apps/web/src/pages/prs-list-actions.test.ts`
- Modify: `apps/web/src/ui.ts`

**Produces:** `POST /api/admin/settings/pull-request-merge` with `{ require_fresh_policy_binding: boolean }`.

- [ ] Add failing route tests: enforcement disabled queues a merge with only a matching head even when snapshot data is missing or stale; enforcement enabled keeps the existing 409 response. Add settings-page and detail-page tests for the checkbox and enabled/disabled merge button states.
- [ ] Run `pnpm exec vitest run apps/web/src/approval-route-regressions.test.ts apps/web/src/pages/prs-list-actions.test.ts apps/web/src/pages/settings-github.test.ts` and confirm the new tests fail.
- [ ] Add a GitHub Settings checkbox named `require_fresh_policy_binding`, unchecked by default, with this help text: `When disabled, Approve & merge checks only the selected commit. GitHub still applies its repository rules.` Submit its boolean to the new endpoint. Validate a boolean server-side and save the singleton row with actor and timestamp.
- [ ] Read the setting in the approval route and PR detail renderer. Disabled mode requires only a matching head SHA and does not send a snapshot ID. Enabled mode retains all current snapshot, freshness, review, and check blockers.
- [ ] Run `pnpm exec vitest run apps/web/src/approval-route-regressions.test.ts apps/web/src/pages/prs-list-actions.test.ts apps/web/src/pages/settings-github.test.ts`.
- [ ] Commit with `feat: add PR policy binding setting`.

## Verification

- Run `pnpm exec tsc --noEmit`.
- Run `pnpm verify`.
- The targeted regression must prove the current case: no policy snapshot plus matching head queues and completes a merge when the setting is disabled.
