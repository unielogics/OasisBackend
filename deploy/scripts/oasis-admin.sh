#!/usr/bin/env bash
# oasis-admin.sh [--url URL] [--origin URL] [--email ADDRESS] COMMAND [args]
#
# The settings that have no dashboard screen yet, as commands: the SMS tablet and the Squarespace connection. It signs in as a person
# with the "Billing and integrations" permission (a Super Admin has it), keeps the session in a private temporary file, adds the CSRF
# token and an Idempotency-Key to every change, and removes the session when it ends. Passwords and keys are asked for on the terminal
# (hidden) or read from an environment variable you name; they never appear on a command line.
#
#   status                                    API readiness and the integration status of both devices and Squarespace
#   sms-devices                               the registered tablets with health, counters and the webhook URL
#   sms-add-device --label NAME --device-url http://100.x.y.z:8080 --username U [--password-env VAR] [--sim-slot N] [--webhook-secret-env VAR]
#                                             register a tablet; prints the webhook signing secret ONCE (type it into the SMS Gate app)
#   sms-update-device ID [--device-url URL] [--username U] [--password-env VAR] [--webhook-secret-env VAR] [--disable | --enable]
#   sms-test ID                               reach the tablet, check the credentials, send nothing
#   sms-register-webhooks ID                  register the seven oasis-* webhooks on the tablet
#   sms-health ID                             live health and queue state of one tablet
#   sqsp-status                               connection, sync lag, orders waiting, dead letters
#   sqsp-connect [--key-env VAR]              store the Squarespace Commerce API key (verified first, kept encrypted)
#   sqsp-product-map [--file map.json]        show the product map, or replace it with the file ({"entries":[...]} as verify:squarespace proposes it, or a bare array)
#   sqsp-sync-now [--resume] [--rematch]      start a sync run now
#   raw METHOD /api/v1/PATH [body.json]       any other call, with the same sign-in and safeguards
#
# URL defaults to PUBLIC_API_URL in the environment files. --origin is the dashboard origin the API expects (PUBLIC_DASHBOARD_URL).
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
. "$here/../lib/common.sh"

URL="${OASIS_URL:-}"
ORIGIN="${OASIS_ORIGIN:-}"
EMAIL="${OASIS_ADMIN_EMAIL:-}"
while (($#)); do
  case "$1" in
    --url) URL=$2; shift 2 ;;
    --origin) ORIGIN=$2; shift 2 ;;
    --email) EMAIL=$2; shift 2 ;;
    -h | --help)
      sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) break ;;
  esac
done
CMD=${1:-}
[[ -n "$CMD" ]] || {
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}
shift

have curl && have node || die "curl and node are required"
[[ -n "$URL" ]] || URL=$(env_get "$OASIS_ETC/common.env" PUBLIC_API_URL 2>/dev/null) || die "give --url https://your-domain (PUBLIC_API_URL was not found in $OASIS_ETC/common.env)"
[[ -n "$ORIGIN" ]] || ORIGIN=$(env_get "$OASIS_ETC/common.env" PUBLIC_DASHBOARD_URL 2>/dev/null) || ORIGIN=$URL
URL=${URL%/}

WORK=$(mktemp -d)
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
JAR="$WORK/jar"
CSRF=""

# json_get FILE PATH...: prints a value from a JSON file (dotted path)
json_get() { node -e 'let v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const k of process.argv[2].split(".")){v=v?.[k]};if(v!==undefined&&v!==null)console.log(typeof v==="object"?JSON.stringify(v):v)' "$1" "$2"; }

# api METHOD PATH [BODYFILE]: one request; prints the JSON answer, or the problem and exit 1 on a 4xx/5xx
api() {
  local method=$1 path=$2 body=${3:-} out="$WORK/out.json" code
  local args=(-sS -o "$out" -w '%{http_code}' -X "$method" -b "$JAR" -c "$JAR" -H "Origin: $ORIGIN" -H 'Accept: application/json' --max-time 60)
  if [[ "$method" != GET ]]; then
    args+=(-H "X-CSRF-Token: $CSRF" -H "Idempotency-Key: oasis-admin-$(openssl rand -hex 12)")
  fi
  if [[ -n "$body" ]]; then args+=(-H 'Content-Type: application/json' --data-binary "@$body"); fi
  code=$(curl "${args[@]}" "$URL$path") || die "could not reach $URL$path"
  if [[ "$code" -ge 400 ]]; then
    printf 'HTTP %s %s\n' "$code" "$(node -e 'try{const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log([p.title,p.detail].filter(Boolean).join(": ")||JSON.stringify(p))}catch{console.log(require("fs").readFileSync(process.argv[1],"utf8").slice(0,300))}' "$out")" >&2
    return 1
  fi
  node -e 'const t=require("fs").readFileSync(process.argv[1],"utf8");try{console.log(JSON.stringify(JSON.parse(t),null,2))}catch{console.log(t)}' "$out"
}

