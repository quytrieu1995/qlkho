#!/usr/bin/env bash

set -u
set -o pipefail

PASS_COUNT=0
FAIL_COUNT=0
STEP_NO=0
RUN_ID="$(date +%s)"

TOKEN=""
P1=""
P2=""
BASE_URL=""

log_info() {
  printf "\n[%02d] %s\n" "$STEP_NO" "$1"
}

log_pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf "  PASS - %s\n" "$1"
}

log_fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf "  FAIL - %s\n" "$1"
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd"
    exit 1
  fi
}

run_step() {
  local title="$1"
  local fn="$2"
  STEP_NO=$((STEP_NO + 1))
  log_info "$title"
  if "$fn"; then
    log_pass "$title"
  else
    log_fail "$title"
  fi
}

trim() {
  local x="$1"
  x="${x#"${x%%[![:space:]]*}"}"
  x="${x%"${x##*[![:space:]]}"}"
  printf "%s" "$x"
}

load_env_file_if_exists() {
  if [[ -f ".env" ]]; then
    set -a
    # shellcheck disable=SC1091
    . ./.env
    set +a
    echo "Loaded .env"
  fi
}

build_base_url() {
  if [[ -z "${WEB_HOST:-}" ]]; then
    return 1
  fi

  if [[ "$WEB_HOST" == http://* || "$WEB_HOST" == https://* ]]; then
    BASE_URL="${WEB_HOST%/}/api"
  else
    BASE_URL="https://${WEB_HOST}/api"
  fi
  return 0
}

api_get() {
  local path="$1"
  local auth="${2:-}"
  if [[ -n "$auth" ]]; then
    curl -sS -m 30 "${BASE_URL}${path}" -H "Authorization: Bearer ${auth}"
  else
    curl -sS -m 30 "${BASE_URL}${path}"
  fi
}

api_post() {
  local path="$1"
  local json="$2"
  local auth="${3:-}"
  if [[ -n "$auth" ]]; then
    curl -sS -m 30 -X POST "${BASE_URL}${path}" \
      -H "Authorization: Bearer ${auth}" \
      -H "Content-Type: application/json" \
      -d "$json"
  else
    curl -sS -m 30 -X POST "${BASE_URL}${path}" \
      -H "Content-Type: application/json" \
      -d "$json"
  fi
}

step_health() {
  local resp
  resp="$(api_get "/health")" || return 1
  echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); raise SystemExit(0 if d.get('status')=='ok' else 1)"
}

step_bootstrap_login() {
  local bootstrap_token="${BOOTSTRAP_TOKEN:-${AUTH_BOOTSTRAP_TOKEN:-}}"
  local admin_user="${ADMIN_USER:-admin}"
  local admin_pass="${ADMIN_PASS:-StrongPass#123}"
  local login_resp

  if [[ -z "$bootstrap_token" ]]; then
    echo "Missing BOOTSTRAP_TOKEN (or AUTH_BOOTSTRAP_TOKEN in .env)."
    return 1
  fi

  api_post "/v1/auth/bootstrap" "{\"token\":\"${bootstrap_token}\",\"username\":\"${admin_user}\",\"password\":\"${admin_pass}\"}" >/dev/null || return 1
  login_resp="$(api_post "/v1/auth/login" "{\"username\":\"${admin_user}\",\"password\":\"${admin_pass}\"}")" || return 1

  TOKEN="$(echo "$login_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))")"
  TOKEN="$(trim "$TOKEN")"
  [[ "${#TOKEN}" -gt 50 ]]
}

step_create_products() {
  local sku1="SKU-QC-001-${RUN_ID}"
  local sku2="SKU-QC-002-${RUN_ID}"
  local r1
  local r2

  r1="$(api_post "/v1/products" "{\"sku\":\"${sku1}\",\"name\":\"Quick Check 1\",\"category\":\"qc\",\"unitPrice\":120000,\"stock\":0}" "$TOKEN")" || return 1
  r2="$(api_post "/v1/products" "{\"sku\":\"${sku2}\",\"name\":\"Quick Check 2\",\"category\":\"qc\",\"unitPrice\":90000,\"stock\":0}" "$TOKEN")" || return 1

  P1="$(echo "$r1" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")"
  P2="$(echo "$r2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")"
  P1="$(trim "$P1")"
  P2="$(trim "$P2")"

  [[ -n "$P1" && -n "$P2" ]]
}

