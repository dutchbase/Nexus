# VA Jobs Platform Production Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task — this plan touches shared provider/domain code, a DB migration, three worker job handlers, one new route, and a UI restructure; each task needs its own review gate. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Production` tab to the existing `/admin/merge` page, with a `VA Jobs Platform` project sub-tab, that promotes `dutchbase/va-jobs-platform` to production by moving `refs/heads/production` directly to the current `master` SHA (never a merge commit), gated on GitHub Actions workflow-run + job-level pre-flight checks (`docker-image`), with stale-master protection, non-fast-forward/diverged-production recovery requiring explicit confirmation, post-promotion ref verification, and live tracking of the resulting production-branch deployment workflow's `migrations-production`/`deploy-production` jobs.

**Architecture:** PR #49 (commit `290f7b6`, already merged into `master`) shipped a generic production-deployment system: `deployment_status_snapshots` / `production_releases` tables (migration `056_deployment_management.sql`), `deployment.sync_status` / `deployment.promote_check` / `deployment.promote` / `deployment.rollback` worker jobs (`apps/worker/src/provider-jobs.ts:254-469`), a ref-move promotion primitive (`updateBranchReference`, `packages/github-provider/src/index.ts:419-428`, already exactly `PATCH .../git/refs/heads/{branch}` with `{sha,force}` — no merge commit), a single-flight DB index (`production_releases_project_inflight_idx`), CAS staleness checks (`master_moved`/`commit_not_master`), audit logging, and CSRF-gated admin routes (`apps/web/src/server.ts:1242-1300`). This is the **same ref-pointer promotion mechanism the new task requires** — rebuilding it as a second, parallel table/job-type pair would mean two independent systems able to move `refs/heads/production` on the same repo, each with its own single-flight guard, which is a real safety regression. **This plan extends the existing system rather than duplicating it.**

What's genuinely missing (confirmed by direct code reading, not assumed): the existing system judges pre-flight readiness from `getCommitCheckStatus` (aggregates every check-run on a SHA regardless of which workflow run produced it — `packages/github-provider/src/index.ts:308-334`) and judges post-promotion success from polling the deployed app's own `/health` + `/version` endpoints (`packages/domain/src/deployment.ts:14-27`). Neither of those can find *the* GitHub Actions workflow run for a specific branch+event+SHA, assert a named job (`docker-image`) concluded `success`, or track named jobs (`migrations-production`, `deploy-production`) on a *different* workflow run pushed to the `production` branch. Nothing in the codebase calls `GET /actions/runs/{id}/jobs` today. This plan adds that capability as a second, opt-in **mechanism** (`DeploymentConfig.mechanism: "github_actions_jobs"`), selected per-project, leaving the existing `"health_check"` mechanism's behavior for any other project untouched. It also fixes three real defects in the shared, reused code: (1) `checkImageExists` is currently mandatory and a GHCR transient error hard-blocks promotion — the new task wants GHCR as an optional/advisory layer; (2) a 422 non-fast-forward ref-update failure is currently indistinguishable from any other failure and auto-retries up to 3× (`packages/domain/src/index.ts:206`) instead of requiring explicit human confirmation; (3) nothing re-reads the ref after the PATCH to confirm it actually moved. Fixes (1) and (3) are applied as new, additive functions so the existing `"health_check"` mechanism's behavior is unchanged; fix (2) is applied by having the new route pass `maxAttempts:1`, which only affects jobs enqueued through that route.

**Tech Stack:** TypeScript, node-postgres (`pg`), the existing job-queue worker (`apps/worker`), plain server-rendered HTML template strings (no React — `apps/web/src/pages/*.ts`), Vitest, the existing GitHub REST API client (`packages/github-provider/src/index.ts`: `responseFor`/`request`/`jsonFor`/`GitHubProviderError`/`apiBaseUrl`).

**Spec:** Task "Add Production deployment tab to Merge page with `va-jobs-platform` promotion workflow" (full text in `plans/INDEX.md`).

## Global Constraints

- Never use GitHub's merge API (`POST /repos/{owner}/{repo}/merges`, `mergeBranch()` in `packages/github-provider/src/index.ts:444`) or create any commit for promotion. Promotion is exclusively `updateBranchReference()` (`packages/github-provider/src/index.ts:419-428`), which already sends `PATCH /repos/{owner}/{repo}/git/refs/heads/{branch}` with `{sha, force}`.
- Normal promotion always uses `force:false`; `force:true` is only ever used after explicit, stronger-than-normal human confirmation via the new `promote-force` route, and only ever targets a freshly re-verified `master` SHA.
- The client never supplies the deployment SHA as the source of truth — the server always re-resolves `master` itself, both at pre-flight time and immediately before the ref write (already true of `deployment.promote`; unchanged by this plan).
- Repository/branch/job names for this feature are server-side allowlisted (`packages/domain/src/production-promotion-allowlist.ts`, new in Task 6) — only `dutchbase/va-jobs-platform`, source `master`, target `production` are permitted through the new Production-tab routes in this plan, independent of whatever `github_owner`/`github_repository`/`production_branch` an admin could otherwise edit via `PATCH /api/admin/projects/:id`.
- All GitHub-mutating calls happen server-side only (worker job), never from the browser; the browser never sees a GitHub write token (already true; unchanged).
- Never report promotion as successful until the production ref has been read back and confirmed to equal the target SHA (new — Task 9).
- Never conflate the master-push workflow run with the production-push workflow run at the same SHA — always filter by `head_branch` AND `event=push`, and additionally treat a run older than the promotion attempt as untrustworthy (Task 2).
- Do not modify the existing `Merge branches` tab's behavior — it must render and behave identically before and after this plan (regression test required, Task 10).
- Do not modify `deployment.sync_status` / `deployment.promote_check` / `deployment.promote` / `deployment.rollback`'s existing behavior for a project using the default `"health_check"` mechanism — every new branch in these handlers is `if (deployment.mechanism === "github_actions_jobs")`, with the untouched original code as the `else`/fallthrough path.
- Run `pnpm verify` (`tsc --noEmit && vitest run` — confirm exact script name in root `package.json` before running) before each commit.

---

## File Structure

- **Create:** `packages/database/migrations/058_production_promotion_actions_tracking.sql` — additive nullable columns on `deployment_status_snapshots` and `production_releases`.
- **Create:** `packages/github-provider/src/actions.ts` — `findWorkflowRun()`, `getWorkflowRunJobs()`, `compareCommits()`.
- **Create:** `packages/github-provider/src/actions.test.ts` — unit tests (mocked `fetch`).
- **Modify:** `packages/github-provider/src/registry.ts` — add `checkImageExistsDetailed()` alongside the existing `checkImageExists()` (unchanged), returning a three-state result.
- **Modify:** `packages/github-provider/src/registry.test.ts` — tests for the new function.
- **Modify:** `packages/github-provider/src/index.ts` — classify the 422 response body in `updateBranchReference()` (additive: existing thrown-error contract unchanged, just carries more detail).
- **Modify:** `packages/github-provider/src/index.test.ts` — tests for the classification.
- **Create:** `packages/domain/src/production-promotion-allowlist.ts` — the server-side project registry (pure data).
- **Create:** `packages/domain/src/production-promotion.ts` — `evaluateActionsPreflight()`, `computeDivergence()` (pure reducers).
- **Create:** `packages/domain/src/production-promotion.test.ts` — unit tests.
- **Modify:** `packages/project-config/src/index.ts` — extend `DeploymentConfig` + `validateDeploymentConfig` with an optional `mechanism` field and `actions` block; `health` becomes conditionally optional.
- **Modify:** `packages/project-config/src/deployment-config.test.ts` — tests for the new branch.
- **Create:** `packages/database/migrations/059_va_jobs_platform_project.sql` — idempotent upsert of the `va-jobs-platform` project row with the actions-mechanism `deployment` config.
- **Modify:** `apps/worker/src/provider-jobs.ts` — branch `deployment.sync_status`, `deployment.promote_check`, `deployment.promote` on `deployment.mechanism`; add `force` support to `deployment.promote`.
- **Modify:** `apps/worker/src/provider-jobs.deployment.test.ts` (or a new sibling `provider-jobs.production-promotion.test.ts` if the existing file is already large — check its line count first) — worker job unit tests for the new branch.
- **Modify:** `apps/web/src/server.ts` — add one route: `POST /api/admin/projects/:id/deployment/promote-force`.
- **Modify:** `apps/web/src/server.test.ts` or the existing route test file covering deployment routes (find it first) — route tests.
- **Modify:** `apps/web/src/pages/merge.ts` — wrap the existing body in a top-level tablist (`Merge branches` / `Production`), add the Production tab body with a `VA Jobs Platform` project sub-tab.
- **Modify:** `apps/web/src/ui.ts` — add client-side wiring for the Production tab (status render, pre-flight checklist, promote button + confirmation dialog, diverged-recovery dialog, deployment progress polling), scoped to the existing `path==="/admin/merge"` script block, following the exact pattern already used by `initDeploymentTab()` (`ui.ts:404-504`).
- **Create/Modify:** a DOM-stub test file covering `/admin/merge`'s client script (check whether one already exists, e.g. `apps/web/src/merge-page-wiring.test.ts`; if not, create it) — confirms the new script tolerates the added markup and the old merge behavior is unchanged.

---

### Task 1: Additive migration for Actions-based tracking columns

**Files:**
- Create: `packages/database/migrations/058_production_promotion_actions_tracking.sql`

**Interfaces:**
- Produces: new nullable columns consumed by Tasks 8 (worker) and 11 (UI).

- [ ] **Step 1: Confirm migration numbering**

