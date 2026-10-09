#!/usr/bin/env bash
# healthcheck.sh [--api URL] [--web URL] [--dashboard-url URL] [--public URL] [--skip-public] [--skip-worker] [--site URL] [--skip-site]
#               [--wait SECONDS] [--quiet]
#
# Is the stack answering? Exit 0 when everything passes, 1 otherwise.
#   API        GET /healthz is 200 and GET /readyz is 200 with {"status":"ready"} (database, migrations and the job queue are fine)
#   dashboard  GET /login is 200
#   sign-in    through the PUBLIC URL (PUBLIC_DASHBOARD_URL: the environment, else common.env; --dashboard-url overrides): a signed-out
#              GET / answers 307 to that URL's /login (a relative /login is accepted too), never to localhost or another host
#              (--skip-public, or PUBLIC_DASHBOARD_URL= set empty in the environment, e.g. for deploy.sh on a host whose own
#              name does not resolve to itself: not checked; also skipped when no public URL is known)
#   worker     systemctl is-active oasis-worker.service says active (--skip-worker: not checked; SYSTEMCTL replaces systemctl)
#   public     (optional, --public https://oasis.example.com) /healthz is 200 through nginx and /hooks/smsgate/x is 404 there
#              (the SMS Gate webhook must never be reachable from the internet)
#   website    (when one is configured: SITE_URL from the environment or /etc/oasis/site.env, or --site URL) GET / answers 200 and
#              contains SITE_MARKER when one is known; www (SITE_WWW_URL, else https://www.<SITE_DOMAIN>) answers 301 to the apex.
#              Not checked with --skip-site, and silently skipped when no site URL is known
# --wait N keeps retrying for N seconds, which is what deploy.sh uses after a restart.
set -euo pipefail

# The ports come from the environment files the services use, so a changed PORT cannot make a deploy judge the wrong address.
ETC="${OASIS_ETC:-${OASIS_ROOT_PREFIX:-}/etc/oasis}"
read_port() { grep -E "^$1=" "$ETC/$2" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d "'\" " || true; }
API_PORT="${API_PORT:-$(read_port PORT api.env)}"
WEB_PORT="${WEB_PORT:-$(read_port WEB_PORT web.env)}"
API_URL="http://127.0.0.1:${API_PORT:-4000}"
WEB_URL="http://127.0.0.1:${WEB_PORT:-3200}"
DASHBOARD_URL="${PUBLIC_DASHBOARD_URL-$(read_port PUBLIC_DASHBOARD_URL common.env)}"
# the website's values may contain spaces (the marker): quotes are stripped, nothing else
read_env() { grep -E "^$1=" "$ETC/$2" 2>/dev/null | tail -n 1 | cut -d= -f2- | sed -E "s/^[\"']//; s/[\"']$//" || true; }
SITE_URL="${SITE_URL-$(read_env SITE_URL site.env)}"
SITE_MARKER="${SITE_MARKER-$(read_env SITE_MARKER site.env)}"
SITE_DOMAIN="${SITE_DOMAIN-$(read_env SITE_DOMAIN site.env)}"
SITE_WWW_URL="${SITE_WWW_URL-${SITE_DOMAIN:+https://www.$SITE_DOMAIN}}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
PUBLIC_URL=""
SKIP_PUBLIC=0
SKIP_WORKER=0
SKIP_SITE=0
WAIT=0
QUIET=0

while (($#)); do
  case "$1" in
    --api) API_URL=$2; shift 2 ;;
    --web) WEB_URL=$2; shift 2 ;;
    --public) PUBLIC_URL=$2; shift 2 ;;
    --dashboard-url) DASHBOARD_URL=$2; shift 2 ;;
    --skip-public) SKIP_PUBLIC=1; shift ;;
    --skip-worker) SKIP_WORKER=1; shift ;;
    --site) SITE_URL=$2; shift 2 ;;
    --skip-site) SKIP_SITE=1; shift ;;
    --wait) WAIT=$2; shift 2 ;;
    --quiet) QUIET=1; shift ;;
    -h | --help)
      sed -n '2,/^set -euo pipefail$/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "healthcheck.sh: unknown option $1" >&2
      exit 2
      ;;
  esac
done

command -v curl >/dev/null 2>&1 || {
  echo "healthcheck.sh: curl is required" >&2
  exit 2
}

BODY=$(mktemp)
FAILURES=()

# probe NAME URL EXPECTED_STATUS [BODY_REGEX]
probe() {
  local name=$1 url=$2 want=$3 pattern=${4:-} code
  code=$(curl -sS -o "$BODY" -w '%{http_code}' --max-time 5 "$url" 2>/dev/null) || code=000
  if [[ "$code" != "$want" ]]; then
    FAILURES+=("$name: $url answered HTTP $code, expected $want$(head -c 200 "$BODY" 2>/dev/null | tr '\n' ' ' | sed 's/^\(.\)/ (\1/;s/$/)/')")
    return 1
  fi
  if [[ -n "$pattern" ]] && ! grep -Eq "$pattern" "$BODY"; then
    FAILURES+=("$name: $url answered $want but the body does not match $pattern: $(head -c 200 "$BODY" | tr '\n' ' ')")
    return 1
  fi
  return 0
}

