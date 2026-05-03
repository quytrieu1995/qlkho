# E2E Smoke Test (Production)

Run on VPS after `docker compose --env-file .env up -d --build`.

## 0) Variables

```bash
export WEB_HOST="ql.thuanchay.vn"
export BOOTSTRAP_TOKEN="<AUTH_BOOTSTRAP_TOKEN>"
export ADMIN_USER="admin"
export ADMIN_PASS="StrongPass#123"
```

## 1) Health + metrics

```bash
curl -fsS "https://${WEB_HOST}/api/health"
curl -fsS "https://${WEB_HOST}/api/metrics" | rg "qlkho_api_webhook_accepted_total|qlkho_api_sync_enqueued_total"
```

Expected:
- `/api/health` returns `status=ok`
- `/api/metrics` contains custom metric names

## 2) Bootstrap admin + login

```bash
curl -fsS -X POST "https://${WEB_HOST}/api/v1/auth/bootstrap" \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"${BOOTSTRAP_TOKEN}\",\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\"}"
```

```bash
TOKEN=$(curl -fsS -X POST "https://${WEB_HOST}/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\"}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
echo "token_len=${#TOKEN}"
```

Expected:
- bootstrap returns `{"ok":true}`
- `token_len` > 100

## 3) Create sales/kho users (RBAC)

```bash
curl -fsS -X POST "https://${WEB_HOST}/api/v1/users" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"username":"sales01","password":"Sales#12345","role":"sales"}'
```

```bash
curl -fsS -X POST "https://${WEB_HOST}/api/v1/users" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"username":"kho01","password":"Kho#12345","role":"kho"}'
```

Expected:
- both return `{"ok":true}`

## 4) Insert test product in DB

```bash
docker exec -i qlkho-postgres psql -U sales -d sales -c "
INSERT INTO products (external_id, sku, name, category, unit_price, stock)
VALUES ('demo-p-001','SKU-DEMO-001','Demo Product','demo',100000,0)
ON CONFLICT (external_id) DO UPDATE SET
  sku=EXCLUDED.sku,
  name=EXCLUDED.name,
  category=EXCLUDED.category,
  unit_price=EXCLUDED.unit_price;"
```

```bash
PRODUCT_ID=$(docker exec -i qlkho-postgres psql -U sales -d sales -t -A -c \
"SELECT id FROM products WHERE external_id='demo-p-001' LIMIT 1;")
echo "product_id=${PRODUCT_ID}"
```

Expected:
- `product_id` is not empty

## 5) Inventory inbound/outbound

```bash
curl -fsS -X POST "https://${WEB_HOST}/api/v1/inventory/inbound" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"productId\":\"${PRODUCT_ID}\",\"quantity\":100,\"unitCost\":80000,\"referenceCode\":\"PO-DEMO-001\"}"
```

```bash
curl -fsS -X POST "https://${WEB_HOST}/api/v1/inventory/outbound" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"productId\":\"${PRODUCT_ID}\",\"quantity\":5,\"referenceCode\":\"SO-DEMO-001\"}"
```

```bash
curl -fsS "https://${WEB_HOST}/api/v1/inventory/transactions?limit=10" \
  -H "Authorization: Bearer ${TOKEN}"
```

Expected:
- inbound/outbound return `{"ok":true}`
- transactions list shows new rows

## 6) Revenue report by day/month/channel

```bash
FROM=$(date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%SZ)
TO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
curl -fsS "https://${WEB_HOST}/api/v1/reports/revenue?from=${FROM}&to=${TO}&groupBy=day" \
  -H "Authorization: Bearer ${TOKEN}"
```

```bash
curl -fsS "https://${WEB_HOST}/api/v1/reports/revenue?from=${FROM}&to=${TO}&groupBy=month&channel=nhanh.vn" \
  -H "Authorization: Bearer ${TOKEN}"
```

Expected:
- returns array with `bucket`, `channel`, `order_count`, `gross_revenue`

## 7) Webhook realtime + dedupe check

```bash
RAW='{"eventType":"order.updated","resourceId":"order-demo-001","changedAt":"2026-05-04T00:00:00.000Z","data":{"id":"order-demo-001","code":"DH-DEMO-001","status":"confirmed","moneyTransfer":500000,"source":"nhanh.vn","customerId":"c-001","customerName":"Demo Customer","updatedDate":"2026-05-04T00:00:00.000Z"}}'
SIG=$(printf "%s" "$RAW" | openssl dgst -sha256 -hmac "<NHANH_WEBHOOK_SECRET>" -hex | awk '{print $2}')
curl -fsS -X POST "https://${WEB_HOST}/api/v1/webhooks/nhanh" \
  -H "Content-Type: application/json" \
  -H "x-nhanh-signature: ${SIG}" \
  -d "$RAW"
```

Send the same webhook again (dedupe):

```bash
curl -fsS -X POST "https://${WEB_HOST}/api/v1/webhooks/nhanh" \
  -H "Content-Type: application/json" \
  -H "x-nhanh-signature: ${SIG}" \
  -d "$RAW"
```

Expected:
- first request `{"ok":true}`
- second request `{"ok":true,"deduplicated":true}`

## 8) Queue + dead-letter check

```bash
curl -fsS "https://${WEB_HOST}/api/v1/sync/dead-letters?limit=20" \
  -H "Authorization: Bearer ${TOKEN}"
```

Expected:
- empty list in normal condition
- if non-empty, inspect `reason` and failed payload

## 9) Grafana check

- Open `https://<GRAFANA_HOST>`
- Login using `.env` credentials
- Confirm Prometheus datasource is already provisioned
- Query: `rate(qlkho_api_sync_enqueued_total[5m])`

## 10) Fast diagnostics commands

```bash
docker compose ps
docker compose logs --tail=120 api
docker compose logs --tail=120 worker
docker compose logs --tail=120 web
docker compose logs --tail=120 prometheus
docker compose logs --tail=120 grafana
```
