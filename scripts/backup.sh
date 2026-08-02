#!/usr/bin/env bash
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

backup_directory="${DCC_BACKUP_DIRECTORY:-data/backups}"
retention_days="${DCC_BACKUP_RETENTION_DAYS:-30}"
data_directory="${DCC_DATA_DIR:-data}"
config_directory="${DCC_CONFIG_DIR:-config}"

if ! [[ "$retention_days" =~ ^[1-9][0-9]*$ ]]; then
  echo "DCC_BACKUP_RETENTION_DAYS must be a positive integer" >&2
  exit 1
fi

mkdir -p "$backup_directory"
backup_directory="$(cd "$backup_directory" && pwd -P)"
stage="$(mktemp -d "$backup_directory/.dcc-backup.XXXXXX")"
backup="$backup_directory/dcc-$(date -u +%Y%m%dT%H%M%SZ)-$$"

cleanup() {
  [ -z "${stage:-}" ] || rm -rf -- "$stage"
}
trap cleanup EXIT

copy_tree() {
  local source="$1" destination="$2" backup_relative="${3:-}"
  mkdir -p "$destination"
  [ -d "$source" ] || return
  local -a excludes=(
    --exclude='./.env' --exclude='./.env.*' --exclude='*/.env' --exclude='*/.env.*'
    --exclude='./secrets' --exclude='./secrets/*' --exclude='*/secrets' --exclude='*/secrets/*'
    --exclude='*.key' --exclude='*.pem' --exclude='*.secret'
  )
  if [ -n "$backup_relative" ]; then
    excludes+=(--exclude="./$backup_relative" --exclude="./$backup_relative/*")
  fi
  (cd "$source" && tar "${excludes[@]}" -cf - .) | tar -C "$destination" -xf -
}

data_backup_relative=""
if [ -d "$data_directory" ]; then
  data_directory="$(cd "$data_directory" && pwd -P)"
  case "$backup_directory/" in
    "$data_directory/"*) data_backup_relative="${backup_directory#"$data_directory/"}" ;;
  esac
fi

pg_dump "$DATABASE_URL" --format=custom --file="$stage/database.dump"
copy_tree "$data_directory" "$stage/data" "$data_backup_relative"
copy_tree "$config_directory" "$stage/config"
(cd "$stage" && find . -type f ! -name 'manifest-v1.sha256' -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) > "$stage/manifest-v1.sha256"
mv -- "$stage" "$backup"
stage=""

find "$backup_directory" -mindepth 1 -maxdepth 1 -type d -name 'dcc-*' -mtime "+$retention_days" -exec rm -rf -- {} +
echo "backup created: $backup"
