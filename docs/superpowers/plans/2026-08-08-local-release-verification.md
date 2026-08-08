# Local Release Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy signed protected-branch pushes without GitHub Actions or GitHub REST API availability, while preserving exact-head, local-verification, migration, rollback, and health gates.

**Architecture:** The signed GitHub `push` webhook becomes the only queue trigger; it does not poll GitHub for a CI result or branch head. The existing `deploy.sh` fetch-and-SHA comparison remains the authoritative exact-head gate, then runs the existing repository verification locally inside the detached release worktree before migration and cutover.

**Tech Stack:** Node.js CommonJS webhook server, Bash, git, pnpm, Vitest.

## Global Constraints

- Do not add dependencies, background services, GitHub API calls, or GitHub Actions dependencies.
- A signed non-`master` push remains ignored; an invalid signature remains rejected.
- The existing `git fetch --no-tags origin "$BRANCH"` plus `FETCH_HEAD === SHA` check is the only protected-head authority and must execute before worktree staging or migration.
- Run `pnpm verify` only after `pnpm install --frozen-lockfile` in the detached release worktree, before migration, with `DCC_TEST_DATABASE_URL` and `DCC_TEST_RESTORE_DATABASE_URL` unset.
- Record `local_verification_passed` only after local verification succeeds. Any failure must leave the current release live under the existing rollback path.
- Do not edit the user-disabled GitHub Actions workflow configuration.

---

## File Structure

- `webhook-server.js` — accepts only signed protected-branch push triggers and launches durable deployment attempts without GitHub REST checks.
- `scripts/webhook-server.test.ts` — proves webhook trigger behavior does not depend on GitHub fetches and preserves ref/signature guards.
- `deploy.sh` — verifies a staged release locally before database migration and records the successful stage.
- `scripts/task-8.test.ts` — drives the deployment shell script with command shims and verifies ordering, environment isolation, failure containment, and no accidental CI-workflow requirement.

### Task 1: Make the webhook independent of GitHub Actions and REST

**Files:**
- Modify: `webhook-server.js:17-69, 176-185, 264-308`
- Test: `scripts/webhook-server.test.ts:17-116`

**Interfaces:**
- Consumes: GitHub's HMAC-signed `push` payload with `ref` and `head_commit.id`.
- Produces: `enqueueDeploymentAttempt(pool, { deliveryId, eventType: "push", targetRef, targetSha, protectedBranch, protectedHeadSha: targetSha, checkEvidence: { trigger: "signed_push" } })` followed by the existing leased launcher.
- Removed: `requiredCiCheck`, `githubApiBaseUrl`, `githubToken`, `requestJson`, `protectedHead`, `isCurrentProtectedHead`, `checkRequiredCiStatus`, and all `check_run` handling.

- [ ] **Step 1: Write the failing webhook tests**

Replace the API-shaped test helper and stale-head/check-run test with a fetch that throws if used, then add these exact assertions:

```ts
it("queues a signed protected push without GitHub API access", async () => {
  const fetchFn = vi.fn(async () => { throw new Error("GitHub API must not be called"); });
  const ctx = await webhook({ fetchFn }); dirs.push(ctx.dir);
  const body = JSON.stringify({ ref: "refs/heads/master", head_commit: { id: protectedSha } });
  const res = response();

  await ctx.app.handleRequest({ headers: { "x-hub-signature-256": signature(body), "x-github-event": "push", "x-github-delivery": "protected" } }, res, body);

  expect(res).toMatchObject({ statusCode: 202, body: "queued" });
  expect(fetchFn).not.toHaveBeenCalled();
  expect(ctx.store.enqueueDeploymentAttempt).toHaveBeenCalledWith(null, expect.objectContaining({
    eventType: "push", targetRef: "refs/heads/master", targetSha: protectedSha,
    protectedBranch: "master", protectedHeadSha: protectedSha,
    checkEvidence: { trigger: "signed_push" },
  }));
});

it("does not launch a claimed attempt only because GitHub is unavailable", async () => {
  const attempt = { id: "attempt-queued", target_sha: protectedSha, protected_branch: "master", owner: "webhook" };
  const ctx = await webhook({ fetchFn: vi.fn(async () => { throw new Error("offline"); }), store: { claimDeploymentAttempt: vi.fn(async () => ({ kind: "claimed", attempt })) } }); dirs.push(ctx.dir);

  await expect(ctx.app.processNext()).resolves.toBe(true);

  expect(ctx.spawnFn).toHaveBeenCalledTimes(1);
  expect(ctx.store.completeDeploymentAttempt).not.toHaveBeenCalled();
});
```

