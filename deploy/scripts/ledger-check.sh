#!/usr/bin/env bash
# ledger-check.sh [--schema NAME]
#
# The restore drill's ledger checks, run read-only against the LIVE database (DATABASE_URL from the environment, common.env or the
# secret it names):
#   - for every invoice, paid and refunded recomputed from ledger_events equal what invoice_calc reports
#   - no negative balance; balance = max(0, total - paid), and 0 for a canceled invoice
#   - ledger_events.seq is unique, every event has an invoice, and the append-only guard trigger exists
# Exit 0 = all hold, 1 = at least one does not. Safe to run any time (the session is read-only). docs/runbook.md, "Ledger mismatch".
# --schema NAME looks at that schema instead of public (tests, sandboxes).
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
. "$here/../lib/common.sh"
# shellcheck source=../lib/ledger-checks.sh
. "$here/../lib/ledger-checks.sh"

SCHEMA=""
while (($#)); do
  case "$1" in
    --schema) SCHEMA=$2; shift 2 ;;
    -h | --help)
      sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown option $1" ;;
  esac
done
use_pg_client
have psql || die "psql is required"
DATABASE_URL=$(config_value DATABASE_URL) || die "DATABASE_URL is set neither in the environment, nor in $OASIS_ETC/common.env, nor in the secret it names"
url_to_pgenv "$DATABASE_URL"
export PGAPPNAME=oasis-ledger-check
export PGOPTIONS="-c default_transaction_read_only=on${SCHEMA:+ -c search_path=$SCHEMA,public}"

FAILS=0
scalar() { psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"; }
pass() { printf '%sPASS%s %s\n' "$C_GREEN" "$C_OFF" "$1"; }
fail() {
  FAILS=$((FAILS + 1))
  printf '%sFAIL%s %s\n' "$C_RED" "$C_OFF" "$1"
}

ledger_invariants
if ((FAILS)); then
  log "$FAILS check(s) failed. Do not edit ledger_events (it is append-only); see docs/runbook.md, Ledger mismatch."
  exit 1
fi
log "the ledger is consistent"
