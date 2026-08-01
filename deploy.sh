#!/bin/bash
set -euo pipefail
cd /home/deploy/projects/dev-control
SHA="${1:-}"
if [ -z "$SHA" ]; then
  echo "deploy.sh: missing target SHA" >&2
  exit 1
fi
git fetch origin master
git checkout master
git reset --hard "$SHA"
pnpm install
pm2 restart dcc-web dcc-worker dcc-webhook
echo "deploy.sh: deployed $SHA"
