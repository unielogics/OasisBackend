#!/usr/bin/env bash
# Release handling shared by deploy.sh and rollback.sh. Source after common.sh; do not run it.
#
# Layout under $OASIS_PREFIX (default /opt/oasis):
#   src/backend, src/dashboard   git clones of the two repositories (origin = GitHub); deploy.sh fetches into them
#   releases/<id>/backend        one built release: source (git archive), node_modules, dist/
#   releases/<id>/dashboard      the dashboard build (.next-live)
#   releases/<id>/REVISIONS      the two commit hashes
#   current -> releases/<id>     what the systemd units run
#   previous -> releases/<id>    the release before it (rollback.sh switches back to it)
# shellcheck shell=bash

SYSTEMCTL="${SYSTEMCTL:-systemctl}"
SERVICES=(oasis-worker oasis-api oasis-web)

if [[ -z "${OASIS_RUN_AS+x}" ]]; then
  if [[ "$(id -u)" == 0 && "$NO_SYSTEM" != 1 ]]; then OASIS_RUN_AS="runuser -u $OASIS_USER --"; else OASIS_RUN_AS=""; fi
fi

# as_oasis CMD...: run as the service user (builds and migrations never run as root).
as_oasis() {
  if [[ -n "$OASIS_RUN_AS" ]]; then
    # shellcheck disable=SC2086
    run $OASIS_RUN_AS "$@"
  else
    run "$@"
  fi
}

# oasis_read CMD...: like as_oasis but also runs in a dry run (for commands that only read, such as git rev-parse).
# Git refuses a repository owned by another user ("dubious ownership"), so even reads happen as the service user.
oasis_read() {
  if [[ -n "$OASIS_RUN_AS" ]]; then
    # shellcheck disable=SC2086
    $OASIS_RUN_AS "$@"
  else
    "$@"
  fi
}

# as_oasis_aws CMD...: as_oasis, with the app's AWS identity (to read the environment secret, to upload a backup). runtime=role: the
# instance provides it. runtime=user: the key file is root-only (systemd hands it to the services itself), so when root runs a command
# as the service user, that user gets a private copy for this one command, removed afterwards.
as_oasis_aws() {
  local cred tmp rc=0
  cred=$(aws_credentials_file)
  if [[ ! -e "$cred" || -n "${AWS_SHARED_CREDENTIALS_FILE:-}" ]]; then
    as_oasis "$@"
    return
  fi
  if [[ -z "$OASIS_RUN_AS" || "$DRY_RUN" == 1 ]]; then
    as_oasis env AWS_SHARED_CREDENTIALS_FILE="$cred" AWS_EC2_METADATA_DISABLED=true "$@"
    return
  fi
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/oasis-aws.XXXXXX")
  install -m 0400 -o "$OASIS_USER" -g "$OASIS_USER" "$cred" "$tmp/credentials"
  chown "$OASIS_USER" "$tmp"
  chmod 0500 "$tmp"
  as_oasis env AWS_SHARED_CREDENTIALS_FILE="$tmp/credentials" AWS_EC2_METADATA_DISABLED=true "$@" || rc=$?
  rm -rf "$tmp"
  return "$rc"
}

# in_release_env DIR CMD...: run CMD in DIR with the API's environment files loaded. Secret settings (DATABASE_URL and friends) come
# from the secret named by OASIS_SECRET_ID in common.env: every program of the release reads it itself (src/config/secrets-source.ts).
in_release_env() {
  local dir=$1
  shift
  # HOME: runuser keeps root's, which the service user cannot write (pnpm wants a cache directory)
  as_oasis_aws env HOME="$OASIS_STATE" bash -c 'set -a; . "$1"; . "$2"; set +a; cd "$3" && shift 3 && exec "$@"' _ "$OASIS_ETC/common.env" "$OASIS_ETC/api.env" "$dir" "$@"
}

# readlink -e: empty (not the link path itself) when the link does not exist yet
current_release() { readlink -e "$OASIS_PREFIX/current" 2>/dev/null || true; }
previous_release() { readlink -e "$OASIS_PREFIX/previous" 2>/dev/null || true; }

# point_symlink NAME TARGET: atomic replace of $OASIS_PREFIX/NAME
point_symlink() {
  local name=$1 target=$2
  run ln -sfn "$target" "$OASIS_PREFIX/$name.new"
  run mv -T "$OASIS_PREFIX/$name.new" "$OASIS_PREFIX/$name"
}

restart_services() {
  local s
  for s in "${SERVICES[@]}"; do
    log "restarting $s"
    run_system "$SYSTEMCTL" restart "$s.service" || return 1
  done
}

stop_services() {
  local s
  for s in "${SERVICES[@]}"; do run_system "$SYSTEMCTL" stop "$s.service" || true; done
}

# health_gate SECONDS: the stack must answer (healthcheck.sh) within SECONDS.
health_gate() {
  local wait=${1:-90}
  if [[ "$DRY_RUN" == 1 ]]; then
    log "would wait up to ${wait}s for ${HEALTH_CMD:-healthcheck.sh}"
    return 0
  fi
  # shellcheck disable=SC2086
  ${HEALTH_CMD:-$OASIS_HERE/healthcheck.sh} --wait "$wait" || return 1
  services_stayed_up
}

