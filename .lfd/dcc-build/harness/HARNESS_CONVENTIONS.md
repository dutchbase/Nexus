# Harness conventions

Contract between this harness and the application the execution agent builds.
Both `eval-cases.json` and every file under `harness/tests/` assume exactly
this. If the app's shape must differ, the gap goes in `LOG.md` as a reported
mismatch — never patched into the harness silently (hard-fail #10).

## Processes the eval run expects to be listening

| Component | How it's started | Env var(s) the app must read |
|---|---|---|
| Postgres | `./pg-ephemeral.sh start` prints `DATABASE_URL` | `DATABASE_URL` |
| apps/web + apps/worker | `pnpm --filter web dev` / `pnpm --filter worker dev` (or a combined `pnpm dev` per PRD §10), started by `run-evals.sh` | `DATABASE_URL`, `PORT` (web), `CLAUDE_CODE_OAUTH_TOKEN=mock-token-not-a-secret` |
| mock-claude | put `harness/mock-claude/` on `$PATH` so the worker's `claude` subprocess resolves to it | `MOCK_CLAUDE_LOG`, `MOCK_CLAUDE_SCENARIO` (per-test) |
| mock-github | `node harness/mock-github/server.js` | `MOCK_GITHUB_PORT` (default 8991); app's GitHub provider must be configured to call `http://127.0.0.1:${MOCK_GITHUB_PORT}` instead of `api.github.com` — via a `GITHUB_API_BASE_URL` env var the provider abstraction reads |
| git-fixtures | `harness/git-fixtures/create-fixtures.sh --clean`, exports `FIXTURE_REPO_*` / `FIXTURE_REMOTE_*` | projects.yaml (or DB `projects.repository_path`) must point at `$FIXTURE_REPO_*` paths — `seed.sql` already substitutes these via `__REPO_PATH_*__` placeholders, see `fixtures/seed.ts` |

`APP_BASE_URL` (default `http://127.0.0.1:3000`) is what every test file's
HTTP client targets.

## Database

Migrations must produce exactly the tables/columns named in PRD §26 (verbatim
snake_case), with:
- every `id` column `uuid`
- every `*_at` column `timestamptz`
- every `*_json` column `jsonb`
- boolean flags (`enabled`, `is_active`, `required`, `draft`, `merged`,
  `is_draft`, `allow_ticket_override`) as `boolean`
- status/enum columns as free `text` holding the exact strings from PRD
  §17.1 (ticket status), §24.2 (job type), or the literal values in
  `fixtures/seed.sql`

`run-evals.sh` order: start Postgres → run the app's own migration command
(`pnpm --filter database migrate`, PRD §10 convention) → run
`scripts/create-admin.ts` non-interactively (see below) → load
`fixtures/seed.ts` → start mock-github → start git-fixtures → start
apps/web + apps/worker with `claude` (mock) on `PATH` → run test suites.

## Admin user / login

`fixtures/seed.sql` does **not** seed a `users` row — a hand-written
password hash can't be trusted as real Argon2id output. Instead
`run-evals.sh` runs:

```bash
pnpm --filter database exec tsx scripts/create-admin.ts \
  --username "$DCC_EVAL_ADMIN_USER" --password "$DCC_EVAL_ADMIN_PASSWORD" --non-interactive
```

with `DCC_EVAL_ADMIN_USER=eval-admin` and a `DCC_EVAL_ADMIN_PASSWORD`
generated fresh per run (printed to stdout only, never written to a file).
The script must exit 0, be idempotent (safe to re-run), and must be the
*only* path that ever writes to `users.password_hash` in the eval run — this
is what `SEC-10` actually verifies (real Argon2id path, not a fixture).
Tests log in via `POST /api/admin/login` with these two values.

## Mock-Claude scenarios

Each test that drives a planning/execution job writes a scenario JSON file
(see `harness/mock-claude/README.md` for the shape) and points
`MOCK_CLAUDE_SCENARIO` at it before triggering the job — either by setting
the env var on the worker process directly (single-worker-process test runs)
or, if the worker runs as a long-lived process across tests, by having the
test write the scenario file to a per-job path the worker is expected to
resolve from job payload (`payload_json.mock_scenario_path` in dev/test
environments only — **never** read in a production build; grep-probed by
`SEC-16`). Pick whichever integration shape `apps/worker` actually uses and
document the chosen mechanism in `apps/worker`'s own README; the harness
tests assume `MOCK_CLAUDE_LOG` is a single shared append-only file for the
whole eval run so assertions filter by ticket/job id within it.

## Mock-GitHub

App's GitHub provider implementation must be pointed at
`GITHUB_API_BASE_URL=http://127.0.0.1:${MOCK_GITHUB_PORT}` in the eval
environment (never `api.github.com`). `MOCK_GITHUB_LOG` records every
request for the `mock-github-log.spec.ts` probe (SEC-17).

## HTTP client conventions tests rely on

- All `/api/admin/*` routes require a session cookie obtained via
  `POST /api/admin/login` and a CSRF token obtained per PRD §27.1 (tests
  read it from the login response or a `GET /api/admin/session` call —
  whichever the app implements; document the chosen mechanism in
  `apps/web`'s README since `harness/tests/helpers.ts` needs to match it
  exactly. If this diverges from what `helpers.ts` assumes, that's a
  reportable harness/implementation mismatch, not something to silently
  work around).
- Routes and payload shapes: PRD §29, verbatim paths. Field names inside
  request/response bodies not fixed by PRD §26 table columns are the
  implementation's choice — tests assert on the PRD §26 column names once
  data reaches Postgres, and are lenient about wrapper JSON envelope shape
  (e.g. `{ ticket: {...} }` vs bare object) by reading whichever top-level
  key exists.
