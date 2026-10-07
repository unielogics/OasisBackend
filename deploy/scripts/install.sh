#!/usr/bin/env bash
# install.sh --domain HOST [options]     first-time setup of an Amazon Linux 2023 host; safe to run again.
#
#   --domain HOST          public host name (required): nginx server_name and the PUBLIC_* URLs
#   --email ADDRESS        contact address for Let's Encrypt (certbot mode)
#   --tls certbot|files    certbot (default): obtain a Let's Encrypt certificate with the webroot challenge; files: use --tls-cert/--tls-key
#   --tls-cert FILE --tls-key FILE
#   --csp report-only|enforce|off   Content-Security-Policy for the dashboard pages (default report-only, see docs/deployment.md)
#   --install-packages     dnf install nginx, certbot, logrotate, the Node 22 runtime and pnpm (otherwise they must already be there)
#   --install-postgres     dnf install postgresql15-server, initialise it and allow password logins on 127.0.0.1
#   --local-db             create the oasis database role and database in the local Postgres (needs sudo -u postgres)
#   --drill-role           also create a role that may create databases and write /etc/oasis/drill.env for the monthly restore drill
#   --backend-repo URL --dashboard-repo URL    clone the repositories into /opt/oasis/src (as the oasis user)
#   --gen-deploy-keys      create SSH deploy keys for the oasis user and print the public halves to add on GitHub (read-only)
#   --api-port N --web-port N
#   --dry-run              print everything it would do, change nothing
#   --no-system            write files only: no users, packages, chown, systemctl or nginx reload (for staging directories)
#
# What it does, in order: checks the host, installs packages, creates the oasis user and directories, writes /etc/oasis/*.env from the
# templates (generating SESSION_SECRET and SECRETS_KEY, never overwriting an existing file), prepares the database, installs the systemd
# units, the nginx site with TLS, log rotation and the journald limits, and enables the backup and health-check timers. It does not
# start the application: run deploy.sh for that. Re-running it changes only what differs and reports variables a new template added.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEPLOY_DIR=$(cd "$here/.." && pwd)
# shellcheck source=../lib/common.sh
. "$DEPLOY_DIR/lib/common.sh"

DOMAIN=""
EMAIL=""
TLS=certbot
TLS_CERT=""
TLS_KEY=""
CSP=report-only
INSTALL_PACKAGES=0
INSTALL_POSTGRES=0
LOCAL_DB=0
DRILL_ROLE=0
BACKEND_REPO=""
DASHBOARD_REPO=""
GEN_KEYS=0
API_PORT=4000
WEB_PORT=3200

while (($#)); do
  case "$1" in
    --domain) DOMAIN=$2; shift 2 ;;
    --email) EMAIL=$2; shift 2 ;;
    --tls) TLS=$2; shift 2 ;;
    --tls-cert) TLS_CERT=$2; shift 2 ;;
    --tls-key) TLS_KEY=$2; shift 2 ;;
    --csp) CSP=$2; shift 2 ;;
    --install-packages) INSTALL_PACKAGES=1; shift ;;
    --install-postgres) INSTALL_POSTGRES=1; shift ;;
    --local-db) LOCAL_DB=1; shift ;;
    --drill-role) DRILL_ROLE=1; shift ;;
    --backend-repo) BACKEND_REPO=$2; shift 2 ;;
    --dashboard-repo) DASHBOARD_REPO=$2; shift 2 ;;
    --gen-deploy-keys) GEN_KEYS=1; shift ;;
    --api-port) API_PORT=$2; shift 2 ;;
    --web-port) WEB_PORT=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-system) NO_SYSTEM=1; shift ;;
    -h | --help)
      sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown option $1" ;;
  esac
done

[[ -n "$DOMAIN" ]] || die "--domain is required (the public host name, e.g. oasis.example.com)"
[[ "$DOMAIN" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ ]] || die "--domain $DOMAIN is not a host name"
[[ "$TLS" == certbot || "$TLS" == files ]] || die "--tls must be certbot or files"
[[ "$CSP" == report-only || "$CSP" == enforce || "$CSP" == off ]] || die "--csp must be report-only, enforce or off"
if [[ "$TLS" == files ]]; then
  [[ -n "$TLS_CERT" && -n "$TLS_KEY" ]] || die "--tls files needs --tls-cert and --tls-key"
  if [[ "$DRY_RUN" != 1 && "$NO_SYSTEM" != 1 ]]; then [[ -r "$TLS_CERT" && -r "$TLS_KEY" ]] || die "cannot read $TLS_CERT / $TLS_KEY"; fi
