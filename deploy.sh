#!/bin/bash
set -uo pipefail
cd /home/deploy/projects/dev-control || exit 1
SHA="${1:-}"
MARKER="${2:-}"
if [ -z "$SHA" ]; then
  echo "deploy.sh: missing target SHA" >&2
  exit 1
fi

EC=0
git fetch origin master || EC=$?
git checkout master || EC=$?
git reset --hard "$SHA" || EC=$?
pnpm install || EC=$?
pm2 restart dcc-web dcc-worker || EC=$?

# Write the completion marker BEFORE restarting the webhook. Restarting the
# webhook kills this deploy child process (it is spawned by the webhook), so
# the marker must already exist for the restarted webhook to finalize it.
if [ -n "$MARKER" ]; then
  printf '%s' "$EC" > "$MARKER.tmp" && mv "$MARKER.tmp" "$MARKER"
fi

pm2 restart dcc-webhook
echo "deploy.sh: deployed $SHA"
exit "$EC"
