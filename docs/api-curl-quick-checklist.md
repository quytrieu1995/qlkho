# API Quick Checklist (curl) - Verify on VPS

Chay nhanh sau khi deploy:

```bash
docker compose --env-file .env up -d --build
```

## 0) Bien moi truong

```bash
export WEB_HOST="ql.thuanchay.vn"
export BOOTSTRAP_TOKEN="<AUTH_BOOTSTRAP_TOKEN>"
export ADMIN_USER="admin"
export ADMIN_PASS="StrongPass#123"
```

## 1) Health check

```bash
curl -fsS "https://${WEB_HOST}/api/health"
```

Expected: tra ve `{"status":"ok",...}`.

## 2) Bootstrap + Login lay token

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

Expected: `token_len` > 100.

## 3) Tao 2 san pham test

```bash
P1=$(curl -fsS -X POST "https://${WEB_HOST}/api/v1/products" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"sku":"SKU-QC-001","name":"Quick Check 1","category":"qc","unitPrice":120000,"stock":0}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

P2=$(curl -fsS -X POST "https://${WEB_HOST}/api/v1/products" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"sku":"SKU-QC-002","name":"Quick Check 2","category":"qc","unitPrice":90000,"stock":0}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

echo "P1=${P1}"
echo "P2=${P2}"
```

Expected: in ra 2 id khong rong.

## 4) Nhap hang 1 luc nhieu san pham (NEW)

```bash
curl -fsS -X POST "https://${WEB_HOST}/api/v1/inventory/inbound" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"referenceCode\":\"PO-QC-001\",
    \"note\":\"nhap nhieu san pham\",
    \"items\":[
      {\"productId\":\"${P1}\",\"quantity\":20,\"unitCost\":70000},
      {\"productId\":\"${P2}\",\"quantity\":15,\"unitCost\":50000}
    ]
  }"
```

Expected: `{"ok":true,"count":2}`.

## 5) Dieu chinh ton 1 luc nhieu san pham (NEW)

```bash
curl -fsS -X POST "https://${WEB_HOST}/api/v1/inventory/adjustment" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"referenceCode\":\"KK-QC-001\",
    \"note\":\"kiem ke cuoi ngay\",
    \"items\":[
      {\"productId\":\"${P1}\",\"targetStock\":8},
      {\"productId\":\"${P2}\",\"targetStock\":0}
    ]
  }"
```

Expected: `{"ok":true,"count":2}` va cho phep `targetStock=0`.

## 6) Xac minh ton kho sau dieu chinh

```bash
curl -fsS "https://${WEB_HOST}/api/v1/products?limit=300" \
  -H "Authorization: Bearer ${TOKEN}" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); f={x['id']:x for x in d}; print('P1_stock=',f.get('${P1}',{}).get('stock')); print('P2_stock=',f.get('${P2}',{}).get('stock'))"
```

Expected:
- `P1_stock= 8`
- `P2_stock= 0`

## 7) Kiem tra lich su giao dich kho

```bash
curl -fsS "https://${WEB_HOST}/api/v1/inventory/transactions?limit=20" \
  -H "Authorization: Bearer ${TOKEN}"
```

Expected:
- co ban ghi `in` cho `PO-QC-001`
- co ban ghi `adjust` cho `KK-QC-001`

## 8) Test nhap le (tuong thich payload cu)

```bash
curl -fsS -X POST "https://${WEB_HOST}/api/v1/inventory/inbound" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"productId\":\"${P1}\",\"quantity\":3,\"unitCost\":65000,\"referenceCode\":\"PO-QC-SINGLE\"}"
```

Expected: `{"ok":true,"count":1}`.

## 9) Chan doan nhanh neu loi

```bash
docker compose ps
docker compose logs --tail=120 api
docker compose logs --tail=120 worker
```
