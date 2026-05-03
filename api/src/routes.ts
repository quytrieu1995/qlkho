import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { syncQueue } from "./queue.js";
import { pool } from "./db.js";
import { verifyNhanhSignature, fetchNhanhChanges } from "./services/nhanh.js";
import {
  getDashboardMetrics,
  getRevenueReport,
  listInventoryTransactions,
  listOrders,
  listProducts,
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
    data?: Record<string, unknown>;
  };
}>;

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

  app.get("/v1/products", { preHandler: [requireRoles(["admin", "sales", "kho"])] }, async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? "100");
    return listProducts(limit);
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

  app.post("/v1/inventory/inbound", { preHandler: [requireRoles(["admin", "kho"])] }, async (request, reply) => {
    const body = request.body as {
      productId?: string;
      quantity?: number;
      unitCost?: number;
      referenceCode?: string;
      note?: string;
    };
    await recordInventoryTransaction({
      productId: String(body.productId ?? ""),
      quantity: Number(body.quantity ?? 0),
      unitCost: Number(body.unitCost ?? 0),
      referenceCode: body.referenceCode,
      note: body.note,
      type: "in",
      createdBy: getRequester(request).id
    });
    return reply.send({ ok: true });
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

  app.get("/v1/inventory/transactions", { preHandler: [requireRoles(["admin", "kho", "sales"])] }, async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? "100");
    return listInventoryTransactions(limit);
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
    const body = request.body as { from?: string; to?: string };
    const to = body?.to ?? new Date().toISOString();
    const from = body?.from ?? new Date(Date.now() - 15 * 60_000).toISOString();

    const changes = await fetchNhanhChanges(from, to);
    for (const change of changes) {
      await enqueueEvent(change);
    }

    broadcast("sync.pull.enqueued", { count: changes.length });
    return reply.send({ ok: true, count: changes.length });
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
    const rawBody = String(
      (request as FastifyRequest & { rawBody?: string }).rawBody ?? JSON.stringify(request.body ?? {})
    );
    const isValid = verifyNhanhSignature(rawBody, signature);
    if (!isValid) {
      webhookRejectedCounter.inc({ reason: "invalid_signature" });
      return reply.code(401).send({ error: "Invalid webhook signature" });
    }

    const payload: SyncEventPayload = {
      eventType: (request.body.eventType as SyncEventPayload["eventType"]) ?? "order.updated",
      resourceId: request.body.resourceId,
      changedAt: request.body.changedAt ?? new Date().toISOString(),
      data: request.body.data ?? {}
    };
    const dedupeKey = `webhook:nhanh:${signature ?? "none"}:${payload.resourceId ?? "none"}:${payload.changedAt}`;
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
      [payload.eventType, signature ?? "", JSON.stringify(payload)]
    );

    await enqueueEvent(payload);
    webhookAcceptedCounter.inc({ event_type: payload.eventType });
    broadcast("webhook.received", { eventType: payload.eventType, resourceId: payload.resourceId });
    return reply.send({ ok: true });
  });
}
