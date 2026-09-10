#!/usr/bin/env bash
# Boots the local-only browser stack in a unique temporary root. Cleanup owns
# only the container and process groups created by this invocation.
#
# Usage:
#   tests/e2e/run-e2e.sh
#   tests/e2e/run-e2e.sh --keep
#   tests/e2e/run-e2e.sh auth.spec.ts
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PNPM=(npm exec --package=pnpm@11.17.0 -- pnpm)

KEEP=false
SPEC_ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--keep" ]; then KEEP=true; else SPEC_ARGS+=("$arg"); fi
done

log() { echo "[run-e2e] $*" >&2; }
free_port() {
  node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}
stop_group() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 0
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}
proc_start() { cut -d' ' -f22 "/proc/$1/stat" 2>/dev/null || true; }

RUN_ROOT="$(mktemp -d "${E2E_TMPDIR:-${TMPDIR:-/tmp}}/nexus-e2e.XXXXXX")"
ARTIFACT_ROOT="${E2E_ARTIFACT_DIR:-${RUN_ROOT}.artifacts}"
STACK_MARKER="$(head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
PG_CONTAINER="nexus-e2e-pg-${UID}-$$-${RANDOM}"
PG_PORT="${E2E_PG_PORT:-$(free_port)}"
export MOCK_GITHUB_PORT="${E2E_MOCK_GITHUB_PORT:-$(free_port)}"
export MOCK_JAM_PORT="${E2E_MOCK_JAM_PORT:-$(free_port)}"
export PORT="${E2E_WEB_PORT:-$(free_port)}"
export APP_BASE_URL="http://127.0.0.1:${PORT}"
export E2E_RUN_ROOT="$RUN_ROOT"
export E2E_ARTIFACT_DIR="$ARTIFACT_ROOT"
export E2E_RESULTS_DIR="$ARTIFACT_ROOT/results"
export DCC_DATA_DIR="$RUN_ROOT/data"
export DCC_DATA_ROOT="$RUN_ROOT/legacy"
export DCC_CONFIG_DIR="$RUN_ROOT/config"
export PROJECTS_CONFIG_PATH="$DCC_CONFIG_DIR/projects.yaml"
export DCC_PR_SYNC_MIN_AGE_SECONDS=0
mkdir -p "$DCC_DATA_DIR" "$DCC_DATA_ROOT/data" "$DCC_CONFIG_DIR" "$E2E_RESULTS_DIR" "$RUN_ROOT/scenarios" "$ARTIFACT_ROOT"
printf '%s\n' "$STACK_MARKER" > "$RUN_ROOT/.owned-stack"
cp "$REPO_ROOT/config/projects.yaml" "$PROJECTS_CONFIG_PATH"

PG_OWNED=false
MOCK_GITHUB_PID=""
MOCK_JAM_PID=""
WEB_PID=""
WORKER_PID=""
MOCK_GITHUB_START=""
MOCK_JAM_START=""
WEB_START=""
WORKER_START=""
STACK_READY=false

