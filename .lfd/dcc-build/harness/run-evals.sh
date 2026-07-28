#!/usr/bin/env bash
# One command: spins everything up, runs migrations + seed, executes every
# eval suite, emits a JSON scorecard, exits non-zero on any hard fail.
# Hermetic and repeatable: no network beyond 127.0.0.1, and every ephemeral
# process it starts is torn down in the EXIT trap regardless of how the
# script exits.
#
# Usage:
#   ./run-evals.sh              # normal dev scoring
#   ./run-evals.sh --holdout    # dev scoring + the regenerated-input probes
#   ./run-evals.sh --keep       # don't tear down Postgres/fixtures/app at
#                                # exit (useful while iterating manually)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
HOLDOUT=false
KEEP=false
for arg in "$@"; do
  [ "$arg" = "--holdout" ] && HOLDOUT=true
  [ "$arg" = "--keep" ] && KEEP=true
done

log() { echo "[run-evals] $*" >&2; }

# ---------------------------------------------------------------- setup
[ -f "$SCRIPT_DIR/.run-started-at" ] || date -Iseconds > "$SCRIPT_DIR/.run-started-at" 2>/dev/null || date > "$SCRIPT_DIR/.run-started-at"

APP_PID=""
MOCK_GITHUB_PID=""

cleanup() {
  if [ "$KEEP" = true ]; then
    log "--keep passed, leaving Postgres / mock-github / app running for manual inspection"
    return
  fi
  log "cleanup: stopping services"
  # `pnpm dev` (backgrounded via a subshell, so $APP_PID from a later
  # pgrep match was never reliable) spawns scripts/dev.ts, which spawns
  # `pnpm --filter web dev` and `pnpm --filter worker dev`, which each
  # spawn a `tsx watch` leaf (which tsx re-execs to full node with --require/--import).
  # Killing $APP_PID alone left this whole tree orphaned. Pattern-kill every known
  # layer directly instead (using script paths, not the tsx wrapper command).
  pkill -f "$REPO_ROOT.*src/server.ts" 2>/dev/null
  pkill -f "$REPO_ROOT.*src/worker.ts" 2>/dev/null
  pkill -f "pnpm --filter web dev" 2>/dev/null
  pkill -f "pnpm --filter worker dev" 2>/dev/null
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null
  [ -n "$MOCK_GITHUB_PID" ] && kill "$MOCK_GITHUB_PID" 2>/dev/null
  "$SCRIPT_DIR/pg-ephemeral.sh" stop 2>/dev/null || true
  rm -rf "$SCRIPT_DIR/.fixtures-tmp" "$SCRIPT_DIR/.fixtures.env"
}
trap cleanup EXIT

log "starting ephemeral Postgres"
export DATABASE_URL
DATABASE_URL="$("$SCRIPT_DIR/pg-ephemeral.sh" start | tail -n1)"
if [ -z "$DATABASE_URL" ]; then
  log "FATAL: could not start ephemeral Postgres"
  exit 1
fi
log "DATABASE_URL=$DATABASE_URL"

APP_EXISTS=false
[ -f "$REPO_ROOT/apps/web/package.json" ] && [ -f "$REPO_ROOT/apps/worker/package.json" ] && APP_EXISTS=true

if [ "$APP_EXISTS" = true ]; then
  log "running migrations"
  (cd "$REPO_ROOT" && pnpm --filter database migrate) || log "WARNING: migrations failed or script not found yet — continuing, most tests will fail (expected before Phase 1 lands)"

  export DCC_EVAL_ADMIN_USER="eval-admin"
  export DCC_EVAL_ADMIN_PASSWORD
  DCC_EVAL_ADMIN_PASSWORD="eval-$(head -c 12 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9')"
  log "creating eval admin user ($DCC_EVAL_ADMIN_USER)"
  (cd "$REPO_ROOT" && pnpm --filter database exec tsx scripts/create-admin.ts --username "$DCC_EVAL_ADMIN_USER" --password "$DCC_EVAL_ADMIN_PASSWORD" --non-interactive) \
    || log "WARNING: create-admin.ts failed or not found yet — login-dependent tests will fail"
