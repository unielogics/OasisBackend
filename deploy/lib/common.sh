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
  for kv in ${q//&/ }; do
    [[ "$kv" == sslmode=* ]] && export PGSSLMODE=${kv#sslmode=}
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