Run: `ls packages/database/migrations/ | sort -V | tail -3` — confirm `057_*.sql` (or `056_deployment_management.sql` if 057 doesn't exist) is the highest, so this migration is the next integer.

- [ ] **Step 2: Write the migration**

```sql
-- packages/database/migrations/058_production_promotion_actions_tracking.sql
-- Additive columns for the github_actions_jobs deployment mechanism. All
-- nullable/defaulted so rows for projects using the existing "health_check"
-- mechanism are never populated and existing reads are unaffected.

ALTER TABLE deployment_status_snapshots
  ADD COLUMN master_workflow_run_id bigint,
  ADD COLUMN master_workflow_conclusion text,
  ADD COLUMN docker_image_job_conclusion text,
  ADD COLUMN ghcr_checked boolean NOT NULL DEFAULT false,
  ADD COLUMN ghcr_verified boolean,
  ADD COLUMN divergence text CHECK (divergence IN ('up_to_date','behind_master','diverged','unavailable')),
  ADD COLUMN production_workflow_run_id bigint,
  ADD COLUMN production_workflow_conclusion text,
  ADD COLUMN migrations_job_conclusion text,
  ADD COLUMN deploy_job_conclusion text;

ALTER TABLE production_releases
  ADD COLUMN forced boolean NOT NULL DEFAULT false,
  -- Set true only when the ref-update failure was specifically classified as
  -- a 422 non-fast-forward (see Task 4) — lets the UI distinguish "diverged,
  -- needs the force-recovery flow" from any other ref_update_failed cause
  -- (401/403/network/rate-limit) without widening the `status` CHECK.
  ADD COLUMN non_fast_forward boolean NOT NULL DEFAULT false,
  ADD COLUMN production_workflow_run_id bigint;
```

- [ ] **Step 3: Run the migration locally**

Check `packages/database/package.json` or the root `package.json` for a `migrate` script (e.g. `pnpm --filter @dcc/database migrate`), matching however `056_deployment_management.sql` was applied. Run it.

Expected: migration applies cleanly; `\d deployment_status_snapshots` and `\d production_releases` (via `psql`) show the new columns.

- [ ] **Step 4: Add migration coverage**

Open `packages/database/src/migrate.test.ts` and find the existing assertion pattern that verifies migrations apply in order with no errors (it should already exercise 056 by virtue of running every migration file in the directory — confirm this is a "run them all" test, not an enumerated list; if enumerated, add 058 to it).

- [ ] **Step 5: Commit**

```bash
git add packages/database/migrations/058_production_promotion_actions_tracking.sql
git commit -m "feat: add production-promotion Actions-tracking columns"
```

---

### Task 2: GitHub Actions workflow-run/job/compare provider functions

**Files:**
- Create: `packages/github-provider/src/actions.ts`
- Test: `packages/github-provider/src/actions.test.ts`

**Interfaces:**
- Consumes: `apiBaseUrl`, `request`, `GitHubProviderError` — read the top of `packages/github-provider/src/index.ts` to confirm these exact export names and signatures before importing (they are used elsewhere in that file at e.g. `index.ts:405-409`'s `getBranchHeadCommit`).
- Produces:
  ```ts
  export type WorkflowRunSummary = {
    id: number;
    name: string | null;
    headBranch: string;
    headSha: string;
    event: string;
    status: string;       // "queued" | "in_progress" | "completed" | ...
    conclusion: string | null; // "success" | "failure" | "cancelled" | null while not completed
    createdAt: string;
    htmlUrl: string;
  };
  export async function findWorkflowRun(
    owner: string, repository: string,
    filter: { sha: string; branch: string; event: string; createdAfter?: string },
  ): Promise<WorkflowRunSummary | null>;

  export type WorkflowJobSummary = {
    name: string;
    status: string;
    conclusion: string | null;
    htmlUrl: string;
  };
  export async function getWorkflowRunJobs(owner: string, repository: string, runId: number): Promise<WorkflowJobSummary[]>;

  export type CommitComparison = {
    status: "identical" | "ahead" | "behind" | "diverged";
    aheadBy: number;
    behindBy: number;
  };
  export async function compareCommits(owner: string, repository: string, base: string, head: string): Promise<CommitComparison>;
  ```
  Consumed by Task 8 (worker job handlers).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/github-provider/src/actions.test.ts
import { expect, test, vi, beforeEach } from "vitest";
import { findWorkflowRun, getWorkflowRunJobs, compareCommits } from "./actions.ts";

beforeEach(() => { process.env.GITHUB_TOKEN = "test-token"; vi.restoreAllMocks(); });

function mockFetchOnce(status: number, body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

test("findWorkflowRun filters by head_sha, branch, and event, and picks the newest match", async () => {
  const fetchSpy = mockFetchOnce(200, {
    workflow_runs: [
      { id: 2, name: "CI", head_branch: "master", head_sha: "a".repeat(40), event: "push", status: "completed", conclusion: "success", created_at: "2026-01-02T00:00:00Z", html_url: "https://x/2" },
      { id: 1, name: "CI", head_branch: "master", head_sha: "a".repeat(40), event: "push", status: "completed", conclusion: "success", created_at: "2026-01-01T00:00:00Z", html_url: "https://x/1" },
    ],
  });
  const run = await findWorkflowRun("dutchbase", "va-jobs-platform", { sha: "a".repeat(40), branch: "master", event: "push" });
  expect(run?.id).toBe(2);
  const calledUrl = fetchSpy.mock.calls[0][0] as string;
  expect(calledUrl).toContain("head_sha=" + "a".repeat(40));
  expect(calledUrl).toContain("branch=master");
  expect(calledUrl).toContain("event=push");
});

test("findWorkflowRun returns null when no run matches", async () => {
  mockFetchOnce(200, { workflow_runs: [] });
  const run = await findWorkflowRun("dutchbase", "va-jobs-platform", { sha: "a".repeat(40), branch: "production", event: "push" });
  expect(run).toBeNull();
});

test("findWorkflowRun ignores a run older than createdAfter", async () => {
  mockFetchOnce(200, {
    workflow_runs: [
      { id: 1, name: "CI", head_branch: "master", head_sha: "a".repeat(40), event: "push", status: "completed", conclusion: "success", created_at: "2020-01-01T00:00:00Z", html_url: "https://x/1" },
    ],
  });
  const run = await findWorkflowRun("dutchbase", "va-jobs-platform", { sha: "a".repeat(40), branch: "master", event: "push", createdAfter: "2026-01-01T00:00:00Z" });
  expect(run).toBeNull();
});

test("getWorkflowRunJobs maps job name/status/conclusion", async () => {
  mockFetchOnce(200, { jobs: [{ name: "docker-image", status: "completed", conclusion: "success", html_url: "https://x/job/1" }] });
  const jobs = await getWorkflowRunJobs("dutchbase", "va-jobs-platform", 123);
  expect(jobs).toEqual([{ name: "docker-image", status: "completed", conclusion: "success", htmlUrl: "https://x/job/1" }]);
});

test("compareCommits maps GitHub's status field", async () => {
  mockFetchOnce(200, { status: "ahead", ahead_by: 3, behind_by: 0 });
  const cmp = await compareCommits("dutchbase", "va-jobs-platform", "b".repeat(40), "a".repeat(40));
  expect(cmp).toEqual({ status: "ahead", aheadBy: 3, behindBy: 0 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:unit -- packages/github-provider/src/actions` (confirm exact vitest invocation from root `package.json` scripts first — mirror whatever `packages/github-provider/src/registry.test.ts` uses).
Expected: FAIL — module `./actions.ts` doesn't exist.

- [ ] **Step 3: Implement**

First read `packages/github-provider/src/index.ts:1-50` and `:405-417` (`getBranchHeadCommit`, `getPullRequestsForCommit`) to copy the exact `request<T>()` call convention (headers, error handling) used by this codebase — do not invent a different fetch wrapper.

```ts
// packages/github-provider/src/actions.ts
import { request } from "./index.ts";

export type WorkflowRunSummary = {
  id: number; name: string | null; headBranch: string; headSha: string; event: string;
  status: string; conclusion: string | null; createdAt: string; htmlUrl: string;
};

export async function findWorkflowRun(
  owner: string, repository: string,
  filter: { sha: string; branch: string; event: string; createdAfter?: string },
): Promise<WorkflowRunSummary | null> {
  const query = new URLSearchParams({
    head_sha: filter.sha, branch: filter.branch, event: filter.event, per_page: "10",
  });
  const result = await request<{ workflow_runs: any[] }>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/runs?${query.toString()}`,
  );
  const runs = (result.workflow_runs ?? [])
    .filter((run) => !filter.createdAfter || run.created_at >= filter.createdAfter)
    .sort((left, right) => (left.created_at < right.created_at ? 1 : -1));
  const newest = runs[0];
  if (!newest) return null;
  return {
    id: newest.id, name: newest.name ?? null, headBranch: newest.head_branch, headSha: newest.head_sha,
    event: newest.event, status: newest.status, conclusion: newest.conclusion ?? null,
    createdAt: newest.created_at, htmlUrl: newest.html_url,
  };
}

export type WorkflowJobSummary = { name: string; status: string; conclusion: string | null; htmlUrl: string };

export async function getWorkflowRunJobs(owner: string, repository: string, runId: number): Promise<WorkflowJobSummary[]> {
  const result = await request<{ jobs: any[] }>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/runs/${runId}/jobs?per_page=100`,
  );
  return (result.jobs ?? []).map((job) => ({
    name: job.name, status: job.status, conclusion: job.conclusion ?? null, htmlUrl: job.html_url,
  }));
}

export type CommitComparison = { status: "identical" | "ahead" | "behind" | "diverged"; aheadBy: number; behindBy: number };

export async function compareCommits(owner: string, repository: string, base: string, head: string): Promise<CommitComparison> {
  const result = await request<{ status: string; ahead_by: number; behind_by: number }>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
  );
  return { status: result.status as CommitComparison["status"], aheadBy: result.ahead_by, behindBy: result.behind_by };
}
```

If `request<T>()` is not exported from `index.ts` (only used internally), export it there first (one-line change: add `export` to its declaration) rather than duplicating the fetch/auth/error-handling logic in this new file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:unit -- packages/github-provider/src/actions`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/github-provider/src/actions.ts packages/github-provider/src/actions.test.ts packages/github-provider/src/index.ts
git commit -m "feat: add GitHub Actions workflow-run/job/compare provider functions"
```

---

### Task 3: GHCR check as an optional/advisory three-state result

**Files:**
- Modify: `packages/github-provider/src/registry.ts`
- Test: `packages/github-provider/src/registry.test.ts`

**Interfaces:**
- Consumes: nothing new — same manifest-fetch logic already in `checkImageExists`.
- Produces:
  ```ts
  export type ImageExistenceResult = { state: "exists" | "not_exists" | "unknown"; digest?: string; reason?: string };
  export async function checkImageExistsDetailed(registry: string, repository: string, tag: string): Promise<ImageExistenceResult>;
  ```
  Consumed by Task 7 (`evaluateActionsPreflight`) — treated as advisory only (never contributes to `eligible:false`).

- [ ] **Step 1: Read the existing implementation in full**

Read `packages/github-provider/src/registry.ts` end to end (it's ~54 lines per the investigation). Confirm the exact 200/404/429/5xx/other-status branches before writing the new function, since it must reuse the same auth/Accept-header logic without duplicating the whole file.

- [ ] **Step 2: Write the failing tests**

```ts
// append to packages/github-provider/src/registry.test.ts
import { checkImageExistsDetailed } from "./registry.ts";

test("checkImageExistsDetailed returns state:exists with digest on 200", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 200, headers: { "docker-content-digest": "sha256:abc" } }));
  const result = await checkImageExistsDetailed("ghcr.io", "dutchbase/va-jobs-platform", "sha-" + "a".repeat(40));
  expect(result).toEqual({ state: "exists", digest: "sha256:abc" });
});

test("checkImageExistsDetailed returns state:not_exists on 404", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 404 }));
  const result = await checkImageExistsDetailed("ghcr.io", "dutchbase/va-jobs-platform", "sha-" + "a".repeat(40));
  expect(result.state).toBe("not_exists");
});

test("checkImageExistsDetailed returns state:unknown (not not_exists) on a 429", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 429 }));
  const result = await checkImageExistsDetailed("ghcr.io", "dutchbase/va-jobs-platform", "sha-" + "a".repeat(40));
  expect(result.state).toBe("unknown");
  expect(result.reason).toBeTruthy();
});

test("checkImageExistsDetailed returns state:unknown on a 5xx", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 503 }));
  const result = await checkImageExistsDetailed("ghcr.io", "dutchbase/va-jobs-platform", "sha-" + "a".repeat(40));
  expect(result.state).toBe("unknown");
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test:unit -- packages/github-provider/src/registry`
Expected: FAIL — `checkImageExistsDetailed` not exported.

- [ ] **Step 4: Implement**

Factor the existing `checkImageExists` body's token-fetch + manifest-request logic into a shared internal helper if it isn't already broken out, then add:

```ts
// packages/github-provider/src/registry.ts (append)
export async function checkImageExistsDetailed(registry: string, repository: string, tag: string): Promise<ImageExistenceResult> {
  try {
    const result = await checkImageExists(registry, repository, tag);
    // checkImageExists's existing contract: {exists:false} covers both a real
    // 404 and a transient 429/5xx (registry.ts:39-41) — re-derive which one
    // happened is not possible from that return shape alone, so this
    // function must duplicate the manifest fetch rather than wrap the old
    // one. Read the real current implementation (Step 1) and copy its
    // request-building logic here, branching explicitly:
    //   200 -> {state:"exists", digest: <docker-content-digest header>}
    //   404 -> {state:"not_exists"}
    //   429/5xx -> {state:"unknown", reason:`GHCR returned ${status}`}
    //   auth failure after GHCR_READ_TOKEN fallback -> {state:"unknown", reason:"authRequired"}
    //   anything else -> {state:"unknown", reason:`unexpected status ${status}`} (do NOT throw — this
    //     function must never throw, since callers treat it as advisory-only)
    return result; // placeholder — replace with the real branching per the comment above once Step 1's read is done
  } catch (error) {
    return { state: "unknown", reason: error instanceof Error ? error.message : String(error) };
  }
}
```

Do not leave the placeholder in the final code — the comment above is a guide for the branching logic to write once Step 1's read confirms the exact status-handling in `checkImageExists`; the implementer must replace the body with real 200/404/429/5xx/auth-failure branches matching what Step 1 found, never a call-through to the boolean-collapsing original.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test:unit -- packages/github-provider/src/registry`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/github-provider/src/registry.ts packages/github-provider/src/registry.test.ts
git commit -m "feat: add three-state GHCR image-existence check for advisory use"
```

---

### Task 4: Classify 422 ref-update failures as non-fast-forward

**Files:**
- Modify: `packages/github-provider/src/index.ts` (`updateBranchReference`, `:419-428`)
- Test: `packages/github-provider/src/index.test.ts`

**Interfaces:**
- Produces: `updateBranchReference` still throws `GitHubProviderError` on 422 exactly as before, but the error now carries a `nonFastForward: boolean` property when GitHub's response body indicates a non-fast-forward rejection specifically (vs. some other 422 reason, e.g. "reference does not exist"). Consumed by Task 8 (`deployment.promote`) to set `production_releases.non_fast_forward`.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/github-provider/src/index.test.ts
test("updateBranchReference marks a non-fast-forward 422 distinctly from other 422s", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(
    JSON.stringify({ message: "Update is not a fast forward" }), { status: 422 },
  ));
  await expect(updateBranchReference("dutchbase", "va-jobs-platform", "production", "a".repeat(40), false))
    .rejects.toMatchObject({ status: 422, nonFastForward: true });
});

test("updateBranchReference does not mark an unrelated 422 as non-fast-forward", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(
    JSON.stringify({ message: "Reference does not exist" }), { status: 422 },
  ));
  await expect(updateBranchReference("dutchbase", "va-jobs-platform", "production", "a".repeat(40), false))
    .rejects.toMatchObject({ status: 422, nonFastForward: false });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- packages/github-provider/src/index`
