#!/bin/bash
set -euo pipefail

ROOT="${DCC_ROOT:-/home/deploy/projects/dev-control}"
SHA="${1:-}"
MARKER="${2:-}"
ATTEMPT_ID="${3:-}"
BRANCH="${4:-}"
RELEASES="${DCC_DEPLOY_RELEASES_DIR:-$ROOT/.deploy-releases}"
CURRENT="${DCC_DEPLOY_CURRENT_LINK:-$ROOT/.deploy-current}"
NEXT_CURRENT="$CURRENT.next"
RELEASE="$RELEASES/$SHA"
PRIOR_RELEASE=""
CUTOVER=0

die() {
  echo "deploy.sh: $*" >&2
  exit 1
}

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "target SHA must be lowercase 40-character hex"
[[ "$MARKER" = /* ]] || die "marker path must be absolute"
[[ "$ATTEMPT_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || die "attempt ID must be a UUID"

write_marker() {
  local exit_code="$1"
  local temporary="$MARKER.tmp.$$"
  printf '{"attemptId":"%s","sha":"%s","exitCode":%s}' "$ATTEMPT_ID" "$SHA" "$exit_code" > "$temporary"
  mv -f "$temporary" "$MARKER"
}

record_event() {
  local stage="$1"
  psql "$DATABASE_URL" --set=ON_ERROR_STOP=1 --set=attempt_id="$ATTEMPT_ID" --set=event_key="deploy:$stage" --set=event_type=stage --set=stage="$stage" --command "INSERT INTO deployment_events (attempt_id,event_key,event_type,metadata) VALUES (:'attempt_id'::uuid, :'event_key', :'event_type', jsonb_build_object('stage', :'stage')) ON CONFLICT (attempt_id,event_key) DO NOTHING"
}

switch_current() {
  ln -s "$1" "$NEXT_CURRENT"
  mv -Tf "$NEXT_CURRENT" "$CURRENT"
}

rollback() {
  local status="$?"
  local recovered=1
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    if [ "$CUTOVER" -eq 1 ]; then
      if [ -n "$PRIOR_RELEASE" ]; then
        switch_current "$PRIOR_RELEASE" || recovered=0
        pm2 startOrReload "$CURRENT/ecosystem.config.cjs" --only dcc-web --update-env || recovered=0
        pm2 startOrReload "$CURRENT/ecosystem.config.cjs" --only dcc-worker --update-env || recovered=0
        curl --fail --silent --show-error --max-time 10 "$DCC_DEPLOY_HEALTH_URL" || recovered=0
      else
        rm -f "$CURRENT"
        pm2 delete dcc-web || recovered=0
        pm2 delete dcc-worker || recovered=0
      fi
    fi
    if [ -n "${DATABASE_URL:-}" ]; then record_event "rollback" || recovered=0; fi
    write_marker "$status" || recovered=0
    [ "$recovered" -eq 1 ] || echo "deploy.sh: rollback recovery failed" >&2
    exit "$status"
  fi
}
trap rollback EXIT

git check-ref-format --branch "$BRANCH" >/dev/null 2>&1 || die "protected branch is invalid"
: "${DATABASE_URL:?deploy.sh: DATABASE_URL is required}"
: "${DCC_DEPLOY_HEALTH_URL:?deploy.sh: DCC_DEPLOY_HEALTH_URL is required}"
[ -f "$ROOT/.env" ] || die "$ROOT/.env is required"
[ -f "$ROOT/.env.worker" ] || die "$ROOT/.env.worker is required"
cd "$ROOT"

if [ -L "$CURRENT" ]; then
  PRIOR_RELEASE="$(readlink -f "$CURRENT")"
  [ -d "$PRIOR_RELEASE" ] || die "current release link is broken"
elif [ -e "$CURRENT" ]; then
  die "current release must be a symlink"
fi

mkdir -p "$RELEASES" "$ROOT/data"
git fetch --no-tags origin "$BRANCH"
[ "$(git rev-parse FETCH_HEAD)" = "$SHA" ] || die "fetched protected head does not match target SHA"
record_event "protected_head_verified"

if [ -e "$RELEASE" ]; then
  [ -d "$RELEASE" ] && [ "$(git -C "$RELEASE" rev-parse HEAD)" = "$SHA" ] || die "release path is not the requested detached worktree"
else
  git worktree add --detach "$RELEASE" "$SHA"
fi
ln -s "$ROOT/.env" "$RELEASE/.env"
ln -s "$ROOT/.env.worker" "$RELEASE/.env.worker"
ln -s "$ROOT/data" "$RELEASE/data"
record_event "staged"

cd "$RELEASE"
pnpm install --frozen-lockfile
record_event "dependencies_installed"
pnpm --filter database migrate
record_event "migrated"
pnpm exec tsx scripts/sync-agent-content.ts
record_event "synced"

switch_current "$RELEASE"
CUTOVER=1
record_event "cutover"
pm2 startOrReload "$CURRENT/ecosystem.config.cjs" --only dcc-web --update-env
pm2 startOrReload "$CURRENT/ecosystem.config.cjs" --only dcc-worker --update-env
record_event "processes_reloaded"
curl --fail --silent --show-error --max-time 10 "$DCC_DEPLOY_HEALTH_URL"
record_event "healthy"
write_marker 0
pm2 startOrReload "$CURRENT/ecosystem.config.cjs" --only dcc-webhook --update-env
echo "deploy.sh: deployed $SHA"
