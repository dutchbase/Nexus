# Nexus

An open-source control center for software projects, AI-assisted development
workflows, pull requests, jobs, and deployments.

## What is Nexus?

Nexus turns a ticket-in, reviewed-PR-out workflow into one controlled
pipeline: public feedback forms feed tickets, an administrator reviews and
approves execution plans, a worker drives AI coding-agent executions against
real project repositories, and results land as pull requests ready for
human review. It also manages the promotion of reviewed changes to
production and keeps an audit trail of the whole path.

Nexus is not tied to one company, one deployment target, or one
infrastructure setup — it's a self-hosted app you run against your own
GitHub repositories and your own Postgres database.

## Features

- **Ticket intake** — public feedback/intake forms that funnel into a
  reviewable ticket queue
- **Planning & execution jobs** — an AI worker drives coding-agent runs
  against your repositories, from an approved plan to a pushed branch
- **Pull request review** — track PR status, policy checks, and merge
  eligibility from one dashboard
- **Production promotion workflows** — controlled, auditable promotion of
  reviewed changes to production, including automated deployment for
  projects that opt in
- **Notifications** — pluggable delivery (webhook/Slack/etc.) for workflow
  events
- **Repository & system health** — visibility into project repository
  status, worker health, and job queue state

## Project status

Nexus is under active development. The core ticket → plan → execute → PR
workflow is in daily production use; some features (e.g. the production
promotion workflow) are opt-in per project and still maturing. Expect
breaking config/schema changes to be called out clearly in release notes —
this is not yet a stable 1.0.

## Prerequisites

- **Node.js 22+** (built and tested on Node 26)
- **pnpm 11** (declared in `packageManager`; `pnpm install` validates
  versions via `engine-strict`)
- **PostgreSQL 15+**, reachable from wherever you run Nexus
- **gcc** and the **libargon2 runtime** (`libargon2-1` on Debian/Ubuntu) —
  `pnpm install` compiles the Argon2 password-hashing helper via
  `postinstall` (`scripts/build-argon2.ts`)
- **git**, and network access to whatever repositories you'll point
  projects at
- **Claude Code CLI** (`claude`) installed and on `$PATH` — the worker
  shells out to it to run executions. Install and authenticate it under the
  same user the worker runs as.
- **Claude Code 2.1.219+**, `bubblewrap`, and `socat` for execution — the
  worker uses Claude Code's native strict Linux sandbox and fails closed
  when that sandbox is unavailable. **Docker is not required.**
