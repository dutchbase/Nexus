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

backup_directory="$(cd "$1" && pwd -P)"
recovery_root="$DCC_RESTORE_ROOT"
mkdir -p "$recovery_root"
recovery_root="$(cd "$recovery_root" && pwd -P)"
case "$recovery_root" in /|"$backup_directory"|"$backup_directory"/*) echo "DCC_RESTORE_ROOT must be separate from the backup" >&2; exit 1 ;; esac

manifest="$backup_directory/manifest-v1.sha256"
manifest_sha256=""
step="preflight"

record_result() {
  local code="$?" status="failed"
  trap - EXIT
  [ "$code" -eq 0 ] && status="passed"
  if ! psql "$DATABASE_URL" --set=ON_ERROR_STOP=1 --set=backup_path="$backup_directory" --set=manifest_sha256="$manifest_sha256" --set=status="$status" --set=failure_step="$step" --command "INSERT INTO backup_recovery_verifications (backup_path,manifest_sha256,status,failure_step) VALUES (:'backup_path',NULLIF(:'manifest_sha256',''),:'status',NULLIF(:'failure_step',''));" ; then
    [ "$code" -ne 0 ] || code=1
  fi
  exit "$code"
}
trap record_result EXIT

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
step="preflight"
if ! health_database_identity="$(curl --fail --silent --show-error "$DCC_RESTORE_HEALTH_URL" | node -e 'let body=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => body += chunk); process.stdin.on("end", () => { const identity = JSON.parse(body).database_identity; if (typeof identity !== "string" || !identity) process.exit(1); process.stdout.write(identity); });')"; then
  echo "health endpoint must expose a database identity" >&2
  exit 1
fi
if [ "$health_database_identity" != "$restore_database_fingerprint" ]; then
  echo "health endpoint is connected to a different database" >&2
  exit 1
fi
step="manifest"
[ -f "$manifest" ]
manifest_sha256="$(sha256sum "$manifest" | awk '{print $1}')"
(cd "$backup_directory" && sha256sum --check --status "manifest-v1.sha256")
step="payload"
for payload in data config; do
  [ -d "$backup_directory/$payload" ] || { echo "backup payload is missing: $payload" >&2; exit 1; }
  mkdir -p "$recovery_root/$payload"
  (cd "$backup_directory/$payload" && tar -cf - .) | tar -C "$recovery_root/$payload" -xf -
  find "$recovery_root/$payload" -type f -print -quit | grep -q . || { echo "restored payload is empty: $payload" >&2; exit 1; }
done
if [ -d "$backup_directory/legacy-data" ]; then
  mkdir -p "$recovery_root/legacy-data"
  (cd "$backup_directory/legacy-data" && tar -cf - .) | tar -C "$recovery_root/legacy-data" -xf -
  find "$recovery_root/legacy-data" -type f -print -quit | grep -q . || { echo "restored payload is empty: legacy-data" >&2; exit 1; }
fi

step="restore"
pg_restore --clean --if-exists --no-owner --dbname="$DCC_RESTORE_DATABASE_URL" "$backup_directory/database.dump"
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
step=""
echo "restore drill passed: $backup_directory"
