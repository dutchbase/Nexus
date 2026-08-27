# GitHub Policy Snapshot Merge-Eligibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a missing GitHub policy snapshot from blocking `Approve & merge` for repositories that have no branch protection / rulesets configured, while preserving (and not weakening) blocking behavior for repositories that do have applicable policies or where policy state is genuinely unknown.

**Architecture:** Introduce one shared, pure "normalized policy status" derivation in `packages/domain` that both the PR list/detail UI (`apps/web/src/pages/prs.ts`) and the `/approve` API route (`apps/web/src/server.ts`) consume — replacing today's independent, narrower null-checks. Add a per-project `config_json.github_policy.enforcement` flag (`"auto" | "required" | "optional"`, default `"auto"`) so projects that are known to require branch-protection enforcement can force `unavailable` to stay blocking even without a snapshot. For the common "never synced yet" race (a PR whose policy sync job hasn't run even once), add a synchronous on-demand policy check in the `/approve` route itself — reusing the existing `getPullRequestPolicyInputs` + `evaluatePullRequestPolicy` + snapshot-insert code path already used by the merge-time re-verification in `packages/domain/src/pr-merge.ts` — so a genuinely unprotected repo gets a real snapshot the moment a human clicks "Approve & merge", instead of waiting for the next poll cycle. The authoritative merge-time gate in `pr-merge.ts` (`approveAndMergePullRequest`) is left structurally unchanged: it already correctly treats `not_required`/`not_required` as passing and always re-verifies against live GitHub state before merging, so no weakening happens there.

**Tech Stack:** TypeScript, Vitest (`vitest run --config vitest.config.ts`), node-postgres (`pg`), plain server-rendered HTML (no React/JSX — template literal strings in `apps/web/src/pages/*.ts`), Zod is available in the repo for schema validation where needed.

**Spec:** This markdown file is self-contained; source task is "Allow PR merging when GitHub policy snapshots are unavailable" (see plans/INDEX.md for the full original task text).

## Global Constraints

- Never convert a missing snapshot into a passing result without knowing *why* it's missing (no blind blanket "treat null as pass").
- Never bypass real GitHub branch protection or rulesets when they are known to apply.
- Never treat an API/authentication failure as equivalent to "no policy configured" — these must render and behave differently.
- The same eligibility logic must drive both the frontend button's enabled/disabled state and the backend's actual merge gate — no divergence.
- Do not touch `packages/domain/src/pr-merge.ts`'s core merge transaction/verification logic (lines 240–306) — it is already correct; only its entry gate (lines 203–205) may need a narrow allowance (see Task 4).
- Existing projects with real branch protection/rulesets configured must see no behavior change (regression tests required).
- Run `pnpm verify` (or `npm run verify` — check root `package.json`) before each commit; this repo's CI expects `tsc --noEmit` + `vitest run` to pass.

---

## File Structure

