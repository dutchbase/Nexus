#!/usr/bin/env bash
# Regression for WEB-10: a failing E2E run must preserve repository data and
# an unrelated process whose command line matched the old pkill patterns.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
sentinel="$REPO_ROOT/data/e2e-cleanup-sentinel-$$"
mkdir -p "$REPO_ROOT/data"
printf 'preserve\n' > "$sentinel"
bash -c 'exec -a "tsx watch src/server.ts" sleep 600' &
unrelated_pid=$!
cleanup_test() {
  kill "$unrelated_pid" 2>/dev/null || true
  rm -f "$sentinel"
}

run_log="$(mktemp)"
trap 'rm -f "$run_log"; cleanup_test' EXIT
set +e
E2E_FAIL_AFTER_READY=true "$SCRIPT_DIR/run-e2e.sh" auth.spec.ts 2>&1 | tee "$run_log"
status=${PIPESTATUS[0]}
set -e

test "$status" -eq 97
test -f "$sentinel"
kill -0 "$unrelated_pid"
owned_container="$(sed -n 's/^\[run-e2e\] starting owned Postgres container \([^ ]*\) .*/\1/p' "$run_log" | tail -1)"
test -n "$owned_container"
! docker inspect "$owned_container" >/dev/null 2>&1
echo "E2E failure cleanup preserved unrelated data and process"
