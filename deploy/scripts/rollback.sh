#!/usr/bin/env bash
# rollback.sh [--to RELEASE_ID] [--list] [--wait SECONDS] [--dry-run]
#
# Points current at the previous release (or --to), restarts the services and health-checks them. The code goes back at once, from
# the release directory, with no rebuild. The DATABASE does not go back: migrations are forward-only, and the old code runs against
# the migrated schema. If a migration made that unsafe, restore the pre-deploy backup instead (docs/runbook.md, "Roll back").
# Exit 0 = back on the target and healthy, 3 = switched but unhealthy, 1 = nothing done.
set -euo pipefail
OASIS_HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
. "$OASIS_HERE/../lib/common.sh"
# shellcheck source=../lib/release.sh
. "$OASIS_HERE/../lib/release.sh"

TO=""
LIST=0
WAIT=90
while (($#)); do
  case "$1" in
    --to) TO=$2; shift 2 ;;
    --list) LIST=1; shift ;;
    --wait) WAIT=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help)
      sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown option $1" ;;
  esac
done

cur=$(current_release)
prev=$(previous_release)

if ((LIST)); then
  while IFS= read -r r; do
    tag=""
    [[ "$r" == "$cur" ]] && tag=" <- current"
    [[ "$r" == "$prev" ]] && tag=" <- previous"
    printf '%s%s%s\n' "$(basename "$r")" "$(release_ok "$r" || printf ' (incomplete)')" "$tag"
  done < <(list_releases)
  exit 0
fi

need_root
exec 9>"$OASIS_PREFIX/.deploy.lock"
flock -n 9 || die "a deploy or rollback is running"

target=""
if [[ -n "$TO" ]]; then
  target="$OASIS_PREFIX/releases/$TO"
else
  target=$prev
fi
[[ -n "$target" && -d "$target" ]] || die "no release to go back to (try --list)"
[[ "$target" != "$cur" ]] || die "$(basename "$target") is already the current release"
release_ok "$target" || die "$(basename "$target") is not a complete build (dist or .next-live is missing)"

log "rolling back from $(basename "${cur:-none}") to $(basename "$target")"
[[ -z "$cur" ]] || point_symlink previous "$cur"
point_symlink current "$target"
restart_services || warn "a service failed to restart"
if health_gate "$WAIT"; then
  record_deploy "$(basename "$target")" rollback-ok
  changed "now running $(basename "$target")"
else
  warn "switched to $(basename "$target") but the stack is not healthy: journalctl -u oasis-api -u oasis-worker -u oasis-web --since '10 min ago'"
  exit 3
fi
