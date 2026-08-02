# Development Control Center

A ticket-in, reviewed-PR-out workflow: public feedback forms feed tickets,
an admin reviews and approves plans, a worker drives Claude Code executions
against real project repositories, and results land as pull requests.

Two long-running Node processes (`apps/web`, `apps/worker`) share one
PostgreSQL database and a job queue table. No build step — both run
directly via `tsx`.

## Prerequisites (VPS)

- **Node.js 22+** (built and tested on Node 26)
- **pnpm 9+** (`corepack enable` or `npm i -g pnpm`)
- **PostgreSQL 15+**, reachable from the VPS
- **git**, and network access to whatever repos you'll point projects at
- **Claude Code CLI** (`claude`) installed and on `$PATH` — the worker
  shells out to it (`spawn("claude", ...)`) to run executions. Install and
  authenticate it under the same user the worker runs as.
- **Claude Code 2.1.219+**, `bubblewrap`, and `socat` for execution. The
  worker uses Claude Code's native strict Linux sandbox; it fails closed when
  that sandbox is unavailable. Docker is not required.
- A **GitHub token/App** with push + PR access to the repos you'll manage,
  if you want the worker to open pull requests automatically

### Ubuntu 24.04+ execution sandbox

Install the native sandbox dependencies:

```bash
sudo apt-get install bubblewrap socat
```

Ubuntu 24.04+ AppArmor blocks Bubblewrap from creating the user namespaces
needed for isolation. Install the exact Claude Code-recommended profile and
reload AppArmor:

```bash
sudo tee /etc/apparmor.d/bwrap > /dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
sudo systemctl reload apparmor
```

The profile applies to `bwrap`, not commands inside its sandbox. Do not start
execution until Claude Code confirms its sandbox support is available: the
worker refuses unsandboxed execution rather than falling back. Claude runs in
a temporary private clone with egress restricted to Claude service domains;
it cannot reach GitHub or receive worker credentials.
The worker verifies the result in worker-owned staging before touching its
publishable worktree. Validation commands receive a scrubbed environment and
no network namespace; the worker re-enumerates and secret-scans their final
output before creating the squashed final commit, pushing, and opening the
draft PR.

## 1. Clone and install

```bash
git clone https://github.com/<you>/dev-control.git
cd dev-control
corepack enable
pnpm install
```

## 2. Provision PostgreSQL

```bash
sudo -u postgres psql <<'SQL'
CREATE USER dcc WITH PASSWORD 'change-me';
CREATE DATABASE dcc OWNER dcc;
SQL
```

## 3. Configure environment

