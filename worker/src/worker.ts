import dotenv from "dotenv";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import pg from "pg";

dotenv.config();

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;

if (!databaseUrl || !redisUrl) {
  throw new Error("DATABASE_URL and REDIS_URL are required");
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 20
});

const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: null
});

function extractNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function scopedExternalId(accountId: string | null, externalId: string): string {
  if (!externalId) {
    return "";
  }
  return accountId ? `${accountId}:${externalId}` : externalId;
}

async function upsertCustomer(data: Record<string, unknown>, accountId: string | null): Promise<string | null> {
  const externalId = scopedExternalId(accountId, String(data.customerId ?? ""));
  if (!externalId) {
    return null;
  }

  const result = await pool.query(
    `
      INSERT INTO customers(external_id, full_name, phone, email, address, updated_at)
      VALUES($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (external_id)
      DO UPDATE
      SET full_name = EXCLUDED.full_name,
          phone = EXCLUDED.phone,
          email = EXCLUDED.email,
          address = EXCLUDED.address,
          updated_at = NOW()
      RETURNING id
    `,
    [
      externalId,
      String(data.customerName ?? "Khach le"),
      String(data.customerPhone ?? ""),
      String(data.customerEmail ?? ""),
      String(data.customerAddress ?? "")
    ]
  );
  return String(result.rows[0].id);
}

async function upsertOrder(payload: Record<string, unknown>): Promise<void> {
  const accountId = String(payload.__nhanhAccountId ?? "").trim() || null;
  const accountName = String(payload.__nhanhAccountName ?? "").trim();
  const customerId = await upsertCustomer(payload, accountId);
  const externalId = scopedExternalId(accountId, String(payload.id ?? ""));
  const orderCode = String(payload.code ?? payload.orderCode ?? externalId);

  if (!externalId || !orderCode) {
    return;
  }

  const totalAmount = extractNumber(payload.moneyTransfer ?? payload.totalAmount ?? 0);
  const status = String(payload.statusName ?? payload.status ?? "new");
  const source = accountName ? `nhanh.vn:${accountName}` : String(payload.source ?? "nhanh.vn");
  const updatedAt = String(payload.updatedDate ?? new Date().toISOString());

  await pool.query(
    `
      INSERT INTO orders(external_id, customer_id, order_code, status, total_amount, source, created_at, updated_at)
      VALUES($1, $2, $3, $4, $5, $6, NOW(), $7::timestamptz)
      ON CONFLICT (external_id)
      DO UPDATE
      SET customer_id = EXCLUDED.customer_id,
          order_code = EXCLUDED.order_code,
          status = EXCLUDED.status,
          total_amount = EXCLUDED.total_amount,
          source = EXCLUDED.source,
          updated_at = EXCLUDED.updated_at
    `,
    [externalId, customerId, orderCode, status, totalAmount, source, updatedAt]
  );

  await pool.query(
    `
      INSERT INTO sales_aggregate_daily(day, order_count, gross_revenue, updated_at)
      VALUES (CURRENT_DATE, 1, $1, NOW())
      ON CONFLICT(day)
      DO UPDATE
      SET order_count = sales_aggregate_daily.order_count + 1,
          gross_revenue = sales_aggregate_daily.gross_revenue + EXCLUDED.gross_revenue,
          updated_at = NOW()
    `,
    [totalAmount]
  );
}

