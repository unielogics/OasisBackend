#!/usr/bin/env bash
# deploy.sh [--backend-ref REF] [--dashboard-ref REF] [--skip-backup] [--force] [--keep N] [--wait SECONDS] [--dry-run]
#
# Fetch, build, migrate, switch, restart, health-check, and roll back by itself when the new release is not healthy.
#   1. git fetch both repositories (src/backend, src/dashboard) and resolve the refs (default origin/main)
#   2. nothing to do when the current release already has those two commits (--force builds anyway)
#   3. export both trees into releases/<id>, pnpm install --frozen-lockfile, pnpm build (API) and pnpm build:live (dashboard)
#   4. backup.sh --label pre-deploy                    (the safety net for the migration; skipped with --skip-backup)
#   5. pnpm migrate up with the new code, while the old release is still serving
#   6. current -> the new release; restart worker, API, dashboard
#   7. healthcheck.sh --wait: API ready (database, migrations, jobs) and dashboard answering
#   8. unhealthy: current -> the previous release, restart, health-check again, exit 1
# A build or migration failure changes nothing that is running. Migrations are forward-only and the old code keeps running against
# the migrated schema after a rollback, so every migration must stay compatible with the release before it (docs/runbook.md).
# Run as root (sudo); builds and migrations drop to the oasis user. One deploy at a time (flock).
set -euo pipefail
OASIS_HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
. "$OASIS_HERE/../lib/common.sh"
# shellcheck source=../lib/release.sh
. "$OASIS_HERE/../lib/release.sh"

BE_REF="${BACKEND_REF:-origin/main}"
DB_REF="${DASHBOARD_REF:-origin/main}"
SKIP_BACKUP=0
FORCE=0
KEEP=4
WAIT=90

while (($#)); do
  case "$1" in
    --backend-ref) BE_REF=$2; shift 2 ;;
    --dashboard-ref) DB_REF=$2; shift 2 ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    --force) FORCE=1; shift ;;
    --keep) KEEP=$2; shift 2 ;;
    --wait) WAIT=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help)
      sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown option $1" ;;
  esac
done

need_root
mkdir -p "$OASIS_PREFIX" "$OASIS_PREFIX/releases" "$OASIS_LOG_DIR" 2>/dev/null || true
exec 9>"$OASIS_PREFIX/.deploy.lock"
flock -n 9 || die "another deploy or rollback is running"
if [[ "$DRY_RUN" != 1 ]]; then exec > >(tee -a "$OASIS_LOG_DIR/deploy.log") 2>&1; fi

for repo in backend dashboard; do
  [[ -d "$OASIS_PREFIX/src/$repo/.git" || -f "$OASIS_PREFIX/src/$repo/HEAD" ]] || die "$OASIS_PREFIX/src/$repo is not a git clone (run install.sh, then clone the repository there)"
done
for f in common.env api.env worker.env web.env; do [[ -r "$OASIS_ETC/$f" ]] || die "$OASIS_ETC/$f is missing (run install.sh)"; done

OLD=$(current_release)
if [[ -n "$OLD" ]]; then log "current release: $(basename "$OLD")"; else log "current release: none (first deployment)"; fi

# --- 1. fetch -------------------------------------------------------------------------------------------------------------------
for repo in backend dashboard; do
  as_oasis git -C "$OASIS_PREFIX/src/$repo" fetch --prune --quiet origin
done
BE_SHA=$(oasis_read git -C "$OASIS_PREFIX/src/backend" rev-parse --verify "$BE_REF^{commit}") || die "backend ref $BE_REF does not exist"
DB_SHA=$(oasis_read git -C "$OASIS_PREFIX/src/dashboard" rev-parse --verify "$DB_REF^{commit}") || die "dashboard ref $DB_REF does not exist"
log "backend  $BE_REF = ${BE_SHA:0:12}"
log "dashboard $DB_REF = ${DB_SHA:0:12}"

# --- 2. anything to do? ---------------------------------------------------------------------------------------------------------
if [[ -n "$OLD" && -f "$OLD/REVISIONS" && "$FORCE" != 1 ]]; then
  if grep -qx "backend=$BE_SHA" "$OLD/REVISIONS" && grep -qx "dashboard=$DB_SHA" "$OLD/REVISIONS"; then
    ok "nothing to deploy: $(basename "$OLD") already runs these commits (--force to rebuild)"
    exit 0
  fi
fi

BASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-b${BE_SHA:0:7}-d${DB_SHA:0:7}"
ID=$BASE_ID
n=1
# two deploys of the same commits in one second (--force) must not share a directory
while [[ -e "$OASIS_PREFIX/releases/$ID" || -e "$OASIS_PREFIX/releases/$ID.failed" || -e "$OASIS_PREFIX/releases/$ID.partial" ]]; do
  n=$((n + 1))
  ID="$BASE_ID-$n"
done
REL="$OASIS_PREFIX/releases/$ID"
PART="$REL.partial"
log "release $ID"

PART_ACTIVE=0
on_exit() {
  # a build that did not finish is kept for inspection, never left looking like a release
  if ((PART_ACTIVE)) && [[ "$DRY_RUN" != 1 && -d "$PART" ]]; then
    mv "$PART" "$REL.failed" 2>/dev/null && log "kept the unfinished build in $REL.failed for inspection"
  fi
}
trap on_exit EXIT
trap 'log "interrupted"; exit 130' INT TERM

