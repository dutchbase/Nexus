# G04 GitHub Integrity Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILLS: use `plan-orchestrator`, then `superpowers:subagent-driven-development`, `superpowers:test-driven-development`, and `superpowers:verification-before-completion`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate only G04-F01 through G04-F05 with authoritative, fresh, head-bound GitHub synchronization, review publication, and merging.

**Architecture:** Centralize provider transport and pagination first. Materialize GitHub policy snapshots from branch protection, reviews, requested reviewers, check runs, and commit statuses; merge through one compare-and-swap domain gate; use the existing AI review row as a resumable comment outbox.

**Tech Stack:** TypeScript, Node `fetch`/`AbortController`, PostgreSQL, Vitest.

## Global Constraints

- Branch: `agent/g04-github-integrity`; never commit, merge, or push `master`/`main`.
- Scope is exactly G04-F01, G04-F02, G04-F03, G04-F04, and G04-F05. No webhooks, GitHub App, deployment work, or local policy configuration.
- No dependencies. Reuse existing Postgres/Vitest/provider patterns. Keep AI automatic merging disabled.
- GitHub branch protection is authoritative. A protected policy that cannot be fully evaluated is incomplete and refuses merge.
- Every behavior change starts with a focused failing test, then minimal code, then its focused green test.

## Revalidated Current State

- G04-F01: `findOpenPullRequestForHead` does not include `owner:` and `listPullRequests` reads only one page.
- G04-F02: sync still copies optional `review_state`/`check_state` fields rather than fetching policy inputs.
- G04-F03: GraphQL hardcodes GitHub Cloud and provider fetches have no central timeout/retry/version/error policy.
- G04-F04: parser rejects ambiguity, but output, comment publication, and terminal state remain separate effects.
- G04-F05: expected SHA is optional and normal admin merge jobs have no policy snapshot binding.

---

### Task 1: Shared GitHub Transport and Complete PR Discovery

**Files:**
- Modify: `packages/github-provider/src/index.ts`
- Test: `packages/github-provider/src/index.test.ts`

**Interfaces:**

```ts
export type GitHubFetchMetadata = {
  complete: boolean;
  fetchedAt: string;
  cursor: string | null;
  errorCode?: string;
  retryAt?: string;
};
export type GitHubListResult<T> = GitHubFetchMetadata & { items: T[] };
export class GitHubProviderError extends Error {
  code: string;
  status?: number;
  retryAt?: string;
}
```

- [ ] **Step 1: Write failing transport tests**

Add HTTP-server tests proving `findOpenPullRequestForHead("acme", "widgets", "feature")` requests `head=acme%3Afeature`; a two-page `Link: rel="next"` list returns each PR number once; a failed second page returns `complete:false`, its partial items, cursor, and recovery metadata; configured REST base derives the GraphQL endpoint; every request has a 10-second abort; GET retries transient failures three times at 250 then 500 ms; rate limits return `rate_limited` plus reset/retry time; errors contain neither token nor response body.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/github-provider/src/index.test.ts --exclude '.worktrees/**'`

Expected: FAIL because pagination metadata, centralized policy, owner-qualified head, and stable errors do not exist.

- [ ] **Step 3: Implement the minimum shared transport**

Route REST, raw diff, GraphQL, branch merge, and pagination through one private request helper. Send `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2022-11-28`; derive `/graphql` for GitHub Cloud and `/api/graphql` from an Enterprise `/api/v3` base. Retry GET only; write operations get one bounded attempt. Follow only same-origin Link URLs, deduplicate page items by PR number, and return partial metadata instead of treating a failed page as complete.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm exec vitest run packages/github-provider/src/index.test.ts --exclude '.worktrees/**'`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/github-provider/src/index.ts packages/github-provider/src/index.test.ts
git commit -m "fix: centralize GitHub transport and pagination"
```

### Task 2: Authoritative GitHub Policy Snapshots

**Files:**
- Create: `packages/database/migrations/039_github_policy_snapshots.sql`
- Create: `packages/domain/src/pull-request-policy.ts`
- Create: `packages/domain/src/pull-request-policy.test.ts`
- Modify: `packages/github-provider/src/index.ts`
- Modify: `packages/domain/src/pull-request-sync.ts`
- Test: `packages/domain/src/pull-request-sync.test.ts`

**Interfaces:**

```ts
export type GitHubPolicyInputs = {
  pullRequest: ProviderPullRequest;
  protected: boolean;
  requiredApprovals: number;
  reviews: Array<{ id: number; reviewer: string; state: string; commitSha: string; submittedAt: string }>;
  requestedReviewers: Array<{ type: "user" | "team"; name: string }>;
  requiredChecks: Array<{ context: string; appId: number | null }>;
  checks: Array<{ context: string; appId: number | null; state: "success" | "pending" | "failure"; updatedAt: string }>;
  complete: boolean;
  incompleteReason?: string;
  fetchedAt: string;
};
export function evaluatePullRequestPolicy(inputs: GitHubPolicyInputs): {
  reviewState: "approved" | "changes_requested" | "pending" | "not_required" | "unknown";
  checkState: "success" | "failure" | "pending" | "not_required" | "unknown";
  refusalCodes: string[];
  material: Record<string, unknown>;
};
```

- [ ] **Step 1: Write failing policy and sync tests**

Cover latest-review reduction, stale-review SHA dismissal, requested reviewers, required/missing/failing checks, unprotected branches, unsupported protected policy, rate-limited stale state retaining the last snapshot, two-page sync without duplicate upserts, and partial sync recording `complete:false` plus cursor.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/github-provider/src/index.test.ts packages/domain/src/pull-request-policy.test.ts packages/domain/src/pull-request-sync.test.ts packages/database/src/migrate.test.ts --exclude '.worktrees/**'`

