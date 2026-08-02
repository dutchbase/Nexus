#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ] || [ ! -d "$1" ]; then
  echo "usage: $0 BACKUP_DIRECTORY" >&2
  exit 1
fi
for variable in DATABASE_URL DCC_RESTORE_DATABASE_URL DCC_RESTORE_HEALTH_URL; do
  if [ -z "${!variable:-}" ]; then
    echo "$variable is required" >&2
    exit 1
  fi
done
database_identity() {
  psql "$1" --quiet --tuples-only --no-align --command "SELECT current_database() || '|' || COALESCE(inet_server_addr()::text,'local') || '|' || COALESCE(inet_server_port()::text,'local');"
}

primary_database_identity="$(database_identity "$DATABASE_URL")"
restore_database_identity="$(database_identity "$DCC_RESTORE_DATABASE_URL")"
if [ "$primary_database_identity" = "$restore_database_identity" ]; then
  echo "DCC_RESTORE_DATABASE_URL must identify a different disposable database" >&2
  exit 1
fi

restore_database_disposable="$(psql "$DCC_RESTORE_DATABASE_URL" --quiet --tuples-only --no-align --command "SELECT COALESCE(current_setting('dcc.restore_disposable', true), 'false');")"
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
step=""
backup_directory="$(cd "$1" && pwd -P)"
manifest="$backup_directory/manifest-v1.sha256"
manifest_sha256=""
step="manifest"

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

[ -f "$manifest" ]
manifest_sha256="$(sha256sum "$manifest" | awk '{print $1}')"
(cd "$backup_directory" && sha256sum --check --status "manifest-v1.sha256")
step="restore"
pg_restore --clean --if-exists --no-owner --dbname="$DCC_RESTORE_DATABASE_URL" "$backup_directory/database.dump"
step="verify"
if [ "$(database_identity "$DCC_RESTORE_DATABASE_URL")" != "$restore_database_identity" ]; then
  echo "DCC_RESTORE_DATABASE_URL changed target during restore" >&2
  exit 1
fi
step="health"
curl --fail --silent --show-error "$DCC_RESTORE_HEALTH_URL"
step=""
echo "restore drill passed: $backup_directory"
