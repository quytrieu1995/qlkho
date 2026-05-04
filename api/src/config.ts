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
  NHANH_APP_ID: z.string().default(""),
  NHANH_ACCESS_TOKEN: z.string().default(""),
  NHANH_BASE_URL: z.string().url().default("https://open.nhanh.vn"),
  NHANH_WEBHOOK_SECRET: z.string().default("")
});

export const env = schema.parse(process.env);
