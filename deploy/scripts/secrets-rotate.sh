#!/usr/bin/env bash
# secrets-rotate.sh [--new-key-file FILE | --generate] [--profile NAME] [--apply] [--dry-run]
#
# Rotates SECRETS_KEY, the key that encrypts the tablet and Squarespace credentials in the database (pnpm secrets:rotate does the
# re-encryption; this wrapper does the safe order of operations around it).
#   without --apply   dry run: decrypts every stored credential with the current key and reports; changes nothing
#   with --apply      1. dry run (and, with the secret, a secrets:push plan that proves the operator may write it), 2. pre-rotate
#                     backup, 3. stop worker and API, 4. re-encrypt in ONE transaction (read-back verified), 5. store the new
#                     SECRETS_KEY: in the secret OASIS_SECRET_ID (pnpm secrets:push as the operator, --profile NAME of root's ~/.aws)
#                     or, on a host without the secret, in common.env (previous file kept as common.env.bak-<time>), 6. start, check.
# The services must be stopped because a running process holds the old key and cannot read the new ciphertext.
# A failure before step 5 leaves the database and the stored key exactly as they were; the services are started again.
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
PROFILE=""
while (($#)); do
  case "$1" in
    --new-key-file) NEW_FILE=$2; shift 2 ;;
    --generate) GENERATE=1; shift ;;
    --apply) APPLY=1; shift ;;
    --profile) PROFILE=$2; shift 2 ;;
    --dry-run) APPLY=0; shift ;;
    -h | --help)
      sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
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
SID=$(secret_id)
if [[ -n "$SID" ]]; then
  [[ -z "$(env_get "$COMMON" SECRETS_KEY 2>/dev/null || true)" ]] || die "$COMMON still sets SECRETS_KEY, which wins over the secret $SID: move it first (install.sh --move-secrets)"
  OLD_KEY=$(config_value SECRETS_KEY) || die "SECRETS_KEY is not in the secret $SID"
else
  OLD_KEY=$(env_get "$COMMON" SECRETS_KEY) || die "SECRETS_KEY is not set in $COMMON"
fi
# the new key as a one-line file for secrets:push (private directory, removed on exit)
printf 'SECRETS_KEY=%s\n' "$(tr -d '[:space:]' <"$NEW_FILE")" >"$tmp/secrets-key.env"
push_key() { # push_key [--apply]
  secrets_push --profile "$PROFILE" --secret-id "$SID" --region "$(aws_region)" --from "$tmp/secrets-key.env" "$@"
}

rotate() { # rotate [--apply]
  in_release_env "$BACKEND" env "OLD_SECRETS_KEY=$OLD_KEY" "NEW_SECRETS_KEY=$(<"$NEW_FILE")" pnpm -s secrets:rotate -- --old-key-env OLD_SECRETS_KEY --new-key-env NEW_SECRETS_KEY "$@"
}

log "dry run"
rotate || die "the dry run failed; nothing was changed"
if [[ -n "$SID" ]] && ((APPLY)); then
  [[ -n "$PROFILE" ]] || die "this host reads SECRETS_KEY from the secret $SID: give --profile <operator profile> so the new key can be stored there"
  log "checking that the operator may write the secret $SID (plan only)"
  push_key || die "secrets:push cannot plan the change of $SID (see above); nothing was changed"
fi
if ((APPLY == 0)); then
  log "that was a dry run. To rotate: $0 --new-key-file $NEW_FILE --apply"
  exit 0
fi

log "pre-rotate backup"
as_oasis_aws "${BACKUP_CMD:-$OASIS_HERE/backup.sh}" --label pre-rotate || die "backup failed; nothing was changed"
log "stopping the API and the worker"
run_system "$SYSTEMCTL" stop oasis-api.service oasis-worker.service
restart_all() { restart_services || true; }
if ! rotate --apply; then
  restart_all
  die "re-encryption failed and was rolled back; the old key is still in force and the services were restarted"
fi
if [[ -n "$SID" ]]; then
  if ! push_key --apply; then
    restart_all
    die "the database is on the NEW key ($NEW_FILE) but the secret $SID still holds the old one: stored tablet and Squarespace credentials cannot be read until you store it: printf 'SECRETS_KEY=%s\\n' \"\$(cat $NEW_FILE)\" > /root/k.env && pnpm secrets:push --profile $PROFILE --secret-id $SID --from /root/k.env --apply && shred -u /root/k.env && systemctl restart oasis-api oasis-worker"
  fi
  changed "SECRETS_KEY in the secret $SID replaced (Secrets Manager keeps the previous version as AWSPREVIOUS)"
else
  env_file_set "$COMMON" SECRETS_KEY "$(<"$NEW_FILE")"
  changed "SECRETS_KEY in $COMMON replaced (previous file: $COMMON.bak-*; it holds the OLD key, delete it once all is well)"
fi
restart_all
if [[ -n "$SID" ]]; then
  leftovers="$NEW_FILE"
  old_copy="the AWSPREVIOUS version of the secret $SID"
else
  leftovers="$NEW_FILE and the common.env.bak-* files"
  old_copy="common.env.bak-*"
fi
if health_gate 90; then
  ok "healthy on the new key. Next: pnpm verify:smsgate and a test send, then delete $leftovers after storing the key."
else
  die "the stack is not healthy after the rotation: journalctl -u oasis-api -u oasis-worker --since '5 min ago'. To undo: put the old key back ($old_copy) AND restore the pre-rotate backup."
fi
