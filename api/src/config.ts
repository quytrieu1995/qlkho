import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  API_PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  WEBHOOK_RATE_LIMIT_MAX: z.coerce.number().default(120),
  WEBHOOK_RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  AUTH_BOOTSTRAP_TOKEN: z.string().min(1).default("change-bootstrap-token"),
  NHANH_OAUTH_STATE_SECRET: z.string().min(16).default("change-nhanh-oauth-state-secret"),
  NHANH_OAUTH_STATE_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  NHANH_APP_ID: z.string().default(""),
  NHANH_SECRET_KEY: z.string().default(""),
  NHANH_BUSINESS_ID: z.string().default(""),
  NHANH_ACCESS_TOKEN: z.string().default(""),
  NHANH_BASE_URL: z.string().url().default("https://pos.open.nhanh.vn"),
  NHANH_WEBHOOK_SECRET: z.string().default("")
});

export const env = schema.parse(process.env);
