#!/usr/bin/env bash
# Boots a hermetic full stack (ephemeral Postgres + mock-github + mock-claude
# + apps/web + apps/worker) and runs the Playwright end-user journey suite
# against it. Reuses the eval harness's infrastructure under
# .lfd/dcc-build/harness/ — nothing here touches the production database,
# ports, or real GitHub/Anthropic APIs.
#
# Usage:
#   tests/e2e/run-e2e.sh                 # boot, run all specs, tear down
#   tests/e2e/run-e2e.sh --keep          # leave the stack running afterwards
#   tests/e2e/run-e2e.sh auth.spec.ts    # run a single spec
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HARNESS_DIR="$REPO_ROOT/.lfd/dcc-build/harness"

KEEP=false
SPEC_ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--keep" ]; then KEEP=true; else SPEC_ARGS+=("$arg"); fi
done

log() { echo "[run-e2e] $*" >&2; }

# Dedicated ports/names so this never collides with production (web :3000,
# pg :5433) or an eval-harness run (web :3000, pg :55432/55433, mock-github :8991).
PG_PORT=55434
PG_CONTAINER="e2e-dcc-postgres"
export MOCK_GITHUB_PORT=8993
export MOCK_ANTHROPIC_PORT=8994
export PORT=3100
export APP_BASE_URL="http://127.0.0.1:${PORT}"

MOCK_GITHUB_PID=""
MOCK_ANTHROPIC_PID=""

cleanup() {
  if [ "$KEEP" = true ]; then
    log "--keep: leaving Postgres / mock-github / mock-anthropic / app running"
    return
  fi
  log "cleanup"
  pkill -f "tsx watch src/server.ts" 2>/dev/null
  pkill -f "tsx watch src/worker.ts" 2>/dev/null
  pkill -f "scripts/dev.ts" 2>/dev/null
  [ -n "$MOCK_GITHUB_PID" ] && kill "$MOCK_GITHUB_PID" 2>/dev/null
  [ -n "$MOCK_ANTHROPIC_PID" ] && kill "$MOCK_ANTHROPIC_PID" 2>/dev/null
  pkill -f "mock-github/server.js" 2>/dev/null
  pkill -f "mock-anthropic/server.mjs" 2>/dev/null
  docker rm -f "$PG_CONTAINER" >/dev/null 2>&1
}
trap cleanup EXIT

# ------------------------------------------------------------ postgres
log "starting ephemeral postgres on :$PG_PORT (container $PG_CONTAINER)"
docker rm -f "$PG_CONTAINER" >/dev/null 2>&1
docker run -d --name "$PG_CONTAINER" \
  -e POSTGRES_USER=dcc_e2e -e POSTGRES_PASSWORD=dcc_e2e -e POSTGRES_DB=dcc_e2e \
  -p "127.0.0.1:${PG_PORT}:5432" --tmpfs /var/lib/postgresql/data \
  postgres:16-alpine >/dev/null || { log "FATAL: postgres container failed to start"; exit 1; }
export DATABASE_URL="postgresql://dcc_e2e:dcc_e2e@127.0.0.1:${PG_PORT}/dcc_e2e"
for i in $(seq 1 30); do
  docker exec "$PG_CONTAINER" pg_isready -U dcc_e2e -d dcc_e2e >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$PG_CONTAINER" pg_isready -U dcc_e2e -d dcc_e2e >/dev/null 2>&1 || { log "FATAL: postgres never became ready"; exit 1; }
log "postgres up: ${DATABASE_URL/:*@/:***@}"

log "running migrations"
(cd "$REPO_ROOT" && pnpm --filter @dcc/database migrate) || { log "FATAL: migrations failed"; exit 1; }

# ------------------------------------------------------------ admin user
export E2E_ADMIN_USER="e2e-admin"
export E2E_ADMIN_PASSWORD="${E2E_ADMIN_PASSWORD:-e2e-pass-$(head -c8 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
log "creating admin user $E2E_ADMIN_USER"
printf %s "$E2E_ADMIN_PASSWORD" | (cd "$REPO_ROOT" && pnpm admin:create --username "$E2E_ADMIN_USER" --password-stdin --non-interactive) || { log "FATAL: create-admin failed"; exit 1; }

# ------------------------------------------------------------ fixtures
log "creating git fixtures"
FIXTURES_OUT="$(bash "$HARNESS_DIR/git-fixtures/create-fixtures.sh" --clean)"
echo "$FIXTURES_OUT" | grep '^FIXTURE_' > "$SCRIPT_DIR/.fixtures.env" || true
set -a; source "$SCRIPT_DIR/.fixtures.env"; set +a

# The DB is fresh but the app's data dir (execution worktrees, artifacts)
# survives runs — stale worktree paths collide with reissued ticket numbers.
rm -rf "$REPO_ROOT/data"

log "seeding fixture data"
# The frozen harness seed predates migration 046's notification_deliveries
# status constraint ('delivered' -> 'sent'). Patch a throwaway copy; the
# harness file itself must stay untouched (HARNESS_CONVENTIONS.md).
SEED_TMP="$SCRIPT_DIR/.seed-patched"
rm -rf "$SEED_TMP" && mkdir -p "$SEED_TMP"
cp "$HARNESS_DIR/fixtures/seed.ts" "$SEED_TMP/seed.ts"
sed "s/'delivered',/'sent',/g" "$HARNESS_DIR/fixtures/seed.sql" > "$SEED_TMP/seed.sql"
(cd "$SEED_TMP" && node seed.ts) || { log "FATAL: seed failed"; exit 1; }

