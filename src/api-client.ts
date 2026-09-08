import { getApiBaseUrl } from "./env-config.js";
import {
  parseMoneyEnvironment,
  RILL_ENVIRONMENT_HEADER,
  type RillMoneyEnvironment,
} from "@rill/shared";

export { wrapToolResult, formatToolResult } from "./api-response.js";

type ApiCallOptions = {
  method: string;
  path: string;
  body?: unknown;
  apiKey?: string | null;
  ownerJwt?: string | null;
  sellerKey?: string | null;
  idempotencyKey?: string;
  headers?: Record<string, string>;
  /** Owner JWT money mode. VW/seller keys encode mode in the key prefix. */
  environment?: RillMoneyEnvironment | string | null;
};

function resolveCallEnvironment(
  explicit?: RillMoneyEnvironment | string | null,
): RillMoneyEnvironment {
  if (explicit != null && String(explicit).trim()) {
    return parseMoneyEnvironment(String(explicit), "live");
  }
  return parseMoneyEnvironment(
    process.env.RILL_ENVIRONMENT ?? process.env.RILL_MONEY_ENVIRONMENT,
    "live",
  );
}

export async function callRillApi(
  options: ApiCallOptions,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const base = getApiBaseUrl();
  const url = `${base}${options.path.startsWith("/") ? options.path : `/${options.path}`}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "rill-mcp/0.1.0",
    ...options.headers,
  };
  if (!headers[RILL_ENVIRONMENT_HEADER]) {
    headers[RILL_ENVIRONMENT_HEADER] = resolveCallEnvironment(
      options.environment,
    );
  }
  if (options.ownerJwt) {
    headers.Authorization = `Bearer ${options.ownerJwt}`;
  } else if (options.apiKey) {
    headers.Authorization = `Bearer ${options.apiKey}`;
    headers["x-rill-vw-key"] = options.apiKey;
  } else if (options.sellerKey) {
    headers.Authorization = `Bearer ${options.sellerKey}`;
    headers["x-rill-seller-key"] = options.sellerKey;
  }
  if (options.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  try {
    const res = await fetch(url, { method: options.method, headers, body });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* plain */
    }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: {
        ok: false,
        error: {
          code: "network_error",
          message:
            err instanceof Error ? err.message : "Network request failed",
        },
      },
    };
  }
}
