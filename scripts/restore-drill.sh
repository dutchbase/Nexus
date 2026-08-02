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
  node -e 'const url = new URL(process.argv[1]); console.log(url.hostname + ":" + (url.port || "5432") + "/" + decodeURIComponent(url.pathname))' "$1"
}

if [ "$(database_identity "$DATABASE_URL")" = "$(database_identity "$DCC_RESTORE_DATABASE_URL")" ]; then
  echo "DCC_RESTORE_DATABASE_URL must identify a different disposable database" >&2
  exit 1
fi

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
step="health"
curl --fail --silent --show-error "$DCC_RESTORE_HEALTH_URL"
step=""
echo "restore drill passed: $backup_directory"
