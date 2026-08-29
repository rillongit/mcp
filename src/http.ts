import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  hostHeaderValidation,
  localhostHostValidation,
} from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { MCP_TOOL_NAMES } from "@rill/shared";
import { getMcpBrandText, printMcpConsoleBrand } from "./console-brand.js";
import {
  getApiBaseUrl,
  getMcpAllowedHosts,
  getMcpHttpBearerTokens,
  getMcpPublicOrigin,
  getMcpReadinessChecks,
  getOptionalMoneyEnvironment,
  mcpHttpPort,
  mcpListenHost,
  mcpMaxBodyBytes,
  mcpMaxSessions,
  mcpRateLimitRpm,
  mcpRequireAuth,
  mcpSessionTtlMs,
  mcpTrustProxy,
  mcpTrustedProxyHops,
  merchantOAuthEnabled,
} from "./env-config.js";
import { introspectOAuthAccessToken } from "./oauth-introspect.js";
import { buildProtectedResourceMetadata } from "./oauth-metadata.js";
import {
  createRillMcpServer,
  type McpToolSet,
  type SessionKeys,
} from "./register-tools.js";
import { McpSessionRegistry } from "./session-registry.js";

function extractKey(header: string | undefined, prefix: string): string | null {
  if (!header) return null;
  const raw = header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim();
  return raw.startsWith(prefix) ? raw : null;
}

function extractTransportBearer(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Owner Supabase JWT (eyJ…) or OAuth access token (rill_oat_*), not VW/seller keys. */
function extractOwnerJwt(header: string | undefined): string | null {
  if (!header) return null;
  const raw = header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim();
  if (!raw || raw.startsWith("rill_vw_") || raw.startsWith("rill_sk_")) {
    return null;
  }
  if (raw.startsWith("eyJ") || raw.startsWith("rill_oat_")) return raw;
  return null;
}

function extractOAuthAccessToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const raw = auth.slice(7).trim();
  return raw.startsWith("rill_oat_") ? raw : null;
}

function extractPresentedCredential(req: Request): string | null {
  return (
    extractTransportBearer(req.headers.authorization) ||
    firstHeader(req.headers["x-rill-vw-key"])?.trim() ||
    firstHeader(req.headers["x-rill-seller-key"])?.trim() ||
    firstHeader(req.headers["x-rill-owner-jwt"])?.trim() ||
    firstHeader(req.headers["x-rill-api-key"])?.trim() ||
    null
  );
}

function sessionCredentialFromHeaders(req: Request): {
  vw: string | null;
  sk: string | null;
  jwt: string | null;
} {
  const generic = firstHeader(req.headers["x-rill-api-key"]);
  const vw =
    extractKey(req.headers.authorization, "rill_vw_") ||
    extractKey(firstHeader(req.headers["x-rill-vw-key"]), "rill_vw_") ||
    extractKey(generic, "rill_vw_");
  const sk =
    extractKey(req.headers.authorization, "rill_sk_") ||
    extractKey(firstHeader(req.headers["x-rill-seller-key"]), "rill_sk_") ||
    extractKey(generic, "rill_sk_");
  const jwt =
    extractOwnerJwt(req.headers.authorization) ||
    extractOwnerJwt(firstHeader(req.headers["x-rill-owner-jwt"]));
  return { vw, sk, jwt };
}

function adoptSessionKeysFromHeaders(keys: SessionKeys, req: Request): void {
  const { vw, sk, jwt } = sessionCredentialFromHeaders(req);
  if (vw) keys.setVwKey(vw);
  if (sk) keys.setSellerKey?.(sk);
  if (jwt) keys.setOwnerJwt?.(jwt);
  const envHeader = req.headers["x-rill-environment"];
  const envRaw = Array.isArray(envHeader) ? envHeader[0] : envHeader;
  const env = envRaw?.trim().toLowerCase();
  if (env === "live" || env === "test") {
    keys.setEnvironment?.(env);
  }
}

function bearerMatches(presented: string, tokens: string[]): boolean {
  const buf = Buffer.from(presented);
  for (const token of tokens) {
    const tbuf = Buffer.from(token);
    if (buf.length === tbuf.length && timingSafeEqual(buf, tbuf)) {
      return true;
    }
  }
  return false;
}

