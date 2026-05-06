import crypto from "crypto";
import { env } from "../config.js";
import { createNhanhV3Client } from "./nhanh-v3.js";
import type { SyncEventPayload } from "../types.js";

export interface NhanhAccountConfig {
  id: string;
  name: string;
  appId: string;
  businessId: string;
  accessToken: string;
  webhookSecret: string;
  baseUrl: string;
}

function signPayload(rawBody: string, webhookSecret: string): string {
  return crypto
    .createHmac("sha256", webhookSecret)
    .update(rawBody, "utf8")
    .digest("hex");
}

export function verifyNhanhSignature(rawBody: string, incomingSignature: string | undefined, webhookSecret: string): boolean {
  if (!incomingSignature) {
    return false;
  }
  const expected = signPayload(rawBody, webhookSecret);
  const a = Buffer.from(expected);
  const b = Buffer.from(incomingSignature);
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export function getDefaultNhanhAccountFromEnv(): NhanhAccountConfig | null {
  if (!env.NHANH_APP_ID || !env.NHANH_BUSINESS_ID || !env.NHANH_ACCESS_TOKEN || !env.NHANH_WEBHOOK_SECRET) {
    return null;
  }
  return {
    id: "env-default",
    name: "Env Default",
    appId: env.NHANH_APP_ID,
    businessId: env.NHANH_BUSINESS_ID,
    accessToken: env.NHANH_ACCESS_TOKEN,
    webhookSecret: env.NHANH_WEBHOOK_SECRET,
    baseUrl: env.NHANH_BASE_URL
  };
}

function extractOrders(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) {
    return data as Array<Record<string, unknown>>;
  }

  if (!data || typeof data !== "object") {
    return [];
  }

  const obj = data as Record<string, unknown>;
  const keys = ["orders", "items", "records", "list"];
  for (const key of keys) {
    if (Array.isArray(obj[key])) {
      return obj[key] as Array<Record<string, unknown>>;
    }
  }

  return [];
}

function extractNextPaginator(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const paginator = (data as Record<string, unknown>).paginator;
  if (!paginator || typeof paginator !== "object") {
    return null;
  }
  const next = (paginator as Record<string, unknown>).next;
  if (!next || typeof next !== "object") {
    return null;
  }
  return next as Record<string, unknown>;
}

export async function fetchNhanhChangesForAccount(account: NhanhAccountConfig, from: string, to: string): Promise<SyncEventPayload[]> {
  const client = createNhanhV3Client({
    appId: account.appId,
    secretKey: "",
    baseUrl: account.baseUrl
  });

  const changes: SyncEventPayload[] = [];
  let next: Record<string, unknown> | undefined;
  let page = 0;
  while (page < 100) {
    page += 1;
    const data = await client.request<Record<string, unknown>>(
      {
        businessId: account.businessId,
        accessToken: account.accessToken
      },
      {
        endpoint: "/order/list",
        body: {
          filters: {
            updatedAtFrom: from,
            updatedAtTo: to
          },
          paginator: {
            size: 100,
            sort: {
              updatedAt: "asc"
            },
            ...(next ? { next } : {})
          }
        }
      }
    );

    const orders = extractOrders(data);
    for (const order of orders) {
      changes.push({
        eventType: "order.updated",
        resourceId: String(order.id ?? ""),
        changedAt: String(order.updatedAt ?? order.updatedDate ?? new Date().toISOString()),
        data: {
          ...order,
          __nhanhAccountId: account.id,
          __nhanhAccountName: account.name
        }
      });
    }

    const nextValue = extractNextPaginator(data);
    if (!nextValue) {
      break;
    }
    next = nextValue;
  }

  return changes;
}
