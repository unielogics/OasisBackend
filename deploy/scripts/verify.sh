#!/usr/bin/env bash
# verify.sh smsgate|squarespace|aws|all [options of that check]
#
# Runs pnpm verify:<name> from the current release as the oasis user, with /etc/oasis/common.env and api.env loaded, and writes the
# reports to /var/lib/oasis/live-verification (a release directory is replaced on every deploy, the state directory is not).
# Options are those of the check; see docs/live-verification.md. Examples:
#   verify.sh smsgate                                   read-only
#   verify.sh smsgate --send --to +13055550100 --watch --replies
#   verify.sh squarespace --days 90 --capture /var/lib/oasis/live-verification/captures
#   verify.sh aws --instance-profile --send --to you@example.com
set -euo pipefail
OASIS_HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
. "$OASIS_HERE/../lib/common.sh"
# shellcheck source=../lib/release.sh
. "$OASIS_HERE/../lib/release.sh"

which=${1:-}
case "$which" in
  smsgate | squarespace | aws | all) shift ;;
  -h | --help | "")
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    [[ -n "$which" ]] && exit 0 || exit 2
    ;;
  *) die "unknown check $which (smsgate, squarespace, aws or all)" ;;
esac
BACKEND="$OASIS_PREFIX/current/backend"
[[ -d "$BACKEND" ]] || die "$BACKEND does not exist: deploy first"
OUT="$OASIS_STATE/live-verification"
as_oasis mkdir -p "$OUT"
in_release_env "$BACKEND" env "VERIFY_LIVE_OUT_DIR=$OUT" pnpm -s "verify:$which" -- "$@"
