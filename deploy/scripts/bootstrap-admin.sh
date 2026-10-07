#!/usr/bin/env bash
# bootstrap-admin.sh set EMAIL | clear | status
#
# The first Super Admin. src/server.ts reads BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD at boot and, only while the database
# has no user at all, creates that person with the built-in roles. On any later boot it does nothing.
#   set EMAIL   generates a password, writes both variables to $OASIS_ETC/api.env and prints the password ONCE. Then start (or restart)
#               oasis-api and sign in at https://<domain>/login; change the password under your profile.
#   clear       removes both lines (do this once you are signed in; the password should not stay on disk)
#   status      shows whether the variables are set and whether any user exists
# Lost the Super Admin login later? See docs/runbook.md, "Locked-out Super Admin" (reset-password.sh).
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
. "$here/../lib/common.sh"

cmd=${1:-}
API_ENV="$OASIS_ETC/api.env"
case "$cmd" in
  set)
    email=${2:-}
    [[ "$email" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "usage: bootstrap-admin.sh set you@example.com"
    need_root
    password=$("$here/gen-secrets.sh" BOOTSTRAP_ADMIN_PASSWORD | cut -d= -f2-)
    env_file_set "$API_ENV" BOOTSTRAP_ADMIN_EMAIL "$email"
    env_file_set "$API_ENV" BOOTSTRAP_ADMIN_PASSWORD "$password"
    ok "wrote BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD to $API_ENV"
    echo
    echo "  Email:     $email"
    echo "  Password:  $password      (shown once; change it after the first sign-in)"
    echo
    echo "Now: systemctl restart oasis-api   (the account is created at boot when the database has no users)"
    echo "Then sign in, and run: $0 clear"
    ;;
  clear)
    need_root
    env_file_unset "$API_ENV" BOOTSTRAP_ADMIN_EMAIL
    env_file_unset "$API_ENV" BOOTSTRAP_ADMIN_PASSWORD
    ok "bootstrap credentials removed from $API_ENV; restart oasis-api so the process forgets them"
    ;;
  status)
    e=$(env_get "$API_ENV" BOOTSTRAP_ADMIN_EMAIL || true)
    p=$(env_get "$API_ENV" BOOTSTRAP_ADMIN_PASSWORD || true)
    echo "BOOTSTRAP_ADMIN_EMAIL:    ${e:-(empty)}"
    echo "BOOTSTRAP_ADMIN_PASSWORD: $([[ -n "$p" ]] && echo '(set)' || echo '(empty)')"
    if have psql && url=$(env_get "$OASIS_ETC/common.env" DATABASE_URL 2>/dev/null); then
      url_to_pgenv "$url"
      echo "users in the database:    $(psql -X -q -A -t -c 'select count(*) from users' 2>&1 | head -1)"
    fi
    ;;
  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
