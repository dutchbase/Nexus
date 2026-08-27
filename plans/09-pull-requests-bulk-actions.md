# Pull Requests — Bulk Actions (AI review, Close, Approve & merge) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is a large, multi-task plan — use per-task review checkpoints, not one giant diff.

**Goal:** Add row selection and a bulk-action toolbar to the `/admin/pull-requests` list page supporting three actions — `AI review`, `Close PR`, `Approve & merge` — each reusing (not bypassing) all existing single-PR safety logic, with per-PR outcome reporting, server-side re-verification immediately before every mutation, and a brand-new "close a GitHub PR" capability that does not exist anywhere in the codebase today.

**Architecture:** Three things this codebase does not yet have, added as small, isolated primitives, then composed into the bulk feature:
1. **Close-PR capability** (does not exist today — confirmed by investigation, no route/provider function/job type). Added the same way every other GitHub mutation in this codebase is added: a `closePullRequest()` function in `packages/github-provider` (a `PATCH .../pulls/{n}` with `{ state: "closed" }`, sibling to the existing `updatePullRequestBase`), a new `github.close_pull_request` job type in `apps/worker/src/provider-jobs.ts` (sibling to `github.merge_pull_request`), executed asynchronously by the existing worker job queue — never a synchronous call from the web server.
2. **Extraction of the two single-PR action bodies that bulk must reuse.** The current `approve` and `ai-review` actions in `apps/web/src/server.ts`'s `pullRequestActionMatch` handler are fully inline in one large `if/else if` chain — not separately callable. This plan extracts each into a small, named async function (`evaluateApproveEligibility`, `startAiReview`) with **zero behavior change** to the existing single-PR routes (proven by Task 2's regression tests passing unmodified against the extracted code), so a new bulk route can call the exact same logic per PR instead of copy-pasting it.
3. **A per-PR eligibility classifier for the merge pre-flight display**, extending — not replacing — the existing inline `mergeBlocker`/`policyAllowsMerge` computation in `apps/web/src/pages/prs.ts` (`renderDetail`, lines ~44-72). That computation only considers policy/head-SHA state; it does not check `is_draft` or `merge_conflicts` (confirmed absent from `mergeBlocker` by direct investigation) because GitHub's own merge endpoint already rejects drafts/conflicts synchronously for a single click. For a *bulk* operation, silently discovering that 3 of 20 PRs were draft/conflicted only after they fail server-side is a materially worse experience than for one PR — so the bulk pre-flight classifier explicitly adds `is_draft`/`merge_conflicts` checks on top of the existing policy checks. **This plan's classifier is a new, small, purpose-built function for bulk pre-flight display — it does not modify `renderDetail`'s existing button-disable behavior on the PR detail page at all** (out of scope; changing single-PR UI behavior is not requested and risks regressing plan 01, which independently touches the same lines — see Global Constraints).

No new DB tables or columns are needed: `pull_requests` already carries every column the classifier needs (`head_sha`, `current_policy_snapshot_id`, `policy_stale`, `policy_complete`, `policy_error_code`, `policy_retry_after`, `review_state`, `check_state`, `is_draft`, `merge_conflicts`, `state`), and `audit_events`/`jobs` already support per-item, per-batch tracking via their existing `metadata_json`/`payload_json` columns (a client-generated `batch_id` UUID is threaded through as metadata, not a new column).

**Tech Stack:** TypeScript, Vitest (`vitest run --config vitest.config.ts`), Playwright (`tests/e2e/*.spec.ts`), node-postgres (`pg`), plain server-rendered HTML + vanilla client JS (no framework), existing job queue (`jobs` table, `claimJob`/`enqueueJob`/`FOR UPDATE SKIP LOCKED`).

**Spec:** This markdown file is self-contained; source task is "Add bulk actions to the Pull Requests page" (see `plans/INDEX.md` for the full original task text, including all UI mockups this plan implements).

## Global Constraints

- **Never bypass existing single-PR safety logic.** Bulk `ai-review` must call the exact same dedup/eligibility logic as single-PR `ai-review` (Task 2 extracts it so there is only one implementation, not two). Bulk `merge` must enqueue the exact same `github.merge_pull_request` job type, processed by the exact same `approveAndMergePullRequest` domain function, with server-fetched (never client-supplied) `expected_head_sha`/`policy_snapshot_id` — the real safety net (live GitHub re-fetch + policy re-evaluation + compare-and-swap against GitHub itself) lives inside `approveAndMergePullRequest` (`packages/domain/src/pr-merge.ts`) regardless of how the job was enqueued, and this plan must not touch that function.
- **Dependency on plan 01 (`plans/01-github-policy-merge-eligibility.md`) for Task 3 only.** Plan 01 independently extracts the same inline `policyIssue`/`mergeBlocker` computation in `prs.ts` into a shared `derivePolicyStatus()` function in `packages/domain/src/pull-request-policy-status.ts`. Task 3 of this plan needs that same underlying policy logic for its bulk classifier. **If plan 01 has already been merged when Task 3 is executed, import and call `derivePolicyStatus()` directly instead of re-deriving policy status from scratch** — do not create a second, diverging copy of this logic. If plan 01 has *not* yet merged, Task 3 falls back to calling the current inline computation's *shape* (documented in Task 3 below) as a local, clearly-labeled `// TODO: replace with derivePolicyStatus() once plan 01 merges` — and the plan 01 executor (or a follow-up) must come back and delete that fallback once plan 01 lands. Do not block this entire plan on plan 01's merge; only Task 3 has this conditional path, and Tasks 1, 2, 4-9 have zero dependency on plan 01.
- **`prs.ts` is touched by plan 01, plan 06 (Nexus rebrand — list-view badge markup), and this plan.** All three add/modify disjoint regions (plan 01: the `policyIssue`/`mergeBlocker` derivation; plan 06: CSS/markup classes only; this plan: new checkbox column + bulk toolbar markup). Rebase carefully; do not blindly accept "ours"/"theirs" on conflicts in this file.
- **Never trust client-supplied PR state for merge eligibility.** The existing single-PR `approve` route accepts `expected_head_sha`/`policy_snapshot_id` from the browser (a legitimate compare-and-swap against what the detail page rendered). Bulk operations originate from the *list* page, which never rendered per-row head SHAs to begin with — so the bulk merge execution route must derive "expected" values by fetching the PR row fresh from the DB itself, immediately before enqueueing, never from the request body.
- **Concurrency**: do not add a new in-process concurrency limiter (no `p-limit`/semaphore exists anywhere in this codebase — confirmed by investigation). Enqueueing a job (`INSERT INTO jobs`) is a fast DB write; looping over selected PR ids sequentially inside one HTTP request handler is sufficient and matches this codebase's existing pattern (`apps/web/src/server.ts:1462-1501`, the bulk-prompts endpoint, loops sequentially inside one `inTransaction`). Actual GitHub API calls happen later, inside the worker's existing single-claim-at-a-time loop (`apps/worker/src/worker.ts`) — that is already the system's concurrency bound; do not add another one.
- **Branch deletion must remain impossible.** There is no branch-delete function anywhere in `packages/github-provider` today — keep it that way. `closePullRequest` (Task 1) must only ever call the PR-state PATCH endpoint, never touch `/git/refs/...`.
- **Authorization**: this codebase has no per-project authorization today — any authenticated admin session can act on any PR (confirmed by investigation; `session.role` is loaded but never checked on PR routes). This plan does not add new authorization scoping (that would be a separate, larger change) — but it MUST still validate that every id in a bulk request actually exists in `pull_requests` and belongs to a real, currently-configured project, exactly like the existing bulk-prompts endpoint validates ids against `project_id` (`server.ts:1473`). Arbitrary/non-existent ids must be silently excluded from execution and reported as `skipped: not found`, never cause a 500 or attempt a GitHub call with garbage data.
- Run `pnpm run verify` (`tsc --noEmit && vitest run`) before every commit.
- Do not remove any existing single-PR action button, route, or behavior.

