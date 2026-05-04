import crypto from "crypto";
import fetch from "node-fetch";
import { env } from "../config.js";
import type { SyncEventPayload } from "../types.js";

interface NhanhApiResponse<T> {
  code: number;
  messages?: string;
  data: T;
}

export interface NhanhAccountConfig {
  id: string;
  name: string;
  appId: string;
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
  if (!env.NHANH_APP_ID || !env.NHANH_ACCESS_TOKEN || !env.NHANH_WEBHOOK_SECRET) {
    return null;
  }
  return {
    id: "env-default",
    name: "Env Default",
    appId: env.NHANH_APP_ID,
    accessToken: env.NHANH_ACCESS_TOKEN,
    webhookSecret: env.NHANH_WEBHOOK_SECRET,
    baseUrl: env.NHANH_BASE_URL
  };
}

export async function fetchNhanhChangesForAccount(account: NhanhAccountConfig, from: string, to: string): Promise<SyncEventPayload[]> {
  const url = `${account.baseUrl}/api/order/index`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      version: "2.0",
      appId: account.appId,
      accessToken: account.accessToken,
      data: {
        page: 1,
        limit: 200,
        "updatedDateFrom": from,
        "updatedDateTo": to
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Nhanh API failed with status ${response.status}`);
  }

  const payload = (await response.json()) as NhanhApiResponse<Record<string, unknown>>;
  if (payload.code !== 1) {
    throw new Error(payload.messages ?? "Nhanh API returned error");
  }

  const orders = (payload.data?.orders ?? []) as Array<Record<string, unknown>>;
  return orders.map((order) => ({
    eventType: "order.updated",
    resourceId: String(order.id ?? ""),
    changedAt: String(order.updatedDate ?? new Date().toISOString()),
    data: {
      ...order,
      __nhanhAccountId: account.id,
      __nhanhAccountName: account.name
    }
  }));
}
