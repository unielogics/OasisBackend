#!/usr/bin/env bash
# links-kill.sh "REASON"     the personal links' kill switch (ADR 0160): ends every personal link, every page opened from one and
# every 30-day phone trust at once by bumping the links epoch (links.epoch). Clients verify again on a new link; reply numbers in chat
# stop running. No restart needed. Run as root on the server; the reason goes into the audit log (identity.links.killed).
# The owner can do the same from the API (POST /api/v1/identity/links/kill). To close the link routes as well, set
# PUBLIC_LINKS_ENABLED=false and restart. See docs/runbook.md, "Personal links".
set -euo pipefail
OASIS_HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
. "$OASIS_HERE/../lib/common.sh"
# shellcheck source=../lib/release.sh
. "$OASIS_HERE/../lib/release.sh"
reason=${1:-}
if [[ "$reason" == -h || "$reason" == --help ]]; then
  sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi
[[ ${#reason} -ge 3 ]] || {
  sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}
need_root
in_release_env "$OASIS_PREFIX/current/backend" pnpm exec tsx deploy/lib/links-kill.ts --reason "$reason"