---

## File Structure

- **Modify:** `packages/github-provider/src/index.ts` — add `closePullRequest(owner, repository, number)`.
- **Modify:** `apps/worker/src/provider-jobs.ts` — add `"github.close_pull_request"` to `providerJobTypes`, add its handler.
- **Create:** `apps/worker/src/close-pull-request-job.test.ts` — unit test for the new job handler.
- **Modify:** `apps/web/src/server.ts` — extract `evaluateApproveEligibility()` and `startAiReview()` helpers from the inline `approve`/`ai-review` action bodies (Task 2, no behavior change); add `POST /api/admin/pull-requests/bulk` and `POST /api/admin/pull-requests/bulk/merge-preflight`; add an `id` (repeatable) query filter to the existing `GET /api/admin/pull-requests` JSON list route (Task 5's polling needs it).
- **Modify:** `apps/web/src/pages/prs.ts` — add a `classifyBulkMergeEligibility()` export (Task 3); add checkbox column + `<thead>` select-all to the list table; add the bulk-action toolbar markup (hidden until selection exists).
- **Modify:** `apps/web/src/ui.ts` — add selection/toolbar wiring, three bulk-action handlers (ai-review, close, merge), a merge pre-flight confirmation `<dialog>`, and a lightweight progress-polling loop, scoped to the `/admin/pull-requests` list route block.
- **Create:** `apps/web/src/pull-requests-bulk-route.test.ts` — unit tests for both new server routes.
- **Modify:** `apps/web/src/pages/prs-list-actions.test.ts` (or create `apps/web/src/pages/prs-bulk-toolbar.test.ts` if that file is scoped tightly to detail-page rendering — check first) — rendering tests for the new checkbox/toolbar markup.
- **Modify:** `tests/e2e/pr-actions.spec.ts` — add end-to-end bulk-action journeys using the existing `driveTicketToPrReady` helper.

---

### Task 1: `closePullRequest` capability — provider function + worker job

**Files:**
- Modify: `packages/github-provider/src/index.ts` (add function near `updatePullRequestBase`, line ~226)
- Modify: `apps/worker/src/provider-jobs.ts` (add to `providerJobTypes` array, line ~13-25; add handler near the `github.merge_pull_request` block, line ~129-156)
- Create: `apps/worker/src/close-pull-request-job.test.ts`

**Interfaces:**
```ts
// packages/github-provider/src/index.ts
export async function closePullRequest(owner: string, repository: string, number: number): Promise<ProviderPullRequest>;
```
New job type `"github.close_pull_request"`, payload `{ actor_id: string, pull_request_id: string }`.

- [ ] **Step 1: Add the provider function**

In `packages/github-provider/src/index.ts`, immediately after `updatePullRequestBase` (line ~231), add:

```ts
export async function closePullRequest(owner: string, repository: string, number: number) {
  return request<ProviderPullRequest>(`${pullsPath(owner, repository)}/${number}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed" }),
  });
}
```

This mirrors `updatePullRequestBase` exactly (same endpoint shape, same `request<ProviderPullRequest>` helper, same `PATCH`) — the only difference is the body. Confirm `ProviderPullRequest` is already exported/imported appropriately (it's already used by the neighboring function).

- [ ] **Step 2: Add the worker job type and handler**

In `apps/worker/src/provider-jobs.ts`:
1. Add `"github.close_pull_request"` to the `providerJobTypes` array (line ~17, next to `"github.merge_pull_request"`).
2. Add `closePullRequest` to the import from `@dcc/github-provider` (line ~7-9).
3. Add the handler, immediately after the `github.merge_pull_request` block ends (after line ~156, before `github.merge_branches` at line ~158):

```ts
if (job.type === "github.close_pull_request") {
  const pullRequestId = required(job.payload_json, "pull_request_id");
  await assertOwned();
  const pr = (await db.query(
    `SELECT pr.id,pr.number,pr.state,p.github_owner,p.github_repository
     FROM pull_requests pr JOIN projects p ON p.id=pr.project_id WHERE pr.id=$1`,
    [pullRequestId],
  )).rows[0];
  if (!pr) throw new Error("pull request not found");
  if (pr.state !== "open") {
    await persistJobResult(db, job.id, { outcome: "skipped", reason: `pull request state is ${pr.state}, not open` });
    return;
  }
  await assertOwned();
  await closePullRequest(pr.github_owner, pr.github_repository, pr.number);
  await db.query("UPDATE pull_requests SET state='closed',closed_at=now(),updated_at=now() WHERE id=$1", [pullRequestId]);
  await persistJobResult(db, job.id, { outcome: "closed" });
  await audit(db, job, actorId, "github.close_pull_request", "pull_request", pullRequestId, {});
  return;
}
```

This follows the exact same shape as the `github.merge_pull_request` handler immediately above it (`required()` for payload validation, `assertOwned()` lease checks before and after the mutating call, `persistJobResult`, local `audit()` helper) — read that block fresh (lines ~129-156) before writing this one to confirm the shape hasn't drifted.

- [ ] **Step 3: Write the job handler test**

Follow the pattern in the existing `apps/worker/src/provider-jobs.test.ts` (read it first — it already tests `github.merge_pull_request` with a fake `db`/GitHub provider; reuse its mocking setup). Cover:
- closes an open PR: `db.query` mocked to return `{ state: "open", ... }`, asserts `closePullRequest` (mocked) was called with the right owner/repo/number, asserts `UPDATE pull_requests SET state='closed'` was issued, asserts `audit` was called.
- skips a PR that is already closed/merged: `db.query` returns `{ state: "merged" }` (or `"closed"`), asserts `closePullRequest` was **not** called, asserts `persistJobResult` recorded `outcome: "skipped"`.
- pull request not found: `db.query` returns no rows, asserts the job throws.

Create as `apps/worker/src/close-pull-request-job.test.ts` (new file; do not append to `provider-jobs.test.ts` if that file already exceeds ~400 lines — check first and follow whichever keeps files under this repo's ~800 LOC hard limit).

- [ ] **Step 4: Run and commit**

Run: `npx vitest run apps/worker/src/close-pull-request-job.test.ts`
Expected: PASS.

```bash
git add packages/github-provider/src/index.ts apps/worker/src/provider-jobs.ts apps/worker/src/close-pull-request-job.test.ts
git commit -m "feat: add github.close_pull_request job and closePullRequest provider call"
```

---

### Task 2: Extract reusable `evaluateApproveEligibility()` and `startAiReview()` from the single-PR routes

**Files:**
- Modify: `apps/web/src/server.ts` (the `approve` branch at lines ~1011-1027 and the `ai-review` branch at lines ~1095-1148, inside `pullRequestActionMatch`'s handler)

**Interfaces:**
```ts
// New local functions in server.ts, near the other route-adjacent helpers (e.g. near `audit`, line ~251)
type ApproveEligibility =
  | { eligible: true; expectedHeadSha: string; policySnapshotId: string | undefined }
  | { eligible: false; reason: string };

async function evaluateApproveEligibility(
  pullRequest: any,
  provided: { expectedHeadSha?: string; policySnapshotId?: string } | undefined,
): Promise<ApproveEligibility>;
// provided === undefined means "derive both values from pullRequest itself" (the bulk path).
// provided !== undefined means "require them to match pullRequest" (the existing single-PR CAS path).

