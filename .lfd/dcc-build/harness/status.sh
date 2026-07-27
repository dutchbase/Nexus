#!/usr/bin/env bash
# Wall-clock / score-history status. No paid external surfaces exist in this
# task (everything AI/GitHub-shaped is mocked and local — see goal.md
# Constraints), so "spend" here is wall-clock only, not dollars.
#
# Usage: ./status.sh
# Reads harness/.cycle-log.jsonl (one JSON line per score.sh run, appended by
# run-evals.sh) and harness/.run-started-at (written once by run-evals.sh on
# first invocation).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STARTED_FILE="$SCRIPT_DIR/.run-started-at"
LOG_FILE="$SCRIPT_DIR/.cycle-log.jsonl"

if [ ! -f "$STARTED_FILE" ]; then
  echo "status: no run has started yet (harness/.run-started-at missing) — run-evals.sh writes this on first invocation"
  exit 0
fi

STARTED_AT=$(cat "$STARTED_FILE")
NOW_EPOCH=$(date +%s)
STARTED_EPOCH=$(date -d "$STARTED_AT" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%S%z" "$STARTED_AT" +%s 2>/dev/null || echo "$NOW_EPOCH")
ELAPSED=$((NOW_EPOCH - STARTED_EPOCH))
ELAPSED_H=$((ELAPSED / 3600))
ELAPSED_M=$(((ELAPSED % 3600) / 60))

echo "=== Development Control Center — LFD status ==="
echo "run started:    $STARTED_AT"
echo "wall-clock:     ${ELAPSED_H}h ${ELAPSED_M}m elapsed"
echo

if [ ! -f "$LOG_FILE" ]; then
  echo "no scoring cycles recorded yet"
  exit 0
fi

TOTAL_CYCLES=$(wc -l < "$LOG_FILE" | tr -d ' ')
echo "cycles run:     $TOTAL_CYCLES"
echo
echo "last 10 cycles (timestamp | weighted_score | hard_fail | pass_bar_met):"
tail -n 10 "$LOG_FILE" | node -e "
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    try {
      const r = JSON.parse(line);
      console.log(\`  \${r.timestamp}  score=\${r.weighted_score}  hard_fail=\${r.hard_fail_triggered}  pass_bar=\${r.pass_bar_met}\`);
    } catch { /* skip malformed line */ }
  });
"

echo
echo "diminishing-returns check (last 3 cycles, per goal.md stop conditions):"
node -e "
  const fs = require('fs');
  const lines = fs.readFileSync('$LOG_FILE', 'utf8').trim().split('\n').filter(Boolean);
  const last3 = lines.slice(-3).map(l => JSON.parse(l).weighted_score);
  if (last3.length < 3) {
    console.log('  not enough cycles yet (' + last3.length + '/3)');
  } else {
    const deltas = [last3[1]-last3[0], last3[2]-last3[1]];
    const allSmall = deltas.every(d => Math.abs(d) < 0.02);
    console.log('  scores:', last3.join(' -> '), '| deltas:', deltas.map(d=>d.toFixed(4)).join(', '));
    console.log(allSmall ? '  -> STOP CONDITION MET: < 2% movement for 3 consecutive cycles' : '  -> still improving, continue');
  }
"
