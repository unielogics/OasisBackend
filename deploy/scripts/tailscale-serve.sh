#!/usr/bin/env bash
# tailscale-serve.sh [--https-port 8443] [--hooks-port 3002] [--path /hooks/smsgate] [--status | --off | --reset] [--dry-run]
#
# Exposes ONLY the SMS Gate webhook on the tailnet:
#   https://<this-host>.<tailnet>.ts.net:8443/hooks/smsgate/<deviceKey>  ->  http://127.0.0.1:3002/hooks/smsgate/<deviceKey>
# 3002 is the API's second listener (HOOKS_PORT). Nothing else on this node is served, and Funnel (the public internet) is never used.
#
# tailscale serve strips the mount path before proxying, so the target carries the full path again (docs/integrations/smsgate.md,
# item 8). The default port is 8443, not 443, because nginx owns 443 on this host and sharing a port between nginx and tailscaled
# is unverified; the tablet accepts any HTTPS port. If you use 443, change the Tailscale ACL (docs/deployment.md) to match.
#
# The script refuses to touch a node that already serves something else; use --reset to wipe the node's serve config first.
# After applying, it reads the configuration back and fails unless it is exactly the one mount.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
. "$here/../lib/common.sh"

TS="${TAILSCALE_BIN:-tailscale}"
HTTPS_PORT="${TS_SERVE_HTTPS_PORT:-8443}"
HOOKS_PORT="${HOOKS_PORT:-3002}"
MOUNT="/hooks/smsgate"
MODE=apply
RESET=0

while (($#)); do
  case "$1" in
    --https-port) HTTPS_PORT=$2; shift 2 ;;
    --hooks-port) HOOKS_PORT=$2; shift 2 ;;
    --path) MOUNT=$2; shift 2 ;;
    --status) MODE=status; shift ;;
    --off) MODE=off; shift ;;
    --reset) RESET=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown option $1" ;;
  esac
done

have "$TS" || die "tailscale is not installed (https://tailscale.com/download/linux)"
TARGET="http://127.0.0.1:${HOOKS_PORT}${MOUNT}"

classify() {
  "$TS" serve status --json 2>/dev/null | node "$here/../lib/serve-check.mjs" --port "$HTTPS_PORT" --path "$MOUNT" --target "$TARGET" || true
}

"$TS" status >/dev/null 2>&1 || die "this node is not logged in to Tailscale: sudo tailscale up --hostname=oasis-api, then approve the login URL"
state=$(classify)
log "current serve configuration: ${state}"

case "$MODE" in
  status)
    [[ "$state" == exact ]] && exit 0
    [[ "$state" == empty ]] && exit 3
    exit 1
    ;;
  off)
    [[ "$state" == empty ]] && {
      ok "nothing is served"
      exit 0
    }
    run "$TS" serve --yes --https="$HTTPS_PORT" --set-path="$MOUNT" off
    exit 0
    ;;
esac

case "$state" in
  exact) ok "already serving exactly $MOUNT on :$HTTPS_PORT" ;;
  empty) ;;
  *)
    if ((RESET)); then
      run "$TS" serve reset
    else
      die "this node already serves something else (${state}). Review it with: tailscale serve status. To replace it with only the SMS Gate mount: $0 --reset"
    fi
    ;;
esac

if [[ "$state" != exact ]]; then
  run "$TS" serve --bg --yes --https="$HTTPS_PORT" --set-path="$MOUNT" "$TARGET"
fi

if [[ "$DRY_RUN" != 1 ]]; then
  after=$(classify)
  [[ "$after" == exact ]] || die "after applying, the node serves: ${after}. Expected only $MOUNT. Run: tailscale serve status"
  dns=$("$TS" status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log((JSON.parse(s).Self.DNSName||"").replace(/\.$/,""))}catch{}})')
  ok "serving only $MOUNT -> $TARGET"
  if [[ -n "$dns" ]]; then
    echo
    echo "Put this in /etc/oasis/common.env (SMSGATE_WEBHOOK_PUBLIC_URL) and restart oasis-api:"
    echo "  SMSGATE_WEBHOOK_PUBLIC_URL=https://${dns}:${HTTPS_PORT}${MOUNT}"
    echo "Registered with the tablet by the API as that URL plus /<deviceKey>. Tailscale ACL: tag:oasis-tablet -> tag:oasis-server:${HTTPS_PORT}."
  else
    warn "could not read this node's DNS name; enable MagicDNS and HTTPS certificates in the Tailscale admin console"
  fi
fi
