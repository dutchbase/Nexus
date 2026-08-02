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
- A **GitHub token/App** with push + PR access to the repos you'll manage,
  if you want the worker to open pull requests automatically

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
DCC_DATA_DIR=./data              # web: file uploads land in $DCC_DATA_DIR/uploads
DCC_DATA_ROOT=.                  # worker: ticket plans/logs/skill bundles under $DCC_DATA_ROOT/data
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

Everything under `$DCC_DATA_ROOT/data/` is worker-managed state:
uploaded attachments, per-ticket plan snapshots, execution logs, and
materialized skill bundles. Back this directory up along with the
database — losing it doesn't corrupt the DB, but you lose execution
history and in-flight plan artifacts.

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
