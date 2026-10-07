#!/usr/bin/env bash
# backup.sh [--label nightly|pre-deploy|manual|NAME] [--schemas all|a,b] [--no-upload] [--dry-run]
#
# One consistent pg_dump (custom format) of the Oasis database, with a manifest, a checksum and the retention below.
#   $OASIS_BACKUP_DIR/daily/    oasis-<UTC time>-<label>.dump  (+ .manifest.json, .sha256)    newest 7 kept
#   $OASIS_BACKUP_DIR/weekly/   a hard link of the Sunday backup                                newest 4 kept
#   $OASIS_BACKUP_DIR/monthly/  a hard link of the backup taken on the 1st of the month         newest 12 kept
# Optional off-host copy: BACKUP_S3_URI=s3://bucket/prefix (uploaded with the aws CLI, server-side encrypted), and when
# BACKUP_ENCRYPTION_KEY_FILE is set the file is encrypted with AES-256-GCM first (deploy/lib/backup-crypt.mjs) so the bucket never
# holds a readable dump. Create a key with: node deploy/lib/backup-crypt.mjs keygen /etc/oasis/backup.key (and keep a copy elsewhere).
#
# The dump and the row counts in the manifest come from ONE exported snapshot, so the restore drill can compare them exactly.
# Reads DATABASE_URL from the environment or from $OASIS_ETC/common.env. The password never appears on a command line.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
. "$here/../lib/common.sh"

LABEL=manual
SCHEMAS="${BACKUP_SCHEMAS:-all}"
UPLOAD=1
KEEP_DAILY="${BACKUP_KEEP_DAILY:-7}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-4}"
KEEP_MONTHLY="${BACKUP_KEEP_MONTHLY:-12}"

while (($#)); do
  case "$1" in
    --label) LABEL=$2; shift 2 ;;
    --schemas) SCHEMAS=$2; shift 2 ;;
    --no-upload) UPLOAD=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown option $1" ;;
  esac
done
[[ "$LABEL" =~ ^[a-z0-9-]{1,24}$ ]] || die "--label must be lowercase letters, digits and dashes"
[[ "$SCHEMAS" =~ ^(all|[a-z_][a-z0-9_]*(,[a-z_][a-z0-9_]*)*)$ ]] || die "--schemas must be 'all' or a comma list of schema names"

have pg_dump && have psql && have pg_restore || die "pg_dump, psql and pg_restore (postgresql15 client) are required"
if [[ -z "${DATABASE_URL:-}" ]]; then
  DATABASE_URL=$(env_get "$OASIS_ETC/common.env" DATABASE_URL) || die "DATABASE_URL is not set and $OASIS_ETC/common.env has none"
fi
url_to_pgenv "$DATABASE_URL"
export PGAPPNAME=oasis-backup

# BACKUP_NOW (an ISO time) exists so tests can place a backup on a Sunday or the 1st; in production it is unset
now_fmt() { date -u ${BACKUP_NOW:+-d "$BACKUP_NOW"} "+$1"; }
STAMP=$(now_fmt %Y%m%dT%H%M%SZ)
NAME="oasis-${STAMP}-${LABEL}.dump"
DAILY="$OASIS_BACKUP_DIR/daily"
WEEKLY="$OASIS_BACKUP_DIR/weekly"
MONTHLY="$OASIS_BACKUP_DIR/monthly"

if [[ "$DRY_RUN" == 1 ]]; then
  log "would dump database $PGDATABASE on $PGHOST:$PGPORT (schemas: $SCHEMAS) to $DAILY/$NAME"
  log "would keep $KEEP_DAILY daily, $KEEP_WEEKLY weekly, $KEEP_MONTHLY monthly${BACKUP_S3_URI:+; would upload to $BACKUP_S3_URI}"
  exit 0
fi

