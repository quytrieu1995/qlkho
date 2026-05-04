import { pool } from "../db.js";
import { getCache, purgePrefix, setCache } from "../cache.js";

export interface DashboardMetrics {
  todayOrders: number;
  todayRevenue: number;
  lowStockProducts: number;
  pendingSyncJobs: number;
}

export async function listOrders(limit = 50): Promise<Record<string, unknown>[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 200);
  const { rows } = await pool.query(
    `
      SELECT
        o.id,
        o.order_code,
        o.status,
        o.total_amount,
        o.source,
        o.updated_at,
        c.full_name AS customer_name,
        c.phone AS customer_phone
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      ORDER BY o.updated_at DESC
      LIMIT $1
    `,
    [safeLimit]
  );
  return rows;
}

export async function listProducts(limit = 100): Promise<Record<string, unknown>[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 500);
  const { rows } = await pool.query(
    `
      SELECT id, sku, name, category, unit_price, stock, updated_at
      FROM products
      ORDER BY updated_at DESC
      LIMIT $1
    `,
    [safeLimit]
  );
  return rows;
}

export async function getDashboardMetrics(): Promise<DashboardMetrics> {
  const cacheKey = "dashboard:metrics:v1";
  const cached = await getCache<DashboardMetrics>(cacheKey);
  if (cached) {
    return cached;
  }

  const { rows } = await pool.query(
    `
      SELECT
        (SELECT COUNT(*)::INT
           FROM orders
          WHERE created_at >= date_trunc('day', NOW())) AS today_orders,
        (SELECT COALESCE(SUM(total_amount), 0)::FLOAT8
           FROM orders
          WHERE created_at >= date_trunc('day', NOW())) AS today_revenue,
        (SELECT COUNT(*)::INT FROM products WHERE stock <= 5) AS low_stock_products,
        (SELECT COUNT(*)::INT FROM sync_jobs WHERE status IN ('queued', 'processing')) AS pending_sync_jobs
    `
  );

  const metrics: DashboardMetrics = {
    todayOrders: rows[0].today_orders,
    todayRevenue: rows[0].today_revenue,
    lowStockProducts: rows[0].low_stock_products,
    pendingSyncJobs: rows[0].pending_sync_jobs
  };

  await setCache(cacheKey, metrics, 10);
  return metrics;
}

export async function invalidateReadCaches(): Promise<void> {
  await purgePrefix("dashboard:");
}

export interface RevenueRow {
  bucket: string;
  channel: string;
  order_count: number;
  gross_revenue: number;
}

