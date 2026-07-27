#!/usr/bin/env bash
set -euo pipefail
if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI is not installed"
  exit 0
fi
claude auth status >/dev/null
echo "Claude authentication is valid"
