#!/usr/bin/env bash
# scripts/e2e-square/run.sh [--port 4710] [--schema e2e_square] [--dir DIR] [--keep] [--steps "setup s1 ... cleanup"]
#
# The Square SANDBOX end to end (plan "Verification"; ADR 0171) on a disposable stack: a fresh schema and pg-boss schema in the
# test database (.env DATABASE_URL_TEST, or E2E_DATABASE_URL), migrated and seeded (base, pricing-defaults, messaging), one API and
# one worker of this checkout (stack.ts: Square live against the SANDBOX, writes, memberships, PAYMENT_PROCESSOR=square, personal
# links on with a pepper of the run, SMS and email simulated), the steps of driver.ts, then the stack stopped and both schemas
# dropped (--keep leaves them). Needs network to Square and AWS credentials that can read the secret oasis/sandbox/square
# (e.g. AWS_PROFILE=... AWS_REGION=us-east-1). Never against a production database. Prints the scenario lines at the end.
set -euo pipefail
cd "$(dirname "$0")/../.."
PORT=4710
SCHEMA=e2e_square
DIR=""
KEEP=0
STEPS="setup s1 s2 s3 s4 s5 s6 s7 cleanup"
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --schema) SCHEMA="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --steps) STEPS="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[[ "$SCHEMA" =~ ^[a-z][a-z0-9_]{0,40}$ ]] || { echo "bad schema name" >&2; exit 2; }
DIR="${DIR:-$(mktemp -d)}"
mkdir -p "$DIR/run" && chmod 700 "$DIR" "$DIR/run"
DB_URL="${E2E_DATABASE_URL:-}"
if [ -z "$DB_URL" ] && [ -f .env ]; then DB_URL="$(grep -E '^DATABASE_URL_TEST=' .env | head -1 | cut -d= -f2-)"; fi
[ -n "$DB_URL" ] || { echo "no database: set E2E_DATABASE_URL or DATABASE_URL_TEST in .env" >&2; exit 2; }
case "$DB_URL" in *rds.amazonaws.com*) echo "refusing a cloud database" >&2; exit 2 ;; esac
if ss -ltn | awk '{print $4}' | grep -qE "[:.]${PORT}\$"; then echo "port $PORT is in use" >&2; exit 2; fi
TSX=node_modules/.bin/tsx

psql "$DB_URL" -qX -v ON_ERROR_STOP=1 -c "drop schema if exists ${SCHEMA} cascade; drop schema if exists pgboss_${SCHEMA} cascade" >/dev/null
DATABASE_URL="$DB_URL" "$TSX" scripts/migrate.ts up --schema "$SCHEMA" | tail -1
DATABASE_URL="$DB_URL" DB_SEARCH_PATH="${SCHEMA},public" "$TSX" db/seeds/index.ts --profile base,pricing-defaults,messaging | tail -1

ENVF="$DIR/stack.env"
( umask 077; cat >"$ENVF" <<EOF
DATABASE_URL=$DB_URL
DB_SEARCH_PATH=${SCHEMA},public
PGBOSS_SCHEMA=pgboss_${SCHEMA}
PORT=$PORT
HOST=127.0.0.1
JOBS_ENABLED=true
SMS_DISPATCH_MODE=jobs
COOKIE_SECURE=false
PUBLIC_API_URL=http://127.0.0.1:$PORT
PUBLIC_DASHBOARD_URL=http://127.0.0.1:$PORT
PUBLIC_SITE_URL=http://127.0.0.1:$((PORT + 1))
ALLOWED_ORIGINS=http://127.0.0.1:$((PORT + 1))
PUBLIC_LINKS_ENABLED=true
SQUARE_LOCATION_ID=${SQUARE_SANDBOX_LOCATION_ID:-LCEVRH6NQ775N}
SQUARE_WRITES_ENABLED=true
PAYMENT_PROCESSOR=square
SQUARE_MEMBERSHIPS_ENABLED=true
SQUARE_MATCH_DELAY_SECONDS=10
SMS_PROVIDER=sim
EMAIL_PROVIDER=sim
STORAGE_FS_ROOT=$DIR/files
LOG_LEVEL=info
BOOTSTRAP_ADMIN_EMAIL=e2e-admin@oasis.test
EOF
)

"$TSX" scripts/e2e-square/stack.ts --env "$ENVF" --dir "$DIR/run" >"$DIR/launcher.log" 2>&1 &
TSX_PID=$!
LAUNCHER=""
stop_stack() {
  if [ -n "$LAUNCHER" ]; then kill -TERM "$LAUNCHER" 2>/dev/null || true; fi
  wait "$TSX_PID" 2>/dev/null || true
  cat "$DIR/launcher.log"
  if [ "$KEEP" = 0 ]; then
    psql "$DB_URL" -qX -c "drop schema if exists ${SCHEMA} cascade; drop schema if exists pgboss_${SCHEMA} cascade" >/dev/null 2>&1 || true
    echo "schemas ${SCHEMA} and pgboss_${SCHEMA} dropped"
  fi
}
trap stop_stack EXIT
for _ in $(seq 1 90); do
  [ -f "$DIR/run/stack.json" ] && LAUNCHER="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['launcher'])" "$DIR/run/stack.json")"
  if curl -fs "http://127.0.0.1:$PORT/readyz" >/dev/null 2>&1; then break; fi
  kill -0 "$TSX_PID" 2>/dev/null || { echo "the stack did not start" >&2; exit 1; }
  sleep 2
done
curl -fs "http://127.0.0.1:$PORT/readyz" >/dev/null || { echo "the API is not ready" >&2; exit 1; }
STATUS=0
for s in $STEPS; do
  echo "== $s"
  "$TSX" scripts/e2e-square/driver.ts --env "$ENVF" --dir "$DIR/run" "$s" || STATUS=1
done
echo "== results"
cat "$DIR/run/results.txt" 2>/dev/null || true
grep -q ' FAIL: ' "$DIR/run/results.txt" 2>/dev/null && STATUS=1
exit $STATUS
