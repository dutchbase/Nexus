#!/usr/bin/env bash
set -euo pipefail
if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi
backup_directory="${DCC_BACKUP_DIRECTORY:-data/backups}"
mkdir -p "$backup_directory"
pg_dump "$DATABASE_URL" --format=custom --file="$backup_directory/dcc-$(date -u +%Y%m%dT%H%M%SZ).dump"
