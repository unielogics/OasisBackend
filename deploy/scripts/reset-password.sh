#!/usr/bin/env bash
# reset-password.sh EMAIL [--enable]     break-glass for a locked-out Super Admin: sets a new password straight in the database.
# Reads the new password from the terminal (hidden), or from stdin when it is piped. Run as root on the server.
# Revokes every session of that login; --enable also re-activates a login that was deactivated. See docs/runbook.md.
set -euo pipefail
OASIS_HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
. "$OASIS_HERE/../lib/common.sh"
# shellcheck source=../lib/release.sh
. "$OASIS_HERE/../lib/release.sh"
email=${1:-}
[[ "$email" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || {
  sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}
shift
need_root
extra=()
[[ "${1:-}" == --enable ]] && extra=(--enable)
if [[ -t 0 ]]; then
  in_release_env "$OASIS_PREFIX/current/backend" pnpm exec tsx deploy/lib/reset-password.ts --email "$email" "${extra[@]}"
else
  in_release_env "$OASIS_PREFIX/current/backend" pnpm exec tsx deploy/lib/reset-password.ts --email "$email" --password-stdin "${extra[@]}"
fi