Expected: FAIL because policy inputs, storage, and freshness state do not exist.

- [ ] **Step 3: Add immutable snapshot storage and policy fetches**

Migration `039` creates `pull_request_policy_snapshots` with immutable material JSON/hash, head/base identity, computed states, completeness, source, and fetch time; adds current-snapshot/freshness fields to `pull_requests`; and adds `github_repository_sync_state(project_id primary key, cursor, complete, last_attempted_at, last_completed_at, error_code, retry_after)`.

Fetch PR detail, branch protection, paginated reviews, requested reviewers, paginated check runs, and combined commit statuses. Reduce every reviewer to their latest effective state; require approvals and checks from branch protection. If a protected rule needs code-owner or last-push proof that these inputs cannot establish, persist an incomplete snapshot and refuse merges.

- [ ] **Step 4: Persist only evaluated truth**

Replace all writes of `remote.review_state` and `remote.check_state`. Insert a policy snapshot and update its PR pointer atomically; retain the prior snapshot on a rate/transport failure and mark its PR stale with error/retry metadata. Import partial pages and record incompleteness rather than silently claiming a full sync.

- [ ] **Step 5: Verify GREEN and commit**

```bash
pnpm exec vitest run packages/github-provider/src/index.test.ts packages/domain/src/pull-request-policy.test.ts packages/domain/src/pull-request-sync.test.ts packages/database/src/migrate.test.ts --exclude '.worktrees/**'
git add packages/database/migrations/039_github_policy_snapshots.sql packages/github-provider/src packages/domain/src
git commit -m "feat: materialize GitHub policy snapshots"
```

### Task 3: Final Head-Bound Merge Gate

**Files:**
- Create: `packages/database/migrations/040_head_bound_merges.sql`
- Modify: `packages/domain/src/pr-merge.ts`
- Test: `packages/domain/src/pr-merge.test.ts`
- Modify: `apps/worker/src/provider-jobs.ts`
- Test: `apps/worker/src/provider-jobs.test.ts`
- Modify: `apps/web/src/server.ts`
- Test: `apps/web/src/approval-route-regressions.test.ts`

**Interfaces:**

```ts
export async function approveAndMergePullRequest(
  db: pg.Pool,
  input: {
    pullRequestId: string;
    jobId: string;
    actor: { type: "worker" | "admin"; id: string };
    expectedHeadSha: string;
    expectedPolicySnapshotId: string;
  },
  assertOwned?: () => Promise<void>,
): Promise<{ mergedSha: string; mergedHeadSha: string; policySnapshotId: string }>;
```

The `github.merge_pull_request` job payload must contain `pull_request_id`, `actor_id`, `expected_head_sha`, and `policy_snapshot_id`. `mergePullRequest` must require—not optionally accept—its expected SHA.

- [ ] **Step 1: Write failing merge tests**

Cover missing/stale browser binding, changed head, changed policy material, missing/failing checks, missing/changes-requested reviews, incomplete policy, expected-SHA request body, provider head-race refusal, successful merge evidence, and retry reconciliation of an already merged PR.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/domain/src/pr-merge.test.ts apps/worker/src/provider-jobs.test.ts apps/web/src/approval-route-regressions.test.ts --exclude '.worktrees/**'`

Expected: FAIL because normal merge jobs have no expected binding.

- [ ] **Step 3: Implement the shared compare-and-swap gate**

Migration `040` creates `pull_request_merge_attempts` keyed to the job and recording expected/verified snapshots, expected/merged SHA, state, refusal code, provider response, actor, and timestamps. The web route rejects absent or stale bindings before queueing. The domain function loads the expected snapshot, fetches and stores a final policy snapshot, requires matching policy material plus fresh satisfied inputs, records any refusal, sends the expected SHA to GitHub, then atomically records the merged head, merge SHA, verified snapshot, and provider response before best-effort sync.

- [ ] **Step 4: Verify GREEN and commit**

```bash
pnpm exec vitest run packages/domain/src/pr-merge.test.ts apps/worker/src/provider-jobs.test.ts apps/web/src/approval-route-regressions.test.ts --exclude '.worktrees/**'
git add packages/database/migrations/040_head_bound_merges.sql packages/domain/src/pr-merge* apps/worker/src/provider-jobs* apps/web/src
git commit -m "fix: bind merges to verified GitHub policy"
```

### Task 4: Resumable AI Review Publication

**Files:**
- Create: `packages/database/migrations/041_pr_review_publication.sql`
- Create: `packages/domain/src/pr-review-publication.ts`
- Create: `packages/domain/src/pr-review-publication.test.ts`
- Modify: `packages/domain/src/pr-review.ts`
- Modify: `apps/worker/src/worker.ts`
- Modify: `apps/worker/src/workflow-state.ts`
- Test: `apps/worker/src/workflow-state.test.ts`

**Interfaces:**

```ts
type PrReviewVerdictErrorCode =
  | "missing_verdict"
  | "ambiguous_verdict"
  | "invalid_verdict_json"
  | "invalid_verdict_value"
  | "invalid_verdict_summary";
