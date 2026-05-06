import fetch from "node-fetch";

export type NhanhV3Service = "pos" | "vpage";

const DEFAULT_BASE_URL: Record<NhanhV3Service, string> = {
  pos: "https://pos.open.nhanh.vn",
  vpage: "https://vpage.open.nhanh.vn"
};

export interface NhanhV3Credentials {
  appId: string;
  secretKey: string;
  service?: NhanhV3Service;
  baseUrl?: string;
}

export interface NhanhV3Connection {
  businessId: string;
  accessToken: string;
}

export interface NhanhV3AccessTokenData {
  accessToken: string;
  version: string;
  expiredAt: number;
  businessId: number;
  depotIds?: Array<number | string>;
  pageIds?: Array<number | string>;
  permissions?: string[];
}

interface NhanhV3Response<T> {
  code: number;
  errorCode?: string;
  message?: string;
  messages?: unknown;
  data?: T;
  warning?: unknown;
}

export interface NhanhV3RequestOptions {
  endpoint: string;
  body?: unknown;
}

export interface NhanhV3ErrorDetails {
  httpStatus?: number;
  errorCode?: string;
  messages: string[];
  payload?: unknown;
}

export class NhanhV3Error extends Error {
  public readonly details: NhanhV3ErrorDetails;

  constructor(message: string, details: NhanhV3ErrorDetails) {
    super(message);
    this.name = "NhanhV3Error";
    this.details = details;
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeMessages(messages: unknown): string[] {
  if (!messages) {
    return [];
  }

  if (typeof messages === "string") {
    return [messages];
  }

  if (Array.isArray(messages)) {
    return messages.map((item) => String(item));
  }

  if (typeof messages === "object") {
    return Object.entries(messages as Record<string, unknown>).map(([key, value]) => `${key}: ${String(value)}`);
  }

  return [String(messages)];
}

function resolveBaseUrl(credentials: NhanhV3Credentials): string {
  if (credentials.baseUrl && credentials.baseUrl.trim().length > 0) {
    return trimSlash(credentials.baseUrl.trim());
  }
  return DEFAULT_BASE_URL[credentials.service ?? "pos"];
}

function buildUrl(baseUrl: string, endpoint: string, query: Record<string, string>): string {
  const normalizedEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const url = new URL(`${trimSlash(baseUrl)}/v3.0${normalizedEndpoint}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function parseJsonSafely(response: Awaited<ReturnType<typeof fetch>>): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

export function createNhanhV3Client(credentials: NhanhV3Credentials) {
  const baseUrl = resolveBaseUrl(credentials);

  const withAppId = (extra?: Record<string, string>): Record<string, string> => ({
    appId: credentials.appId,
    ...(extra ?? {})
  });

  const withAuthHeaders = (accessToken: string): Record<string, string> => ({
    "Content-Type": "application/json",
    Authorization: accessToken
  });

  async function getAccessTokenFromCode(accessCode: string): Promise<NhanhV3AccessTokenData> {
    const url = buildUrl(baseUrl, "/app/getaccesstoken", withAppId());

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        accessCode,
        secretKey: credentials.secretKey
      })
    });

    const payload = (await parseJsonSafely(response)) as NhanhV3Response<NhanhV3AccessTokenData>;
    if (!response.ok || payload.code !== 1 || !payload.data) {
      const messages = normalizeMessages(payload.messages ?? payload.message);
      throw new NhanhV3Error("Unable to exchange accessCode for accessToken", {
        httpStatus: response.status,
        errorCode: payload.errorCode,
        messages,
        payload
      });
    }

    return payload.data;
  }

  async function checkAccessToken(connection: NhanhV3Connection): Promise<NhanhV3AccessTokenData> {
    const url = buildUrl(baseUrl, "/app/checkaccesstoken", withAppId({ businessId: connection.businessId }));

    const response = await fetch(url, {
      method: "POST",
      headers: withAuthHeaders(connection.accessToken),
      body: JSON.stringify({
        secretKey: credentials.secretKey
      })
    });

    const payload = (await parseJsonSafely(response)) as NhanhV3Response<NhanhV3AccessTokenData>;
    if (!response.ok || payload.code !== 1 || !payload.data) {
      const messages = normalizeMessages(payload.messages ?? payload.message);
      throw new NhanhV3Error("Nhanh accessToken is invalid", {
        httpStatus: response.status,
        errorCode: payload.errorCode,
        messages,
        payload
      });
    }

    return payload.data;
  }

  async function request<T>(connection: NhanhV3Connection, options: NhanhV3RequestOptions): Promise<T> {
    const url = buildUrl(baseUrl, options.endpoint, withAppId({ businessId: connection.businessId }));

    const response = await fetch(url, {
      method: "POST",
      headers: withAuthHeaders(connection.accessToken),
      body: JSON.stringify(options.body ?? {})
    });

    const payload = (await parseJsonSafely(response)) as NhanhV3Response<T>;
    if (!response.ok || payload.code !== 1) {
      const messages = normalizeMessages(payload.messages ?? payload.message);
      throw new NhanhV3Error(`Nhanh request failed: ${options.endpoint}`, {
        httpStatus: response.status,
        errorCode: payload.errorCode,
        messages,
        payload
      });
    }

    return (payload.data ?? ({} as T)) as T;
  }

  return {
    getAccessTokenFromCode,
    checkAccessToken,
    request
  };
}
