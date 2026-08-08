# GitHub No-Policy Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable approve-and-merge for repositories without GitHub branch-protection requirements while retaining the exact-head merge binding.

**Architecture:** A policy snapshot is an internal record of the pull request head and its GitHub merge requirements. Once GitHub reports no branch protection, return complete no-requirements inputs from the pull-request response and skip the inaccessible review/check endpoints. Protected repositories stay fail-closed.

**Tech Stack:** TypeScript, Node.js, Vitest, GitHub REST API.

## Global Constraints

- Preserve the exported `getPullRequestPolicyInputs()` signature and `ProviderGitHubPolicyInputs` shape.
- Do not add dependencies, migrations, configuration, or another policy system.
- Preserve the exact-head, immutable-snapshot merge guard.
- Keep actual protected-repository behavior unchanged and fail-closed.
- Commit only `packages/github-provider/src/index.ts`, `packages/github-provider/src/index.test.ts`, and this plan document.

---

### Task 1: Return policy inputs without irrelevant GitHub API calls

**Files:**
- Modify: `packages/github-provider/src/index.ts:305-370`
- Modify: `packages/github-provider/src/index.test.ts:162-191`

**Interfaces:**
- Consumes the existing pull-request response and its branch-protection response.
- Produces the existing `Promise<ProviderGitHubPolicyInputs>` with no required approvals or checks when branch protection is unavailable.

- [ ] **Step 1: Write the failing regression test**

Replace the existing plan-restricted branch-protection test. Record every request. Return the current complete pull-request fixture, return GitHub's plan-restricted `403` body from `/branches/main/protection`, and return `403 Resource not accessible by integration` from every other endpoint. Assert `getPullRequestPolicyInputs("acme", "widgets", 42)` resolves with `protected: false`, `requiredApprovals: 0`, empty `reviews`, the requested user `bob` and team `platform`, empty `requiredChecks` and `checks`, and `complete: true`. Assert the only requested paths are `/repos/acme/widgets/pulls/42` and `/repos/acme/widgets/branches/main/protection`.

- [ ] **Step 2: Run the regression test and verify it fails**

Run: `rtk pnpm exec vitest run packages/github-provider/src/index.test.ts --config vitest.config.ts`

Expected: FAIL because the current code still requests `/pulls/42/reviews` and throws `GitHub policy input fetch failed`.

- [ ] **Step 3: Write the minimal implementation**

Immediately after `protection` is derived, create one typed `requestedReviewers` array from `pullRequest.requested_reviewers` and `pullRequest.requested_teams`. If `protection === null`, return:

```ts
{
  pullRequest,
  protected: false,
  requiredApprovals: 0,
  reviews: [],
  requestedReviewers,
  requiredChecks: [],
  checks: [],
  complete: true,
  fetchedAt: new Date().toISOString(),
}
```

Use the same `requestedReviewers` variable in the existing protected-policy return. Do not change the path for non-null protection.

- [ ] **Step 4: Verify the fix**

Run: `rtk pnpm exec vitest run packages/github-provider/src/index.test.ts --config vitest.config.ts`

Expected: PASS. The existing protected-policy tests must remain green.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/github-provider/src/index.ts packages/github-provider/src/index.test.ts docs/superpowers/plans/2026-08-08-github-no-policy-snapshot.md
rtk git commit -m "fix(github): snapshot pull requests without branch policies"
```

### Task 2: Verify and publish the branch

**Files:** None.

- [ ] **Step 1: Run full verification**

Run: `rtk pnpm verify`

Expected: TypeScript and the full unit suite pass.

- [ ] **Step 2: Publish the reviewed branch**

Push `fix/github-no-policy-snapshot` to `origin` and open a draft GitHub PR targeting `master`. The PR body must state that the GitHub policy snapshot is an internal exact-head safety record, identify the unnecessary `check-runs` request as the root cause, and list the focused and full verification commands.
