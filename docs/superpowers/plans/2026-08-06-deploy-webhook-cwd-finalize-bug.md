# Deploy Webhook `isCurrentReleaseFn` Finalization Bug — Fix Plan

> **Status:** Diagnosed and manually worked around for one incident (commit `8ac175a`, attempt `0748597d-6fe8-4dbb-bd74-5aeaa5b19a3d`) on 2026-08-05. This plan documents root cause and a permanent fix — not yet implemented.

**Goal:** Stop successful deploys from getting stuck in `deployment_attempts.state='running'` forever, which serializes and blocks every subsequent deploy to the same branch.

## Context

While merging `g10-operational-truth` into `master` and pushing (2026-08-05 ~20:37 UTC), the automated deploy for the merge commit never launched. Investigation found a **different, unrelated, already-stuck deployment attempt** blocking the queue:

- `deployment_attempts` row `0748597d-6fe8-4dbb-bd74-5aeaa5b19a3d` (target commit `8ac175a`, the pre-merge `master` HEAD) had `state='running'` with `started_at = 2026-08-05 14:39:17 UTC` — over 6 hours stale by the time it was found.
- Its child process (PID recorded in `child_pid`) was confirmed dead.
- Its completion marker file (`.deploy-state/completions/0748597d-....done`) existed with `{"exitCode":0,"reloadPending":true}` — i.e. `deploy.sh` for that commit had **already succeeded**: cutover happened, the health check passed, `.deploy-current` correctly pointed at `8ac175a`.
- Despite this, the attempt was never finalized to `state='succeeded'`, on any of the ~50+ restarts `dcc-webhook` went through in that window (each successful deploy's last step is `pm2 startOrReload ... dcc-webhook`, which self-restarts it — that restart count is normal, not a crash loop).

**Root cause:** `apps/../webhook-server.js`'s default `isCurrentReleaseFn` (used to decide whether a `{exitCode:0, reloadPending:true}` marker means the deploy is *actually* done) is:

```js
isCurrentReleaseFn = (markerSha) => {
  try {
    const currentRelease = fsModule.realpathSync(config.currentReleaseLink);
    return currentRelease === fsModule.realpathSync(process.cwd()) && path.basename(currentRelease) === markerSha;
  } catch { return false; }
}
```

It requires the **webhook process's own `process.cwd()`** to equal `.deploy-current`'s resolved target. Confirmed directly: `pm2 describe dcc-webhook` reports `exec cwd = /home/deploy/projects/dev-control` — the plain repo checkout, never a `.deploy-releases/<sha>` path. `ecosystem.config.cjs` sets `cwd: __dirname` for every app, and `deploy.sh`'s final step (`pm2 startOrReload "$CURRENT/ecosystem.config.cjs" --only dcc-webhook --update-env`) evidently does not cause pm2 to re-resolve `cwd` for an already-registered fork-mode app — `--update-env` refreshes environment variables, not the process's working directory. So this comparison is **structurally unsatisfiable** as currently deployed, not an intermittent race: every future `pendingSuccess` marker will fail it, forever, until `dcc-webhook` is fully deleted and re-added in pm2 (which would only fix it until the next deploy moves `.deploy-current` again).

This explains why the same symptom will recur on literally the next successful deploy unless fixed.

**Why the existing test suite didn't catch it:** `scripts/webhook-server.test.ts` calls `createWebhook({..., isCurrentReleaseFn: overrides.isCurrentReleaseFn, ...})` in every test — the *default* implementation (the one with the actual bug) is never exercised; every test substitutes its own mock. No test asserts anything about the real `cwd`-comparison logic.

## Recommended Fix

Drop the `process.cwd()` half of the check. By the time `deploy.sh` writes a `{exitCode:0, reloadPending:true}` marker, it has already: atomically swapped the `.deploy-current` symlink (`switch_current`), reloaded `dcc-web`/`dcc-worker` from the new path, and confirmed `DCC_DEPLOY_HEALTH_URL` returns success against the new release. The symlink target is already the verified source of truth for "what's currently deployed" — the webhook process's own resolved `cwd` adds nothing but a false negative given how pm2 actually behaves here.

```js
isCurrentReleaseFn = (markerSha) => {
  try {
    return path.basename(fsModule.realpathSync(config.currentReleaseLink)) === markerSha;
  } catch { return false; }
}
```

**Rejected alternative:** changing `deploy.sh`'s final step from `pm2 startOrReload` to `pm2 delete dcc-webhook && pm2 start ...` to force pm2 to pick up the new `cwd` on every deploy. This preserves the check's original intent (verifying the *running* webhook process itself reloaded) but trades a targeted one-line fix for a behavior change with a real (if brief) listener-availability gap, and doesn't address whatever else in this deployment's pm2 setup might implicitly assume `cwd` tracks the release path — worth a separate look, but out of scope for unblocking deploys.

## Files

- Modify: `webhook-server.js` (the `isCurrentReleaseFn` default parameter, top of `createWebhook`)
- Test: `scripts/webhook-server.test.ts` — add a test that exercises the **real default** `isCurrentReleaseFn` (don't pass an override), verifying it returns `true` when `.deploy-current` resolves to a directory named `<markerSha>` regardless of `process.cwd()`, and `false` otherwise. This is the regression test that would have caught the bug: construct a temp `.deploy-current` symlink pointing at a directory named after a fake SHA, call `finalizeAttempt` (or `createWebhook(...)` without overriding `isCurrentReleaseFn`) from a `process.cwd()` that is deliberately *not* that directory, and assert the attempt still finalizes to `succeeded`.

## Operational follow-up (separate from the code fix)

This incident sat undetected for 6+ hours because nothing surfaces "a deploy has been stuck in `running` past its lease+grace window." Given the G10-operational-truth work just landed a real worker-heartbeat/health pattern for exactly this class of problem (`workers` table + `workerHealth` in `apps/web/src/pages/shared.ts`), the same shape applies here: a simple check — `deployment_attempts` has a `running` row with `updated_at` older than, say, `2 * leaseMs` — surfaced on the existing System health page (`apps/web/src/pages/operate.ts`) or as a notification, would have caught this within minutes instead of silently blocking every deploy for most of a day. Worth a small follow-up finding/task, not bundled into this fix.

## Verification

1. `pnpm exec vitest run scripts/webhook-server.test.ts` — existing suite plus the new default-`isCurrentReleaseFn` test, all passing.
2. `pnpm exec tsc --noEmit` (this repo's `scripts/*.test.ts` are type-checked).
3. Deploy this fix itself through the normal pipeline once merged, and confirm via `deployment_attempts` that its own attempt reaches `state='succeeded'` without manual intervention — the fix validating itself is the strongest evidence it works.

## Incident record

The stuck attempt for `8ac175a` needs the same manual close-out this investigation proposed (state set to `succeeded`, matching exactly what `completeDeploymentAttempt` would set, plus a `deployment_events` row documenting the manual recovery and its justification) — verified safe to apply: dead child PID, valid `{exitCode:0,reloadPending:true}` marker, and `.deploy-current` already correctly pointing at that commit. The auto-mode classifier blocked the agent from executing this write directly; the exact SQL was handed to the operator to run by hand. No application code or running release needs to be touched — only deployment bookkeeping. Once applied, `pm2 restart dcc-webhook` lets the queue advance and launch the deploy for the `g10-operational-truth` merge commit (`05b889664f48cbebe7819fcbb701f456df958fd7`).
