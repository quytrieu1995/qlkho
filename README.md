# QLKho Sales Realtime (Docker + VPS + nhanh.vn)

He thong quan ly ban hang full-stack, dong bo realtime voi nhanh.vn qua API va Webhook, toi uu cho workload lon bang mo hinh:

- API Fastify (REST + WebSocket)
- Worker BullMQ (xu ly dong bo bat dong bo, concurrency cao)
- PostgreSQL (du lieu giao dich + index truy van nhanh)
- Redis (queue, pub/sub, cache)
- React dashboard realtime
- Auth JWT + RBAC (`admin`, `sales`, `kho`)
- Inventory in/out transactions + revenue report by channel/time
- Prometheus + Grafana observability
- Docker Compose + Traefik labels de deploy tren Hostinger KVM

## 1) Kien truc

1. nhanh.vn goi webhook vao `POST /api/v1/webhooks/nhanh`
2. API verify signature, ghi log webhook, day event vao queue
3. Worker consume queue, upsert don hang/san pham/khach hang
4. Worker publish event qua Redis Pub/Sub
5. API subscribe channel, push realtime len WebSocket `/ws`
6. Frontend nhan realtime + refresh dashboard

## 2) Chuan bi `.env`

```bash
cp .env.example .env
```

Can dien dung:

- `WEB_HOST`: domain web dashboard (vi du `ql.thuanchay.vn`)
- `GRAFANA_HOST`: domain monitor (vi du `grafana.ql.thuanchay.vn`)
- `TRAEFIK_NETWORK`: network ma Traefik dang dung (thuong la `traefik`)
- `NHANH_APP_ID`, `NHANH_ACCESS_TOKEN`, `NHANH_WEBHOOK_SECRET`
- `POSTGRES_PASSWORD`, `JWT_SECRET`, `AUTH_BOOTSTRAP_TOKEN`

## 3) Deploy tren Hostinger KVM 2

```bash
docker network create traefik || true
docker compose --env-file .env up -d --build
```

Neu Traefik cua ban dang chay tren network ten khac, cap nhat `TRAEFIK_NETWORK` trong `.env`.

## 4) Cau hinh nhanh.vn

- Webhook URL: `https://<WEB_HOST>/api/v1/webhooks/nhanh`
- Header signature: `x-nhanh-signature`
- Secret phai trung voi `NHANH_WEBHOOK_SECRET`

Ban co the pull du lieu chu dong:

```bash
curl -X POST "https://<WEB_HOST>/api/v1/sync/pull" \
  -H "Content-Type: application/json" \
  -d '{"from":"2026-05-04T00:00:00.000Z","to":"2026-05-04T23:59:59.999Z"}'
```

## 5) API chinh

- `GET /api/health`
- `GET /api/metrics`
- `POST /api/v1/auth/bootstrap`
- `POST /api/v1/auth/login`
- `GET /api/v1/auth/me`
- `POST /api/v1/users` (admin)
- `GET /api/v1/users` (admin)
- `PATCH /api/v1/users/:id` (admin)
- `GET /api/v1/dashboard`
- `GET /api/v1/orders?limit=20`
- `GET /api/v1/products?limit=50`
- `POST /api/v1/products`
- `PUT /api/v1/products/:id`
- `GET /api/v1/customers?limit=100`
- `POST /api/v1/customers`
- `PUT /api/v1/customers/:id`
- `POST /api/v1/inventory/inbound`
- `POST /api/v1/inventory/outbound`
- `GET /api/v1/inventory/transactions`
- `GET /api/v1/inventory/stock`
- `GET /api/v1/reports/revenue?from=&to=&groupBy=day|month&channel=`
- `POST /api/v1/webhooks/nhanh`
- `POST /api/v1/sync/pull`
- `GET /api/ws` (WebSocket realtime)

## 6) Toi uu cho du lieu lon realtime

- Queue/worker tach rieng de tranh block API
- Worker concurrency cao (`50`) cho batch event
- Retry exponential (`attempts=5`) cho sync jobs
- Dead-letter table `sync_dead_letters` cho job fail sau retry
- Redis cache dashboard de giam tai DB
- Index toi uu cho query `orders`, `sync_jobs`, `products`
- Thiết kế idempotent upsert theo `external_id` de tranh dup data
- Co the horizontal scale:
  - `docker compose up -d --scale worker=3`
  - Dung read replica PostgreSQL cho query reporting
  - Chuyen Redis single node sang Redis Sentinel/Cluster khi tai rat cao

## 7) Auth + RBAC quickstart

```bash
curl -X POST "https://<WEB_HOST>/api/v1/auth/bootstrap" \
  -H "Content-Type: application/json" \
  -d '{"token":"<AUTH_BOOTSTRAP_TOKEN>","username":"admin","password":"StrongPass#123"}'
```

```bash
TOKEN=$(curl -s -X POST "https://<WEB_HOST>/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"StrongPass#123"}' | jq -r .token)
```

```bash
curl -H "Authorization: Bearer $TOKEN" "https://<WEB_HOST>/api/v1/reports/revenue?groupBy=day"
```

## 8) Monitoring

- Prometheus scrape `api:4000/metrics`
- Grafana auto provision datasource Prometheus
- Truy cap Grafana qua `https://<GRAFANA_HOST>`

## 9) Luu y bao mat

- Gioi han IP cho webhook nhanh.vn neu co the
- Rate-limit webhook theo `WEBHOOK_RATE_LIMIT_MAX/WINDOW_MS`
- Bat TLS cho tat ca endpoint public qua Traefik
- Rotate token nhanh.vn dinh ky
- Backup PostgreSQL hang ngay

## 10) E2E verification

Run full production smoke test:

- `docs/e2e-smoke-test.md`
