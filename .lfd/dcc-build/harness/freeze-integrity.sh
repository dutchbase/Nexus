#!/usr/bin/env bash
# Run ONCE, by the LFD designer (or the operator), after harness construction
# is complete and before handing off to the execution agent. Hashes every
# harness/eval file so probe.sh's "harness integrity" check can detect any
# later drift (accidental or deliberate — see hard-fail #10 and
# cheat-museum.md #4/#8). Deliberately not run automatically by any other
# script: re-running this after the execution agent has started would erase
# the very tamper-evidence it exists to provide.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$SCRIPT_DIR/.integrity.sha256"

cd "$SCRIPT_DIR"
find . -type f \
  ! -name '.integrity.sha256' \
  ! -name '.file-status.json' \
  ! -name '.last-scorecard.json' \
  ! -name '.lint-detail.log' \
  ! -name '.cycle-log.jsonl' \
  ! -name '.run-started-at' \
  ! -name '.holdout-state.json' \
  ! -name '.holdout-audit.log' \
  ! -name '.fixtures.env' \
  ! -path './.fixtures-tmp/*' \
  ! -path './.pg-ephemeral-state/*' \
  ! -name '.mock-*' \
  ! -name '.app.stdout.log' \
  -print0 | sort -z | xargs -0 sha256sum > "$MANIFEST"

echo "wrote $(wc -l < "$MANIFEST") file hashes to $MANIFEST"
echo "commit this file — probe.sh compares against it on every future run"