step_bulk_inbound() {
  local resp
  resp="$(api_post "/v1/inventory/inbound" "{
    \"referenceCode\":\"PO-QC-${RUN_ID}\",
    \"note\":\"bulk inbound quick check\",
    \"items\":[
      {\"productId\":\"${P1}\",\"quantity\":20,\"unitCost\":70000},
      {\"productId\":\"${P2}\",\"quantity\":15,\"unitCost\":50000}
    ]
  }" "$TOKEN")" || return 1

  echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); ok=d.get('ok') is True and int(d.get('count',0))==2; raise SystemExit(0 if ok else 1)"
}

step_bulk_adjustment() {
  local resp
  resp="$(api_post "/v1/inventory/adjustment" "{
    \"referenceCode\":\"KK-QC-${RUN_ID}\",
    \"note\":\"bulk adjustment quick check\",
    \"items\":[
      {\"productId\":\"${P1}\",\"targetStock\":8},
      {\"productId\":\"${P2}\",\"targetStock\":0}
    ]
  }" "$TOKEN")" || return 1

  echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); ok=d.get('ok') is True and int(d.get('count',0))==2; raise SystemExit(0 if ok else 1)"
}

step_verify_stock() {
  local resp
  resp="$(api_get "/v1/products?limit=500" "$TOKEN")" || return 1
  echo "$resp" | python3 -c "import sys,json; arr=json.load(sys.stdin); m={x.get('id'):x for x in arr}; s1=(m.get('${P1}') or {}).get('stock'); s2=(m.get('${P2}') or {}).get('stock'); raise SystemExit(0 if s1==8 and s2==0 else 1)"
}

step_verify_transactions() {
  local resp
  resp="$(api_get "/v1/inventory/transactions?limit=100" "$TOKEN")" || return 1
  echo "$resp" | python3 -c "import sys,json; arr=json.load(sys.stdin); has_in=any(x.get('reference_code')=='PO-QC-${RUN_ID}' and x.get('type')=='in' for x in arr); has_adj=any(x.get('reference_code')=='KK-QC-${RUN_ID}' and x.get('type')=='adjust' for x in arr); raise SystemExit(0 if has_in and has_adj else 1)"
}

step_legacy_single_inbound() {
  local resp
  resp="$(api_post "/v1/inventory/inbound" "{\"productId\":\"${P1}\",\"quantity\":3,\"unitCost\":65000,\"referenceCode\":\"PO-QC-SINGLE-${RUN_ID}\"}" "$TOKEN")" || return 1
  echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); ok=d.get('ok') is True and int(d.get('count',0))==1; raise SystemExit(0 if ok else 1)"
}

main() {
  require_cmd curl
  require_cmd python3

  load_env_file_if_exists
  if ! build_base_url; then
    echo "Missing WEB_HOST. Example:"
    echo "  export WEB_HOST=ql.thuanchay.vn"
    exit 1
  fi

  echo "BASE_URL=${BASE_URL}"
  echo "Run ID: ${RUN_ID}"

  run_step "Health check" step_health
  run_step "Bootstrap + login token" step_bootstrap_login
  run_step "Create test products" step_create_products
  run_step "Bulk inbound (multi items)" step_bulk_inbound
  run_step "Bulk adjustment (multi items)" step_bulk_adjustment
  run_step "Verify stock values" step_verify_stock
  run_step "Verify inventory transactions" step_verify_transactions
  run_step "Legacy single inbound compatibility" step_legacy_single_inbound

  echo
  echo "========== SUMMARY =========="
  echo "PASS: ${PASS_COUNT}"
  echo "FAIL: ${FAIL_COUNT}"
  echo "============================="

  if [[ "$FAIL_COUNT" -gt 0 ]]; then
    exit 1
  fi
}

main "$@"
