#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ] || [ ! -d "$1" ]; then
  echo "usage: $0 BACKUP_DIRECTORY" >&2
  exit 1
fi
for variable in DATABASE_URL DCC_RESTORE_DATABASE_URL DCC_RESTORE_HEALTH_URL DCC_RESTORE_ROOT; do
  if [ -z "${!variable:-}" ]; then
    echo "$variable is required" >&2
    exit 1
  fi
done

repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
resolve_path() {
  if [[ "$1" = /* ]]; then printf "%s\n" "$1"; else printf "%s/%s\n" "$repo_root" "$1"; fi
}

backup_directory="$(cd "$1" && pwd -P)"
manifest="$backup_directory/manifest-v1.sha256"
manifest_sha256=""
step="preflight"
stage=""
actual_manifest=""

record_result() {
  local code=$?
  local status="failed"
  trap - EXIT
  if [ -n "$actual_manifest" ]; then rm -f -- "$actual_manifest" || true; fi
  if [ -n "$stage" ]; then rm -rf -- "$stage" || true; fi
  [ "$code" -eq 0 ] && status="passed"
  if ! psql "$DATABASE_URL" --set=ON_ERROR_STOP=1 --set=backup_path="$backup_directory" --set=manifest_sha256="$manifest_sha256" --set=status="$status" --set=failure_step="$step" --command "INSERT INTO backup_recovery_verifications (backup_path,manifest_sha256,status,failure_step) VALUES (:'backup_path',NULLIF(:'manifest_sha256',''),:'status',NULLIF(:'failure_step',''));" ; then
    [ "$code" -ne 0 ] || code=1
  fi
  exit "$code"
}
trap record_result EXIT

if [[ "$DCC_RESTORE_ROOT" != /* ]]; then
  echo "DCC_RESTORE_ROOT must be an absolute normalized path" >&2
  exit 1
fi
if [ -e "$DCC_RESTORE_ROOT" ] || [ -L "$DCC_RESTORE_ROOT" ]; then
  echo "DCC_RESTORE_ROOT must not already exist" >&2
  exit 1
fi
recovery_root="$(realpath -m -- "$DCC_RESTORE_ROOT")"
if [ "$recovery_root" != "$DCC_RESTORE_ROOT" ]; then
  echo "DCC_RESTORE_ROOT must be an absolute normalized path" >&2
  exit 1
fi
recovery_parent="$(dirname -- "$recovery_root")"
if [ ! -d "$recovery_parent" ]; then
  echo "DCC_RESTORE_ROOT parent must already exist" >&2
  exit 1
fi
recovery_parent="$(cd "$recovery_parent" && pwd -P)"
recovery_root="$recovery_parent/$(basename -- "$recovery_root")"
if [ -e "$recovery_root" ] || [ -L "$recovery_root" ]; then
  echo "DCC_RESTORE_ROOT must not already exist" >&2
  exit 1
fi

legacy_data_directory="$(resolve_path "${DCC_DATA_ROOT:-.}/data")"
data_directory="$(resolve_path "${DCC_DATA_DIR:-$legacy_data_directory}")"
config_directory="$(resolve_path "${DCC_CONFIG_DIR:-config}")"
backup_root="$(dirname -- "$backup_directory")"
for protected_root in "$repo_root" "$data_directory" "$legacy_data_directory" "$config_directory" "$backup_root"; do
  protected_root="$(realpath -m -- "$protected_root")"
  case "$recovery_root/" in
    "$protected_root/"*)
      echo "DCC_RESTORE_ROOT must be outside repository, live, and backup roots" >&2
      exit 1
      ;;
  esac
done

database_identity() {
  psql "$1" --quiet --tuples-only --no-align --command "SELECT current_database() || chr(124) || (pg_control_system()).system_identifier;"
}

primary_database_identity="$(database_identity "$DATABASE_URL")"
restore_database_identity="$(database_identity "$DCC_RESTORE_DATABASE_URL")"
if [ "$primary_database_identity" = "$restore_database_identity" ]; then
  echo "DCC_RESTORE_DATABASE_URL must identify a different disposable database" >&2
  exit 1
fi

restore_database_disposable="$(psql "$DCC_RESTORE_DATABASE_URL" --quiet --tuples-only --no-align --command "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_db_role_setting settings WHERE settings.setdatabase = (SELECT oid FROM pg_database WHERE datname=current_database()) AND settings.setrole=0 AND \$\$dcc.restore_disposable=true\$\$ = ANY(settings.setconfig)) THEN \$\$true\$\$ ELSE \$\$false\$\$ END;")"
if [ "$restore_database_disposable" != "true" ]; then
  echo "DCC_RESTORE_DATABASE_URL must be marked disposable with dcc.restore_disposable=true" >&2
  exit 1
fi

restore_database_fingerprint="$(node -e 'const { createHash } = require("node:crypto"); process.stdout.write(createHash("sha256").update(process.argv[1]).digest("hex"));' "$restore_database_identity")"
if ! health_database_identity="$(curl --fail --silent --show-error "$DCC_RESTORE_HEALTH_URL" | node -e 'let body=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => body += chunk); process.stdin.on("end", () => { const identity = JSON.parse(body).database_identity; if (typeof identity !== "string" || !identity) process.exit(1); process.stdout.write(identity); });')"; then
  echo "health endpoint must expose a database identity" >&2
  exit 1
fi
if [ "$health_database_identity" != "$restore_database_fingerprint" ]; then
  echo "health endpoint is connected to a different database" >&2
  exit 1
fi

step="manifest"
if [ ! -f "$manifest" ]; then
  echo "backup manifest is missing" >&2
  exit 1
fi
manifest_sha256="$(sha256sum "$manifest" | awk '{print $1}')"

if find "$backup_directory" -mindepth 1 ! -type d ! -type f -print -quit | grep -q .; then
  echo "backup contains unsupported filesystem entries" >&2
  exit 1
fi
if find "$backup_directory" -type f \
  ! -path "$manifest" \
  ! -path "$backup_directory/database.dump" \
  ! -path "$backup_directory/data/*" \
  ! -path "$backup_directory/config/*" \
  ! -path "$backup_directory/legacy-data/*" \
  -print -quit | grep -q .; then
  echo "backup contains an unexpected payload path" >&2
  exit 1
fi
for payload in data config; do
  if [ ! -d "$backup_directory/$payload" ]; then
    echo "backup payload is missing: $payload" >&2
    exit 1
  fi
done
if [ ! -f "$backup_directory/database.dump" ]; then
  echo "backup payload is missing: database.dump" >&2
  exit 1
fi

verify_exact_manifest() {
  local root="$1"
  actual_manifest="$(mktemp "$recovery_parent/.dcc-restore-manifest.XXXXXX")"
  (cd "$root" && find . -type f ! -path './manifest-v1.sha256' -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) > "$actual_manifest"
  if ! cmp -s "$root/manifest-v1.sha256" "$actual_manifest"; then
    echo "backup manifest does not match the exact file set" >&2
    exit 1
  fi
  rm -f -- "$actual_manifest"
  actual_manifest=""
}

verify_exact_manifest "$backup_directory"

step="payload"
stage="$(mktemp -d "$recovery_parent/.dcc-restore.XXXXXX")"
cp -- "$backup_directory/database.dump" "$backup_directory/manifest-v1.sha256" "$stage/"
for payload in data config; do
  mkdir "$stage/$payload"
  (cd "$backup_directory/$payload" && tar -cf - .) | tar -C "$stage/$payload" -xf -
  find "$stage/$payload" -type f -print -quit | grep -q . || {
    echo "restored payload is empty: $payload" >&2
    exit 1
  }
done
if [ -d "$backup_directory/legacy-data" ]; then
  mkdir "$stage/legacy-data"
  (cd "$backup_directory/legacy-data" && tar -cf - .) | tar -C "$stage/legacy-data" -xf -
  find "$stage/legacy-data" -type f -print -quit | grep -q . || {
    echo "restored payload is empty: legacy-data" >&2
    exit 1
  }
fi
verify_exact_manifest "$stage"

step="restore"
pg_restore --clean --if-exists --no-owner --dbname="$DCC_RESTORE_DATABASE_URL" "$stage/database.dump"
step="verify"
if [ "$(database_identity "$DCC_RESTORE_DATABASE_URL")" != "$restore_database_identity" ]; then
  echo "DCC_RESTORE_DATABASE_URL changed target during restore" >&2
  exit 1
fi

step="health"
if ! post_restore_health_database_identity="$(curl --fail --silent --show-error "$DCC_RESTORE_HEALTH_URL" | node -e 'let body=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => body += chunk); process.stdin.on("end", () => { const identity = JSON.parse(body).database_identity; if (typeof identity !== "string" || !identity) process.exit(1); process.stdout.write(identity); });')"; then
  echo "health endpoint must expose a database identity after restore" >&2
  exit 1
fi
if [ "$post_restore_health_database_identity" != "$restore_database_fingerprint" ]; then
  echo "health endpoint changed database after restore" >&2
  exit 1
fi

step="publish"
rm -- "$stage/database.dump" "$stage/manifest-v1.sha256"
if [ -e "$recovery_root" ] || [ -L "$recovery_root" ]; then echo "DCC_RESTORE_ROOT appeared before publish" >&2; exit 1; fi
mv -T -- "$stage" "$recovery_root"
stage=""
step=""
echo "restore drill passed: $backup_directory"