```

Migration `041` adds publication UUID, raw output, parsed verdict, reviewed refs, publication state/count, comment ID, error code, and last publication error to each `pr_ai_reviews` attempt. The comment marker is `<!-- dcc-review-publication:{publication_id} -->`.

- [ ] **Step 1: Write failing publication tests**

Cover actionable parser codes; persisting output/verdict/refs before external comment creation; retry after posted comment finding the marker without a second post; incomplete comment search refusing to post; retry skipping Claude and reusing output; terminal history remaining visible; and three retries sharing one review/publication identity.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/domain/src/pr-review.test.ts packages/domain/src/pr-review-publication.test.ts apps/worker/src/workflow-state.test.ts apps/worker/src/task-6.test.ts --exclude '.worktrees/**'`

Expected: FAIL because review rows cannot resume publication safely.

- [ ] **Step 3: Implement the smallest resumable state machine**

Use the existing review row as the outbox: invoke/parse/persist once; find a marker before posting; persist comment identity and terminal status in one DB update. Publication errors leave a parsed review retryable; model/parser errors are terminal and carry a stable code. Set review jobs to three attempts. Keep legacy `review_and_merge` data readable but delete the dead automatic merge call and its unused binding helpers.

- [ ] **Step 4: Verify GREEN and commit**

```bash
pnpm exec vitest run packages/domain/src/pr-review.test.ts packages/domain/src/pr-review-publication.test.ts apps/worker/src/workflow-state.test.ts apps/worker/src/task-6.test.ts --exclude '.worktrees/**'
git add packages/database/migrations/041_pr_review_publication.sql packages/github-provider/src packages/domain/src apps/worker/src
git commit -m "fix: make PR review publication idempotent"
```

### Task 5: Operator Truth and Final Verification

**Files:**
- Modify: `apps/web/src/pages/prs.ts`
- Modify: `apps/web/src/ui.ts`
- Test: `apps/web/src/pages/prs-list-actions.test.ts`

- [ ] **Step 1: Write failing UI tests**

Assert GitHub review/check source labels, policy timestamp, stale/incomplete/rate-limited status text, requested reviewers, disabled merge controls without a fresh complete binding, review/publication IDs in history, and absence of the misleading automatic-AI-merge controls.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run apps/web/src/pages/prs-list-actions.test.ts apps/web/src/approval-route-regressions.test.ts --exclude '.worktrees/**'`

Expected: FAIL because the page displays internal/fallback state without freshness provenance.

- [ ] **Step 3: Implement the narrow UI change**

Render authoritative states as `GitHub: …`, include `policy_synced_at`, stale reason/retry time, and requested reviewers. Enable admin merge only with a fresh complete snapshot and bound head. Remove the non-functional “AI Review & Approve” actions and the admin target-branch merge field; preserve the existing styles and layout.

- [ ] **Step 4: Focused verification and commit**

```bash
pnpm exec vitest run packages/github-provider/src/index.test.ts packages/domain/src/pull-request-policy.test.ts packages/domain/src/pull-request-sync.test.ts packages/domain/src/pr-merge.test.ts packages/domain/src/pr-review.test.ts packages/domain/src/pr-review-publication.test.ts apps/worker/src/provider-jobs.test.ts apps/worker/src/workflow-state.test.ts apps/worker/src/task-6.test.ts apps/web/src/approval-route-regressions.test.ts apps/web/src/pages/prs-list-actions.test.ts --exclude '.worktrees/**'
git add apps/web/src/pages/prs.ts apps/web/src/ui.ts apps/web/src/pages/prs-list-actions.test.ts
git commit -m "fix: show GitHub policy freshness"
```

- [ ] **Step 5: Run required acceptance and review**

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run apps packages
node /home/deploy/.agents/skills/impeccable/scripts/detect.mjs --json apps/web/src/pages/prs.ts apps/web/src/ui.ts
git diff --check
```

Run a final whole-branch review. Fix only confirmed G04 regressions, rerun all four commands, then leave the branch ready for publication.

## Assumptions

- GitHub branch protection, reviews, requested reviewers, checks, and commit statuses provide the needed current policy inputs.
- Pagination reports a stale partial state rather than attempting cursor resume across a mutable list.
- Rate limiting exposes retry metadata and does not keep a worker asleep until a distant reset.
- The current no-automatic-merge safeguard remains in force; an approved AI review still requires the head-bound admin merge path.
