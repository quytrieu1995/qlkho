import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import fastifyJwt from "@fastify/jwt";
import fastifyRateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import websocket from "@fastify/websocket";
import { env } from "./config.js";
import { registerRoutes } from "./routes.js";
import { registerSocket } from "./realtime.js";
import { pool } from "./db.js";
import { redis } from "./redis.js";
import { broadcast } from "./realtime.js";
import { metricsRegistry } from "./metrics.js";

const app = Fastify({
  logger: true
});

await app.register(cors, { origin: true, credentials: true });
await app.register(helmet, { global: true });
await app.register(sensible);
await app.register(fastifyJwt, {
  secret: env.JWT_SECRET
});
await app.register(fastifyRateLimit, {
  global: false
});
await app.register(websocket);
app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
  try {
    const rawBody = typeof body === "string" ? body : body.toString("utf8");
    (request as FastifyRequest & { rawBody?: string }).rawBody = rawBody;
    done(null, JSON.parse(rawBody));
  } catch (error) {
    done(error as Error);
  }
});

const subscriber = redis.duplicate();
await subscriber.subscribe("sales-events");
subscriber.on("message", (_channel, raw) => {
  try {
    const rawMessage = typeof raw === "string" ? raw : raw.toString("utf8");
    const packet = JSON.parse(rawMessage) as { event?: string; payload?: Record<string, unknown> };
    broadcast(packet.event ?? "sync.updated", packet.payload ?? {});
  } catch {
    const fallbackMessage = typeof raw === "string" ? raw : raw.toString("utf8");
    broadcast("sync.updated", { raw: fallbackMessage });
  }
});

app.get("/ws", { websocket: true }, (connection) => {
  registerSocket(connection.socket);
  connection.socket.send(JSON.stringify({ event: "connected", payload: { ok: true } }));
});

app.get("/metrics", async (_request, reply) => {
  reply.header("Content-Type", metricsRegistry.contentType);
  return metricsRegistry.metrics();
});

await registerRoutes(app);

const shutdown = async (): Promise<void> => {
  await app.close();
  await subscriber.quit();
  await pool.end();
  await redis.quit();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
