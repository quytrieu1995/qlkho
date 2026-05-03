# nhanh.vn Webhook Sample

## Recommended request

```
POST /api/v1/webhooks/nhanh
Content-Type: application/json
x-nhanh-signature: <hmac-sha256>
```

```json
{
  "eventType": "order.updated",
  "resourceId": "1019923",
  "changedAt": "2026-05-04T01:20:00.000Z",
  "data": {
    "id": 1019923,
    "code": "DH1019923",
    "statusName": "Da xac nhan",
    "moneyTransfer": 2500000,
    "customerId": 7788,
    "customerName": "Nguyen Van A",
    "customerPhone": "0900000000",
    "updatedDate": "2026-05-04T01:20:00.000Z"
  }
}
```

## Signature convention

- Hash algorithm: `sha256`
- Message: raw JSON string body
- Key: `NHANH_WEBHOOK_SECRET`
- Encode output: hex lowercase
