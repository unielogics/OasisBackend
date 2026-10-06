#!/usr/bin/env bash
# Asserts the M0 toolchain on this Amazon Linux 2023 aarch64 box. Exit non-zero on the first hard failure.
set -uo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.local/bin:$PATH"
fail=0
ok()   { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=1; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$1"; }

[[ "$(node -v 2>/dev/null)" == v22.* ]] && ok "node $(node -v)" || bad "node 22 not found"
command -v pnpm >/dev/null && ok "pnpm $(pnpm -v)" || bad "pnpm missing"

if [[ -f .env ]]; then
  set -a; . ./.env; set +a
  for v in DATABASE_URL DATABASE_URL_TEST DATABASE_URL_PARITY; do
    if psql "${!v}" -tAc 'select 1' >/dev/null 2>&1; then ok "postgres $v"; else bad "postgres $v unreachable"; fi
  done
  exts=$(psql "$DATABASE_URL" -tAc "select string_agg(extname, ',' order by extname) from pg_extension" 2>/dev/null)
  for e in btree_gist citext pg_trgm pgcrypto; do [[ ",$exts," == *",$e,"* ]] && ok "extension $e" || bad "extension $e missing"; done
else
  bad ".env missing (see .env.example)"
fi

[[ "$(sudo -n -u postgres psql -tAc 'show server_version' 2>/dev/null)" == 15.* ]] && ok "postgres 15" || warn "could not confirm postgres 15 (needs sudo)"
swapon --show | grep -q swapfile && ok "swap enabled" || warn "no swap (next build + chromium may OOM on 7.8 GB)"

bin=$(find "$HOME/.cache/ms-playwright" -type f \( -name chrome-headless-shell -o -name headless_shell \) 2>/dev/null | head -1)
if [[ -n "$bin" ]]; then
  ldd "$bin" 2>&1 | grep -q 'not found' && bad "chromium has missing shared libs" || ok "chromium libs complete"
else warn "playwright chromium not installed (run in dashboard: pnpm exec playwright install chromium)"; fi
fonts=$(fc-list 2>/dev/null); grep -qi 'noto emoji' <<<"$fonts" && ok "emoji font" || warn "no emoji font"

systemctl is-active --quiet tailscaled && ok "tailscaled running" || warn "tailscaled not running"
tailscale status >/dev/null 2>&1 && ok "tailscale joined: $(tailscale ip -4 2>/dev/null | head -1)" || warn "tailscale not logged in (needs user approval)"
for r in backend dashboard; do
  git -C "$HOME/oasis/$r" remote get-url origin >/dev/null 2>&1 && ok "git remote $r" || bad "git remote $r missing"
done
exit $fail