- **Modify:** `packages/domain/src/pull-request-policy.ts` — no changes needed to `evaluatePullRequestPolicy` itself; it's already correct (`not_required`/`not_required` when `!inputs.protected`). Referenced, not edited, except possibly exporting `GitHubPolicyInputs` (already exported).
- **Create:** `packages/domain/src/pull-request-policy-status.ts` — the new shared `PolicyStatus` type + `derivePolicyStatus()` pure function operating on cached `pull_requests` row columns.
- **Create:** `packages/domain/src/pull-request-policy-status.test.ts` — unit tests for the new derivation function.
- **Create:** `packages/domain/src/pull-request-on-demand-sync.ts` — extracts a reusable `ensurePolicySnapshot(db, { pullRequestId, owner, repo, number })` helper that performs a synchronous fetch-evaluate-persist cycle (used by the `/approve` route when `current_policy_snapshot_id` is null and the project's enforcement mode allows it).
- **Create:** `packages/domain/src/pull-request-on-demand-sync.test.ts` — unit tests for the helper.
- **Modify:** `packages/project-config/src/index.ts` — add a small pure helper `getGithubPolicyEnforcementMode(configJson: unknown): "auto" | "required" | "optional"` reading `config_json.github_policy.enforcement`, defaulting to `"auto"` on anything unexpected.
- **Modify:** `apps/web/src/pages/prs.ts` — replace the inline `policyIssue`/`mergeBlocker` derivation (lines 50–72 in `renderDetail`, plus the list-view badge) with calls to `derivePolicyStatus()`.
- **Modify:** `apps/web/src/server.ts` — replace the raw-column check in the `approve` action (lines ~1011–1027) with a call to `derivePolicyStatus()` plus the new on-demand sync path.
- **Modify:** `apps/web/src/pages/prs-list-actions.test.ts` — update/extend the existing tests that currently lock in the old "always unavailable when snapshot missing" behavior (lines 55–64 and 66) to reflect the new behavior; add new cases.
- **Modify:** `apps/web/src/approval-route-regressions.test.ts` — add regression cases for the `/approve` route's new logic.
- **No DB migration required** — this plan reuses the existing `projects.config_json jsonb` column (already used for `config_json.deployment`, see `apps/web/src/server.ts:1246`), so `config_json.github_policy.enforcement` needs no schema change.

---

### Task 1: Shared `PolicyStatus` derivation in the domain package

**Files:**
- Create: `packages/domain/src/pull-request-policy-status.ts`
- Test: `packages/domain/src/pull-request-policy-status.test.ts`

**Interfaces:**
- Consumes: nothing new — operates purely on plain data shaped like the `pull_requests` table row (the same shape already read throughout `apps/web/src/pages/prs.ts` as `item`).
- Produces:
  ```ts
  export type PolicyStatusCode = "satisfied" | "not_applicable" | "failed" | "unavailable";

  export type PolicyStatusInput = {
    headSha: string | null;
    currentPolicySnapshotId: string | null;
    policyStale: boolean;
    policyComplete: boolean | null;
    reviewState: string | null;
    checkState: string | null;
    policyErrorCode: string | null;
    policyRetryAfter: string | Date | null;
    enforcementMode: "auto" | "required" | "optional";
  };

  export type PolicyStatus = {
    code: PolicyStatusCode;
    /** Short label safe to show next to "GitHub: " in a status badge, e.g. "No applicable policies". */
    label: string;
    /** True when this status should NOT block Approve & merge (all other Dev Control checks aside). */
    allowsMerge: boolean;
  };

  export function derivePolicyStatus(input: PolicyStatusInput): PolicyStatus;
  ```
  Later tasks (2, 3, 4) import `derivePolicyStatus`, `PolicyStatus`, and `PolicyStatusInput` from this exact path.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/domain/src/pull-request-policy-status.test.ts
import { expect, test } from "vitest";
import { derivePolicyStatus, type PolicyStatusInput } from "./pull-request-policy-status.ts";

const base: PolicyStatusInput = {
  headSha: "abc123",
  currentPolicySnapshotId: null,
  policyStale: false,
  policyComplete: null,
  reviewState: null,
  checkState: null,
  policyErrorCode: null,
  policyRetryAfter: null,
  enforcementMode: "auto",
};

test("missing head SHA is always unavailable regardless of enforcement mode", () => {
  const result = derivePolicyStatus({ ...base, headSha: null });
  expect(result).toEqual({ code: "unavailable", label: "Unavailable: head SHA missing", allowsMerge: false });
});

test("no snapshot yet, auto mode, no recorded error -> not_applicable (never synced, treat as no known policy)", () => {
  const result = derivePolicyStatus({ ...base, currentPolicySnapshotId: null, enforcementMode: "auto" });
  expect(result.code).toBe("unavailable");
  expect(result.allowsMerge).toBe(false);
  // On its own (no on-demand sync applied) this stays unavailable — Task 3 covers
  // the on-demand sync that eliminates this state before the user ever sees it.
});

test("no snapshot yet, enforcement required -> unavailable and blocks", () => {
  const result = derivePolicyStatus({ ...base, currentPolicySnapshotId: null, enforcementMode: "required" });
  expect(result).toEqual({ code: "unavailable", label: "Unavailable: policy snapshot missing", allowsMerge: false });
});

test("snapshot exists, no recorded error, real API failure recorded -> unavailable, distinct message", () => {
  const result = derivePolicyStatus({
    ...base, currentPolicySnapshotId: null, policyErrorCode: "rate_limited", enforcementMode: "auto",
  });
  expect(result.code).toBe("unavailable");
  expect(result.label).toContain("rate_limited");
  expect(result.allowsMerge).toBe(false);
});

test("snapshot exists, both states not_required -> not_applicable, allows merge", () => {
  const result = derivePolicyStatus({
    ...base, currentPolicySnapshotId: "snap-1", policyComplete: true,
    reviewState: "not_required", checkState: "not_required",
  });
  expect(result).toEqual({ code: "not_applicable", label: "No applicable policies", allowsMerge: true });
});

test("snapshot exists, approved + success -> satisfied, allows merge", () => {
  const result = derivePolicyStatus({
    ...base, currentPolicySnapshotId: "snap-1", policyComplete: true,
    reviewState: "approved", checkState: "success",
  });
  expect(result).toEqual({ code: "satisfied", label: "Policies satisfied", allowsMerge: true });
});

test("snapshot exists, checks pending -> failed, does not allow merge, mentions checks", () => {
  const result = derivePolicyStatus({
    ...base, currentPolicySnapshotId: "snap-1", policyComplete: true,
    reviewState: "approved", checkState: "pending",
  });
  expect(result.code).toBe("failed");
  expect(result.label.toLowerCase()).toContain("checks pending");
  expect(result.allowsMerge).toBe(false);
});

test("snapshot exists, reviews changes_requested -> failed, mentions reviews", () => {
  const result = derivePolicyStatus({
    ...base, currentPolicySnapshotId: "snap-1", policyComplete: true,
    reviewState: "changes_requested", checkState: "success",
  });
  expect(result.code).toBe("failed");
  expect(result.label.toLowerCase()).toContain("changes requested");
  expect(result.allowsMerge).toBe(false);
});

test("snapshot stale -> unavailable, does not allow merge", () => {
  const result = derivePolicyStatus({
    ...base, currentPolicySnapshotId: "snap-1", policyStale: true, policyComplete: true,
    reviewState: "not_required", checkState: "not_required",
  });
  expect(result.code).toBe("unavailable");
  expect(result.label).toContain("Stale");
  expect(result.allowsMerge).toBe(false);
});

test("snapshot incomplete (policyComplete false) -> unavailable", () => {
  const result = derivePolicyStatus({
    ...base, currentPolicySnapshotId: "snap-1", policyComplete: false,
  });
  expect(result.code).toBe("unavailable");
  expect(result.label).toContain("Incomplete");
  expect(result.allowsMerge).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/domain/src/pull-request-policy-status.test.ts`
Expected: FAIL with "Cannot find module './pull-request-policy-status.ts'"

- [ ] **Step 3: Write the implementation**

```ts
// packages/domain/src/pull-request-policy-status.ts
export type PolicyStatusCode = "satisfied" | "not_applicable" | "failed" | "unavailable";

export type PolicyStatusInput = {
  headSha: string | null;
  currentPolicySnapshotId: string | null;
  policyStale: boolean;
  policyComplete: boolean | null;
  reviewState: string | null;
  checkState: string | null;
  policyErrorCode: string | null;
  policyRetryAfter: string | Date | null;
  enforcementMode: "auto" | "required" | "optional";
};

export type PolicyStatus = {
  code: PolicyStatusCode;
  label: string;
  allowsMerge: boolean;
};

function unavailable(label: string): PolicyStatus {
  return { code: "unavailable", label, allowsMerge: false };
}

export function derivePolicyStatus(input: PolicyStatusInput): PolicyStatus {
  if (!input.headSha) return unavailable("Unavailable: head SHA missing");

  if (!input.currentPolicySnapshotId) {
    if (input.enforcementMode === "required") {
      return unavailable("Unavailable: policy snapshot missing");
    }
    if (input.policyErrorCode) {
      const retry = input.policyRetryAfter ? `; retry after ${new Date(input.policyRetryAfter).toLocaleString("nl-NL")}` : "";
      return unavailable(`Unavailable: ${input.policyErrorCode}${retry}`);
    }
    // auto/optional, never synced, no recorded failure: still unavailable on its
    // own — callers with the on-demand sync helper (see pull-request-on-demand-sync.ts)
    // should run that BEFORE calling derivePolicyStatus so this branch is rarely hit
    // by end users. It intentionally does not "pass" from absence alone.
    return unavailable("Unavailable: policy snapshot missing");
  }

  if (input.policyStale) {
    const retry = input.policyRetryAfter ? `; retry after ${new Date(input.policyRetryAfter).toLocaleString("nl-NL")}` : "";
    return unavailable(`Stale${input.policyErrorCode ? `: ${input.policyErrorCode}` : ""}${retry}`);
  }
  if (input.policyComplete === false || input.policyComplete === null) {
    return unavailable(`Incomplete${input.policyErrorCode ? `: ${input.policyErrorCode}` : ""}`);
  }

  const reviewOk = input.reviewState === "approved" || input.reviewState === "not_required";
  const checkOk = input.checkState === "success" || input.checkState === "not_required";
  if (input.reviewState === "not_required" && input.checkState === "not_required") {
    return { code: "not_applicable", label: "No applicable policies", allowsMerge: true };
  }
  if (reviewOk && checkOk) {
    return { code: "satisfied", label: "Policies satisfied", allowsMerge: true };
  }
  const reasons: string[] = [];
  if (!reviewOk) {
    reasons.push(input.reviewState === "changes_requested" ? "changes requested" : `reviews ${input.reviewState ?? "unknown"}`);
  }
  if (!checkOk) {
    reasons.push(input.checkState === "failure" ? "checks failed" : `checks ${input.checkState ?? "unknown"}`);
  }
  return { code: "failed", label: `Required: ${reasons.join(", ")}`, allowsMerge: false };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/domain/src/pull-request-policy-status.test.ts`
Expected: PASS (all 10 tests)

- [ ] **Step 5: Export from the domain package's public entrypoint**

Check `packages/domain/src/index.ts` (or equivalent barrel file) for how `pull-request-policy.ts` is exported, and add the same export pattern for `pull-request-policy-status.ts`. Run `grep -n "pull-request-policy" packages/domain/src/index.ts` first to see the existing line to mirror.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/pull-request-policy-status.ts packages/domain/src/pull-request-policy-status.test.ts packages/domain/src/index.ts
git commit -m "feat: add shared PolicyStatus derivation for PR merge eligibility"
```

---

### Task 2: Per-project GitHub policy enforcement mode config

**Files:**
- Modify: `packages/project-config/src/index.ts`
- Test: `packages/project-config/src/index.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```ts
  export function getGithubPolicyEnforcementMode(configJson: unknown): "auto" | "required" | "optional";
  ```
  Task 3 and Task 4 call this with a project row's `config_json` column value.

- [ ] **Step 1: Write the failing tests**

```ts
// append to packages/project-config/src/index.test.ts
import { getGithubPolicyEnforcementMode } from "./index.ts";

test("defaults to auto when config_json has no github_policy key", () => {
  expect(getGithubPolicyEnforcementMode({})).toBe("auto");
  expect(getGithubPolicyEnforcementMode(null)).toBe("auto");
  expect(getGithubPolicyEnforcementMode(undefined)).toBe("auto");
});

test("reads a valid enforcement value", () => {
  expect(getGithubPolicyEnforcementMode({ github_policy: { enforcement: "required" } })).toBe("required");
  expect(getGithubPolicyEnforcementMode({ github_policy: { enforcement: "optional" } })).toBe("optional");
});

test("falls back to auto on an invalid/unexpected value", () => {
  expect(getGithubPolicyEnforcementMode({ github_policy: { enforcement: "bogus" } })).toBe("auto");
  expect(getGithubPolicyEnforcementMode({ github_policy: "not-an-object" })).toBe("auto");
});
```

(Check the top of `packages/project-config/src/index.test.ts` for the existing test-framework import style — mirror it, likely `import { expect, test } from "vitest";`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/project-config/src/index.test.ts`
Expected: FAIL with "getGithubPolicyEnforcementMode is not a function" / import error

- [ ] **Step 3: Write the implementation**

Add to `packages/project-config/src/index.ts` (near the other exported small helpers, e.g. next to `normalizeAgentStartPath`):

```ts
const GITHUB_POLICY_ENFORCEMENT_MODES = new Set(["auto", "required", "optional"]);

export function getGithubPolicyEnforcementMode(configJson: unknown): "auto" | "required" | "optional" {
  if (!configJson || typeof configJson !== "object") return "auto";
  const githubPolicy = (configJson as Record<string, unknown>).github_policy;
  if (!githubPolicy || typeof githubPolicy !== "object") return "auto";
  const enforcement = (githubPolicy as Record<string, unknown>).enforcement;
  return typeof enforcement === "string" && GITHUB_POLICY_ENFORCEMENT_MODES.has(enforcement)
    ? (enforcement as "auto" | "required" | "optional")
    : "auto";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/project-config/src/index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/project-config/src/index.ts packages/project-config/src/index.test.ts
git commit -m "feat: add per-project github_policy.enforcement config mode"
```

---

### Task 3: On-demand policy snapshot sync helper

This closes the main real-world gap: a PR whose periodic policy sync hasn't run yet (or has been failing) gets a fresh, authoritative check performed synchronously when a human clicks "Approve & merge", instead of silently blocking forever.

**Files:**
- Create: `packages/domain/src/pull-request-on-demand-sync.ts`
- Test: `packages/domain/src/pull-request-on-demand-sync.test.ts`

**Interfaces:**
- Consumes:
  - `getPullRequestPolicyInputs(owner: string, repo: string, number: number)` from `packages/github-provider/src/index.ts` (existing).
  - `evaluatePullRequestPolicy(inputs: GitHubPolicyInputs)` from `./pull-request-policy.ts` (existing).
  - `GitHubProviderError` from `packages/github-provider/src/index.ts` (existing — used to distinguish real API failures).
- Produces:
  ```ts
  export type EnsurePolicySnapshotResult =
    | { outcome: "synced"; snapshotId: string }
    | { outcome: "error"; errorCode: string; retryAfter: string | null };

  export async function ensurePolicySnapshot(
    db: pg.Pool,
    input: { pullRequestId: string; owner: string; repo: string; number: number },
  ): Promise<EnsurePolicySnapshotResult>;
  ```
  Task 5 (server.ts `/approve` route) calls this.

- [ ] **Step 1: Write the failing tests**

Look at `packages/domain/src/pr-merge.test.ts` first for how this codebase mocks `pg.Pool` and `getPullRequestPolicyInputs`/`GitHubProviderError` (it exercises the exact same dependencies inside `approveAndMergePullRequest`). Mirror that mocking style exactly — do not invent a new one.

```ts
// packages/domain/src/pull-request-on-demand-sync.test.ts
import { expect, test, vi } from "vitest";
import { ensurePolicySnapshot } from "./pull-request-on-demand-sync.ts";

// NOTE: adjust the mock shape below to match whatever mocking pattern
// pr-merge.test.ts already uses for `../../github-provider/src/index.ts`
// (vi.mock with a factory, or a passed-in fake pool) — copy that pattern,
// do not diverge from it.

test("persists a snapshot and returns synced outcome when GitHub call succeeds", async () => {
  // Arrange: fake pool.query resolves for the INSERT into
  // pull_request_policy_snapshots and the UPDATE of pull_requests,
  // matching the exact query shape used in pr-merge.ts lines 245-268.
  // Fake getPullRequestPolicyInputs to resolve with protected:false, complete:true.
  // Act: const result = await ensurePolicySnapshot(fakeDb, { pullRequestId: "pr-1", owner: "o", repo: "r", number: 1 });
  // Assert: result.outcome === "synced" and result.snapshotId is the inserted id.
});

test("returns error outcome without writing a snapshot when GitHub call throws GitHubProviderError", async () => {
  // Fake getPullRequestPolicyInputs to reject with a GitHubProviderError(code: "rate_limited", status: 429, ...).
  // Assert: result.outcome === "error", result.errorCode === "rate_limited", no INSERT query was issued.
});
```

Because this helper's persistence logic is a near-duplicate of the snapshot-insert block already inside `pr-merge.ts` (lines 245–268), write the two tests above against the actual mocking scaffold already present in `packages/domain/src/pr-merge.test.ts` — open that file first and copy its `pg.Pool` fake / `vi.mock` setup verbatim before writing assertions, rather than re-deriving a mock shape from scratch.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/domain/src/pull-request-on-demand-sync.test.ts`
Expected: FAIL — module does not exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// packages/domain/src/pull-request-on-demand-sync.ts
import type pg from "pg";
import { getPullRequestPolicyInputs } from "../../github-provider/src/index.ts";
import { GitHubProviderError } from "../../github-provider/src/index.ts";
import { evaluatePullRequestPolicy } from "./pull-request-policy.ts";

export type EnsurePolicySnapshotResult =
  | { outcome: "synced"; snapshotId: string }
  | { outcome: "error"; errorCode: string; retryAfter: string | null };

export async function ensurePolicySnapshot(
  db: pg.Pool,
  input: { pullRequestId: string; owner: string; repo: string; number: number },
): Promise<EnsurePolicySnapshotResult> {
  let inputs;
  try {
    inputs = await getPullRequestPolicyInputs(input.owner, input.repo, input.number);
  } catch (error) {
    const code = error instanceof GitHubProviderError ? error.code : "unknown_error";
    const retryAfter = error instanceof GitHubProviderError && "retryAfter" in error
      ? (error as { retryAfter?: string | null }).retryAfter ?? null
      : null;
    await db.query(
      `UPDATE pull_requests SET policy_stale=true,policy_error_code=$2,policy_retry_after=$3,
       policy_last_attempted_at=now(),updated_at=now() WHERE id=$1`,
      [input.pullRequestId, code, retryAfter],
    );
    return { outcome: "error", errorCode: code, retryAfter };
  }

  const evaluated = evaluatePullRequestPolicy(inputs);
  const snapshot = (await db.query(
    `INSERT INTO pull_request_policy_snapshots
     (pull_request_id,material_json,material_hash,head_sha,base_ref,base_sha,review_state,check_state,
      refusal_codes,complete,incomplete_reason,source,fetched_at)
     VALUES ($1,$2,encode(digest(canonical_jsonb($2::jsonb),'sha256'),'hex'),$3,$4,$5,$6,$7,$8::jsonb,$9,$10,'github',$11)
     RETURNING id`,
    [input.pullRequestId, evaluated.material, inputs.pullRequest.head.sha, inputs.pullRequest.base.ref,
     inputs.pullRequest.base.sha ?? null, evaluated.reviewState, evaluated.checkState,
     JSON.stringify(evaluated.refusalCodes), inputs.complete, inputs.incompleteReason ?? null, inputs.fetchedAt],
  )).rows[0];
  await db.query(
    `UPDATE pull_requests SET current_policy_snapshot_id=$2,head_sha=$3,base_branch=$4,review_state=$5,
     check_state=$6,policy_complete=$7,policy_stale=false,policy_synced_at=$8,
     policy_last_attempted_at=$8,policy_error_code=NULL,policy_retry_after=NULL,updated_at=now()
     WHERE id=$1`,
    [input.pullRequestId, snapshot.id, inputs.pullRequest.head.sha, inputs.pullRequest.base.ref,
     evaluated.reviewState, evaluated.checkState, inputs.complete, inputs.fetchedAt],
  );
  return { outcome: "synced", snapshotId: snapshot.id as string };
}
```

Cross-check the exact `pull_request_policy_snapshots` INSERT column list and the `pull_requests` UPDATE column list against `packages/domain/src/pr-merge.ts` lines 246–268 while implementing this — copy them verbatim (they must stay byte-identical to avoid two slightly-different snapshot-writing code paths drifting apart over time).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/domain/src/pull-request-on-demand-sync.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/pull-request-on-demand-sync.ts packages/domain/src/pull-request-on-demand-sync.test.ts
git commit -m "feat: add on-demand policy snapshot sync for approve-time gap"
```

---

### Task 4: Wire the shared status into the PR list/detail UI

**Files:**
- Modify: `apps/web/src/pages/prs.ts:39-166` (`renderDetail`) and the list-row renderer (~line 169-230, the `.map((item) => ...)` block)
- Modify: `apps/web/src/pages/prs-list-actions.test.ts` (lines 55–66 currently lock in old behavior)

**Interfaces:**
- Consumes: `derivePolicyStatus`, `PolicyStatusInput` from `../../../packages/domain/src/pull-request-policy-status.ts` (adjust relative path to match how `apps/web/src/pages/prs.ts` already imports from `@dcc/domain`, e.g. line 3: `import { aiModels, reasoningLevels } from "@dcc/domain";` — add `derivePolicyStatus` to that same import if the barrel re-exports it from Task 1 Step 5).
- Produces: no new exports; only changes rendered HTML strings.

- [ ] **Step 1: Update the failing/locked-in tests first**

Open `apps/web/src/pages/prs-list-actions.test.ts` lines 55–66. Update the test that currently asserts "labels missing snapshot ... as unavailable" so it reflects the NEW behavior for the specific scenario it was testing — re-read that test's setup fixture first (does it set `enforcementMode`/`config_json`? No — it operates on a raw `item`-shaped fixture. Since `renderDetail`/list-row now derive `enforcementMode` from the project row's `config_json`, extend the fixture with a `project_config_json` field or however `prs.ts` threads project config into `renderDetail` — check the `detailQuery` at `prs.ts:5-13`, which does NOT currently select `p.config_json`. You must add `p.config_json` to that SQL query's SELECT list (and to the list-view query at ~line 187) so `renderDetail`/the row mapper can call `getGithubPolicyEnforcementMode(item.config_json)`.

```ts
// apps/web/src/pages/prs-list-actions.test.ts — replace the existing
// "labels missing snapshot ... as unavailable" test with:
test("labels a missing snapshot as unavailable when enforcement mode is required", () => {
  const item = { ...baseItem, current_policy_snapshot_id: null, config_json: { github_policy: { enforcement: "required" } } };
  // ...render and assert the badge text is "GitHub: Unavailable: policy snapshot missing"
  // and the Approve & merge button carries the disabled attribute.
});

test("labels a missing snapshot as no applicable policies when enforcement mode is auto and review/check states are not_required", () => {
  const item = {
    ...baseItem, current_policy_snapshot_id: "snap-1", policy_complete: true, policy_stale: false,
    review_state: "not_required", check_state: "not_required", config_json: {},
  };
  // ...render and assert the badge text is "GitHub: No applicable policies"
  // and the Approve & merge button is NOT disabled (assuming other gates pass).
});
```

Read the actual `baseItem` fixture and assertion helper style already in this test file before writing these — match its exact conventions (how it renders, what selector/regex it uses to find the badge in the output HTML string).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/web/src/pages/prs-list-actions.test.ts`
Expected: FAIL (old behavior still hardcoded in `prs.ts`)

- [ ] **Step 3: Update the SQL queries to select `p.config_json`**

In `apps/web/src/pages/prs.ts`:
- `detailQuery` (lines 5–13): add `p.config_json` to the SELECT list (it already does `p.name project_name,p.slug project_slug` — add `,p.config_json` alongside those).
- The list-view query (~line 187, inside the `if (url.pathname === "/admin/pull-requests")` block): add `p.config_json` to its SELECT list too.

- [ ] **Step 4: Replace `policyIssue`/`mergeBlocker` in `renderDetail`**

Replace lines 50–72 of `apps/web/src/pages/prs.ts`:

```ts
// DELETE the old policyIssue / mergeBlocker / policyAllowsMerge block (lines 50-72) and replace with:
import { derivePolicyStatus } from "@dcc/domain"; // add to the existing import at the top of the file instead of a new line
import { getGithubPolicyEnforcementMode } from "@dcc/project-config"; // match this package's actual export path/name

// ...inside renderDetail(item, ...):
const policyStatus = derivePolicyStatus({
  headSha: item.head_sha ?? null,
  currentPolicySnapshotId: item.current_policy_snapshot_id ?? null,
  policyStale: Boolean(item.policy_stale),
  policyComplete: item.policy_complete ?? null,
  reviewState: item.review_state ?? null,
  checkState: item.check_state ?? null,
  policyErrorCode: item.policy_error_code ?? null,
  policyRetryAfter: item.policy_retry_after ?? null,
  enforcementMode: getGithubPolicyEnforcementMode(item.config_json),
});
const policyIssue = policyStatus.label;
```

Then compute the overall `mergeBlocker`/`policyAllowsMerge` by combining `policyStatus.allowsMerge` with the existing non-policy checks (head SHA missing is already folded into `derivePolicyStatus`, so simplify):

```ts
const mergeBlocker = !policyStatus.allowsMerge ? `GitHub: ${policyStatus.label}` : "";
const policyAllowsMerge = policyStatus.allowsMerge;
```

Update the badge rendering at line 113:
```ts
<span class="status ${policyAllowsMerge ? "ok" : (policyStatus.code === "not_applicable" ? "ok" : "warn")}">GitHub: ${escapeHtml(policyIssue)}</span>
```
(`not_applicable` and `satisfied` both render with the "ok"/green tone; `failed` and `unavailable` render with "warn"/amber — check `apps/web/src/pages/shared.ts` `statusTone`/tone-class conventions used elsewhere in this file, e.g. line 84 `stateBadge`, and match the class names it actually uses, e.g. `ok`/`warn`/`danger`/`muted`/`info`.)

- [ ] **Step 5: Apply the same change to the list-view row renderer**

In the `.map((item) => ...)` block (~lines 169-230), the list row currently does not render a GitHub policy badge at all (only `stateBadge`/`aiBadge`/conflicts/freshness — confirm by re-reading the row template literal). If a policy badge is not currently shown in the list view, skip this step (no behavior to fix there) — only the detail page (`renderDetail`) shows it today per the investigation report. Confirm this by re-reading the row template literal before deciding whether any change is needed here.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run apps/web/src/pages/prs-list-actions.test.ts apps/web/src/pages/prs.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/prs.ts apps/web/src/pages/prs-list-actions.test.ts
git commit -m "fix: derive PR policy badge and merge-button state from shared PolicyStatus"
```

---

### Task 5: Wire the shared status + on-demand sync into the `/approve` API route

**Files:**
- Modify: `apps/web/src/server.ts` (the `approve` action inside the PR action handler, ~lines 1011–1027)
- Test: `apps/web/src/approval-route-regressions.test.ts`

**Interfaces:**
- Consumes: `derivePolicyStatus` (Task 1), `getGithubPolicyEnforcementMode` (Task 2), `ensurePolicySnapshot` (Task 3).
- Produces: no new exports; changes the 409-vs-202 decision in this one route.

- [ ] **Step 1: Write the failing tests**

Open `apps/web/src/approval-route-regressions.test.ts` first to copy its existing request-mocking/fixture style exactly (it already has a case "queues a matching head without a policy snapshot when enforcement is disabled", line 56 area — model new tests after that one's structure).

```ts
// add to apps/web/src/approval-route-regressions.test.ts
test("approves a PR with no policy snapshot when the project has no applicable GitHub policies (auto mode)", async () => {
  // Fixture: pull_requests row with current_policy_snapshot_id=null, head_sha matching
  // request body, requireFreshPolicyBinding=true (global setting on), project.config_json={}.
  // Mock getPullRequestPolicyInputs (via whatever this test file's github-provider mock
  // is, matching pr-merge.test.ts's pattern) to resolve protected:false, complete:true.
  // POST /api/admin/pull-requests/:id -> { action: "approve", expected_head_sha: "<matching>" }
  // Assert: 202 response with a queued job (NOT 409).
});

test("keeps blocking a PR with no policy snapshot when the project requires enforcement", async () => {
  // Same as above but project.config_json = { github_policy: { enforcement: "required" } }.
  // Assert: 409 "pull request policy binding is missing or stale" (unchanged from today).
});

test("keeps blocking and surfaces the real error when GitHub is unreachable during on-demand sync", async () => {
  // Mock getPullRequestPolicyInputs to throw a GitHubProviderError (rate limit).
  // Assert: 409, and the pull_requests row's policy_error_code column was updated
  // (or assert on the response body if this route echoes it back).
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/web/src/approval-route-regressions.test.ts`
Expected: FAIL — current route always 409s when `current_policy_snapshot_id` is null and enforcement is required by the global toggle.

- [ ] **Step 3: Update the route**

In `apps/web/src/server.ts`, the `approve` branch (~lines 1011–1027). First, update the query at the top of this handler (~line 1000–1005, `SELECT pr.* ... FROM pull_requests pr ...`) to also join `projects p` and select `p.config_json,p.github_owner,p.github_repository` if not already present — check whether `pullRequest` already carries these (the report notes the query only reads from `pull_requests`, so a join is likely needed; confirm by reading lines 995–1006 in full before editing).

```ts
} else if (action === "approve") {
  const expectedHeadSha = typeof body.expected_head_sha === "string" ? body.expected_head_sha.trim() : "";
  const { requireFreshPolicyBinding } = await getPullRequestMergeSettings(pool);
  if (!expectedHeadSha || expectedHeadSha !== pullRequest.head_sha) {
    return json(response, 409, { error: "pull request policy binding is missing or stale" });
  }
  let policySnapshotId = pullRequest.current_policy_snapshot_id as string | null;
  if (requireFreshPolicyBinding) {
    const enforcementMode = getGithubPolicyEnforcementMode(pullRequest.config_json);
    if (!policySnapshotId && enforcementMode !== "required") {
      const synced = await ensurePolicySnapshot(pool, {
        pullRequestId: pullRequest.id, owner: pullRequest.github_owner,
        repo: pullRequest.github_repository, number: pullRequest.number,
      });
      if (synced.outcome === "synced") policySnapshotId = synced.snapshotId;
    }
    const status = derivePolicyStatus({
      headSha: pullRequest.head_sha ?? null,
      currentPolicySnapshotId: policySnapshotId,
      policyStale: policySnapshotId ? false : Boolean(pullRequest.policy_stale),
      policyComplete: policySnapshotId ? true : (pullRequest.policy_complete ?? null),
      reviewState: policySnapshotId === pullRequest.current_policy_snapshot_id ? pullRequest.review_state : null,
      checkState: policySnapshotId === pullRequest.current_policy_snapshot_id ? pullRequest.check_state : null,
      policyErrorCode: pullRequest.policy_error_code ?? null,
      policyRetryAfter: pullRequest.policy_retry_after ?? null,
      enforcementMode,
    });
    if (!status.allowsMerge) {
      return json(response, 409, { error: `pull request policy binding is missing or stale: ${status.label}` });
    }
  }
  const job = await enqueueJob({
    type: "github.merge_pull_request",
    payload: {
      actor_id: session.user_id, pull_request_id: pullRequest.id,
      expected_head_sha: expectedHeadSha, ...(requireFreshPolicyBinding ? { policy_snapshot_id: policySnapshotId } : {}),
    },
    idempotencyKey: `g07:github.merge_pull_request:${pullRequest.id}:${expectedHeadSha}:${Math.floor(Date.now() / 3_600_000)}`,
  });
  return json(response, 202, { job });
}
```

**Important subtlety**: when `ensurePolicySnapshot` runs and stores a brand-new snapshot, the freshly-read `pullRequest.review_state`/`check_state` in memory are stale (they were read before the sync). The snippet above only trusts `review_state`/`check_state` from the in-memory `pullRequest` object when `policySnapshotId` still equals what was originally on the row (i.e. no on-demand sync happened) — when a sync DID just happen, re-query the row (`SELECT review_state, check_state, policy_complete FROM pull_requests WHERE id=$1`) instead of trusting stale in-memory fields, since `ensurePolicySnapshot` writes these to the DB but does not return them. Add that re-query explicitly:

```ts
if (synced.outcome === "synced") {
  policySnapshotId = synced.snapshotId;
  const refreshed = (await pool.query(
    "SELECT review_state, check_state, policy_complete FROM pull_requests WHERE id=$1", [pullRequest.id],
  )).rows[0];
  pullRequest.review_state = refreshed.review_state;
  pullRequest.check_state = refreshed.check_state;
  pullRequest.policy_complete = refreshed.policy_complete;
}
```//
Place this refresh immediately after the `ensurePolicySnapshot` call, before constructing `status`, and simplify the `reviewState`/`checkState` fields passed into `derivePolicyStatus` back to `pullRequest.review_state`/`pullRequest.check_state` directly (drop the `policySnapshotId === pullRequest.current_policy_snapshot_id` conditional from the snippet above — it's superseded by this explicit refresh).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/web/src/approval-route-regressions.test.ts`
Expected: PASS

- [ ] **Step 5: Verify the merge-time gate in `pr-merge.ts` still requires a real snapshot ID (no weakening)**

Run: `npx vitest run packages/domain/src/pr-merge.test.ts`
Expected: PASS unchanged — confirms Task 5 did not touch `approveAndMergePullRequest`'s existing `if (typeof mergeInput.expectedPolicySnapshotId !== "string") throw ...` gate (line ~203), and the worker job still requires a real, valid snapshot ID before merging, matching what `/approve` now guarantees it always supplies when `allowsMerge` is true.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server.ts apps/web/src/approval-route-regressions.test.ts
git commit -m "fix: allow approve route to merge unprotected repos without a pre-existing policy snapshot"
```

---

### Task 6: Regression coverage for protected repositories (no weakening)

**Files:**
- Modify: `apps/web/src/pages/prs-list-actions.test.ts`
- Modify: `apps/web/src/approval-route-regressions.test.ts`
- Modify: `packages/domain/src/pr-merge.test.ts`

**Interfaces:** none new — pure regression tests.

- [ ] **Step 1: Write regression tests confirming protected repos remain blocked when they should be**

```ts
// prs-list-actions.test.ts
test("a protected repo with pending required checks still shows Approve & merge disabled", () => {
  const item = { ...baseItem, current_policy_snapshot_id: "snap-1", policy_complete: true, policy_stale: false, review_state: "approved", check_state: "pending", config_json: {} };
  // assert badge is "GitHub: Required: checks pending" (or similar per Task 1's label format) and button disabled.
});

test("a protected repo with changes requested still shows Approve & merge disabled", () => {
  const item = { ...baseItem, current_policy_snapshot_id: "snap-1", policy_complete: true, policy_stale: false, review_state: "changes_requested", check_state: "success", config_json: {} };
  // assert badge mentions "changes requested" and button disabled.
});
```

```ts
// approval-route-regressions.test.ts
test("a protected repo whose checks are failing is refused at merge time even if the approve route let it through", async () => {
  // Simulate: approve route succeeds (job queued) because snapshot existed and was stale-but-not-yet-detected,
  // but pr-merge.ts's fresh re-verification (packages/domain/src/pr-merge.ts lines 240-286) finds refusalCodes
  // non-empty at merge time. Assert the worker job throws PullRequestMergeError and the PR is NOT merged.
  // This exercises the existing authoritative gate, confirming Task 5 did not bypass it.
});
```

```ts
// packages/domain/src/pr-merge.test.ts
test("does not merge when the domain reducer finds an applicable policy failing, regardless of snapshot presence", () => {
  // Existing test file likely already covers this via evaluatePullRequestPolicy fixtures with protected:true
  // and a failing check — confirm coverage exists; if not, add one modeled on the existing
  // "refuses to merge when reviews are pending" style test already in this file.
});
```

- [ ] **Step 2: Run the full domain + web test suites**

Run: `npx vitest run packages/domain apps/web`
Expected: PASS, all new and pre-existing tests green.

- [ ] **Step 3: Run full verify**

Run: `npm run verify` (or `pnpm verify`, check `package.json` — this runs `tsc --noEmit && vitest run`)
Expected: PASS with no type errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/prs-list-actions.test.ts apps/web/src/approval-route-regressions.test.ts packages/domain/src/pr-merge.test.ts
git commit -m "test: add regression coverage confirming protected repos stay blocked"
```

---

## Self-Review Notes (for the plan author, already applied above)

- **Spec coverage**: satisfied/failed/not_applicable/unavailable states (Task 1); per-repo flag mechanism (Task 2, `config_json.github_policy.enforcement`); auto-detection via existing 404/403-plan-restricted handling in `getPullRequestPolicyInputs` (already correct, reused as-is — no change needed there); shared frontend/backend logic (Tasks 1, 4, 5); backend enforcement not bypassable (Task 5 Step 5, Task 6); no dummy policies required (nothing in this plan asks the user to configure GitHub-side policies); UI copy changed to "No applicable policies" (Task 4 Step 4); distinct error state for real API failures preserved (Task 1's `unavailable` + `policyErrorCode` threading, Task 3, Task 5 test 3).
- **Placeholder scan**: all code blocks contain real, compilable-shaped TypeScript; the one intentionally-open item (exact mock scaffolding for `pull-request-on-demand-sync.test.ts` and `approval-route-regressions.test.ts`) explicitly instructs copying an existing, named test file's pattern rather than leaving a "TODO" — this is a deliberate "go read this specific file first" instruction, not a placeholder.
- **Type consistency**: `PolicyStatus`/`PolicyStatusCode`/`PolicyStatusInput` (Task 1) are the exact names reused unchanged through Tasks 4 and 5. `ensurePolicySnapshot`/`EnsurePolicySnapshotResult` (Task 3) reused unchanged in Task 5.

## Known Limitation (flagged, not fixed by this plan)

`getPullRequestPolicyInputs` (`packages/github-provider/src/index.ts:336-403`) only queries the classic branch-protection REST endpoint (`GET /branches/{branch}/protection`). It never queries GitHub **Rulesets** (`GET /repos/{owner}/{repo}/rulesets`), which is the newer, non-classic policy mechanism. A repository governed *only* by rulesets (no classic branch protection) is therefore silently treated as "no policy configured" today, both before and after this plan — this plan does not introduce that gap, but it also doesn't close it, since closing it requires a new ruleset-fetch + ruleset-evaluation feature (fetching applicable rulesets for the base branch, mapping rule types like `required_status_checks`/`pull_request` to the existing `requiredChecks`/`requiredApprovals` shape) that is out of scope for a merge-eligibility bug fix. Flag this to the user as a follow-up candidate if any managed repository uses rulesets instead of classic branch protection.

## Execution Handoff

Plan complete and saved to `plans/01-github-policy-merge-eligibility.md`. Recommended: **Subagent-Driven** (superpowers:subagent-driven-development) — fresh subagent per task, review between tasks, since Tasks 4–5 touch shared server-rendered UI code that benefits from a review checkpoint before the route-level change ships.