async function startAiReview(
  pullRequest: { id: string },
  options: { mode?: "review_only" | "review_and_merge"; model?: string; reasoningLevel?: string; targetBranch?: string },
  actorUserId: string,
): Promise<{ id: string; alreadyRunning: boolean }>;
```

- [ ] **Step 1: Re-read both current inline blocks fresh**

Re-read `apps/web/src/server.ts` lines ~1011-1027 (`approve`) and ~1095-1148 (`ai-review`) before touching anything — this is a refactor of live, working code; the regression tests in `approval-route-regressions.test.ts` must still pass byte-for-byte in behavior afterward.

- [ ] **Step 2: Extract `evaluateApproveEligibility`**

Add near the top-level helpers (e.g. after `audit`, line ~262):

```ts
type ApproveEligibility =
  | { eligible: true; expectedHeadSha: string; policySnapshotId: string | undefined }
  | { eligible: false; reason: string };

async function evaluateApproveEligibility(
  pullRequest: any,
  provided?: { expectedHeadSha?: string; policySnapshotId?: string },
): Promise<ApproveEligibility> {
  const { requireFreshPolicyBinding } = await getPullRequestMergeSettings(pool);
  // Bulk path: derive "expected" values from the freshly-fetched row itself — there is
  // no browser-rendered snapshot to compare-and-swap against for a list-page bulk action.
  const expectedHeadSha = provided?.expectedHeadSha ?? pullRequest.head_sha ?? "";
  const policySnapshotId = provided?.policySnapshotId ?? pullRequest.current_policy_snapshot_id ?? "";
  if (!expectedHeadSha || expectedHeadSha !== pullRequest.head_sha || (requireFreshPolicyBinding && (!policySnapshotId || pullRequest.policy_stale
    || policySnapshotId !== pullRequest.current_policy_snapshot_id))) {
    return { eligible: false, reason: "pull request policy binding is missing or stale" };
  }
  return { eligible: true, expectedHeadSha, policySnapshotId: requireFreshPolicyBinding ? policySnapshotId : undefined };
}
```

Then replace the `approve` branch body (lines ~1011-1027) with:

```ts
} else if (action === "approve") {
  const providedHeadSha = typeof body.expected_head_sha === "string" ? body.expected_head_sha.trim() : "";
  const providedSnapshotId = typeof body.policy_snapshot_id === "string" ? body.policy_snapshot_id.trim() : "";
  const eligibility = await evaluateApproveEligibility(pullRequest, { expectedHeadSha: providedHeadSha, policySnapshotId: providedSnapshotId });
  if (!eligibility.eligible) return json(response, 409, { error: eligibility.reason });
  const job = await enqueueJob({
    type: "github.merge_pull_request",
    payload: {
      actor_id: session.user_id, pull_request_id: pullRequest.id,
      expected_head_sha: eligibility.expectedHeadSha, ...(eligibility.policySnapshotId ? { policy_snapshot_id: eligibility.policySnapshotId } : {}),
    },
    idempotencyKey: `g07:github.merge_pull_request:${pullRequest.id}:${eligibility.expectedHeadSha}:${Math.floor(Date.now() / 3_600_000)}`,
  });
  return json(response, 202, { job });
```

Note the single-PR route still passes `{ expectedHeadSha: providedHeadSha, policySnapshotId: providedSnapshotId }` explicitly (both from the request body, exactly as before) — this preserves the exact existing CAS behavior (empty string from an absent body field still fails the `!expectedHeadSha` check exactly as today). Only the *bulk* caller (Task 5) will call `evaluateApproveEligibility(pullRequest)` with `provided` omitted.

- [ ] **Step 3: Extract `startAiReview`**

Add near `evaluateApproveEligibility`:

```ts
async function startAiReview(
  pullRequestId: string,
  options: { mode?: string; model?: string; reasoningLevel?: string; targetBranch?: string },
  actorUserId: string,
) {
  const mode = options.mode === "review_and_merge" ? "review_and_merge" : "review_only";
  const settings = (await pool.query("SELECT * FROM ai_review_settings WHERE id=1")).rows[0];
  const selection = validateAiSelection({
    model: options.model ?? settings.default_model,
    reasoning_level: options.reasoningLevel ?? settings.default_reasoning_level,
  });
  return inTransaction(async (client) => {
    await client.query("SELECT id FROM pull_requests WHERE id=$1 FOR UPDATE", [pullRequestId]);
    const previous = (await client.query(
      `SELECT r.id,j.id job_id,j.status job_status
       FROM pr_ai_reviews r
       LEFT JOIN LATERAL (
         SELECT id,status FROM jobs
         WHERE type='pr.ai_review' AND payload_json->>'pr_ai_review_id'=r.id::text
         ORDER BY created_at DESC LIMIT 1
       ) j ON true
       WHERE r.pull_request_id=$1
       ORDER BY CASE WHEN j.status IN ('queued','running') THEN 0 ELSE 1 END,r.created_at DESC LIMIT 1
       FOR UPDATE OF r`,
      [pullRequestId],
    )).rows[0];
    if (previous && ["queued", "running"].includes(previous.job_status)) return { id: previous.id, alreadyRunning: true };
    const row = (await client.query(
      `INSERT INTO pr_ai_reviews (pull_request_id, mode, status, model, reasoning_level, created_by)
       VALUES ($1,$2,'running',$3,$4,$5) RETURNING id`,
      [pullRequestId, mode, selection.model, selection.reasoning_level, actorUserId],
    )).rows[0];
    await enqueueJob({
      type: "pr.ai_review",
      payload: { pr_ai_review_id: row.id, pull_request_id: pullRequestId, mode, model: selection.model, reasoning_level: selection.reasoning_level, target_branch: options.targetBranch },
      idempotencyKey: `pr-ai-review:${row.id}`,
      maxAttempts: 3,
      rerunOf: previous?.job_id,
    }, client);
    return { id: row.id, alreadyRunning: false };
  });
}
```

Then replace the `ai-review` branch body (lines ~1095-1148) with:

```ts
} else if (action === "ai-review") {
  if (body.mode !== undefined && body.mode !== "review_only" && body.mode !== "review_and_merge") {
    return json(response, 400, { error: "mode must be review_only or review_and_merge" });
  }
  if (body.target_branch !== undefined && (typeof body.target_branch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(body.target_branch.trim()))) {
    return json(response, 400, { error: "invalid target_branch" });
  }
  const result = await startAiReview(pullRequest.id, {
    mode: body.mode,
    model: typeof body.model === "string" ? body.model : undefined,
    reasoningLevel: typeof body.reasoning_level === "string" ? body.reasoning_level : undefined,
    targetBranch: typeof body.target_branch === "string" && body.target_branch.trim() ? body.target_branch.trim() : undefined,
  }, session.user_id);
  return json(response, 200, { id: result.id });
```

- [ ] **Step 4: Run the EXISTING regression suite unmodified — this proves the extraction is behavior-preserving**

Run: `npx vitest run apps/web/src/approval-route-regressions.test.ts`
Expected: **every existing test still passes without modification.** This is the proof that the refactor didn't change behavior. If any test fails, the extraction introduced a behavior change — stop and find the discrepancy rather than editing the test to match the new code.

- [ ] **Step 5: Type-check and commit**

Run: `npx tsc --noEmit`

```bash
git add apps/web/src/server.ts
git commit -m "refactor: extract evaluateApproveEligibility and startAiReview for reuse by bulk actions"
```

---

### Task 3: Bulk merge-eligibility classifier

**Files:**
- Modify: `apps/web/src/pages/prs.ts` (add a new exported function; do not modify `renderDetail`'s existing `mergeBlocker`/`policyAllowsMerge` computation at lines ~44-72 — leave it exactly as-is)
- Create: `apps/web/src/pages/prs-bulk-eligibility.test.ts`

**Interfaces:**
```ts
export type BulkMergeClassification =
  | { eligible: true }
  | { eligible: false; reason: string };

export function classifyBulkMergeEligibility(
  row: {
    state: string; head_sha: string | null; current_policy_snapshot_id: string | null;
    policy_stale: boolean; policy_complete: boolean | null; review_state: string | null;
    check_state: string | null; is_draft: boolean | null; merge_conflicts: boolean | null;
  },
  requireFreshPolicyBinding: boolean,
): BulkMergeClassification;
```

- [ ] **Step 1: Check whether plan 01 has already merged**

```bash
git log --oneline -- packages/domain/src/pull-request-policy-status.ts
```
If this file exists on the current branch, plan 01 has landed — proceed with Step 2a. If it does not exist, proceed with Step 2b.

- [ ] **Step 2a: (plan 01 already merged) Implement using `derivePolicyStatus`**

```ts
import { derivePolicyStatus } from "@dcc/domain";

export type BulkMergeClassification = { eligible: true } | { eligible: false; reason: string };

export function classifyBulkMergeEligibility(row: {
  state: string; head_sha: string | null; current_policy_snapshot_id: string | null;
  policy_stale: boolean; policy_complete: boolean | null; review_state: string | null;
  check_state: string | null; is_draft: boolean | null; merge_conflicts: boolean | null; policy_error_code?: string | null; policy_retry_after?: string | Date | null;
}, requireFreshPolicyBinding: boolean): BulkMergeClassification {
  if (row.state !== "open") return { eligible: false, reason: `pull request is ${row.state}, not open` };
  if (row.is_draft) return { eligible: false, reason: "pull request is a draft" };
  if (row.merge_conflicts) return { eligible: false, reason: "pull request has merge conflicts" };
  const status = derivePolicyStatus({
    headSha: row.head_sha, currentPolicySnapshotId: row.current_policy_snapshot_id, policyStale: row.policy_stale,
    policyComplete: row.policy_complete, reviewState: row.review_state, checkState: row.check_state,
    policyErrorCode: row.policy_error_code ?? null, policyRetryAfter: row.policy_retry_after ?? null,
    enforcementMode: requireFreshPolicyBinding ? "required" : "auto",
  });
  return status.allowsMerge ? { eligible: true } : { eligible: false, reason: status.label };
}
```
Read `packages/domain/src/pull-request-policy-status.ts`'s actual final shape first (plan 01 may have refined the type/field names during its own execution) and adjust the call to match exactly — do not guess field names from this plan's draft if the real file differs.

- [ ] **Step 2b: (plan 01 not yet merged) Implement with the current inline logic's shape, clearly marked for later replacement**

```ts
export type BulkMergeClassification = { eligible: true } | { eligible: false; reason: string };

// TODO(plan 01 dependency): once packages/domain/src/pull-request-policy-status.ts
// (derivePolicyStatus) lands, replace this function's policy-check block with a call
// to it instead of re-deriving the same logic — see plans/09-pull-requests-bulk-actions.md
// Task 3 Global Constraints for why this duplication is temporary and intentional.
export function classifyBulkMergeEligibility(row: {
  state: string; head_sha: string | null; current_policy_snapshot_id: string | null;
  policy_stale: boolean; policy_complete: boolean | null; review_state: string | null;
  check_state: string | null; is_draft: boolean | null; merge_conflicts: boolean | null;
}, requireFreshPolicyBinding: boolean): BulkMergeClassification {
  if (row.state !== "open") return { eligible: false, reason: `pull request is ${row.state}, not open` };
  if (row.is_draft) return { eligible: false, reason: "pull request is a draft" };
  if (row.merge_conflicts) return { eligible: false, reason: "pull request has merge conflicts" };
  if (!row.head_sha) return { eligible: false, reason: "GitHub head SHA is unavailable" };
  if (requireFreshPolicyBinding && !row.current_policy_snapshot_id) return { eligible: false, reason: "GitHub policy snapshot is unavailable" };
  if (requireFreshPolicyBinding && row.policy_stale) return { eligible: false, reason: "GitHub policy is stale" };
  if (requireFreshPolicyBinding && !row.policy_complete) return { eligible: false, reason: "GitHub policy is incomplete" };
  if (requireFreshPolicyBinding && !["approved", "not_required"].includes(row.review_state ?? "")) return { eligible: false, reason: `GitHub reviews are ${row.review_state ?? "unknown"}` };
  if (requireFreshPolicyBinding && !["success", "not_required"].includes(row.check_state ?? "")) return { eligible: false, reason: `GitHub checks are ${row.check_state ?? "unknown"}` };
  return { eligible: true };
}
```
This is deliberately the same ternary chain as `renderDetail`'s existing `mergeBlocker` (lines ~59-71), copied rather than imported because it isn't exported yet — with `state`/`is_draft`/`merge_conflicts` checks added in front, matching item 2a's behavior exactly so switching between 2a/2b later is a pure implementation swap with no observable difference.

- [ ] **Step 3: Export it and write unit tests**

Add `export` to the function (whichever branch was implemented) in `apps/web/src/pages/prs.ts`. Create `apps/web/src/pages/prs-bulk-eligibility.test.ts`:

```ts
import { expect, test } from "vitest";
import { classifyBulkMergeEligibility } from "./prs.ts";

const base = {
  state: "open", head_sha: "abc123", current_policy_snapshot_id: "snap-1", policy_stale: false,
  policy_complete: true, review_state: "approved", check_state: "success", is_draft: false, merge_conflicts: false,
};

test("eligible when everything is clean", () => {
  expect(classifyBulkMergeEligibility(base, true)).toEqual({ eligible: true });
});
test("draft PRs are blocked regardless of policy state", () => {
  expect(classifyBulkMergeEligibility({ ...base, is_draft: true }, true)).toMatchObject({ eligible: false, reason: expect.stringMatching(/draft/i) });
});
test("PRs with merge conflicts are blocked", () => {
  expect(classifyBulkMergeEligibility({ ...base, merge_conflicts: true }, true)).toMatchObject({ eligible: false, reason: expect.stringMatching(/conflict/i) });
});
test("closed/merged PRs are blocked", () => {
  expect(classifyBulkMergeEligibility({ ...base, state: "merged" }, true)).toMatchObject({ eligible: false, reason: expect.stringMatching(/merged/i) });
});
test("changes requested blocks when enforcement is on", () => {
  expect(classifyBulkMergeEligibility({ ...base, review_state: "changes_requested" }, true)).toMatchObject({ eligible: false });
});
test("policy checks are skipped when enforcement is off", () => {
  expect(classifyBulkMergeEligibility({ ...base, current_policy_snapshot_id: null, requireFreshPolicyBinding: false } as any, false)).toEqual({ eligible: true });
});
```

- [ ] **Step 4: Run, typecheck, commit**

```bash
npx vitest run apps/web/src/pages/prs-bulk-eligibility.test.ts
npx tsc --noEmit
git add apps/web/src/pages/prs.ts apps/web/src/pages/prs-bulk-eligibility.test.ts
git commit -m "feat: add bulk merge-eligibility classifier for the PR list page"
```

---

### Task 4: Row selection UI and bulk-action toolbar (list page)

**Files:**
- Modify: `apps/web/src/pages/prs.ts` (list rendering, lines ~218-246)

**Interfaces:** none new — pure markup addition, following the exact existing bulk-selection pattern already in production at `apps/web/src/pages/projects.ts:139-150` (Project → Prompts tab).

- [ ] **Step 1: Re-read the current list-row and table-header markup fresh**

Re-read `apps/web/src/pages/prs.ts` lines ~218-246, and re-read `apps/web/src/pages/projects.ts:139-150` (the prompts bulk-toolbar markup) as the template to match — same visual language, same `data-*` attribute naming convention (just `pr` instead of `prompt`).

- [ ] **Step 2: Add the toolbar and checkbox column**

Add, immediately before the existing column header row (~line 244):
```html
<div data-pr-bulk-toolbar hidden style="display:flex;gap:8px;padding:12px 18px;align-items:center;border-bottom:1px solid var(--border)">
  <span>Selected: <strong data-pr-selected-count>0</strong></span>
  <span style="flex:1"></span>
  <button class="button" type="button" data-pr-bulk="ai-review">AI review</button>
  <button class="button" type="button" data-pr-bulk="close" style="border:1px solid var(--t-danger);color:var(--t-danger)">Close PR</button>
  <button class="button primary" type="button" data-pr-bulk="merge">Approve &amp; merge</button>
  <button class="button" type="button" data-pr-clear-selection>Clear</button>
</div>
```
Add a checkbox to the column header row: `<input type="checkbox" data-pr-check-all aria-label="Select all pull requests">` as the first column, and to each row template: `<input type="checkbox" data-pr-check="${item.id}" value="${item.id}" aria-label="Select PR #${item.number}">`, plus `data-pr-state="${item.state}"` and `data-pr-draft="${item.is_draft ? "1" : "0"}"` attributes on each row's checkbox (or on the row itself) so client JS can filter selection by tab/state without an extra fetch (per the "Filtering and tabs" requirement — `AI review`/`Close PR` only make sense for open PRs; merged/closed rows either don't render a checkbox at all, or render one that's `disabled` — prefer **not rendering a checkbox** for non-open-tab rows outright, since the source task's own examples only show bulk actions in the context of actionable open PRs; if the `All`/`Merged`/`Closed` tabs are visited, hide the entire toolbar+checkbox column for rows that are not `state==="open"` rather than showing a disabled checkbox no action will ever apply to).

Ensure the checkbox click doesn't also trigger the existing full-row click-through link (`.pr-row-link` per investigation item 1) — wrap the checkbox in its own cell/`stopPropagation` the same way `projects.ts`'s prompt rows already avoid this (check how that file's row-level click-through, if any, coexists with its checkboxes before assuming a pattern — `prs.ts` rows use a full-row overlay link (`pr-row-link`) that `projects.ts`'s prompt rows likely do NOT have, so this may need a `event.stopPropagation()` on the checkbox's own click handler that `projects.ts` doesn't need — read both files' actual click/link structure before writing the JS in Task 5, not just the markup here in Task 4).

- [ ] **Step 3: Rendering test**

Add to `apps/web/src/pages/prs-list-actions.test.ts` (or wherever list-page rendering is tested — check the file's actual scope first per this plan's File Structure note): assert the toolbar markup and per-row checkboxes are present with the right `data-pr-check`/`value` attributes for open-tab rows, and absent (or the whole toolbar/column omitted) for merged/closed-tab rows.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/prs.ts apps/web/src/pages/prs-list-actions.test.ts
git commit -m "feat: add row selection and bulk-action toolbar markup to the PR list page"
```

---

### Task 5: Server-side bulk routes

**Files:**
- Modify: `apps/web/src/server.ts` — add two routes; add `id` filter to the existing `GET /api/admin/pull-requests` list route (line ~709-720).
- Create: `apps/web/src/pull-requests-bulk-route.test.ts`

**Interfaces:**
```
POST /api/admin/pull-requests/bulk
  body: { action: "ai-review" | "close" | "merge", ids: string[] /* uuid */, batch_id?: string /* client-generated uuid for audit correlation */ }
  200: { batch_id: string, results: Array<{ id: string, outcome: "queued" | "skipped" | "not_found", reason?: string, job_id?: string }> }

POST /api/admin/pull-requests/bulk/merge-preflight
  body: { ids: string[] }
  200: { results: Array<{ id: string, number: number, title: string, eligible: boolean, reason?: string }> }

GET /api/admin/pull-requests?id=<uuid>&id=<uuid>...   (repeatable "id" param, in addition to all existing filters)
```

- [ ] **Step 1: Add the `id` filter to the existing list route**

In `server.ts`, inside the `GET /api/admin/pull-requests` handler (~line 709-742), add alongside the other filters:
```ts
const ids = url.searchParams.getAll("id").filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
if (ids.length) { params.push(ids); where.push(`pr.id = ANY($${params.length}::uuid[])`); }
```
This is purely additive — omitted for every existing caller, so no existing behavior changes. It exists so the bulk toolbar (Task 6-8) can poll just the selected rows' current state without over-fetching the whole list.

- [ ] **Step 2: Add `POST /api/admin/pull-requests/bulk/merge-preflight`**

Add near the `pullRequestActionMatch` block (e.g. immediately before it, since both concern `/api/admin/pull-requests/...`):

```ts
if (url.pathname === "/api/admin/pull-requests/bulk/merge-preflight" && request.method === "POST") {
  const body = await bodyOf(request);
  const ids = Array.isArray(body.ids) && body.ids.every((id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) ? body.ids : [];
  if (!ids.length) return json(response, 400, { error: "no pull requests selected" });
  const { requireFreshPolicyBinding } = await getPullRequestMergeSettings(pool);
  const rows = (await pool.query("SELECT * FROM pull_requests WHERE id = ANY($1::uuid[])", [ids])).rows;
  const byId = new Map(rows.map((row: any) => [row.id, row]));
  const results = ids.map((id: string) => {
    const row = byId.get(id);
    if (!row) return { id, number: null, title: null, eligible: false, reason: "pull request not found" };
    const classification = classifyBulkMergeEligibility(row, requireFreshPolicyBinding);
    return { id, number: row.number, title: row.title, eligible: classification.eligible, ...(classification.eligible ? {} : { reason: classification.reason }) };
  });
  return json(response, 200, { results });
}
```
Import `classifyBulkMergeEligibility` from `./pages/prs.ts` at the top of `server.ts` (check the existing import style for cross-imports from `./pages/*` — `server.ts` likely already imports render functions from `./pages/prs.ts` for the HTML routes; add to that same import statement rather than a new one).

- [ ] **Step 3: Add `POST /api/admin/pull-requests/bulk`**

```ts
if (url.pathname === "/api/admin/pull-requests/bulk" && request.method === "POST") {
  const body = await bodyOf(request);
  const action = body.action;
  if (!["ai-review", "close", "merge"].includes(action)) return json(response, 400, { error: "invalid action" });
  const ids = Array.isArray(body.ids) && body.ids.every((id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) ? body.ids : [];
  if (!ids.length) return json(response, 400, { error: "no pull requests selected" });
  if (ids.length > 100) return json(response, 400, { error: "select at most 100 pull requests at once" });
  const batchId = typeof body.batch_id === "string" && body.batch_id.trim() ? body.batch_id.trim() : randomUUID();
  const rows = (await pool.query(
    `SELECT pr.*,p.github_owner,p.github_repository FROM pull_requests pr JOIN projects p ON p.id=pr.project_id WHERE pr.id = ANY($1::uuid[])`,
    [ids],
  )).rows;
  const byId = new Map(rows.map((row: any) => [row.id, row]));
  const results: Array<{ id: string; outcome: string; reason?: string; job_id?: string }> = [];
  const { requireFreshPolicyBinding } = action === "merge" ? await getPullRequestMergeSettings(pool) : { requireFreshPolicyBinding: false };
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) { results.push({ id, outcome: "not_found" }); continue; }
    try {
      if (action === "ai-review") {
        if (row.state !== "open") { results.push({ id, outcome: "skipped", reason: `pull request is ${row.state}, not open` }); continue; }
        const started = await startAiReview(row.id, {}, session.user_id);
        results.push({ id, outcome: started.alreadyRunning ? "skipped" : "queued", ...(started.alreadyRunning ? { reason: "AI review already running" } : {}) });
        await audit({ actorType: "admin", actorId: session.user_id, action: "ai_review.bulk_start", entityType: "pull_request", entityId: id, metadata: { batch_id: batchId }, ip: ipOf(request) });
      } else if (action === "close") {
        if (row.state !== "open") { results.push({ id, outcome: "skipped", reason: `pull request is ${row.state}, not open` }); continue; }
        const job = await enqueueJob({ type: "github.close_pull_request", payload: { actor_id: session.user_id, pull_request_id: row.id }, idempotencyKey: `bulk-close:${row.id}:${batchId}` });
        results.push({ id, outcome: "queued", job_id: job.id });
        await audit({ actorType: "admin", actorId: session.user_id, action: "pull_request.bulk_close", entityType: "pull_request", entityId: id, metadata: { batch_id: batchId }, ip: ipOf(request) });
      } else {
        const classification = classifyBulkMergeEligibility(row, requireFreshPolicyBinding);
        if (!classification.eligible) { results.push({ id, outcome: "skipped", reason: classification.reason }); continue; }
        const eligibility = await evaluateApproveEligibility(row);
        if (!eligibility.eligible) { results.push({ id, outcome: "skipped", reason: eligibility.reason }); continue; }
        const job = await enqueueJob({
          type: "github.merge_pull_request",
          payload: { actor_id: session.user_id, pull_request_id: row.id, expected_head_sha: eligibility.expectedHeadSha, ...(eligibility.policySnapshotId ? { policy_snapshot_id: eligibility.policySnapshotId } : {}) },
          idempotencyKey: `g07:github.merge_pull_request:${row.id}:${eligibility.expectedHeadSha}:${Math.floor(Date.now() / 3_600_000)}`,
        });
        results.push({ id, outcome: "queued", job_id: job.id });
        await audit({ actorType: "admin", actorId: session.user_id, action: "pull_request.bulk_merge", entityType: "pull_request", entityId: id, metadata: { batch_id: batchId }, ip: ipOf(request) });
      }
    } catch (error) {
      results.push({ id, outcome: "skipped", reason: "an unexpected error occurred — see server logs" });
      console.error(`bulk ${action} failed for pull request ${id}`, error);
    }
  }
  return json(response, 200, { batch_id: batchId, results });
}
```

Note the per-id `try/catch` inside the loop — this is what satisfies "a failure on one PR must not stop the remaining selected PRs" for all three actions in one shared loop, and "GitHub rate/API failures are surfaced per PR" (the loop continues to the next id, and this id's `results` entry carries the failure).

- [ ] **Step 4: Write route tests**

Follow the exact pattern in `apps/web/src/approval-route-regressions.test.ts` (mock `@dcc/database`, call `adminApi` directly). Cover, at minimum, one test per requirement:
- `merge-preflight` classifies a mix of ready/blocked PRs correctly and includes a reason for each blocked one.
- `merge-preflight` rejects a non-array/empty `ids`.
- bulk `ai-review` queues eligible open PRs and skips a PR with an already-running review (mock `pr_ai_reviews`/`jobs` lookups the same way the existing single-PR ai-review test does).
- bulk `ai-review` continues processing the rest of the batch after one PR's lookup throws (mock `pool.query` to throw only for one specific id).
- bulk `close` skips a non-open PR and queues an open one; asserts `INSERT INTO jobs` payload has `type: "github.close_pull_request"`.
- bulk `merge` re-evaluates eligibility server-side even when the (hypothetical) client passed something else — since this route doesn't accept `expected_head_sha` from the client at all, prove eligibility is derived purely from the freshly-queried row by asserting the enqueued job's `expected_head_sha` matches `row.head_sha`, not anything from the request body.
- bulk `merge` skips a draft/conflicted PR with the correct reason string, and does not enqueue a job for it.
- an id that doesn't exist in `pull_requests` is reported `not_found`, not a 500.
- more than 100 ids is rejected with 400 before any query runs.
- every successful action writes an `audit_events` row tagged with the same `batch_id`.

- [ ] **Step 5: Run, typecheck, commit**

```bash
npx vitest run apps/web/src/pull-requests-bulk-route.test.ts apps/web/src/approval-route-regressions.test.ts
npx tsc --noEmit
git add apps/web/src/server.ts apps/web/src/pull-requests-bulk-route.test.ts
git commit -m "feat: add bulk PR action routes (ai-review, close, merge) and merge pre-flight endpoint"
```

---

### Task 6: Wire the bulk toolbar's selection state and "AI review" action

**Files:**
- Modify: `apps/web/src/ui.ts` (add a new block scoped to `path==="/admin/pull-requests"`, the list page — distinct from the existing detail-page block scoped to `/^\/admin\/pull-requests\/[^/]+(\/\d+)?$/`)

- [ ] **Step 1: Read the existing bulk-selection JS template in full**

Re-read `apps/web/src/ui.ts:387-403` (the prompts bulk-toolbar wiring) — this plan's selection/count/clear logic must match it almost verbatim, just renamed `pr` instead of `prompt` and scoped to the PR list page's own `if(path===...)` block rather than the projects detail page's.

- [ ] **Step 2: Add selection state + AI review wiring**

```js
${path==="/admin/pull-requests"?`
  const csrf=sessionStorage.getItem("dccCsrf")||"";
  const prChecks=()=>[...document.querySelectorAll("[data-pr-check]")];
  const prToolbar=document.querySelector("[data-pr-bulk-toolbar]"),prSelectedCount=document.querySelector("[data-pr-selected-count]");
  const updatePrSelection=()=>{
    const selected=prChecks().filter(c=>c.checked);
    if(prSelectedCount)prSelectedCount.textContent=String(selected.length);
    if(prToolbar)prToolbar.hidden=selected.length===0;
  };
  prChecks().forEach(checkbox=>{
    checkbox.addEventListener("click",event=>event.stopPropagation());
    checkbox.addEventListener("change",updatePrSelection);
  });
  document.querySelector("[data-pr-check-all]")?.addEventListener("change",event=>{
    prChecks().forEach(checkbox=>{checkbox.checked=event.target.checked});
    updatePrSelection();
  });
  document.querySelector("[data-pr-clear-selection]")?.addEventListener("click",()=>{
    prChecks().forEach(checkbox=>{checkbox.checked=false});
    const checkAll=document.querySelector("[data-pr-check-all]");if(checkAll)checkAll.checked=false;
    updatePrSelection();
  });
  const selectedPrIds=()=>prChecks().filter(c=>c.checked).map(c=>c.value);

  document.querySelector('[data-pr-bulk="ai-review"]')?.addEventListener("click",async(event)=>{
    const ids=selectedPrIds();if(!ids.length)return;
    const button=event.currentTarget;button.disabled=true;
    try{
      const response=await fetch("/api/admin/pull-requests/bulk",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({action:"ai-review",ids})});
      const result=await response.json();
      if(response.ok){
        const queued=result.results.filter(r=>r.outcome==="queued").length,skipped=result.results.length-queued;
        alert(\`AI review started for \${queued} pull request\${queued===1?"":"s"}\${skipped?\`, \${skipped} skipped\`:""}.\`);
        location.reload();
      }else alert(result.error);
    }finally{button.disabled=false}
  });
`:""}
```

Note `prToolbar.hidden` handles the "toolbar appears only when selection exists" requirement, and `checkbox.addEventListener("click",event=>event.stopPropagation())` prevents the checkbox from also triggering the full-row `.pr-row-link` click-through discovered during Task 4's investigation — confirm this is actually the right event/element to stop propagation on by testing it manually or in Task 9's e2e test (a `<label>`-wrapped checkbox vs. a bare `<input>` inside an `<a>` may need `preventDefault()` instead of/in addition to `stopPropagation()` — check the actual row markup from Task 2 before assuming this exact call is sufficient).

- [ ] **Step 3: Manual/automated check, typecheck, commit**

Run: `npx tsc --noEmit` (guards the surrounding TS file; the injected JS itself isn't type-checked).

```bash
git add apps/web/src/ui.ts
git commit -m "feat: wire PR list row selection and bulk AI review action"
```

---

### Task 7: Wire "Close PR" with confirmation and result summary

**Files:**
- Modify: `apps/web/src/ui.ts` (same block as Task 6)

- [ ] **Step 1: Add the close handler**

```js
document.querySelector('[data-pr-bulk="close"]')?.addEventListener("click",async(event)=>{
  const ids=selectedPrIds();if(!ids.length)return;
  if(!confirm(\`Close \${ids.length} pull request\${ids.length===1?"":"s"}?\n\nThis will close the selected PRs on GitHub.\nNo branches or commits will be deleted.\`))return;
  const button=event.currentTarget;button.disabled=true;
  try{
    const response=await fetch("/api/admin/pull-requests/bulk",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({action:"close",ids})});
    const result=await response.json();
    if(response.ok){
      const queued=result.results.filter(r=>r.outcome==="queued").length,skipped=result.results.filter(r=>r.outcome!=="queued");
      alert(\`Closing \${queued} pull request\${queued===1?"":"s"}.\${skipped.length?\` \${skipped.length} skipped: \${skipped.map(r=>r.reason).join("; ")}\`:""}\`);
      location.reload();
    }else alert(result.error);
  }finally{button.disabled=false}
});
```

This matches the confirmation-dialog convention already used throughout this codebase (plain `confirm()`, not a custom `<dialog>` — see Global Constraints reference to the existing pattern list). The result is asynchronous (the actual GitHub close happens in the worker job from Task 1) — the alert reports how many were *queued*, not yet confirmed closed; the page reload afterward will reflect `state='closed'` only once the worker has actually processed the job. This is consistent with how the existing single-PR `sync`/`refresh` actions already behave (fire-and-reload, not wait-for-completion) — do not add new polling machinery for this action specifically; Task 8's merge polling is justified separately because the source task's own mockup explicitly shows a live "2/5 complete" progress state for merge, not for close.

- [ ] **Step 2: Typecheck and commit**

```bash
npx tsc --noEmit
git add apps/web/src/ui.ts
git commit -m "feat: wire bulk Close PR action with confirmation and result summary"
```

---

### Task 8: Wire "Approve & merge" with pre-flight confirmation modal and progress

**Files:**
- Modify: `apps/web/src/pages/prs.ts` (add the pre-flight `<dialog>` markup, once, at the bottom of the list page's rendered HTML — follow the existing `<dialog>` pattern already used elsewhere in this app, e.g. the preview dialog referenced in `ui.ts:157-169`)
- Modify: `apps/web/src/ui.ts` (same block as Tasks 6-7)

**Interfaces:** none new beyond the routes already added in Task 5.

- [ ] **Step 1: Add the dialog markup**

In `prs.ts`, in the list-page render function, add (structure matching the existing `[data-preview-dialog]` pattern in this codebase — read `ui.ts:157-169` and find that dialog's own markup in whichever `pages/*.ts` file renders it, to match its exact `<dialog>`/focus-trap/close-button shape):

```html
<dialog data-pr-merge-preflight-dialog>
  <h3>Approve &amp; merge selected PRs</h3>
  <div data-pr-preflight-summary></div>
  <ul data-pr-preflight-list style="list-style:none;padding:0"></ul>
  <div style="display:flex;gap:8px;margin-top:12px">
    <button class="button" type="button" data-close-dialog>Cancel</button>
    <button class="button primary" type="button" data-pr-preflight-confirm>Merge</button>
  </div>
</dialog>
```

- [ ] **Step 2: Wire pre-flight fetch, render, and confirm**

```js
const preflightDialog=document.querySelector("[data-pr-merge-preflight-dialog]");
let preflightReadyIds=[];
document.querySelector('[data-pr-bulk="merge"]')?.addEventListener("click",async(event)=>{
  const ids=selectedPrIds();if(!ids.length)return;
  const button=event.currentTarget;button.disabled=true;
  try{
    const response=await fetch("/api/admin/pull-requests/bulk/merge-preflight",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({ids})});
    const result=await response.json();
    if(!response.ok){alert(result.error);return}
    const ready=result.results.filter(r=>r.eligible),blocked=result.results.filter(r=>!r.eligible);
    preflightReadyIds=ready.map(r=>r.id);
    preflightDialog.querySelector("[data-pr-preflight-summary]").textContent=\`\${ready.length} ready, \${blocked.length} blocked\`;
    preflightDialog.querySelector("[data-pr-preflight-list]").replaceChildren(
      ...result.results.map(r=>{
        const li=document.createElement("li");
        li.textContent=(r.eligible?"✓ ":"✕ ")+"#"+(r.number??"?")+" "+(r.title??"")+(r.eligible?"":" — "+r.reason);
        return li;
      }),
    );
    const confirmButton=preflightDialog.querySelector("[data-pr-preflight-confirm]");
    confirmButton.textContent=\`Merge \${ready.length} PR\${ready.length===1?"":"s"}\`;
    confirmButton.disabled=ready.length===0;
    preflightDialog.showModal();
  }finally{button.disabled=false}
});
preflightDialog?.querySelector("[data-pr-preflight-confirm]")?.addEventListener("click",async()=>{
  if(!preflightReadyIds.length)return;
  const button=preflightDialog.querySelector("[data-pr-preflight-confirm]");button.disabled=true;
  try{
    const response=await fetch("/api/admin/pull-requests/bulk",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({action:"merge",ids:preflightReadyIds})});
    const result=await response.json();
    preflightDialog.close();
    if(response.ok){
      const queued=result.results.filter(r=>r.outcome==="queued").length,skipped=result.results.filter(r=>r.outcome!=="queued");
      alert(\`Merging \${queued} pull request\${queued===1?"":"s"}.\${skipped.length?\` \${skipped.length} could not be merged: \${skipped.map(r=>r.reason).join("; ")}\`:""}\`);
      location.reload();
    }else alert(result.error);
  }finally{button.disabled=false}
});
preflightDialog?.querySelector("[data-close-dialog]")?.addEventListener("click",()=>preflightDialog.close());
```

Note that `preflightReadyIds` is submitted to `/bulk`, not the full original selection — matching this plan's design decision (Architecture section) that only PRs classified ready *at pre-flight time* are sent for execution, and the execution route re-verifies each one fresh again regardless (Task 5, `evaluateApproveEligibility` + `classifyBulkMergeEligibility` both re-run server-side inside the `/bulk` handler using freshly-queried rows) — so a PR that flips to blocked between pre-flight and confirm click is still safely skipped, not silently merged, and shows up in the final `skipped` summary.

- [ ] **Step 3: Typecheck and commit**

```bash
npx tsc --noEmit
git add apps/web/src/pages/prs.ts apps/web/src/ui.ts
git commit -m "feat: wire bulk Approve & merge pre-flight confirmation and execution"
```

---

### Task 9: End-to-end tests

**Files:**
- Modify: `tests/e2e/pr-actions.spec.ts`

**Interfaces:**
- Consumes: `driveTicketToPrReady`, `loginViaUI`, `queryOne`, `waitFor`, `waitForTicketStatus` from `./helpers` (already imported in this file).

- [ ] **Step 1: Read `driveTicketToPrReady`'s implementation in `./helpers.ts` in full**

Confirm exactly what state it leaves a PR in (open, policy-synced or not) and whether it's safe/fast enough to call 2-3 times in one test to produce multiple real PRs for a bulk-selection test — check for any shared-state/uniqueness requirements (e.g. unique ticket titles, as already done via `` `E2E ... ${Date.now()}` `` in every existing test in this file).

- [ ] **Step 2: Write the bulk-selection and bulk-action tests**

```ts
test("select multiple PRs and run a bulk AI review", async ({ page }) => {
  const a = await driveTicketToPrReady(page, `E2E bulk-ai-1 ${Date.now()}`);
  const b = await driveTicketToPrReady(page, `E2E bulk-ai-2 ${Date.now()}`);
  await page.goto("/admin/pull-requests");
  await page.locator(`[data-pr-check="${a.prId}"]`).check();
  await page.locator(`[data-pr-check="${b.prId}"]`).check();
  await expect(page.locator("[data-pr-selected-count]")).toHaveText("2");
  await page.locator('[data-pr-bulk="ai-review"]').click();

  for (const prId of [a.prId, b.prId]) {
    await waitFor(async () => {
      const review = await queryOne("select status from pr_ai_reviews where pull_request_id = $1 order by created_at desc limit 1", [prId]);
      return !!review && !["queued", "running"].includes(review.status);
    }, { timeoutMs: 60_000, intervalMs: 500 });
  }
});

test("bulk AI review does not duplicate an already-running review", async ({ page }) => {
  const a = await driveTicketToPrReady(page, `E2E bulk-ai-dup ${Date.now()}`);
  await page.goto(`/admin/pull-requests`);
  // Start one review directly first via the detail page, then attempt a bulk review on the same PR while it's still running.
  await page.locator(".prs-row", { hasText: a.ticketNumber }).first().click();
  await page.locator("[data-pr-ai-review]").click();
  await page.goto("/admin/pull-requests");
  await page.locator(`[data-pr-check="${a.prId}"]`).check();
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator('[data-pr-bulk="ai-review"]').click();
  const reviews = await queryOne("select count(*)::int as count from pr_ai_reviews where pull_request_id = $1", [a.prId]);
  expect(reviews.count).toBe(1); // no duplicate row created
});

test("bulk close requires confirmation and closes selected PRs without deleting branches", async ({ page }) => {
  const a = await driveTicketToPrReady(page, `E2E bulk-close ${Date.now()}`);
  await page.goto("/admin/pull-requests");
  await page.locator(`[data-pr-check="${a.prId}"]`).check();
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator('[data-pr-bulk="close"]').click();
  await waitFor(async () => {
    const pr = await queryOne("select state from pull_requests where id = $1", [a.prId]);
    return pr?.state === "closed";
  }, { timeoutMs: 30_000, intervalMs: 500 });
});

test("bulk merge pre-flight classifies ready vs blocked PRs and only merges the ready ones", async ({ page }) => {
  const ready = await driveTicketToPrReady(page, `E2E bulk-merge-ready ${Date.now()}`);
  await waitFor(async () => {
    const row = await queryOne("select current_policy_snapshot_id, policy_stale from pull_requests where id = $1", [ready.prId]);
    return !!row?.current_policy_snapshot_id && row.policy_stale === false;
  }, { timeoutMs: 30_000, intervalMs: 300 });

  await page.goto("/admin/pull-requests");
  await page.locator(`[data-pr-check="${ready.prId}"]`).check();
  await page.locator('[data-pr-bulk="merge"]').click();

  const dialog = page.locator("[data-pr-merge-preflight-dialog]");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-pr-preflight-summary]")).toHaveText(/1 ready, 0 blocked/);
  await dialog.locator("[data-pr-preflight-confirm]").click();

  await waitForTicketStatus(ready.ticketId, ["Merged", "Completed"], 60_000);
  const pr = await queryOne("select merged_at from pull_requests where id = $1", [ready.prId]);
  expect(pr.merged_at).not.toBeNull();
});
```

Adjust field names (`prId`/`ticketId`/`ticketNumber`) to whatever `driveTicketToPrReady`'s actual return shape is (confirmed in Step 1) — the existing tests in this same file (`pr-actions.spec.ts:54-55`) already destructure `{ ticketNumber, ticketId, prId }` from it, so this should match directly, but verify rather than assume.

- [ ] **Step 3: Run the tests**

Run: `npx playwright test tests/e2e/pr-actions.spec.ts`
Expected: all pass, including pre-existing tests in this file (unmodified by this plan) and the new bulk ones. If Playwright/browsers aren't provisioned in this execution environment, note that explicitly in the execution report.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/pr-actions.spec.ts
git commit -m "test: e2e coverage for bulk AI review, bulk close, and bulk approve & merge"
```

---

## Self-Review Notes

- **Spec coverage**: row selection/select-all/count/clear (Task 4+6), bulk toolbar visibility (Task 4+6), bulk AI review with dedup and per-PR independence (Task 2+5+6+9), bulk close with confirmation and no branch deletion (Task 1+5+7+9), bulk merge with pre-flight classification, explicit ready/blocked display, and server-side re-verification (Task 2+3+5+8+9), batch result summaries for every action (Task 5's `results` array, surfaced by Tasks 6-8's `alert`), authorization/id-boundary validation (Task 5), audit logging with a shared `batch_id` (Task 5), bounded "concurrency" via sequential enqueue rather than an unbounded fan-out (Task 5, Global Constraints), tests for every listed scenario (Tasks 1, 3, 5, 9). The one item given a deliberately reduced implementation is live "N / M complete" progress during execution (the source task's own example) — Task 7/8 use an immediate post-submit summary plus a page reload rather than a live-updating counter, because building genuine live progress would require either polling infrastructure this codebase doesn't have anywhere yet or a new WebSocket/SSE channel (over-engineering relative to how every other async action in this app already works — fire, get an immediate queued-count summary, reload). Flag this simplification explicitly to the user in the execution report as a deliberate scope reduction, not an oversight.
- **Cross-plan dependency**: Task 3 has an explicit, documented conditional path depending on whether plan 01 has merged (see Global Constraints and Task 3 Step 1). This is the only real dependency between this plan and any other; report it prominently to the orchestrator/user.
- **Placeholder scan**: the one intentional `// TODO` (Task 3, Step 2b) is explicitly justified and self-documenting, not a lazy stub — it names the exact file/condition that removes it.
- **Type consistency**: `BulkMergeClassification`, the `/bulk` and `/bulk/merge-preflight` response shapes, and the extracted `evaluateApproveEligibility`/`startAiReview` signatures are each defined once and reused by every consumer (single-PR route, bulk route, tests) — no duplicate/divergent type definitions introduced.

## Execution Handoff

Plan complete and saved to `plans/09-pull-requests-bulk-actions.md`. Recommended: **Subagent-Driven Development** (superpowers:subagent-driven-development) — nine tasks with real sequencing (Task 2's extraction must land and pass regression tests before Tasks 5+ can call the extracted functions; Task 1 must land before Task 5/7 can reference the new job type), each substantial enough to warrant its own review checkpoint before the next begins.
