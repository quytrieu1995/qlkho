# Nhanh A/B quickstart (30s)

Chi can chay dung 4 lenh sau tren VPS:

```bash
cd /opt/qlkho
chmod +x docs/run-nhanh-multi-account-check.sh
export WEB_HOST="ql.yourdomain.com" BOOTSTRAP_TOKEN="<AUTH_BOOTSTRAP_TOKEN>"
./docs/run-nhanh-multi-account-check.sh
```

Neu can test pull that tu Nhanh (khong chi webhook gia lap), chay them:

```bash
export NHANH_A_APP_ID="..." NHANH_A_ACCESS_TOKEN="..." NHANH_A_WEBHOOK_SECRET="..."
export NHANH_B_APP_ID="..." NHANH_B_ACCESS_TOKEN="..." NHANH_B_WEBHOOK_SECRET="..." TEST_REAL_PULL=1
./docs/run-nhanh-multi-account-check.sh
```

Ket qua:
- Script in `PASS/FAIL` tung buoc
- Exit code `0` = thanh cong, `1` = co loi
