#!/usr/bin/env bash
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
resolve_path() {
  if [[ "$1" = /* ]]; then printf "%s\n" "$1"; else printf "%s/%s\n" "$repo_root" "$1"; fi
}
backup_directory="$(resolve_path "${DCC_BACKUP_DIRECTORY:-data/backups}")"
retention_days="${DCC_BACKUP_RETENTION_DAYS:-30}"
legacy_data_directory="$(resolve_path "${DCC_DATA_ROOT:-.}/data")"
data_directory="$(resolve_path "${DCC_DATA_DIR:-$legacy_data_directory}")"
config_directory="$(resolve_path "${DCC_CONFIG_DIR:-config}")"

if ! [[ "$retention_days" =~ ^[1-9][0-9]*$ ]]; then
  echo "DCC_BACKUP_RETENTION_DAYS must be a positive integer" >&2
  exit 1
fi

for required_root in "$data_directory" "$config_directory"; do
  if [ ! -d "$required_root" ]; then echo "required backup root is missing: $required_root" >&2; exit 1; fi
done
if [ "$legacy_data_directory" != "$data_directory" ] && [ ! -d "$legacy_data_directory" ]; then
  echo "required backup root is missing: $legacy_data_directory" >&2
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
    --exclude="./.env" --exclude="./.env.*" --exclude="*/.env" --exclude="*/.env.*"
    --exclude="./secrets" --exclude="./secrets/*" --exclude="*/secrets" --exclude="*/secrets/*"
    --exclude="*.key" --exclude="*.pem" --exclude="*.secret"
  )
  if [ -n "$backup_relative" ]; then
    excludes+=(--exclude="./$backup_relative" --exclude="./$backup_relative/*")
  fi
  (cd "$source" && tar "${excludes[@]}" -cf - .) | tar -C "$destination" -xf -
}

artifact_snapshot() {
  psql "$DATABASE_URL" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align <<'SQL'
SELECT encode(digest(COALESCE(jsonb_agg(to_jsonb(snapshot) ORDER BY id),'[]'::jsonb)::text,'sha256'),'hex')
FROM (
  SELECT id,storage_path,storage_root,artifact_type,status,sha256,expires_at
  FROM artifacts WHERE status IN ('staged','finalized') ORDER BY id
) snapshot;
SQL
}

artifact_registry() {
  psql "$DATABASE_URL" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align <<'SQL'
SELECT json_build_object('id',id,'storage_path',storage_path,'storage_root',storage_root,'artifact_type',artifact_type,'status',status,'sha256',sha256)
FROM artifacts WHERE status IN ('staged','finalized') ORDER BY id;
SQL
}

data_backup_relative=""
legacy_data_backup_relative=""
if [ -d "$data_directory" ]; then
  data_directory="$(cd "$data_directory" && pwd -P)"
  case "$backup_directory/" in
    "$data_directory/"*) data_backup_relative="${backup_directory#"$data_directory/"}" ;;
  esac
fi
if [ -d "$legacy_data_directory" ]; then
  legacy_data_directory="$(cd "$legacy_data_directory" && pwd -P)"
  case "$backup_directory/" in
    "$legacy_data_directory/"*) legacy_data_backup_relative="${backup_directory#"$legacy_data_directory/"}" ;;
  esac
fi

artifact_snapshot_before="$(artifact_snapshot)"
pg_dump "$DATABASE_URL" --format=custom --file="$stage/database.dump"
copy_tree "$data_directory" "$stage/data" "$data_backup_relative"
if [ "$legacy_data_directory" != "$data_directory" ]; then
  copy_tree "$legacy_data_directory" "$stage/legacy-data" "$legacy_data_backup_relative"
fi
copy_tree "$config_directory" "$stage/config"
stage_legacy="$stage/data"
[ "$legacy_data_directory" = "$data_directory" ] || stage_legacy="$stage/legacy-data"
artifact_registry | node "$repo_root/scripts/verify-artifact-registry.mjs" capture \
  "$stage/data" "$stage_legacy" "$stage/artifact-registry-v1.json" "$data_directory" "$legacy_data_directory"
if [ "$(artifact_snapshot)" != "$artifact_snapshot_before" ]; then
  echo "artifact metadata changed while the backup snapshot was copied" >&2
  exit 1
fi
(cd "$stage" && { find . -type f ! -path './manifest-v1.sha256' -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum; find . -type l -printf 'symlink %p %l\n'; } | LC_ALL=C sort) > "$stage/manifest-v1.sha256"
if ! mv -T -n -- "$stage" "$backup" || [ -d "$stage" ]; then
  echo "backup destination appeared before publish" >&2
  exit 1
fi
stage=""

find "$backup_directory" -mindepth 1 -maxdepth 1 -type d \( -name "dcc-*" -o -name ".dcc-backup.*" \) ! -newermt "$retention_days days ago" -exec rm -rf -- {} +
echo "backup created: $backup"
