#!/usr/bin/env bash
# restore-drill.sh [--latest | --file DUMP] [--dir DIR] [--mode database|schema] [--schema NAME] [--keep] [--quiet]
#
# Proves a backup can be restored, without touching the live database: restores into a scratch database (or, for sandboxes, a scratch
# schema) and checks it.
#   1. the file matches its .sha256, and pg_restore can read it (encrypted .enc files are decrypted first)
#   2. pg_restore --exit-on-error loads everything: tables, constraints, foreign keys, the ledger guard trigger
#   3. every table has exactly the row count in the backup's manifest (counted in the same snapshot as the dump)
#   4. the number of applied migrations matches the manifest
#   5. ledger invariants, recomputed from the raw ledger_events and compared with the invoice_calc view:
#        - for every invoice paid = pay - void + credit_apply and refunded = refunds done
#        - balance is never negative and equals max(0, total - paid) (0 for a canceled invoice)
#        - ledger_events.seq is unique, no event points at a missing invoice, and the append-only guard trigger exists
# Exit 0 = all passed, 1 = something failed (the scratch copy is dropped unless --keep).
#
# database mode (default, production): RESTORE_ADMIN_URL is a role that may create databases, e.g.
#   postgres://oasis_drill:...@127.0.0.1:5432/postgres   (install.sh --drill-role creates it and writes /etc/oasis/drill.env)
# schema mode (--mode schema --schema NAME): for hosts where no database may be created. The dump must be of the single schema NAME
# and NAME must not exist; it is created, checked and dropped again. Connects with RESTORE_URL or DATABASE_URL.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
. "$here/../lib/common.sh"
# shellcheck source=../lib/ledger-checks.sh
. "$here/../lib/ledger-checks.sh"

FILE=""
LATEST=0
MODE=database
SCHEMA=""
KEEP=0
QUIET=0
DIR="$OASIS_BACKUP_DIR/daily"

while (($#)); do
  case "$1" in
    --file) FILE=$2; shift 2 ;;
    --latest) LATEST=1; shift ;;
    --dir) DIR=$2; shift 2 ;;
    --mode) MODE=$2; shift 2 ;;
    --schema) SCHEMA=$2; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --quiet) QUIET=1; shift ;;
    -h | --help)
      sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown option $1" ;;
  esac
done
[[ "$MODE" == database || "$MODE" == schema ]] || die "--mode must be database or schema"
if [[ "$MODE" == schema ]]; then
  [[ "$SCHEMA" =~ ^[a-z_][a-z0-9_]*$ ]] || die "--mode schema needs --schema NAME"
fi
have pg_restore && have psql || die "postgresql15 client tools are required"
have node || die "node is required"

if [[ -z "$FILE" ]]; then
  ((LATEST)) || die "give --latest or --file DUMP"
  FILE=$(find "$DIR" -maxdepth 1 -type f \( -name 'oasis-*.dump' -o -name 'oasis-*.dump.enc' \) | sort | tail -n 1)
  [[ -n "$FILE" ]] || die "no backup found in $DIR"
fi
[[ -f "$FILE" ]] || die "$FILE not found"

