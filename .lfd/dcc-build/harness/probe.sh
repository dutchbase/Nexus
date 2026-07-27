#!/usr/bin/env bash
# Anti-cheat probes. See goal.md "Probes" for what each one catches.
#
# Modes:
#   ./probe.sh                        full verbose report (for the human /
#                                      Phase-6-style manual verification)
#   ./probe.sh --always                harness-integrity + mock-leakage only
#                                      (fast, safe, non-destructive — this is
#                                      what score.sh should call on every run
#                                      if it wants these checks inline; the
#                                      current score.sh calls lint.sh
#                                      separately and treats probe.sh as an
#                                      operator/holdout tool, see goal.md)
#   ./probe.sh --holdout-summary-only  --always PLUS the regenerated-input
#                                      determinism probe and the gate-bypass
#                                      curl probe, output kept to aggregate
#                                      pass/fail only (called by score.sh
#                                      --holdout, which handles rate-limiting)
#   ./probe.sh --test-authenticity     DESTRUCTIVE. Mutates a known invariant
#                                      in the built app, re-runs the suite,
#                                      confirms it goes red, then reverts.
#                                      Never called automatically — run by
#                                      hand (or by the LFD loop periodically)
#                                      against a real checkout with changes
#                                      committed, never mid-flight.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
MODE="${1:-full}"

fail=0

# ---------------------------------------------------- harness integrity
check_harness_integrity() {
  local manifest="$SCRIPT_DIR/.integrity.sha256"
  if [ ! -f "$manifest" ]; then
    echo "[integrity] no manifest yet (harness/.integrity.sha256) — run harness/freeze-integrity.sh once harness construction is complete" >&2
    return 0
  fi
  if (cd "$SCRIPT_DIR" && sha256sum -c "$manifest" --quiet 2>/dev/null); then
    echo "[integrity] OK — harness/eval files unchanged since freeze"
  else
    echo "[integrity] FAIL — harness/eval files have drifted since freeze-integrity.sh was run"
    fail=1
  fi
}

# ------------------------------------------------------- mock leakage
check_mock_leakage() {
  local build_dirs=()
  for d in apps/web/.next apps/web/dist apps/worker/dist; do
    [ -d "$REPO_ROOT/$d" ] && build_dirs+=("$REPO_ROOT/$d")
  done
  if [ "${#build_dirs[@]}" -eq 0 ]; then
    echo "[mock-leakage] no production build output yet — nothing to check"
    return 0
  fi
  local hit
  hit=$(grep -rlE 'mock-claude|mock-github|MOCK_CLAUDE_LOG|MOCK_GITHUB' "${build_dirs[@]}" 2>/dev/null || true)
  if [ -n "$hit" ]; then
    echo "[mock-leakage] FAIL — mock harness references reachable from production build output: $hit"
    fail=1
  else
    echo "[mock-leakage] OK — no mock-claude/mock-github references in production build output"
  fi
}

# ------------------------------------------------------- determinism
check_determinism_regenerated() {
  echo "[determinism] generating 5 randomized ticket bodies and building each prompt twice, in separate processes..."
  node "$SCRIPT_DIR/probes/generate-determinism-inputs.js" > /tmp/dcc-determinism-inputs.json
  # This step intentionally has nothing more to do here without a running
  # app — the actual double-build-and-hash-compare happens inside
  # harness/tests/api/prompt-determinism.spec.ts (DET-01) against a FIXED
  # ticket, and inside the DET-04 case description in eval-cases.json
  # against these freshly-regenerated ones. A future iteration of this
  # script can drive the app's prompt-preview/planning endpoints directly
  # with /tmp/dcc-determinism-inputs.json's 5 ticket bodies once that
  # endpoint's contract is confirmed (see prompt-determinism batch's report
  # in LOG.md for the assumption it made). Until then this step reports the
  # inputs were generated successfully; a real app-integrated check is a
  # documented gap, not a silent pass.
  echo "[determinism] regenerated 5 fresh ticket bodies at /tmp/dcc-determinism-inputs.json (gap: not yet wired to a running app — see LOG.md)"
}

# ------------------------------------------------------- gate bypass
check_gate_bypass_curl() {
  local base="${APP_BASE_URL:-http://127.0.0.1:3000}"
  if ! curl -sf -o /dev/null "$base/api/admin/session" 2>/dev/null && ! curl -s -o /dev/null -w '%{http_code}' "$base" 2>/dev/null | grep -q '.'; then
    echo "[gate-bypass] app not reachable at $base — skipping (nothing to probe yet)"
    return 0
  fi
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/api/admin/tickets/00000000-0000-0000-0000-000000000148/execute" -H 'content-type: application/json' -d '{}')
  if [[ "$code" =~ ^2 ]]; then
    echo "[gate-bypass] FAIL — direct curl POST to /execute with no approval returned $code (expected 4xx)"
    fail=1
  else
    echo "[gate-bypass] OK — direct curl POST to /execute with no approval returned $code"
  fi
}

case "$MODE" in
  --always)
    check_harness_integrity
    check_mock_leakage
    ;;
  --holdout-summary-only)
    check_harness_integrity
    check_mock_leakage
    check_determinism_regenerated
    check_gate_bypass_curl
    ;;
  --test-authenticity)
    echo "[test-authenticity] see harness/README-probes.md for the manual procedure (flip apps/worker's auth-guard check, confirm harness/tests/api/auth-guard.spec.ts goes red, then git checkout the file back)."
    echo "[test-authenticity] this mode intentionally does not auto-mutate source — run the procedure by hand."
    ;;
  full|*)
    check_harness_integrity
    check_mock_leakage
    check_determinism_regenerated
    check_gate_bypass_curl
    ;;
esac

exit $fail