else
  log "apps/web or apps/worker not scaffolded yet — skipping migrations/admin-creation/app-boot, running lint + static probes only"
fi

log "creating git fixtures"
FIXTURES_OUT="$(bash "$SCRIPT_DIR/git-fixtures/create-fixtures.sh" --clean)"
echo "$FIXTURES_OUT" | grep '^FIXTURE_' > "$SCRIPT_DIR/.fixtures.env" || true
# shellcheck disable=SC1090
set -a; source "$SCRIPT_DIR/.fixtures.env" 2>/dev/null || true; set +a

if [ "$APP_EXISTS" = true ]; then
  log "seeding fixture data"
  (cd "$SCRIPT_DIR/fixtures" && node seed.ts) || log "WARNING: seed.ts failed — check schema matches HARNESS_CONVENTIONS.md contract"

  log "starting mock-github"
  MOCK_GITHUB_PORT="${MOCK_GITHUB_PORT:-8991}"
  export MOCK_GITHUB_PORT
  export MOCK_GITHUB_BASE_URL="http://127.0.0.1:${MOCK_GITHUB_PORT}"
  export MOCK_GITHUB_LOG="$SCRIPT_DIR/.mock-github.log"
  : > "$MOCK_GITHUB_LOG"
  node "$SCRIPT_DIR/mock-github/server.js" >"$SCRIPT_DIR/.mock-github.stdout.log" 2>&1 &
  MOCK_GITHUB_PID=$!
  sleep 1

  export PATH="$SCRIPT_DIR/mock-claude:$PATH"
  export MOCK_CLAUDE_LOG="$SCRIPT_DIR/.mock-claude.log"
  : > "$MOCK_CLAUDE_LOG"
  export CLAUDE_CODE_OAUTH_TOKEN="mock-token-not-a-secret"
  for v in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY; do
    unset "$v"
  done

  log "starting the app (apps/web + apps/worker)"
  export APP_BASE_URL="${APP_BASE_URL:-http://127.0.0.1:3000}"
  export GITHUB_API_BASE_URL="$MOCK_GITHUB_BASE_URL"
  (cd "$REPO_ROOT" && pnpm dev >"$SCRIPT_DIR/.app.stdout.log" 2>&1 &)
  APP_PID=$(pgrep -f "pnpm dev" | tail -n1 || true)
  log "waiting for app readiness at $APP_BASE_URL (up to 60s)"
  for i in $(seq 1 60); do
    if curl -sf -o /dev/null "$APP_BASE_URL" 2>/dev/null; then
      log "app is responding"
      break
    fi
    sleep 1
  done
fi

# ---------------------------------------------------------------- score
log "scoring"
SCORE_ARGS=()
[ "$HOLDOUT" = true ] && SCORE_ARGS+=(--holdout)
"$SCRIPT_DIR/score.sh" "${SCORE_ARGS[@]}"
SCORE_RC=$?

# ------------------------------------------------------------ cycle log
if [ -f "$SCRIPT_DIR/.last-scorecard.json" ]; then
  node -e "
    const fs = require('fs');
    const sc = JSON.parse(fs.readFileSync('$SCRIPT_DIR/.last-scorecard.json', 'utf8'));
    const entry = {
      timestamp: new Date().toISOString(),
      weighted_score: sc.weighted_score,
      hard_fail_triggered: sc.hard_fail_triggered,
      pass_bar_met: sc.pass_bar_met,
      categories: Object.fromEntries(Object.entries(sc.categories).map(([k,v]) => [k, v.score])),
    };
    fs.appendFileSync('$SCRIPT_DIR/.cycle-log.jsonl', JSON.stringify(entry) + '\n');
  " 2>/dev/null || true
fi

exit $SCORE_RC