Create a `.env` file at the repo root (or export these in your process
manager's environment — nothing in this repo auto-loads `.env`, so wire it
up via systemd `EnvironmentFile=`, pm2's `env`, or similar):

```bash
# Required
DATABASE_URL=postgresql://dcc:change-me@127.0.0.1:5432/dcc

# Web process
PORT=3000                                # apps/web listens here
APP_BASE_URL=https://control.example.com # used to build links in notifications

# Worker process — Claude Code auth (pick whichever your `claude` CLI uses)
CLAUDE_CODE_OAUTH_TOKEN=...

# GitHub API (omit to use https://api.github.com)
GITHUB_API_BASE_URL=https://api.github.com

# Optional overrides (sane defaults if unset)
DB_POOL_SIZE=10
DCC_DATA_DIR=./data              # managed artifact root for web, worker, and reconciliation
DCC_DATA_ROOT=.                  # compatibility fallback: artifacts live in $DCC_DATA_ROOT/data when DCC_DATA_DIR is unset
DCC_SKILLS_ROOT=.                # worker: where skill definitions are read from
PROJECTS_CONFIG_PATH=./config/projects.yaml
```

Then source it in your shell for the one-off setup commands below:

```bash
set -a; source .env; set +a
```

## 4. Run database migrations

```bash
pnpm --filter database migrate
```

Re-run this after every `git pull` that touches `packages/database/migrations/`.

## 5. Configure projects, skills, and notification providers

Three YAML files under `config/` drive the app; all start empty:

- **`config/projects.yaml`** — the repositories the worker can execute
  against (repo path/URL, default branch, install/lint/test/build
  commands, protected paths). Add one entry per project before creating
  tickets against it.
- **`config/notification-providers.yaml`** — webhook/Slack/etc. targets
  for workflow notifications. Optional; delivery failures never block the
  ticket workflow.
- **`config/system.yaml`** — system-level settings.

Edit these directly on the VPS (they're config, not secrets — but don't
commit real webhook URLs/tokens into a public fork).

## 6. Create the first admin user

```bash
pnpm admin:create -- --username admin --password 'a-strong-password' --non-interactive
```

## 7. Run it

**Quick check (foreground, both processes, restarts on file change):**

```bash
pnpm dev
```

This starts `apps/web` (the admin UI + public form + API, port `$PORT`)
and `apps/worker` (the job queue consumer that drives Claude Code
executions) together and logs both to your terminal. Fine for a first
smoke test; not what you want for a VPS you'll walk away from.

**Production — run each process under a supervisor** so it survives
crashes and reboots. Example with `systemd` (two unit files):

`/etc/systemd/system/dcc-web.service`:

```ini
[Unit]
Description=Development Control Center — web
After=network.target postgresql.service

[Service]
Type=simple
User=dcc
WorkingDirectory=/opt/dev-control
EnvironmentFile=/opt/dev-control/.env
ExecStart=/usr/bin/env pnpm --filter web dev
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/dcc-worker.service`:

```ini
[Unit]
Description=Development Control Center — worker
After=network.target postgresql.service

[Service]
Type=simple
User=dcc
WorkingDirectory=/opt/dev-control
EnvironmentFile=/opt/dev-control/.env
ExecStart=/usr/bin/env pnpm --filter worker start
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dcc-web dcc-worker
sudo systemctl status dcc-web dcc-worker
```

(`apps/web` only has a `dev` script — `tsx watch`, which is fine to run
under systemd too; it just also restarts on source-file changes, which is
harmless in production since you deploy via `git pull` + restart anyway.)

## 8. Put it behind a reverse proxy + TLS

Point nginx/Caddy at `127.0.0.1:$PORT` and terminate TLS there. Example
Caddyfile:

```
control.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Make sure `APP_BASE_URL` in `.env` matches the public HTTPS URL — it's
used to build links in outgoing notifications.

## Updating

The deployment webhook runs `deploy.sh <merged-sha>`. It installs locked
dependencies, migrates the database, syncs agent content, then restarts the
application only if every prior step succeeds.

```bash
cd /opt/dev-control
git pull
pnpm install --frozen-lockfile
pnpm --filter database migrate
pnpm exec tsx scripts/sync-agent-content.ts
sudo systemctl restart dcc-web dcc-worker
```

To roll back code, redeploy the previous known-good SHA with `deploy.sh`.
Migrations are forward-only: restore the database backup or ship a forward
fix for a schema problem; do not reset a production database to roll back.

### Superpowers updates

The **Superpowers Update** workflow runs daily at 04:17 UTC. It imports the
latest tagged `obra/superpowers` release into an
`automation/superpowers-<tag>` PR; review and merge that PR to activate it.
Use **Run workflow** with an exact `vX.Y.Z` tag to override the resolved
latest release. Leaving the tag empty uses the latest release again.

## Data layout

Everything under `$DCC_DATA_DIR` (or `$DCC_DATA_ROOT/data` when `DCC_DATA_DIR` is unset) is managed artifact state: uploaded attachments, execution logs, and worktrees. Plans are immutable database rows; skill bundles are temporary and reconstructed for each run. Back this directory up with the database — losing it does not corrupt the DB, but it loses execution history and in-flight artifacts.

## Backups and recovery drills

Backups are external scheduled work. Configure the process environment with:

```bash
DCC_BACKUP_DIRECTORY=/var/backups/dcc
DCC_BACKUP_RETENTION_DAYS=30
DCC_DATA_DIR=/opt/dev-control/data
DCC_CONFIG_DIR=/opt/dev-control/config

# Required only for restore drills — this must be a separate, disposable database.
DCC_RESTORE_DATABASE_URL=postgresql://dcc:change-me@127.0.0.1:5432/dcc_restore
DCC_RESTORE_HEALTH_URL=http://127.0.0.1:3100/api/health
```

Install an external cron entry for **03:15 Europe/Amsterdam**. Cron does not inherit your service environment, so source the same environment file explicitly:

```cron
CRON_TZ=Europe/Amsterdam
15 3 * * * cd /opt/dev-control && set -a && . ./.env && set +a && /usr/bin/env bash scripts/backup.sh >> /var/log/dcc-backup.log 2>&1
```

Each backup is atomically published as one directory containing database.dump, managed data/ (and legacy-data/ when DCC_DATA_DIR differs from DCC_DATA_ROOT/data), managed config/, and manifest-v1.sha256. .env files and secrets/, .key, .pem, and .secret paths are excluded; backup directories are also excluded from the managed-data copy. Successful runs apply DCC_BACKUP_RETENTION_DAYS.

Run the recovery drill after a successful backup:

```bash
set -a; source .env; set +a
scripts/restore-drill.sh /var/backups/dcc/dcc-YYYYMMDDTHHMMSSZ-PID
```

The drill verifies the manifest before it calls pg_restore, restores only to the explicit DCC_RESTORE_DATABASE_URL, checks the explicit DCC_RESTORE_HEALTH_URL, and writes a passed or failed result to backup_recovery_verifications through the primary DATABASE_URL. It rejects the primary database and requires a durable database-scoped marker set with PostgreSQL configuration; session and role options do not qualify: `psql -d postgres --command "ALTER DATABASE dcc_restore SET dcc.restore_disposable = true"`. Never set that marker on production. The System health page reports configured retention and recorded verification, but cannot inspect an external host crontab.

Start a separate health process against the restore target before the drill (in another terminal):

```bash
DATABASE_URL="$DCC_RESTORE_DATABASE_URL" HOST=127.0.0.1 PORT=3100 pnpm exec tsx apps/web/src/server.ts
export DCC_RESTORE_HEALTH_URL=http://127.0.0.1:3100/api/health
```

## Recovery integration test

`scripts/backup.integration.test.ts` is intentionally skipped unless **both** `DCC_TEST_DATABASE_URL` and `DCC_TEST_RESTORE_DATABASE_URL` are set. A CI job that runs it must provide distinct, disposable databases; the primary and restore databases must already be marked `dcc.restore_disposable=true`; the test refuses unmarked targets before any reset. These variables never default to `DATABASE_URL` or a production target.

## Troubleshooting

- **Worker can't find `claude`:** confirm `which claude` resolves for the
  `dcc-worker` systemd user specifically (`sudo -u dcc which claude`), not
  just your login shell.
- **Migrations fail on a fresh DB:** confirm `DATABASE_URL` is set in the
  shell you're running `pnpm --filter database migrate` from — it isn't
  read from `.env` automatically.
- **Admin login locked out:** the app rate-limits failed logins per
  account; wait out the lockout window or create a second admin via
  `pnpm admin:create`.