else
  TLS_CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
  TLS_KEY="/etc/letsencrypt/live/$DOMAIN/privkey.pem"
  [[ -n "$EMAIL" ]] || warn "no --email: certbot will register without a contact address"
fi
need_root

# Paths as the running system sees them (OASIS_ROOT_PREFIX only moves where this script writes).
real() { printf '%s' "${1#"$OASIS_ROOT_PREFIX"}"; }
REAL_PREFIX=$(real "$OASIS_PREFIX")
REAL_ETC=$(real "$OASIS_ETC")
REAL_NGINX=$(real "$NGINX_DIR")
CREATED_ENV=()

log "installing Oasis for $DOMAIN (prefix $REAL_PREFIX)$([[ "$DRY_RUN" == 1 ]] && printf ' [dry run]')"

# --- 1. host checks ----------------------------------------------------------------------------------------------------------------
step_preflight() {
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    [[ "${ID:-}" == amzn && "${VERSION_ID:-}" == 2023 ]] || warn "this kit is written for Amazon Linux 2023; found ${PRETTY_NAME:-unknown}"
  fi
  if have node; then
    [[ "$(node -v)" == v22.* ]] && ok "node $(node -v)" || warn "node $(node -v) found, Node 22 is required (the app pins >=22 <23)"
  else
    ((INSTALL_PACKAGES)) || warn "node is not installed: use --install-packages, or install Node 22 yourself"
  fi
  have pnpm && ok "pnpm $(pnpm -v 2>/dev/null)" || { ((INSTALL_PACKAGES)) || warn "pnpm is not installed: use --install-packages"; }
  have pg_dump && ok "pg_dump $(pg_dump --version | awk '{print $3}')" || warn "pg_dump is missing (dnf install postgresql15): backups need it"
  local mem
  mem=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
  ((mem >= 3500)) || warn "only ${mem} MB of memory: the dashboard build needs about 2 GB; add swap (docs/deployment.md)"
}

# --- 2. packages -----------------------------------------------------------------------------------------------------------------
step_packages() {
  ((INSTALL_PACKAGES)) || return 0
  run_system dnf install -y nginx logrotate git openssl curl tar gzip nodejs22 nodejs22-npm postgresql15
  have pnpm || run_system npm install -g pnpm@10.34.6
  if ! have certbot; then
    run_system dnf install -y certbot || {
      warn "no certbot package: installing it into /opt/certbot"
      run_system python3 -m venv /opt/certbot
      run_system /opt/certbot/bin/pip install --quiet certbot
      run_system ln -sf /opt/certbot/bin/certbot /usr/local/bin/certbot
    }
  fi
  if ((INSTALL_POSTGRES)); then
    run_system dnf install -y postgresql15-server postgresql15-contrib
    [[ -f /var/lib/pgsql/data/PG_VERSION ]] || run_system postgresql-setup --initdb
    ensure_pg_hba
    run_system systemctl enable --now postgresql
  fi
}

ensure_pg_hba() {
  local hba=/var/lib/pgsql/data/pg_hba.conf
  [[ "$NO_SYSTEM" == 1 || "$DRY_RUN" == 1 ]] && {
    log "would switch $hba from ident to scram-sha-256 for 127.0.0.1 and ::1"
    return 0
  }
  if grep -Eq '^host\s+all\s+all\s+(127\.0\.0\.1/32|::1/128)\s+ident' "$hba"; then
    cp -n "$hba" "$hba.pre-oasis"
    sed -i -E 's#^(host\s+all\s+all\s+(127\.0\.0\.1/32|::1/128)\s+)ident#\1scram-sha-256#' "$hba"
    changed "pg_hba.conf: password logins on loopback (backup in pg_hba.conf.pre-oasis)"
    systemctl reload postgresql
  else
    ok "pg_hba.conf already allows password logins on loopback"
  fi
}

# --- 3. user and directories ---------------------------------------------------------------------------------------------------
step_user_dirs() {
  if [[ "$NO_SYSTEM" != 1 ]]; then
    if id "$OASIS_USER" >/dev/null 2>&1; then
      ok "user $OASIS_USER exists"
    else
      run useradd --system --home-dir "$(real "$OASIS_STATE")" --shell /sbin/nologin --user-group "$OASIS_USER"
      changed "created user $OASIS_USER"
    fi
  fi
  local o="$OASIS_USER:$OASIS_USER"
  ensure_dir "$OASIS_PREFIX" 0755 "$o"
  ensure_dir "$OASIS_PREFIX/src" 0755 "$o"
  ensure_dir "$OASIS_PREFIX/releases" 0755 "$o"
  ensure_dir "$OASIS_ETC" 0750 "root:$OASIS_USER"
  ensure_dir "$OASIS_STATE" 0750 "$o"
  ensure_dir "$OASIS_STATE/files" 0750 "$o"
  ensure_dir "$OASIS_STATE/mail" 0750 "$o"
  ensure_dir "$OASIS_BACKUP_DIR" 0700 "$o"
  ensure_dir "$OASIS_LOG_DIR" 0750 "$o"
  ensure_dir "$OASIS_ROOT_PREFIX/var/www/certbot" 0755 "root:root"
}

