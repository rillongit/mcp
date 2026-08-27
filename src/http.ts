import { randomUUID } from "node:crypto";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { MCP_TOOL_NAMES } from "@rill/shared";
import { getMcpBrandText, printMcpConsoleBrand } from "./console-brand.js";
import {
  getApiBaseUrl,
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

/** Owner Supabase JWT (eyJ…) or OAuth access token (rill_oat_*), not VW/seller keys. */
function extractOwnerJwt(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const raw = header.slice(7).trim();
  if (!raw || raw.startsWith("rill_vw_") || raw.startsWith("rill_sk_")) {
    return null;
  }
  if (raw.startsWith("eyJ") || raw.startsWith("rill_oat_")) return raw;
  return null;
}

function extractOAuthAccessToken(req: express.Request): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const raw = auth.slice(7).trim();
  return raw.startsWith("rill_oat_") ? raw : null;
}

function adoptSessionKeysFromHeaders(
  keys: SessionKeys,
  req: express.Request,
): void {
  const vw =
    extractKey(req.headers.authorization, "rill_vw_") ||
    extractKey(req.headers["x-rill-vw-key"] as string | undefined, "rill_vw_");
  const sk =
    extractKey(req.headers.authorization, "rill_sk_") ||
    extractKey(
      req.headers["x-rill-seller-key"] as string | undefined,
      "rill_sk_",
    );
  const jwt =
    extractOwnerJwt(req.headers.authorization) ||
    extractOwnerJwt(
      typeof req.headers["x-rill-owner-jwt"] === "string"
        ? `Bearer ${req.headers["x-rill-owner-jwt"]}`
        : undefined,
    );
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

type RateBucket = { count: number; resetAt: number };

export async function startHttpServer(): Promise<void> {
  const port = mcpHttpPort();
  const host = mcpListenHost();
  const app = express();
  app.use(express.json({ limit: mcpMaxBodyBytes() }));

  const sessions = new McpSessionRegistry(mcpMaxSessions(), mcpSessionTtlMs());
  sessions.startPeriodicPrune();

  const rpm = mcpRateLimitRpm();
  const buckets = new Map<string, RateBucket>();

  app.use((req, res, next) => {
    if (rpm <= 0) return next();
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const bucket = buckets.get(ip) ?? { count: 0, resetAt: now + 60_000 };
    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + 60_000;
    }
    bucket.count += 1;
    buckets.set(ip, bucket);
    if (bucket.count > rpm) {
      const retryAfterSec = Math.max(
        1,
        Math.ceil((bucket.resetAt - now) / 1000),
      );
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({
        ok: false,
        error: "Too Many Requests",
        error_code: "rate_limited",
        message: `MCP request rate limit exceeded (${rpm} req/min per client).`,
        retry_after_sec: retryAfterSec,
      });
      return;
    }
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "rill-mcp",
      api: getApiBaseUrl(),
      sessions: sessions.size,
    });
  });

  app.get("/ready", (_req, res) => {
    const readiness = getMcpReadinessChecks();
    res.status(readiness.ok ? 200 : 503).json(readiness);
  });

  app.get("/", (_req, res) => {
    res.type("text/plain").send(getMcpBrandText());
  });

  app.get(
    ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"],
    (_req, res) => {
      res.json(buildProtectedResourceMetadata());
    },
  );

  function authorizeTransport(req: express.Request): boolean {
    if (!mcpRequireAuth()) return true;
    const tokens = getMcpHttpBearerTokens();
    if (tokens.length === 0) return false;
    const presented = extractTransportBearer(req.headers.authorization);
    return Boolean(presented && tokens.includes(presented));
  }

  async function mcpAuthMiddleware(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): Promise<void> {
    if (authorizeTransport(req)) {
      next();
      return;
    }

    const vw =
      extractKey(req.headers.authorization, "rill_vw_") ||
      extractKey(req.headers["x-rill-vw-key"] as string | undefined, "rill_vw_");
    const sk =
      extractKey(req.headers.authorization, "rill_sk_") ||
      extractKey(
        req.headers["x-rill-seller-key"] as string | undefined,
        "rill_sk_",
      );
    const jwt = extractOwnerJwt(req.headers.authorization);
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
        const metadataUrl = `${getMcpPublicOrigin()}/.well-known/oauth-protected-resource/mcp`;
        res.setHeader(
          "WWW-Authenticate",
          `Bearer resource_metadata="${metadataUrl}", error="invalid_token"`,
        );
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

    const metadataUrl = `${getMcpPublicOrigin()}/.well-known/oauth-protected-resource/mcp`;
    if (merchantOAuthEnabled()) {
      res.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${metadataUrl}"`,
      );
    }
    res.status(401).json({
      error: "Unauthorized",
      error_code: "missing_credentials",
      message:
        "Send Authorization: Bearer rill_oat_…, rill_vw_*/rill_sk_*, owner JWT, or transport bearer. Guest tools: /mcp/guest.",
    });
  }

  async function handleMcp(
    req: express.Request,
    res: express.Response,
    toolSet: McpToolSet,
  ) {
    if (toolSet === "full") {
      await new Promise<void>((resolve) => {
        void mcpAuthMiddleware(req, res, () => resolve());
      });
      if (res.headersSent) return;
    }

    const rpc = req.body as {
      method?: string;
      id?: unknown;
      params?: { name?: string };
    } | null;
    if (rpc?.method === "tools/call") {
      const name = rpc.params?.name;
      if (typeof name === "string" && !(MCP_TOOL_NAMES as readonly string[]).includes(name)) {
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

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      sessions.touch(sessionId);
      adoptSessionKeysFromHeaders(session.keys, req);
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      if (!sessions.canAcceptNewSession()) {
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
          sessions.attach(id, transport, keys);
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) sessions.delete(id);
      };
      const server = createRillMcpServer(keys, "http", toolSet);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
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
  }

  app.post("/mcp", (req, res) => void handleMcp(req, res, "full"));
  app.post("/mcp/guest", (req, res) => void handleMcp(req, res, "guest"));
  app.get("/mcp", (req, res) => void handleMcp(req, res, "full"));
  app.delete("/mcp", (req, res) => void handleMcp(req, res, "full"));
  app.get("/mcp/guest", (req, res) => void handleMcp(req, res, "guest"));
  app.delete("/mcp/guest", (req, res) => void handleMcp(req, res, "guest"));

  app.listen(port, host, () => {
    printMcpConsoleBrand();
    console.log(
      `Rill MCP HTTP on http://${host}:${port}/mcp (api ${getApiBaseUrl()})`,
    );
  });
}
