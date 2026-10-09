#!/usr/bin/env bash
# site-deploy.sh [--ref REF] [--force] [--keep N] [--skip-hours] [--dry-run] | --list | --rollback [--to RELEASE_ID]
#
# Builds the public website from the root-owned mirror, verifies the output, and switches nginx's document root to it.
#   1. reads /etc/oasis/site.env (install.sh --site-domain wrote it: SITE_DOMAIN, SITE_ROOT, SITE_MIRROR, SITE_MARKER ...)
#   2. the mirror (/opt/oasis/git/site.git) must be owned by root with nothing writable by group or others, or nothing runs:
#      root reads the commit from it and exports it with git archive. --ref names a branch, tag or commit of the mirror (default main)
#   3. nothing to do when <site root>/current already runs that commit (--force builds anyway)
#   4. the tree goes into <site root>/releases/<id>.partial/src, owned by the oasis user, which builds it there:
#      pnpm install --frozen-lockfile && pnpm build, with SITE_URL=https://<domain> and SITE_HOURS_JSON=<a snapshot of the API's
#      /api/v1/public/hours on this host, fetched just before; --skip-hours or an API that does not answer: no snapshot, a warning>
#   5. the build's dist/ is verified before anything is served: index.html and 404.html present, index larger than 1 KB and
#      containing the marker text, no localhost/loopback or development-port URL in any html/js/css, no inline <script> (the
#      Content-Security-Policy allows none; JSON-LD data blocks are not scripts), no symbolic link, no file over 25 MB, total between
#      50 KB and 200 MB. A failure keeps the build in <id>.failed and changes nothing
#   6. dist/ becomes <site root>/releases/<id> with a REVISION record (site=<commit>, built=<time>, hours=<fetched|skipped|unavailable>),
#      owned by root, read-only for everyone (nginx reads it); the sources and node_modules are removed
#   7. current -> the new release (atomic; previous -> the one before). No nginx reload: it follows the link
#   8. health, through nginx on this host: https://<domain>/ answers 200 with the marker, https://www.<domain>/ answers 301 to the apex,
#      /api/v1/public/hours answers 200 (a warning only: the site works without live hours). Unhealthy: current -> the old release,
#      the new one becomes <id>.failed, exit 1
#   9. keeps SITE_KEEP releases (default 4) plus current and previous, and 2 failed builds
# --rollback: current -> previous (or --to ID), the same health check (exit 3 when it fails). --list: the releases.
# Run as root from the root-owned kit: sudo /usr/local/lib/oasis/deploy/scripts/site-deploy.sh. One at a time (a lock).
# SITE_HEALTH_CMD, SITE_HOURS_URL, OASIS_RUN_AS, OASIS_CHOWN and OASIS_KIT_TRUST_UID replace the commands it calls (the tests use them).
set -euo pipefail
OASIS_HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
. "$OASIS_HERE/../lib/common.sh"
# shellcheck source=../lib/release.sh
. "$OASIS_HERE/../lib/release.sh"
# Commands run as the oasis user inherit the working directory, and a caller's home is not theirs to enter. Every path is absolute.
cd /

REF=main
FORCE=0
KEEP=""
SKIP_HOURS=0
LIST=0
ROLLBACK=0
TO=""

while (($#)); do
  case "$1" in
    --ref) REF=$2; shift 2 ;;
    --force) FORCE=1; shift ;;
    --keep) KEEP=$2; shift 2 ;;
    --skip-hours) SKIP_HOURS=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --list) LIST=1; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    --to) TO=$2; shift 2 ;;
    -h | --help)
      sed -n '2,/^set -euo pipefail$/p' "$OASIS_HERE/site-deploy.sh" | sed '$d' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown option $1" ;;
  esac
done
[[ -z "$KEEP" || "$KEEP" =~ ^[0-9]+$ ]] || die "--keep N needs a number"
[[ -z "$TO" ]] || ((ROLLBACK)) || die "--to needs --rollback"

