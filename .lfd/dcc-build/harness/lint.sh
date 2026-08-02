#!/usr/bin/env bash
# Capacity-cap and eval-literal-overlap lint. Called ONLY by score.sh, before
# any test suite runs. On violation: print exactly "VOID: constraint
# violation" to stdout and exit 1 — score.sh must not print anything else on
# a VOID. Detailed findings go to $LINT_DETAIL_LOG (a file, not stdout) for
# the human operator; the optimizer never sees which constraint it tripped
# (see cheat-museum.md #12 — oracle-mining the enforcement instrument).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LINT_DETAIL_LOG="${LINT_DETAIL_LOG:-$SCRIPT_DIR/.lint-detail.log}"

violations=0
: > "$LINT_DETAIL_LOG"

record() {
  echo "$*" >> "$LINT_DETAIL_LOG"
  violations=$((violations + 1))
}

# Source dirs the execution agent actually writes to. Skip gracefully if
# they don't exist yet (early phases / clean checkout).
SRC_DIRS=()
for d in apps/web/src apps/worker/src packages; do
  if [ -d "$REPO_ROOT/$d" ]; then
    SRC_DIRS+=("$REPO_ROOT/$d")
  fi
done

if [ "${#SRC_DIRS[@]}" -eq 0 ]; then
  echo "lint.sh: no production source directories exist yet — nothing to lint" >> "$LINT_DETAIL_LOG"
  exit 0
fi

grep_src() {
  # $1 = pattern, rest = grep args. Excludes node_modules, dist, .next, test files.
  local pattern="$1"; shift
  grep -rEn "$pattern" "${SRC_DIRS[@]}" \
    --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
    --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next \
    --exclude='*.spec.ts' --exclude='*.test.ts' "$@" 2>/dev/null || true
}

# --- hard-fail #1 / #8: forbidden literals -----------------------------
m=$(grep_src 'api\.anthropic\.com' \
  | grep -vE "/packages/claude-runner/src/index\.ts:[0-9]+:[[:space:]]*network: \{ allowedDomains: \[\"api\.anthropic\.com\"\], strictAllowlist: true \},[[:space:]]*$" || true)
[ -n "$m" ] && record "forbidden literal api.anthropic.com found: $m"

m=$(grep_src '\.dc\.html|support\.js')
[ -n "$m" ] && record "prototype file reference found: $m"

# ANTHROPIC_API_KEY outside an auth-guard-shaped file path
#
# NOTE: every `m=$(cmd1 | cmd2)` pipeline in this file ends its FINAL stage
# with `|| true`. Under `set -e -o pipefail`, grep's "no match" exit status
# (1) propagates through the pipe and INTO the assignment context, which
# silently kills the whole script before it reaches its own exit/echo logic
# — the empty-result case (nothing found, the common case) is not a real
# error and must never trigger errexit here. Caught during Phase 6
# verification by deliberately planting a violation and observing lint.sh
# die silently instead of reporting VOID; do not remove these guards.
m=$(grep_src 'ANTHROPIC_API_KEY' | grep -viE '(auth-guard|claude-guard|subscription-guard|auth\.guard)' || true)
[ -n "$m" ] && record "ANTHROPIC_API_KEY referenced outside an auth-guard module: $m"

# --- hard-fail #4: merge-capable calls in the GitHub provider ----------
m=$(grep_src "pulls/[^\"']*\\}/merge|\\.merge\\(" \
  | grep -iE 'github|provider' || true)
[ -n "$m" ] && record "possible merge-endpoint call in GitHub provider code: $m"

# --- design-handoff §7: hardcoded hex colors outside the token block ---
# Token files are expected under a path containing "token" (e.g.
# apps/web/src/styles/tokens.css) — anything else defining a bare hex
# literal in CSS/inline styles is a violation of "no one-off hex values".
if command -v find >/dev/null; then
  while IFS= read -r -d '' f; do
    case "$f" in
      *token*|*/node_modules/*|*/dist/*|*/.next/*) continue ;;
    esac
    hexmatches=$(grep -noE '#[0-9a-fA-F]{3,8}\b' "$f" 2>/dev/null || true)
    if [ -n "$hexmatches" ]; then
      record "hardcoded hex color outside token file $f: $hexmatches"
    fi
  done < <(find "${SRC_DIRS[@]}" -type f \( -name '*.css' -o -name '*.tsx' -o -name '*.ts' \) -print0 2>/dev/null)
fi

# --- capacity cap: this harness has no agent-writable list-shaped -------
# artifact to cap (no keyword lists, seed lookups, etc. are part of the
# spec-compliance target) — nothing to check here. Kept as an explicit
# no-op section so a future cap is easy to add without restructuring.

if [ "$violations" -gt 0 ]; then
  echo "VOID: constraint violation"
  exit 1
fi

exit 0
