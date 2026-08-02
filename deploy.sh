#!/bin/bash
set -euo pipefail
ROOT="${DCC_ROOT:-/home/deploy/projects/dev-control}"
cd "$ROOT"
SHA="${1:-}"
MARKER="${2:-}"
if [ -z "$SHA" ]; then
  echo "deploy.sh: missing target SHA" >&2
  exit 1
fi

# Write the completion marker BEFORE restarting the webhook. Restarting the
# webhook kills this deploy child process (it is spawned by the webhook), so
# the marker must already exist for the restarted webhook to finalize it.
finish() {
  local status=$?
  trap - EXIT
  if [ -n "$MARKER" ]; then printf '%s' "$status" > "$MARKER.tmp" && mv "$MARKER.tmp" "$MARKER"; fi
  if [ "$status" -eq 0 ]; then echo "deploy.sh: deployed $SHA"; else echo "deploy.sh: failed before restart" >&2; fi
  exit "$status"
}
trap finish EXIT

git fetch origin master
git checkout master
git reset --hard "$SHA"
pnpm install --frozen-lockfile
pnpm --filter database migrate
pnpm exec tsx scripts/sync-agent-content.ts
pm2 restart dcc-web dcc-worker
pm2 restart dcc-webhook
