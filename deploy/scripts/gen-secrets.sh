#!/usr/bin/env bash
# gen-secrets.sh [NAME ...]    prints NAME=value lines for the secrets Oasis needs, generated from the system CSPRNG (openssl).
# With no names it prints all of them. Nothing is written anywhere; install.sh and you decide where the lines go.
#
#   SESSION_SECRET           48 random bytes, base64: signs session cookies
#   SECRETS_KEY              32 random bytes, base64: AES-256 key for the credentials stored in the database
#   SMSGATE_WEBHOOK_SECRET   24 random bytes, base64url: type it into the SMS Gate app as the webhook signing key
#   STORAGE_SIGNING_SECRET   32 random bytes, hex: only for STORAGE_PROVIDER=fs
#   DB_PASSWORD              24 random bytes, hex: the password of the oasis database role (hex needs no URL encoding)
#   BOOTSTRAP_ADMIN_PASSWORD 18 random bytes, base64url: a first Super Admin password to change after signing in
#   BACKUP_ENCRYPTION_KEY    32 random bytes, base64: key for encrypted off-host backups
set -euo pipefail
command -v openssl >/dev/null 2>&1 || {
  echo "gen-secrets.sh: openssl is required" >&2
  exit 1
}

b64url() { openssl rand -base64 "$1" | tr -d '\n=' | tr '+/' '-_'; }

gen() {
  case "$1" in
    SESSION_SECRET) printf 'SESSION_SECRET=%s\n' "$(openssl rand -base64 48 | tr -d '\n')" ;;
    SECRETS_KEY) printf 'SECRETS_KEY=%s\n' "$(openssl rand -base64 32 | tr -d '\n')" ;;
    SMSGATE_WEBHOOK_SECRET) printf 'SMSGATE_WEBHOOK_SECRET=%s\n' "$(b64url 24)" ;;
    STORAGE_SIGNING_SECRET) printf 'STORAGE_SIGNING_SECRET=%s\n' "$(openssl rand -hex 32)" ;;
    DB_PASSWORD) printf 'DB_PASSWORD=%s\n' "$(openssl rand -hex 24)" ;;
    BOOTSTRAP_ADMIN_PASSWORD) printf 'BOOTSTRAP_ADMIN_PASSWORD=%s\n' "$(b64url 18)" ;;
    BACKUP_ENCRYPTION_KEY) printf 'BACKUP_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32 | tr -d '\n')" ;;
    *)
      echo "gen-secrets.sh: unknown secret $1" >&2
      return 1
      ;;
  esac
}

if (($# == 0)); then
  set -- SESSION_SECRET SECRETS_KEY SMSGATE_WEBHOOK_SECRET STORAGE_SIGNING_SECRET DB_PASSWORD BOOTSTRAP_ADMIN_PASSWORD BACKUP_ENCRYPTION_KEY
fi
for name in "$@"; do gen "$name"; done