write_keep_files() {
  local env_file="$RUN_ROOT/stack.env" cleanup_file="$RUN_ROOT/cleanup.sh"
  : > "$env_file"
  for name in APP_BASE_URL DATABASE_URL E2E_ADMIN_USER E2E_ADMIN_PASSWORD MOCK_GITHUB_BASE_URL MOCK_GITHUB_LOG MOCK_CLAUDE_LOG MOCK_CLAUDE_SCENARIO_DIR E2E_RUN_ROOT E2E_ARTIFACT_DIR E2E_RESULTS_DIR DCC_DATA_DIR DCC_DATA_ROOT DCC_CONFIG_DIR PROJECTS_CONFIG_PATH DCC_PR_SYNC_MIN_AGE_SECONDS MOCK_JAM_PORT; do
    printf '%s=%q\n' "$name" "${!name}" >> "$env_file"
  done
  cat "$RUN_ROOT/fixtures.env" >> "$env_file"
  cat > "$cleanup_file" <<EOF
#!/usr/bin/env bash
set -u
[ "\$(cat "$RUN_ROOT/.owned-stack" 2>/dev/null)" = "$STACK_MARKER" ] || { echo "owned stack marker missing or changed" >&2; exit 1; }
stop_owned() {
  local pid="\$1" expected_start="\$2" current_start
  current_start="\$(cut -d' ' -f22 "/proc/\$pid/stat" 2>/dev/null || true)"
  [ -n "\$current_start" ] && [ "\$current_start" = "\$expected_start" ] || return 0
  kill -TERM -- "-\$pid" 2>/dev/null || kill -TERM "\$pid" 2>/dev/null || true
  for _ in \$(seq 1 20); do kill -0 -- "-\$pid" 2>/dev/null || return 0; sleep 0.1; done
  kill -KILL -- "-\$pid" 2>/dev/null || true
}
stop_owned "$MOCK_GITHUB_PID" "$MOCK_GITHUB_START"
stop_owned "$MOCK_JAM_PID" "$MOCK_JAM_START"
stop_owned "$WEB_PID" "$WEB_START"
stop_owned "$WORKER_PID" "$WORKER_START"
[ "\$(docker inspect --format '{{ index .Config.Labels "nexus.e2e.run" }}' "$PG_CONTAINER" 2>/dev/null)" = "$STACK_MARKER" ] && docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
rm -rf -- "$RUN_ROOT"
EOF
  chmod 700 "$cleanup_file"
  log "--keep: stack environment: $env_file"
  log "--keep: cleanup command: $cleanup_file"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [ "$KEEP" = true ] && [ "$STACK_READY" = true ]; then
    write_keep_files
    return "$status"
  fi
  stop_group "$WORKER_PID"
  stop_group "$WEB_PID"
  stop_group "$MOCK_GITHUB_PID"
  stop_group "$MOCK_JAM_PID"
  if [ "$PG_OWNED" = true ]; then docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true; fi
  rm -rf -- "$RUN_ROOT"
  log "logs and Playwright artifacts: $ARTIFACT_ROOT"
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

log "run root: $RUN_ROOT"
log "starting owned Postgres container $PG_CONTAINER on :$PG_PORT"
docker run -d --name "$PG_CONTAINER" \
  --label "nexus.e2e.run=$STACK_MARKER" \
  -e POSTGRES_USER=dcc_e2e -e POSTGRES_PASSWORD=dcc_e2e -e POSTGRES_DB=dcc_e2e \
  -p "127.0.0.1:${PG_PORT}:5432" --tmpfs /var/lib/postgresql/data \
  postgres:16-alpine >/dev/null || { log "FATAL: Postgres container failed to start"; exit 1; }
PG_OWNED=true
export DATABASE_URL="postgresql://dcc_e2e:dcc_e2e@127.0.0.1:${PG_PORT}/dcc_e2e"
PG_READY=false
for _ in $(seq 1 60); do
  if docker exec "$PG_CONTAINER" pg_isready -U dcc_e2e -d dcc_e2e >/dev/null 2>&1; then
    # The image briefly accepts connections on its bootstrap server before
    # restarting Postgres. Require a second check across that restart window.
    sleep 0.5
    if docker exec "$PG_CONTAINER" pg_isready -U dcc_e2e -d dcc_e2e >/dev/null 2>&1; then PG_READY=true; break; fi
  fi
  sleep 0.5
done
if [ "$PG_READY" != true ]; then
  docker logs "$PG_CONTAINER" > "$ARTIFACT_ROOT/postgres.log" 2>&1 || true
  log "FATAL: Postgres never became ready; see $ARTIFACT_ROOT/postgres.log"
  exit 1
fi

log "running migrations and creating local admin"
(cd "$REPO_ROOT" && "${PNPM[@]}" --filter @dcc/database migrate) || { log "FATAL: migrations failed"; exit 1; }
export E2E_ADMIN_USER=e2e-admin
export E2E_ADMIN_PASSWORD="${E2E_ADMIN_PASSWORD:-e2e-pass-$(head -c8 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
printf %s "$E2E_ADMIN_PASSWORD" | (cd "$REPO_ROOT" && "${PNPM[@]}" admin:create --username "$E2E_ADMIN_USER" --password-stdin --non-interactive) || { log "FATAL: create-admin failed"; exit 1; }

log "creating isolated git and database fixtures"
bash "$SCRIPT_DIR/git-fixtures/create-fixtures.sh" --clean --root "$RUN_ROOT/fixtures" | grep '^FIXTURE_' > "$RUN_ROOT/fixtures.env"
set -a; source "$RUN_ROOT/fixtures.env"; set +a
(cd "$SCRIPT_DIR/fixtures" && node seed.ts) || { log "FATAL: seed failed"; exit 1; }
(cd "$REPO_ROOT" && "${PNPM[@]}" exec tsx scripts/sync-agent-content.ts) || { log "FATAL: agent content sync failed"; exit 1; }

export MOCK_GITHUB_BASE_URL="http://127.0.0.1:${MOCK_GITHUB_PORT}"
export MOCK_GITHUB_LOG="$ARTIFACT_ROOT/mock-github.log"
: > "$MOCK_GITHUB_LOG"
setsid node "$SCRIPT_DIR/mock-github/server.js" > "$ARTIFACT_ROOT/mock-github.stdout.log" 2>&1 &
MOCK_GITHUB_PID=$!
MOCK_GITHUB_START="$(proc_start "$MOCK_GITHUB_PID")"

setsid node "$SCRIPT_DIR/mock-jam/server.js" > "$ARTIFACT_ROOT/mock-jam.log" 2>&1 &
MOCK_JAM_PID=$!
MOCK_JAM_START="$(proc_start "$MOCK_JAM_PID")"

chmod +x "$SCRIPT_DIR/mock-claude/claude"
export PATH="$SCRIPT_DIR/mock-claude:$PATH"
export MOCK_CLAUDE_LOG="$ARTIFACT_ROOT/mock-claude.log"
export MOCK_CLAUDE_SCENARIO_DIR="$RUN_ROOT/scenarios"
: > "$MOCK_CLAUDE_LOG"
export CLAUDE_CODE_OAUTH_TOKEN=mock-token-not-a-secret
for name in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY GH_TOKEN DEEPSEEK_API_KEY GHCR_READ_TOKEN; do unset "$name"; done
while IFS= read -r name; do unset "$name"; done < <(compgen -A variable | grep '^DCC_NOTIFICATION_SECRET_' || true)
export GITHUB_API_BASE_URL="$MOCK_GITHUB_BASE_URL"
export GITHUB_TOKEN=mock-github-token
unset NODE_ENV DCC_JAM_TOKEN DCC_JAM_TEST_ENDPOINT

log "starting web :$PORT and worker in owned process groups"
DCC_PROCESS_ROLE=web setsid "${PNPM[@]}" --dir "$REPO_ROOT" --filter web exec tsx src/server.ts > "$ARTIFACT_ROOT/web.log" 2>&1 &
WEB_PID=$!
WEB_START="$(proc_start "$WEB_PID")"
DCC_JAM_TOKEN=mock-worker-token DCC_JAM_TEST_ENDPOINT="http://127.0.0.1:${MOCK_JAM_PORT}/mcp" DCC_PROCESS_ROLE=worker setsid "${PNPM[@]}" --dir "$REPO_ROOT" --filter worker exec tsx src/worker.ts > "$ARTIFACT_ROOT/worker.log" 2>&1 &
WORKER_PID=$!
WORKER_START="$(proc_start "$WORKER_PID")"

for _ in $(seq 1 120); do
  if curl --fail --silent --output /dev/null "$APP_BASE_URL/api/health"; then STACK_READY=true; break; fi
  sleep 0.5
done
if [ "$STACK_READY" != true ]; then
  log "FATAL: app never became ready; logs remain until cleanup"
  tail -80 "$ARTIFACT_ROOT/web.log" "$ARTIFACT_ROOT/worker.log" >&2 || true
  exit 1
fi
log "app ready at $APP_BASE_URL"

if [ "${E2E_FAIL_AFTER_READY:-false}" = true ]; then
  log "intentional post-readiness failure requested"
  exit 97
fi
if [ "${BOOT_ONLY:-false}" = true ]; then
  log "BOOT_ONLY=true; skipping Playwright"
  exit 0
fi

log "running Playwright journeys"
set +e
(cd "$REPO_ROOT" && "${PNPM[@]}" exec playwright test --config tests/e2e/playwright.config.ts "${SPEC_ARGS[@]}")
RC=$?
set -e
log "Playwright exit code: $RC"
exit "$RC"
