# Deployment Runbook (for operators and AI agents)

Production deployment is automated: a push to `master` hits the webhook on
the VPS (port 9003), which spawns `deploy.sh`. The script stages a detached
release worktree, verifies, migrates, cuts over `.deploy-current`, restarts
pm2 apps (`dcc-web`, `dcc-worker`, `dcc-webhook`), health-checks, then hands
finalization to the fresh webhook. If everything works you do nothing.

**This runbook is for when that automation fails.**

Server: `ssh <your-deploy-host>` (whatever user your deploy process runs
as). Repo root: `$DCC_ROOT` (defaults to `/opt/nexus` — see `deploy.sh`; a
checkout whose `origin/master` tracks GitHub). Live releases:
`$DCC_ROOT/.deploy-releases/<sha>`, selected by the `.deploy-current`
symlink. pm2 manages the three processes (`dcc-web`, `dcc-worker`,
`dcc-webhook`); if you installed Node via nvm, pm2 may only be on `PATH`
under nvm's shim — prefix commands with
`export PATH=$(dirname "$(nvm which node)"):$PATH` if `pm2` isn't found.

## 1. Diagnose: what state is the deployment in?

```bash
cd "$DCC_ROOT"
set -a; source .env; set +a
psql "$DATABASE_URL" -tAc "SELECT state,target_sha,created_at FROM deployment_attempts ORDER BY created_at DESC LIMIT 5"
ls -la .deploy-state/completions/ | tail -3      # completion markers (.done)
readlink -f .deploy-current                       # what SHOULD be live
pm2 ls                                            # what IS live
```

Also useful: the per-attempt log is `.deploy-state/logs/<attempt-id>.log`
(ends with stage evidence; failures show the failing verify/migrate output).

State meanings:
- `succeeded` — done; if apps still look stale see §4 anyway.
- `running` for >10 min — stuck; usually the webhook died mid-swap (§3-A).
- `failed` — read the attempt log; almost always `pnpm verify` (fix code,
  push again) or a transient network error during install/fetch (just
  re-trigger, §3-C).
- `superseded` — normal; a newer push landed for the same branch while this
  one was still queued, so it was skipped rather than run. Only the newest
  queued attempt per branch ever runs. If a burst of merges left production
  looking stale, check the *newest* attempt's state, not an older one that
  shows `failed` with `deploy.sh: fetched protected head does not match
  target SHA` — that specific error on an attempt superseded by a newer push
  is expected and does not need retriggering.

### Automated staleness alert

`dcc-webhook` checks, once at boot and then every `DEPLOY_STALE_ALERT_INTERVAL_MS`
(default 5 min), whether the newest `deployment_attempts` row for
`DEPLOY_PROTECTED_BRANCH` is older than `DEPLOY_STALE_ALERT_THRESHOLD_MS`
(default 15 min) without reaching `succeeded` (a `queued`, `running`,
`failed`, or `blocked` newest attempt counts as stale; `succeeded`,
`superseded`, and `rejected` don't). When it is, a WhatsApp message goes out
over the same channel deploy-completion notifications already use. It
re-alerts roughly once per interval window while the condition persists —
not a single fire-and-forget, not a continuous spam.

**Known blind spot:** this check runs *inside* `dcc-webhook` itself, so if
that process is fully down or crash-looping (as happened in the
`DEPLOY_STATE_DIR`/`DCC_ROOT` incident on 2026-08-27), no alert fires —
there's no external dead-man's-switch yet. `cron_check_ins` has a write path
for exactly this kind of external liveness check but no read path built —
that's a separate, larger gap, not covered here.

## 2. Is the live release actually current?

The historical failure mode: `.deploy-current` points at the new SHA but pm2
processes were started from an older release directory (stale exec cwd).

```bash
for a in dcc-web dcc-worker dcc-webhook; do echo -n "$a: "; \
  pm2 describe $a | grep -o 'releases/[a-f0-9]\{8\}' | head -1; done
```

Every line must show the same SHA as `readlink -f .deploy-current`. If not,
jump to §3-A (do NOT just `pm2 restart` — restart keeps the stale cwd).

## 3. Recovery scenarios

### A. Attempt stuck `running` / processes on an old release (webhook died mid-swap)

```bash
export PATH=$(dirname "$(nvm which node)"):$PATH   # only if pm2 isn't already on PATH
cd "$DCC_ROOT"
pm2 delete dcc-webhook >/dev/null 2>&1
pm2 start .deploy-current/ecosystem.config.cjs --only dcc-webhook
sleep 5
# The fresh webhook's boot recovery finalizes any reloadPending marker:
psql "$DATABASE_URL" -tAc "SELECT state FROM deployment_attempts ORDER BY created_at DESC LIMIT 1"
```

If web/worker are ALSO on the wrong release, repeat the delete+start for
`dcc-web` and `dcc-worker` (same command shape), then re-run the check in §2.
Since commit `160ee63` this whole class is automated (detached
`scripts/webhook-reload.sh` survives the tree-kill); manual nudges should be
rare.

### B. Webhook process dead entirely

Same as §3-A first block. **Important:** GitHub push deliveries that arrived
while nothing listened on :9003 are lost forever. After restoring the
webhook, retrigger a deployment with an empty commit:

```bash
git commit --allow-empty -m "chore: retrigger deployment" && git push
```

### C. Re-trigger a deployment without a code change

```bash
git commit --allow-empty -m "chore: retrigger deployment" && git push
```

### D. Full manual deployment (automation unusable)

Only after confirming no attempt is `running` (§1):

```bash
cd "$DCC_ROOT"
git pull --ff-only
set -a; source .env; source .env.worker; set +a   # releases have no .env!
SHA=$(git rev-parse origin/master)
git fetch --no-tags origin master
git worktree add --detach ".deploy-releases/$SHA" "$SHA"
cd ".deploy-releases/$SHA"
ln -sfn ../../.env .env && ln -sfn ../../data data   # both live at $DCC_ROOT
pnpm install --frozen-lockfile
pnpm verify
pnpm --filter database migrate
# switch over (release sits at <root>/.deploy-releases/<sha>)
ln -sfn "$(pwd)" ../.deploy-current.tmp && mv -Tf ../.deploy-current.tmp ../.deploy-current
cd "$DCC_ROOT"
pm2 delete dcc-web dcc-worker dcc-webhook
pm2 start .deploy-current/ecosystem.config.cjs
curl --fail http://127.0.0.1:3000/api/health
```

Then reconcile the bookkeeping so future pushes aren't blocked:

```sql
-- mark the manual attempt terminal (replace ids):
UPDATE deployment_attempts SET state='succeeded', completed_at=now()
 WHERE state='running' ORDER BY created_at DESC LIMIT 1;
```

(Or simply let the next real push create a fresh attempt.)

## 4. Hard rules

- **Never** reset or rewind the database; migrations are forward-only.
- **Never** `git reset`/`checkout` the root checkout to another SHA while an
  attempt is running — the webhook executes `<root>/…/deploy.sh` bookkeeping
  against `deployment_attempts`.
- Releases under `.deploy-releases/` are kept for rollback; delete only ones
  older than the current release AND referenced by no
  `deployment_attempts.prior_release_path`.
- `pnpm verify` must pass locally before pushing — CI and deploy.sh both run
  it; a red verify = failed deployment = wasted cycle.
- After ANY recovery, confirm: `pm2 describe` cwd matches
  `.deploy-current`, `/api/health` returns 200, and
  `SELECT state … ORDER BY created_at DESC LIMIT 1` shows `succeeded`.
