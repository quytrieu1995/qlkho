#!/usr/bin/env bash

set -u
set -o pipefail

PASS_COUNT=0
FAIL_COUNT=0
STEP_NO=0
RUN_ID="$(date +%s)"

BASE_URL=""
TOKEN=""
ACCOUNT_A_ID=""
ACCOUNT_B_ID=""

SKU_SHARED="SKU-NHANH-SHARED-${RUN_ID}"
REF_A="A-${RUN_ID}"
REF_B="B-${RUN_ID}"

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

bootstrap_and_login() {
  local bootstrap_token="${BOOTSTRAP_TOKEN:-${AUTH_BOOTSTRAP_TOKEN:-}}"
  local admin_user="${ADMIN_USER:-admin}"
  local admin_pass="${ADMIN_PASS:-StrongPass#123}"

  if [[ -z "$bootstrap_token" ]]; then
    echo "Missing BOOTSTRAP_TOKEN (or AUTH_BOOTSTRAP_TOKEN in .env)."
    return 1
  fi

  api_post "/v1/auth/bootstrap" "{\"token\":\"${bootstrap_token}\",\"username\":\"${admin_user}\",\"password\":\"${admin_pass}\"}" >/dev/null || return 1
  local login_resp
  login_resp="$(api_post "/v1/auth/login" "{\"username\":\"${admin_user}\",\"password\":\"${admin_pass}\"}")" || return 1
  TOKEN="$(echo "$login_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))")"
  [[ "${#TOKEN}" -gt 50 ]]
}

create_accounts_ab() {
  local a_name="${NHANH_A_NAME:-Nhanh A ${RUN_ID}}"
  local b_name="${NHANH_B_NAME:-Nhanh B ${RUN_ID}}"
  local a_app="${NHANH_A_APP_ID:-app-a-${RUN_ID}}"
  local b_app="${NHANH_B_APP_ID:-app-b-${RUN_ID}}"
  local a_token="${NHANH_A_ACCESS_TOKEN:-token-a-${RUN_ID}}"
  local b_token="${NHANH_B_ACCESS_TOKEN:-token-b-${RUN_ID}}"
  local a_secret="${NHANH_A_WEBHOOK_SECRET:-verify-token-a-${RUN_ID}}"
  local b_secret="${NHANH_B_WEBHOOK_SECRET:-verify-token-b-${RUN_ID}}"
  local a_base="${NHANH_A_BASE_URL:-https://open.nhanh.vn}"
  local b_base="${NHANH_B_BASE_URL:-https://open.nhanh.vn}"

  local ra
  local rb

  ra="$(api_post "/v1/integrations/nhanh/accounts" "{
    \"name\":\"${a_name}\",
    \"appId\":\"${a_app}\",
    \"accessToken\":\"${a_token}\",
    \"webhookSecret\":\"${a_secret}\",
    \"baseUrl\":\"${a_base}\",
    \"isActive\":true
  }" "$TOKEN")" || return 1

  rb="$(api_post "/v1/integrations/nhanh/accounts" "{
    \"name\":\"${b_name}\",
    \"appId\":\"${b_app}\",
    \"accessToken\":\"${b_token}\",
    \"webhookSecret\":\"${b_secret}\",
    \"baseUrl\":\"${b_base}\",
    \"isActive\":true
  }" "$TOKEN")" || return 1

  ACCOUNT_A_ID="$(echo "$ra" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")"
  ACCOUNT_B_ID="$(echo "$rb" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")"

  [[ -n "$ACCOUNT_A_ID" && -n "$ACCOUNT_B_ID" ]]
}

post_webhook_for_account_a() {
  local a_secret="${NHANH_A_WEBHOOK_SECRET:-verify-token-a-${RUN_ID}}"
  local resp
  resp="$(api_post "/v1/webhooks/nhanh" "{
    \"eventType\":\"product.updated\",
    \"resourceId\":\"prod-${REF_A}\",
    \"changedAt\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\",
    \"webhooksVerifyToken\":\"${a_secret}\",
    \"data\":{
      \"id\":\"prod-${REF_A}\",
      \"sku\":\"${SKU_SHARED}\",
      \"name\":\"Shared Product From A\",
      \"price\":120000,
      \"remain\":18
    }
  }")" || return 1
  echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); raise SystemExit(0 if d.get('ok') is True else 1)"
}

post_webhook_for_account_b() {
  local b_secret="${NHANH_B_WEBHOOK_SECRET:-verify-token-b-${RUN_ID}}"
  local resp
  resp="$(api_post "/v1/webhooks/nhanh" "{
    \"eventType\":\"product.updated\",
    \"resourceId\":\"prod-${REF_B}\",
    \"changedAt\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\",
    \"webhooksVerifyToken\":\"${b_secret}\",
    \"data\":{
      \"id\":\"prod-${REF_B}\",
      \"sku\":\"${SKU_SHARED}\",
      \"name\":\"Shared Product From B\",
      \"price\":130000,
      \"remain\":33
    }
  }")" || return 1
  echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); raise SystemExit(0 if d.get('ok') is True else 1)"
}

verify_single_sku_after_worker() {
  local products
  local i
  for i in 1 2 3 4 5; do
    sleep 2
    products="$(api_get "/v1/products?limit=500" "$TOKEN")" || return 1
    if echo "$products" | python3 -c "import sys,json; arr=json.load(sys.stdin); m=[x for x in arr if x.get('sku')=='${SKU_SHARED}']; ok=(len(m)==1 and str(m[0].get('name'))=='Shared Product From B' and int(m[0].get('stock',-1))==33); raise SystemExit(0 if ok else 1)"; then
      return 0
    fi
  done
  return 1
}

verify_accounts_listed() {
  local resp
  resp="$(api_get "/v1/integrations/nhanh/accounts" "$TOKEN")" || return 1
  echo "$resp" | python3 -c "import sys,json; arr=json.load(sys.stdin); ids={x.get('id') for x in arr}; raise SystemExit(0 if '${ACCOUNT_A_ID}' in ids and '${ACCOUNT_B_ID}' in ids else 1)"
}

optional_pull_test() {
  if [[ "${TEST_REAL_PULL:-0}" != "1" ]]; then
    echo "  SKIP - Pull test (set TEST_REAL_PULL=1 to enable)"
    return 0
  fi
  local from to resp
  from="$(date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%SZ)"
  to="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  resp="$(api_post "/v1/sync/pull" "{
    \"from\":\"${from}\",
    \"to\":\"${to}\",
    \"accountIds\":[\"${ACCOUNT_A_ID}\",\"${ACCOUNT_B_ID}\"]
  }" "$TOKEN")" || return 1
  echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); raise SystemExit(0 if d.get('ok') is True else 1)"
}

main() {
  require_cmd curl
  require_cmd python3

  load_env_file_if_exists
  if ! build_base_url; then
    echo "Missing WEB_HOST. Example:"
    echo "  export WEB_HOST=ql.yourdomain.com"
    exit 1
  fi

  echo "BASE_URL=${BASE_URL}"
  echo "RUN_ID=${RUN_ID}"
  echo "SKU_SHARED=${SKU_SHARED}"

  run_step "Bootstrap + login admin" bootstrap_and_login
  run_step "Create nhanh accounts A/B" create_accounts_ab
  run_step "Webhook product.updated for account A" post_webhook_for_account_a
  run_step "Webhook product.updated for account B (same SKU)" post_webhook_for_account_b
  run_step "Verify single SKU updated by latest webhook" verify_single_sku_after_worker
  run_step "Verify account A/B listed in integration API" verify_accounts_listed
  run_step "Optional real pull with accountIds" optional_pull_test

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
