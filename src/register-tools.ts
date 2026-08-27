import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GUEST_MCP_TOOL_NAMES, MCP_TOOL_NAMES } from "@rill/shared";
import { callRillApi, wrapToolResult } from "./api-client.js";
import {
  getApiBaseUrl,
  getAppBaseUrl,
  getOptionalMoneyEnvironment,
  getOptionalOwnerJwt,
  getOptionalSellerKey,
  getOptionalVwKey,
} from "./env-config.js";
import { registerBootstrapAgent } from "./register-bootstrap.js";
import { buildServerInstructions } from "./server-instructions.js";
import { registerRillDocsResources } from "./register-resources.js";
import type { RillMoneyEnvironment } from "@rill/shared";

export type SessionKeys = {
  getVwKey: () => string | null;
  setVwKey: (key: string | null) => void;
  getOwnerJwt: () => string | null;
  setOwnerJwt?: (jwt: string | null) => void;
  getSellerKey: () => string | null;
  setSellerKey?: (key: string | null) => void;
  getEnvironment: () => RillMoneyEnvironment;
  setEnvironment?: (env: RillMoneyEnvironment) => void;
};

export type McpToolSet = "full" | "guest";

/** Descriptions keyed by canonical MCP_TOOL_NAMES from @rill/shared. */
const TOOL_DESCRIPTIONS: Record<(typeof MCP_TOOL_NAMES)[number], string> = {
  rill_search_tools: "Search Rill MCP tools",
  rill_capabilities: "Read agent capabilities",
  rill_resolve_handle: "Resolve @handle / agent FQDN",
  rill_list_directory: "List MPP/x402 directory (defaults to spendable / payment_ready=1)",
  rill_discover: "Discover verified spendable pay URLs to spend",
  rill_register_agent: "PoW bootstrap → rill_vw_* (guest)",
  rill_claim_handle: "Claim handle (owner JWT)",
  rill_accounts: "List owner accounts",
  rill_create_wallet: "Create rill_vw_* wallet with budget",
  rill_pay_url: "Pay any MPP/x402 URL (open world)",
  rill_pay: "Legacy ledger pay / FQDN transfer",
  rill_balance: "Seller balance or wallet status",
  rill_verify_receipt: "Verify receipt",
  rill_fund: "Fund wallet; action checkout|intent|mock",
  rill_resources: "Seller resources; action list|create",
  rill_create_pay_link: "Create gate URL for Accept (agents pay this)",
  rill_enable_payments: "Enable MPP/x402 on seller gate URLs",
  rill_webhooks: "Register payment.succeeded to unlock your product",
  rill_create_seller: "Create seller (owner JWT)",
  rill_connect: "Seller Connect; action status|onboard|sync|login",
  rill_withdraw: "Transfer seller balance via Connect",
  rill_recycle: "Recycle seller balance to account wallet",
  rill_sync_directory: "Refresh + probe MPP/x402 directory catalog (owner)",
};

export const TOOL_CATALOG = MCP_TOOL_NAMES.map((name) => ({
  name,
  description: TOOL_DESCRIPTIONS[name],
}));

function missingKeyResult(code: string, message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ok: false,
          error: { code, message },
        }),
      },
    ],
    isError: true as const,
    structuredContent: { code, message },
  };
}

function resolveSellerKey(
  session: SessionKeys,
  sellerKey?: string,
): string | null {
  const key =
    sellerKey?.trim() || session.getSellerKey() || getOptionalSellerKey();
  if (key) session.setSellerKey?.(key);
  return key;
}

function resolveOwnerJwt(
  session: SessionKeys,
  ownerJwt?: string,
): string | null {
  const jwt =
    ownerJwt?.trim() || session.getOwnerJwt() || getOptionalOwnerJwt();
  if (jwt) session.setOwnerJwt?.(jwt);
  return jwt;
}

function resolveVwKey(session: SessionKeys, vwKey?: string): string | null {
  const key = vwKey?.trim() || session.getVwKey() || getOptionalVwKey();
  if (key) session.setVwKey(key);
  return key;
}

function resolveEnvironment(
  session: SessionKeys,
  explicit?: string | null,
): RillMoneyEnvironment {
  const raw = explicit?.trim().toLowerCase();
  if (raw === "live" || raw === "test") {
    session.setEnvironment?.(raw);
    return raw;
  }
  return session.getEnvironment();
}

const environmentArg = z.enum(["live", "test"]).optional();


function idempotencyOrNew(key?: string): string {
  return key?.trim() || randomUUID();
}

