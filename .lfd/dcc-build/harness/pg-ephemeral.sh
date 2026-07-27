#!/usr/bin/env bash
# Ephemeral Postgres for eval runs. Prefers `docker compose` (docker-compose.eval.yml)
# when a Docker daemon is reachable; otherwise falls back to a local throwaway
# cluster via initdb/pg_ctl. Either path prints a single DATABASE_URL line and
# nothing else on success, so callers can do:
#   DATABASE_URL=$(./pg-ephemeral.sh start)
#   ./pg-ephemeral.sh stop
#
# Localhost-only in both modes. No persistent state survives `stop`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${PG_EPHEMERAL_STATE_DIR:-$SCRIPT_DIR/.pg-ephemeral-state}"
PGDATA="$STATE_DIR/pgdata"
PIDFILE="$STATE_DIR/postmaster.pid.marker"
PORT="${PG_EVAL_PORT:-55432}"
DB="dcc_eval"
USER="dcc_eval"
PASSWORD="dcc_eval"

log() { echo "[pg-ephemeral] $*" >&2; }

find_pg_bindir() {
  # Prefer whatever initdb is already on PATH; fall back to the known
  # Homebrew location observed in this environment.
  if command -v initdb >/dev/null 2>&1; then
    dirname "$(command -v initdb)"
    return 0
  fi
  for candidate in /home/linuxbrew/.linuxbrew/bin /usr/lib/postgresql/*/bin; do
    if [ -x "$candidate/initdb" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

docker_available() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

start_docker() {
  log "starting via docker compose"
  docker compose -f "$SCRIPT_DIR/docker-compose.eval.yml" up -d --wait postgres >&2
  echo "postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DB}"
}

stop_docker() {
  log "stopping docker compose"
  docker compose -f "$SCRIPT_DIR/docker-compose.eval.yml" down -v >&2 || true
}

start_local() {
  local bindir
  bindir="$(find_pg_bindir)" || { log "FATAL: no initdb found and no docker daemon reachable"; exit 1; }

  mkdir -p "$STATE_DIR"
  if [ -f "$PIDFILE" ]; then
    log "a local cluster marker already exists at $PIDFILE — stop it first (./pg-ephemeral.sh stop)"
    exit 1
  fi

  rm -rf "$PGDATA"
  mkdir -p "$PGDATA"
  log "initdb (bindir=$bindir)"
  "$bindir/initdb" -D "$PGDATA" -U "$USER" -A trust --no-locale --encoding=UTF8 >&2 2>&1

  # Localhost-only, fixed port, no unix-socket collisions with a real cluster.
  # TCP-only (no unix socket): the state dir can live deep under a worktree
  # path, which regularly exceeds the ~107-byte unix-socket path limit.
  cat >> "$PGDATA/postgresql.conf" <<EOF
listen_addresses = '127.0.0.1'
port = ${PORT}
unix_socket_directories = ''
EOF

  log "pg_ctl start (port=$PORT)"
  "$bindir/pg_ctl" -D "$PGDATA" -l "$STATE_DIR/postgres.log" -o "-p ${PORT}" -w start >&2
  echo "$bindir" > "$PIDFILE"

  # createdb (initdb's default superuser db is named after $USER, e.g. "postgres"
  # equivalent — create the eval-specific database explicitly).
  "$bindir/createdb" -h 127.0.0.1 -p "$PORT" -U "$USER" -O "$USER" "$DB" >&2 2>&1 || true

  echo "postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DB}"
}

stop_local() {
  if [ ! -f "$PIDFILE" ]; then
    log "no local cluster marker found — nothing to stop"
    return 0
  fi
  local bindir
  bindir="$(cat "$PIDFILE")"
  log "pg_ctl stop"
  "$bindir/pg_ctl" -D "$PGDATA" -m fast stop >&2 || true
  rm -rf "$STATE_DIR"
}

cmd="${1:-}"
case "$cmd" in
  start)
    if docker_available; then
      start_docker
    else
      log "docker not available — using local initdb/pg_ctl fallback"
      start_local
    fi
    ;;
  stop)
    if docker_available && docker compose -f "$SCRIPT_DIR/docker-compose.eval.yml" ps -q postgres >/dev/null 2>&1 && [ -n "$(docker compose -f "$SCRIPT_DIR/docker-compose.eval.yml" ps -q postgres 2>/dev/null)" ]; then
      stop_docker
    else
      stop_local
    fi
    ;;
  *)
    echo "usage: $0 {start|stop}" >&2
    exit 1
    ;;
esac