function normalizeIp(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === "unknown") return null;
  if (trimmed.startsWith("::ffff:")) return trimmed.slice("::ffff:".length);
  return trimmed;
}

/** Prefer CF-Connecting-IP; else rightmost trusted XFF hop; else socket peer. */
function clientIp(req: Request): string {
  if (mcpTrustProxy()) {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string") {
      const normalized = normalizeIp(cf);
      if (normalized) return normalized;
    }
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length > 0) {
      const parts = forwarded
        .split(",")
        .map((part) => normalizeIp(part))
        .filter((part): part is string => Boolean(part));
      if (parts.length > 0) {
        const hops = mcpTrustedProxyHops();
        const index = Math.max(0, parts.length - hops);
        return parts[index] ?? parts[parts.length - 1]!;
      }
    }
  }
  return normalizeIp(req.socket.remoteAddress ?? "") ?? "unknown";
}

type RateBucket = { count: number; windowStart: number };

type RateLimitDecision =
  | {
      ok: true;
      limit: number;
      remaining: number;
      resetAt: number;
    }
  | {
      ok: false;
      limit: number;
      remaining: 0;
      resetAt: number;
      retryAfterSec: number;
    };

function applyMcpRateLimitHeaders(
  res: Response,
  decision: RateLimitDecision,
): void {
  const resetDelaySec = Math.max(
    0,
    Math.ceil((decision.resetAt - Date.now()) / 1000),
  );
  res.setHeader("X-RateLimit-Limit", String(decision.limit));
  res.setHeader("X-RateLimit-Remaining", String(decision.remaining));
  res.setHeader(
    "X-RateLimit-Reset",
    String(Math.floor(decision.resetAt / 1000)),
  );
  res.setHeader("RateLimit-Limit", String(decision.limit));
  res.setHeader("RateLimit-Remaining", String(decision.remaining));
  res.setHeader("RateLimit-Reset", String(resetDelaySec));
  res.setHeader("RateLimit-Policy", `${decision.limit};w=60`);
  res.setHeader(
    "RateLimit",
    `default;q=${decision.limit};r=${decision.remaining};t=${resetDelaySec}`,
  );
}

function checkMcpRateLimit(
  buckets: Map<string, RateBucket>,
  ip: string,
): RateLimitDecision {
  const rpm = mcpRateLimitRpm();
  const now = Date.now();
  const windowMs = 60_000;
  if (rpm <= 0) {
    return { ok: true, limit: 0, remaining: 0, resetAt: now + windowMs };
  }
  let b = buckets.get(ip);
  if (!b || now - b.windowStart >= windowMs) {
    b = { count: 0, windowStart: now };
    buckets.set(ip, b);
  }
  b.count += 1;
  const resetAt = b.windowStart + windowMs;
  if (b.count > rpm) {
    const retryAfterSec = Math.max(1, Math.ceil((resetAt - now) / 1000));
    return {
      ok: false,
      limit: rpm,
      remaining: 0,
      resetAt,
      retryAfterSec,
    };
  }
  return {
    ok: true,
    limit: rpm,
    remaining: Math.max(0, rpm - b.count),
    resetAt,
  };
}

function oauthChallenge(error?: string): string {
  const metadataUrl = `${getMcpPublicOrigin()}/.well-known/oauth-protected-resource/mcp`;
  return error
    ? `Bearer resource_metadata="${metadataUrl}", error="${error}"`
    : `Bearer resource_metadata="${metadataUrl}"`;
}

function sessionIdFromRequest(req: Request): string | undefined {
  const sessionHeader = req.headers["mcp-session-id"];
  return Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
}

/** Browser / curl human GETs — not Streamable HTTP SSE or session resumes. */
function isHumanLandingGet(req: Request): boolean {
  if (req.method !== "GET") return false;
  if (sessionIdFromRequest(req)) return false;
  if (req.headers["mcp-protocol-version"]) return false;
  const accept = String(req.headers.accept ?? "");
  if (accept.includes("text/event-stream")) return false;
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    return false;
  }
  return true;
}