mkdir -p "$DAILY" "$WEEKLY" "$MONTHLY"
chmod 700 "$OASIS_BACKUP_DIR" "$DAILY" "$WEEKLY" "$MONTHLY"
WORK=$(mktemp -d "$OASIS_BACKUP_DIR/.work.XXXXXX")
PSQL_PID=""
cleanup() {
  : >"$WORK/done" 2>/dev/null || true
  if [[ -n "$PSQL_PID" ]] && kill -0 "$PSQL_PID" 2>/dev/null; then
    sleep 1
    kill "$PSQL_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# A session that holds an exported snapshot open until the dump is finished, then counts the rows in that same snapshot.
cat >"$WORK/snapshot.sql" <<SQL
\\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
\\o $WORK/snapshot.id
SELECT pg_export_snapshot();
\\o
\\! i=0; while [ ! -e '$WORK/done' ] && [ \$i -lt 36000 ]; do sleep 0.2; i=\$((i+1)); done
\\o $WORK/counts.json
WITH t AS (
  SELECT table_schema AS s, table_name AS n,
         (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint AS c
  FROM information_schema.tables
  WHERE table_type = 'BASE TABLE'
    AND ((:'schemas' = 'all' AND table_schema NOT IN ('pg_catalog', 'information_schema'))
         OR table_schema = ANY (string_to_array(:'schemas', ',')))
)
SELECT coalesce(json_object_agg(s || '.' || n, c ORDER BY s, n), '{}'::json)::text FROM t;
\\o
COMMIT;
SQL

psql -X -q -A -t -v schemas="$SCHEMAS" -f "$WORK/snapshot.sql" >"$WORK/psql.out" 2>&1 &
PSQL_PID=$!
for _ in $(seq 1 300); do
  [[ -s "$WORK/snapshot.id" ]] && break
  kill -0 "$PSQL_PID" 2>/dev/null || die "could not open the snapshot session: $(cat "$WORK/psql.out")"
  sleep 0.1
done
[[ -s "$WORK/snapshot.id" ]] || die "no snapshot id after 30 s"
SNAPSHOT=$(tr -d '[:space:]' <"$WORK/snapshot.id")

DUMP_ARGS=(--format=custom --compress=6 --snapshot="$SNAPSHOT" --file="$WORK/$NAME")
if [[ "$SCHEMAS" != all ]]; then
  IFS=',' read -ra schema_list <<<"$SCHEMAS"
  for s in "${schema_list[@]}"; do DUMP_ARGS+=(--schema="$s"); done
fi
log "dumping $PGDATABASE (schemas: $SCHEMAS, snapshot $SNAPSHOT)"
pg_dump "${DUMP_ARGS[@]}"
: >"$WORK/done"
wait "$PSQL_PID" || die "snapshot session failed: $(cat "$WORK/psql.out")"
PSQL_PID=""
[[ -s "$WORK/counts.json" ]] || die "row counts were not produced"

pg_restore --list "$WORK/$NAME" >/dev/null || die "the dump is not a readable archive"
SIZE=$(stat -c %s "$WORK/$NAME")
SUM=$(sha256_of "$WORK/$NAME")
if [[ "$SCHEMAS" != all ]]; then export PGOPTIONS="-c search_path=${SCHEMAS%%,*},public"; fi
MIGRATIONS=$(psql -X -q -A -t -c "select count(*) from schema_migrations" 2>/dev/null || echo null)
[[ "$MIGRATIONS" =~ ^[0-9]+$ ]] || MIGRATIONS=null
RELEASE=$(basename "$(readlink -f "$OASIS_PREFIX/current" 2>/dev/null || echo unknown)")
SERVER_VERSION=$(psql -X -q -A -t -c "show server_version" 2>/dev/null || echo unknown)

printf '%s  %s\n' "$SUM" "$NAME" >"$WORK/$NAME.sha256"
cat >"$WORK/$NAME.manifest.json" <<JSON
{
  "file": "$NAME",
  "createdAt": "$(now_fmt %Y-%m-%dT%H:%M:%SZ)",
  "label": "$LABEL",
  "database": "$PGDATABASE",
  "host": "$(uname -n | cut -d. -f1)",
  "schemas": "$SCHEMAS",
  "snapshot": "$SNAPSHOT",
  "bytes": $SIZE,
  "sha256": "$SUM",
  "serverVersion": "$SERVER_VERSION",
  "pgDump": "$(pg_dump --version | tr -d '\n')",
  "release": "$RELEASE",
  "migrations": $MIGRATIONS,
  "counts": $(cat "$WORK/counts.json")
}
JSON

mv -f "$WORK/$NAME" "$WORK/$NAME.sha256" "$WORK/$NAME.manifest.json" "$DAILY/"
log "wrote $DAILY/$NAME ($SIZE bytes)"

if [[ "$LABEL" == nightly ]]; then
  if [[ "$(now_fmt %u)" == 7 ]]; then
    ln -f "$DAILY/$NAME" "$WEEKLY/$NAME"
    ln -f "$DAILY/$NAME.sha256" "$WEEKLY/$NAME.sha256"
    ln -f "$DAILY/$NAME.manifest.json" "$WEEKLY/$NAME.manifest.json"
  fi
  if [[ "$(now_fmt %d)" == 01 ]]; then
    ln -f "$DAILY/$NAME" "$MONTHLY/$NAME"
    ln -f "$DAILY/$NAME.sha256" "$MONTHLY/$NAME.sha256"
    ln -f "$DAILY/$NAME.manifest.json" "$MONTHLY/$NAME.manifest.json"
  fi
  keep_newest "$DAILY" 'oasis-*-nightly.dump' "$KEEP_DAILY"
  keep_newest "$WEEKLY" 'oasis-*-nightly.dump' "$KEEP_WEEKLY"
  keep_newest "$MONTHLY" 'oasis-*-nightly.dump' "$KEEP_MONTHLY"
else
  # pre-deploy and manual backups are kept apart so a busy deploy day cannot push the nightly ones out
  keep_newest "$DAILY" "oasis-*-${LABEL}.dump" "${BACKUP_KEEP_OTHER:-5}"
fi

if ((UPLOAD)) && [[ -n "${BACKUP_S3_URI:-}" ]]; then
  have aws || die "BACKUP_S3_URI is set but the aws CLI is not installed"
  UPLOAD_FILE="$DAILY/$NAME"
  if [[ -n "${BACKUP_ENCRYPTION_KEY_FILE:-}" ]]; then
    node "$here/../lib/backup-crypt.mjs" encrypt "$DAILY/$NAME" "$WORK/$NAME.enc"
    UPLOAD_FILE="$WORK/$NAME.enc"
    log "encrypted the copy for upload (AES-256-GCM, key file $BACKUP_ENCRYPTION_KEY_FILE)"
  else
    warn "BACKUP_ENCRYPTION_KEY_FILE is not set: the dump is uploaded readable (S3 server-side encryption only)"
  fi
  aws s3 cp --only-show-errors --sse "${BACKUP_S3_SSE:-AES256}" "$UPLOAD_FILE" "${BACKUP_S3_URI%/}/$(basename "$UPLOAD_FILE")"
  aws s3 cp --only-show-errors --sse "${BACKUP_S3_SSE:-AES256}" "$DAILY/$NAME.manifest.json" "${BACKUP_S3_URI%/}/$NAME.manifest.json"
  log "uploaded to ${BACKUP_S3_URI%/}/"
fi

ROWS=$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).counts;console.log(Object.values(c).reduce((a,b)=>a+b,0))' "$DAILY/$NAME.manifest.json" 2>/dev/null || echo "?")
log "backup ok: $NAME, $SIZE bytes, ${ROWS} rows, migrations $MIGRATIONS"