- A **GitHub token or GitHub App** with push + pull-request access to the
  repositories you'll manage, if you want the worker to open pull requests
  automatically. See [GitHub integration](#github-integration) below.

Tested on Ubuntu 24.04+; other modern Linux distributions should work but
aren't specifically verified.

### Ubuntu 24.04+ execution sandbox

Install the native sandbox dependencies:

```bash
sudo apt-get install bubblewrap socat
```

Ubuntu 24.04+'s AppArmor policy blocks Bubblewrap from creating the user
namespaces isolation needs. Install the Claude Code-recommended profile and
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

Do not start execution work until Claude Code confirms its sandbox support
is available — the worker refuses unsandboxed execution rather than falling
back. Claude runs in a temporary private clone with egress restricted to
Claude's own service domains; it cannot reach GitHub or receive worker
credentials directly. The worker verifies results in worker-owned staging
before touching its publishable worktree, re-scans final output for
secrets, then creates a squashed commit, pushes, and opens a draft PR.

## Installation

```bash
git clone https://github.com/dutchbase/dev-control.git
cd dev-control
corepack enable
pnpm install
```

Verify the install:

```bash
pnpm verify
```

This runs TypeScript type-checking plus the full unit test suite — it must
pass before you deploy. Database-backed tests additionally require
`DCC_TEST_DATABASE_URL` to be set (see [Environment variables](#environment-variables)).

## Configuration

### Environment variables

Copy the example file and fill in real values:

```bash
cp .env.example .env
```

Nothing in this repo auto-loads `.env` — wire it up via systemd's
`EnvironmentFile=`, pm2's `env` config, or (for one-off commands)
`set -a; source .env; set +a`. See `.env.example` for every variable this
app reads, with comments. The two most important, always required:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `PORT` | Port `apps/web` listens on |

In production, keep worker-only credentials (`GITHUB_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`, etc.) in a **separate** `.env.worker` file — the
web process is deliberately never given these (see
`apps/web/src/security.ts`'s `workerOnlyCredentials` list, enforced at
process-start via `env -u ...` stripping in `ecosystem.config.cjs`).

### Provisioning PostgreSQL

```bash
sudo -u postgres psql <<'SQL'
CREATE USER nexus WITH PASSWORD 'change-me';
CREATE DATABASE nexus OWNER nexus;
SQL
```

Then run migrations:

```bash
pnpm --filter database migrate
```

Re-run this after every `git pull` that touches
`packages/database/migrations/`.

### Configuring projects

Three YAML files under `config/` drive the app; **all start empty** — Nexus
boots and runs with no projects configured, so there's no private
configuration required just to get it running:

- **`config/projects.yaml`** — the repositories the worker can execute
  against. Add one entry per project before creating tickets against it.
- **`config/notification-providers.yaml`** — webhook/Slack/etc. targets for
  workflow notifications. Optional; delivery failures never block the
  ticket workflow.
- **`config/system.yaml`** — system-level settings.

Minimal working example — add this under `projects:` in
`config/projects.yaml` to register your first project:

```yaml
version: 1
defaults:
  ai:
    model: sonnet
    reasoning_level: high
projects:
  example-app:
    name: Example App
    description: A sample project Nexus can plan and execute against.
    paths:
      repository: /srv/repos/example-app   # required: local clone path, must be a valid git repo
    github:
      owner: your-org
      repository: example-app
    default_branch: main                    # optional, defaults to "main"
```

Required per-project fields: `paths.repository` (entries missing it are
skipped with a warning at import time). Everything else — `github.owner`,
`github.repository`, `default_branch`, and an optional `deployment:` block
for automated production promotion — is optional and validated by
`packages/project-config/src/index.ts` (`validateProject` /
`validateDeploymentConfig`). The `deployment.image.registry` field, if you
use it, must currently be exactly `"ghcr.io"` — that's the only registry
Nexus's deployment flow supports today.

Import/sync the file into the database:

```bash
pnpm projects:import
```

This is idempotent — safe to re-run any time you edit
`config/projects.yaml`.

Edit these files directly wherever you run Nexus — they're config, not
secrets, but don't commit real webhook URLs or tokens into a public fork.

### GitHub integration

Nexus talks to GitHub via a personal access token or GitHub App
installation token (not OAuth) — set `GITHUB_TOKEN` and
`GITHUB_API_BASE_URL` (see `.env.example`). Nexus degrades gracefully with
GitHub features disabled if these are unset; nothing else breaks.

**Minimum permissions needed** for the worker's token, scoped to the
repositories you register in `config/projects.yaml`:

- **Contents: Read and write** — to push branches and commits
- **Pull requests: Read and write** — to open and update PRs
- **Actions: Read** — to check workflow run/job status for merge-eligibility checks
- **Packages: Read** (optional) — only needed if you use the GHCR-based
  deployment/promotion feature; it degrades gracefully without this scope

If you use the included deployment webhook (`webhook-server.js`/
`deploy.sh`), you'll also need a webhook configured on your protected
branch with a shared `WEBHOOK_SECRET` (see `.env.example`).

### Authentication

Nexus's admin UI uses session-cookie auth with a local `users` table
(Argon2-hashed passwords, no external identity provider today). Create the
first admin user after migrating:

```bash
printf %s 'a-strong-password' | pnpm admin:create -- --username admin --password-stdin --non-interactive
```

Passwords are UTF-8 input of 1–4096 bytes; NUL, CR, and LF are rejected.
Use `printf %s`, not `echo` — the password is read from stdin, never
accepted as a command-line argument (which would leak it into shell
history / process listings). Failed logins are rate-limited per account.

## Running locally

```bash
pnpm dev
```

Starts `apps/web` (admin UI + public form + API, on `$PORT`) and
`apps/worker` (the job-queue consumer that drives executions) together,
both logging to your terminal, restarting on file change. Good for a first
smoke test; not what you want for a server you'll walk away from.

**Verify it worked:** open `http://localhost:3000` — it redirects to
`/login`. Sign in with the admin user you created above.

## Production / self-hosted deployment

Run each process under a supervisor so it survives crashes and reboots.
Example with `systemd` (two unit files):

`/etc/systemd/system/nexus-web.service`:

```ini
[Unit]
Description=Nexus — web
After=network.target postgresql.service

[Service]
Type=simple
User=nexus
WorkingDirectory=/opt/nexus
EnvironmentFile=/opt/nexus/.env
Environment=DCC_PROCESS_ROLE=web
Environment=NODE_ENV=production
ExecStart=/usr/bin/env pnpm --filter web dev
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/nexus-worker.service`:

```ini
[Unit]
Description=Nexus — worker
After=network.target postgresql.service

[Service]
Type=simple
User=nexus
WorkingDirectory=/opt/nexus
EnvironmentFile=/opt/nexus/.env
EnvironmentFile=/opt/nexus/.env.worker
Environment=DCC_PROCESS_ROLE=worker
Environment=NODE_ENV=production
ExecStart=/usr/bin/env pnpm --filter worker start
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nexus-web nexus-worker
sudo systemctl status nexus-web nexus-worker
```

(`apps/web` only has a `dev` script — `tsx watch` — which is fine under
systemd too; it just also restarts on source-file changes, harmless in
production since you deploy via `git pull` + restart anyway.)

This repository also includes an optional zero-downtime deploy pipeline
(`deploy.sh` + `webhook-server.js`, driven by `pm2` — see
`ecosystem.config.cjs`) that stages each release as a detached git
worktree, runs `pnpm verify` and migrations, then atomically cuts over. It
is entirely optional infrastructure specific to a PM2-based deployment
style; you can ignore it and manage systemd units directly as shown above.
If you do use it, see
[`docs/DEPLOYMENT-RUNBOOK.md`](docs/DEPLOYMENT-RUNBOOK.md) for the
operator runbook, and set `DCC_ROOT` to wherever you check the repo out
(defaults to `/opt/nexus`).

Put it behind a reverse proxy + TLS (nginx/Caddy) — example Caddyfile:

```
your-domain.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Make sure `APP_BASE_URL` matches the public HTTPS URL — it's used to build
links in outgoing notifications. Set `DCC_TRUST_PROXY_HOPS` to the exact
number of trusted proxies in front of Nexus.

### Backups and recovery drills

```bash
DCC_BACKUP_DIRECTORY=/var/backups/nexus
DCC_BACKUP_RETENTION_DAYS=30
DCC_DATA_DIR=/opt/nexus/data
DCC_CONFIG_DIR=/opt/nexus/config

# Required only for restore drills — must be a separate, disposable database.
DCC_RESTORE_DATABASE_URL=postgresql://nexus:change-me@127.0.0.1:5432/nexus_restore
DCC_RESTORE_ROOT=/var/lib/nexus/recovery-drill
DCC_RESTORE_HEALTH_URL=http://127.0.0.1:3100/api/health
```

Install an external cron entry to run `scripts/backup.sh` on your own
schedule (cron doesn't inherit your service environment, so source it
explicitly in the crontab line). Each backup is atomically published as one
directory containing a database dump, managed data/config, and a manifest;
`.env` files and any `secrets/`, `.key`, `.pem`, `.secret` paths are always
excluded. Run `scripts/restore-drill.sh <backup-dir>` after a successful
backup to verify it's actually restorable — see `README`'s prior revision
or `scripts/restore-drill.sh` itself for the full flag/marker contract.

## Updating

If you manage deployment yourself (no webhook), updating is just: `git pull`,
`pnpm install`, `pnpm --filter database migrate`, then restart both
processes.

If you use the included webhook flow, a signed protected-branch push queues a
deployment; GitHub Actions are not a deployment prerequisite. Before staging
or migrating, `deploy.sh` fetches the protected branch and requires its SHA to
equal the queued SHA. After installing locked dependencies in the detached
release worktree, it runs pnpm verify locally before migrations. Each release
is a detached worktree under `$DCC_ROOT/.deploy-releases`; the script keeps
`.env`, `.env.worker`, and `data` in `$DCC_ROOT`, then atomically repoints the
`$DCC_ROOT/.deploy-current` symlink once the new release is healthy.
A fetched SHA mismatch fails before staging, writes a nonzero marker, and the webhook finalizes the attempt as failed.

See [`docs/DEPLOYMENT-RUNBOOK.md`](docs/DEPLOYMENT-RUNBOOK.md) for the full
operator and incident-recovery runbook.

### Superpowers updates

The **Superpowers Update** GitHub Actions workflow runs daily and imports
the latest tagged `obra/superpowers` release into an
`automation/superpowers-<tag>` PR; review and merge that PR to activate it.

## Data layout

Everything under `$DCC_DATA_DIR` (or `$DCC_DATA_ROOT/data` when
`DCC_DATA_DIR` is unset) is managed artifact state: uploaded attachments,
execution logs, and worktrees. Plans are immutable database rows; skill
bundles are temporary and reconstructed per run. Back this directory up
alongside the database — losing it doesn't corrupt the DB, but loses
execution history and in-flight artifacts.

## Troubleshooting

- **Worker can't find `claude`:** confirm `which claude` resolves for the
  exact user/service the worker runs as, not just your login shell.
- **Migrations fail on a fresh DB:** confirm `DATABASE_URL` is set in the
  shell you're running `pnpm --filter database migrate` from — it isn't
  read from `.env` automatically.
- **Admin login locked out:** Nexus rate-limits failed logins per account;
  wait out the lockout window or create a second admin via
  `pnpm admin:create`.
- **`pnpm install` fails to build the Argon2 helper:** confirm `gcc` and
  `libargon2-1` (or your distro's equivalent) are installed — see
  [Prerequisites](#prerequisites).

## Security

- No secrets, tokens, or credentials are committed in this repository — see
  `.gitignore` for what's excluded (`.env`, `.env.*`, `secrets/`, etc.).
- Worker-only credentials (`GITHUB_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, and
  similar) are deliberately never exposed to the web process — see
  `apps/web/src/security.ts`.
- AI-agent execution runs inside Claude Code's native Linux sandbox
  (bubblewrap-based); the worker fails closed if that sandbox is
  unavailable rather than running unsandboxed.
- If you believe you've found a security vulnerability, please open a
  private report via GitHub's "Report a vulnerability" flow on this
  repository (Security tab) rather than a public issue.

## Contributing

Nexus is actively developed and contributions are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) for how to get set up, what makes a good
PR, and where help is most useful right now.

Want to contribute or discuss an idea?

Open an [issue](https://github.com/dutchbase/dev-control/issues), send a
pull request, or reach out via X/Twitter DM:
[@dutchbase](https://x.com/dutchbase).

## License

[MIT](LICENSE)

## Contact

- **Bugs and feature requests:** [GitHub Issues](https://github.com/dutchbase/dev-control/issues)
- **Code contributions:** GitHub pull requests
- **Anything else:** [@dutchbase on X/Twitter](https://x.com/dutchbase)