Keep the existing duplicate-delivery test, and add a signed feature-branch push assertion:

```ts
expect(res).toMatchObject({ statusCode: 200, body: "Ignored" });
expect(ctx.store.enqueueDeploymentAttempt).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm exec vitest run scripts/webhook-server.test.ts --testTimeout=15000`

Expected: FAIL because the webhook still calls `fetchFn`, requires the `ci` check, or blocks the claimed attempt before spawning.

- [ ] **Step 3: Implement the minimum webhook change**

In `readConfig`, retain only configuration that the webhook still uses:

```js
return {
  secret: env.WEBHOOK_SECRET,
  port: Number(env.WEBHOOK_PORT || 9003),
  protectedBranch: env.DEPLOY_PROTECTED_BRANCH,
  deployShPath: env.DEPLOY_SH_PATH || '/home/deploy/projects/dev-control/deploy.sh',
  currentReleaseLink: env.DCC_DEPLOY_CURRENT_LINK || path.join(env.DCC_ROOT || '/home/deploy/projects/dev-control', '.deploy-current'),
  completionsDir: path.join(stateDir, 'completions'),
  logsDir: path.join(stateDir, 'logs'),
  leaseMs: Number(env.DEPLOY_STUCK_TIMEOUT_MS || 1800000),
  owner: `webhook-${process.pid}`,
  notification: { url: env.WHATSAPP_API_URL, secret: env.WHATSAPP_API_SECRET, phone: env.WHATSAPP_PHONE },
};
```

Delete the REST helper and all use of `fetchFn`. Remove the pre-launch GitHub revalidation from `launchAttempt`; `deploy.sh` immediately performs the authoritative fetch-and-SHA comparison before it can stage, migrate, or cut over.

Replace `handleDeploy` with the durable queue operation below and accept only push events:

```js
async function handleDeploy(res, { sha, deliveryId, targetRef }) {
  const queued = await store.enqueueDeploymentAttempt(pool, {
    deliveryId, eventType: 'push', targetRef, targetSha: sha,
    protectedBranch: config.protectedBranch, protectedHeadSha: sha,
    checkEvidence: { trigger: 'signed_push' },
  });
  if (!queued.created) { respond(res, 200, 'already_processed'); return; }
  await processNext();
  respond(res, 202, 'queued');
}

if (eventType !== 'push' || payload.ref !== `refs/heads/${config.protectedBranch}` || !SHA.test(payload.head_commit?.id || '')) { respond(res, 200, 'Ignored'); return; }
await handleDeploy(res, { sha: payload.head_commit.id, deliveryId, targetRef: payload.ref });
```