# sign_in_redirect URL: a signed-out visit to URL/ must be sent to URL/login (absolute on that origin, or a relative /login), with
# 307. A Location on localhost (Next building it from its own listen address) or any other host is the bug this guards against.
HEADERS=$(mktemp)
trap 'rm -f "$BODY" "$HEADERS"' EXIT
sign_in_redirect() {
  local base=${1%/} code location
  code=$(curl -sS -o /dev/null -D "$HEADERS" -w '%{http_code}' --max-time 5 "$base/" 2>/dev/null) || code=000
  location=$(grep -i '^location:' "$HEADERS" 2>/dev/null | tail -n 1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//') || location=""
  if [[ "$code" != 307 ]]; then
    FAILURES+=("public sign-in redirect: $base/ answered HTTP $code, expected 307 to $base/login")
    return 1
  fi
  case "$location" in
    "$base/login" | "$base/login?"* | "$base/login/"* | /login | "/login?"* | /login/*) return 0 ;;
  esac
  FAILURES+=("public sign-in redirect: $base/ sends a signed-out visitor to '${location:-nothing}', expected $base/login (never localhost or another host)")
  return 1
}

# site_ok: the website's front page through its public URL (200 with the marker text), and www sent to the apex with 301.
site_ok() {
  local base=${SITE_URL%/} code location rc=0
  code=$(curl -sS -o "$BODY" -w '%{http_code}' --max-time 5 "$base/" 2>/dev/null) || code=000
  if [[ "$code" != 200 ]]; then
    FAILURES+=("website: $base/ answered HTTP $code, expected 200$(head -c 200 "$BODY" 2>/dev/null | tr '\n' ' ' | sed 's/^\(.\)/ (\1/;s/$/)/')")
    rc=1
  elif [[ -n "$SITE_MARKER" ]] && ! grep -qF -- "$SITE_MARKER" "$BODY"; then
    FAILURES+=("website: $base/ answered 200 but the page does not contain '$SITE_MARKER'")
    rc=1
  fi
  [[ -n "$SITE_WWW_URL" ]] || return "$rc"
  code=$(curl -sS -o /dev/null -D "$HEADERS" -w '%{http_code}' --max-time 5 "${SITE_WWW_URL%/}/" 2>/dev/null) || code=000
  location=$(grep -i '^location:' "$HEADERS" 2>/dev/null | tail -n 1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//') || location=""
  if [[ "$code" != 301 ]]; then
    FAILURES+=("website www: ${SITE_WWW_URL%/}/ answered HTTP $code, expected 301 to $base/")
    return 1
  fi
  case "$location" in
    "$base/" | "$base") return "$rc" ;;
  esac
  FAILURES+=("website www: ${SITE_WWW_URL%/}/ sends visitors to '${location:-nothing}', expected $base/")
  return 1
}

worker_active() {
  local state
  state=$("$SYSTEMCTL" is-active oasis-worker.service 2>/dev/null) || true
  [[ "$state" == active ]] && return 0
  FAILURES+=("worker: oasis-worker.service is ${state:-unknown}, expected active (journalctl -u oasis-worker)")
  return 1
}

run_checks() {
  FAILURES=()
  probe "api liveness" "$API_URL/healthz" 200 || true
  probe "api readiness" "$API_URL/readyz" 200 '"status":"ready"' || true
  probe "dashboard" "$WEB_URL/login" 200 || true
  ((SKIP_PUBLIC)) || [[ -z "$DASHBOARD_URL" ]] || sign_in_redirect "$DASHBOARD_URL" || true
  ((SKIP_WORKER)) || worker_active || true
  ((SKIP_SITE)) || [[ -z "$SITE_URL" ]] || site_ok || true
  if [[ -n "$PUBLIC_URL" ]]; then
    probe "public liveness" "${PUBLIC_URL%/}/healthz" 200 || true
    probe "public sms hook hidden" "${PUBLIC_URL%/}/hooks/smsgate/healthcheck" 404 || true
  fi
  ((${#FAILURES[@]} == 0))
}

deadline=$((SECONDS + WAIT))
until run_checks; do
  if ((SECONDS >= deadline)); then
    printf 'UNHEALTHY\n' >&2
    printf '  %s\n' "${FAILURES[@]}" >&2
    exit 1
  fi
  sleep 1
done
checked="api $API_URL, dashboard $WEB_URL"
if ((SKIP_PUBLIC)); then
  checked+=", public sign-in redirect skipped"
elif [[ -n "$DASHBOARD_URL" ]]; then
  checked+=", sign-in redirect ${DASHBOARD_URL%/}/login"
else
  checked+=", public sign-in redirect not checked (no PUBLIC_DASHBOARD_URL)"
fi
((SKIP_WORKER)) || checked+=", worker active"
if ((SKIP_SITE)); then
  checked+=", website skipped"
elif [[ -n "$SITE_URL" ]]; then
  checked+=", website ${SITE_URL%/}/${SITE_WWW_URL:+ (www 301)}"
fi
((QUIET)) || echo "healthy: $checked${PUBLIC_URL:+, public $PUBLIC_URL}"
