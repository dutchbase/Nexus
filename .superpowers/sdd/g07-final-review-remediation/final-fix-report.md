# G07 final-review remediation

## Scope

Completed only the requested final-review fixes. Durable execution identity and immutable merge-target binding remain untouched.

## Files changed

- `deploy.sh`, `scripts/task-8.test.ts` — deploy PM2 apps through `ecosystem.config.cjs`.
- `apps/web/src/security.ts`, `apps/web/src/security.test.ts` — reject every known worker-only credential in production, including all `DCC_NOTIFICATION_SECRET_*` names and the subscription guard's Anthropic/provider variables.
- `apps/web/src/pages/dashboard.ts`, `apps/web/src/pages/operate.ts`, `apps/web/src/dashboard-boundary.test.ts` — remove web credential probes and retain the existing non-secret job-claim heartbeat for worker health.
- `packages/notification-provider/src/index.ts`, `packages/notification-provider/src/config.test.ts`, `apps/web/src/ui.ts`, `apps/web/src/provider-boundary.test.ts` — accept only explicit `authentication: null` as a PATCH clear; merge removes the stored authentication and sends without an authorization header.
- `packages/database/src/password.ts`, `scripts/create-admin.ts`, `scripts/create-admin.test.ts` — reuse the password validator before the username lookup.
- `apps/worker/src/role.test.ts` — verify missing and wrong worker roles fail startup.
- `.env.worker` (ignored operational file) — documents the worker-only `DCC_NOTIFICATION_SECRET_<NAME>` convention without any literal secret.

## Finding coverage

1. Deployment now runs exactly:
   - `pm2 startOrReload ecosystem.config.cjs --only dcc-web --update-env`
   - `pm2 startOrReload ecosystem.config.cjs --only dcc-worker --update-env`
   - `pm2 startOrReload ecosystem.config.cjs --only dcc-webhook --update-env`
   The focused deploy test asserts the command order and success marker timing.
2. Production web rejects GitHub, Claude OAuth, all subscription-guard Anthropic/provider variables, and any populated `DCC_NOTIFICATION_SECRET_*` name. Dashboard/settings credential probes were removed; worker health remains the `jobs.claimed_at` heartbeat. Focused security and dashboard-boundary tests cover this.
3. The UI sends `authentication: null` only for an existing provider with “None” selected. The partial patch treats this as a clear, and the provider regression verifies no authorization header is sent.
4. Empty, NUL, and newline stdin passwords now fail the shared validator before the script can query an existing username.
5. Missing and wrong `DCC_PROCESS_ROLE` worker startups both fail closed with the existing role error.

## RED evidence

Before implementation, ran:

```sh
pnpm exec vitest run scripts/task-8.test.ts apps/web/src/security.test.ts apps/web/src/dashboard-boundary.test.ts apps/web/src/provider-boundary.test.ts packages/notification-provider/src/config.test.ts scripts/create-admin.test.ts apps/worker/src/role.test.ts
```

Result: six expected failures: old PM2 restart commands, incomplete web credential rejection, dashboard environment probes, missing UI clear value, PATCH preservation of authentication, and invalid stdin reaching the database lookup. The newly added worker-role test passed because it covers an already-existing fail-closed invariant.

## GREEN evidence

Ran:

```sh
pnpm exec tsc --noEmit
pnpm exec vitest run scripts/task-8.test.ts apps/web/src/security.test.ts apps/web/src/dashboard-boundary.test.ts apps/web/src/provider-boundary.test.ts packages/notification-provider/src/config.test.ts scripts/create-admin.test.ts apps/worker/src/role.test.ts
```

Results: TypeScript exited 0. Vitest exited 0: 7 files and 28 tests passed.

## Concerns

`.env.worker` is intentionally ignored and is not part of the commit, so it cannot overwrite a deployment's secrets during `git reset --hard`. Its documentation must be present in the deployment root alongside the actual worker-only values. No full-suite run was performed: the requested verification scope was the named focused tests plus `tsc`.