function sendMcpBrandPage(res: Response): void {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.status(200).send(getMcpBrandText());
}

function maybeServeMcpLanding(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (isHumanLandingGet(req)) {
    sendMcpBrandPage(res);
    return;
  }
  next();
}

function mcpGuestAuthMiddleware(
  _req: Request,
  _res: Response,
  next: NextFunction,
): void {
  next();
}

async function mcpAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const tokens = getMcpHttpBearerTokens();
  const presented = extractPresentedCredential(req);

  if (
    presented &&
    tokens.length > 0 &&
    bearerMatches(presented, tokens)
  ) {
    next();
    return;
  }

  const { vw, sk, jwt } = sessionCredentialFromHeaders(req);
  if (vw || sk || (jwt && jwt.startsWith("eyJ"))) {
    next();
    return;
  }

  const oauthToken = extractOAuthAccessToken(req);
  if (oauthToken) {
    const intro = await introspectOAuthAccessToken(oauthToken);
    if (intro.active) {
      next();
      return;
    }
    if (merchantOAuthEnabled()) {
      res.setHeader("WWW-Authenticate", oauthChallenge("invalid_token"));
      res.status(401).json({
        error: "Unauthorized",
        error_code: "invalid_oauth_token",
        message: "OAuth access token is invalid, expired, or revoked.",
      });
      return;
    }
  }

  if (!mcpRequireAuth()) {
    next();
    return;
  }

  res.setHeader("WWW-Authenticate", oauthChallenge());
  res.status(401).json({
    error: "Unauthorized",
    error_code: presented ? "invalid_credentials" : "missing_credentials",
    message:
      "Send Authorization: Bearer rill_oat_…, rill_vw_*/rill_sk_*, owner JWT, or transport bearer. Guest tools: /mcp/guest.",
  });
}