# ask_secret VARNAME PROMPT [ENVNAME]: the value comes from the environment variable ENVNAME when given, else a hidden prompt
secret_from() {
  local envname=${1:-} prompt=$2 value
  if [[ -n "$envname" ]]; then
    value=${!envname:-}
    [[ -n "$value" ]] || die "environment variable $envname is empty"
  else
    [[ -t 0 ]] || die "$prompt: no terminal, pass the name of an environment variable that holds it"
    read -r -s -p "$prompt: " value
    echo >&2
  fi
  printf '%s' "$value"
}

login() {
  local password
  [[ -n "$EMAIL" ]] || {
    [[ -t 0 ]] || die "give --email"
    read -r -p "Email: " EMAIL
  }
  password=$(secret_from "${OASIS_ADMIN_PASSWORD:+OASIS_ADMIN_PASSWORD}" "Password for $EMAIL")
  A_EMAIL=$EMAIL A_PASSWORD=$password node -e 'console.log(JSON.stringify({email:process.env.A_EMAIL,password:process.env.A_PASSWORD}))' >"$WORK/login.json"
  local code
  code=$(curl -sS -o "$WORK/login.out" -w '%{http_code}' -X POST -c "$JAR" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' --data-binary "@$WORK/login.json" --max-time 30 "$URL/api/v1/auth/login") || die "could not reach $URL"
  rm -f "$WORK/login.json"
  [[ "$code" == 200 ]] || die "sign-in failed (HTTP $code): $(json_get "$WORK/login.out" detail 2>/dev/null || json_get "$WORK/login.out" title 2>/dev/null || echo 'see the API log')"
  CSRF=$(json_get "$WORK/login.out" csrfToken)
  [[ -n "$CSRF" ]] || die "the sign-in answer carried no CSRF token"
}

body_file() { # body_file KEY=VALUE... (values from the environment names after @) -> writes $WORK/body.json
  node -e 'const o={};for(const a of process.argv.slice(1)){const i=a.indexOf("=");const k=a.slice(0,i);let v=a.slice(i+1);if(v==="true")v=true;else if(v==="false")v=false;else if(/^-?\d+$/.test(v)&&k!=="username"&&k!=="label"&&k!=="password"&&k!=="apiKey")v=Number(v);if(v!=="")o[k]=v}console.log(JSON.stringify(o))' "$@" >"$WORK/body.json"
  echo "$WORK/body.json"
}

login

case "$CMD" in
  status)
    curl -sS --max-time 10 "$URL/readyz" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log("readyz:",s.slice(0,200)||"(no answer; /readyz is restricted to the server itself)"))'
    echo "--- SMS tablets"
    api GET /api/v1/integrations/sms/devices
    echo "--- Squarespace"
    api GET /api/v1/integrations/squarespace/status
    ;;
  sms-devices) api GET /api/v1/integrations/sms/devices ;;
  sms-add-device)
    label="" durl="" user="" pwenv="" slot="" secenv=""
    while (($#)); do
      case "$1" in
        --label) label=$2; shift 2 ;;
        --device-url) durl=$2; shift 2 ;;
        --username) user=$2; shift 2 ;;
        --password-env) pwenv=$2; shift 2 ;;
        --sim-slot) slot=$2; shift 2 ;;
        --webhook-secret-env) secenv=$2; shift 2 ;;
        *) die "unknown option $1" ;;
      esac
    done
    [[ -n "$label" && -n "$durl" && -n "$user" ]] || die "sms-add-device needs --label, --device-url and --username"
    pw=$(secret_from "$pwenv" "Tablet password (shown in the SMS Gate app under Local Server)")
    ws=""
    [[ -z "$secenv" ]] || ws=$(secret_from "$secenv" "Webhook signing key")
    f=$(provider=smsgate label=$label baseUrl=$durl username=$user password=$pw simSlotDefault=$slot webhookSecret=$ws bash -c 'node -e '"'"'const o={provider:"smsgate",label:process.env.label,baseUrl:process.env.baseUrl,username:process.env.username,password:process.env.password};if(process.env.simSlotDefault)o.simSlotDefault=Number(process.env.simSlotDefault);if(process.env.webhookSecret)o.webhookSecret=process.env.webhookSecret;console.log(JSON.stringify(o))'"'"' > "'"$WORK"'/body.json"; echo "'"$WORK"'/body.json"')
    api POST /api/v1/integrations/sms/devices "$f"
    echo >&2
    echo "The webhookSecret above is shown only now. Type it into the SMS Gate app: Settings, Webhooks, Signing key." >&2
    ;;
  sms-update-device)
    id=${1:-}
    [[ -n "$id" ]] || die "sms-update-device needs the device id"
    shift
    durl="" user="" pwenv="" secenv="" enabled=""
    while (($#)); do
      case "$1" in
        --device-url) durl=$2; shift 2 ;;
        --username) user=$2; shift 2 ;;
        --password-env) pwenv=$2; shift 2 ;;
        --webhook-secret-env) secenv=$2; shift 2 ;;
        --disable) enabled=false; shift ;;
        --enable) enabled=true; shift ;;
        *) die "unknown option $1" ;;
      esac
    done
    pw="" ws=""
    [[ -z "$pwenv" ]] || pw=$(secret_from "$pwenv" "New tablet password")
    [[ -z "$secenv" ]] || ws=$(secret_from "$secenv" "New webhook signing key")
    f=$(baseUrl=$durl username=$user password=$pw webhookSecret=$ws enabled=$enabled bash -c 'node -e '"'"'const o={};for(const [k,e] of [["baseUrl","baseUrl"],["username","username"],["password","password"],["webhookSecret","webhookSecret"]])if(process.env[e])o[k]=process.env[e];if(process.env.enabled)o.enabled=process.env.enabled==="true";console.log(JSON.stringify(o))'"'"' > "'"$WORK"'/body.json"; echo "'"$WORK"'/body.json"')
    api PATCH "/api/v1/integrations/sms/devices/$id" "$f"
    ;;
  sms-test) api POST "/api/v1/integrations/sms/devices/${1:?device id}/test" ;;
  sms-register-webhooks) api POST "/api/v1/integrations/sms/devices/${1:?device id}/register-webhooks" ;;
  sms-health) api GET "/api/v1/integrations/sms/devices/${1:?device id}/health?refresh=true" ;;
  sqsp-status) api GET /api/v1/integrations/squarespace/status ;;
  sqsp-connect)
    keyenv=""
    [[ "${1:-}" == --key-env ]] && keyenv=${2:?variable name}
    key=$(secret_from "$keyenv" "Squarespace Commerce API key")
    K=$key node -e 'console.log(JSON.stringify({apiKey:process.env.K,verify:true}))' >"$WORK/body.json"
    api PUT /api/v1/integrations/squarespace/connection "$WORK/body.json"
    ;;
  sqsp-product-map)
    if [[ "${1:-}" == --file ]]; then
      [[ -r "${2:-}" ]] || die "cannot read ${2:-the --file argument}"
      node -e 'const rows=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(JSON.stringify(Array.isArray(rows)?{entries:rows}:rows))' "$2" >"$WORK/body.json" || die "$2 is not a JSON array"
      api PUT /api/v1/integrations/squarespace/product-map "$WORK/body.json"
    else
      api GET /api/v1/integrations/squarespace/product-map
    fi
    ;;
  sqsp-sync-now)
    resume=false rematch=false
    for a in "$@"; do
      case "$a" in
        --resume) resume=true ;;
        --rematch) rematch=true ;;
        *) die "unknown option $a" ;;
      esac
    done
    printf '{"resume":%s,"rematch":%s}\n' "$resume" "$rematch" >"$WORK/body.json"
    api POST /api/v1/integrations/squarespace/sync-now "$WORK/body.json"
    ;;
  raw)
    method=${1:?METHOD}
    path=${2:?PATH}
    body=${3:-}
    [[ "$path" == /api/* ]] || die "PATH must start with /api/"
    api "$method" "$path" "$body"
    ;;
  *) die "unknown command $CMD (see --help)" ;;
esac