# services_stayed_up: every service is still active and systemd has not restarted it since the deploy did. A worker that exits at
# start does not make the API unready (by design), so healthcheck.sh alone would call a crash-looping worker healthy.
services_stayed_up() {
  [[ "$NO_SYSTEM" == 1 ]] && return 0
  local s n state
  for s in "${SERVICES[@]}"; do
    state=$("$SYSTEMCTL" is-active "$s.service" 2>/dev/null) || true
    n=$("$SYSTEMCTL" show -p NRestarts --value "$s.service" 2>/dev/null) || n=""
    if [[ -n "$state" && "$state" != active ]] || [[ -n "$n" && "$n" != 0 ]]; then
      warn "$s did not stay up after the restart (state ${state:-unknown}, restarted ${n:-?} times by systemd): journalctl -u $s"
      return 1
    fi
  done
}

release_ok() {
  local rel=$1
  [[ -f "$rel/backend/dist/server.js" && -f "$rel/backend/dist/worker.js" && -d "$rel/dashboard/.next-live" ]]
}

list_releases() {
  [[ -d "$OASIS_PREFIX/releases" ]] || return 0
  find "$OASIS_PREFIX/releases" -mindepth 1 -maxdepth 1 -type d -not -name '*.failed' -not -name '*.partial' | sort
}

# record_deploy ID RESULT: one line in deploys.list (not in a dry run)
record_deploy() {
  [[ "$DRY_RUN" == 1 ]] && return 0
  printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$1" "$2" >>"$OASIS_LOG_DIR/deploys.list" 2>/dev/null || true
}

# releases_newest_first: by build time (REVISIONS is written last, fractional seconds), not by name: two builds in one second would
# otherwise sort by commit hash.
releases_newest_first() {
  [[ -d "$OASIS_PREFIX/releases" ]] || return 0
  find "$OASIS_PREFIX/releases" -mindepth 2 -maxdepth 2 -name REVISIONS -printf '%T@ %h\n' |
    sort -rn | cut -d' ' -f2- | grep -v -E '\.(failed|partial)$' || true
}

# trusted_kit_origin: the backend clone's origin when it is a local repository that only root can change (the production host's
# mirrors in /opt/oasis/git, published by the operator): every file owned by root (OASIS_KIT_TRUST_UID, tests) and nothing writable
# by group or others. Empty for GitHub, or a mirror the oasis user owns.
trusted_kit_origin() {
  local url uid=${OASIS_KIT_TRUST_UID:-0}
  url=$(oasis_read git -C "$OASIS_PREFIX/src/backend" config --get remote.origin.url 2>/dev/null) || return 0
  url=${url#file://}
  [[ "$url" == /* && -d "$url" ]] || return 0
  [[ -z "$(find "$url" \( ! -uid "$uid" -o \( ! -type l -perm /022 \) \) -print -quit 2>/dev/null)" ]] || return 0
  printf '%s' "$url"
}

# verify_kit REL SHA: the deploy kit inside the built release (which root will copy and run) must be exactly the commit's deploy/
# as the trusted mirror has it, read by root. A build step running as oasis could otherwise have changed it. Exit 1 on a
# difference; 0 when it matches, or when there is no trusted mirror to compare with (KIT_VERIFIED=0, said in the log).
# shellcheck disable=SC2034 # read by deploy.sh
KIT_VERIFIED=0
verify_kit() {
  local rel=$1 sha=$2 origin tmp rc=0
  origin=$(trusted_kit_origin)
  if [[ -z "$origin" ]]; then
    KIT_VERIFIED=0
    log "the backend origin is not a root-owned local mirror: the release's deploy kit is not cross-checked (docs/deployment.md, \"Privilege separation\")"
    return 0
  fi
  tmp=$(mktemp -d)
  mkdir -p "$tmp/from-mirror"
  if git -c safe.directory="$origin" -C "$origin" cat-file -e "$sha^{commit}" 2>/dev/null; then
    if git -c safe.directory="$origin" -C "$origin" ls-tree -d --name-only "$sha" deploy | grep -qx deploy; then
      git -c safe.directory="$origin" -C "$origin" archive "$sha" deploy | tar -x -C "$tmp/from-mirror" || rc=1
    fi
    if ((rc == 0)); then
      if [[ -d "$tmp/from-mirror/deploy" || -e "$rel/backend/deploy" ]]; then
        diff -r --no-dereference "$tmp/from-mirror/deploy" "$rel/backend/deploy" >"$tmp/diff" 2>&1 || rc=1
        ((rc == 0)) || warn "$(head -n 5 "$tmp/diff")"
      fi
    fi
  else
    warn "commit $sha is not in the mirror $origin"
    rc=1
  fi
  rm -rf "$tmp"
  # shellcheck disable=SC2034 # read by deploy.sh
  KIT_VERIFIED=$((rc == 0 ? 1 : 0))
  return "$rc"
}