# Same step deploy.sh runs: syncs prompts/global/*.md (incl. the code-reviewer
# rubric the PR AI review requires) into prompt_files.
log "syncing agent content (prompts)"
(cd "$REPO_ROOT" && pnpm exec tsx scripts/sync-agent-content.ts) || { log "FATAL: agent content sync failed"; exit 1; }

# ------------------------------------------------------------ mocks
log "starting mock-github on :$MOCK_GITHUB_PORT"
export MOCK_GITHUB_BASE_URL="http://127.0.0.1:${MOCK_GITHUB_PORT}"
export MOCK_GITHUB_LOG="$SCRIPT_DIR/.mock-github.log"
: > "$MOCK_GITHUB_LOG"
# e2e fork of the harness mock (adds head/base SHAs, refs/pull/N/head,
# policy-input endpoints, and a working merge — see the file header).
node "$SCRIPT_DIR/mock-github/server.js" > "$SCRIPT_DIR/.mock-github.stdout.log" 2>&1 &
MOCK_GITHUB_PID=$!

log "starting mock-anthropic on :$MOCK_ANTHROPIC_PORT"
export MOCK_ANTHROPIC_LOG="$SCRIPT_DIR/.mock-anthropic.log"
: > "$MOCK_ANTHROPIC_LOG"
node "$SCRIPT_DIR/mock-anthropic/server.mjs" > "$SCRIPT_DIR/.mock-anthropic.stdout.log" 2>&1 &
MOCK_ANTHROPIC_PID=$!

# Shim first (fixes the stale `auth status` shape), harness mock second.
chmod +x "$SCRIPT_DIR/mock-claude/claude"
export PATH="$SCRIPT_DIR/mock-claude:$HARNESS_DIR/mock-claude:$PATH"
export MOCK_CLAUDE_LOG="$SCRIPT_DIR/.mock-claude.log"
export MOCK_CLAUDE_SCENARIO_DIR="$SCRIPT_DIR/.scenarios"
mkdir -p "$MOCK_CLAUDE_SCENARIO_DIR"
: > "$MOCK_CLAUDE_LOG"
export CLAUDE_CODE_OAUTH_TOKEN="mock-token-not-a-secret"
for v in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY; do unset "$v"; done

# Set ANTHROPIC_API_KEY only AFTER the unset loop above, and only for the
# worker's API-billed follow-up-description path (Task B4) — the mock
# `claude` CLI (tests/e2e/mock-claude/claude:17-21) exits 1 if it ever sees
# this var, which is the e2e proof that the worker's child-process env
# scrubbing (packages/claude-runner's assertSubscriptionOnlyChildEnvironment,
# Task B1) actually keeps it away from the CLI subprocess. scripts/dev.ts
# also strips it from the web child's env before spawning apps/web.
# DCC_ANTHROPIC_API_JOBS is left at its default (routes pr_follow_up_description).
export ANTHROPIC_API_KEY="sk-ant-mock-not-a-secret"
export ANTHROPIC_BASE_URL="http://127.0.0.1:${MOCK_ANTHROPIC_PORT}"

# ------------------------------------------------------------ app
export GITHUB_API_BASE_URL="$MOCK_GITHUB_BASE_URL"
export GITHUB_TOKEN="mock-github-token"
unset NODE_ENV # mock_scenario_path routing is disabled under NODE_ENV=production

log "starting app (web :$PORT + worker)"
(cd "$REPO_ROOT" && pnpm dev > "$SCRIPT_DIR/.app.stdout.log" 2>&1 &)

log "waiting for app readiness (up to 60s)"
READY=false
for i in $(seq 1 60); do
  if curl -sf -o /dev/null "$APP_BASE_URL/api/health"; then READY=true; break; fi
  sleep 1
done
[ "$READY" = true ] || { log "FATAL: app never became ready — see $SCRIPT_DIR/.app.stdout.log"; exit 1; }
log "app ready at $APP_BASE_URL"

# Snapshot the stack env so a --keep run can be iterated against manually:
#   set -a; source tests/e2e/.stack.env; set +a; npx playwright test --config tests/e2e/playwright.config.ts
{
  echo "APP_BASE_URL=$APP_BASE_URL"
  echo "DATABASE_URL=$DATABASE_URL"
  echo "E2E_ADMIN_USER=$E2E_ADMIN_USER"
  echo "E2E_ADMIN_PASSWORD=$E2E_ADMIN_PASSWORD"
  echo "MOCK_GITHUB_BASE_URL=$MOCK_GITHUB_BASE_URL"
  echo "MOCK_GITHUB_LOG=$MOCK_GITHUB_LOG"
  echo "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"
  echo "MOCK_ANTHROPIC_LOG=$MOCK_ANTHROPIC_LOG"
  echo "MOCK_CLAUDE_LOG=$MOCK_CLAUDE_LOG"
  echo "MOCK_CLAUDE_SCENARIO_DIR=$MOCK_CLAUDE_SCENARIO_DIR"
  cat "$SCRIPT_DIR/.fixtures.env"
} > "$SCRIPT_DIR/.stack.env"

# ------------------------------------------------------------ playwright
if [ "${BOOT_ONLY:-false}" = true ]; then
  log "BOOT_ONLY=true — stack is up, skipping playwright"
  exit 0
fi

log "running playwright journeys"
(cd "$REPO_ROOT" && npx playwright test --config tests/e2e/playwright.config.ts "${SPEC_ARGS[@]}")
RC=$?
log "playwright exit code: $RC"
exit $RC