function normalizeResolveDestination(input: string): string {
  let raw = input.trim();
  if (raw.startsWith("@")) raw = raw.slice(1);
  return raw;
}

const GUEST_TOOLS = new Set<string>(GUEST_MCP_TOOL_NAMES);

export function createRillMcpServer(
  session: SessionKeys,
  mode: "stdio" | "http" = "stdio",
  toolSet: McpToolSet = "full",
): McpServer {
  const server = new McpServer({
    name: "rill",
    version: "0.1.0",
  });

  registerRillDocsResources(server);

  const allow = (name: string) => toolSet === "full" || GUEST_TOOLS.has(name);

  if (allow("rill_search_tools")) {
    server.tool(
      "rill_search_tools",
      "Search available Rill MCP tools",
      { query: z.string().optional() },
      async ({ query }) => {
        const q = query?.trim().toLowerCase() ?? "";
        const tools = TOOL_CATALOG.filter(
          (t) =>
            allow(t.name) &&
            (!q ||
              t.name.includes(q) ||
              t.description.toLowerCase().includes(q)),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: [
                buildServerInstructions(mode),
                "",
                JSON.stringify({ ok: true, tools }, null, 2),
              ].join("\n"),
            },
          ],
        };
      },
    );
  }

  if (allow("rill_capabilities")) {
    server.tool(
      "rill_capabilities",
      "Read Rill agent capabilities, seed resources, and MCP tool list",
      {},
      async () =>
        wrapToolResult(
          await callRillApi({
            method: "GET",
            path: "/agent/capabilities",
          }),
        ),
    );
  }

  if (allow("rill_resolve_handle")) {
    server.tool(
      "rill_resolve_handle",
      "Resolve @handle, handle FQDN, or agent FQDN to pay address and agents",
      { handle: z.string() },
      async ({ handle }) => {
        const destination = normalizeResolveDestination(handle);
        return wrapToolResult(
          await callRillApi({
            method: "GET",
            path: `/handles/resolve/${encodeURIComponent(destination)}`,
          }),
        );
      },
    );
  }

  if (allow("rill_list_directory")) {
    server.tool(
      "rill_list_directory",
      "List cached MPP/x402 pay URLs. Defaults to payment_ready=true (maps to spendable / Can pay). Pass payment_ready=false for the full research catalog. Prefer rill_discover for spend. Pass pay_url (and optional id as directory_id) to rill_pay_url.",
      {
        q: z.string().optional(),
        rail: z.enum(["mpp", "x402", "any"]).optional(),
        probe_status: z.string().optional(),
        payment_ready: z.boolean().optional(),
        max_probe_age_hours: z.number().int().positive().max(720).optional(),
        network: z.string().optional(),
        limit: z.number().int().positive().max(100).optional(),
        cursor: z.string().optional(),
      },
      async (args) => {
        const params = new URLSearchParams();
        if (args.q?.trim()) params.set("q", args.q.trim());
        if (args.rail) params.set("rail", args.rail);
        if (args.probe_status?.trim())
          params.set("probe_status", args.probe_status.trim());
        // Payable-first: default true unless explicitly false.
        if (args.payment_ready !== false) params.set("payment_ready", "1");
        const ageHours = args.max_probe_age_hours ?? 168;
        if (args.payment_ready !== false) {
          params.set("max_probe_age_hours", String(ageHours));
        } else if (args.max_probe_age_hours) {
          params.set("max_probe_age_hours", String(args.max_probe_age_hours));
        }
        // Spend wallet is Base-first; default network=base for payable lists.
        if (args.payment_ready !== false) {
          params.set("network", args.network?.trim() || "base");
        } else if (args.network?.trim()) {
          params.set("network", args.network.trim());
        }
        if (args.limit) params.set("limit", String(args.limit));
        if (args.cursor?.trim()) params.set("cursor", args.cursor.trim());
        const qs = params.toString();
        return wrapToolResult(
          await callRillApi({
            method: "GET",
            path: `/directory${qs ? `?${qs}` : ""}`,
          }),
        );
      },
    );
  }

  if (allow("rill_discover")) {
    server.tool(
      "rill_discover",
      "Discover verified spendable MPP/x402 gates (always payment_ready=1 → spendable, Base by default). Prefer Accept seed_gate first. Rows include pay_url, probe_method, probe_amount_cents → rill_pay_url.",
      {
        q: z.string().optional(),
        rail: z.enum(["mpp", "x402", "any"]).optional(),
        network: z.string().optional(),
        max_probe_age_hours: z.number().int().positive().max(720).optional(),
        limit: z.number().int().positive().max(100).optional(),
        cursor: z.string().optional(),
      },
      async (args) => {
        const params = new URLSearchParams();
        params.set("payment_ready", "1");
        params.set("network", args.network?.trim() || "base");
        params.set(
          "max_probe_age_hours",
          String(args.max_probe_age_hours ?? 168),
        );
        if (args.q?.trim()) params.set("q", args.q.trim());
        if (args.rail) params.set("rail", args.rail);
        if (args.limit) params.set("limit", String(args.limit));
        if (args.cursor?.trim()) params.set("cursor", args.cursor.trim());
        const qs = params.toString();
        const result = await callRillApi({
          method: "GET",
          path: `/directory?${qs}`,
        });
        return wrapToolResult(result);
      },
    );
  }

  if (allow("rill_register_agent")) {
    server.tool(
      "rill_register_agent",
      "Self-register via PoW and mint a bootstrap wallet key (rill_vw_* live or rill_vw_test_*). Session adopts the key.",
      {
        label: z.string().optional(),
        environment: environmentArg,
      },
      async (args) => {
        const environment = resolveEnvironment(session, args.environment);
        const result = await registerBootstrapAgent(args.label, environment);
        if (result.ok && result.body && typeof result.body === "object") {
          const body = result.body as {
            agent?: { api_key?: string };
            api_key?: string;
          };
          const key = body.agent?.api_key ?? body.api_key;
          if (
            typeof key === "string" &&
            (key.startsWith("rill_vw_") || key.startsWith("rill_vw_test_"))
          ) {
            session.setVwKey(key);
          }
        }
        return wrapToolResult(result);
      },
    );
  }

  if (allow("rill_claim_handle")) {
    server.tool(
      "rill_claim_handle",
      "Claim a Rill handle and create the owner account wallet (owner JWT). Pass environment=test for Test mode.",
      {
        handle: z.string().min(3),
        owner_jwt: z.string().optional(),
        environment: environmentArg,
      },
      async (args) => {
        const jwt = resolveOwnerJwt(session, args.owner_jwt);
        if (!jwt) {
          return missingKeyResult(
            "missing_owner_jwt",
            "RILL_OWNER_JWT or owner_jwt required",
          );
        }
        const environment = resolveEnvironment(session, args.environment);
        return wrapToolResult(
          await callRillApi({
            method: "POST",
            path: "/handles/claim",
            ownerJwt: jwt,
            environment,
            body: { handle: args.handle.trim().toLowerCase().replace(/^@/, "") },
          }),
        );
      },
    );
  }

  if (allow("rill_accounts")) {
    server.tool(
      "rill_accounts",
      "List owner account wallets (or /me when me=true). Scoped by environment (live|test).",
      {
        me: z.boolean().optional(),
        owner_jwt: z.string().optional(),
        environment: environmentArg,
      },
      async (args) => {
        const jwt = resolveOwnerJwt(session, args.owner_jwt);
        if (!jwt) {
          return missingKeyResult(
            "missing_owner_jwt",
            "RILL_OWNER_JWT or owner_jwt required",
          );
        }
        const environment = resolveEnvironment(session, args.environment);
        return wrapToolResult(
          await callRillApi({
            method: "GET",
            path: args.me ? "/accounts/me" : "/accounts",
            ownerJwt: jwt,
            environment,
          }),
        );
      },
    );
  }

  if (allow("rill_create_wallet")) {
    server.tool(
      "rill_create_wallet",
      "Mint a virtual wallet (rill_vw_* or rill_vw_test_*) with period allowance, max tx, allowlist. Account wallet must match environment.",
      {
        account_wallet_id: z.string(),
        agent_slug: z.string().optional(),
        period_allowance: z.number().positive().optional(),
        max_transaction: z.number().positive().optional(),
        allowlist: z.array(z.string()).optional(),
        policy_template_id: z.string().optional(),
        owner_jwt: z.string().optional(),
        environment: environmentArg,
      },
      async (args) => {
        const jwt = resolveOwnerJwt(session, args.owner_jwt);
        if (!jwt) {
          return missingKeyResult(
            "missing_owner_jwt",
            "RILL_OWNER_JWT or owner_jwt required",
          );
        }
        const environment = resolveEnvironment(session, args.environment);
        const result = await callRillApi({
          method: "POST",
          path: "/wallets",
          ownerJwt: jwt,
          environment,
          body: {
            account_wallet_id: args.account_wallet_id,
            agent_slug: args.agent_slug ?? "agent",
            period_allowance: args.period_allowance,
            max_transaction: args.max_transaction,
            allowlist: args.allowlist,
            policy_template_id: args.policy_template_id,
          },
        });
        const body = result.body as {
          virtual_wallet?: { api_key?: string; fqdn?: string };
        } | null;
        if (body?.virtual_wallet?.api_key) {
          session.setVwKey(body.virtual_wallet.api_key);
        }
        return wrapToolResult(result);
      },
    );
  }

  if (allow("rill_pay_url")) {
    server.tool(
      "rill_pay_url",
      "Pay any HTTPS URL that speaks MPP or x402 (open-world Spend under VW policy). Prefer urls from rill_discover; optional directory_id uses catalog probe_method/hints. Default prefer_rail=auto uses Base/x402 when the gate offers it.",
      {
        url: z.string().url().optional(),
        directory_id: z.string().optional(),
        method: z.string().optional(),
        max_amount: z.number().positive().optional(),
        max_amount_cents: z.number().int().positive().optional(),
        prefer_rail: z.enum(["auto", "mpp", "x402"]).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
        idempotency_key: z.string().optional(),
        vw_key: z.string().optional(),
      },
      async (args) => {
        const apiKey = resolveVwKey(session, args.vw_key);
        if (!apiKey) {
          return missingKeyResult(
            "missing_vw_key",
            "Set RILL_VW_KEY, pass vw_key, or mint via rill_create_wallet",
          );
        }
        if (!args.url?.trim() && !args.directory_id?.trim()) {
          return missingKeyResult(
            "invalid_url",
            "Pass url from rill_discover, or directory_id",
          );
        }
        const result = await callRillApi({
          method: "POST",
          path: "/spend/pay-url",
          apiKey,
          idempotencyKey: idempotencyOrNew(args.idempotency_key),
          body: {
            url: args.url,
            directory_id: args.directory_id,
            method: args.method,
            max_amount: args.max_amount,
            max_amount_cents: args.max_amount_cents,
            prefer_rail: args.prefer_rail,
            headers: args.headers,
            body: args.body,
          },
        });
        return wrapToolResult(result);
      },
    );
  }

  if (allow("rill_pay")) {
    server.tool(
      "rill_pay",
      "Background ledger: pay a Rill resource or transfer USD to a handle / agent FQDN",
      {
        amount: z.number().positive().optional(),
        resource_id: z.string().optional(),
        to: z.string().optional(),
        destination: z.string().optional(),
        idempotency_key: z.string().optional(),
        vw_key: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
      async (args) => {
        const apiKey = resolveVwKey(session, args.vw_key);
        if (!apiKey) {
          return missingKeyResult(
            "missing_vw_key",
            "Set RILL_VW_KEY, pass vw_key, or mint via rill_create_wallet",
          );
        }
        const result = await callRillApi({
          method: "POST",
          path: "/pay",
          apiKey,
          idempotencyKey: idempotencyOrNew(args.idempotency_key),
          body: {
            amount: args.amount,
            resource_id: args.resource_id,
            to: args.to,
            destination: args.destination,
            metadata: args.metadata,
          },
        });
        return wrapToolResult(result);
      },
    );
  }

  if (allow("rill_balance")) {
    server.tool(
      "rill_balance",
      "Seller balance + Connect flags (seller key) or VW allowance status (vw key)",
      {
        seller_key: z.string().optional(),
        vw_key: z.string().optional(),
      },
      async (args) => {
        const sellerKey = resolveSellerKey(session, args.seller_key);
        if (sellerKey) {
          return wrapToolResult(
            await callRillApi({
              method: "GET",
              path: "/sellers/me/balance",
              sellerKey,
            }),
          );
        }
        const vw = resolveVwKey(session, args.vw_key);
        if (!vw) {
          return missingKeyResult(
            "missing_key",
            "Provide seller_key or vw_key",
          );
        }
        return wrapToolResult(
          await callRillApi({
            method: "GET",
            path: "/wallets/me/status",
            apiKey: vw,
          }),
        );
      },
    );
  }

  if (allow("rill_verify_receipt")) {
    server.tool(
      "rill_verify_receipt",
      "Verify a Rill receipt",
      {
        receipt_id: z.string(),
        resource_id: z.string().optional(),
      },
      async (args) =>
        wrapToolResult(
          await callRillApi({
            method: "POST",
            path: "/access/verify",
            body: {
              receipt_id: args.receipt_id,
              resource_id: args.resource_id,
            },
          }),
        ),
    );
  }

  if (allow("rill_fund")) {
    server.tool(
      "rill_fund",
      "Fund an account wallet. action=checkout: Stripe Checkout URL for a human. action=intent: poll until paid. action=mock: local/dev only. Bootstrap agents: no owner JWT, uses session rill_vw_* (auto-registers when missing).",
      {
        action: z
          .enum(["checkout", "intent", "mock"])
          .describe("checkout | intent | mock"),
        account_wallet_id: z
          .string()
          .optional()
          .describe("Owner path: wallet to fund. VW path: optional (uses the VW account wallet)."),
        amount: z
          .number()
          .positive()
          .optional()
          .describe("checkout/mock only: USD amount"),
        funding_intent_id: z
          .string()
          .optional()
          .describe("intent only: id from checkout response"),
        owner_jwt: z.string().optional(),
        vw_key: z.string().optional(),
        label: z
          .string()
          .optional()
          .describe("Optional label when auto-registering a bootstrap agent"),
        environment: environmentArg,
        idempotency_key: z.string().optional(),
      },
      async (args) => {
        const jwt = resolveOwnerJwt(session, args.owner_jwt);
        let vwKey = resolveVwKey(session, args.vw_key);
        const environment = resolveEnvironment(session, args.environment);

        // Agent cold-start: no credentials → PoW register, then fund with the new VW.
        if (
          !jwt &&
          !vwKey &&
          (args.action === "checkout" || args.action === "mock")
        ) {
          const registered = await registerBootstrapAgent(
            args.label,
            environment,
          );
          if (!registered.ok || !registered.body || typeof registered.body !== "object") {
            return wrapToolResult(registered);
          }
          const body = registered.body as {
            agent?: { api_key?: string; account_wallet_id?: string };
            api_key?: string;
          };
          const key = body.agent?.api_key ?? body.api_key;
          if (
            typeof key === "string" &&
            (key.startsWith("rill_vw_") || key.startsWith("rill_vw_test_"))
          ) {
            session.setVwKey(key);
            vwKey = key;
          } else {
            return wrapToolResult(registered);
          }
        }

        if (!jwt && !vwKey) {
          return missingKeyResult(
            "missing_credentials",
            "Pass owner_jwt, vw_key, or call without keys to auto-register then checkout",
          );
        }

        if (args.action === "intent") {
          if (!args.funding_intent_id?.trim()) {
            return missingKeyResult(
              "invalid_request",
              "funding_intent_id required for action=intent",
            );
          }
          return wrapToolResult(
            await callRillApi({
              method: "GET",
              path: `/funding/${encodeURIComponent(args.funding_intent_id)}`,
              ownerJwt: jwt,
              environment,
              apiKey: jwt ? null : vwKey,
            }),
          );
        }

        if (!args.amount) {
          return missingKeyResult(
            "invalid_request",
            "amount required for action=checkout|mock",
          );
        }

        // VW / bootstrap path, no account_wallet_id required.
        if (!jwt && vwKey) {
          if (args.action === "mock") {
            let walletId = args.account_wallet_id?.trim();
            if (!walletId) {
              const status = await callRillApi({
                method: "GET",
                path: "/wallets/me/status",
                apiKey: vwKey,
              });
              const statusBody = status.body as {
                virtual_wallet?: { account_wallet_id?: string };
              } | null;
              walletId = statusBody?.virtual_wallet?.account_wallet_id;
            }
            if (!walletId) {
              return missingKeyResult(
                "invalid_request",
                "Could not resolve account_wallet_id for mock fund",
              );
            }
            return wrapToolResult(
              await callRillApi({
                method: "POST",
                path: `/accounts/${encodeURIComponent(walletId)}/fund`,
                apiKey: vwKey,
                idempotencyKey: idempotencyOrNew(args.idempotency_key),
                body: { amount: args.amount },
              }),
            );
          }
          return wrapToolResult(
            await callRillApi({
              method: "POST",
              path: "/agent/fund-checkout",
              apiKey: vwKey,
              idempotencyKey: idempotencyOrNew(args.idempotency_key),
              body: { amount: args.amount },
            }),
          );
        }

        // Owner JWT path
        if (!args.account_wallet_id?.trim()) {
          return missingKeyResult(
            "invalid_request",
            "account_wallet_id required for owner fund",
          );
        }
        const path =
          args.action === "checkout"
            ? `/accounts/${encodeURIComponent(args.account_wallet_id)}/fund-checkout`
            : `/accounts/${encodeURIComponent(args.account_wallet_id)}/fund`;
        return wrapToolResult(
          await callRillApi({
            method: "POST",
            path,
            ownerJwt: jwt,
            environment,
            idempotencyKey: idempotencyOrNew(args.idempotency_key),
            body:
              args.action === "checkout"
                ? { amount: args.amount, hosted: true }
                : { amount: args.amount },
          }),
        );
      },
    );
  }

  if (allow("rill_resources")) {
    server.tool(
      "rill_resources",
      "Seller priced resources. action=list: inventory. action=create: raw SKU (prefer rill_create_pay_link for hosted Accept).",
      {
        action: z.enum(["list", "create"]).describe("list | create"),
        path_or_tool: z
          .string()
          .optional()
          .describe("create only: path or tool name"),
        amount: z
          .number()
          .positive()
          .optional()
          .describe("create only: USD price"),
        resource_type: z
          .enum(["http", "mcp"])
          .optional()
          .describe("create only: defaults to http"),
        seller_key: z.string().optional(),
      },
      async (args) => {
        const sellerKey = resolveSellerKey(session, args.seller_key);
        if (!sellerKey) {
          return missingKeyResult("missing_seller_key", "rill_sk_* required");
        }
        if (args.action === "list") {
          return wrapToolResult(
            await callRillApi({
              method: "GET",
              path: "/resources",
              sellerKey,
            }),
          );
        }
        if (!args.path_or_tool?.trim() || !args.amount) {
          return missingKeyResult(
            "invalid_request",
            "path_or_tool and amount required for action=create",
          );
        }
        return wrapToolResult(
          await callRillApi({
            method: "POST",
            path: "/resources",
            sellerKey,
            body: {
              path_or_tool: args.path_or_tool,
              amount: args.amount,
              resource_type: args.resource_type ?? "http",
            },
          }),
        );
      },
    );
  }

  if (allow("rill_create_seller")) {
    server.tool(
      "rill_create_seller",
      "Create an Accept seller and return rill_sk_* or rill_sk_test_* (owner JWT). Pass environment=test for Test mode.",
      {
        name: z.string().min(1),
        owner_jwt: z.string().optional(),
        environment: environmentArg,
      },
      async (args) => {
        const jwt = resolveOwnerJwt(session, args.owner_jwt);
        if (!jwt) {
          return missingKeyResult(
            "missing_owner_jwt",
            "RILL_OWNER_JWT or owner_jwt required",
          );
        }
        const environment = resolveEnvironment(session, args.environment);
        const result = await callRillApi({
          method: "POST",
          path: "/sellers",
          ownerJwt: jwt,
          environment,
          body: { name: args.name },
        });
        const body = result.body as {
          seller?: { api_key?: string };
        } | null;
        if (body?.seller?.api_key) {
          session.setSellerKey?.(body.seller.api_key);
        }
        return wrapToolResult(result);
      },
    );
  }

  if (allow("rill_connect")) {
    server.tool(
      "rill_connect",
      "Seller Stripe Express Connect. action=status: requirements/onboarded. action=onboard: Account Link URL for human KYC. action=sync: pull Stripe state. action=login: Express login for outstanding requirements.",
      {
        action: z
          .enum(["status", "onboard", "sync", "login"])
          .describe("status | onboard | sync | login"),
        country: z
          .string()
          .length(2)
          .optional()
          .describe("onboard only: ISO-3166 alpha-2"),
        seller_key: z.string().optional(),
      },
      async (args) => {
        const sellerKey = resolveSellerKey(session, args.seller_key);
        if (!sellerKey) {
          return missingKeyResult("missing_seller_key", "rill_sk_* required");
        }
        if (args.action === "status") {
          return wrapToolResult(
            await callRillApi({
              method: "GET",
              path: "/sellers/me/connect",
              sellerKey,
            }),
          );
        }
        if (args.action === "onboard") {
          return wrapToolResult(
            await callRillApi({
              method: "POST",
              path: "/sellers/me/connect/onboard",
              sellerKey,
              body: args.country ? { country: args.country } : {},
            }),
          );
        }
        if (args.action === "sync") {
          return wrapToolResult(
            await callRillApi({
              method: "POST",
              path: "/sellers/me/connect/sync",
              sellerKey,
            }),
          );
        }
        return wrapToolResult(
          await callRillApi({
            method: "POST",
            path: "/sellers/me/connect/login-link",
            sellerKey,
          }),
        );
      },
    );
  }

  if (allow("rill_withdraw")) {
    server.tool(
      "rill_withdraw",
      "Withdraw seller balance via Stripe Connect Transfer (requires payouts_enabled)",
      {
        amount: z.number().positive(),
        seller_key: z.string().optional(),
        idempotency_key: z.string().optional(),
      },
      async (args) => {
        const sellerKey = resolveSellerKey(session, args.seller_key);
        if (!sellerKey) {
          return missingKeyResult("missing_seller_key", "rill_sk_* required");
        }
        return wrapToolResult(
          await callRillApi({
            method: "POST",
            path: "/sellers/me/withdraw",
            sellerKey,
            idempotencyKey: idempotencyOrNew(args.idempotency_key),
            body: { amount: args.amount },
          }),
        );
      },
    );
  }

  if (allow("rill_recycle")) {
    server.tool(
      "rill_recycle",
      "Move seller balance into the owner account wallet (no Stripe). Scoped by environment (live|test).",
      {
        seller_id: z.string(),
        amount: z.number().positive(),
        owner_jwt: z.string().optional(),
        environment: environmentArg,
        idempotency_key: z.string().optional(),
      },
      async (args) => {
        const jwt = resolveOwnerJwt(session, args.owner_jwt);
        if (!jwt) {
          return missingKeyResult(
            "missing_owner_jwt",
            "RILL_OWNER_JWT or owner_jwt required",
          );
        }
        const environment = resolveEnvironment(session, args.environment);
        return wrapToolResult(
          await callRillApi({
            method: "POST",
            path: `/sellers/${encodeURIComponent(args.seller_id)}/recycle`,
            ownerJwt: jwt,
            environment,
            idempotencyKey: idempotencyOrNew(args.idempotency_key),
            body: { amount: args.amount },
          }),
        );
      },
    );
  }

  if (allow("rill_create_pay_link")) {
    server.tool(
      "rill_create_pay_link",
      "Create a priced resource and return gate_url (agents pay this). Also returns pay_page_url for humans; balise_html is optional embed.",
      {
        path_or_tool: z.string().optional(),
        amount: z.number().positive().optional(),
        resource_id: z.string().optional(),
        resource_type: z.enum(["http", "mcp"]).optional(),
        seller_key: z.string().optional(),
      },
      async (args) => {
        const sellerKey = resolveSellerKey(session, args.seller_key);
        if (!sellerKey) {
          return missingKeyResult("missing_seller_key", "rill_sk_* required");
        }
        const api = getApiBaseUrl();
        const app = getAppBaseUrl();
        let resourceId = args.resource_id?.trim();
        let amount = args.amount;
        if (!resourceId) {
          if (!args.path_or_tool?.trim() || !amount) {
            return missingKeyResult(
              "invalid_request",
              "Provide resource_id, or path_or_tool + amount",
            );
          }
          const created = await callRillApi({
            method: "POST",
            path: "/resources",
            sellerKey,
            body: {
              path_or_tool: args.path_or_tool,
              amount,
              resource_type: args.resource_type ?? "http",
            },
          });
          if (!created.ok) return wrapToolResult(created);
          const body = created.body as {
            resource?: {
              id?: string;
              short_id?: string;
              amount?: string | number;
              pay_url?: string;
              gate_url?: string;
            };
            id?: string;
            amount?: string | number;
          } | null;
          resourceId = body?.resource?.id ?? body?.id;
          const shortId = body?.resource?.short_id;
          const amt = body?.resource?.amount ?? body?.amount ?? amount;
          amount = typeof amt === "string" ? Number(amt) : amt;
          if (!resourceId) {
            return missingKeyResult("create_failed", "Resource create missing id");
          }
          const publicCode = shortId ?? resourceId;
          const gateUrl = body?.resource?.gate_url ?? `${api}/r/${publicCode}`;
          const payPageUrl = body?.resource?.pay_url ?? `${app}/r/${publicCode}`;
          const baliseHtml = `<script src="${app}/rill-balise.js" data-resource-id="${publicCode}" data-api-base="${api}" async></script>`;
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ok: true,
                    resource_id: resourceId,
                    short_id: shortId ?? null,
                    amount,
                    gate_url: gateUrl,
                    pay_page_url: payPageUrl,
                    balise_html: baliseHtml,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        const termsRes = await callRillApi({
          method: "POST",
          path: `/resources/${encodeURIComponent(resourceId)}/terms`,
        });
        const termsBody = termsRes.body as {
          payment_terms?: {
            amount?: unknown;
            gate_url?: string;
            pay_page_url?: string;
            resource_id?: string;
          };
        } | null;
        const terms = termsBody?.payment_terms;
        const publicCode =
          typeof terms?.gate_url === "string"
            ? terms.gate_url.split("/").pop() || resourceId
            : resourceId;
        const gateUrl = terms?.gate_url ?? `${api}/r/${publicCode}`;
        const payPageUrl = terms?.pay_page_url ?? `${app}/r/${publicCode}`;
        const baliseHtml = `<script src="${app}/rill-balise.js" data-resource-id="${publicCode}" data-api-base="${api}" async></script>`;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: true,
                  resource_id: resourceId,
                  amount: amount ?? terms?.amount,
                  gate_url: gateUrl,
                  pay_page_url: payPageUrl,
                  balise_html: baliseHtml,
                  payment_terms: terms ?? null,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    );
  }

  if (allow("rill_enable_payments")) {
    server.tool(
      "rill_enable_payments",
      "Enable MPP/x402 on the seller gate URL so agents can finish pay (optional stripe_profile_id)",
      {
        stripe_profile_id: z
          .string()
          .optional()
          .describe(
            "Optional Stripe Profile id. When omitted, adopts the platform profile for the seller money environment.",
          ),
        mpp_enabled: z.boolean().optional(),
        x402_enabled: z.boolean().optional(),
        seller_key: z.string().optional(),
      },
      async (args) => {
        const sellerKey = resolveSellerKey(session, args.seller_key);
        if (!sellerKey) {
          return missingKeyResult("missing_seller_key", "rill_sk_* required");
        }
        const body: {
          stripe_profile_id?: string;
          mpp_enabled: boolean;
          x402_enabled: boolean;
        } = {
          mpp_enabled: args.mpp_enabled ?? true,
          x402_enabled: args.x402_enabled ?? true,
        };
        if (args.stripe_profile_id?.trim()) {
          body.stripe_profile_id = args.stripe_profile_id.trim();
        }
        return wrapToolResult(
          await callRillApi({
            method: "PATCH",
            path: "/sellers/me/payments",
            sellerKey,
            body,
          }),
        );
      },
    );
  }

  if (allow("rill_webhooks")) {
    server.tool(
      "rill_webhooks",
      "Owner webhooks. action=create: register HTTPS URL for payment.succeeded (unlocks your product). action=list: list endpoints. Pass environment=test for Test mode.",
      {
        action: z.enum(["create", "list"]).describe("create | list"),
        url: z.string().url().optional().describe("create only: HTTPS callback"),
        events: z
          .array(z.string())
          .optional()
          .describe("create only: event allowlist"),
        owner_jwt: z.string().optional(),
        environment: environmentArg,
      },
      async (args) => {
        const jwt = resolveOwnerJwt(session, args.owner_jwt);
        if (!jwt) {
          return missingKeyResult(
            "missing_owner_jwt",
            "RILL_OWNER_JWT or owner_jwt required",
          );
        }
        const environment = resolveEnvironment(session, args.environment);
        if (args.action === "list") {
          return wrapToolResult(
            await callRillApi({
              method: "GET",
              path: "/webhooks",
              ownerJwt: jwt,
              environment,
            }),
          );
        }
        if (!args.url) {
          return missingKeyResult(
            "invalid_request",
            "url required for action=create",
          );
        }
        return wrapToolResult(
          await callRillApi({
            method: "POST",
            path: "/webhooks",
            ownerJwt: jwt,
            environment,
            body: {
              url: args.url,
              events: args.events,
            },
          }),
        );
      },
    );
  }

  if (allow("rill_sync_directory")) {
    server.tool(
      "rill_sync_directory",
      "Refresh + probe the MPP/x402 directory. Response includes probe counts (spendable, challenge_only, docs_only, dead, …) so you can spot quality drift.",
      {
        owner_jwt: z.string().optional(),
        environment: environmentArg,
      },
      async (args) => {
        const jwt = resolveOwnerJwt(session, args.owner_jwt);
        if (!jwt) {
          return missingKeyResult(
            "missing_owner_jwt",
            "RILL_OWNER_JWT or owner_jwt required",
          );
        }
        const environment = resolveEnvironment(session, args.environment);
        return wrapToolResult(
          await callRillApi({
            method: "POST",
            path: "/directory/sync",
            ownerJwt: jwt,
            environment,
          }),
        );
      },
    );
  }

  return server;
}

export function createSessionFromEnv(): SessionKeys {
  let vwKey = getOptionalVwKey();
  let sellerKey = getOptionalSellerKey();
  let ownerJwt = getOptionalOwnerJwt();
  let environment = getOptionalMoneyEnvironment();
  return {
    getVwKey: () => vwKey,
    setVwKey: (key) => {
      vwKey = key;
    },
    getOwnerJwt: () => ownerJwt,
    setOwnerJwt: (jwt) => {
      ownerJwt = jwt;
    },
    getSellerKey: () => sellerKey,
    setSellerKey: (key) => {
      sellerKey = key;
    },
    getEnvironment: () => environment,
    setEnvironment: (env) => {
      environment = env;
    },
  };
}
