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

write_marker() {
  if [ -n "$MARKER" ]; then printf '%s' "$1" > "$MARKER.tmp" && mv "$MARKER.tmp" "$MARKER"; fi
}

# Restarting the webhook kills this deploy child process, so its successful
# completion marker must exist before that restart. Earlier failures still
# reach the EXIT trap and receive their failure marker.
finish() {
  local status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then write_marker "$status"; fi
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
write_marker 0
pm2 restart dcc-webhook
