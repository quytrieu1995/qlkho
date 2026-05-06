import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import crypto from "crypto";
import { syncQueue } from "./queue.js";
import { pool } from "./db.js";
import { fetchNhanhChangesForAccount, getDefaultNhanhAccountFromEnv, verifyNhanhSignature } from "./services/nhanh.js";
import { NhanhV3Error, createNhanhV3Client, type NhanhV3Service } from "./services/nhanh-v3.js";
import {
  getDashboardMetrics,
  getRevenueReport,
  listInventoryTransactions,
  listOrders,
  listProducts,
  recordInventoryBulkTransaction,
  recordInventoryMixedTransaction,
  recordInventoryTransaction
} from "./services/sales.js";
import { broadcast } from "./realtime.js";
import type { SyncEventPayload } from "./types.js";
import { env } from "./config.js";
import { findUserByUsername, getRequester, hashPassword, requireAuth, requireRoles, verifyPassword } from "./auth.js";
import { syncEnqueuedCounter, webhookAcceptedCounter, webhookRejectedCounter } from "./metrics.js";
import { redis } from "./redis.js";

type WebhookRequest = FastifyRequest<{
  Body: {
    eventType?: string;
    resourceId?: string;
    changedAt?: string;
    webhooksVerifyToken?: string;
    verifyToken?: string;
    webhookVerifyToken?: string;
    data?: Record<string, unknown>;
  };
}>;
const allowedRoles = ["admin", "sales", "kho"] as const;
const OAUTH_STATE_KEY_PREFIX = "oauth:nhanh:state:";
type NhanhAccountRow = {
  id: string;
  name: string;
  app_id: string;
  business_id: string;
  access_token: string;
  webhook_secret: string;
  base_url: string;
  is_active: boolean;
};

type NhanhOauthStateStoredContext = {
  appId: string;
  secretKey: string;
  name?: string;
  webhookSecret?: string;
  baseUrl?: string;
  service?: NhanhV3Service;
  isActive?: boolean;
  clientState?: string;
};

function toBase64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function hmacSha256Base64Url(content: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(content, "utf8").digest("base64url");
}

function createSignedOauthState(nonce: string, secret: string): string {
  const payload = toBase64UrlJson({
    v: 1,
    n: nonce,
    iat: Date.now()
  });
  const signature = hmacSha256Base64Url(payload, secret);
  return `v1.${payload}.${signature}`;
}

function verifySignedOauthState(state: string, secret: string): { nonce: string } | null {
  const parts = state.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    return null;
  }

  const payload = parts[1] ?? "";
  const signature = parts[2] ?? "";
  const expected = hmacSha256Base64Url(payload, secret);
  const actualBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actualBuffer.length !== expectedBuffer.length) {
    return null;
  }
  if (!crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      v?: number;
      n?: string;
      iat?: number;
    };
    if (decoded.v !== 1 || !decoded.n || typeof decoded.n !== "string") {
      return null;
    }
    return { nonce: decoded.n };
  } catch {
    return null;
  }
}

async function ensureOperationalTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shipments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
      shipping_code TEXT UNIQUE NOT NULL,
      carrier TEXT NOT NULL,
      service_level TEXT,
      recipient_name TEXT NOT NULL,
      recipient_phone TEXT,
      recipient_address TEXT NOT NULL,
      shipping_fee NUMERIC(14,2) NOT NULL DEFAULT 0,
      cod_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT,
      shipped_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nhanh_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      app_id TEXT NOT NULL,
      business_id TEXT NOT NULL DEFAULT '',
      access_token TEXT NOT NULL,
      webhook_secret TEXT NOT NULL,
      base_url TEXT NOT NULL DEFAULT 'https://pos.open.nhanh.vn',
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("ALTER TABLE nhanh_accounts ADD COLUMN IF NOT EXISTS business_id TEXT NOT NULL DEFAULT ''");
}

async function getNhanhAccounts(opts?: { includeInactive?: boolean }) {
  const includeInactive = opts?.includeInactive ?? false;
  const { rows } = await pool.query<NhanhAccountRow>(
    `
      SELECT id, name, app_id, business_id, access_token, webhook_secret, base_url, is_active
      FROM nhanh_accounts
      WHERE ($1::boolean = true OR is_active = true)
      ORDER BY created_at DESC
    `,
    [includeInactive]
  );

  const accounts = rows.map((row) => ({
    id: row.id,
    name: row.name,
    appId: row.app_id,
    businessId: row.business_id,
    accessToken: row.access_token,
    webhookSecret: row.webhook_secret,
    baseUrl: row.base_url,
    isActive: row.is_active
  }));

  const envAccount = getDefaultNhanhAccountFromEnv();
  if (envAccount) {
    accounts.push({ ...envAccount, isActive: true });
  }
  return accounts;
}

