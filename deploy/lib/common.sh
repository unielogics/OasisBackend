#!/usr/bin/env bash
# Shared helpers for the deploy scripts. Source it; do not run it.
#
# Every absolute path can be moved under OASIS_ROOT_PREFIX (a staging directory), which is how the scripts are tested without
# touching the machine they run on. In production the prefix is empty.
# shellcheck shell=bash

shopt -u patsub_replacement 2>/dev/null || true # bash 5.2 would otherwise treat "&" in a replacement string specially

OASIS_ROOT_PREFIX="${OASIS_ROOT_PREFIX:-}"
OASIS_USER="${OASIS_USER:-oasis}"
OASIS_PREFIX="${OASIS_PREFIX:-${OASIS_ROOT_PREFIX}/opt/oasis}"
OASIS_ETC="${OASIS_ETC:-${OASIS_ROOT_PREFIX}/etc/oasis}"
OASIS_STATE="${OASIS_STATE:-${OASIS_ROOT_PREFIX}/var/lib/oasis}"
OASIS_BACKUP_DIR="${OASIS_BACKUP_DIR:-${OASIS_ROOT_PREFIX}/var/backups/oasis}"
OASIS_LOG_DIR="${OASIS_LOG_DIR:-${OASIS_ROOT_PREFIX}/var/log/oasis}"
SYSTEMD_DIR="${SYSTEMD_DIR:-${OASIS_ROOT_PREFIX}/etc/systemd/system}"
JOURNALD_DIR="${JOURNALD_DIR:-${OASIS_ROOT_PREFIX}/etc/systemd/journald.conf.d}"
NGINX_DIR="${NGINX_DIR:-${OASIS_ROOT_PREFIX}/etc/nginx}"
LOGROTATE_DIR="${LOGROTATE_DIR:-${OASIS_ROOT_PREFIX}/etc/logrotate.d}"
# The deploy kit root runs: a root-owned copy of deploy/ that the oasis user cannot change (install.sh puts it there, deploy.sh
# refreshes it from each verified release). Root never executes a file the oasis user can write (docs/deployment.md, ADR 0140).
OASIS_KIT_DIR="${OASIS_KIT_DIR:-${OASIS_ROOT_PREFIX}/usr/local/lib/oasis/deploy}"
# Where the dashboard's Next.js cache really lives (the release is read-only; its .next-live/cache is a symlink to this). A path on the
# running system, not under OASIS_ROOT_PREFIX: systemd creates it for oasis-web (CacheDirectory=oasis-web).
OASIS_WEB_CACHE="${OASIS_WEB_CACHE:-/var/cache/oasis-web}"
DRY_RUN="${DRY_RUN:-0}"
# Set to 1 to skip everything that changes the host itself (users, packages, chown, systemctl, nginx reloads).
NO_SYSTEM="${NO_SYSTEM:-0}"

if [[ -t 1 ]]; then
  C_RED=$'\033[31m' C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_OFF=$'\033[0m'
else
  C_RED='' C_GREEN='' C_YELLOW='' C_OFF=''
