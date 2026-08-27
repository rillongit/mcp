export function parseBearerCsvTokens(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const tokens = raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  for (const token of tokens) {
    if (seen.has(token)) {
      throw new Error("RILL_MCP_BEARER_TOKEN contains duplicate token segments");
    }
    seen.add(token);
  }
  return tokens;
}

export function getApiBaseUrl(): string {
  return (
    process.env.RILL_API_URL?.trim() ||
    process.env.API_URL?.trim() ||
    "http://localhost:3001"
  ).replace(/\/$/, "");
}

export function getAppBaseUrl(): string {
  return (
    process.env.RILL_APP_URL?.trim() ||
    process.env.APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

export function getOptionalVwKey(): string | null {
  return (
    process.env.RILL_VW_KEY?.trim() ||
    process.env.RILL_API_KEY?.trim() ||
    null
  );
}

export function getOptionalOwnerJwt(): string | null {
  return process.env.RILL_OWNER_JWT?.trim() || null;
}

export function getOptionalSellerKey(): string | null {
  return process.env.RILL_SELLER_KEY?.trim() || null;
}

/** Default money mode for owner JWT MCP calls (live|test). */
export function getOptionalMoneyEnvironment(): "live" | "test" {
  const raw =
    process.env.RILL_ENVIRONMENT?.trim() ||
    process.env.RILL_MONEY_ENVIRONMENT?.trim() ||
    "live";
  return raw.toLowerCase() === "test" ? "test" : "live";
}

export function getMcpHttpBearerTokens(): string[] {
  return parseBearerCsvTokens(process.env.RILL_MCP_BEARER_TOKEN);
}

export function mcpHttpPort(): number {
  const p = Number(process.env.PORT ?? process.env.RILL_MCP_PORT ?? 3101);
  return Number.isFinite(p) ? p : 3101;
}

export function getMcpPublicOrigin(): string {
  const raw =
    process.env.RILL_MCP_PUBLIC_URL?.trim()?.replace(/\/$/, "") ||
    "https://mcp.userill.com";
  // Origin without trailing /mcp path segment (resource metadata appends /mcp).
  return raw.replace(/\/mcp$/i, "");
}

export function merchantOAuthEnabled(): boolean {
  return process.env.RILL_MERCHANT_OAUTH_ENABLED === "true";
}

function internalApiKey(): string | null {
  return (
    process.env.INTERNAL_API_KEY?.trim() ||
    process.env.CRON_SECRET?.trim() ||
    null
  );
}

export function mcpRequireAuth(): boolean {
  const raw = process.env.RILL_MCP_REQUIRE_AUTH?.trim().toLowerCase();
  if (raw === "true" || raw === "on" || raw === "1") return true;
  if (raw === "false" || raw === "off" || raw === "0") return false;
  return process.env.NODE_ENV === "production";
}

export function getTransportMode(): "stdio" | "http" {
  return process.env.RILL_MCP_TRANSPORT === "http" ? "http" : "stdio";
}

export function mcpMaxSessions(): number {
  const n = Number(process.env.RILL_MCP_MAX_SESSIONS ?? "2000");
  return Number.isFinite(n) && n > 0 ? n : 2000;
}

export function mcpSessionTtlMs(): number {
  const n = Number(process.env.RILL_MCP_SESSION_TTL_MS ?? `${30 * 60_000}`);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60_000;
}

export function mcpRateLimitRpm(): number {
  const n = Number(process.env.RILL_MCP_RATE_LIMIT_RPM ?? "120");
  return Number.isFinite(n) && n >= 0 ? n : 120;
}

export function mcpMaxBodyBytes(): number {
  const n = Number(process.env.RILL_MCP_MAX_BODY_BYTES ?? `${1 * 1024 * 1024}`);
  return Number.isFinite(n) && n > 0 ? n : 1 * 1024 * 1024;
}

export function mcpListenHost(): string {
  return process.env.RILL_MCP_HOST?.trim() || "0.0.0.0";
}

export function getMcpReadinessChecks(): {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
} {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const apiUrl = getApiBaseUrl();
  checks.push({
    name: "api_url",
    ok: Boolean(apiUrl),
    detail: apiUrl ? undefined : "RILL_API_URL missing",
  });

  if (mcpRequireAuth()) {
    const tokens = getMcpHttpBearerTokens();
    const transportOk = tokens.length > 0;
    checks.push({
      name: "mcp_require_auth_bearer",
      ok: transportOk,
      detail: transportOk
        ? undefined
        : "RILL_MCP_BEARER_TOKEN required when RILL_MCP_REQUIRE_AUTH=true",
    });
  }

  if (merchantOAuthEnabled()) {
    const keyOk = Boolean(internalApiKey());
    checks.push({
      name: "oauth_internal_api_key",
      ok: keyOk,
      detail: keyOk
        ? undefined
        : "INTERNAL_API_KEY required when RILL_MERCHANT_OAUTH_ENABLED=true",
    });
  }

  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}

export function ensureProductionBearer(): void {
  if (!mcpRequireAuth()) return;
  if (getMcpHttpBearerTokens().length > 0) return;
  console.error(
    "[rill-mcp] FATAL: RILL_MCP_BEARER_TOKEN is required when RILL_MCP_REQUIRE_AUTH=true",
  );
  process.exit(1);
}