export async function recordInventoryTransaction(input: {
  productId: string;
  type: "in" | "out" | "adjust";
  quantity: number;
  unitCost?: number;
  referenceCode?: string;
  note?: string;
  createdBy?: string;
}): Promise<void> {
  const quantity = Math.trunc(Math.abs(input.quantity));
  if (quantity <= 0) {
    throw new Error("Quantity must be greater than 0");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const productResult = await client.query(
      `
        SELECT stock
        FROM products
        WHERE id = $1
        FOR UPDATE
      `,
      [input.productId]
    );
    if (productResult.rowCount === 0) {
      throw new Error("Product not found");
    }

    const currentStock = Number(productResult.rows[0].stock);
    const delta = input.type === "out" ? -quantity : quantity;
    const nextStock = input.type === "adjust" ? quantity : currentStock + delta;

    if (nextStock < 0) {
      throw new Error("Insufficient stock");
    }

    await client.query(
      `
        UPDATE products
        SET stock = $2,
            updated_at = NOW()
        WHERE id = $1
      `,
      [input.productId, nextStock]
    );

    await client.query(
      `
        INSERT INTO inventory_transactions(product_id, type, quantity, unit_cost, reference_code, note, created_by)
        VALUES($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        input.productId,
        input.type,
        quantity,
        input.unitCost ?? 0,
        input.referenceCode ?? null,
        input.note ?? null,
        input.createdBy ?? null
      ]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recordInventoryBulkTransaction(input: {
  mode: "in" | "out" | "adjust";
  items: Array<{ productId: string; quantity: number; unitCost?: number; note?: string }>;
  referenceCode?: string;
  commonNote?: string;
  createdBy?: string;
}): Promise<number> {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error("items is required");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let processedCount = 0;
    for (const item of input.items) {
      const productId = String(item.productId ?? "").trim();
      if (!productId) {
        throw new Error("productId is required");
      }

      // "adjust" uses target stock directly (can be 0); in/out uses positive delta quantity.
      const rawQuantity = Number(item.quantity ?? 0);
      const quantity = input.mode === "adjust" ? Math.trunc(rawQuantity) : Math.trunc(Math.abs(rawQuantity));
      if (input.mode === "adjust") {
        if (quantity < 0) {
          throw new Error("Target stock must be greater than or equal to 0");
        }
      } else if (quantity <= 0) {
        throw new Error("Quantity must be greater than 0");
      }

      const productResult = await client.query(
        `
          SELECT stock
          FROM products
          WHERE id = $1
          FOR UPDATE
        `,
        [productId]
      );
      if (productResult.rowCount === 0) {
        throw new Error(`Product not found: ${productId}`);
      }

      const currentStock = Number(productResult.rows[0].stock);
      const delta = input.mode === "out" ? -quantity : quantity;
      const nextStock = input.mode === "adjust" ? quantity : currentStock + delta;
      if (nextStock < 0) {
        throw new Error("Insufficient stock");
      }

      await client.query(
        `
          UPDATE products
          SET stock = $2,
              updated_at = NOW()
          WHERE id = $1
        `,
        [productId, nextStock]
      );

      await client.query(
        `
          INSERT INTO inventory_transactions(product_id, type, quantity, unit_cost, reference_code, note, created_by)
          VALUES($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          productId,
          input.mode,
          quantity,
          item.unitCost ?? 0,
          input.referenceCode ?? null,
          item.note ?? input.commonNote ?? null,
          input.createdBy ?? null
        ]
      );
      processedCount += 1;
    }

    if (processedCount === 0) {
      throw new Error("No valid items to process");
    }
    await client.query("COMMIT");
    return processedCount;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listInventoryTransactions(limit = 100): Promise<Record<string, unknown>[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 500);
  const { rows } = await pool.query(
    `
      SELECT
        t.id,
        t.type,
        t.quantity,
        t.unit_cost,
        t.reference_code,
        t.note,
        t.created_at,
        p.id AS product_id,
        p.sku,
        p.name AS product_name,
        u.username AS created_by_username
      FROM inventory_transactions t
      JOIN products p ON p.id = t.product_id
      LEFT JOIN app_users u ON u.id = t.created_by
      ORDER BY t.created_at DESC
      LIMIT $1
    `,
    [safeLimit]
  );
  return rows;
}

export async function getRevenueReport(input: {
  from: string;
  to: string;
  groupBy: "day" | "month";
  channel?: string;
}): Promise<RevenueRow[]> {
  const bucket = input.groupBy === "month" ? "month" : "day";
  const channelFilter = input.channel && input.channel !== "all" ? input.channel : null;

  const { rows } = await pool.query(
    `
      SELECT
        to_char(date_trunc($3, created_at), CASE WHEN $3 = 'month' THEN 'YYYY-MM' ELSE 'YYYY-MM-DD' END) AS bucket,
        source AS channel,
        COUNT(*)::INT AS order_count,
        COALESCE(SUM(total_amount), 0)::FLOAT8 AS gross_revenue
      FROM orders
      WHERE created_at >= $1::timestamptz
        AND created_at <= $2::timestamptz
        AND ($4::text IS NULL OR source = $4::text)
      GROUP BY 1, 2
      ORDER BY 1 DESC, 4 DESC
    `,
    [input.from, input.to, bucket, channelFilter]
  );
  return rows;
}