# --- 4. environment files ---------------------------------------------------------------------------------------------------------
ensure_env() {
  local name=$1 dest="$OASIS_ETC/$1.env" tmpl="$DEPLOY_DIR/env/$1.env.example" content
  if [[ -f "$dest" ]]; then
    ok "$dest exists (left alone)"
    local missing
    missing=$(comm -23 <(names_in "$tmpl") <(names_in "$dest") | tr '\n' ' ')
    [[ -z "$missing" ]] || warn "$dest lacks variables that the current template has: $missing (see $tmpl)"
    return 0
  fi
  content=$(<"$tmpl")
  case "$name" in
    common)
      DB_PASSWORD=$(random_hex 24)
      content=$(printf '%s\n' "$content" | set_var SESSION_SECRET "$(random_b64 48)" | set_var SECRETS_KEY "$(random_b64 32)" |
        set_var PUBLIC_API_URL "https://$DOMAIN" | set_var PUBLIC_DASHBOARD_URL "https://$DOMAIN" |
        set_var DATABASE_URL "postgres://oasis:${DB_PASSWORD}@127.0.0.1:5432/oasis")
      CREATED_ENV+=(common)
      ;;
    api) content=$(printf '%s\n' "$content" | set_var PORT "$API_PORT") ;;
    web) content=$(printf '%s\n' "$content" | set_var WEB_PORT "$WEB_PORT") ;;
  esac
  printf '%s\n' "$content" | install_content "$dest" 0640 "root:$OASIS_USER"
}

step_env() {
  ensure_env common
  ensure_env api
  ensure_env worker
  ensure_env web
  if [[ " ${CREATED_ENV[*]:-} " == *" common "* ]]; then
    warn "SECRETS_KEY was generated in $OASIS_ETC/common.env: copy it to a password manager now. Without it the stored tablet and Squarespace credentials cannot be read."
  fi
}

# --- 5. database -----------------------------------------------------------------------------------------------------------------
psql_admin() { sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 "$@"; }

step_database() {
  ((LOCAL_DB)) || {
    log "database: not touched (use --local-db to create the role and database, or point DATABASE_URL at your own server)"
    return 0
  }
  local url pw
  url=$(env_get "$OASIS_ETC/common.env" DATABASE_URL 2>/dev/null) || url=""
  if [[ "$DRY_RUN" == 1 || "$NO_SYSTEM" == 1 ]]; then
    log "would create role oasis and database oasis from DATABASE_URL in $OASIS_ETC/common.env"
    return 0
  fi
  [[ "$url" =~ ^postgres://oasis:([^@]+)@127\.0\.0\.1:5432/oasis$ ]] || die "--local-db expects DATABASE_URL=postgres://oasis:PASSWORD@127.0.0.1:5432/oasis in common.env"
  pw=${BASH_REMATCH[1]}
  if [[ " ${CREATED_ENV[*]:-} " == *" common "* ]] || [[ -z "$(psql_admin -A -t -c "select 1 from pg_roles where rolname = 'oasis'")" ]]; then
    psql_admin -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname = 'oasis') then create role oasis login; end if; end \$\$"
    psql_admin -c "alter role oasis with login password '$pw'"
    changed "database role oasis"
  else
    ok "database role oasis exists (password not changed: common.env already existed)"
  fi
  if [[ -z "$(psql_admin -A -t -c "select 1 from pg_database where datname = 'oasis'")" ]]; then
    psql_admin -c "create database oasis owner oasis"
    changed "database oasis"
  else
    ok "database oasis exists"
  fi
  if ((DRILL_ROLE)); then
    local drill="$OASIS_ETC/drill.env"
    if [[ -f "$drill" ]]; then
      ok "$drill exists (left alone)"
    else
      local dpw
      dpw=$(random_hex 24)
      psql_admin -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname = 'oasis_drill') then create role oasis_drill login createdb; end if; end \$\$"
      psql_admin -c "alter role oasis_drill with login createdb password '$dpw'"
      printf '# Restore drills create and drop a scratch database with this role (it can create databases and nothing else).\nRESTORE_ADMIN_URL=postgres://oasis_drill:%s@127.0.0.1:5432/postgres\n' "$dpw" | install_content "$drill" 0640 "root:$OASIS_USER"
    fi
  fi
}

