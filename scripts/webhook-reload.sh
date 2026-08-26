#!/usr/bin/env bash
# Detached webhook swapper — spawned by deploy.sh AFTER the reloadPending
# success marker is written.
#
# Why the two-phase dance: deploy.sh runs as a descendant of the OLD webhook,
# and `pm2 delete` tree-kills that entire ancestry. Phase 1 therefore
# re-spawns this script in a brand-new session (--detached) and exits
# immediately, orphaning phase 2 to init — outside the kill tree. Phase 2
# then safely swaps the webhook.
#
# Contract:
#   Requires: DCC_SWAP_MARKER, DCC_SWAP_ATTEMPT_ID, DCC_SWAP_SHA,
#             DCC_SWAP_CURRENT   (all exported by deploy.sh)
#   Optional: DCC_SWAP_DELAY    seconds phase 2 waits before touching
#                         anything (lets the old webhook release port 9003;
#                         default 1)
#
#   Success:  leaves the reloadPending marker intact — the fresh webhook
#             finalizes the deployment attempt during its own boot recovery.
#   Failure:  replaces it with a nonzero final marker (visible failed
#             attempt) instead of hanging forever.
set -u

echo "p1 $(date +%H:%M:%S.%3N) ppid=$(ps -o ppid= -p $$ | tr -d ' ')" >> /tmp/swap-trace.log
# DCC_SWAP_INLINE=1 runs phase 2 synchronously (used by the deploy harness);
# production takes the two-phase orphaning route.
if [ "${DCC_SWAP_INLINE:-}" != "1" ] && [ "${1:-}" != "--detached" ]; then
  : "${DCC_SWAP_MARKER:?}" "${DCC_SWAP_ATTEMPT_ID:?}" "${DCC_SWAP_SHA:?}" "${DCC_SWAP_CURRENT:?}"
  setsid bash "$0" --detached </dev/null >/dev/null 2>&1 &
  exit 0
fi

: "${DCC_SWAP_MARKER:?}" "${DCC_SWAP_ATTEMPT_ID:?}" "${DCC_SWAP_SHA:?}" "${DCC_SWAP_CURRENT:?}"
echo "p2 begin" >> /tmp/swap-trace.log
sleep "${DCC_SWAP_DELAY:-1}"

[ -f "$DCC_SWAP_MARKER" ] || exit 0            # attempt superseded meanwhile
cd "$DCC_SWAP_CURRENT" || exit 1

pm2 delete dcc-webhook >/dev/null 2>&1         # tolerate already-absent app
if pm2 start ecosystem.config.cjs --only dcc-webhook --update-env; then
  touch "$DCC_SWAP_MARKER.swap-done"
  exit 0                                       # boot recovery finalizes marker
fi

printf '{"attemptId":"%s","sha":"%s","exitCode":75}' "$DCC_SWAP_ATTEMPT_ID" "$DCC_SWAP_SHA" \
  > "$DCC_SWAP_MARKER.tmp.$$" && mv -f "$DCC_SWAP_MARKER.tmp.$$" "$DCC_SWAP_MARKER"
touch "$DCC_SWAP_MARKER.swap-done"
exit 75
