# G05 Deployment Safety Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILLS: use `plan-orchestrator`, then `superpowers:subagent-driven-development`, `superpowers:test-driven-development`, ponytail full, and `superpowers:verification-before-completion`.

**Goal:** Remediate only G05-F01 through G05-F07 with protected-head authorization, durable deployment history, recoverable staged releases, bounded webhook handling, safe notifications, and shell-free process launch.

**Architecture:** Keep the webhook as deploy owner, but replace local JSON authority with PostgreSQL deployment attempts, leases, and append-only events. Stage immutable git worktree releases, atomically switch a `current` symlink, health-gate the cutover, and restore the prior release on failure.

**Tech Stack:** Node.js CommonJS, PostgreSQL, Bash, native `fetch`/`spawn`, PM2, Vitest.

## Global Constraints

- Branch: `agent/g05-deployment-safety`; never modify, commit, merge, or push `master`/`main`.
- Scope is exactly G05-F01 through G05-F07. No deployment UI, generic worker job, dedicated deploy service, GitHub App work, or other audit/roadmap findings.
- Add no dependency: move the already-installed `pg` package from root `devDependencies` to runtime `dependencies`.
- Every behavior change begins with a focused failing regression test. Keep changes minimal and use native Node/Postgres/Bash facilities.
- The webhook remains the deployment executor; PostgreSQL is the authorization/history source. Marker, log, symlink, and PID data cannot authorize a deployment.
- Missing notification configuration disables only notifications and is durably visible; it never rewrites deployment success.
- Deployment migrations must remain compatible with the immediately previous release so automatic code rollback is safe.

---

### Task 1: Durable Deployment Attempts, Leases, and Events

**Files:**
- Create: `packages/database/migrations/042_deployment_safety.sql`, `webhook-deployments.js`, `scripts/webhook-deployments.test.ts`
- Modify: `packages/database/src/migrate.test.ts`, `package.json`, `pnpm-lock.yaml`

**Interfaces:**
- `deployment_attempts` stores immutable delivery/event/target/protected-head/check evidence and mutable owner, lease, recovery, marker, prior-release, notification, and lifecycle fields.
- States: `rejected`, `queued`, `running`, `succeeded`, `failed`, `blocked`.
- `deployment_events` is append-only with unique `(attempt_id,event_key)` and safe metadata only.
- A transaction-scoped advisory lock serializes claim/promotion. Recovery occurs once; a second expiry blocks. Failed/blocked attempts never automatically promote the queue.

- [ ] Write failing tests for immutable identity, append-only events, duplicate delivery IDs, one running attempt, lease renew/recovery/blocking, and SHA deduplication.
- [ ] Run `pnpm exec vitest run scripts/webhook-deployments.test.ts packages/database/src/migrate.test.ts` and verify RED.
- [ ] Implement migration 042 and minimal function-based PostgreSQL store; no class/factory hierarchy.
- [ ] Re-run the focused tests and commit: `git commit -m "feat: persist durable deployment attempts"`.

### Task 2: Protected-Head Webhook and Safe Launch/Notifications

**Files:**
- Modify: `webhook-server.js`
- Create: `scripts/webhook-server.test.ts`

**Interfaces:**
- Require `DEPLOY_PROTECTED_BRANCH`; accept only an exact current GitHub branch head before queueing and immediately before process launch.
- `launchDeploy(sha, markerPath, attemptId, protectedBranch)` invokes the script through argv with `shell:false`, detached mode, and an opened log descriptor.
- Marker JSON is `{ attemptId, sha, exitCode }`; malformed/mismatched markers block the attempt.
- Oversize requests return exactly `413 webhook_body_too_large` and never authenticate, parse, or deploy.
- Notification outcomes are `accepted`, `failed_http`, `failed_network`, or `disabled_config`; logs/events never expose recipient, authorization, response body, or webhook body.

- [ ] Write failing tests for feature/stale/protected head checks, queued revalidation, duplicate delivery, corrupt marker, one recovery, shell metacharacter paths, 1 MiB body handling, and notification results/redaction.
- [ ] Run `pnpm exec vitest run scripts/webhook-server.test.ts scripts/webhook-deployments.test.ts` and verify RED.
- [ ] Replace local JSON lock/outcome authority with Task 1’s store; retain marker/log files only as artifacts. Use bounded native fetch and check `Response.ok`.
- [ ] Re-run focused tests and commit: `git commit -m "fix: authorize and launch deployments safely"`.

### Task 3: Health-Gated Worktree Release Transaction

**Files:**
- Modify: `deploy.sh`, `scripts/task-8.test.ts`, `.gitignore`, `README.md`

**Interfaces:**
- `deploy.sh <40-char-sha> <absolute-marker-path> <attempt-uuid> <protected-branch>`.
- Required environment: `DATABASE_URL`, `DCC_DEPLOY_HEALTH_URL`; releases default to `$DCC_ROOT/.deploy-releases`, current link to `$DCC_ROOT/.deploy-current`.

- [ ] Write failing harness tests for frozen install, migration failure before cutover, health/partial-restart rollback, prior-release preservation, atomic current-link cutover, and marker before webhook reload.
- [ ] Run `pnpm exec vitest run scripts/task-8.test.ts` and verify RED.
- [ ] Implement: validate inputs; verify fetched protected head; stage detached worktree; link stable env/data; frozen install, migrate, sync; atomically switch current; reload web/worker; health check; persist stage events; write marker; then reload webhook.
- [ ] On failure restore the prior link and processes, health-check recovery, append rollback evidence, and write a nonzero marker. Do not auto-promote queued work after failure.
- [ ] Document environment, migration compatibility, recovery queries/procedure, bootstrap behavior, and manual release cleanup. Ignore release/current paths.
- [ ] Re-run focused tests and commit: `git commit -m "fix: health-gate recoverable releases"`.

### Task 4: Final Verification and Publication

- [ ] Run `pnpm exec vitest run scripts/webhook-deployments.test.ts scripts/webhook-server.test.ts scripts/task-8.test.ts packages/database/src/migrate.test.ts`.
- [ ] Run `pnpm exec tsc --noEmit`, `pnpm exec vitest run apps packages`, and `git diff --check`.
- [ ] Run a whole-branch security review, fix only confirmed G05 regressions, then repeat all checks.
- [ ] Push `agent/g05-deployment-safety` and create a draft PR to `master`; keep the worktree for review feedback.

## Assumptions

- Release-directory pruning, deployment UI, generic worker ownership, and a separate deploy service are out of scope.
- The production environment provides `git`, `pnpm`, `pm2`, `curl`, and `psql`, consistent with existing deployment/recovery scripts.
