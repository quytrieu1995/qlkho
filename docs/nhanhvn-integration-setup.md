# Huong dan setup ket noi nhanh.vn (da tai khoan + dong bo theo SKU)

Tai lieu tham chieu Nhanh:
- https://apidocs.nhanh.vn/app
- https://apidocs.nhanh.vn/app#lay-access-token

Huong dan nay dung voi he thong QLKho hien tai:
- Quan ly nhieu tai khoan nhanh.vn
- Nhan webhook theo `webhooks verify token` hoac `x-nhanh-signature`
- Dong bo san pham theo `sku`

## 1) Chuan bi app tren open.nhanh.vn

Vao trang open.nhanh.vn -> tao app moi:

1. Ten app: tuy y (vi du `qlkho-prod`)
2. Trang thai: `Dang hoat dong`
3. Redirect URL: URL HTTPS cua he thong ban (vi du `https://ql.domain.com/nhanh/callback`)
4. Bat webhooks: `ON`
5. Webhooks callback URL:
   - `https://<WEB_HOST>/api/v1/webhooks/nhanh`
6. Webhooks verify token:
   - Tao chuoi bi mat 16-128 ky tu
   - Luu lai, se dung nhu `webhookSecret` khi khai bao tai khoan trong QLKho
7. Chon su kien webhook:
   - Them/Sua/Xoa san pham
   - Them/Sua/Xoa don hang
   - Cap nhat ton kho

## 2) Lay access token tu nhanh.vn

## Cach A - OAuth day du (khuyen nghi)

### Buoc 1: Chuyen huong user de cap quyen

```text
https://nhanh.vn/oauth?version=2.0&appId=YOUR_APP_ID&returnLink=YOUR_RETURN_LINK
```

Sau khi user dang nhap va dong y, Nhanh redirect ve `returnLink?accessCode=...`.

### Buoc 2: Doi accessCode lay accessToken

Neu ban dung API v3:

```bash
curl --location --globoff "https://pos.open.nhanh.vn/v3.0/app/getaccesstoken?appId=<APP_ID>" \
  --header "Content-Type: application/json" \
  --data "{
    \"accessCode\": \"<ACCESS_CODE>\",
    \"secretKey\": \"<APP_SECRET_KEY>\"
  }"
```

Lay `data.accessToken` trong response.

## Cach B - Da co accessToken san

Neu doi tac/chu shop da co accessToken hop le, co the nhap truc tiep vao QLKho (bo qua OAuth flow).

## 3) Khai bao tai khoan nhanh.vn trong QLKho

Dang nhap QLKho bang admin:

1. Vao module `Nguoi dung`
2. Bam `+ Ket noi nhanh.vn`
3. Dien thong tin:
   - Ten ket noi (vi du `Shop A`)
   - `APP_ID`
   - `ACCESS_TOKEN`
   - `WEBHOOK_SECRET` (chinh la verify token da set trong app Nhanh)
   - Base URL: `https://open.nhanh.vn` (mac dinh)
   - Trang thai: `Hoat dong`
4. Luu

Lap lai cho moi doanh nghiep/tai khoan nhanh.vn khac nhau.

## 4) Kiem tra webhook da vao he thong

Khi Nhanh gui webhook den:
- He thong tu nhan dien tai khoan theo:
  - `x-nhanh-signature` (neu co), hoac
  - `webhooksVerifyToken` trong request body
- Sau do day vao queue dong bo.

API kiem tra nhanh:

```bash
curl -H "Authorization: Bearer <TOKEN_ADMIN>" "https://<WEB_HOST>/api/v1/sync/dead-letters?limit=20"
curl -H "Authorization: Bearer <TOKEN_ADMIN>" "https://<WEB_HOST>/api/v1/products?limit=50"
curl -H "Authorization: Bearer <TOKEN_ADMIN>" "https://<WEB_HOST>/api/v1/orders?limit=20"
```

## 5) Pull du lieu chu dong theo tai khoan

Co the goi pull theo 1 hoac nhieu account:

```bash
curl -X POST "https://<WEB_HOST>/api/v1/sync/pull" \
  -H "Authorization: Bearer <TOKEN_ADMIN>" \
  -H "Content-Type: application/json" \
  -d "{
    \"from\":\"2026-05-01T00:00:00.000Z\",
    \"to\":\"2026-05-05T23:59:59.999Z\",
    \"accountIds\":[\"<NHANH_ACCOUNT_ID_1>\",\"<NHANH_ACCOUNT_ID_2>\"]
  }"
```

Neu bo trong `accountIds`, he thong se pull tat ca account dang active.

## 6) Dong bo theo SKU (quan trong)

Worker dang ap dung quy tac:

1. Uu tien cap nhat san pham theo `sku`
2. Neu khong tim thay theo `sku`, moi fallback theo `external_id`
3. Neu chua co ca hai, tao moi

Nghia la:
- Cung `sku` giua nhieu nguon se tro ve cung 1 san pham trong QLKho
- Tranh tao trung ma khac nhau nhung cung SKU

## 7) Checklist van hanh an toan

- Moi account Nhanh nen dung verify token rieng
- Access token het han can cap lai (Nhanh khong refresh token tu dong)
- Theo doi dead-letter de phat hien payload loi
- Luon su dung HTTPS cho callback URL