async function upsertProduct(payload: Record<string, unknown>): Promise<void> {
  const accountId = String(payload.__nhanhAccountId ?? "").trim() || null;
  const externalId = scopedExternalId(accountId, String(payload.id ?? payload.productId ?? ""));
  const sku = String(payload.code ?? payload.sku ?? externalId);
  if (!sku) {
    return;
  }

  const updatedBySku = await pool.query(
    `
      UPDATE products
      SET name = $2,
          category = $3,
          unit_price = $4,
          stock = $5,
          updated_at = NOW()
      WHERE sku = $1
      RETURNING id
    `,
    [
      sku,
      String(payload.name ?? "Unknown Product"),
      String(payload.categoryName ?? ""),
      extractNumber(payload.price ?? 0),
      Math.trunc(extractNumber(payload.remain ?? payload.stock ?? 0))
    ]
  );
  if (updatedBySku.rowCount > 0) {
    return;
  }

  if (externalId) {
    const updatedByExternal = await pool.query(
      `
        UPDATE products
        SET sku = $2,
            name = $3,
            category = $4,
            unit_price = $5,
            stock = $6,
            updated_at = NOW()
        WHERE external_id = $1
        RETURNING id
      `,
      [
        externalId,
        sku,
        String(payload.name ?? "Unknown Product"),
        String(payload.categoryName ?? ""),
        extractNumber(payload.price ?? 0),
        Math.trunc(extractNumber(payload.remain ?? payload.stock ?? 0))
      ]
    );
    if (updatedByExternal.rowCount > 0) {
      return;
    }
  }

  await pool.query(
    `
      INSERT INTO products(external_id, sku, name, category, unit_price, stock, updated_at)
      VALUES($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (sku)
      DO UPDATE
      SET name = EXCLUDED.name,
          category = EXCLUDED.category,
          unit_price = EXCLUDED.unit_price,
          stock = EXCLUDED.stock,
          updated_at = NOW()
    `,
    [
      externalId || null,
      sku,
      String(payload.name ?? "Unknown Product"),
      String(payload.categoryName ?? ""),
      extractNumber(payload.price ?? 0),
      Math.trunc(extractNumber(payload.remain ?? payload.stock ?? 0))
    ]
  );
}

async function markJobDone(syncJobId: string): Promise<void> {
  await pool.query(
    `
      UPDATE sync_jobs
      SET status = 'done',
          processed_at = NOW()
      WHERE id = $1::uuid
    `,
    [syncJobId]
  );
}

const worker = new Worker(
  "sync-events",
  async (job) => {
    const eventType = String(job.data.eventType ?? "");
    const data = (job.data.data ?? {}) as Record<string, unknown>;
    const syncJobId = String(job.id ?? "");

    await pool.query(
      `
        UPDATE sync_jobs
        SET status = 'processing'
        WHERE id = $1::uuid
      `,
      [syncJobId]
    );

    if (eventType.startsWith("order.")) {
      await upsertOrder(data);
    } else if (eventType.startsWith("product.") || eventType.startsWith("inventory.")) {
      await upsertProduct(data);
    }

    await redis.publish(
      "sales-events",
      JSON.stringify({
        event: eventType,
        payload: { resourceId: job.data.resourceId ?? "", changedAt: job.data.changedAt ?? "" }
      })
    );

    await markJobDone(syncJobId);
  },
  {
    concurrency: 50,
    connection: redis
  }
);

worker.on("completed", (job) => {
  console.log(`Sync job ${job.id} completed`);
});

worker.on("failed", async (job, error) => {
  console.error(`Sync job ${job?.id} failed`, error);
  if (!job) {
    return;
  }
  const syncJobId = String(job.id ?? "");
  await pool.query(
    `
      UPDATE sync_jobs
      SET status = 'failed',
          error_message = $2,
          processed_at = NOW()
      WHERE id = $1::uuid
    `,
    [syncJobId, String(error?.message ?? "Unknown error")]
  );

  const attempts = Number(job.opts.attempts ?? 1);
  if (job.attemptsMade >= attempts) {
    await pool.query(
      `
        INSERT INTO sync_dead_letters(event_type, payload, reason)
        VALUES($1, $2::jsonb, $3)
      `,
      [
        String(job.data.eventType ?? "unknown"),
        JSON.stringify(job.data ?? {}),
        String(error?.message ?? "Unknown error")
      ]
    );
  }
});
