#!/usr/bin/env bash
# site-deploy.sh [--ref REF] [--force] [--keep N] [--skip-hours] [--dry-run] | --list | --rollback [--to RELEASE_ID]
#
# Builds the public website from the root-owned mirror, verifies the output, and switches nginx's document root to it.
#   1. reads /etc/oasis/site.env (install.sh --site-domain wrote it: SITE_DOMAIN, SITE_ROOT, SITE_MIRROR, SITE_MARKER ...)
#   2. the mirror (/opt/oasis/git/site.git) must be owned by root with nothing writable by group or others, or nothing runs:
#      root reads the commit from it and exports it with git archive. --ref names a branch, tag or commit of the mirror (default main)
#   3. nothing to do when <site root>/current already runs that commit (--force builds anyway)
#   4. the tree goes into <site root>/releases/<id>.partial/src: <id>.partial is root's, src (only) belongs to the website build user
#      oasis-site (not oasis: no access to /etc/oasis, the app's state or backups, rejected by the metadata guard), which builds it there
#      with an environment of its own (env -i): pnpm install --frozen-lockfile && pnpm build, HOME=/var/lib/oasis-site,
#      SITE_URL=https://<domain> and SITE_HOURS_JSON=<a snapshot of the API's /api/v1/public/hours on this host, fetched just before by
#      root into the root-owned <id>.partial; --skip-hours or an API that does not answer: no snapshot, a warning>
#   5. then every process of oasis-site is killed and <id>.partial becomes root-only (0700): nothing can change the build tree any more.
#      Root copies dist/ out of it (cp -R -P: links are copied as links, never followed) into a fresh directory of its own, refusing a
#      hard link or a file the build user does not own, and verifies THE COPY before anything is served: index.html and 404.html present,
#      index larger than 1 KB and containing the marker text, no localhost/loopback or development-port URL in any html/js/css, no inline
#      <script> (the Content-Security-Policy allows none; JSON-LD data blocks are not scripts), no symbolic link or special file, no file
#      over 25 MB, total between 50 KB and 200 MB. A failure keeps the build in <id>.failed (root-only) and changes nothing
#   6. the copy becomes <site root>/releases/<id> with a REVISION record (site=<commit>, built=<time>, hours=<fetched|skipped|unavailable>),
#      owned by root, read-only for everyone (nginx reads it); the build tree (sources, node_modules) is removed. Root never writes into,
#      changes the mode of or renames anything in the build user's tree
#   7. current -> the new release (atomic). No nginx reload: it follows the link
#   8. health, through nginx on this host: https://<domain>/ answers 200 with the marker, https://www.<domain>/ answers 301 to the apex,
#      /api/v1/public/hours answers 200 (a warning only: the site works without live hours). Healthy: previous -> the release before.
#      Unhealthy: current -> the old release, previous unchanged, the new one becomes <id>.failed, exit 1
#   9. keeps SITE_KEEP releases (default 4) plus current and previous, and 2 failed builds
# --rollback: current -> previous (or --to ID), the same health check (exit 3 when it fails). --list: the releases.
# Run as root from the root-owned kit: sudo /usr/local/lib/oasis/deploy/scripts/site-deploy.sh. One at a time (a lock).
# SITE_HEALTH_CMD, SITE_HOURS_URL, OASIS_SITE_RUN_AS, OASIS_SITE_REAP_CMD, OASIS_CHOWN and OASIS_KIT_TRUST_UID replace the commands it
# calls, OASIS_SITE_BUILD_ENV_PASS names variables to pass into the build, OASIS_SITE_CHECK_ISOLATION=1 forces the isolation check (tests).
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
    if [[ "$r" == "$prev" ]]; then if [[ -n "$tag" ]]; then tag="$tag, previous"; else tag=" <- previous"; fi; fi
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
# the site root and its releases belong to root: the website build user builds inside <id>.partial/src only (ADR 0145)
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
  [[ "$target" != "$OLD" ]] || die "$(basename "$target") is already the current release (try --list, then --rollback --to <id>)"
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
BUILD_STARTED=0
REAPED=0
on_exit() {
  if ((BUILD_STARTED && !REAPED)); then site_reap || warn "processes of $SITE_USER may still be running: ps -u $SITE_USER"; fi
  if ((PART_ACTIVE)) && [[ "$DRY_RUN" != 1 && -d "$PART" ]]; then
    chmod 0700 "$PART" 2>/dev/null || true
    mv "$PART" "$REL.failed" 2>/dev/null && log "kept the unfinished build in $REL.failed for inspection (root only)"
  fi
}
trap on_exit EXIT
trap 'log "interrupted"; exit 130' INT TERM

