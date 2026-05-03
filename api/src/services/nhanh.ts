import crypto from "crypto";
import fetch from "node-fetch";
import { env } from "../config.js";
import type { SyncEventPayload } from "../types.js";

interface NhanhApiResponse<T> {
  code: number;
  messages?: string;
  data: T;
}

function signPayload(rawBody: string): string {
  return crypto
    .createHmac("sha256", env.NHANH_WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("hex");
}

export function verifyNhanhSignature(rawBody: string, incomingSignature?: string): boolean {
  if (!incomingSignature) {
    return false;
  }
  const expected = signPayload(rawBody);
  const a = Buffer.from(expected);
  const b = Buffer.from(incomingSignature);
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export async function fetchNhanhChanges(from: string, to: string): Promise<SyncEventPayload[]> {
  const url = `${env.NHANH_BASE_URL}/api/order/index`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      version: "2.0",
      appId: env.NHANH_APP_ID,
      accessToken: env.NHANH_ACCESS_TOKEN,
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
    data: order
  }));
}