export function createHttpApplication(): Express {
  const registry = new McpSessionRegistry(mcpMaxSessions(), mcpSessionTtlMs());
  registry.startPeriodicPrune();
  const rateBuckets = new Map<string, RateBucket>();

  const app = express();
  app.use(express.json({ limit: mcpMaxBodyBytes() }));

  if (mcpTrustProxy()) {
    app.set("trust proxy", 1);
  }

  const listenHost = mcpListenHost();
  const allowedHosts = getMcpAllowedHosts();
  if (allowedHosts.length > 0) {
    app.use(hostHeaderValidation(allowedHosts));
  } else {
    const localhostHosts = ["127.0.0.1", "localhost", "::1"];
    if (localhostHosts.includes(listenHost)) {
      app.use(localhostHostValidation());
    } else if (listenHost === "0.0.0.0" || listenHost === "::") {
      console.warn(
        `[rill-mcp] Binding to ${listenHost} without RILL_MCP_ALLOWED_HOSTS; use TLS in production (set RILL_MCP_REQUIRE_AUTH=true to require transport bearer).`,
      );
    }
  }

  function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const rl = checkMcpRateLimit(rateBuckets, clientIp(req));
    if (rl.limit > 0) {
      applyMcpRateLimitHeaders(res, rl);
    }
    if (rl.ok) {
      next();
      return;
    }
    res.setHeader("Retry-After", String(rl.retryAfterSec));
    res.status(429).json({
      error: "Too Many Requests",
      error_code: "rate_limited",
      message: `MCP request rate limit exceeded (${mcpRateLimitRpm()} req/min per client).`,
      retry_after_sec: rl.retryAfterSec,
    });
  }

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "rill-mcp",
      api: getApiBaseUrl(),
      sessions: registry.size,
    });
  });

  app.get("/ready", (_req, res) => {
    const readiness = getMcpReadinessChecks();
    res.status(readiness.ok ? 200 : 503).json(readiness);
  });

  app.get("/", (_req, res) => {
    sendMcpBrandPage(res);
  });

  app.get(/^\/\.well-known\/oauth-protected-resource(\/.*)?$/, (_req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(buildProtectedResourceMetadata());
  });

  const handleMcp = async (
    req: Request,
    res: Response,
    toolSet: McpToolSet,
  ): Promise<void> => {
    try {
      const rpc = req.body as {
        method?: string;
        id?: unknown;
        params?: { name?: string };
      } | null;
      if (rpc?.method === "tools/call") {
        const name = rpc.params?.name;
        if (
          typeof name === "string" &&
          !(MCP_TOOL_NAMES as readonly string[]).includes(name)
        ) {
          const message = `Unknown tool: ${name}`;
          res.status(200).json({
            jsonrpc: "2.0",
            id: rpc.id ?? null,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    ok: false,
                    error: { code: "unknown_tool", message },
                  }),
                },
              ],
              structuredContent: { code: "unknown_tool", message },
            },
          });
          return;
        }
      }

      const sessionId = sessionIdFromRequest(req);
      if (sessionId && registry.has(sessionId)) {
        const session = registry.get(sessionId)!;
        registry.touch(sessionId);
        adoptSessionKeysFromHeaders(session.keys, req);
        await session.transport.handleRequest(
          req as IncomingMessage,
          res as ServerResponse,
          req.method === "POST" ? req.body : undefined,
        );
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        if (!registry.canAcceptNewSession()) {
          res.status(503).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Too many MCP sessions",
              data: { code: "too_many_sessions", message: "Too many MCP sessions" },
            },
            id: null,
          });
          return;
        }

        let vwKey: string | null = null;
        let sellerKey: string | null = null;
        let ownerJwt: string | null = null;
        let environment: "live" | "test" = getOptionalMoneyEnvironment();

        const keys: SessionKeys = {
          getVwKey: () => vwKey,
          setVwKey: (k) => {
            vwKey = k;
          },
          getOwnerJwt: () => ownerJwt,
          setOwnerJwt: (jwt) => {
            ownerJwt = jwt;
          },
          getSellerKey: () => sellerKey,
          setSellerKey: (k) => {
            sellerKey = k;
          },
          getEnvironment: () => environment,
          setEnvironment: (env) => {
            environment = env;
          },
        };
        adoptSessionKeysFromHeaders(keys, req);

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            registry.attach(id, transport, keys);
          },
          onsessionclosed: (id) => {
            registry.delete(id);
          },
        });
        const server = createRillMcpServer(keys, "http", toolSet);
        await server.connect(transport);
        await transport.handleRequest(
          req as IncomingMessage,
          res as ServerResponse,
          req.body,
        );
        return;
      }

      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
          data: {
            code: "missing_session",
            message: "Bad Request: No valid session ID provided",
          },
        },
        id: null,
      });
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message:
              error instanceof Error ? error.message : "Internal server error",
          },
          id: null,
        });
      }
    }
  };

  const handleAuthenticatedMcp = (req: Request, res: Response) =>
    void handleMcp(req, res, "full");
  const handleGuestMcp = (req: Request, res: Response) =>
    void handleMcp(req, res, "guest");

  app.post("/mcp", rateLimitMiddleware, mcpAuthMiddleware, handleAuthenticatedMcp);
  app.get(
    "/mcp",
    rateLimitMiddleware,
    maybeServeMcpLanding,
    mcpAuthMiddleware,
    handleAuthenticatedMcp,
  );
  app.delete(
    "/mcp",
    rateLimitMiddleware,
    mcpAuthMiddleware,
    handleAuthenticatedMcp,
  );

  app.post(
    "/mcp/guest",
    rateLimitMiddleware,
    mcpGuestAuthMiddleware,
    handleGuestMcp,
  );
  app.get(
    "/mcp/guest",
    rateLimitMiddleware,
    maybeServeMcpLanding,
    mcpGuestAuthMiddleware,
    handleGuestMcp,
  );
  app.delete(
    "/mcp/guest",
    rateLimitMiddleware,
    mcpGuestAuthMiddleware,
    handleGuestMcp,
  );

  return app;
}

export async function startHttpServer(): Promise<void> {
  const app = createHttpApplication();
  const port = mcpHttpPort();
  const host = mcpListenHost();
  app.listen(port, host, () => {
    printMcpConsoleBrand();
    console.log(
      `Rill MCP HTTP on http://${host}:${port}/mcp (api ${getApiBaseUrl()})`,
    );
  });
}