fi

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
ok() { printf '%s %sok%s   %s\n' "$(date -u +%H:%M:%S)" "$C_GREEN" "$C_OFF" "$*"; }
changed() {
  local label='done'
  [[ "$DRY_RUN" == 1 ]] && label=plan
  printf '%s %s%s%s %s\n' "$(date -u +%H:%M:%S)" "$C_GREEN" "$label" "$C_OFF" "$*"
}
warn() { printf '%s %swarn%s %s\n' "$(date -u +%H:%M:%S)" "$C_YELLOW" "$C_OFF" "$*" >&2; }
die() {
  printf '%serror%s %s\n' "$C_RED" "$C_OFF" "$*" >&2
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

# Prints the command instead of running it in dry-run mode.
run() {
  if [[ "$DRY_RUN" == 1 ]]; then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

# Like run, but for steps that change the host itself: also skipped with NO_SYSTEM=1.
run_system() {
  if [[ "$NO_SYSTEM" == 1 ]]; then
    printf 'skip (NO_SYSTEM)'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  run "$@"
}

need_root() {
  [[ "$DRY_RUN" == 1 || "$NO_SYSTEM" == 1 || "${OASIS_ALLOW_NONROOT:-0}" == 1 || "$(id -u)" == 0 ]] || die "run as root (sudo $0 ...)"
}

# env_get FILE NAME: the value of NAME= in an env file, without executing the file. Surrounding quotes are removed.
env_get() {
  local file=$1 name=$2 line value
  [[ -r "$file" ]] || return 1
  line=$(grep -E "^${name}=" "$file" | tail -n 1) || return 1
  value=${line#*=}
  value=${value%"${value##*[![:space:]]}"}
  if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then value=${value:1:${#value}-2}; fi
  printf '%s' "$value"
}

urldecode() {
  local s=$1
  printf '%b' "${s//%/\\x}"
}

# use_pg_client: a PostgreSQL client newer than the host's packages (Aurora PostgreSQL 17 from an AL2023 host whose postgresql15
# packages conflict with postgresql17): PG_BINDIR=/opt/oasis/pgclient/17/usr/bin (from the environment or common.env), with its
# private libpq in ../lib64, goes first on the PATH, so psql, pg_dump and pg_restore are that version. Run outside systemd too
# (deploy.sh calls backup.sh directly), hence the common.env lookup.
use_pg_client() {
  local dir=${PG_BINDIR:-}
  [[ -n "$dir" ]] || dir=$(env_get "$OASIS_ETC/common.env" PG_BINDIR 2>/dev/null) || dir=""
  [[ -n "$dir" ]] || return 0
  PG_BINDIR=$dir
  PATH="$dir:$PATH"
  if [[ -d "$dir/../lib64" ]]; then
    LD_LIBRARY_PATH="$(cd "$dir/../lib64" && pwd)${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    export LD_LIBRARY_PATH
  fi
  export PATH PG_BINDIR
}

# url_to_pgenv URL: exports PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE (and PGSSLMODE) so pg tools never see the password on a command line.
url_to_pgenv() {
  local url=$1
  local re='^postgres(ql)?://([^:@/]+)(:([^@]*))?@([^:/?]+)(:([0-9]+))?/([^?]+)(\?(.*))?$'
  [[ "$url" =~ $re ]] || die "DATABASE_URL is not postgres://user:password@host:port/database"
  PGUSER=$(urldecode "${BASH_REMATCH[2]}")
  PGPASSWORD=$(urldecode "${BASH_REMATCH[4]}")
  PGHOST=${BASH_REMATCH[5]}
  PGPORT=${BASH_REMATCH[7]:-5432}
  PGDATABASE=$(urldecode "${BASH_REMATCH[8]}")
  export PGUSER PGPASSWORD PGHOST PGPORT PGDATABASE
  local q=${BASH_REMATCH[10]:-} kv
  # the TLS settings travel too (Aurora/RDS: sslmode=verify-full&sslrootcert=/etc/oasis/rds-global-bundle.pem); without
  # sslrootcert libpq looks for ~/.postgresql/root.crt and refuses to connect
  for kv in ${q//&/ }; do
    case $kv in
      sslmode=*) PGSSLMODE=$(urldecode "${kv#sslmode=}") && export PGSSLMODE ;;
      sslrootcert=*) PGSSLROOTCERT=$(urldecode "${kv#sslrootcert=}") && export PGSSLROOTCERT ;;
      sslcert=*) PGSSLCERT=$(urldecode "${kv#sslcert=}") && export PGSSLCERT ;;
      sslkey=*) PGSSLKEY=$(urldecode "${kv#sslkey=}") && export PGSSLKEY ;;
    esac
  done
  return 0
}

# render_template TEMPLATE KEY=value ...: replaces @KEY@ and fails when a placeholder is left over.
render_template() {
  local src=$1
  shift
  [[ -r "$src" ]] || die "template $src not found"
  local content pair key value left
  content=$(<"$src")
  for pair in "$@"; do
    key=${pair%%=*}
    value=${pair#*=}
    content=${content//"@${key}@"/"$value"}
  done
  left=$(grep -oE '@[A-Z][A-Z0-9_]*@' <<<"$content" | sort -u | tr '\n' ' ' || true)
  [[ -z "$left" ]] || die "$src has placeholders without a value: $left"
  printf '%s\n' "$content"
}

# install_content DEST MODE OWNER:GROUP < content   (idempotent: only touches the file when the content differs)
install_content() {
  local dest=$1 mode=$2 owner=$3 tmp
  tmp=$(mktemp)
  cat >"$tmp"
  if [[ -f "$dest" ]] && cmp -s "$tmp" "$dest"; then
    rm -f "$tmp"
    ok "$dest unchanged"
    return 0
  fi
  if [[ "$DRY_RUN" == 1 ]]; then
    changed "would write $dest ($mode $owner)"
    rm -f "$tmp"
    return 0
  fi
  mkdir -p "$(dirname "$dest")"
  install -m "$mode" "$tmp" "$dest"
  rm -f "$tmp"
  if [[ "$NO_SYSTEM" != 1 ]]; then chown "$owner" "$dest"; fi
  changed "wrote $dest"
}

ensure_dir() {
  local dir=$1 mode=$2 owner=$3
  if [[ -d "$dir" ]]; then
    ok "$dir exists"
  else
    run mkdir -p "$dir"
    changed "created $dir"
  fi
  run chmod "$mode" "$dir"
  if [[ "$NO_SYSTEM" != 1 ]]; then run chown "$owner" "$dir"; fi
}

# random_b64 BYTES / random_hex BYTES
random_b64() { openssl rand -base64 "$1" | tr -d '\n'; }
random_hex() { openssl rand -hex "$1" | tr -d '\n'; }

# sha256 of a file, hex only
sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

# keep_newest DIR PATTERN COUNT: removes everything matching PATTERN in DIR except the COUNT newest (names sort chronologically).
keep_newest() {
  local dir=$1 pattern=$2 keep=$3 f i=0
  [[ -d "$dir" ]] || return 0
  # newest first
  while IFS= read -r f; do
    i=$((i + 1))
    if ((i > keep)); then
      run rm -f -- "$f" "$f.manifest.json" "$f.sha256" "$f.enc" "$f.enc.sha256"
      log "pruned $(basename "$f")"
    fi
  done < <(find "$dir" -maxdepth 1 -type f -name "$pattern" | sort -r)
}

# set_var NAME VALUE < content > content : replaces the first NAME= line (filter for env-file text)
set_var() {
  awk -v n="$1" -v v="$2" 'BEGIN { FS = OFS = "=" } $1 == n && !done { print n "=" v; done = 1; next } { print }'
}

# names_in FILE: every variable named in an env file, active or commented out
names_in() { grep -oE '^#? ?[A-Z][A-Z0-9_]*=' "$1" | tr -d '# =' | sort -u; }

# env_file_set FILE NAME VALUE: rewrites one variable of an env file in place (atomic, keeps mode and owner, leaves FILE.bak-<time>)
env_file_set() {
  local file=$1 name=$2 value=$3 tmp stamp
  [[ -f "$file" ]] || die "$file does not exist"
  if [[ "$DRY_RUN" == 1 ]]; then
    log "would set $name in $file"
    return 0
  fi
  stamp=$(date -u +%Y%m%d%H%M%S)
  cp -p "$file" "$file.bak-$stamp"
  tmp=$(mktemp "$file.XXXXXX")
  if grep -q "^${name}=" "$file"; then
    set_var "$name" "$value" <"$file" >"$tmp"
  else
    { cat "$file"; printf '%s=%s\n' "$name" "$value"; } >"$tmp"
  fi
  chmod --reference="$file" "$tmp"
  chown --reference="$file" "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$file"
}

# env_file_unset FILE NAME: removes every NAME= line (atomic, keeps mode, leaves FILE.bak-<time>)
env_file_unset() {
  local file=$1 name=$2 tmp stamp
  [[ -f "$file" ]] || die "$file does not exist"
  if [[ "$DRY_RUN" == 1 ]]; then
    log "would remove $name from $file"
    return 0
  fi
  grep -q "^${name}=" "$file" || return 0
  stamp=$(date -u +%Y%m%d%H%M%S)
  cp -p "$file" "$file.bak-$stamp"
  tmp=$(mktemp "$file.XXXXXX")
  grep -v "^${name}=" "$file" >"$tmp" || true
  chmod --reference="$file" "$tmp"
  chown --reference="$file" "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$file"
}

# --- the application environment in AWS Secrets Manager (docs/deployment.md, ADR 0130) ---------------------------------------
# /etc/oasis/common.env names the secret (OASIS_SECRET_ID) and its region (AWS_REGION); the secret holds these keys. The list is the
# same as SECRET_KEYS in src/config/secrets-source.ts (a test holds them together).
# shellcheck disable=SC2034 # used by install.sh
OASIS_SECRET_KEYS=(DATABASE_URL SESSION_SECRET SECRETS_KEY STORAGE_SIGNING_SECRET BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_PASSWORD SQSP_API_KEY SQSP_WEBHOOK_SECRET SMSGATE_PASSWORD SMSGATE_WEBHOOK_SECRET)
# The backend whose node_modules the kit borrows (scripts/secret-env.ts and friends): the checkout this kit sits in, or, for the
# root-owned copy (no package.json above it), the current release.
if [[ -z "${OASIS_BACKEND_DIR:-}" ]]; then
  OASIS_BACKEND_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
  [[ -f "$OASIS_BACKEND_DIR/package.json" ]] || OASIS_BACKEND_DIR="$OASIS_PREFIX/current/backend"
fi

# secret_id: OASIS_SECRET_ID from the environment or common.env; empty when this host keeps its secrets in the env files.
secret_id() {
  local v=${OASIS_SECRET_ID:-}
  [[ -n "$v" ]] || v=$(env_get "$OASIS_ETC/common.env" OASIS_SECRET_ID 2>/dev/null) || v=""
  printf '%s' "$v"
}

# aws_region: AWS_REGION from the environment or common.env.
aws_region() {
  local v=${AWS_REGION:-}
  [[ -n "$v" ]] || v=$(env_get "$OASIS_ETC/common.env" AWS_REGION 2>/dev/null) || v=""
  printf '%s' "$v"
}

# The app's AWS identity for a command the kit runs itself. runtime=user ($OASIS_ETC/aws-credentials exists): the SDK reads that file
# (the systemd units get it through LoadCredential and set AWS_SHARED_CREDENTIALS_FILE themselves); runtime=role: the instance.
AWS_CREDENTIALS_FILE_NAME=aws-credentials
aws_credentials_file() { printf '%s' "$OASIS_ETC/$AWS_CREDENTIALS_FILE_NAME"; }

# use_app_aws_identity: for the aws CLI in this shell: with runtime=user and the key file readable (root), point the CLI at it.
use_app_aws_identity() {
  local cred
  cred=$(aws_credentials_file)
  if [[ -z "${AWS_SHARED_CREDENTIALS_FILE:-}" && -r "$cred" ]]; then
    export AWS_SHARED_CREDENTIALS_FILE="$cred" AWS_EC2_METADATA_DISABLED=true
  fi
  return 0
}

# secret_env ARGS...: runs scripts/secret-env.ts (the app's own loader) with the secret's id and region and the app's AWS identity.
# OASIS_SECRET_ENV_CMD replaces it (tests). Never prints a value except on stdout for --get, which callers capture.
secret_env() {
  local sid region cred
  sid=$(secret_id)
  region=$(aws_region)
  [[ -n "$sid" ]] || die "OASIS_SECRET_ID is not set in $OASIS_ETC/common.env"
  local envs=(OASIS_SECRET_ID="$sid" AWS_REGION="$region")
  cred=$(aws_credentials_file)
  if [[ -z "${AWS_SHARED_CREDENTIALS_FILE:-}" && -e "$cred" ]]; then
    [[ -r "$cred" ]] || die "$cred exists but this user cannot read it: run as root, or through the systemd unit (which hands it over)"
    envs+=(AWS_SHARED_CREDENTIALS_FILE="$cred" AWS_EC2_METADATA_DISABLED=true)
  fi
  if [[ -n "${OASIS_SECRET_ENV_CMD:-}" ]]; then
    # shellcheck disable=SC2086
    env "${envs[@]}" $OASIS_SECRET_ENV_CMD "$@"
  else
    [[ -x "$OASIS_BACKEND_DIR/node_modules/.bin/tsx" ]] || die "$OASIS_BACKEND_DIR has no node_modules (run from a deployed release)"
    env "${envs[@]}" "$OASIS_BACKEND_DIR/node_modules/.bin/tsx" "$OASIS_BACKEND_DIR/scripts/secret-env.ts" "$@"
  fi
}

# config_value NAME: NAME as the app sees it: the process environment, else common.env (a non-empty line wins over the secret, as in
# the app), else the secret. Prints the value (capture it; never echo it). Exit 1 when NAME is set nowhere.
config_value() {
  local name=$1 v
  v=${!name:-}
  if [[ -n "$v" ]]; then printf '%s' "$v"; return 0; fi
  v=$(env_get "$OASIS_ETC/common.env" "$name" 2>/dev/null) || v=""
  if [[ -n "$v" ]]; then printf '%s' "$v"; return 0; fi
  [[ -n "$(secret_id)" ]] || return 1
  secret_env --get "$name"
}

# secrets_push ARGS...: pnpm secrets:push from this release, as the operator (root's AWS profile, never the instance role).
# OASIS_SECRETS_PUSH_CMD replaces it (tests).
secrets_push() {
  if [[ -n "${OASIS_SECRETS_PUSH_CMD:-}" ]]; then
    # shellcheck disable=SC2086
    $OASIS_SECRETS_PUSH_CMD "$@"
  else
    [[ -x "$OASIS_BACKEND_DIR/node_modules/.bin/tsx" ]] || die "$OASIS_BACKEND_DIR has no node_modules (run from a deployed release)"
    "$OASIS_BACKEND_DIR/node_modules/.bin/tsx" "$OASIS_BACKEND_DIR/scripts/secrets-push.ts" "$@"
  fi
}

# --- privilege separation (ADR 0140) -----------------------------------------------------------------------------------------------
# root_own [-R] OWNER PATH...: chown without following symbolic links (-h), so a link the oasis user planted in a tree it built can
# never hand it a file outside that tree. Only as root on a real system; OASIS_CHOWN replaces chown (tests record the call).
root_own() {
  if [[ -n "${OASIS_CHOWN:-}" ]]; then
    # shellcheck disable=SC2086
    $OASIS_CHOWN -h "$@"
  elif [[ "$(id -u)" == 0 && "$NO_SYSTEM" != 1 ]]; then
    chown -h "$@"
  fi
}

# lock_release DIR: a built release becomes root:oasis and read-only for everyone but root (chmod skips symbolic links). The services
# (user oasis) read and run it; nothing the oasis user runs can change the code that runs next, or the kit copied from it.
lock_release() {
  local dir=$1
  if [[ "$DRY_RUN" == 1 ]]; then
    log "would make $dir root:$OASIS_USER and read-only (chown -R -h, chmod -R g+rX,go-w)"
    return 0
  fi
  root_own -R "root:$OASIS_USER" "$dir"
  chmod -R g+rX,go-w "$dir"
}

# install_kit SRC: copy the deploy kit SRC (a deploy/ directory) into OASIS_KIT_DIR, root:root, nothing writable but by root, and
# swap it in whole. Nothing to do when SRC is the kit itself or the copy is already identical.
install_kit() {
  local src dest=$OASIS_KIT_DIR parent tmp old=""
  src=$(cd "$1" && pwd -P) || die "no deploy kit at $1"
  parent=$(dirname "$dest")
  if [[ -d "$dest" && "$(cd "$dest" && pwd -P)" == "$src" ]]; then
    ok "the deploy kit runs from $dest"
    return 0
  fi
  if [[ -d "$dest" ]] && diff -rq --no-dereference "$src" "$dest" >/dev/null 2>&1; then
    ok "$dest is current"
    return 0
  fi
  if [[ "$DRY_RUN" == 1 ]]; then
    changed "would install the deploy kit from $src into $dest (root:root, read-only for everyone else)"
    return 0
  fi
  mkdir -p "$parent"
  chmod 0755 "$parent"
  root_own root:root "$parent"
  tmp=$(mktemp -d "$dest.new.XXXXXX")
  cp -R --no-preserve=ownership "$src/." "$tmp/"
  root_own -R root:root "$tmp"
  chmod -R u+rwX,go+rX,go-w "$tmp"
  if [[ -e "$dest" ]]; then
    old="$dest.old.$$"
    mv -T "$dest" "$old"
  fi
  mv -T "$tmp" "$dest"
  [[ -z "$old" ]] || rm -rf -- "$old"
  changed "installed the deploy kit in $dest (from $src)"
}

# running_from_kit: whether this script is the root-owned copy (or a test's stand-in for it).
running_from_kit() {
  local here=$1
  [[ -d "$OASIS_KIT_DIR" ]] && [[ "$(cd "$here/.." && pwd -P)" == "$(cd "$OASIS_KIT_DIR" && pwd -P)" ]]
}