# --- 6. repositories ---------------------------------------------------------------------------------------------------------------
step_repos() {
  local home="$OASIS_STATE" ssh_dir="$OASIS_STATE/.ssh"
  if ((GEN_KEYS)); then
    run mkdir -p "$ssh_dir"
    run chmod 700 "$ssh_dir"
    local repo
    for repo in backend dashboard; do
      if [[ -f "$ssh_dir/${repo}_ed25519" ]]; then
        ok "deploy key for $repo exists"
      else
        run ssh-keygen -q -t ed25519 -N '' -C "oasis-$repo-deploy@$DOMAIN" -f "$ssh_dir/${repo}_ed25519"
        changed "deploy key for $repo"
      fi
      [[ "$DRY_RUN" == 1 || ! -f "$ssh_dir/${repo}_ed25519.pub" ]] || {
        echo "Add this as a READ-ONLY deploy key on the $repo repository:"
        cat "$ssh_dir/${repo}_ed25519.pub"
      }
    done
    {
      for repo in backend dashboard; do
        printf 'Host github-oasis-%s\n  HostName github.com\n  User git\n  IdentityFile %s/.ssh/%s_ed25519\n  IdentitiesOnly yes\n  StrictHostKeyChecking accept-new\n\n' "$repo" "$(real "$home")" "$repo"
      done
    } | install_content "$ssh_dir/config" 0600 "$OASIS_USER:$OASIS_USER"
    if [[ "$NO_SYSTEM" != 1 && "$DRY_RUN" != 1 ]]; then chown -R "$OASIS_USER:$OASIS_USER" "$ssh_dir"; fi
    log "clone URLs: git@github-oasis-backend:<owner>/<backend repo>.git and git@github-oasis-dashboard:<owner>/<dashboard repo>.git"
  fi
  local pair name url
  for pair in "backend:$BACKEND_REPO" "dashboard:$DASHBOARD_REPO"; do
    name=${pair%%:*}
    url=${pair#*:}
    [[ -n "$url" ]] || continue
    if [[ -d "$OASIS_PREFIX/src/$name/.git" ]]; then
      ok "$OASIS_PREFIX/src/$name is already cloned"
    else
      run_system runuser -u "$OASIS_USER" -- env HOME="$OASIS_STATE" git clone "$url" "$OASIS_PREFIX/src/$name"
    fi
  done
}

# --- 7. systemd ---------------------------------------------------------------------------------------------------------------------
adapt_unit() {
  local text node
  text=$(<"$1")
  node=$(command -v node 2>/dev/null || echo /usr/bin/node)
  text=${text//\/opt\/oasis/$REAL_PREFIX}
  text=${text//\/etc\/oasis/$REAL_ETC}
  text=${text//\/usr\/bin\/node/$node}
  text=${text//\/var\/lib\/oasis/$(real "$OASIS_STATE")}
  text=${text//\/var\/backups\/oasis/$(real "$OASIS_BACKUP_DIR")}
  text=${text//\/var\/log\/oasis/$(real "$OASIS_LOG_DIR")}
  text=${text//WEB_PORT=3200/WEB_PORT=$WEB_PORT}
  printf '%s\n' "$text"
}

step_systemd() {
  local unit
  for unit in "$DEPLOY_DIR"/systemd/*; do
    adapt_unit "$unit" | install_content "$SYSTEMD_DIR/$(basename "$unit")" 0644 root:root
  done
  install_content "$JOURNALD_DIR/oasis.conf" 0644 root:root <"$DEPLOY_DIR/journald/oasis.conf"
  install_content "$LOGROTATE_DIR/oasis" 0644 root:root <"$DEPLOY_DIR/logrotate/oasis"
  run_system systemctl daemon-reload
  run_system systemctl enable oasis.target oasis-api.service oasis-worker.service oasis-web.service oasis-backup.timer oasis-healthcheck.timer
  if [[ -f "$OASIS_ETC/drill.env" ]] || ((DRY_RUN)); then
    run_system systemctl enable oasis-restore-drill.timer
  else
    log "the monthly restore drill timer stays off until /etc/oasis/drill.env exists (install.sh --local-db --drill-role)"
  fi
  run_system systemctl restart systemd-journald
}

# --- 8. nginx and TLS ----------------------------------------------------------------------------------------------------------------
render_nginx() {
  local stapling=on csp_header="Content-Security-Policy" csp_note="Enforced."
  [[ "$TLS" == files ]] && stapling=off
  case "$CSP" in
    report-only) csp_header="Content-Security-Policy-Report-Only"; csp_note="Report-only until every screen has been opened with no violation in the browser console; then run install.sh --csp enforce." ;;
    off) csp_header="X-Oasis-Csp-Disabled"; csp_note="Disabled with --csp off (this header is inert)." ;;
  esac
  local common=("DOMAIN=$DOMAIN" "API_PORT=$API_PORT" "WEB_PORT=$WEB_PORT" "NGINX_DIR=$REAL_NGINX" "TLS_CERT=$TLS_CERT" "TLS_KEY=$TLS_KEY" "SSL_STAPLING=$stapling" "CSP_HEADER=$csp_header" "CSP_NOTE=$csp_note")
  render_template "$DEPLOY_DIR/nginx/oasis-zones.conf.template" "${common[@]}" | install_content "$NGINX_DIR/conf.d/oasis-zones.conf" 0644 root:root
  render_template "$DEPLOY_DIR/nginx/oasis-proxy.conf.template" "${common[@]}" | install_content "$NGINX_DIR/oasis/proxy.conf" 0644 root:root
  render_template "$DEPLOY_DIR/nginx/oasis-security-headers.conf.template" "${common[@]}" | install_content "$NGINX_DIR/oasis/security-headers.conf" 0644 root:root
  if [[ "$1" == bootstrap ]]; then
    render_template "$DEPLOY_DIR/nginx/oasis-http-bootstrap.conf.template" "${common[@]}" | install_content "$NGINX_DIR/conf.d/oasis.conf" 0644 root:root
  else
    render_template "$DEPLOY_DIR/nginx/oasis.conf.template" "${common[@]}" | install_content "$NGINX_DIR/conf.d/oasis.conf" 0644 root:root
  fi
}

nginx_reload() {
  [[ "$NO_SYSTEM" == 1 || "$DRY_RUN" == 1 ]] && {
    log "would run nginx -t and reload nginx"
    return 0
  }
  have nginx || die "nginx is not installed (use --install-packages)"
  nginx -t || die "nginx -t failed; the configuration under $NGINX_DIR/conf.d/oasis*.conf was written but nginx was not reloaded"
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl reload nginx 2>/dev/null || systemctl start nginx
}

step_nginx() {
  if [[ "$TLS" == certbot && ! -f "$OASIS_ROOT_PREFIX$TLS_CERT" && "$NO_SYSTEM" != 1 && "$DRY_RUN" != 1 ]]; then
    have certbot || die "certbot is not installed (use --install-packages)"
    render_nginx bootstrap
    nginx_reload
    local contact=(--register-unsafely-without-email)
    [[ -z "$EMAIL" ]] || contact=(--email "$EMAIL")
    certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" --non-interactive --agree-tos "${contact[@]}" || die "certbot could not issue a certificate for $DOMAIN (does its DNS record point at this host, and is port 80 open?)"
    changed "certificate for $DOMAIN"
    mkdir -p /etc/letsencrypt/renewal-hooks/deploy
    printf '#!/bin/sh\nsystemctl reload nginx\n' >/etc/letsencrypt/renewal-hooks/deploy/oasis-nginx.sh
    chmod 755 /etc/letsencrypt/renewal-hooks/deploy/oasis-nginx.sh
    systemctl enable --now certbot-renew.timer 2>/dev/null || warn "enable certificate renewal yourself: systemctl enable --now certbot-renew.timer (or a cron entry for certbot renew)"
  fi
  render_nginx full
  nginx_reload
}

# --- run -------------------------------------------------------------------------------------------------------------------------------
step_preflight
step_packages
step_user_dirs
step_env
step_database
step_repos
step_systemd
step_nginx

cat <<NEXT

Done. Next:
  1. Deploy keys / repositories: ${BACKEND_REPO:+cloned. }Make sure $REAL_PREFIX/src/backend and $REAL_PREFIX/src/dashboard are clones (install.sh --backend-repo ... --dashboard-repo ...).
  2. First deployment, as root:   $REAL_PREFIX/src/backend/deploy/scripts/deploy.sh      (builds, migrates, starts, health-checks)
  3. First Super Admin:            $DEPLOY_DIR/scripts/bootstrap-admin.sh set you@example.com     then deploy or restart oasis-api once
  4. SMS: connect the tablet and run tailscale-serve.sh (docs/runbook.md, "Add or replace the SMS tablet")
  5. Prove the integrations: pnpm verify:all (docs/live-verification.md)
NEXT