# --- 3. build -------------------------------------------------------------------------------------------------------------------
run mkdir -p "$PART/backend" "$PART/dashboard"
PART_ACTIVE=1
if [[ "$DRY_RUN" != 1 ]]; then
  chown "$OASIS_USER:$OASIS_USER" "$PART" "$PART/backend" "$PART/dashboard" 2>/dev/null || true
fi
export_tree() {
  local repo=$1 sha=$2 dest=$3
  if [[ "$DRY_RUN" == 1 ]]; then
    log "would export $repo $sha to $dest"
    return 0
  fi
  oasis_read git -C "$OASIS_PREFIX/src/$repo" archive "$sha" | as_oasis tar -x -C "$dest"
}
export_tree backend "$BE_SHA" "$PART/backend"
export_tree dashboard "$DB_SHA" "$PART/dashboard"

log "building the API"
as_oasis env HOME="$OASIS_STATE" CI=1 NODE_OPTIONS=--max-old-space-size=2048 bash -c 'cd "$1" && pnpm install --frozen-lockfile && pnpm build' _ "$PART/backend"
log "building the dashboard (live variant)"
as_oasis env HOME="$OASIS_STATE" CI=1 NODE_OPTIONS=--max-old-space-size=2048 bash -c 'cd "$1" && pnpm install --frozen-lockfile && pnpm build:live' _ "$PART/dashboard"

if [[ "$DRY_RUN" != 1 ]]; then
  [[ -f "$PART/backend/dist/server.js" && -f "$PART/backend/dist/worker.js" ]] || die "the API build produced no dist/server.js and dist/worker.js"
  [[ -d "$PART/dashboard/.next-live" ]] || die "the dashboard build produced no .next-live"
  printf 'backend=%s\ndashboard=%s\nbuilt=%s\n' "$BE_SHA" "$DB_SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$PART/REVISIONS"
  mv "$PART" "$REL"
fi
PART_ACTIVE=0

# --- 4. pre-deploy backup -------------------------------------------------------------------------------------------------------
if ((SKIP_BACKUP)); then
  warn "skipping the pre-deploy backup (--skip-backup)"
else
  log "pre-deploy backup"
  # shellcheck disable=SC2086
  as_oasis ${BACKUP_CMD:-$OASIS_HERE/backup.sh} --label pre-deploy || die "the pre-deploy backup failed; nothing was changed. Fix it, or deploy with --skip-backup if you accept the risk."
fi

# --- 5. migrate (old release still serving) -----------------------------------------------------------------------------------
log "applying migrations with the new code"
if ! in_release_env "$REL/backend" pnpm migrate up; then
  [[ "$DRY_RUN" == 1 ]] || mv "$REL" "$REL.failed"
  die "migration failed; the running release was not touched. The failed build is in $REL.failed. The migration runs in a transaction, so the schema is unchanged."
fi

# --- 6. switch and restart --------------------------------------------------------------------------------------------------
[[ -z "$OLD" ]] || point_symlink previous "$OLD"
point_symlink current "$REL"

rollback() {
  warn "the new release is not healthy: rolling back"
  if [[ -n "$OLD" && -d "$OLD" ]]; then
    point_symlink current "$OLD"
    restart_services || true
    if health_gate "$WAIT"; then
      warn "rolled back to $(basename "$OLD"); it is healthy again. The database keeps the new migrations (docs/runbook.md, Rollback)."
    else
      warn "the previous release is ALSO unhealthy. Read: journalctl -u oasis-api -u oasis-worker -u oasis-web --since '10 min ago'"
    fi
  else
    warn "there is no previous release to go back to (first deployment): the services are stopped"
    stop_services
  fi
  [[ "$DRY_RUN" == 1 ]] || mv "$REL" "$REL.failed"
  record_deploy "$ID" rolled-back
  exit 1
}

if ! restart_services; then rollback; fi

# --- 7. health ------------------------------------------------------------------------------------------------------------------
if ! health_gate "$WAIT"; then rollback; fi

record_deploy "$ID" ok
changed "release $ID is live"

# --- 8. did the kit's own configuration change? ----------------------------------------------------------------------------------
# Units, nginx templates and env templates are installed by install.sh, not by a release: say so when this release changed them.
if [[ -n "$OLD" && -d "$OLD/backend/deploy" && "$DRY_RUN" != 1 ]]; then
  changed_cfg=$(cd "$OLD/backend/deploy" && for d in systemd nginx env logrotate journald; do [[ -d "$d" ]] && diff -rq "$d" "$REL/backend/deploy/$d" 2>&1 | sed "s#^#  #"; done || true)
  if [[ -n "$changed_cfg" ]]; then
    warn "this release changes the deployment configuration; apply it with install.sh (safe to repeat, it never overwrites your env files):"
    printf '%s\n' "$changed_cfg" >&2
  fi
fi

# --- 9. housekeeping ---------------------------------------------------------------------------------------------------------------
cur=$(current_release)
prev=$(previous_release)
i=0
while IFS= read -r r; do
  i=$((i + 1))
  if ((i > KEEP)) && [[ "$r" != "$cur" && "$r" != "$prev" ]]; then
    run rm -rf -- "$r"
    log "removed old release $(basename "$r")"
  fi
done < <(releases_newest_first)
j=0
while IFS= read -r r; do
  j=$((j + 1))
  if ((j > 2)); then run rm -rf -- "$r"; fi
done < <(find "$OASIS_PREFIX/releases" -mindepth 1 -maxdepth 1 -name '*.failed' | sort -r)
