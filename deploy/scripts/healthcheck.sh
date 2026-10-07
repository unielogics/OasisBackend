#!/usr/bin/env bash
# healthcheck.sh [--api URL] [--web URL] [--public URL] [--wait SECONDS] [--quiet]
#
# Is the stack answering? Exit 0 when everything passes, 1 otherwise.
#   API        GET /healthz is 200 and GET /readyz is 200 with {"status":"ready"} (database, migrations and the job queue are fine)
#   dashboard  GET /login is 200
#   public     (optional, --public https://oasis.example.com) /healthz is 200 through nginx and /hooks/smsgate/x is 404 there
#              (the SMS Gate webhook must never be reachable from the internet)
# --wait N keeps retrying for N seconds, which is what deploy.sh uses after a restart.
set -euo pipefail

API_URL="http://127.0.0.1:${API_PORT:-4000}"
WEB_URL="http://127.0.0.1:${WEB_PORT:-3200}"
PUBLIC_URL=""
WAIT=0
QUIET=0

while (($#)); do
  case "$1" in
    --api) API_URL=$2; shift 2 ;;
    --web) WEB_URL=$2; shift 2 ;;
    --public) PUBLIC_URL=$2; shift 2 ;;
    --wait) WAIT=$2; shift 2 ;;
    --quiet) QUIET=1; shift ;;
    -h | --help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
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
trap 'rm -f "$BODY"' EXIT
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

run_checks() {
  FAILURES=()
  probe "api liveness" "$API_URL/healthz" 200 || true
  probe "api readiness" "$API_URL/readyz" 200 '"status":"ready"' || true
  probe "dashboard" "$WEB_URL/login" 200 || true
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
((QUIET)) || echo "healthy: api $API_URL, dashboard $WEB_URL${PUBLIC_URL:+, public $PUBLIC_URL}"