# --- the site's settings: site.env, with the environment allowed to override (tests) ------------------------------------------------
SITE_ENV="$OASIS_ETC/site.env"
[[ -r "$SITE_ENV" ]] || die "$SITE_ENV is missing: run install.sh --site-domain <domain> first"
site_setting() {
  local name=$1 v
  v=${!name:-}
  [[ -n "$v" ]] || v=$(env_get "$SITE_ENV" "$name" 2>/dev/null) || v=""
  printf '%s' "$v"
}
SITE_DOMAIN=$(site_setting SITE_DOMAIN)
SITE_MARKER=$(site_setting SITE_MARKER)
SITE_BUILD_DIR=$(site_setting SITE_BUILD_DIR)
SITE_BUILD_DIR=${SITE_BUILD_DIR:-dist}
# paths from site.env are the running system's; the environment's are used as given (a staging directory in the tests)
SITE_ROOT=${SITE_ROOT:-${OASIS_ROOT_PREFIX}$(env_get "$SITE_ENV" SITE_ROOT 2>/dev/null || true)}
SITE_MIRROR=${SITE_MIRROR:-${OASIS_ROOT_PREFIX}$(env_get "$SITE_ENV" SITE_MIRROR 2>/dev/null || true)}
[[ -n "$SITE_DOMAIN" && -n "$SITE_ROOT" && -n "$SITE_MIRROR" ]] || die "$SITE_ENV lacks SITE_DOMAIN, SITE_ROOT or SITE_MIRROR (re-run install.sh --site-domain)"
[[ "$SITE_ROOT" == /* && "$SITE_MIRROR" == /* ]] || die "SITE_ROOT and SITE_MIRROR must be absolute paths"
[[ "$SITE_BUILD_DIR" =~ ^[A-Za-z0-9._-]+$ && "$SITE_BUILD_DIR" != . && "$SITE_BUILD_DIR" != .. ]] || die "SITE_BUILD_DIR must be a plain directory name (is: $SITE_BUILD_DIR)"
[[ -n "$KEEP" ]] || KEEP=$(site_setting SITE_KEEP)
KEEP=${KEEP:-4}
RELEASES="$SITE_ROOT/releases"

site_current() { readlink -e "$SITE_ROOT/current" 2>/dev/null || true; }
site_previous() { readlink -e "$SITE_ROOT/previous" 2>/dev/null || true; }
site_link() {
  local name=$1 target=$2
  run ln -sfn "$target" "$SITE_ROOT/$name.new"
  run mv -T "$SITE_ROOT/$name.new" "$SITE_ROOT/$name"
}
# newest first by build time (REVISION is written last), never .failed or .partial
site_releases_newest_first() {
  [[ -d "$RELEASES" ]] || return 0
  find "$RELEASES" -mindepth 2 -maxdepth 2 -name REVISION -printf '%T@ %h\n' | sort -rn | cut -d' ' -f2- | grep -v -E '\.(failed|partial)$' || true
}
record_site_deploy() {
  [[ "$DRY_RUN" == 1 ]] && return 0
  printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$1" "$2" >>"$OASIS_LOG_DIR/site-deploys.list" 2>/dev/null || true
}
release_commit() { grep -E '^site=' "$1/REVISION" 2>/dev/null | cut -d= -f2- || true; }

# --- health: through nginx on this host, by name (the certificate is the real one, the address loopback) -----------------------------
site_health() {
  if [[ -n "${SITE_HEALTH_CMD:-}" ]]; then
    # shellcheck disable=SC2086
    $SITE_HEALTH_CMD "$SITE_DOMAIN" "$SITE_MARKER"
    return
  fi
  local body code location rc=0
  body=$(mktemp)
  code=$(curl -sS --max-time 10 --resolve "$SITE_DOMAIN:443:127.0.0.1" -o "$body" -w '%{http_code}' "https://$SITE_DOMAIN/" 2>/dev/null) || code=000
  if [[ "$code" != 200 ]]; then
    warn "https://$SITE_DOMAIN/ answered HTTP $code through nginx on this host, expected 200"
    rc=1
  elif [[ -n "$SITE_MARKER" ]] && ! grep -qF -- "$SITE_MARKER" "$body"; then
    warn "https://$SITE_DOMAIN/ answered 200 but the page does not contain the marker text '$SITE_MARKER'"
    rc=1
  fi
  rm -f "$body"
  code=$(curl -sS --max-time 10 --resolve "www.$SITE_DOMAIN:443:127.0.0.1" -o /dev/null -w '%{http_code} %{redirect_url}' "https://www.$SITE_DOMAIN/" 2>/dev/null) || code="000 "
  location=${code#* }
  code=${code%% *}
  if [[ "$code" != 301 || "$location" != "https://$SITE_DOMAIN/" ]]; then
    warn "https://www.$SITE_DOMAIN/ answered HTTP $code${location:+ to $location}, expected 301 to https://$SITE_DOMAIN/"
    rc=1
  fi
  code=$(curl -sS --max-time 10 --resolve "$SITE_DOMAIN:443:127.0.0.1" -o /dev/null -w '%{http_code}' "https://$SITE_DOMAIN/api/v1/public/hours" 2>/dev/null) || code=000
  [[ "$code" == 200 ]] || warn "https://$SITE_DOMAIN/api/v1/public/hours answered HTTP $code (the site shows its built-in hours until the API answers; not a deploy failure)"
  return "$rc"
}

# --- --list -----------------------------------------------------------------------------------------------------------------------
if ((LIST)); then
  cur=$(site_current)
  prev=$(site_previous)
  while IFS= read -r r; do
    tag=""
    [[ "$r" == "$cur" ]] && tag=" <- current"
    [[ "$r" == "$prev" ]] && tag=" <- previous"
    printf '%s %s%s\n' "$(basename "$r")" "$(release_commit "$r" | cut -c1-12)" "$tag"
  done < <(site_releases_newest_first | tac) # oldest first, by build time
  exit 0
fi

need_root
[[ -d "$SITE_ROOT" ]] || die "$SITE_ROOT does not exist: run install.sh --site-domain $SITE_DOMAIN first"
mkdir -p "$RELEASES" "$OASIS_LOG_DIR" 2>/dev/null || true
exec 9>"$SITE_ROOT/.deploy.lock"
flock -n 9 || die "another site deploy or rollback is running"
if [[ "$DRY_RUN" != 1 ]]; then exec > >(tee -a "$OASIS_LOG_DIR/site-deploy.log") 2>&1; fi
if ! running_from_kit "$OASIS_HERE"; then
  warn "running $OASIS_HERE/site-deploy.sh, not the root-owned kit in $OASIS_KIT_DIR: run $(printf '%s' "${OASIS_KIT_DIR#"$OASIS_ROOT_PREFIX"}")/scripts/site-deploy.sh (deploy.sh installs it)"
fi
# the site root and its releases belong to root: the oasis user builds inside <id>.partial only (ADR 0145)
if [[ "$DRY_RUN" != 1 ]]; then
  for d in "$SITE_ROOT" "$RELEASES"; do
    root_own root:root "$d"
    chmod 0755 "$d"
  done
fi

OLD=$(site_current)

# --- --rollback ----------------------------------------------------------------------------------------------------------------------
if ((ROLLBACK)); then
  if [[ -n "$TO" ]]; then target="$RELEASES/$TO"; else target=$(site_previous); fi
  [[ -n "$target" && -d "$target" && -f "$target/REVISION" ]] || die "no release to go back to (try --list)"
  [[ "$target" != "$OLD" ]] || die "$(basename "$target") is already the current release"
  log "rolling the website back from $(basename "${OLD:-none}") to $(basename "$target")"
  [[ -z "$OLD" ]] || site_link previous "$OLD"
  site_link current "$target"
  if [[ "$DRY_RUN" == 1 ]]; then
    log "would health-check https://$SITE_DOMAIN/ through nginx"
    exit 0
  fi
  if site_health; then
    record_site_deploy "$(basename "$target")" rollback-ok
    changed "the website now serves $(basename "$target")"
  else
    record_site_deploy "$(basename "$target")" rollback-unhealthy
    warn "switched to $(basename "$target") but the website is not healthy: check nginx (nginx -t, /var/log/nginx/oasis-site.error.log)"
    exit 3
  fi
  exit 0
fi

# --- 1. the mirror, root-only, and the commit ---------------------------------------------------------------------------------------
# The path is fixed (site.env, root-owned), never read from a clone the oasis user could repoint. Everything in it must belong to
# root (OASIS_KIT_TRUST_UID in the tests) with nothing writable by group or others, its directory included: root is about to run a
# build of what it holds.
trust_uid=${OASIS_KIT_TRUST_UID:-0}
[[ -d "$SITE_MIRROR" ]] || die "no mirror at $SITE_MIRROR: publish the site repository there first (docs/runbook.md, \"The public website\")"
mirror_parent=$(dirname "$SITE_MIRROR")
if [[ -n "$(find "$SITE_MIRROR" \( ! -uid "$trust_uid" -o \( ! -type l -perm /022 \) \) -print -quit 2>/dev/null)" ]] ||
  [[ "$(stat -c %u "$mirror_parent")" != "$trust_uid" || -n "$(find "$mirror_parent" -maxdepth 0 -perm /022 -print 2>/dev/null)" ]]; then
  die "the mirror $SITE_MIRROR (or its directory) can be changed by users other than root: refusing to build from it. Make it root-only: sudo chown -R root:root $mirror_parent && sudo chmod -R go-w $mirror_parent"
fi
mirror_git() { git -c safe.directory="$SITE_MIRROR" -C "$SITE_MIRROR" "$@"; }
SHA=$(mirror_git rev-parse --verify --quiet "$REF^{commit}") || die "ref $REF does not exist in $SITE_MIRROR"
log "site $REF = ${SHA:0:12} (mirror $SITE_MIRROR)"
if [[ -n "$OLD" ]]; then log "current release: $(basename "$OLD") ($(release_commit "$OLD" | cut -c1-12))"; else log "current release: none"; fi

# --- 2. anything to do? ---------------------------------------------------------------------------------------------------------
if [[ -n "$OLD" && "$FORCE" != 1 && "$(release_commit "$OLD")" == "$SHA" ]]; then
  ok "nothing to deploy: $(basename "$OLD") already serves commit ${SHA:0:12} (--force to rebuild)"
  exit 0
fi

BASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-s${SHA:0:7}"
ID=$BASE_ID
n=1
while [[ -e "$RELEASES/$ID" || -e "$RELEASES/$ID.failed" || -e "$RELEASES/$ID.partial" ]]; do
  n=$((n + 1))
  ID="$BASE_ID-$n"
done
REL="$RELEASES/$ID"
PART="$REL.partial"
log "release $ID"

PART_ACTIVE=0
on_exit() {
  if ((PART_ACTIVE)) && [[ "$DRY_RUN" != 1 && -d "$PART" ]]; then
    mv "$PART" "$REL.failed" 2>/dev/null && log "kept the unfinished build in $REL.failed for inspection"
  fi
}
trap on_exit EXIT
trap 'log "interrupted"; exit 130' INT TERM

# --- 3. export and build as the oasis user ------------------------------------------------------------------------------------------
if [[ "$DRY_RUN" == 1 ]]; then
  log "would export ${SHA:0:12} into $PART/src, fetch the hours snapshot, build as $OASIS_USER (pnpm install --frozen-lockfile && pnpm build), verify $SITE_BUILD_DIR/, make it $REL and point $SITE_ROOT/current at it, then health-check https://$SITE_DOMAIN/"
  exit 0
fi
run mkdir -p "$PART/src"
PART_ACTIVE=1
chown "$OASIS_USER:$OASIS_USER" "$PART" "$PART/src" 2>/dev/null || true
mirror_git archive "$SHA" | as_oasis tar -x -C "$PART/src"

# the hours snapshot: the API on this host (api.env's PORT), so the first paint shows today's hours even before the browser asks
HOURS_FILE="$PART/hours.json"
HOURS=skipped
if ((SKIP_HOURS)); then
  log "hours snapshot skipped (--skip-hours)"
else
  api_port=$(env_get "$OASIS_ETC/api.env" PORT 2>/dev/null) || api_port=""
  hours_url=${SITE_HOURS_URL:-http://127.0.0.1:${api_port:-4000}/api/v1/public/hours}
  if curl -fsS --max-time 5 -o "$HOURS_FILE" "$hours_url" 2>/dev/null && [[ -s "$HOURS_FILE" ]]; then
    chmod 0644 "$HOURS_FILE"
    HOURS=fetched
    ok "hours snapshot from $hours_url"
  else
    rm -f "$HOURS_FILE"
    HOURS=unavailable
    warn "no hours snapshot: $hours_url did not answer (the site builds with its own fallback hours and asks the API in the browser)"
  fi
fi

log "building the website as $OASIS_USER"
build_env=()
[[ "$HOURS" == fetched ]] || build_env+=(-u SITE_HOURS_JSON) # (env options come before the assignments)
build_env+=(HOME="$OASIS_STATE" CI=1 NODE_OPTIONS=--max-old-space-size=2048 SITE_URL="https://$SITE_DOMAIN")
[[ "$HOURS" != fetched ]] || build_env+=(SITE_HOURS_JSON="$HOURS_FILE")
as_oasis env "${build_env[@]}" bash -c 'cd "$1" && pnpm install --frozen-lockfile && pnpm build' _ "$PART/src" || die "the website build failed; nothing was changed. The build is kept in $REL.failed for inspection"

# --- 4. verify the output before anything is served ---------------------------------------------------------------------------------
DIST="$PART/src/$SITE_BUILD_DIR"
verify_dist() {
  local problems=() total big
  [[ -d "$DIST" ]] || { problems+=("no $SITE_BUILD_DIR/ directory"); printf '%s\n' "${problems[@]}"; return 1; }
  [[ -f "$DIST/index.html" ]] || problems+=("index.html is missing")
  [[ -f "$DIST/404.html" ]] || problems+=("404.html is missing")
  if [[ -f "$DIST/index.html" ]]; then
    (($(stat -c %s "$DIST/index.html") > 1024)) || problems+=("index.html is smaller than 1 KB")
    [[ -z "$SITE_MARKER" ]] || grep -qF -- "$SITE_MARKER" "$DIST/index.html" || problems+=("index.html does not contain the marker text '$SITE_MARKER'")
  fi
  local hits
  # development addresses and ports in anything the browser runs: a build that kept its local API origin would break on the host
  hits=$(grep -rElI --include='*.html' --include='*.js' --include='*.mjs' --include='*.css' -e 'localhost' -e '127\.0\.0\.1' -e '0\.0\.0\.0' -e '//[A-Za-z0-9.-]+:(3000|4000|4321)([^0-9]|$)' "$DIST" 2>/dev/null | head -n 5 || true)
  [[ -z "$hits" ]] || problems+=("development address or port (localhost, 127.0.0.1, 0.0.0.0, :3000, :4000, :4321) in: $(tr '\n' ' ' <<<"$hits")")
  # every <script> must come from a file (the policy allows no inline script); a JSON-LD data block is not a script
  hits=$(grep -rhoI --include='*.html' -e '<script[^>]*>' "$DIST" 2>/dev/null | grep -Ev 'src=|type="application/ld\+json"' | head -n 3 || true)
  [[ -z "$hits" ]] || problems+=("inline <script> in the HTML (the Content-Security-Policy allows none): $(tr '\n' ' ' <<<"$hits")")
  hits=$(find "$DIST" -type l -print -quit)
  [[ -z "$hits" ]] || problems+=("symbolic link in the output: $hits")
  big=$(find "$DIST" -type f -size +25M -print -quit)
  [[ -z "$big" ]] || problems+=("file over 25 MB: $big")
  total=$(du -sb "$DIST" | cut -f1)
  ((total >= 50 * 1024)) || problems+=("total size ${total} bytes is below 50 KB")
  ((total <= 200 * 1024 * 1024)) || problems+=("total size ${total} bytes is above 200 MB")
  ((${#problems[@]} == 0)) || { printf '%s\n' "${problems[@]}"; return 1; }
}
if ! problems=$(verify_dist); then
  die "the build's $SITE_BUILD_DIR/ is not a deployable site:
$(sed 's/^/  - /' <<<"$problems")
Nothing was changed; the build is kept in $REL.failed for inspection"
fi
ok "verified $SITE_BUILD_DIR/ ($(du -sh "$DIST" | cut -f1), $(find "$DIST" -type f | wc -l) files)"

# --- 5. the release: root-owned, read-only, world-readable; the sources are not kept -----------------------------------------------------
mv "$DIST" "$REL"
PART_ACTIVE=0
rm -rf -- "$PART"
printf 'site=%s\nbuilt=%s\nhours=%s\n' "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$HOURS" >"$REL/REVISION"
root_own -R root:root "$REL"
chmod -R u=rwX,go=rX "$REL"

# --- 6. switch (no nginx reload: it reads through the link) and health ------------------------------------------------------------------
[[ -z "$OLD" ]] || site_link previous "$OLD"
site_link current "$REL"
if site_health; then
  record_site_deploy "$ID" ok
  changed "release $ID is live at https://$SITE_DOMAIN/"
else
  warn "the new release is not healthy: switching back"
  if [[ -n "$OLD" && -d "$OLD" ]]; then
    site_link current "$OLD"
    if site_health; then warn "back on $(basename "$OLD"), which is healthy"; else warn "the previous release is ALSO unhealthy: check nginx (nginx -t, /var/log/nginx/oasis-site.error.log)"; fi
  else
    rm -f "$SITE_ROOT/current"
    warn "there was no previous release to go back to: $SITE_ROOT/current removed"
  fi
  mv "$REL" "$REL.failed"
  record_site_deploy "$ID" rolled-back
  exit 1
fi

# --- 7. housekeeping -------------------------------------------------------------------------------------------------------------------
cur=$(site_current)
prev=$(site_previous)
i=0
while IFS= read -r r; do
  i=$((i + 1))
  if ((i > KEEP)) && [[ "$r" != "$cur" && "$r" != "$prev" ]]; then
    run rm -rf -- "$r"
    log "removed old release $(basename "$r")"
  fi
done < <(site_releases_newest_first)
j=0
while IFS= read -r r; do
  j=$((j + 1))
  if ((j > 2)); then run rm -rf -- "$r"; fi
done < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -name '*.failed' | sort -r)
