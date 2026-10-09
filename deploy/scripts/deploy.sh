#!/usr/bin/env bash
# deploy.sh [--backend-ref REF] [--dashboard-ref REF] [--skip-backup] [--force] [--keep N] [--wait SECONDS] [--dry-run]
#
# Fetch, build, migrate, switch, restart, health-check, and roll back by itself when the new release is not healthy.
#   1. git fetch both repositories (src/backend, src/dashboard) and resolve the refs (default origin/main)
#   2. nothing to do when the current release already has those two commits (--force builds anyway)
#   3. export both trees into releases/<id>, pnpm install --frozen-lockfile, pnpm build (API) and pnpm build:live (dashboard, with
#      OASIS_PHOTOS_ORIGINS from S3_BUCKET and AWS_REGION in common.env when STORAGE_PROVIDER=s3, for its Content-Security-Policy);
#      then the release becomes root:oasis and read-only (Next's cache is a symlink to /var/cache/oasis-web), and its deploy/ must equal
#      the commit's in a root-owned local mirror when the backend's origin is one
#   4. backup.sh --label pre-deploy                    (the safety net for the migration; skipped with --skip-backup)
#   5. pnpm migrate up with the new code, while the old release is still serving
#   6. current -> the new release; restart worker, API, dashboard
#   7. healthcheck.sh --wait: API ready (database, migrations, jobs), dashboard answering, the public sign-in redirect, the worker;
#      healthy: the root-owned kit (/usr/local/lib/oasis/deploy) is refreshed from the new release
#   8. unhealthy: current -> the previous release, restart, health-check again, exit 1
# A build or migration failure changes nothing that is running. Migrations are forward-only and the old code keeps running against
# the migrated schema after a rollback, so every migration must stay compatible with the release before it (docs/runbook.md).
# Run as root (sudo) from the root-owned kit: sudo /usr/local/lib/oasis/deploy/scripts/deploy.sh. Builds and migrations drop to the oasis
# user. One deploy at a time (flock).
set -euo pipefail
OASIS_HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
. "$OASIS_HERE/../lib/common.sh"
# shellcheck source=../lib/release.sh
. "$OASIS_HERE/../lib/release.sh"
# Commands run as the oasis user inherit the working directory, and a caller's home (root's, or an operator's) is not
# theirs to enter: spawned processes (pnpm, tsx/esbuild, git) then fail with EACCES. Every path below is absolute.
cd /

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
      sed -n '2,/^set -euo pipefail$/p' "$OASIS_HERE/deploy.sh" | sed '$d' | sed 's/^# \{0,1\}//'
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
# Releases live in root-owned directories: the oasis user builds inside its own staging directory (<id>.partial) and can neither
# rename nor replace a finished release, nor the current/previous links (ADR 0140).
if [[ "$DRY_RUN" != 1 ]]; then
  for d in "$OASIS_PREFIX" "$OASIS_PREFIX/releases"; do
    root_own root:root "$d"
    chmod 0755 "$d"
  done