WORK=$(mktemp -d)
FAILS=()
NOTES=()
SCRATCH=""
ADMIN_ENV=()
cleaned=0
cleanup() {
  ((cleaned)) && return 0
  cleaned=1
  if ((KEEP == 0)) && [[ -n "$SCRATCH" ]]; then
    if [[ "$MODE" == database ]]; then
      env "${ADMIN_ENV[@]}" PGDATABASE=postgres psql -X -q -c "drop database if exists \"$SCRATCH\" with (force)" >/dev/null 2>&1 || warn "could not drop the scratch database $SCRATCH"
    else
      psql -X -q -c "drop schema if exists \"$SCRATCH\" cascade" >/dev/null 2>&1 || warn "could not drop the scratch schema $SCRATCH"
    fi
  elif [[ -n "$SCRATCH" ]]; then
    log "kept the scratch copy: $SCRATCH"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { FAILS+=("$1"); printf '%sFAIL%s %s\n' "$C_RED" "$C_OFF" "$1"; }
pass() { ((QUIET)) || printf '%sPASS%s %s\n' "$C_GREEN" "$C_OFF" "$1"; }
finish() {
  local verdict=ok code=0
  if ((${#FAILS[@]})); then verdict=failed; code=1; fi
  local report="$OASIS_STATE/drills"
  if mkdir -p "$report" 2>/dev/null; then
    {
      printf '{"at":"%s","file":"%s","mode":"%s","result":"%s","failures":[' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$FILE")" "$MODE" "$verdict"
      local i=0 f
      for f in "${FAILS[@]}"; do
        ((i++)) && printf ','
        printf '"%s"' "${f//\"/\'}"
      done
      printf ']}\n'
    } >"$report/$(date -u +%Y%m%dT%H%M%SZ).json" 2>/dev/null || true
    ((code == 0)) && : >"$report/last-ok" 2>/dev/null || true
  fi
  if ((code == 0)); then
    log "restore drill passed for $(basename "$FILE")"
  else
    log "restore drill FAILED for $(basename "$FILE"): ${#FAILS[@]} problem(s)"
  fi
  exit "$code"
}

# --- 1. file integrity -------------------------------------------------------------------------------------------------------
SRC=$FILE
MANIFEST=""
BASE=$(basename "$FILE")
if [[ "$FILE" == *.enc ]]; then
  [[ -n "${BACKUP_ENCRYPTION_KEY_FILE:-}" ]] || die "$BASE is encrypted: set BACKUP_ENCRYPTION_KEY_FILE"
  node "$here/../lib/backup-crypt.mjs" decrypt "$FILE" "$WORK/plain.dump" || {
    fail "$BASE could not be decrypted (wrong key, or the file was altered)"
    finish
  }
  SRC="$WORK/plain.dump"
  BASE=${BASE%.enc}
fi
for candidate in "$(dirname "$FILE")/${BASE}.manifest.json" "$(dirname "$FILE")/${BASE%.enc}.manifest.json"; do
  [[ -f "$candidate" ]] && MANIFEST=$candidate && break
done
if [[ -f "$(dirname "$FILE")/${BASE}.sha256" ]]; then
  want=$(cut -d' ' -f1 "$(dirname "$FILE")/${BASE}.sha256")
  if [[ "$(sha256_of "$SRC")" == "$want" ]]; then pass "checksum matches ${BASE}.sha256"; else fail "checksum of $BASE does not match ${BASE}.sha256 (the file changed after it was written)"; fi
else
  warn "no ${BASE}.sha256 next to the file; checksum not verified"
fi
if pg_restore --list "$SRC" >/dev/null 2>"$WORK/list.err"; then pass "pg_restore can read the archive"; else
  fail "pg_restore cannot read the archive: $(head -c 200 "$WORK/list.err")"
fi
((${#FAILS[@]})) && finish

# --- 2. restore into a scratch copy ---------------------------------------------------------------------------------------------
STAMP=$(date -u +%Y%m%d%H%M%S)
if [[ "$MODE" == database ]]; then
  [[ -n "${RESTORE_ADMIN_URL:-}" ]] || die "RESTORE_ADMIN_URL is not set (a role with CREATEDB; see install.sh --drill-role), or use --mode schema"
  url_to_pgenv "$RESTORE_ADMIN_URL"
  ADMIN_ENV=("PGHOST=$PGHOST" "PGPORT=$PGPORT" "PGUSER=$PGUSER" "PGPASSWORD=$PGPASSWORD")
  SCRATCH="oasis_drill_${STAMP}"
  PGDATABASE=postgres psql -X -q -c "create database \"$SCRATCH\"" || die "cannot create the scratch database (does the role have CREATEDB?)"
  export PGDATABASE=$SCRATCH
  RESTORE_SCHEMAS=all
else
  url_to_pgenv "${RESTORE_URL:-$(config_value DATABASE_URL)}"
  exists=$(psql -X -q -A -t -c "select 1 from pg_namespace where nspname = '$SCHEMA'")
  [[ -z "$exists" ]] || die "schema $SCHEMA already exists in $PGDATABASE; a drill never restores over an existing schema"
  SCRATCH=$SCHEMA
  export PGOPTIONS="-c search_path=${SCHEMA},public"
  RESTORE_SCHEMAS=$SCHEMA
fi
export PGAPPNAME=oasis-restore-drill

log "restoring $BASE into scratch ${MODE} $SCRATCH"
if pg_restore --no-owner --no-privileges --exit-on-error --dbname="$PGDATABASE" "$SRC" 2>"$WORK/restore.err"; then
  pass "pg_restore loaded the whole archive (tables, constraints, foreign keys, triggers)"
else
  fail "pg_restore failed: $(head -c 400 "$WORK/restore.err" | tr '\n' ' ')"
  finish
fi

scalar() { psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"; }

# --- 3. row counts against the manifest ---------------------------------------------------------------------------------------
COUNT_SQL="WITH t AS (
  SELECT table_schema AS s, table_name AS n,
         (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint AS c
  FROM information_schema.tables
  WHERE table_type = 'BASE TABLE'
    AND (('$RESTORE_SCHEMAS' = 'all' AND table_schema NOT IN ('pg_catalog', 'information_schema')) OR table_schema = ANY (string_to_array('$RESTORE_SCHEMAS', ',')))
)
SELECT coalesce(json_object_agg(s || '.' || n, c ORDER BY s, n), '{}'::json)::text FROM t"
scalar "$COUNT_SQL" >"$WORK/restored-counts.json"
if [[ -z "$MANIFEST" ]]; then
  warn "no manifest next to the backup; row counts and the migration count were not compared"
  NOTES+=("no manifest")
else
  verdict=$(node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
    const r = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"))
    const bad = []
    for (const [t, n] of Object.entries(m.counts)) {
      if (!(t in r)) bad.push(`${t}: missing after restore (backup had ${n})`)
      else if (r[t] !== n) bad.push(`${t}: backup had ${n} rows, restored ${r[t]}`)
    }
    for (const t of Object.keys(r)) if (!(t in m.counts)) bad.push(`${t}: not in the backup manifest`)
    const total = Object.values(r).reduce((a, b) => a + b, 0)
    console.log(bad.length ? "BAD " + bad.slice(0, 12).join("; ") : `OK ${Object.keys(r).length} tables, ${total} rows`)
  ' "$MANIFEST" "$WORK/restored-counts.json")
  if [[ "$verdict" == OK* ]]; then pass "row counts equal the manifest (${verdict#OK })"; else fail "row counts differ from the manifest: ${verdict#BAD }"; fi

  want_migrations=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(m.migrations===null?"":m.migrations)' "$MANIFEST")
  if [[ -n "$want_migrations" ]]; then
    have_migrations=$(scalar "select count(*) from schema_migrations")
    if [[ "$have_migrations" == "$want_migrations" ]]; then pass "$have_migrations migrations applied, as in the manifest"; else fail "schema_migrations has $have_migrations rows, the manifest says $want_migrations"; fi
  fi
fi
files=$({ find "$OASIS_PREFIX/current/backend/db/migrations" -maxdepth 1 -name '*.sql' 2>/dev/null || true; } | wc -l | tr -d ' ')
if [[ "$files" != 0 ]]; then
  have_migrations=${have_migrations:-$(scalar "select count(*) from schema_migrations" 2>/dev/null || echo "?")}
  [[ "$have_migrations" == "$files" ]] || warn "the backup has $have_migrations migrations, the current release has $files; deploy.sh will apply the rest"
fi

# --- 4. ledger invariants ------------------------------------------------------------------------------------------------------
ledger_invariants

finish
