#!/bin/bash
set -euo pipefail
BASE_DIR="${DCC_ROOT:-/opt/nexus}"
cd "$BASE_DIR"
set -a; source "$BASE_DIR/.env"; set +a
exec node "$BASE_DIR/webhook-server.js"
