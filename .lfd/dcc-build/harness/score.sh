#!/usr/bin/env bash
# The task-specific scorer. Runs lint.sh first (any violation VOIDs the
# score — see lint.sh for why detail never reaches stdout), then runs every
# frozen spec file under harness/tests/ individually (per-file pass/fail via
# exit code — deliberately not parsing vitest/playwright's JSON reporter
# schemas, which are fragile across versions; a file that passes covers
# every eval case whose test_ref points at it), computes per-category and
# weighted scores against harness/eval-cases.json, and emits a JSON
# scorecard.
#
# Usage:
#   ./score.sh              # score against eval-cases.json (the "dev" set —
#                            # see goal.md for why this task has no separate
#                            # secret holdout answer set)
#   ./score.sh --holdout    # additionally run probe.sh (regenerated,
#                            # unmemorizable inputs), rate-limited, appends
#                            # to a holdout audit log, aggregate-only output
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CASES_FILE="$SCRIPT_DIR/eval-cases.json"
HOLDOUT=false
[ "${1:-}" = "--holdout" ] && HOLDOUT=true

# ---------------------------------------------------------------- 1. lint
LINT_OUT="$("$SCRIPT_DIR/lint.sh")"
LINT_RC=$?
if [ "$LINT_RC" -ne 0 ]; then
  echo "$LINT_OUT"
  exit 1
fi

# ---------------------------------------------------------- 2. run specs
FILE_STATUS_JSON="$SCRIPT_DIR/.file-status.json"
echo "{}" > "$FILE_STATUS_JSON"

run_spec_file() {
  local abs="$1" runner="$2"
  local rel="harness/${abs#"$SCRIPT_DIR"/}"
  local status="fail"
  local log
  log="$(mktemp)"
  if [ "$runner" = "vitest" ]; then
    if (cd "$REPO_ROOT" && npx --yes vitest run "$abs" --root "$REPO_ROOT" >"$log" 2>&1); then
      status="pass"
    fi
  else
    if (cd "$REPO_ROOT" && npx --yes playwright test "$abs" >"$log" 2>&1); then
      status="pass"
    fi
  fi
  node -e "
    const fs = require('fs');
    const p = '$FILE_STATUS_JSON';
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    m['$rel'] = '$status';
    fs.writeFileSync(p, JSON.stringify(m, null, 2));
  "
  if [ "$status" = "fail" ]; then
    echo "--- FAILED: $rel ---" >&2
    tail -n 40 "$log" >&2
  fi
  rm -f "$log"
}

shopt -s nullglob
for f in "$SCRIPT_DIR"/tests/api/*.spec.ts; do
  run_spec_file "$f" vitest
  if [ "$(basename "$f")" = "public-form-security.spec.ts" ]; then
    echo "[score] pausing 20s after public-form-security.spec.ts's deliberate rate-limit burst so the next file's normal form submissions aren't caught in the same window" >&2
    sleep 20
  fi
done
export LD_LIBRARY_PATH="/home/linuxbrew/.linuxbrew/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
for f in "$SCRIPT_DIR"/tests/frontend/*.spec.ts; do
  run_spec_file "$f" playwright
done
for f in "$SCRIPT_DIR"/tests/probes/*.spec.ts; do
  run_spec_file "$f" vitest
done
shopt -u nullglob

# ------------------------------------------------- 3. aggregate & score
SCORECARD="$SCRIPT_DIR/.last-scorecard.json"
node "$SCRIPT_DIR/aggregate-score.js" "$CASES_FILE" "$FILE_STATUS_JSON" "$SCORECARD"
cat "$SCORECARD"

PASS_BAR_OK=$(node -e "const s=require('$SCORECARD'); process.stdout.write(String(s.pass_bar_met))")
HARD_FAIL=$(node -e "const s=require('$SCORECARD'); process.stdout.write(String(s.hard_fail_triggered))")

# --------------------------------------------------------- 4. holdout
if [ "$HOLDOUT" = true ]; then
  STATE_FILE="$SCRIPT_DIR/.holdout-state.json"
  [ -f "$STATE_FILE" ] || echo '{"calls":[]}' > "$STATE_FILE"
  NOW_CALLS=$(node -e "
    const fs = require('fs');
    const s = JSON.parse(fs.readFileSync('$STATE_FILE','utf8'));
    const dayAgo = Date.now() - 24*3600*1000;
    // Date.now() is fine here — score.sh runs outside any Workflow script context.
    s.calls = s.calls.filter(t => t > dayAgo);
    if (s.calls.length >= 6) { console.log('RATE_LIMITED'); process.exit(0); }
    s.calls.push(Date.now());
    fs.writeFileSync('$STATE_FILE', JSON.stringify(s));
    console.log(s.calls.length);
  ")
  if [ "$NOW_CALLS" = "RATE_LIMITED" ]; then
    echo '{"holdout":"rate_limited","max_calls_per_24h":6}'
    exit 1
  fi
  echo "--- holdout probes ---" >&2
  "$SCRIPT_DIR/probe.sh" --holdout-summary-only
  HOLDOUT_LOG="$SCRIPT_DIR/.holdout-audit.log"
  echo "$(date -Iseconds 2>/dev/null || echo unknown) call#$NOW_CALLS scorecard_weighted=$(node -e "console.log(require('$SCORECARD').weighted_score)")" >> "$HOLDOUT_LOG"
fi

if [ "$HARD_FAIL" = "true" ] || [ "$PASS_BAR_OK" != "true" ]; then
  exit 1
fi
exit 0
