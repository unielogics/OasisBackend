#!/usr/bin/env bash
# secrets-rotate.sh [--new-key-file FILE | --generate] [--apply] [--dry-run]
#
# Rotates SECRETS_KEY, the key that encrypts the tablet and Squarespace credentials in the database (pnpm secrets:rotate does the
# re-encryption; this wrapper does the safe order of operations around it).
#   without --apply   dry run: decrypts every stored credential with the current key and reports; changes nothing
#   with --apply      1. dry run, 2. pre-rotate backup, 3. stop worker and API, 4. re-encrypt in ONE transaction (read-back verified),
#                     5. write the new SECRETS_KEY into common.env (previous file kept as common.env.bak-<time>), 6. start, health-check
# The services must be stopped because a running process holds the old key and cannot read the new ciphertext.
# A failure before step 5 leaves the database and common.env exactly as they were; the services are started again.
# Copy the new key to your password manager BEFORE deleting anything. SESSION_SECRET is separate: changing it only signs people out.
set -euo pipefail
OASIS_HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
. "$OASIS_HERE/../lib/common.sh"
# shellcheck source=../lib/release.sh
. "$OASIS_HERE/../lib/release.sh"

NEW_FILE=""
GENERATE=0
APPLY=0
while (($#)); do
  case "$1" in
    --new-key-file) NEW_FILE=$2; shift 2 ;;
    --generate) GENERATE=1; shift ;;
    --apply) APPLY=1; shift ;;
    --dry-run) APPLY=0; shift ;;
    -h | --help)
      sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown option $1" ;;
  esac
done
need_root
COMMON="$OASIS_ETC/common.env"
BACKEND="$OASIS_PREFIX/current/backend"
[[ -d "$BACKEND" ]] || die "$BACKEND does not exist: deploy first"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
chmod 700 "$tmp"
if ((GENERATE)); then
  [[ -z "$NEW_FILE" ]] || die "use --generate or --new-key-file, not both"
  NEW_FILE="$OASIS_ETC/secrets-key.new"
  [[ ! -e "$NEW_FILE" ]] || die "$NEW_FILE already exists from an earlier run; move it away first"
  "$OASIS_HERE/gen-secrets.sh" SECRETS_KEY | cut -d= -f2- >"$NEW_FILE"
  chmod 0640 "$NEW_FILE"
  chown "root:$OASIS_USER" "$NEW_FILE" 2>/dev/null || true
  warn "a new key was written to $NEW_FILE: copy it to a password manager now"
fi
[[ -r "$NEW_FILE" ]] || die "give --new-key-file FILE or --generate"
OLD_KEY=$(env_get "$COMMON" SECRETS_KEY) || die "SECRETS_KEY is not set in $COMMON"

rotate() { # rotate [--apply]
  in_release_env "$BACKEND" env "OLD_SECRETS_KEY=$OLD_KEY" "NEW_SECRETS_KEY=$(<"$NEW_FILE")" pnpm -s secrets:rotate -- --old-key-env OLD_SECRETS_KEY --new-key-env NEW_SECRETS_KEY "$@"
}

log "dry run"
rotate || die "the dry run failed; nothing was changed"
if ((APPLY == 0)); then
  log "that was a dry run. To rotate: $0 --new-key-file $NEW_FILE --apply"
  exit 0
fi

log "pre-rotate backup"
as_oasis "${BACKUP_CMD:-$OASIS_HERE/backup.sh}" --label pre-rotate || die "backup failed; nothing was changed"
log "stopping the API and the worker"
run_system "$SYSTEMCTL" stop oasis-api.service oasis-worker.service
restart_all() { restart_services || true; }
if ! rotate --apply; then
  restart_all
  die "re-encryption failed and was rolled back; the old key is still in force and the services were restarted"
fi
env_file_set "$COMMON" SECRETS_KEY "$(<"$NEW_FILE")"
changed "SECRETS_KEY in $COMMON replaced (previous file: $COMMON.bak-*; it holds the OLD key, delete it once all is well)"
restart_all
if health_gate 90; then
  ok "healthy on the new key. Next: pnpm verify:smsgate and a test send, then delete $NEW_FILE and the common.env.bak-* files after storing the key."
else
  die "the stack is not healthy after the rotation: journalctl -u oasis-api -u oasis-worker --since '5 min ago'. To undo: restore common.env from common.env.bak-* AND restore the pre-rotate backup."
fi