Expected: FAIL — `nonFastForward` is `undefined`, not `true`/`false`.

- [ ] **Step 3: Implement**

Modify `updateBranchReference` (`packages/github-provider/src/index.ts:419-428`):

```ts
export async function updateBranchReference(owner: string, repository: string, branch: string, sha: string, force = false): Promise<{ sha: string }> {
  const response = await responseFor(
    `${apiBaseUrl()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/refs/heads/${encodeURIComponent(branch)}`,
    { method: "PATCH", body: JSON.stringify({ sha, force }) },
    [422],
  );
  if (response.status === 422) {
    const body = await response.clone().json().catch(() => ({}) as { message?: string });
    const nonFastForward = /not a fast forward/i.test(body.message ?? "");
    const error = new GitHubProviderError("http_error", `branch ref update was rejected (force:${force})`, 422);
    (error as GitHubProviderError & { nonFastForward: boolean }).nonFastForward = nonFastForward;
    throw error;
  }
  const responseBody = await jsonFor<{ object: { sha: string } }>(response);
  return { sha: responseBody.object.sha };
}
```

Check `GitHubProviderError`'s class definition first (near the top of `index.ts`) — if it's a plain class without an index signature, either add an optional `nonFastForward?: boolean` field to the class itself (cleaner) instead of the cast above, matching however the class already exposes optional fields like `retryAt`/`cursor` (seen used at `packages/github-provider/src/index.ts:367` from the investigation).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- packages/github-provider/src/index`
Expected: PASS

- [ ] **Step 5: Run the full package test suite for regressions**

Run: `pnpm test:unit -- packages/github-provider`
Expected: PASS — `deployment.rollback`'s use of `updateBranchReference` (`apps/worker/src/provider-jobs.ts:455`) is unaffected since it doesn't read `nonFastForward`.

- [ ] **Step 6: Commit**

```bash
git add packages/github-provider/src/index.ts packages/github-provider/src/index.test.ts
git commit -m "feat: classify 422 ref-update failures as non-fast-forward or not"
```

---

### Task 5: `DeploymentConfig` gains an opt-in Actions-based mechanism

**Files:**
- Modify: `packages/project-config/src/index.ts` (`DeploymentConfig` type + `validateDeploymentConfig`, `:86-148`)
- Test: `packages/project-config/src/deployment-config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type DeploymentConfig = {
    enabled: boolean;
    production_branch: string;
    image: { registry: string; repository: string; tag_template: string };
    health?: { host: string; health_path: string; version_path: string; version_field?: string }; // now optional
    promotion: { require_e2e_gate_label: boolean; e2e_gate_label?: string };
    auto_rollback_on_failed_health_check?: boolean;
    cron_jobs?: Array<{ key: string; description?: string; expected_interval_minutes: number; grace_minutes?: number }>;
    cron_webhook_secret_reference?: string;
    mechanism?: "health_check" | "github_actions_jobs"; // new, defaults to "health_check" when absent
    actions?: { docker_image_job_name: string; migrations_job_name: string; deploy_job_name: string }; // required iff mechanism === "github_actions_jobs"
  };
  ```
  Consumed by Task 8 (worker) to branch handler behavior, and Task 9 (seed migration) to populate.

- [ ] **Step 1: Write the failing tests**

```ts
// append to packages/project-config/src/deployment-config.test.ts
import { validateDeploymentConfig } from "./index.ts";

test("mechanism absent defaults to health_check semantics — health still required", () => {
  const errors = validateDeploymentConfig({
    enabled: true, production_branch: "production",
    image: { registry: "ghcr.io", repository: "x/y", tag_template: "sha-{{commit}}" },
    promotion: { require_e2e_gate_label: false },
    // health omitted
  });
  expect(errors).toContain("deployment.health is required");
});

test("mechanism github_actions_jobs makes health optional but requires actions block", () => {
  const errors = validateDeploymentConfig({
    enabled: true, production_branch: "production", mechanism: "github_actions_jobs",
    image: { registry: "ghcr.io", repository: "dutchbase/va-jobs-platform", tag_template: "sha-{{commit}}" },
    promotion: { require_e2e_gate_label: false },
    // health omitted deliberately
  });
  expect(errors).toContain("deployment.actions is required when mechanism is github_actions_jobs");
});

test("a complete github_actions_jobs config with no health block is valid", () => {
  const errors = validateDeploymentConfig({
    enabled: true, production_branch: "production", mechanism: "github_actions_jobs",
    image: { registry: "ghcr.io", repository: "dutchbase/va-jobs-platform", tag_template: "sha-{{commit}}" },
    promotion: { require_e2e_gate_label: false },
    actions: { docker_image_job_name: "docker-image", migrations_job_name: "migrations-production", deploy_job_name: "deploy-production" },
  });
  expect(errors).toEqual([]);
});

test("an unknown mechanism value is rejected", () => {
  const errors = validateDeploymentConfig({
    enabled: true, production_branch: "production", mechanism: "something_else",
    image: { registry: "ghcr.io", repository: "x/y", tag_template: "sha-{{commit}}" },
    health: { host: "https://x", health_path: "/health", version_path: "/version" },
    promotion: { require_e2e_gate_label: false },
  });
  expect(errors).toContain('deployment.mechanism must be "health_check" or "github_actions_jobs"');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:unit -- packages/project-config/src/deployment-config`
Expected: FAIL on the last three (mechanism/actions not yet validated).

- [ ] **Step 3: Implement**

In `packages/project-config/src/index.ts`, update the type (as shown in Interfaces above — `health` becomes `health?:`) and edit `validateDeploymentConfig` (`:107-148`):

```ts
export function validateDeploymentConfig(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== "object" || Array.isArray(value)) return ["deployment must be an object"];
  const v = value as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof v.enabled !== "boolean") errors.push("deployment.enabled must be a boolean");
  if (v.enabled !== true) return errors;
  if (typeof v.production_branch !== "string" || !v.production_branch.trim()) errors.push("deployment.production_branch is required");
  const image = v.image as Record<string, unknown> | undefined;
  if (!image || typeof image !== "object") errors.push("deployment.image is required");
  else {
    if (typeof image.registry !== "string" || !image.registry.trim()) errors.push("deployment.image.registry is required");
    if (typeof image.repository !== "string" || !image.repository.trim()) errors.push("deployment.image.repository is required");
    if (typeof image.tag_template !== "string" || !image.tag_template.includes("{{commit}}")) errors.push("deployment.image.tag_template must contain {{commit}}");
  }
  const mechanism = v.mechanism === undefined ? "health_check" : v.mechanism;
  if (mechanism !== "health_check" && mechanism !== "github_actions_jobs") {
    errors.push('deployment.mechanism must be "health_check" or "github_actions_jobs"');
  }
  const health = v.health as Record<string, unknown> | undefined;
  if (mechanism === "health_check") {
    if (!health || typeof health !== "object") errors.push("deployment.health is required");
    else {
      if (typeof health.host !== "string" || !/^https?:\/\//.test(health.host)) errors.push("deployment.health.host must be an http(s) URL");
      if (typeof health.health_path !== "string" || !health.health_path.startsWith("/")) errors.push("deployment.health.health_path must start with /");
      if (typeof health.version_path !== "string" || !health.version_path.startsWith("/")) errors.push("deployment.health.version_path must start with /");
    }
  } else if (health !== undefined) {
    // health is optional under github_actions_jobs, but if provided it must still be well-formed
    if (typeof health !== "object") errors.push("deployment.health must be an object when provided");
    else {
      if (typeof health.host !== "string" || !/^https?:\/\//.test(health.host)) errors.push("deployment.health.host must be an http(s) URL");
      if (typeof health.health_path !== "string" || !health.health_path.startsWith("/")) errors.push("deployment.health.health_path must start with /");
      if (typeof health.version_path !== "string" || !health.version_path.startsWith("/")) errors.push("deployment.health.version_path must start with /");
    }
  }
  if (mechanism === "github_actions_jobs") {
    const actions = v.actions as Record<string, unknown> | undefined;
    if (!actions || typeof actions !== "object") errors.push("deployment.actions is required when mechanism is github_actions_jobs");
    else {
      if (typeof actions.docker_image_job_name !== "string" || !actions.docker_image_job_name.trim()) errors.push("deployment.actions.docker_image_job_name is required");
      if (typeof actions.migrations_job_name !== "string" || !actions.migrations_job_name.trim()) errors.push("deployment.actions.migrations_job_name is required");
      if (typeof actions.deploy_job_name !== "string" || !actions.deploy_job_name.trim()) errors.push("deployment.actions.deploy_job_name is required");
    }
  }
  const promotion = v.promotion as Record<string, unknown> | undefined;
  if (!promotion || typeof promotion !== "object") errors.push("deployment.promotion is required");
  else if (typeof promotion.require_e2e_gate_label !== "boolean") errors.push("deployment.promotion.require_e2e_gate_label must be a boolean");
  if (v.cron_jobs !== undefined) {
    if (!Array.isArray(v.cron_jobs)) errors.push("deployment.cron_jobs must be an array");
    else v.cron_jobs.forEach((job: any, i: number) => {
      if (typeof job?.key !== "string" || !job.key.trim()) errors.push(`deployment.cron_jobs[${i}].key is required`);
      if (typeof job?.expected_interval_minutes !== "number" || job.expected_interval_minutes <= 0) errors.push(`deployment.cron_jobs[${i}].expected_interval_minutes must be a positive number`);
    });
  }
  if (v.cron_webhook_secret_reference !== undefined) {
    if (typeof v.cron_webhook_secret_reference !== "string" || !cronWebhookSecretReferencePattern.test(v.cron_webhook_secret_reference)) {
      errors.push("deployment.cron_webhook_secret_reference must match DCC_DEPLOYMENT_SECRET_<NAME>");
    }
  }
  if (image && typeof image === "object" && typeof image.registry === "string" && image.registry.trim() && image.registry !== "ghcr.io") {
    errors.push("deployment.image.registry must be ghcr.io (only registry currently supported)");
  }
  return errors;
}
```

- [ ] **Step 4: Run tests to verify they pass, then the full package suite**

Run: `pnpm test:unit -- packages/project-config`
Expected: PASS, including the 9 pre-existing tests (undefined/disabled/valid/missing-branch/missing-image/bad-tag-template/bad-registry/bad-secret-ref/malformed-cron listed in the investigation) — this confirms the `health_check` default path is unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/project-config/src/index.ts packages/project-config/src/deployment-config.test.ts
git commit -m "feat: add github_actions_jobs deployment mechanism to DeploymentConfig"
```

---

### Task 6: Server-side allowlist for production-promotion projects

**Files:**
- Create: `packages/domain/src/production-promotion-allowlist.ts`
- Test: `packages/domain/src/production-promotion-allowlist.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ProductionPromotionAllowlistEntry = {
    projectSlug: string;      // matches projects.slug
    owner: string;            // "dutchbase"
    repo: string;             // "va-jobs-platform"
    sourceBranch: string;     // "master"
    targetBranch: string;     // "production"
    allowForce: boolean;      // whether the promote-force route may act on this project
  };
  export const PRODUCTION_PROMOTION_ALLOWLIST: readonly ProductionPromotionAllowlistEntry[];
  export function findAllowlistEntry(projectSlugOrId: string, projectRow: { slug: string; id: string }): ProductionPromotionAllowlistEntry | null;
  ```
  Consumed by Task 8 (worker, defense-in-depth check inside `deployment.promote`/`deployment.promote_check` when `deployment.mechanism === "github_actions_jobs"`) and the new route in Task 8b.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/domain/src/production-promotion-allowlist.test.ts
import { expect, test } from "vitest";
import { PRODUCTION_PROMOTION_ALLOWLIST, findAllowlistEntry } from "./production-promotion-allowlist.ts";

test("va-jobs-platform is on the allowlist with the exact required repo/branch pair", () => {
  const entry = PRODUCTION_PROMOTION_ALLOWLIST.find((e) => e.projectSlug === "va-jobs-platform");
  expect(entry).toMatchObject({ owner: "dutchbase", repo: "va-jobs-platform", sourceBranch: "master", targetBranch: "production" });
});

test("findAllowlistEntry returns null for a project row not on the list", () => {
  const result = findAllowlistEntry("some-other-project", { id: "x", slug: "some-other-project" });
  expect(result).toBeNull();
});

test("findAllowlistEntry matches by slug even if the DB row's owner/repo were tampered with", () => {
  // The allowlist entry — not the DB row — is the source of truth for owner/repo/branches.
  const result = findAllowlistEntry("va-jobs-platform", { id: "x", slug: "va-jobs-platform" });
  expect(result?.owner).toBe("dutchbase");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:unit -- packages/domain/src/production-promotion-allowlist`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
// packages/domain/src/production-promotion-allowlist.ts
export type ProductionPromotionAllowlistEntry = {
  projectSlug: string; owner: string; repo: string; sourceBranch: string; targetBranch: string; allowForce: boolean;
};

export const PRODUCTION_PROMOTION_ALLOWLIST: readonly ProductionPromotionAllowlistEntry[] = [
  { projectSlug: "va-jobs-platform", owner: "dutchbase", repo: "va-jobs-platform", sourceBranch: "master", targetBranch: "production", allowForce: true },
];

export function findAllowlistEntry(projectSlugOrId: string, projectRow: { slug: string; id: string }): ProductionPromotionAllowlistEntry | null {
  return PRODUCTION_PROMOTION_ALLOWLIST.find((entry) => entry.projectSlug === projectRow.slug || entry.projectSlug === projectSlugOrId) ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:unit -- packages/domain/src/production-promotion-allowlist`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/production-promotion-allowlist.ts packages/domain/src/production-promotion-allowlist.test.ts
git commit -m "feat: add server-side allowlist for production-promotion projects"
```

---

### Task 7: Actions-based pre-flight and divergence reducers

**Files:**
- Create: `packages/domain/src/production-promotion.ts`
- Test: `packages/domain/src/production-promotion.test.ts`

**Interfaces:**
- Consumes: `WorkflowRunSummary`, `WorkflowJobSummary` (Task 2), `ImageExistenceResult` (Task 3), `CommitComparison` (Task 2).
- Produces:
  ```ts
  export type ActionsPreflightInput = {
    masterWorkflowRun: import("../../github-provider/src/actions.ts").WorkflowRunSummary | null;
    masterWorkflowJobs: import("../../github-provider/src/actions.ts").WorkflowJobSummary[];
    dockerImageJobName: string;
    ghcr: import("../../github-provider/src/registry.ts").ImageExistenceResult;
  };
  export type ActionsPreflightResult = { eligible: boolean; reasons: string[]; dockerImageJobConclusion: string | null };
  export function evaluateActionsPreflight(input: ActionsPreflightInput): ActionsPreflightResult;

  export function computeDivergence(comparison: import("../../github-provider/src/actions.ts").CommitComparison | null): "up_to_date" | "behind_master" | "diverged" | "unavailable";
  ```
  Consumed by Task 8 (worker).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/domain/src/production-promotion.test.ts
import { expect, test } from "vitest";
import { evaluateActionsPreflight, computeDivergence } from "./production-promotion.ts";

const baseRun = { id: 1, name: "CI", headBranch: "master", headSha: "a".repeat(40), event: "push", status: "completed", conclusion: "success", createdAt: "2026-01-01T00:00:00Z", htmlUrl: "x" };

test("eligible when the master run succeeded and docker-image job succeeded, regardless of GHCR state", () => {
  const result = evaluateActionsPreflight({
    masterWorkflowRun: baseRun,
    masterWorkflowJobs: [{ name: "docker-image", status: "completed", conclusion: "success", htmlUrl: "x" }],
    dockerImageJobName: "docker-image",
    ghcr: { state: "unknown", reason: "rate limited" }, // GHCR failure must NOT block
  });
  expect(result.eligible).toBe(true);
  expect(result.dockerImageJobConclusion).toBe("success");
});

test("ineligible when no master workflow run was found", () => {
  const result = evaluateActionsPreflight({ masterWorkflowRun: null, masterWorkflowJobs: [], dockerImageJobName: "docker-image", ghcr: { state: "unknown" } });
  expect(result.eligible).toBe(false);
  expect(result.reasons).toContain("master_workflow_not_found");
});

test("ineligible when the master workflow run has not concluded", () => {
  const result = evaluateActionsPreflight({
    masterWorkflowRun: { ...baseRun, status: "in_progress", conclusion: null },
    masterWorkflowJobs: [], dockerImageJobName: "docker-image", ghcr: { state: "unknown" },
  });
  expect(result.eligible).toBe(false);
  expect(result.reasons).toContain("master_workflow_pending");
});

test("ineligible when the master workflow run failed", () => {
  const result = evaluateActionsPreflight({
    masterWorkflowRun: { ...baseRun, conclusion: "failure" },
    masterWorkflowJobs: [], dockerImageJobName: "docker-image", ghcr: { state: "unknown" },
  });
  expect(result.eligible).toBe(false);
  expect(result.reasons).toContain("master_workflow_failed");
});

test("ineligible when the docker-image job is missing from the run", () => {
  const result = evaluateActionsPreflight({
    masterWorkflowRun: baseRun, masterWorkflowJobs: [{ name: "lint", status: "completed", conclusion: "success", htmlUrl: "x" }],
    dockerImageJobName: "docker-image", ghcr: { state: "unknown" },
  });
  expect(result.eligible).toBe(false);
  expect(result.reasons).toContain("docker_image_job_missing");
});

test("ineligible when the docker-image job failed", () => {
  const result = evaluateActionsPreflight({
    masterWorkflowRun: baseRun, masterWorkflowJobs: [{ name: "docker-image", status: "completed", conclusion: "failure", htmlUrl: "x" }],
    dockerImageJobName: "docker-image", ghcr: { state: "unknown" },
  });
  expect(result.eligible).toBe(false);
  expect(result.reasons).toContain("docker_image_job_failed");
});

test("computeDivergence maps identical to up_to_date", () => {
  expect(computeDivergence({ status: "identical", aheadBy: 0, behindBy: 0 })).toBe("up_to_date");
});
test("computeDivergence maps ahead (master ahead of production) to behind_master", () => {
  expect(computeDivergence({ status: "ahead", aheadBy: 3, behindBy: 0 })).toBe("behind_master");
});
test("computeDivergence maps diverged to diverged", () => {
  expect(computeDivergence({ status: "diverged", aheadBy: 2, behindBy: 1 })).toBe("diverged");
});
test("computeDivergence maps a null comparison (compare API failed) to unavailable", () => {
  expect(computeDivergence(null)).toBe("unavailable");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:unit -- packages/domain/src/production-promotion`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
// packages/domain/src/production-promotion.ts
import type { WorkflowRunSummary, WorkflowJobSummary, CommitComparison } from "../../github-provider/src/actions.ts";
import type { ImageExistenceResult } from "../../github-provider/src/registry.ts";

export type ActionsPreflightInput = {
  masterWorkflowRun: WorkflowRunSummary | null;
  masterWorkflowJobs: WorkflowJobSummary[];
  dockerImageJobName: string;
  ghcr: ImageExistenceResult; // advisory only — never affects `eligible`
};
export type ActionsPreflightResult = { eligible: boolean; reasons: string[]; dockerImageJobConclusion: string | null };

export function evaluateActionsPreflight(input: ActionsPreflightInput): ActionsPreflightResult {
  const reasons: string[] = [];
  if (!input.masterWorkflowRun) {
    return { eligible: false, reasons: ["master_workflow_not_found"], dockerImageJobConclusion: null };
  }
  if (input.masterWorkflowRun.status !== "completed") {
    return { eligible: false, reasons: ["master_workflow_pending"], dockerImageJobConclusion: null };
  }
  if (input.masterWorkflowRun.conclusion !== "success") {
    reasons.push("master_workflow_failed");
  }
  const dockerJob = input.masterWorkflowJobs.find((job) => job.name === input.dockerImageJobName);
  if (!dockerJob) {
    reasons.push("docker_image_job_missing");
  } else if (dockerJob.status !== "completed") {
    reasons.push("docker_image_job_pending");
  } else if (dockerJob.conclusion !== "success") {
    reasons.push("docker_image_job_failed");
  }
  return { eligible: reasons.length === 0, reasons, dockerImageJobConclusion: dockerJob?.conclusion ?? null };
}

export function computeDivergence(comparison: CommitComparison | null): "up_to_date" | "behind_master" | "diverged" | "unavailable" {
  if (!comparison) return "unavailable";
  if (comparison.status === "identical") return "up_to_date";
  if (comparison.status === "ahead") return "behind_master"; // base(production)...head(master): master ahead of production
  if (comparison.status === "diverged") return "diverged";
  return "unavailable"; // "behind" (production ahead of master) shouldn't occur for a ref-pointer branch; treat as unavailable rather than guess
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:unit -- packages/domain/src/production-promotion`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/production-promotion.ts packages/domain/src/production-promotion.test.ts
git commit -m "feat: add Actions-based pre-flight and divergence reducers"
```

---

### Task 8: Extend `deployment.sync_status` / `promote_check` / `promote` for the Actions mechanism

**Files:**
- Modify: `apps/worker/src/provider-jobs.ts`
- Test: `apps/worker/src/provider-jobs.deployment.test.ts` (check its current line count with `wc -l`; if over ~400 lines, create `apps/worker/src/provider-jobs.production-promotion.test.ts` instead and import the same test helpers)

**Interfaces:**
- Consumes: `findWorkflowRun`, `getWorkflowRunJobs`, `compareCommits` (Task 2), `checkImageExistsDetailed` (Task 3), `evaluateActionsPreflight`, `computeDivergence` (Task 7), `findAllowlistEntry` (Task 6).
- Produces: no new exported functions — this task modifies the existing job handlers in place. Later tasks (9: route, 10: UI) rely on `deployment.promote`'s payload gaining an optional `force: boolean` field and its result gaining `outcome: "refused", refusal_code: "diverged_confirmation_required"` as a new possible outcome.

- [ ] **Step 1: Read the current handlers in full**

Read `apps/worker/src/provider-jobs.ts:1-80` (imports, `fetchLiveDeploymentStatus`, `loadDeploymentConfig`) and `:254-400` (`deployment.sync_status`, `deployment.promote_check`, `deployment.promote`) in full before editing — this task inserts `if (deployment.mechanism === "github_actions_jobs")` branches at specific points, not a rewrite.

- [ ] **Step 2: Write the failing tests**

Follow the exact mocking style of the existing 8 tests in `provider-jobs.deployment.test.ts` (`vi.mock("@dcc/github-provider", ...)`, `vi.mock("@dcc/domain", ...)` — read that file's setup block first and mirror it exactly, adding mocks for `findWorkflowRun`, `getWorkflowRunJobs`, `compareCommits`, `checkImageExistsDetailed`).

```ts
// New tests (in whichever file Step 1 determined — mirror existing describe/test structure)
test("sync_status (github_actions_jobs mechanism) persists master workflow run id, docker-image job conclusion, and divergence", async () => {
  // Arrange: project row with config_json.deployment.mechanism = "github_actions_jobs",
  // mocked findWorkflowRun returning a completed/success run, mocked getWorkflowRunJobs
  // returning a docker-image job with conclusion "success", mocked compareCommits
  // returning {status:"identical", aheadBy:0, behindBy:0}.
  // Act: runProviderJob({type:"deployment.sync_status", ...}, db).
  // Assert: the INSERT/UPSERT into deployment_status_snapshots was called with
  // master_workflow_run_id, docker_image_job_conclusion:"success", divergence:"up_to_date".
});

test("promote_check (github_actions_jobs mechanism) reports ineligible with docker_image_job_missing when the job isn't in the run", async () => {
  // Arrange as above but getWorkflowRunJobs returns jobs without a "docker-image" entry.
  // Act: runProviderJob({type:"deployment.promote_check", ...}, db).
  // Assert: persistJobResult was called with eligible:false, reasons containing "docker_image_job_missing".
});

test("promote_check ignores a GHCR failure — still eligible when Actions checks pass", async () => {
  // Arrange: checkImageExistsDetailed mock rejects/returns {state:"unknown"}, everything else passes.
  // Assert: eligible:true.
});

test("promote (github_actions_jobs mechanism) refuses master_workflow_not_found when no run exists for the exact SHA/branch/event", async () => {
  // Arrange: findWorkflowRun mock returns null.
  // Assert: persistJobResult called with outcome:"refused", refusal_code:"not_eligible", reasons containing "master_workflow_not_found".
});

test("promote (github_actions_jobs mechanism) still enforces master_moved before checking Actions eligibility", async () => {
  // Reuses the existing master_moved fixture/assertions pattern already in this file —
  // confirms the new mechanism branch doesn't skip the pre-existing CAS check.
});

test("promote classifies a non-fast-forward 422 and sets non_fast_forward:true without retrying", async () => {
  // Arrange: updateBranchReference mock throws a GitHubProviderError with nonFastForward:true.
  // Assert: the UPDATE production_releases call included non_fast_forward:true (or the query
  // string/params show it), status:'failed', and the job result outcome is
  // "refused" with refusal_code "non_fast_forward" (not "ref_update_failed" — this
  // is the one case that must NOT rethrow, since rethrowing triggers the worker's
  // retry machinery; see Step 3).
});

test("promote re-reads the production ref after a successful PATCH and fails the release if it doesn't match", async () => {
  // Arrange: updateBranchReference resolves normally, but a subsequent
  // getBranchHeadCommit(production_branch) mock returns a DIFFERENT sha than
  // what was just written.
  // Assert: production_releases status becomes 'failed' with a
  // 'ref_verify_failed' failure_reason, not 'pending_approval'.
});

test("promote with force:true is refused when the project is not on the allowlist's allowForce set", async () => {
  // Arrange: a hypothetical second project with mechanism github_actions_jobs but
  // not present in PRODUCTION_PROMOTION_ALLOWLIST (or allowForce:false).
  // Assert: outcome:"refused", refusal_code:"force_not_allowed", and
  // updateBranchReference was never called with force:true.
});

test("promote with force:true still requires commit_sha === fresh master sha", () => {
  // Same commit_not_master guard applies even when forcing.
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run whatever `pnpm test:unit -- apps/worker/src/provider-jobs` invocation matches the existing suite.
Expected: FAIL — none of the new branching exists yet.

- [ ] **Step 4: Implement**

**4a. `fetchLiveDeploymentStatus`** (`provider-jobs.ts:59-73`) — leave the existing function entirely as-is (it's still used by the `health_check` mechanism path). Add a sibling function used only by the new mechanism:

```ts
async function fetchActionsPreflightStatus(project: any, deployment: DeploymentConfig) {
  const master = await getBranchHeadCommit(project.github_owner, project.github_repository, project.default_branch);
  const masterRun = await findWorkflowRun(project.github_owner, project.github_repository, {
    sha: master.sha, branch: project.default_branch, event: "push",
  });
  const masterJobs = masterRun ? await getWorkflowRunJobs(project.github_owner, project.github_repository, masterRun.id) : [];
  const imageTag = deployment.image.tag_template.replace("{{commit}}", master.sha);
  const ghcr = await checkImageExistsDetailed(deployment.image.registry, deployment.image.repository, imageTag);
  const preflight = evaluateActionsPreflight({
    masterWorkflowRun: masterRun, masterWorkflowJobs: masterJobs,
    dockerImageJobName: deployment.actions!.docker_image_job_name, ghcr,
  });
  // Production SHA read live from the API — NOT lsRemoteHeads(project.repository_path) —
  // so this mechanism has no dependency on a local git clone existing on disk,
  // matching the task's explicit GET .../git/ref/heads/{branch} spec.
  const production = await getBranchHeadCommit(project.github_owner, project.github_repository, deployment.production_branch).catch(() => null);
  const comparison = production ? await compareCommits(project.github_owner, project.github_repository, deployment.production_branch, project.default_branch).catch(() => null) : null;
  return { master, masterRun, masterJobs, imageTag, ghcr, preflight, production, divergence: computeDivergence(comparison) };
}
```

Add the corresponding imports at the top of the file: `findWorkflowRun, getWorkflowRunJobs, compareCommits` from `@dcc/github-provider` (re-export them from `packages/github-provider/src/index.ts` if that package's public surface is defined by re-exports there — check how `registry.ts`'s `checkImageExists` is currently exposed to this file's existing import at `provider-jobs.ts:8` and mirror it exactly), `checkImageExistsDetailed` likewise, and `evaluateActionsPreflight, computeDivergence, findAllowlistEntry` from `@dcc/domain`.

**4b. `deployment.sync_status`** (`:254-298`) — after the existing `fetchLiveDeploymentStatus(project, deployment)` call, branch:

```ts
if (deployment.mechanism === "github_actions_jobs") {
  const actionsStatus = await fetchActionsPreflightStatus(project, deployment);
  await db.query(
    `INSERT INTO deployment_status_snapshots (project_id, master_commit_sha, master_workflow_run_id, master_workflow_conclusion, docker_image_job_conclusion, ghcr_checked, ghcr_verified, image_tag, production_commit_sha, divergence, fetched_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,true,$6,$7,$8,$9,now(),now())
     ON CONFLICT (project_id) DO UPDATE SET master_commit_sha=$2, master_workflow_run_id=$3, master_workflow_conclusion=$4, docker_image_job_conclusion=$5, ghcr_checked=true, ghcr_verified=$6, image_tag=$7, production_commit_sha=$8, divergence=$9, fetched_at=now(), updated_at=now()`,
    [projectId, actionsStatus.master.sha, actionsStatus.masterRun?.id ?? null, actionsStatus.masterRun?.conclusion ?? null,
     actionsStatus.preflight.dockerImageJobConclusion, actionsStatus.ghcr.state === "exists" ? true : actionsStatus.ghcr.state === "not_exists" ? false : null,
     actionsStatus.imageTag, actionsStatus.production?.sha ?? null, actionsStatus.divergence],
  );
  await persistJobResult(db, job.id, { outcome: "synced", mechanism: "github_actions_jobs", ...actionsStatus });
  return;
}
// existing health_check path continues unchanged below
```

**4c. `deployment.promote_check`** (`:300-319`) — same branch shape:

```ts
if (deployment.mechanism === "github_actions_jobs") {
  const actionsStatus = await fetchActionsPreflightStatus(project, deployment);
  await persistJobResult(db, job.id, {
    eligible: actionsStatus.preflight.eligible, reasons: actionsStatus.preflight.reasons,
    master_sha: actionsStatus.master.sha, master_commit_message: actionsStatus.master.message,
    image_tag: actionsStatus.imageTag, production_current_sha: actionsStatus.production?.sha ?? null,
    divergence: actionsStatus.divergence, master_workflow_run_url: actionsStatus.masterRun ? `https://github.com/${project.github_owner}/${project.github_repository}/actions/runs/${actionsStatus.masterRun.id}` : null,
  });
  return;
}
// existing health_check path continues unchanged below
```

**4d. `deployment.promote`** (`:321-400`) — this handler needs the most surgery. After the existing `commit_not_master` check (`:338-342`) and before the existing generic eligibility check, branch:

```ts
const forceRequested = job.payload_json.force === true;
let eligibilityOk = true;
let eligibilityReasons: string[] = [];
let imageTag: string;
if (deployment.mechanism === "github_actions_jobs") {
  const allowlistEntry = findAllowlistEntry(project.slug, project);
  if (forceRequested && !allowlistEntry?.allowForce) {
    await persistJobResult(db, job.id, { outcome: "refused", refusal_code: "force_not_allowed" });
    await audit(db, job, actorId, "deployment.promote", "project", projectId, { outcome: "refused", refusal_code: "force_not_allowed" });
    return;
  }
  const actionsStatus = await fetchActionsPreflightStatus(project, deployment);
  eligibilityOk = actionsStatus.preflight.eligible;
  eligibilityReasons = actionsStatus.preflight.reasons;
  imageTag = actionsStatus.imageTag;
  if (!forceRequested && actionsStatus.production && actionsStatus.production.sha !== commitSha) {
    // Non-fast-forward is only expected/allowed via the explicit force path;
    // if production is diverged and force wasn't requested, refuse before
    // ever attempting the PATCH so the UI can show the recovery flow instead
    // of a generic ref_update_failed.
    const comparison = await compareCommits(project.github_owner, project.github_repository, deployment.production_branch, commitSha).catch(() => null);
    if (comparison?.status === "diverged") {
      await persistJobResult(db, job.id, { outcome: "refused", refusal_code: "diverged_confirmation_required", production_sha: actionsStatus.production.sha });
      await audit(db, job, actorId, "deployment.promote", "project", projectId, { outcome: "refused", refusal_code: "diverged_confirmation_required" });
      return;
    }
  }
} else {
  const live = await fetchLiveDeploymentStatus(project, deployment); // existing path, unchanged
  const eligibility = evaluatePromotionEligibility({ ciState: live.ciStatus.overallState, imageExists: live.image.exists, e2eGateRequired: deployment.promotion.require_e2e_gate_label, e2eGateSatisfied: live.e2eGateSatisfied });
  eligibilityOk = eligibility.eligible; eligibilityReasons = eligibility.reasons; imageTag = live.imageTag;
}
if (!eligibilityOk) {
  await persistJobResult(db, job.id, { outcome: "refused", refusal_code: "not_eligible", reasons: eligibilityReasons });
  await audit(db, job, actorId, "deployment.promote", "project", projectId, { outcome: "refused", reasons: eligibilityReasons });
  return;
}
```

This restructures the existing eligibility block into an `if/else` rather than deleting the `health_check` path — read the original `:343-352` carefully and confirm every existing variable name (`live`, `eligibility`) it produced is still supplied to the code that follows (the `production_releases` INSERT already uses `live.imageTag`; change that to the new shared `imageTag` variable).

Then, for the ref-write section (`:376-398`), change the hardcoded `false` to the payload-driven `force`, and rewrite the catch block to classify non-fast-forward instead of a blanket rethrow:

```ts
try {
  await updateBranchReference(project.github_owner, project.github_repository, deployment.production_branch, commitSha, forceRequested);
} catch (error) {
  const nonFastForward = error instanceof GitHubProviderError && (error as any).nonFastForward === true;
  await db.query(
    `UPDATE production_releases SET status='failed', failure_reason=$2, non_fast_forward=$3, forced=$4, updated_at=now() WHERE id=$1`,
    [releaseId, error instanceof Error ? error.message : String(error), nonFastForward, forceRequested],
  );
  await persistJobResult(db, job.id, { outcome: "refused", refusal_code: nonFastForward ? "non_fast_forward" : "ref_update_failed", error: error instanceof Error ? error.message : String(error) });
  await audit(db, job, actorId, "deployment.promote", "project", projectId, { outcome: "refused", refusal_code: nonFastForward ? "non_fast_forward" : "ref_update_failed" });
  // IMPORTANT: do not rethrow. The original code rethrew here, which
  // propagates to the worker's retry machinery (enqueueJob defaults
  // max_attempts to 3, packages/domain/src/index.ts:206) — the whole point
  // of this task is that a 422/non-fast-forward must NOT auto-retry. The
  // route in Task 8b additionally passes maxAttempts:1 at enqueue time as a
  // second, independent safeguard for this specific job type.
  return;
}
// Post-write ref verification — re-read the ref rather than trusting the PATCH response body.
const verifyRead = await getBranchHeadCommit(project.github_owner, project.github_repository, deployment.production_branch).catch(() => null);
if (verifyRead?.sha !== commitSha) {
  await db.query(`UPDATE production_releases SET status='failed', failure_reason='ref_verify_failed — ref did not read back as the target SHA', updated_at=now() WHERE id=$1`, [releaseId]);
  await persistJobResult(db, job.id, { outcome: "failed", refusal_code: "ref_verify_failed" });
  await audit(db, job, actorId, "deployment.promote", "project", projectId, { outcome: "failed", refusal_code: "ref_verify_failed" });
  return;
}
await db.query(`UPDATE production_releases SET status='pending_approval', forced=$2, updated_at=now() WHERE id=$1`, [releaseId, forceRequested]);
```

The rest of the function (audit + `persistJobResult({outcome:"requested",...})`) stays as-is, using `imageTag` in place of `live.imageTag`.

- [ ] **Step 5: Run tests to verify they pass, then the full worker suite**

Run: `pnpm test:unit -- apps/worker`
Expected: PASS, including every pre-existing test in `provider-jobs.deployment.test.ts` (the `else` branches must reproduce the original behavior exactly).

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/provider-jobs.ts apps/worker/src/provider-jobs.deployment.test.ts
git commit -m "feat: extend deployment worker jobs with the github_actions_jobs mechanism, force-promote, and ref verification"
```

---

### Task 8b: Post-promotion production workflow tracking (extend `deployment.sync_status`)

**Files:**
- Modify: `apps/worker/src/provider-jobs.ts` (`deployment.sync_status`, the `github_actions_jobs` branch added in Task 8)

**Interfaces:**
- Consumes: `findWorkflowRun`, `getWorkflowRunJobs` (Task 2).
- Produces: `deployment_status_snapshots.production_workflow_run_id`, `.production_workflow_conclusion`, `.migrations_job_conclusion`, `.deploy_job_conclusion` populated once a release is in flight or recently completed — consumed by Task 11 (UI).

- [ ] **Step 1: Write the failing test**

```ts
test("sync_status (github_actions_jobs mechanism) tracks the production-branch run's migrations/deploy jobs distinctly from the master run at the same SHA", async () => {
  // Arrange: findWorkflowRun mock is called twice with different args — once
  // with {branch: project.default_branch, event:'push'} for master, once with
  // {branch: deployment.production_branch, event:'push', createdAfter: <the
  // in-flight release's created_at>} for production — return two DIFFERENT
  // run ids even though both mock commits share the same SHA. getWorkflowRunJobs
  // for the production run returns migrations-production:"success",
  // deploy-production:"in_progress".
  // Act: runProviderJob({type:"deployment.sync_status", ...}).
  // Assert: the snapshot UPDATE includes production_workflow_run_id equal to
  // the SECOND run's id (not the master run's id), migrations_job_conclusion:"success",
  // deploy_job_conclusion: null (job not yet concluded while in_progress).
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- apps/worker`
Expected: FAIL.

- [ ] **Step 3: Implement**

Extend the `github_actions_jobs` branch of `deployment.sync_status` (added in Task 8's step 4b) to also look up a production-branch run, only when there's a release row to anchor `createdAfter` against (avoids matching a stale run from a much earlier promotion at the same SHA, per the Global Constraints):

```ts
if (deployment.mechanism === "github_actions_jobs") {
  const actionsStatus = await fetchActionsPreflightStatus(project, deployment);
  const recentRelease = (await db.query(
    `SELECT * FROM production_releases WHERE project_id=$1 AND action='promote' AND status IN ('pending_approval','deploying','healthy') ORDER BY created_at DESC LIMIT 1`,
    [projectId],
  )).rows[0];
  let productionRun = null, productionJobs: Awaited<ReturnType<typeof getWorkflowRunJobs>> = [];
  if (recentRelease) {
    productionRun = await findWorkflowRun(project.github_owner, project.github_repository, {
      sha: recentRelease.commit_sha, branch: deployment.production_branch, event: "push", createdAfter: recentRelease.created_at,
    });
    if (productionRun) productionJobs = await getWorkflowRunJobs(project.github_owner, project.github_repository, productionRun.id);
  }
  const migrationsJob = productionJobs.find((j) => j.name === deployment.actions!.migrations_job_name);
  const deployJob = productionJobs.find((j) => j.name === deployment.actions!.deploy_job_name);
  await db.query(
    `INSERT INTO deployment_status_snapshots (project_id, master_commit_sha, master_workflow_run_id, master_workflow_conclusion, docker_image_job_conclusion, ghcr_checked, ghcr_verified, image_tag, production_commit_sha, divergence, production_workflow_run_id, production_workflow_conclusion, migrations_job_conclusion, deploy_job_conclusion, fetched_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,true,$6,$7,$8,$9,$10,$11,$12,$13,now(),now())
     ON CONFLICT (project_id) DO UPDATE SET master_commit_sha=$2, master_workflow_run_id=$3, master_workflow_conclusion=$4, docker_image_job_conclusion=$5, ghcr_checked=true, ghcr_verified=$6, image_tag=$7, production_commit_sha=$8, divergence=$9, production_workflow_run_id=$10, production_workflow_conclusion=$11, migrations_job_conclusion=$12, deploy_job_conclusion=$13, fetched_at=now(), updated_at=now()`,
    [projectId, actionsStatus.master.sha, actionsStatus.masterRun?.id ?? null, actionsStatus.masterRun?.conclusion ?? null,
     actionsStatus.preflight.dockerImageJobConclusion, actionsStatus.ghcr.state === "exists" ? true : actionsStatus.ghcr.state === "not_exists" ? false : null,
     actionsStatus.imageTag, actionsStatus.production?.sha ?? null, actionsStatus.divergence,
     productionRun?.id ?? null, productionRun?.conclusion ?? null, migrationsJob?.conclusion ?? null, deployJob?.conclusion ?? null],
  );
  // Reuse the existing in-flight release status machinery (:263-283) but drive
  // "nowLive"/"deploying"/"failed" from the two named job conclusions instead
  // of an HTTP health check, when a release is in flight.
  if (recentRelease && recentRelease.status !== "healthy") {
    const bothSucceeded = migrationsJob?.conclusion === "success" && deployJob?.conclusion === "success";
    const eitherFailed = migrationsJob?.conclusion === "failure" || deployJob?.conclusion === "failure" || migrationsJob?.conclusion === "cancelled" || deployJob?.conclusion === "cancelled";
    const stalled = !bothSucceeded && !eitherFailed && Date.now() - new Date(recentRelease.updated_at).getTime() > 15 * 60 * 1000;
    const nextStatus = bothSucceeded ? "healthy" : eitherFailed ? "failed" : stalled ? "failed" : "deploying";
    await db.query(
      `UPDATE production_releases SET status=$2, production_workflow_run_id=$3, health_checked_at=now(), updated_at=now()${stalled ? ",failure_reason='stalled — production workflow jobs did not resolve within 15 minutes'" : eitherFailed ? ",failure_reason='migrations-production or deploy-production job failed'" : ""} WHERE id=$1`,
      [recentRelease.id, nextStatus, productionRun?.id ?? null],
    );
  }
  await persistJobResult(db, job.id, { outcome: "synced", mechanism: "github_actions_jobs", ...actionsStatus, production_run: productionRun, migrations_job_conclusion: migrationsJob?.conclusion ?? null, deploy_job_conclusion: deployJob?.conclusion ?? null });
  return;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:unit -- apps/worker`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/provider-jobs.ts apps/worker/src/provider-jobs.deployment.test.ts
git commit -m "feat: track production-branch migrations-production/deploy-production jobs distinctly from the master run"
```

---

### Task 9: `promote-force` route with independent re-verification

**Files:**
- Modify: `apps/web/src/server.ts` (near the existing `deploymentPromoteMatch` route, `:1272-1281`)
- Test: whichever existing test file covers the deployment routes (search `deploymentPromoteMatch` usage in test files first; extend it, or create `apps/web/src/production-promotion-routes.test.ts` if none covers this area yet)

**Interfaces:**
- Consumes: `findAllowlistEntry` (Task 6), `enqueueJob` (existing, `packages/domain/src/index.ts:192`).
- Produces: `POST /api/admin/projects/:id/deployment/promote-force`, enqueuing `deployment.promote` with `force: true`.

- [ ] **Step 1: Write the failing tests**

```ts
test("promote-force route is rejected for a project not on the production-promotion allowlist", async () => {
  // Arrange: a project row whose slug isn't in PRODUCTION_PROMOTION_ALLOWLIST.
  // Act: POST /api/admin/projects/:id/deployment/promote-force with a valid body.
  // Assert: 403, error mentions the project isn't eligible for forced promotion.
});

test("promote-force route requires confirm_diverged:true in the body", async () => {
  // Act: POST without confirm_diverged.
  // Assert: 400.
});

test("promote-force route enqueues deployment.promote with force:true and maxAttempts:1", async () => {
  // Act: POST with a valid 40-hex commit_sha, expected_master_sha, confirm_diverged:true,
  // for the va-jobs-platform project id.
  // Assert: the enqueued job's payload_json.force === true, and (read from the
  // jobs table row, or from a spy on enqueueJob if the route calls it directly
  // as an imported function — check which pattern the existing promote route
  // uses first) max_attempts === 1.
});

test("normal promote route (unchanged) still uses maxAttempts:1 too — 422 must never auto-retry regardless of force", async () => {
  // This locks in the fix from Task 8's step 4d for the ordinary (non-force) path as well.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:unit -- apps/web`
Expected: FAIL — route doesn't exist yet; existing `deployment.promote` enqueue call still uses the default `maxAttempts`.

- [ ] **Step 3: Implement**

First, update the *existing* promote route (`server.ts:1272-1281`) to pass `maxAttempts: 1` — this is a one-line addition to the existing `enqueueJob` call, needed regardless of force since Task 8 made the non-fast-forward catch non-rethrowing but the retry-prevention is defense-in-depth for any other thrown error in that handler:

```ts
const job = await enqueueJob({ type: "deployment.promote",
  payload: { project_id: project.id, actor_id: session.user_id, commit_sha: body.commit_sha, expected_master_sha: body.expected_master_sha },
  idempotencyKey: `g07:deployment.promote:${project.id}:${body.commit_sha}:${Math.floor(Date.now() / 3600000)}`,
  maxAttempts: 1 });
```

Then add the new route directly below it:

```ts
const deploymentPromoteForceMatch = url.pathname.match(/^\/api\/admin\/projects\/([0-9a-f-]+)\/deployment\/promote-force$/i);
if (deploymentPromoteForceMatch && request.method === "POST") {
  const project = (await pool.query("SELECT id, slug, config_json FROM projects WHERE id=$1", [deploymentPromoteForceMatch[1]])).rows[0];
  if (!project) return json(response, 404, { error: "project not found" });
  if (!project.config_json?.deployment?.enabled) return json(response, 404, { error: "project has no deployment configured" });
  const allowlistEntry = findAllowlistEntry(project.slug, project);
  if (!allowlistEntry?.allowForce) return json(response, 403, { error: "this project is not eligible for forced production promotion" });
  const body = await bodyOf(request);
  if (body.confirm_diverged !== true) return json(response, 400, { error: "confirm_diverged:true is required to force a diverged production branch" });
  if (typeof body.commit_sha !== "string" || !/^[0-9a-f]{40}$/.test(body.commit_sha)) return json(response, 400, { error: "commit_sha must be a 40-character hex SHA" });
  if (typeof body.expected_master_sha !== "string" || !/^[0-9a-f]{40}$/.test(body.expected_master_sha)) return json(response, 400, { error: "expected_master_sha must be a 40-character hex SHA" });
  const job = await enqueueJob({ type: "deployment.promote",
    payload: { project_id: project.id, actor_id: session.user_id, commit_sha: body.commit_sha, expected_master_sha: body.expected_master_sha, force: true },
    idempotencyKey: `g07:deployment.promote:${project.id}:${body.commit_sha}:force:${Math.floor(Date.now() / 3600000)}`,
    maxAttempts: 1 });
  return json(response, 202, { job });
}
```

Add the `findAllowlistEntry` import from `@dcc/domain` near the top of `server.ts`, matching the existing import style for other domain functions used in this file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:unit -- apps/web`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server.ts apps/web/src/*.test.ts
git commit -m "feat: add promote-force route with allowlist gating and no auto-retry"
```

---

### Task 10: Seed the `va-jobs-platform` project row

**Files:**
- Create: `packages/database/migrations/059_va_jobs_platform_project.sql`

**Interfaces:**
- Produces: a `projects` row with `slug='va-jobs-platform'`, `github_owner='dutchbase'`, `github_repository='va-jobs-platform'`, `default_branch='master'`, and `config_json.deployment` configured for the `github_actions_jobs` mechanism — consumed by every worker/route task above (they all do `SELECT * FROM projects WHERE id=$1` / join on slug).

- [ ] **Step 1: Check whether a `va-jobs-platform` row already exists in any real (non-test-fixture) environment**

Run: `psql "$DATABASE_URL" -c "SELECT id, slug, github_owner, github_repository, default_branch, repository_path FROM projects WHERE slug='va-jobs-platform' OR (github_owner='dutchbase' AND github_repository='va-jobs-platform')"` against whatever environment this migration will actually run in. If a row already exists with different values (e.g. a different `default_branch`), this migration must `UPDATE`, not `INSERT ... ON CONFLICT DO NOTHING` — adjust Step 2 accordingly and flag the discrepancy to the user before proceeding, since silently rewriting `github_owner`/`github_repository`/`default_branch` on an existing row is exactly the kind of surprising change this plan's constraints warn against.

- [ ] **Step 2: Write the migration**

```sql
-- packages/database/migrations/059_va_jobs_platform_project.sql
-- Idempotent upsert: if a va-jobs-platform project row already exists (by
-- slug), only its config_json.deployment block is set/merged — its
-- repository_path, name, and any other admin-configured fields are left
-- untouched. If no row exists, one is created with placeholder
-- repository_path/agent_start_path that must be filled in with a real local
-- clone path before planning/execution features (not this deployment
-- feature, which reads production/master SHAs live from the GitHub API, not
-- from a local clone) are used for this project.
INSERT INTO projects (id, slug, name, github_owner, github_repository, default_branch, repository_path, config_json, health_status)
VALUES (
  gen_random_uuid(), 'va-jobs-platform', 'VA Jobs Platform', 'dutchbase', 'va-jobs-platform', 'master',
  '/PLACEHOLDER/set-a-real-local-clone-path-for-va-jobs-platform',
  jsonb_build_object(
    'deployment', jsonb_build_object(
      'enabled', true,
      'mechanism', 'github_actions_jobs',
      'production_branch', 'production',
      'image', jsonb_build_object('registry', 'ghcr.io', 'repository', 'dutchbase/va-jobs-platform', 'tag_template', 'sha-{{commit}}'),
      'promotion', jsonb_build_object('require_e2e_gate_label', false),
      'actions', jsonb_build_object(
        'docker_image_job_name', 'docker-image',
        'migrations_job_name', 'migrations-production',
        'deploy_job_name', 'deploy-production'
      )
    )
  ),
  'unknown'
)
ON CONFLICT (slug) DO UPDATE SET
  config_json = projects.config_json || jsonb_build_object(
    'deployment', jsonb_build_object(
      'enabled', true,
      'mechanism', 'github_actions_jobs',
      'production_branch', 'production',
      'image', jsonb_build_object('registry', 'ghcr.io', 'repository', 'dutchbase/va-jobs-platform', 'tag_template', 'sha-{{commit}}'),
      'promotion', jsonb_build_object('require_e2e_gate_label', false),
      'actions', jsonb_build_object(
        'docker_image_job_name', 'docker-image',
        'migrations_job_name', 'migrations-production',
        'deploy_job_name', 'deploy-production'
      )
    )
  ),
  github_owner = 'dutchbase', github_repository = 'va-jobs-platform', default_branch = 'master';
```

Before finalizing, confirm `projects.slug` actually has a `UNIQUE` constraint (needed for `ON CONFLICT (slug)`) — check `packages/database/migrations/` for the original `CREATE TABLE projects` migration. If `repository_path` has a `NOT NULL` constraint (also confirm from the original table definition), the placeholder string above satisfies it; if it does not, consider using `NULL` instead of a placeholder to more honestly represent "not configured" — pick whichever the constraint requires and document the choice in a one-line comment.

- [ ] **Step 3: Run the migration and verify**

Run the project's migration command; then `psql ... -c "SELECT slug, config_json->'deployment' FROM projects WHERE slug='va-jobs-platform'"` and confirm the JSON matches.

- [ ] **Step 4: Commit**

```bash
git add packages/database/migrations/059_va_jobs_platform_project.sql
git commit -m "feat: seed va-jobs-platform project with github_actions_jobs deployment config"
```

**Manual/deploy action required (record this in the INDEX.md deploy notes):** the placeholder `repository_path` must be replaced with a real path to a local clone of `dutchbase/va-jobs-platform` on the dev-control host if any *other* dev-control feature for this project (planning, execution, the generic "Merge branches" branch-preview dropdown) is ever wanted — this specific Production-tab feature does not need it, since Task 8's `fetchActionsPreflightStatus` reads master/production SHAs live from the GitHub API.

---

### Task 11: Production tab UI on `/admin/merge`

**Files:**
- Modify: `apps/web/src/pages/merge.ts`
- Modify: `apps/web/src/ui.ts`

**Interfaces:**
- Consumes: `GET /api/admin/projects/:id/deployment`, `POST /api/admin/projects/:id/deployment/sync`, `POST /api/admin/projects/:id/deployment/promote-check`, `POST /api/admin/projects/:id/deployment/promote`, `POST /api/admin/projects/:id/deployment/promote-force` (Tasks 8, 9) — all pre-existing routes except the last.

- [ ] **Step 1: Wrap `merge.ts`'s existing body in a top-level tablist**

Read the full current `render()` function in `apps/web/src/pages/merge.ts` (reproduced in this plan's Architecture section) and restructure it. The existing single-card body becomes panel 0; a new Production panel becomes panel 1. Follow the exact `id="tab-${index}"`/`id="panel-${index}"` convention already used on `/admin/projects/:slug` (`projects.ts:160`) — since this is a *different page*, reusing `tab-0`/`tab-1` here does not collide with that page's own `tab-0`. Fetch the `va-jobs-platform` project id server-side (needed to build the `data-project-id` attribute the client script reads, exactly as `projects.ts:32` does for the existing Deployment tab):

```ts
import { pool } from "@dcc/database";
import { escapeHtml } from "./shared.ts";
import type { PageResult, Session } from "./shared.ts";

export async function render(url: URL, _session: Session, _metrics: Record<string, number>): Promise<PageResult | null> {
  if (url.pathname !== "/admin/merge") return null;
  const projects = (await pool.query(
    `SELECT id, name, default_branch FROM projects
     WHERE github_owner IS NOT NULL AND github_repository IS NOT NULL AND repository_path IS NOT NULL
     ORDER BY name`,
  )).rows;
  const vaJobsPlatform = (await pool.query(`SELECT id, config_json FROM projects WHERE slug='va-jobs-platform'`)).rows[0];

  const projectOptions = projects.map((project: any) =>
    `<option value="${escapeHtml(project.id)}" data-default-branch="${escapeHtml(project.default_branch ?? "master")}">${escapeHtml(project.name)}</option>`).join("");

  const mergeBranchesPanel = `<section class="card"><div class="card-body" style="display:flex;flex-direction:column;gap:14px;max-width:640px">
    <label class="field"><span>Project</span>
      <select id="merge-project" ${projects.length ? "" : "disabled"}>
        <option value="">${projects.length ? "Select a project…" : "No GitHub-connected projects configured"}</option>
        ${projectOptions}
      </select>
    </label>
    <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:10px;align-items:end">
      <label class="field"><span>From (head)</span><select id="merge-from" disabled><option value="">Select a project first</option></select></label>
      <span style="padding-bottom:10px;color:var(--text3)">→</span>
      <label class="field"><span>Into (base)</span><select id="merge-into" disabled><option value="">Select a project first</option></select></label>
    </div>
    <div style="display:flex;gap:10px;align-items:stretch">
      <div data-merge-status role="status" style="flex:1;border:1px solid var(--border);border-left:3px solid var(--border2);border-radius:5px;padding:11px 14px;font-size:13.5px;color:var(--text2)">
        Select a project to list its branches.
      </div>
      <button class="button" type="button" data-merge-retry hidden>Retry</button>
    </div>
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <button class="button primary" type="button" data-merge-button disabled>Merge</button>
      <button class="button" type="button" data-create-pr-button disabled>Create PR</button>
      <span data-merge-reason style="font-size:13px;color:var(--text3)"></span>
    </div>
  </div></section>
  <section class="card"><div class="card-head">How this works</div><div class="card-body" style="font-size:13px;color:var(--text2)">
    Branches are read live from GitHub via the local clone. Before the buttons
    unlock, a dry-run merge computes whether it would apply cleanly, conflict,
    or is already up to date — each button stays disabled with the reason shown
    whenever its action isn't possible. <strong>Merge</strong> applies head → base
    directly on GitHub (no pull request). <strong>Create PR</strong> opens a pull request
    for the same pair instead — it stays available even when a direct merge
    would conflict or needs review, because GitHub flags those on the PR.
  </div></section>`;

  const productionPanel = vaJobsPlatform ? `
    <div class="tabs" role="tablist">${["VA Jobs Platform"].map((label, index) =>
      `<button type="button" role="tab" id="prod-tab-${index}" aria-controls="prod-panel-${index}" aria-selected="${index === 0}">${label}</button>`).join("")}</div>
    <div role="tabpanel" id="prod-panel-0" aria-labelledby="prod-tab-0">
      <section class="card">
        <div class="card-head">Repository <button class="button" type="button" data-refresh-production-promotion>Refresh</button></div>
        <div class="card-body" data-production-promotion-status data-project-id="${vaJobsPlatform.id}">
          <p style="color:var(--text3);font-size:13px">Loading…</p>
        </div>
      </section>
      <section class="card">
        <div class="card-head">Pre-flight</div>
        <div class="card-body" data-production-promotion-preflight>
          <p style="color:var(--text3);font-size:13px">Loading…</p>
        </div>
      </section>
      <section class="card">
        <div class="card-head">Deploy</div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:10px">
          <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
            <button class="button primary" type="button" data-production-promote-button disabled>Deploy to production</button>
            <button class="button" type="button" data-production-promote-retry hidden>Retry</button>
            <span data-production-promote-reason style="font-size:13px;color:var(--text3)"></span>
          </div>
        </div>
      </section>
      <section class="card" data-production-diverged-warning hidden>
        <div class="card-head" style="color:var(--t-danger)">Production cannot be fast-forwarded</div>
        <div class="card-body">
          <p>Production has diverged from master and cannot be moved through a normal fast-forward.</p>
          <p>Current production: <code data-diverged-production-sha></code></p>
          <p>Master: <code data-diverged-master-sha></code></p>
          <p>Recovering it will forcibly re-point <code>production</code> to the verified master commit.</p>
          <button class="button danger" type="button" data-production-force-button>Force production to master</button>
        </div>
      </section>
      <section class="card">
        <div class="card-head">Production deployment</div>
        <div data-production-promotion-progress><p style="color:var(--text3);font-size:13px">No deployment in progress.</p></div>
      </section>
      <dialog data-production-promote-dialog>
        <h3>Deploy VA Jobs Platform to production</h3>
        <p><code data-production-promote-dialog-sha></code></p>
        <p data-production-promote-dialog-message></p>
        <p>This commit will become the production version.</p>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="button" type="button" data-production-promote-dialog-cancel>Cancel</button>
          <button class="button primary" type="button" data-production-promote-dialog-confirm>Deploy to production</button>
        </div>
      </dialog>
      <dialog data-production-force-dialog>
        <h3>Force production to master — this cannot be undone</h3>
        <p>Production will be forcibly re-pointed to <code data-production-force-dialog-sha></code>, discarding whatever commit(s) production currently points to that aren't on master.</p>
        <label class="field"><span>Type the target commit's short SHA to confirm</span><input type="text" data-production-force-dialog-input></label>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="button" type="button" data-production-force-dialog-cancel>Cancel</button>
          <button class="button danger" type="button" data-production-force-dialog-confirm disabled>Force production</button>
        </div>
      </dialog>
    </div>` : `<section class="card"><div class="card-body"><p style="color:var(--text3)">VA Jobs Platform is not configured yet — run migration 059.</p></div></section>`;

  const tabLabels = ["Merge branches", "Production"];
  const panelContents = [mergeBranchesPanel, productionPanel];
  const body = `<div class="eyebrow">Work / merge branches</div><h1>Merge branches</h1>
    <div class="tabs" role="tablist">${tabLabels.map((label, index) => `<button type="button" role="tab" id="tab-${index}" aria-controls="panel-${index}" aria-selected="${index === 0}">${label}</button>`).join("")}</div>
    ${panelContents.map((content, index) => `<div role="tabpanel" id="panel-${index}" aria-labelledby="tab-${index}"${index === 0 ? "" : " hidden"}>${content}</div>`).join("")}`;
  return { status: 200, title: "Merge branches", body };
}
```

Note the nested tablist inside `productionPanel` uses `prod-tab-0`/`prod-panel-0` ids — distinct from the outer `tab-0`/`tab-1` — so both tablists on this single page work independently via the existing global handler (`ui.ts:76-90`, confirmed in this plan's investigation to iterate `document.querySelectorAll("[role=tablist]")` and resolve panels by `id`, with no assumption that only one tablist exists per page).

- [ ] **Step 2: Add client-side wiring in `ui.ts`**

Find the existing `${path==="/admin/merge"?...}` block (`ui.ts:667+`) and add a new IIFE inside it, immediately after the existing merge-branches wiring, following the exact `pollJob`/dialog/csrf conventions already used by `initDeploymentTab()` (`ui.ts:404-504`, reproduced in this plan's Architecture section):

```js
(function initProductionPromotion(){
  const statusEl=document.querySelector("[data-production-promotion-status]");
  if(!statusEl)return;
  const projectId=statusEl.dataset.projectId;
  const preflightEl=document.querySelector("[data-production-promotion-preflight]");
  const progressEl=document.querySelector("[data-production-promotion-progress]");
  const promoteButton=document.querySelector("[data-production-promote-button]");
  const promoteRetry=document.querySelector("[data-production-promote-retry]");
  const promoteReason=document.querySelector("[data-production-promote-reason]");
  const dialog=document.querySelector("[data-production-promote-dialog]");
  const divergedWarning=document.querySelector("[data-production-diverged-warning]");
  const forceButton=document.querySelector("[data-production-force-button]");
  const forceDialog=document.querySelector("[data-production-force-dialog]");
  let lastCheck=null;

  async function pollJob(jobId,maxMs){
    for(let i=0;i<Math.ceil(maxMs/700);i++){
      await new Promise(r=>setTimeout(r,i===0?300:700));
      const payload=await fetch("/api/admin/jobs/"+jobId,{headers:{"x-csrf-token":csrf}}).then(r=>r.json()).catch(()=>null);
      const job=payload&&payload.job;if(!job)continue;
      if(["completed","failed","cancelled","blocked_auth","blocked_auth_configuration"].includes(job.status))return job;
    }
    return null;
  }

  async function loadStatus(){
    const data=await fetch("/api/admin/projects/"+projectId+"/deployment",{headers:{"x-csrf-token":csrf}}).then(r=>r.json());
    const snapshot=data.snapshot;
    if(!snapshot){statusEl.innerHTML="<p>No status yet — click Refresh.</p>";return;}
    statusEl.innerHTML='<p>Master: <code>'+snapshot.master_commit_sha.slice(0,8)+'</code></p>'
      +'<p>Production: <code>'+(snapshot.production_commit_sha?snapshot.production_commit_sha.slice(0,8):"unknown")+'</code></p>'
      +'<p>Status: '+({up_to_date:"Already deployed",behind_master:"Ready to deploy",diverged:"Diverged — needs recovery",unavailable:"Unavailable"}[snapshot.divergence]||snapshot.divergence)+'</p>';
    if(snapshot.divergence==="diverged"){
      divergedWarning.hidden=false;
      divergedWarning.querySelector("[data-diverged-production-sha]").textContent=(snapshot.production_commit_sha||"").slice(0,8);
      divergedWarning.querySelector("[data-diverged-master-sha]").textContent=snapshot.master_commit_sha.slice(0,8);
    } else divergedWarning.hidden=true;
    renderProgress(data.releases);
  }

  function renderProgress(releases){
    const active=releases.find(r=>r.action==="promote"&&["pending_approval","deploying"].includes(r.status));
    if(!active){progressEl.innerHTML='<p style="color:var(--text3);font-size:13px">No deployment in progress.</p>';return;}
    progressEl.innerHTML='<p>Deploying <code>'+active.commit_sha.slice(0,8)+'</code> — '+active.status+'</p>'
      +(active.production_workflow_run_id?'<p><a href="https://github.com/dutchbase/va-jobs-platform/actions/runs/'+active.production_workflow_run_id+'" target="_blank" rel="noopener">View on GitHub →</a></p>':'');
  }

  async function runPreflight(){
    promoteButton.disabled=true;promoteRetry.hidden=true;promoteReason.textContent="Checking preconditions…";
    try{
      const queued=await fetch("/api/admin/projects/"+projectId+"/deployment/promote-check",{method:"POST",headers:{"x-csrf-token":csrf}});
      const {job}=await queued.json();
      const done=await pollJob(job.id,20000);
      if(!done||done.status!=="completed"){promoteReason.textContent="Pre-flight check timed out — try again.";promoteRetry.hidden=false;return;}
      lastCheck=done.result_json;
      preflightEl.innerHTML='<p>Master workflow: '+(lastCheck.reasons.includes("master_workflow_failed")?"Failed":lastCheck.reasons.includes("master_workflow_not_found")?"Not found":lastCheck.reasons.includes("master_workflow_pending")?"Pending":"Passed")+'</p>'
        +'<p>docker-image: '+(lastCheck.reasons.includes("docker_image_job_missing")?"Missing":lastCheck.reasons.includes("docker_image_job_failed")?"Failed":lastCheck.reasons.includes("docker_image_job_pending")?"Pending":"Passed")+'</p>';
      if(lastCheck.divergence==="up_to_date"){promoteButton.disabled=true;promoteButton.textContent="Already in production";promoteReason.textContent="Production is already on this commit.";}
      else if(lastCheck.eligible){promoteButton.disabled=false;promoteButton.textContent="Deploy to production";promoteReason.textContent="Ready: "+lastCheck.master_sha.slice(0,8);}
      else{promoteButton.disabled=true;promoteReason.textContent=lastCheck.reasons.join(", ");}
    }catch(error){promoteReason.textContent="Pre-flight failed: "+error.message;promoteRetry.hidden=false;}
  }

  promoteRetry.addEventListener("click",runPreflight);
  promoteButton.addEventListener("click",()=>{
    if(!lastCheck||!lastCheck.eligible)return;
    dialog.querySelector("[data-production-promote-dialog-sha]").textContent=lastCheck.master_sha.slice(0,8);
    dialog.querySelector("[data-production-promote-dialog-message]").textContent=lastCheck.master_commit_message||"";
    dialog.showModal();
  });
  dialog.querySelector("[data-production-promote-dialog-cancel]").addEventListener("click",()=>dialog.close());
  dialog.querySelector("[data-production-promote-dialog-confirm]").addEventListener("click",async()=>{
    dialog.close();
    promoteButton.disabled=true;promoteReason.textContent="Deploying…";
    const queued=await fetch("/api/admin/projects/"+projectId+"/deployment/promote",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({commit_sha:lastCheck.master_sha,expected_master_sha:lastCheck.master_sha})});
    const body=await queued.json().catch(()=>({}));
    if(!queued.ok){promoteReason.textContent="Could not start deployment: "+(body.error||queued.status);return;}
    const done=await pollJob(body.job.id,20000);
    const result=done&&done.result_json;
    if(result&&result.refusal_code==="diverged_confirmation_required"){promoteReason.textContent="Production has diverged — use the force-recovery option below.";loadStatus();return;}
    promoteReason.textContent=result?("Deployment "+result.outcome):"Deployment status unknown — refresh to check.";
    loadStatus();
  });

  forceButton.addEventListener("click",()=>{
    if(!lastCheck)return;
    forceDialog.querySelector("[data-production-force-dialog-sha]").textContent=lastCheck.master_sha.slice(0,8);
    const input=forceDialog.querySelector("[data-production-force-dialog-input]");
    const confirmBtn=forceDialog.querySelector("[data-production-force-dialog-confirm]");
    input.value="";confirmBtn.disabled=true;
    input.oninput=()=>{confirmBtn.disabled=input.value.trim()!==lastCheck.master_sha.slice(0,8);};
    forceDialog.showModal();
  });
  forceDialog.querySelector("[data-production-force-dialog-cancel]").addEventListener("click",()=>forceDialog.close());
  forceDialog.querySelector("[data-production-force-dialog-confirm]").addEventListener("click",async()=>{
    forceDialog.close();
    promoteReason.textContent="Forcing production…";
    const queued=await fetch("/api/admin/projects/"+projectId+"/deployment/promote-force",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({commit_sha:lastCheck.master_sha,expected_master_sha:lastCheck.master_sha,confirm_diverged:true})});
    const body=await queued.json().catch(()=>({}));
    if(!queued.ok){promoteReason.textContent="Could not force: "+(body.error||queued.status);return;}
    const done=await pollJob(body.job.id,20000);
    const result=done&&done.result_json;
    promoteReason.textContent=result?("Forced deployment "+result.outcome):"Status unknown — refresh to check.";
    loadStatus();
  });

  document.querySelectorAll("[data-refresh-production-promotion]").forEach(btn=>btn.addEventListener("click",()=>fetch("/api/admin/projects/"+projectId+"/deployment/sync",{method:"POST",headers:{"x-csrf-token":csrf}}).then(()=>setTimeout(loadStatus,1500))));

  loadStatus();
  runPreflight();
})();
```

- [ ] **Step 3: Manually verify in a dev environment**

Start the app locally (check root `package.json` for the dev script), navigate to `/admin/merge`, confirm: the `Merge branches` tab looks and behaves exactly as before; the `Production` tab shows the nested `VA Jobs Platform` tab; status/pre-flight/deploy render without console errors (network calls will fail against a real GitHub API without valid credentials/a real repo — that's expected in local dev; confirm the failure is handled gracefully, not a blank page or unhandled exception).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/merge.ts apps/web/src/ui.ts
git commit -m "feat: add Production tab to the Merge branches page for VA Jobs Platform"
```

---

### Task 12: Regression and integration test sweep

**Files:**
- Create or modify a DOM-stub test file for `/admin/merge` (check for an existing one first, e.g. search for `"admin/merge"` across `*.test.ts` files; the investigation found `merge-page-wiring.test.ts` may already exist for the pre-existing merge script — extend it rather than duplicating if so).
- Modify: `tests/e2e/visual-sweep.spec.ts` if it exists and already sweeps `/admin/merge` (search for the route string first).

**Interfaces:**
- Consumes: everything built in Tasks 1-11.

- [ ] **Step 1: Write/extend the DOM-stub test for `/admin/merge`**

Follow whatever pattern the existing merge-page test (or `responsive-layout.test.ts`'s general approach for other pages) uses — likely a JSDOM-lite stub of `document`/`fetch` exercising the raw script string exported from `ui.ts`. Add cases:

```ts
test("existing merge-branches DOM elements and event listeners are still wired after the Production tab is added", () => {
  // Assert the script still queries #merge-project, [data-merge-button], etc.,
  // and that adding initProductionPromotion() doesn't throw when the
  // production-tab elements ARE present (this page's real markup) nor when
  // they're absent (defensive: initProductionPromotion returns early via its
  // `if(!statusEl)return` guard, mirroring initDeploymentTab's own guard).
});

test("merge.ts renders both a Merge branches tab and a Production tab with VA Jobs Platform nested inside", () => {
  // Render merge.ts's exported render() against a stubbed pool query result
  // including a va-jobs-platform row; assert the HTML contains both top-level
  // tab labels and the nested "VA Jobs Platform" tab.
});

test("merge.ts still renders correctly when va-jobs-platform is not yet configured (pre-migration-059 state)", () => {
  // Stub the pool query to return no va-jobs-platform row; assert the
  // Production tab shows the "not configured yet" fallback instead of throwing.
});
```

- [ ] **Step 2: Run the full test suite**

Run: `pnpm verify` (or the two-step `tsc --noEmit && vitest run` if that's the real script name — confirm from root `package.json`).
Expected: PASS, zero regressions across the whole repo.

- [ ] **Step 3: Manually confirm no horizontal overflow on `/admin/merge`**

If `tests/e2e/visual-sweep.spec.ts` already sweeps `/admin/merge` for overflow (search for the route string in that file first), no action needed beyond letting it run. If it doesn't cover this route yet, that's out of scope for this plan (a pre-existing gap, not introduced by this change) — do not expand the e2e sweep's route list as part of this plan.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "test: regression coverage for the Production tab and unchanged Merge branches behavior"
```

---

## Self-review notes (for the plan author, not the executor)

- Every requirement from the task's exhaustive test list (master/production SHA resolution, exact master-push run selection vs PR/unrelated runs, docker-image job gating in all four states, stale-master invalidation, force:false/exact-SHA/no-merge-commit/no-merge-API invariants, non-fast-forward non-auto-force, force-confirmation requirement, forced-recovery-only-targets-verified-master, post-promotion ref verification, production-run-selected-by-branch-and-SHA, migrations/deploy job surfacing, success-only-after-workflow-succeeds, permission/API-failure handling, duplicate-submission prevention) maps to a task above: SHA resolution → Task 8's `fetchActionsPreflightStatus`; exact run selection → Task 2 + Task 8b; job gating → Task 7; stale-master → pre-existing `master_moved`/`commit_not_master` checks (unchanged, re-tested in Task 8); force invariants → Task 8's step 4d + Task 9; ref verification → Task 8 step 4d; production run tracking → Task 8b; success-only-after-workflow → Task 8b's `bothSucceeded` gate; permission/API failures → `GitHubProviderError` propagation (unchanged existing pattern) surfaced via the existing job-failure UI path; duplicate prevention → the pre-existing `production_releases_project_inflight_idx` (unchanged, still applies to this mechanism since it's the same table).
- Known residual risk, intentionally out of scope for this plan (do not fix as a drive-by): `apps/web/src/pages/projects.ts:127-136` renders a "Merge branches" panel on the va-jobs-platform project's own Overview tab whose help text says "Use to promote master into staging/production" and which goes through `mergeBranch()` (a real merge commit) — this is a pre-existing, separate UI surface that could still be used to merge onto `production` the old way, bypassing this feature's safeguards. Flag this to the user as a follow-up ticket; do not touch `projects.ts` in this plan (the Global Constraints forbid modifying Merge-branches-adjacent behavior beyond what's explicitly scoped here).
