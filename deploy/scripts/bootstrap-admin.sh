#!/usr/bin/env bash
# bootstrap-admin.sh set EMAIL [--profile NAME] | clear [--profile NAME] | status
#
# The first Super Admin. src/server.ts reads BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD at boot and, only while the database
# has no user at all, creates that person with the built-in roles. On any later boot it does nothing.
#   set EMAIL   generates a password, stores both variables and prints the password ONCE. Then start (or restart) oasis-api and sign
#               in at https://<domain>/login; change the password under your profile.
#   clear       removes both (do this once you are signed in; the password should not stay stored)
#   status      shows whether the variables are set (never the password) and whether any user exists
# Where they are stored: with OASIS_SECRET_ID in common.env (the default), in that AWS Secrets Manager secret, written with
# pnpm secrets:push as the operator: --profile NAME is a profile of root's ~/.aws (or keep AWS_SHARED_CREDENTIALS_FILE and
# AWS_CONFIG_FILE through sudo). On a host without the secret: in $OASIS_ETC/api.env.
# Lost the Super Admin login later? See docs/runbook.md, "Locked-out Super Admin" (reset-password.sh).
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
. "$here/../lib/common.sh"

cmd=${1:-}
[[ $# -eq 0 ]] || shift
email=""
if [[ "$cmd" == set ]]; then
  email=${1:-}
  [[ $# -eq 0 ]] || shift
fi
PROFILE=""
while (($#)); do
  case "$1" in
    --profile) PROFILE=${2:-}; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done
API_ENV="$OASIS_ETC/api.env"
SID=$(secret_id)

# push_admin_secret ARGS...: secrets:push for the two keys, as the operator
push_admin_secret() {
  [[ -n "$PROFILE" ]] || die "this host reads its secrets from $SID: give --profile <operator profile> so the change goes into the secret (docs/runbook.md)"
  secrets_push --profile "$PROFILE" --secret-id "$SID" --region "$(aws_region)" "$@" --apply
}

case "$cmd" in
  set)
    [[ "$email" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "usage: bootstrap-admin.sh set you@example.com [--profile NAME]"
    need_root
    password=$("$here/gen-secrets.sh" BOOTSTRAP_ADMIN_PASSWORD | cut -d= -f2-)
    if [[ -n "$SID" ]]; then
      tmp=$(mktemp -d)
      chmod 700 "$tmp"
      trap 'rm -rf "$tmp"' EXIT
      printf 'BOOTSTRAP_ADMIN_EMAIL=%s\nBOOTSTRAP_ADMIN_PASSWORD=%s\n' "$email" "$password" >"$tmp/admin.env"
      push_admin_secret --from "$tmp/admin.env" >/dev/null || die "the secret $SID was not changed (see the message above; nothing was stored)"
      ok "stored BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD in the secret $SID"
    else
      env_file_set "$API_ENV" BOOTSTRAP_ADMIN_EMAIL "$email"
      env_file_set "$API_ENV" BOOTSTRAP_ADMIN_PASSWORD "$password"
      ok "wrote BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD to $API_ENV"
    fi
    echo
    echo "  Email:     $email"
    echo "  Password:  $password      (shown once; change it after the first sign-in)"
    echo
    echo "Now: systemctl restart oasis-api   (the account is created at boot when the database has no users)"
    echo "Then sign in, and run: $0 clear${SID:+ --profile ${PROFILE}}"
    ;;
  clear)
    need_root
    if [[ -n "$SID" ]]; then
      push_admin_secret --remove BOOTSTRAP_ADMIN_EMAIL --remove BOOTSTRAP_ADMIN_PASSWORD >/dev/null || die "the secret $SID was not changed (see the message above)"
      ok "bootstrap credentials removed from the secret $SID; restart oasis-api so the process forgets them"
    else
      env_file_unset "$API_ENV" BOOTSTRAP_ADMIN_EMAIL
      env_file_unset "$API_ENV" BOOTSTRAP_ADMIN_PASSWORD
      ok "bootstrap credentials removed from $API_ENV; restart oasis-api so the process forgets them"
    fi
    ;;
  status)
    if [[ -n "$SID" ]]; then
      keys=$(secret_env --keys) || die "cannot read the secret $SID"
      e=$(grep -qx BOOTSTRAP_ADMIN_EMAIL <<<"$keys" && echo "(set in the secret)" || echo "(not in the secret)")
      p=$(grep -qx BOOTSTRAP_ADMIN_PASSWORD <<<"$keys" && echo "(set in the secret)" || echo "(not in the secret)")
      echo "BOOTSTRAP_ADMIN_EMAIL:    $e"
      echo "BOOTSTRAP_ADMIN_PASSWORD: $p"
    else
      e=$(env_get "$API_ENV" BOOTSTRAP_ADMIN_EMAIL || true)
      p=$(env_get "$API_ENV" BOOTSTRAP_ADMIN_PASSWORD || true)
      echo "BOOTSTRAP_ADMIN_EMAIL:    ${e:-(empty)}"
      echo "BOOTSTRAP_ADMIN_PASSWORD: $([[ -n "$p" ]] && echo '(set)' || echo '(empty)')"
    fi
    if have psql && url=$(config_value DATABASE_URL 2>/dev/null); then
      url_to_pgenv "$url"
      echo "users in the database:    $(psql -X -q -A -t -c 'select count(*) from users' 2>&1 | head -1)"
    fi
    ;;
  *)
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