# --- 3. the build user ----------------------------------------------------------------------------------------------------------------
# The site repository's dependencies run during the build. They run as oasis-site, which owns $PART/src and nothing else of this host
# that matters: not oasis (whose files hold the production secrets and which the metadata guard lets reach the instance role), not in
# its group, its own home. As root on a real host the build goes through runuser; OASIS_SITE_RUN_AS replaces that (the tests).
SITE_USER=$OASIS_SITE_USER
SITE_HOME=$OASIS_SITE_STATE
SITE_SEPARATE=0
if [[ -z "${OASIS_SITE_RUN_AS+x}" ]]; then
  if [[ "$(id -u)" == 0 && "$NO_SYSTEM" != 1 ]]; then
    OASIS_SITE_RUN_AS="runuser -u $SITE_USER --"
    SITE_SEPARATE=1
  else
    OASIS_SITE_RUN_AS=""
  fi
fi
as_site() {
  if [[ -n "$OASIS_SITE_RUN_AS" ]]; then
    # shellcheck disable=SC2086
    run $OASIS_SITE_RUN_AS "$@"
  else
    run "$@"
  fi
}
# as_site_read CMD...: as_site, also in a dry run (for the checks, which change nothing)
as_site_read() {
  if [[ -n "$OASIS_SITE_RUN_AS" ]]; then
    # shellcheck disable=SC2086
    $OASIS_SITE_RUN_AS "$@"
  else
    "$@"
  fi
}
# site_reap: no process of the build user outlives the build (a dependency could leave one behind to change the output after root
# looked at it, or the next build). Every process of that user is killed, until none is left.
site_reap() {
  REAPED=1
  if [[ -n "${OASIS_SITE_REAP_CMD:-}" ]]; then
    # shellcheck disable=SC2086
    $OASIS_SITE_REAP_CMD "$SITE_USER"
    return
  fi
  ((SITE_SEPARATE)) || return 0
  local i
  for ((i = 0; i < 50; i++)); do
    pgrep -U "$SITE_USER" >/dev/null 2>&1 || pgrep -u "$SITE_USER" >/dev/null 2>&1 || return 0
    pkill -KILL -U "$SITE_USER" 2>/dev/null || true
    pkill -KILL -u "$SITE_USER" 2>/dev/null || true
    sleep 0.2
  done
  return 1
}
if ((SITE_SEPARATE)); then
  site_uid=$(id -u "$SITE_USER" 2>/dev/null) || die "there is no user $SITE_USER, which builds the website: re-run install.sh with the same options as last time (--site-domain creates it)"
  [[ "$site_uid" != 0 && "$site_uid" != "$(id -u "$OASIS_USER" 2>/dev/null || echo -1)" ]] || die "$SITE_USER must be its own unprivileged user, not root or $OASIS_USER"
  if [[ " $(id -nG "$SITE_USER") " == *" $OASIS_USER "* ]]; then
    die "$SITE_USER is in the group $OASIS_USER, which can read /etc/oasis: sudo gpasswd -d $SITE_USER $OASIS_USER"
  fi
  [[ -d "$SITE_HOME" ]] || die "$SITE_HOME (the home of $SITE_USER) is missing: re-run install.sh with the same options as last time"
  have pgrep && have pkill || die "pgrep/pkill are missing (dnf install procps-ng): the build user's processes could not be stopped after the build"
else
  site_uid=$(id -u)
fi
# The isolation check: the build user must not be able to read the app's configuration files or enter its state and backups.
if ((SITE_SEPARATE)) || [[ "${OASIS_SITE_CHECK_ISOLATION:-0}" == 1 ]]; then
  guarded=()
  while IFS= read -r f; do guarded+=("$f"); done < <(find "$OASIS_ETC" -maxdepth 1 -type f \( -name '*.env' -o -name '*.env.bak-*' -o -name '*.key' -o -name "$AWS_CREDENTIALS_FILE_NAME" \) ! -name site.env 2>/dev/null | sort)
  guarded+=("$OASIS_STATE" "$OASIS_BACKUP_DIR")
  # shellcheck disable=SC2016
  exposed=$(as_site_read bash -c 'for p; do if { [ -f "$p" ] && [ -r "$p" ]; } || { [ -d "$p" ] && [ -x "$p" ]; }; then printf "%s\n" "$p"; fi; done' _ "${guarded[@]}") ||
    die "could not run a command as $SITE_USER"
  [[ -z "$exposed" ]] || die "the website build user $SITE_USER can read (or enter) $(tr '\n' ' ' <<<"$exposed")and must not: its builds run third-party code. Re-run install.sh --site-domain with the same options as last time; /etc/oasis must be 0750 root:$OASIS_USER, /var/lib/oasis 0750 and $SITE_USER outside the group $OASIS_USER"