async function enqueueEvent(payload: SyncEventPayload): Promise<void> {
  const syncJob = await pool.query(
    `
      INSERT INTO sync_jobs(event_type, payload, status)
      VALUES($1, $2::jsonb, 'queued')
      RETURNING id
    `,
    [payload.eventType, JSON.stringify(payload)]
  );
  const syncJobId = String(syncJob.rows[0].id);

  await syncQueue.add(payload.eventType, payload, {
    jobId: syncJobId,
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 1000
    },
    removeOnComplete: 5000,
    removeOnFail: 2000
  });
  syncEnqueuedCounter.inc({ event_type: payload.eventType });
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await ensureOperationalTables();

  async function exchangeNhanhTokenAndSaveAccount(input: {
    name?: string;
    appId: string;
    secretKey: string;
    accessCode: string;
    webhookSecret?: string;
    baseUrl?: string;
    service?: NhanhV3Service;
    isActive?: boolean;
  }) {
    const appId = String(input.appId ?? "").trim();
    const secretKey = String(input.secretKey ?? "").trim();
    const accessCode = String(input.accessCode ?? "").trim();
    const requestedName = String(input.name ?? "").trim();
    const service: NhanhV3Service = input.service === "vpage" ? "vpage" : "pos";
    const baseUrl = String(
      input.baseUrl ?? (service === "vpage" ? "https://vpage.open.nhanh.vn" : "https://pos.open.nhanh.vn")
    ).trim();
    const originalWebhookSecret = String(input.webhookSecret ?? "").trim();
    const webhookSecret = originalWebhookSecret || crypto.randomBytes(24).toString("hex");
    const isActive = typeof input.isActive === "boolean" ? input.isActive : true;

    if (!appId || !secretKey || !accessCode) {
      return {
        statusCode: 400,
        body: { error: "appId, secretKey, accessCode are required" }
      };
    }

    const client = createNhanhV3Client({
      appId,
      secretKey,
      baseUrl
    });
    const tokenData = await client.getAccessTokenFromCode(accessCode);
    const businessId = String(tokenData.businessId);

    // Double-check token validity before persisting into integration table.
    await client.checkAccessToken({
      businessId,
      accessToken: tokenData.accessToken
    });

    const accountName = requestedName || `Nhanh ${appId}-${businessId}`;
    const existing = await pool.query<{ id: string }>(
      `
        SELECT id
        FROM nhanh_accounts
        WHERE app_id = $1 AND business_id = $2
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      [appId, businessId]
    );

    let saved;
    if (existing.rowCount && existing.rows[0]) {
      saved = await pool.query(
        `
          UPDATE nhanh_accounts
          SET name = COALESCE(NULLIF($2, ''), name),
              access_token = $3,
              webhook_secret = COALESCE(NULLIF($4, ''), webhook_secret),
              base_url = COALESCE(NULLIF($5, ''), base_url),
              is_active = COALESCE($6, is_active),
              updated_at = NOW()
          WHERE id = $1::uuid
          RETURNING id, name, app_id, business_id, access_token, webhook_secret, base_url, is_active
        `,
        [existing.rows[0].id, accountName, tokenData.accessToken, webhookSecret, baseUrl, isActive]
      );
    } else {
      saved = await pool.query(
        `
          INSERT INTO nhanh_accounts(name, app_id, business_id, access_token, webhook_secret, base_url, is_active, updated_at)
          VALUES($1, $2, $3, $4, $5, $6, COALESCE($7, true), NOW())
          RETURNING id, name, app_id, business_id, access_token, webhook_secret, base_url, is_active
        `,
        [accountName, appId, businessId, tokenData.accessToken, webhookSecret, baseUrl, isActive]
      );
    }

    const account = saved.rows[0];
    return {
      statusCode: existing.rowCount ? 200 : 201,
      body: {
        id: account.id,
        name: account.name,
        appId: account.app_id,
        businessId: account.business_id,
        accessToken: account.access_token,
        webhookSecret: account.webhook_secret,
        baseUrl: account.base_url,
        isActive: account.is_active,
        token: {
          version: tokenData.version,
          expiredAt: tokenData.expiredAt,
          permissions: tokenData.permissions ?? [],
          depotIds: tokenData.depotIds ?? [],
          pageIds: tokenData.pageIds ?? []
        },
        generatedWebhookSecret: !originalWebhookSecret
      }
    };
  }

  app.get("/health", async () => ({
    status: "ok",
    service: "qlkho-api",
    ts: new Date().toISOString()
  }));

  app.get("/v1/dashboard", { preHandler: [requireRoles(["admin", "sales", "kho"])] }, async () => {
    return getDashboardMetrics();
  });

  app.get("/v1/orders", { preHandler: [requireRoles(["admin", "sales", "kho"])] }, async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? "50");
    return listOrders(limit);
  });

  app.get("/v1/orders/:id", { preHandler: [requireRoles(["admin", "sales", "kho"])] }, async (request, reply) => {
    const params = request.params as { id: string };
    const orderResult = await pool.query(
      `
        SELECT o.*, c.full_name AS customer_name, c.phone AS customer_phone, c.email AS customer_email, c.address AS customer_address
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
        WHERE o.id = $1::uuid
        LIMIT 1
      `,
      [params.id]
    );
    if (orderResult.rowCount === 0) {
      return reply.code(404).send({ error: "Order not found" });
    }

    const itemResult = await pool.query(
      `
        SELECT oi.id, oi.quantity, oi.unit_price, p.id AS product_id, p.sku, p.name
        FROM order_items oi
        LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = $1::uuid
        ORDER BY oi.created_at ASC
      `,
      [params.id]
    );

    const shippingResult = await pool.query(
      `
        SELECT *
        FROM shipments
        WHERE order_id = $1::uuid
        ORDER BY updated_at DESC
      `,
      [params.id]
    );

    return {
      ...orderResult.rows[0],
      items: itemResult.rows,
      shipments: shippingResult.rows
    };
  });

  app.post("/v1/orders", { preHandler: [requireRoles(["admin", "sales"])] }, async (request, reply) => {
    const body = request.body as {
      customerId?: string;
      customer?: { fullName?: string; phone?: string; email?: string; address?: string };
      source?: string;
      status?: string;
      items?: Array<{ productId?: string; quantity?: number; unitPrice?: number }>;
    };
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) {
      return reply.code(400).send({ error: "items is required" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      let customerId = body.customerId ? String(body.customerId) : null;
      if (!customerId && body.customer?.fullName) {
        const customerResult = await client.query(
          `
            INSERT INTO customers(full_name, phone, email, address, updated_at)
            VALUES($1, $2, $3, $4, NOW())
            RETURNING id
          `,
          [
            String(body.customer.fullName),
            String(body.customer.phone ?? ""),
            String(body.customer.email ?? ""),
            String(body.customer.address ?? "")
          ]
        );
        customerId = String(customerResult.rows[0].id);
      }

      let totalAmount = 0;
      for (const item of items) {
        totalAmount += Number(item.quantity ?? 0) * Number(item.unitPrice ?? 0);
      }
      const orderCode = `ORD-${Date.now()}`;
      const orderResult = await client.query(
        `
          INSERT INTO orders(customer_id, order_code, status, total_amount, source, created_at, updated_at)
          VALUES($1::uuid, $2, $3, $4, $5, NOW(), NOW())
          RETURNING id
        `,
        [customerId, orderCode, String(body.status ?? "new"), totalAmount, String(body.source ?? "local")]
      );
      const orderId = String(orderResult.rows[0].id);

      for (const item of items) {
        const productId = String(item.productId ?? "");
        const quantity = Math.max(1, Math.trunc(Number(item.quantity ?? 1)));
        const unitPrice = Number(item.unitPrice ?? 0);
        await client.query(
          `
            INSERT INTO order_items(order_id, product_id, quantity, unit_price)
            VALUES($1::uuid, $2::uuid, $3, $4)
          `,
          [orderId, productId, quantity, unitPrice]
        );
      }

      await client.query(
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

      await client.query("COMMIT");
      return reply.code(201).send({ ok: true, orderId, orderCode, totalAmount });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.patch("/v1/orders/:id/status", { preHandler: [requireRoles(["admin", "sales"])] }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as { status?: string };
    const status = String(body.status ?? "").trim();
    if (!status) {
      return reply.code(400).send({ error: "status is required" });
    }
    const result = await pool.query(
      `
        UPDATE orders
        SET status = $2,
            updated_at = NOW()
        WHERE id = $1::uuid
        RETURNING *
      `,
      [params.id, status]
    );
    if (result.rowCount === 0) {
      return reply.code(404).send({ error: "Order not found" });
    }
    return result.rows[0];
  });

  app.get("/v1/products", { preHandler: [requireRoles(["admin", "sales", "kho"])] }, async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? "100");
    return listProducts(limit);
  });

  app.post("/v1/products", { preHandler: [requireRoles(["admin", "kho"])] }, async (request, reply) => {
    const body = request.body as {
      sku?: string;
      name?: string;
      category?: string;
      unitPrice?: number;
      stock?: number;
      externalId?: string;
    };
    const sku = String(body.sku ?? "").trim();
    const name = String(body.name ?? "").trim();
    if (!sku || !name) {
      return reply.code(400).send({ error: "sku and name are required" });
    }

    const result = await pool.query(
      `
        INSERT INTO products(external_id, sku, name, category, unit_price, stock, updated_at)
        VALUES($1, $2, $3, $4, $5, $6, NOW())
        RETURNING *
      `,
      [
        String(body.externalId ?? ""),
        sku,
        name,
        String(body.category ?? ""),
        Number(body.unitPrice ?? 0),
        Math.max(0, Math.trunc(Number(body.stock ?? 0)))
      ]
    );
    return reply.code(201).send(result.rows[0]);
  });

  app.put("/v1/products/:id", { preHandler: [requireRoles(["admin", "kho"])] }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as {
      sku?: string;
      name?: string;
      category?: string;
      unitPrice?: number;
      stock?: number;
    };
    const result = await pool.query(
      `
        UPDATE products
        SET sku = COALESCE($2, sku),
            name = COALESCE($3, name),
            category = COALESCE($4, category),
            unit_price = COALESCE($5, unit_price),
            stock = COALESCE($6, stock),
            updated_at = NOW()
        WHERE id = $1::uuid
        RETURNING *
      `,
      [
        params.id,
        body.sku ?? null,
        body.name ?? null,
        body.category ?? null,
        body.unitPrice ?? null,
        typeof body.stock === "number" ? Math.max(0, Math.trunc(body.stock)) : null
      ]
    );
    if (result.rowCount === 0) {
      return reply.code(404).send({ error: "Product not found" });
    }
    return result.rows[0];
  });

  app.get("/v1/customers", { preHandler: [requireRoles(["admin", "sales"])] }, async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? "100");
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    const { rows } = await pool.query(
      `
        SELECT id, external_id, full_name, phone, email, address, updated_at, created_at
        FROM customers
        ORDER BY updated_at DESC
        LIMIT $1
      `,
      [safeLimit]
    );
    return rows;
  });

  app.post("/v1/customers", { preHandler: [requireRoles(["admin", "sales"])] }, async (request, reply) => {
    const body = request.body as {
      fullName?: string;
      phone?: string;
      email?: string;
      address?: string;
      externalId?: string;
    };
    const fullName = String(body.fullName ?? "").trim();
    if (!fullName) {
      return reply.code(400).send({ error: "fullName is required" });
    }
    const result = await pool.query(
      `
        INSERT INTO customers(external_id, full_name, phone, email, address, updated_at)
        VALUES($1, $2, $3, $4, $5, NOW())
        RETURNING *
      `,
      [
        String(body.externalId ?? ""),
        fullName,
        String(body.phone ?? ""),
        String(body.email ?? ""),
        String(body.address ?? "")
      ]
    );
    return reply.code(201).send(result.rows[0]);
  });

  app.put("/v1/customers/:id", { preHandler: [requireRoles(["admin", "sales"])] }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as {
      fullName?: string;
      phone?: string;
      email?: string;
      address?: string;
    };
    const result = await pool.query(
      `
        UPDATE customers
        SET full_name = COALESCE($2, full_name),
            phone = COALESCE($3, phone),
            email = COALESCE($4, email),
            address = COALESCE($5, address),
            updated_at = NOW()
        WHERE id = $1::uuid
        RETURNING *
      `,
      [params.id, body.fullName ?? null, body.phone ?? null, body.email ?? null, body.address ?? null]
    );
    if (result.rowCount === 0) {
      return reply.code(404).send({ error: "Customer not found" });
    }
    return result.rows[0];
  });

  app.post("/v1/auth/bootstrap", async (request, reply) => {
    const body = request.body as { token?: string; username?: string; password?: string };
    if (body.token !== env.AUTH_BOOTSTRAP_TOKEN) {
      return reply.code(401).send({ error: "Invalid bootstrap token" });
    }

    const username = String(body.username ?? "admin");
    const password = String(body.password ?? "");
    if (password.length < 8) {
      return reply.code(400).send({ error: "Password must be at least 8 chars" });
    }

    const hash = hashPassword(password);
    await pool.query(
      `
        INSERT INTO app_users(username, password_hash, role)
        VALUES($1, $2, 'admin')
        ON CONFLICT (username)
        DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin', is_active = true, updated_at = NOW()
      `,
      [username, hash]
    );
    return { ok: true };
  });

  app.post("/v1/auth/login", async (request, reply) => {
    const body = request.body as { username?: string; password?: string };
    const username = String(body.username ?? "");
    const password = String(body.password ?? "");
    const user = await findUserByUsername(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return reply.code(401).send({ error: "Invalid username or password" });
    }

    const token = await reply.jwtSign(
      {
        id: user.id,
        username: user.username,
        role: user.role
      },
      { expiresIn: "12h" }
    );
    return { token, user: { id: user.id, username: user.username, role: user.role } };
  });

  app.get("/v1/auth/me", { preHandler: [requireAuth] }, async (request) => {
    return { user: getRequester(request) };
  });

  app.post("/v1/users", { preHandler: [requireRoles(["admin"])] }, async (request, reply) => {
    const body = request.body as { username?: string; password?: string; role?: "admin" | "sales" | "kho" };
    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");
    const role = body.role ?? "sales";

    if (!username || password.length < 8) {
      return reply.code(400).send({ error: "Invalid username or password" });
    }

    const hash = hashPassword(password);
    await pool.query(
      `
        INSERT INTO app_users(username, password_hash, role)
        VALUES($1, $2, $3)
      `,
      [username, hash, role]
    );
    return { ok: true };
  });

  app.get("/v1/users", { preHandler: [requireRoles(["admin"])] }, async () => {
    const { rows } = await pool.query(
      `
        SELECT id, username, role, is_active, created_at, updated_at
        FROM app_users
        ORDER BY created_at DESC
      `
    );
    return rows;
  });

  app.patch("/v1/users/:id", { preHandler: [requireRoles(["admin"])] }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as { role?: "admin" | "sales" | "kho"; isActive?: boolean };
    const role = body.role ?? null;
    if (role && !allowedRoles.includes(role)) {
      return reply.code(400).send({ error: "Invalid role" });
    }
    const result = await pool.query(
      `
        UPDATE app_users
        SET role = COALESCE($2, role),
            is_active = COALESCE($3, is_active),
            updated_at = NOW()
        WHERE id = $1::uuid
        RETURNING id, username, role, is_active, created_at, updated_at
      `,
      [params.id, role, typeof body.isActive === "boolean" ? body.isActive : null]
    );
    if (result.rowCount === 0) {
      return reply.code(404).send({ error: "User not found" });
    }
    return result.rows[0];
  });

  app.get("/v1/integrations/nhanh/accounts", { preHandler: [requireRoles(["admin"])] }, async () => {
    const accounts = await getNhanhAccounts({ includeInactive: true });
    return accounts.map((item) => ({
      id: item.id,
      name: item.name,
      appId: item.appId,
      businessId: item.businessId,
      accessToken: item.accessToken,
      webhookSecret: item.webhookSecret,
      baseUrl: item.baseUrl,
      isActive: item.isActive
    }));
  });

  app.post("/v1/integrations/nhanh/oauth-url", { preHandler: [requireRoles(["admin"])] }, async (request, reply) => {
    const body = request.body as {
      appId?: string;
      secretKey?: string;
      returnLink?: string;
      version?: string;
      state?: string;
      prompt?: string;
      name?: string;
      webhookSecret?: string;
      baseUrl?: string;
      service?: NhanhV3Service;
      isActive?: boolean;
    };

    const appId = String(body.appId ?? env.NHANH_APP_ID ?? "").trim();
    const secretKey = String(body.secretKey ?? env.NHANH_SECRET_KEY ?? "").trim();
    const returnLink = String(body.returnLink ?? "").trim();
    const version = String(body.version ?? "2.0").trim();
    const clientState = String(body.state ?? "").trim();
    const prompt = String(body.prompt ?? "").trim();
    const service: NhanhV3Service = body.service === "vpage" ? "vpage" : "pos";
    const baseUrl = String(
      body.baseUrl ?? (service === "vpage" ? "https://vpage.open.nhanh.vn" : "https://pos.open.nhanh.vn")
    ).trim();
    const oauthStateSecret = env.NHANH_OAUTH_STATE_SECRET;
    const stateTtlSeconds = env.NHANH_OAUTH_STATE_TTL_SECONDS;

    if (!appId || !secretKey || !returnLink) {
      return reply.code(400).send({ error: "appId, secretKey and returnLink are required" });
    }

    let parsedReturnLink: URL;
    try {
      parsedReturnLink = new URL(returnLink);
    } catch {
      return reply.code(400).send({ error: "returnLink must be a valid URL" });
    }

    if (parsedReturnLink.protocol !== "https:") {
      return reply.code(400).send({ error: "returnLink must use https" });
    }

    const nonce = crypto.randomBytes(18).toString("hex");
    const signedState = createSignedOauthState(nonce, oauthStateSecret);
    const stateKey = `${OAUTH_STATE_KEY_PREFIX}${nonce}`;
    const stateContext: NhanhOauthStateStoredContext = {
      appId,
      secretKey,
      name: String(body.name ?? "").trim() || undefined,
      webhookSecret: String(body.webhookSecret ?? "").trim() || undefined,
      baseUrl,
      service,
      isActive: typeof body.isActive === "boolean" ? body.isActive : true,
      clientState: clientState || undefined
    };
    const stored = await redis.set(stateKey, JSON.stringify(stateContext), "EX", stateTtlSeconds, "NX");
    if (stored !== "OK") {
      return reply.code(500).send({ error: "Unable to initialize OAuth state" });
    }

    const oauthUrl = new URL("https://nhanh.vn/oauth");
    oauthUrl.searchParams.set("version", version);
    oauthUrl.searchParams.set("appId", appId);
    oauthUrl.searchParams.set("returnLink", returnLink);
    oauthUrl.searchParams.set("state", signedState);
    if (prompt) {
      oauthUrl.searchParams.set("prompt", prompt);
    }

    return reply.send({
      oauthUrl: oauthUrl.toString(),
      expiresInSeconds: stateTtlSeconds,
      params: {
        version,
        appId,
        returnLink,
        state: signedState,
        ...(prompt ? { prompt } : {})
      },
      meta: {
        service,
        baseUrl,
        hasClientState: Boolean(clientState)
      }
    });
  });

  app.post("/v1/integrations/nhanh/accounts", { preHandler: [requireRoles(["admin"])] }, async (request, reply) => {
    const body = request.body as {
      name?: string;
      appId?: string;
      businessId?: string;
      accessToken?: string;
      webhookSecret?: string;
      baseUrl?: string;
      isActive?: boolean;
    };
    const name = String(body.name ?? "").trim();
    const appId = String(body.appId ?? "").trim();
    const businessId = String(body.businessId ?? "").trim();
    const accessToken = String(body.accessToken ?? "").trim();
    const webhookSecret = String(body.webhookSecret ?? "").trim();
    const baseUrl = String(body.baseUrl ?? "https://pos.open.nhanh.vn").trim();
    if (!name || !appId || !businessId || !accessToken || !webhookSecret) {
      return reply.code(400).send({ error: "name, appId, businessId, accessToken, webhookSecret are required" });
    }
    const result = await pool.query(
      `
        INSERT INTO nhanh_accounts(name, app_id, business_id, access_token, webhook_secret, base_url, is_active, updated_at)
        VALUES($1, $2, $3, $4, $5, $6, COALESCE($7, true), NOW())
        RETURNING id, name, app_id, business_id, access_token, webhook_secret, base_url, is_active
      `,
      [name, appId, businessId, accessToken, webhookSecret, baseUrl, typeof body.isActive === "boolean" ? body.isActive : true]
    );
    return reply.code(201).send({
      id: result.rows[0].id,
      name: result.rows[0].name,
      appId: result.rows[0].app_id,
      businessId: result.rows[0].business_id,
      accessToken: result.rows[0].access_token,
      webhookSecret: result.rows[0].webhook_secret,
      baseUrl: result.rows[0].base_url,
      isActive: result.rows[0].is_active
    });
  });

  app.post("/v1/integrations/nhanh/accounts/exchange-token", { preHandler: [requireRoles(["admin"])] }, async (request, reply) => {
    const body = request.body as {
      name?: string;
      appId?: string;
      secretKey?: string;
      accessCode?: string;
      webhookSecret?: string;
      baseUrl?: string;
      service?: NhanhV3Service;
      isActive?: boolean;
    };

    try {
      const result = await exchangeNhanhTokenAndSaveAccount({
        name: body.name,
        appId: String(body.appId ?? ""),
        secretKey: String(body.secretKey ?? ""),
        accessCode: String(body.accessCode ?? ""),
        webhookSecret: body.webhookSecret,
        baseUrl: body.baseUrl,
        service: body.service,
        isActive: body.isActive
      });
      return reply.code(result.statusCode).send(result.body);
    } catch (error) {
      if (error instanceof NhanhV3Error) {
        return reply.code(400).send({
          error: error.message,
          nhanh: error.details
        });
      }
      throw error;
    }
  });

  app.get("/v1/integrations/nhanh/oauth-callback", async (request, reply) => {
    const query = request.query as {
      accessCode?: string;
      state?: string;
      error?: string;
      errorDescription?: string;
    };

    if (query.error) {
      return reply.code(400).send({
        error: "Nhanh OAuth authorization failed",
        oauth: {
          code: query.error,
          description: query.errorDescription ?? ""
        }
      });
    }
    const accessCode = String(query.accessCode ?? "").trim();
    const signedState = String(query.state ?? "").trim();
    if (!accessCode || !signedState) {
      return reply.code(400).send({ error: "accessCode and state are required" });
    }

    const verified = verifySignedOauthState(signedState, env.NHANH_OAUTH_STATE_SECRET);
    if (!verified) {
      return reply.code(400).send({ error: "Invalid OAuth state signature" });
    }

    const stateKey = `${OAUTH_STATE_KEY_PREFIX}${verified.nonce}`;
    const stateOps = await redis.multi().get(stateKey).del(stateKey).exec();
    const stateRaw = String(stateOps?.[0]?.[1] ?? "").trim();
    if (!stateRaw) {
      return reply.code(400).send({ error: "OAuth state is expired or already used" });
    }

    let stateContext: NhanhOauthStateStoredContext;
    try {
      stateContext = JSON.parse(stateRaw) as NhanhOauthStateStoredContext;
    } catch {
      return reply.code(400).send({ error: "OAuth state payload is invalid" });
    }

    try {
      const result = await exchangeNhanhTokenAndSaveAccount({
        name: stateContext.name,
        appId: stateContext.appId ?? "",
        secretKey: stateContext.secretKey ?? "",
        accessCode,
        webhookSecret: stateContext.webhookSecret,
        baseUrl: stateContext.baseUrl,
        service: stateContext.service,
        isActive: stateContext.isActive
      });

      return reply.code(result.statusCode).send({
        ...result.body,
        oauth: {
          state: stateContext.clientState ?? "",
          consumed: true
        }
      });
    } catch (error) {
      if (error instanceof NhanhV3Error) {
        return reply.code(400).send({
          error: error.message,
          nhanh: error.details
        });
      }
      throw error;
    }
  });

  app.put("/v1/integrations/nhanh/accounts/:id", { preHandler: [requireRoles(["admin"])] }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as {
      name?: string;
      appId?: string;
      businessId?: string;
      accessToken?: string;
      webhookSecret?: string;
      baseUrl?: string;
      isActive?: boolean;
    };
    const result = await pool.query(
      `
        UPDATE nhanh_accounts
        SET name = COALESCE(NULLIF($2, ''), name),
            app_id = COALESCE(NULLIF($3, ''), app_id),
            business_id = COALESCE(NULLIF($4, ''), business_id),
            access_token = COALESCE(NULLIF($5, ''), access_token),
            webhook_secret = COALESCE(NULLIF($6, ''), webhook_secret),
            base_url = COALESCE(NULLIF($7, ''), base_url),
            is_active = COALESCE($8, is_active),
            updated_at = NOW()
        WHERE id = $1::uuid
        RETURNING id, name, app_id, business_id, access_token, webhook_secret, base_url, is_active
      `,
      [
        params.id,
        body.name ?? "",
        body.appId ?? "",
        body.businessId ?? "",
        body.accessToken ?? "",
        body.webhookSecret ?? "",
        body.baseUrl ?? "",
        typeof body.isActive === "boolean" ? body.isActive : null
      ]
    );
    if (result.rowCount === 0) {
      return reply.code(404).send({ error: "Nhanh account not found" });
    }
    return {
      id: result.rows[0].id,
      name: result.rows[0].name,
      appId: result.rows[0].app_id,
      businessId: result.rows[0].business_id,
      accessToken: result.rows[0].access_token,
      webhookSecret: result.rows[0].webhook_secret,
      baseUrl: result.rows[0].base_url,
      isActive: result.rows[0].is_active
    };
  });

  app.post("/v1/inventory/inbound", { preHandler: [requireRoles(["admin", "kho"])] }, async (request, reply) => {
    const body = request.body as {
      productId?: string;
      quantity?: number;
      unitCost?: number;
      referenceCode?: string;
      note?: string;
      items?: Array<{ productId?: string; quantity?: number; unitCost?: number; note?: string }>;
    };
    const hasBulkItems = Array.isArray(body.items) && body.items.length > 0;

    if (hasBulkItems) {
      const processedCount = await recordInventoryBulkTransaction({
        mode: "in",
        items: body.items!.map((item) => ({
          productId: String(item.productId ?? ""),
          quantity: Number(item.quantity ?? 0),
          unitCost: Number(item.unitCost ?? 0),
          note: item.note
        })),
        referenceCode: body.referenceCode,
        commonNote: body.note,
        createdBy: getRequester(request).id
      });
      return reply.send({ ok: true, count: processedCount });
    }

    await recordInventoryTransaction({
      productId: String(body.productId ?? ""),
      quantity: Number(body.quantity ?? 0),
      unitCost: Number(body.unitCost ?? 0),
      referenceCode: body.referenceCode,
      note: body.note,
      type: "in",
      createdBy: getRequester(request).id
    });
    return reply.send({ ok: true, count: 1 });
  });

  app.post("/v1/inventory/outbound", { preHandler: [requireRoles(["admin", "kho", "sales"])] }, async (request, reply) => {
    const body = request.body as {
      productId?: string;
      quantity?: number;
      referenceCode?: string;
      note?: string;
    };
    await recordInventoryTransaction({
      productId: String(body.productId ?? ""),
      quantity: Number(body.quantity ?? 0),
      referenceCode: body.referenceCode,
      note: body.note,
      type: "out",
      createdBy: getRequester(request).id
    });
    return reply.send({ ok: true });
  });

  app.post("/v1/inventory/bulk", { preHandler: [requireRoles(["admin", "kho"])] }, async (request, reply) => {
    const body = request.body as {
      mode?: "in" | "out" | "adjust";
      referenceCode?: string;
      note?: string;
      items?: Array<{ productId?: string; quantity?: number; unitCost?: number; note?: string }>;
    };
    const mode = (body.mode ?? "in") as "in" | "out" | "adjust";
    const items = Array.isArray(body.items) ? body.items : [];
    const processedCount = await recordInventoryBulkTransaction({
      mode,
      items: items.map((item) => ({
        productId: String(item.productId ?? ""),
        quantity: Number(item.quantity ?? 0),
        unitCost: Number(item.unitCost ?? 0),
        note: item.note
      })),
      referenceCode: body.referenceCode,
      commonNote: body.note,
      createdBy: getRequester(request).id
    });
    return reply.send({ ok: true, count: processedCount });
  });

  app.post("/v1/inventory/adjustment", { preHandler: [requireRoles(["admin", "kho"])] }, async (request, reply) => {
    const body = request.body as {
      productId?: string;
      targetStock?: number;
      referenceCode?: string;
      note?: string;
      items?: Array<{ productId?: string; targetStock?: number; note?: string }>;
    };
    const bulkItems =
      Array.isArray(body.items) && body.items.length > 0
        ? body.items
        : body.productId
          ? [{ productId: body.productId, targetStock: body.targetStock, note: body.note }]
          : [];
    const processedCount = await recordInventoryBulkTransaction({
      mode: "adjust",
      items: bulkItems.map((item) => ({
        productId: String(item.productId ?? ""),
        quantity: Number(item.targetStock ?? 0),
        note: item.note
      })),
      referenceCode: body.referenceCode,
      commonNote: body.note,
      createdBy: getRequester(request).id
    });
    return reply.send({ ok: true, count: processedCount });
  });

  app.post("/v1/inventory/mixed", { preHandler: [requireRoles(["admin", "kho"])] }, async (request, reply) => {
    const body = request.body as {
      referenceCode?: string;
      note?: string;
      items?: Array<{ mode?: "in" | "out" | "adjust"; productId?: string; quantity?: number; targetStock?: number; unitCost?: number; note?: string }>;
    };
    const items = Array.isArray(body.items) ? body.items : [];
    const processedCount = await recordInventoryMixedTransaction({
      items: items.map((item) => {
        const mode = item.mode ?? "in";
        return {
          mode,
          productId: String(item.productId ?? ""),
          quantity: mode === "adjust" ? Number(item.targetStock ?? item.quantity ?? 0) : Number(item.quantity ?? 0),
          unitCost: Number(item.unitCost ?? 0),
          note: item.note
        };
      }),
      referenceCode: body.referenceCode,
      commonNote: body.note,
      createdBy: getRequester(request).id
    });
    return reply.send({ ok: true, count: processedCount });
  });

  app.get("/v1/inventory/transactions", { preHandler: [requireRoles(["admin", "kho", "sales"])] }, async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? "100");
    return listInventoryTransactions(limit);
  });

  app.get("/v1/inventory/stock", { preHandler: [requireRoles(["admin", "kho", "sales"])] }, async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? "200");
    const safeLimit = Math.min(Math.max(limit, 1), 1000);
    const { rows } = await pool.query(
      `
        SELECT id, sku, name, category, stock, unit_price, updated_at
        FROM products
        ORDER BY stock ASC, updated_at DESC
        LIMIT $1
      `,
      [safeLimit]
    );
    return rows;
  });

  app.get("/v1/reports/revenue", { preHandler: [requireRoles(["admin", "sales"])] }, async (request, reply) => {
    const query = request.query as { from?: string; to?: string; groupBy?: "day" | "month"; channel?: string };
    const from = query.from ?? new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
    const to = query.to ?? new Date().toISOString();
    const groupBy = query.groupBy ?? "day";

    if (!["day", "month"].includes(groupBy)) {
      return reply.code(400).send({ error: "groupBy must be day or month" });
    }

    return getRevenueReport({
      from,
      to,
      groupBy,
      channel: query.channel
    });
  });

  app.get("/v1/shippings", { preHandler: [requireRoles(["admin", "sales", "kho"])] }, async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? "100");
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    const { rows } = await pool.query(
      `
        SELECT s.*, o.order_code, c.full_name AS customer_name
        FROM shipments s
        LEFT JOIN orders o ON o.id = s.order_id
        LEFT JOIN customers c ON c.id = o.customer_id
        ORDER BY s.updated_at DESC
        LIMIT $1
      `,
      [safeLimit]
    );
    return rows;
  });

  app.post("/v1/shippings", { preHandler: [requireRoles(["admin", "sales"])] }, async (request, reply) => {
    const body = request.body as {
      orderId?: string;
      shippingCode?: string;
      carrier?: string;
      serviceLevel?: string;
      recipientName?: string;
      recipientPhone?: string;
      recipientAddress?: string;
      shippingFee?: number;
      codAmount?: number;
      note?: string;
    };
    const shippingCode = String(body.shippingCode ?? `SHIP-${Date.now()}`);
    const carrier = String(body.carrier ?? "").trim();
    const recipientName = String(body.recipientName ?? "").trim();
    const recipientAddress = String(body.recipientAddress ?? "").trim();
    if (!carrier || !recipientName || !recipientAddress) {
      return reply.code(400).send({ error: "carrier, recipientName, recipientAddress are required" });
    }
    const result = await pool.query(
      `
        INSERT INTO shipments(
          order_id, shipping_code, carrier, service_level, recipient_name, recipient_phone, recipient_address,
          shipping_fee, cod_amount, status, note, created_at, updated_at
        )
        VALUES($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, NOW(), NOW())
        RETURNING *
      `,
      [
        body.orderId ? String(body.orderId) : null,
        shippingCode,
        carrier,
        String(body.serviceLevel ?? ""),
        recipientName,
        String(body.recipientPhone ?? ""),
        recipientAddress,
        Number(body.shippingFee ?? 0),
        Number(body.codAmount ?? 0),
        String(body.note ?? "")
      ]
    );
    return reply.code(201).send(result.rows[0]);
  });

  app.patch("/v1/shippings/:id/status", { preHandler: [requireRoles(["admin", "sales", "kho"])] }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as { status?: string; note?: string };
    const status = String(body.status ?? "").trim();
    if (!status) {
      return reply.code(400).send({ error: "status is required" });
    }
    const result = await pool.query(
      `
        UPDATE shipments
        SET status = $2,
            note = COALESCE($3, note),
            shipped_at = CASE WHEN $2 = 'shipped' THEN COALESCE(shipped_at, NOW()) ELSE shipped_at END,
            delivered_at = CASE WHEN $2 = 'delivered' THEN COALESCE(delivered_at, NOW()) ELSE delivered_at END,
            updated_at = NOW()
        WHERE id = $1::uuid
        RETURNING *
      `,
      [params.id, status, body.note ?? null]
    );
    if (result.rowCount === 0) {
      return reply.code(404).send({ error: "Shipping not found" });
    }
    return result.rows[0];
  });

  app.get("/v1/sync/dead-letters", { preHandler: [requireRoles(["admin"])] }, async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? "100");
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    const { rows } = await pool.query(
      `
        SELECT id, event_type, payload, reason, failed_at
        FROM sync_dead_letters
        ORDER BY failed_at DESC
        LIMIT $1
      `,
      [safeLimit]
    );
    return rows;
  });

  app.post("/v1/sync/pull", { preHandler: [requireRoles(["admin"])] }, async (request, reply) => {
    const body = request.body as { from?: string; to?: string; accountId?: string; accountIds?: string[] };
    const to = body?.to ?? new Date().toISOString();
    const from = body?.from ?? new Date(Date.now() - 15 * 60_000).toISOString();
    const accountIds = Array.isArray(body.accountIds)
      ? body.accountIds
      : body.accountId
        ? [body.accountId]
        : [];
    const allAccounts = await getNhanhAccounts();
    const selectedAccounts = accountIds.length > 0 ? allAccounts.filter((item) => accountIds.includes(item.id)) : allAccounts;
    if (selectedAccounts.length === 0) {
      return reply.code(400).send({ error: "No active nhanh account found" });
    }

    const invalidAccounts = selectedAccounts
      .filter((item) => !item.businessId || item.businessId.trim().length === 0)
      .map((item) => item.id);
    if (invalidAccounts.length > 0) {
      return reply.code(400).send({
        error: "Some nhanh accounts are missing businessId",
        accountIds: invalidAccounts
      });
    }

    let totalChanges = 0;
    for (const account of selectedAccounts) {
      const changes = await fetchNhanhChangesForAccount(account, from, to);
      for (const change of changes) {
        await enqueueEvent(change);
      }
      totalChanges += changes.length;
    }

    broadcast("sync.pull.enqueued", { count: totalChanges });
    return reply.send({ ok: true, count: totalChanges, accounts: selectedAccounts.length });
  });

  app.post("/v1/webhooks/nhanh", {
    config: {
      rateLimit: {
        max: env.WEBHOOK_RATE_LIMIT_MAX,
        timeWindow: env.WEBHOOK_RATE_LIMIT_WINDOW_MS
      }
    }
  }, async (request: WebhookRequest, reply: FastifyReply) => {
    const signature = request.headers["x-nhanh-signature"] as string | undefined;
    const rawBody = JSON.stringify(request.body ?? {});
    const accounts = await getNhanhAccounts();
    const bodyTokenCandidates = [
      request.body.webhooksVerifyToken,
      request.body.verifyToken,
      request.body.webhookVerifyToken,
      String(request.body.data?.webhooksVerifyToken ?? ""),
      String(request.body.data?.verifyToken ?? ""),
      String(request.body.data?.webhookVerifyToken ?? "")
    ]
      .map((item) => String(item ?? "").trim())
      .filter((item) => item.length > 0);

    const matchedAccount = accounts.find((item) => {
      if (verifyNhanhSignature(rawBody, signature, item.webhookSecret)) {
        return true;
      }
      return bodyTokenCandidates.includes(item.webhookSecret);
    });
    if (!matchedAccount) {
      webhookRejectedCounter.inc({ reason: "invalid_signature" });
      return reply.code(401).send({ error: "Invalid webhook signature" });
    }

    const payload: SyncEventPayload = {
      eventType: (request.body.eventType as SyncEventPayload["eventType"]) ?? "order.updated",
      resourceId: request.body.resourceId,
      changedAt: request.body.changedAt ?? new Date().toISOString(),
      data: {
        ...(request.body.data ?? {}),
        __nhanhAccountId: matchedAccount.id,
        __nhanhAccountName: matchedAccount.name
      }
    };
    const dedupeKey = `webhook:nhanh:${matchedAccount.id}:${signature ?? "none"}:${payload.resourceId ?? "none"}:${payload.changedAt}`;
    const dedupeOk = await redis.set(dedupeKey, "1", "EX", 300, "NX");
    if (!dedupeOk) {
      webhookRejectedCounter.inc({ reason: "duplicate" });
      return reply.send({ ok: true, deduplicated: true });
    }

    await pool.query(
      `
        INSERT INTO webhook_logs(provider, event_type, signature, payload)
        VALUES ('nhanh.vn', $1, $2, $3::jsonb)
      `,
      [payload.eventType, signature ?? "", JSON.stringify({ ...payload, accountId: matchedAccount.id })]
    );

    await enqueueEvent(payload);
    webhookAcceptedCounter.inc({ event_type: payload.eventType });
    broadcast("webhook.received", { eventType: payload.eventType, resourceId: payload.resourceId });
    return reply.send({ ok: true });
  });
}