Do not alter HMAC validation, durable launch intent/PID persistence, completion recovery, notification handling, or the deployment-store schema.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm exec vitest run scripts/webhook-server.test.ts --testTimeout=15000`

Expected: PASS, including the new no-REST trigger and no-REST launch tests.

- [ ] **Step 5: Commit**

```bash
git add webhook-server.js scripts/webhook-server.test.ts
git commit -m "fix: deploy signed pushes without GitHub Actions"
```

### Task 2: Verify every release locally before migration

**Files:**
- Modify: `deploy.sh:127-131`
- Modify: `scripts/task-8.test.ts:13-119, 265-283`

**Interfaces:**
- Consumes: an already-created detached `$RELEASE` worktree after locked dependency installation.
- Produces: `deployment_events` stage key `deploy:local_verification_passed` and stage value `local_verification_passed` only after `pnpm verify` exits successfully.
- Failure behavior: `set -e` invokes the existing `rollback` trap; no migration, cutover, process reload, or `local_verification_passed` event follows a failed verification.

- [ ] **Step 1: Write the failing deployment-script tests**

Add `failVerification = false` to the existing `deploy` helper destructuring, then extend its `pnpm` shim so it records the two environment variables and can fail only verification:

```ts
pnpm: `#!/bin/sh
echo "pnpm $* test_db=${DCC_TEST_DATABASE_URL-unset} restore_db=${DCC_TEST_RESTORE_DATABASE_URL-unset}" >> "$DCC_LOG"
if [ "$DCC_FAIL_VERIFICATION" = 1 ] && [ "$*" = 'verify' ]; then exit 73; fi
if [ "$DCC_FAIL_MIGRATION" = 1 ] && [ "$*" = '--filter database migrate' ]; then exit 72; fi
`,
```

Pass `DCC_TEST_DATABASE_URL: "must-be-unset"`, `DCC_TEST_RESTORE_DATABASE_URL: "must-be-unset"`, and `DCC_FAIL_VERIFICATION` into the spawned script environment. Add these tests:

```ts
it("verifies the staged release locally before migration without test databases", async () => {
  const result = await deploy();

  const installed = result.commands.indexOf("pnpm install --frozen-lockfile");
  const verified = result.commands.indexOf("pnpm verify test_db=unset restore_db=unset");
  const verificationEvent = result.commands.indexOf("--set=stage=local_verification_passed");
  const migrated = result.commands.indexOf("pnpm --filter database migrate");
  expect(verified).toBeGreaterThan(installed);
  expect(verificationEvent).toBeGreaterThan(verified);
  expect(migrated).toBeGreaterThan(verificationEvent);
});

it("keeps the prior release when local verification fails", async () => {
  const result = await deploy({ failVerification: true });

  expect(result.status).toBe(73);
  expect(await readlink(result.current)).toBe(result.previous);
  expect(result.commands).not.toContain("pnpm --filter database migrate");
  expect(result.commands).not.toContain("--set=stage=local_verification_passed");
  expect(result.commands).not.toContain("pm2 startOrReload");
  expect(result.marker).toEqual({ attemptId, sha, exitCode: 73 });
});
```

Replace the final test's CI-workflow assertions with assertions limited to the Superpowers update workflow; this implementation intentionally does not read or require `.github/workflows/ci.yml`.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm exec vitest run scripts/task-8.test.ts --testTimeout=15000`

Expected: FAIL because no `pnpm verify` command or `local_verification_passed` stage exists, and the test still reads the disabled CI workflow.

- [ ] **Step 3: Implement the minimum deployment gate**

Insert exactly these lines after the existing dependency stage and before database migration:

```bash
pnpm install --frozen-lockfile
record_event "dependencies_installed"
env -u DCC_TEST_DATABASE_URL -u DCC_TEST_RESTORE_DATABASE_URL pnpm verify
record_event "local_verification_passed"
pnpm --filter database migrate
```