fi

# --- 4. export and build as the build user ------------------------------------------------------------------------------------------
if [[ "$DRY_RUN" == 1 ]]; then
  log "would export ${SHA:0:12} into $PART/src, fetch the hours snapshot, build as $SITE_USER (pnpm install --frozen-lockfile && pnpm build), stop its processes, copy and verify $SITE_BUILD_DIR/, make the copy $REL and point $SITE_ROOT/current at it, then health-check https://$SITE_DOMAIN/"
  exit 0
fi
# $PART is root's (the build user cannot create, replace or rename anything in it); only $PART/src is handed over
mkdir -m 0755 "$PART"
PART_ACTIVE=1
root_own root:root "$PART"
mkdir -m 0755 "$PART/src"
root_own "$SITE_USER:$SITE_USER" "$PART/src"
mirror_git archive "$SHA" | as_site tar -x -C "$PART/src"

# the hours snapshot: the API on this host (api.env's PORT), so the first paint shows today's hours even before the browser asks.
# Written by root into the root-owned $PART, readable by the build.
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

log "building the website as $SITE_USER"
# nothing of root's environment reaches the build (an AWS identity, the secret's name ...): only what the build contract names
build_env=(-i "PATH=$PATH" "HOME=$SITE_HOME" CI=1 NODE_OPTIONS=--max-old-space-size=2048 "SITE_URL=https://$SITE_DOMAIN")
for v in LANG LC_ALL TZ HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy ${OASIS_SITE_BUILD_ENV_PASS:-}; do
  [[ "$v" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "OASIS_SITE_BUILD_ENV_PASS: $v is not a variable name"
  [[ -z "${!v+x}" ]] || build_env+=("$v=${!v}")
done
[[ "$HOURS" != fetched ]] || build_env+=("SITE_HOURS_JSON=$HOURS_FILE")
BUILD_STARTED=1
build_rc=0
as_site env "${build_env[@]}" bash -c 'cd "$1" && pnpm install --frozen-lockfile && pnpm build' _ "$PART/src" || build_rc=$?
# from here on nothing of the build user runs, and nothing new can reach the build tree: $PART is root's and becomes 0700
site_reap || die "processes of $SITE_USER are still running after the build (ps -u $SITE_USER); nothing was changed. The build is kept in $REL.failed"
chmod 0700 "$PART"
((build_rc == 0)) || die "the website build failed; nothing was changed. The build is kept in $REL.failed for inspection"

# --- 5. copy the output out of the build tree, then verify the copy ----------------------------------------------------------------------
# Root reads the build tree but never writes into it, changes a mode in it or follows a link in it: cp -R -P copies a symbolic link as
# a link (refused below), and the copy is a fresh directory inside the root-only $PART.
BUILT="$PART/src/$SITE_BUILD_DIR"
STAGE="$PART/release"
take_problems=()
if [[ -L "$BUILT" || ! -d "$BUILT" ]]; then
  take_problems+=("no $SITE_BUILD_DIR/ directory")
else
  hits=$(find "$BUILT" -type f -links +1 -print -quit)
  [[ -z "$hits" ]] || take_problems+=("hard link in the output: $hits")
  hits=$(find "$BUILT" ! -uid "$site_uid" -print -quit)
  [[ -z "$hits" ]] || take_problems+=("a file the build did not create (not owned by $SITE_USER): $hits")
  hits=$(find "$BUILT" ! -type f ! -type d ! -type l -print -quit)
  [[ -z "$hits" ]] || take_problems+=("not a regular file or directory: $hits")
  # the size bound before the copy too (apparent size: a sparse file counts in full), so the copy cannot fill the disk
  total=$(du -sb "$BUILT" | cut -f1)
  ((total <= 200 * 1024 * 1024)) || take_problems+=("total size ${total} bytes is above 200 MB")
fi
if ((${#take_problems[@]} == 0)); then
  cp -R -P --preserve=timestamps -- "$BUILT" "$STAGE" || take_problems+=("copying $SITE_BUILD_DIR/ failed")
fi
if ((${#take_problems[@]})); then
  die "the build's $SITE_BUILD_DIR/ is not a deployable site:
$(printf '  - %s\n' "${take_problems[@]}")
Nothing was changed; the build is kept in $REL.failed for inspection"
fi

verify_dist() {
  local d=$1 problems=() total big
  [[ -d "$d" ]] || { problems+=("no $SITE_BUILD_DIR/ directory"); printf '%s\n' "${problems[@]}"; return 1; }
  [[ -f "$d/index.html" ]] || problems+=("index.html is missing")
  [[ -f "$d/404.html" ]] || problems+=("404.html is missing")
  if [[ -f "$d/index.html" ]]; then
    (($(stat -c %s "$d/index.html") > 1024)) || problems+=("index.html is smaller than 1 KB")
    [[ -z "$SITE_MARKER" ]] || grep -qF -- "$SITE_MARKER" "$d/index.html" || problems+=("index.html does not contain the marker text '$SITE_MARKER'")
  fi
  local hits
  # development addresses and ports in anything the browser runs: a build that kept its local API origin would break on the host
  hits=$(grep -rElI --include='*.html' --include='*.js' --include='*.mjs' --include='*.css' -e 'localhost' -e '127\.0\.0\.1' -e '0\.0\.0\.0' -e '//[A-Za-z0-9.-]+:(3000|4000|4321)([^0-9]|$)' "$d" 2>/dev/null | head -n 5 || true)
  [[ -z "$hits" ]] || problems+=("development address or port (localhost, 127.0.0.1, 0.0.0.0, :3000, :4000, :4321) in: $(tr '\n' ' ' <<<"$hits")")
  # every <script> must come from a file (the policy allows no inline script); a JSON-LD data block is not a script
  hits=$(grep -rhoI --include='*.html' -e '<script[^>]*>' "$d" 2>/dev/null | grep -Ev 'src=|type="application/ld\+json"' | head -n 3 || true)
  [[ -z "$hits" ]] || problems+=("inline <script> in the HTML (the Content-Security-Policy allows none): $(tr '\n' ' ' <<<"$hits")")
  hits=$(find "$d" -type l -print -quit)
  [[ -z "$hits" ]] || problems+=("symbolic link in the output: $hits")
  hits=$(find "$d" ! -type f ! -type d ! -type l -print -quit)
  [[ -z "$hits" ]] || problems+=("not a regular file or directory: $hits")
  big=$(find "$d" -type f -size +25M -print -quit)
  [[ -z "$big" ]] || problems+=("file over 25 MB: $big")
  total=$(du -sb "$d" | cut -f1)
  ((total >= 50 * 1024)) || problems+=("total size ${total} bytes is below 50 KB")
  ((total <= 200 * 1024 * 1024)) || problems+=("total size ${total} bytes is above 200 MB")
  ((${#problems[@]} == 0)) || { printf '%s\n' "${problems[@]}"; return 1; }
}
if ! problems=$(verify_dist "$STAGE"); then
  die "the build's $SITE_BUILD_DIR/ is not a deployable site:
$(sed 's/^/  - /' <<<"$problems")
Nothing was changed; the build is kept in $REL.failed for inspection"
fi
ok "verified $SITE_BUILD_DIR/ ($(du -sh "$STAGE" | cut -f1), $(find "$STAGE" -type f | wc -l) files)"

# --- 6. the release: root-owned, read-only, world-readable; the build tree is not kept ----------------------------------------------------
# (the copy holds only directories and regular files, checked above: nothing here can lead outside it)
printf 'site=%s\nbuilt=%s\nhours=%s\n' "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$HOURS" >"$STAGE/REVISION"
find "$STAGE" -type d -exec chmod 0755 {} +
find "$STAGE" -type f -exec chmod 0644 {} +
mv -T "$STAGE" "$REL"
PART_ACTIVE=0
rm -rf -- "$PART"
root_own -R root:root "$REL"

# --- 7. switch (no nginx reload: it reads through the link) and health ------------------------------------------------------------------
# previous moves only once the new release is healthy: a release that is switched back leaves previous where it was, so --rollback
# still goes to the release before
site_link current "$REL"
if site_health; then
  [[ -z "$OLD" ]] || site_link previous "$OLD"
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

# --- 8. housekeeping -------------------------------------------------------------------------------------------------------------------
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