fi
if ! running_from_kit "$OASIS_HERE"; then
  warn "running $OASIS_HERE/deploy.sh, not the root-owned kit in $OASIS_KIT_DIR: from the next deploy on, run $(printf '%s' "${OASIS_KIT_DIR#"$OASIS_ROOT_PREFIX"}")/scripts/deploy.sh (this deploy installs it)"
fi

for repo in backend dashboard; do
  [[ -d "$OASIS_PREFIX/src/$repo/.git" || -f "$OASIS_PREFIX/src/$repo/HEAD" ]] || die "$OASIS_PREFIX/src/$repo is not a git clone (run install.sh, then clone the repository there)"
done
for f in common.env api.env worker.env web.env; do [[ -r "$OASIS_ETC/$f" ]] || die "$OASIS_ETC/$f is missing (run install.sh)"; done
[[ ! -e "$OASIS_ETC/secret-seed.env" ]] || warn "$OASIS_ETC/secret-seed.env still exists: push it into the secret (docs/aws-setup.md, step 6) and shred it"

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

# The photos bucket's origins, for the dashboard's Content-Security-Policy (next.config.mjs reads OASIS_PHOTOS_ORIGINS at BUILD time):
# with STORAGE_PROVIDER=s3, both host names S3 may use for S3_BUCKET in AWS_REGION (common.env), comma-separated; otherwise empty.
photos_origins() {
  local f="$OASIS_ETC/common.env" provider bucket region
  provider=$(env_get "$f" STORAGE_PROVIDER 2>/dev/null) || provider=""
  [[ "$provider" == s3 ]] || return 0
  bucket=$(env_get "$f" S3_BUCKET 2>/dev/null) || bucket=""
  region=$(env_get "$f" AWS_REGION 2>/dev/null) || region=""
  region=${region:-us-east-1}
  [[ "$bucket" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "STORAGE_PROVIDER=s3 but S3_BUCKET in $f is ${bucket:+not a bucket name: }${bucket:-not set}"
  [[ "$region" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || die "AWS_REGION in $f is not an AWS region: $region"
  printf 'https://%s.s3.%s.amazonaws.com,https://%s.s3.amazonaws.com' "$bucket" "$region" "$bucket"
}
PHOTOS_ORIGINS=$(photos_origins)
log "photos origins for the dashboard build: ${PHOTOS_ORIGINS:-(none: STORAGE_PROVIDER is not s3)}"

# --- 2. anything to do? ---------------------------------------------------------------------------------------------------------
# (the photos origins are part of the dashboard build, so a changed bucket or region rebuilds too)
if [[ -n "$OLD" && -f "$OLD/REVISIONS" && "$FORCE" != 1 ]]; then
  if grep -qx "backend=$BE_SHA" "$OLD/REVISIONS" && grep -qx "dashboard=$DB_SHA" "$OLD/REVISIONS" &&
    grep -qxF "photos_origins=$PHOTOS_ORIGINS" "$OLD/REVISIONS"; then
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
as_oasis env HOME="$OASIS_STATE" CI=1 NODE_OPTIONS=--max-old-space-size=2048 OASIS_PHOTOS_ORIGINS="$PHOTOS_ORIGINS" bash -c 'cd "$1" && pnpm install --frozen-lockfile && pnpm build:live' _ "$PART/dashboard"

if [[ "$DRY_RUN" != 1 ]]; then
  [[ -f "$PART/backend/dist/server.js" && -f "$PART/backend/dist/worker.js" ]] || die "the API build produced no dist/server.js and dist/worker.js"
  [[ -d "$PART/dashboard/.next-live" ]] || die "the dashboard build produced no .next-live"
  # The release becomes read-only; Next's runtime cache moves out of it, to the directory systemd gives oasis-web (CacheDirectory=).
  # (The build's own cache there, webpack and swc, is not needed at run time.)
  rm -rf -- "$PART/dashboard/.next-live/cache"
  ln -s "$OASIS_WEB_CACHE" "$PART/dashboard/.next-live/cache"
fi
lock_release "$PART"
if [[ "$DRY_RUN" != 1 ]]; then
  # The kit root will copy from this release must be the commit's own, as the root-owned mirror has it.
  verify_kit "$PART" "$BE_SHA" || die "the deploy kit in the built release differs from commit ${BE_SHA:0:12} in the mirror: a build step changed it. Nothing was changed; the build is kept in $REL.failed for inspection"
  printf 'backend=%s\ndashboard=%s\nphotos_origins=%s\nbuilt=%s\n' "$BE_SHA" "$DB_SHA" "$PHOTOS_ORIGINS" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$PART/REVISIONS"
  chmod 0644 "$PART/REVISIONS"
  mv "$PART" "$REL"
fi
PART_ACTIVE=0

# --- 4. pre-deploy backup -------------------------------------------------------------------------------------------------------
if ((SKIP_BACKUP)); then
  warn "skipping the pre-deploy backup (--skip-backup)"
else
  log "pre-deploy backup"
  # The backup reads DATABASE_URL through the app's loader, which needs installed packages: use the release just built (on a
  # first deployment the source clone has none, and there is no current release yet).
  backup_env=()
  [[ -x "$REL/backend/node_modules/.bin/tsx" ]] && backup_env=(env "OASIS_BACKEND_DIR=$REL/backend")
  # shellcheck disable=SC2086
  as_oasis_aws "${backup_env[@]}" ${BACKUP_CMD:-$OASIS_HERE/backup.sh} --label pre-deploy || die "the pre-deploy backup failed; nothing was changed. Fix it, or deploy with --skip-backup if you accept the risk."
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

# --- 7b. the root-owned kit follows the release that is now live and healthy ----------------------------------------------------------
if [[ "$DRY_RUN" == 1 ]]; then
  log "would refresh the deploy kit in $OASIS_KIT_DIR from the new release"
elif [[ -d "$REL/backend/deploy/scripts" ]]; then
  install_kit "$REL/backend/deploy"
  if ((KIT_VERIFIED)); then ok "the kit matches commit ${BE_SHA:0:12} in the root-owned mirror"; fi
else
  warn "the release has no deploy/ kit: $OASIS_KIT_DIR left as it was"
fi

# --- 8. did the kit's own configuration change? ----------------------------------------------------------------------------------
# Units, nginx templates and env templates are installed by install.sh, not by a release: say so when this release changed them.
if [[ -n "$OLD" && -d "$OLD/backend/deploy" && "$DRY_RUN" != 1 ]]; then
  changed_cfg=$(cd "$OLD/backend/deploy" && for d in systemd nginx env logrotate journald; do [[ -d "$d" ]] && diff -rq "$d" "$REL/backend/deploy/$d" 2>&1 | sed "s#^#  #"; done || true)
  if [[ -n "$changed_cfg" ]]; then
    warn "this release changes the deployment configuration; apply it with $(printf '%s' "${OASIS_KIT_DIR#"$OASIS_ROOT_PREFIX"}")/scripts/install.sh and the options this host was installed with (safe to repeat, it never overwrites your env files):"
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