Do not move the `git fetch`/`FETCH_HEAD` comparison, migration, synchronization, cutover, health check, completion marker, or rollback trap.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm exec vitest run scripts/task-8.test.ts --testTimeout=15000`

Expected: PASS, proving exact-head verification still precedes staging and local verification now precedes migration.

- [ ] **Step 5: Run the combined release regression suite**

Run: `pnpm exec vitest run scripts/webhook-server.test.ts scripts/task-8.test.ts scripts/webhook-deployments.test.ts --testTimeout=15000`

Expected: PASS. The database-backed block in `scripts/webhook-deployments.test.ts` may remain skipped unless `DCC_TEST_DATABASE_URL` names a disposable test database.

- [ ] **Step 6: Commit**

```bash
git add deploy.sh scripts/task-8.test.ts
git commit -m "feat: verify releases locally before migration"
```

### Task 3: Document the operational trigger and verify the branch

**Files:**
- Modify: `README.md:272-291`
- Test: `scripts/task-8.test.ts:265-283`

**Interfaces:**
- Consumes: the existing Updating section and the existing shell-harness test.
- Produces: operational instructions that state signed protected pushes trigger deployment; `deploy.sh` validates the fetched protected SHA and runs local `pnpm verify` before migration; GitHub Actions are not a release prerequisite.

- [ ] **Step 1: Write the failing documentation assertion**

Add a test to the final `task-8` test that reads `README.md` and expects each operational guarantee:

```ts
const readme = await readFile(join(root, "README.md"), "utf8");
expect(readme).toContain("signed protected-branch push");
expect(readme).toContain("pnpm verify locally before migrations");
expect(readme).toContain("GitHub Actions are not a deployment prerequisite");
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm exec vitest run scripts/task-8.test.ts --testTimeout=15000`

Expected: FAIL because the Updating section still says the webhook invokes `deploy.sh` without identifying the signed-push trigger or local verification gate.

- [ ] **Step 3: Update only the Updating section**

Amend the paragraph beginning “The webhook invokes” so it states, in plain language:

```md
A signed protected-branch push queues a deployment; GitHub Actions are not a deployment prerequisite. Before staging or migrating, `deploy.sh` fetches the protected branch and requires its SHA to equal the queued SHA. After installing locked dependencies in the detached release worktree, it runs `pnpm verify` locally before migrations.
```

Keep the following four-argument invocation, inherited launch-pipe requirement, release-worktree details, rollback behavior, and event-recording notes intact.

- [ ] **Step 4: Run focused documentation and release tests**

Run: `pnpm exec vitest run scripts/task-8.test.ts --testTimeout=15000 && git diff --check`

Expected: PASS with no whitespace errors.

- [ ] **Step 5: Run final verification**

Run: `pnpm verify`

Expected: PASS. If an existing unrelated timing flake occurs, rerun its individual test with `--testTimeout=15000`, preserve the original failure output, and do not weaken production verification or the new focused tests.

- [ ] **Step 6: Commit**

```bash
git add README.md scripts/task-8.test.ts
git commit -m "docs: describe local release verification"
```

### Task 4: Stabilize the local verification timeout

**Files:**
- Modify: `scripts/create-admin.test.ts:23-27`

**Interfaces:**
- Consumes: the existing three-process invalid-password test, which deliberately starts `pnpm exec tsx` once for each invalid input.
- Produces: an explicit 15-second per-test budget for that integration-style test; all password assertions and process behavior remain unchanged.

- [ ] **Step 1: Capture the failing full-suite evidence**

Run: `pnpm verify`

Expected: FAIL only at `scripts/create-admin.test.ts > validates empty and forbidden stdin passwords before looking up the user` after the explicit `10_000` millisecond timeout expires, while the rest of the suite remains green or skipped.

- [ ] **Step 2: Confirm the timing hypothesis in isolation**

Run: `pnpm exec vitest run scripts/create-admin.test.ts --testTimeout=15000`

Expected: PASS. This proves the test's three child-process starts complete correctly with the documented diagnostic budget; no application behavior is changed.

- [ ] **Step 3: Make the minimal fix**

Change only the explicit timeout on the first test:

```ts
  }, 15_000);
```

Do not alter the helper, spawned command, assertions, global Vitest timeout, or the second test's three-second EOF guard.

- [ ] **Step 4: Verify the focused test and full local release suite**

Run: `pnpm exec vitest run scripts/create-admin.test.ts --testTimeout=15000 && pnpm verify`

Expected: PASS. The full command must no longer fail from the 10-second budget; any unrelated new failure stops this task for diagnosis.

- [ ] **Step 5: Commit**

```bash
git add scripts/create-admin.test.ts
git commit -m "test: allow create-admin process startup under load"
```
