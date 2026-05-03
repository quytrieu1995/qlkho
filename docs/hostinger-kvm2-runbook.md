# Hostinger KVM2 Runbook

## 1. Prepare server

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker
```

## 2. Clone and configure

```bash
git clone <your-repo> qlkho
cd qlkho
cp .env.example .env
nano .env
```

Set at least: `WEB_HOST`, `GRAFANA_HOST`, `JWT_SECRET`, `AUTH_BOOTSTRAP_TOKEN`, `NHANH_*`.

## 3. Ensure Traefik can reach services

```bash
docker network ls
docker network create traefik || true
```

`TRAEFIK_NETWORK` in `.env` must match the network where your existing Traefik container is attached.

## 4. Run

```bash
docker compose --env-file .env up -d --build
docker compose ps
docker compose logs -f api
```

## 5. Health check

```bash
curl https://<WEB_HOST>/api/health
curl https://<WEB_HOST>/api/v1/dashboard
curl https://<WEB_HOST>/api/metrics
```

## 6. Bootstrap admin account

```bash
curl -X POST "https://<WEB_HOST>/api/v1/auth/bootstrap" \
  -H "Content-Type: application/json" \
  -d '{"token":"<AUTH_BOOTSTRAP_TOKEN>","username":"admin","password":"<STRONG_PASSWORD>"}'
```

## 7. Scale worker for peak traffic

```bash
docker compose up -d --scale worker=4
```

## 8. Monitoring

- Grafana URL: `https://<GRAFANA_HOST>`
- Login from `.env`: `GRAFANA_ADMIN_USER`, `GRAFANA_ADMIN_PASSWORD`

## 9. Backup PostgreSQL

```bash
docker exec qlkho-postgres pg_dump -U sales sales > backup.sql
```
