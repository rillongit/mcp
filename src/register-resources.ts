import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const DOCS: Record<string, string> = {
  authentication: `# Rill authentication

Principals:
- owner: Supabase JWT (Authorization: Bearer eyJ…)
- seller: rill_sk_* (Bearer or x-rill-seller-key)
- virtual_wallet / agent: rill_vw_* (Bearer or x-rill-vw-key)

Invalid JWTs return 401. Missing credentials stay anonymous on public routes.
Discover live trust ladder via rill_capabilities or GET /agent/capabilities.
`,
  money: `# Rill money

Closed-loop USD ledger. Amounts in API bodies are decimal dollars; settlement uses integer cents in Postgres RPCs.

Flow:
Stripe Checkout → account_wallets → virtual_wallets (allowance)
  → primary: POST /spend/pay-url (MPP/x402 open world)
  → background ledger: POST /pay (resource or FQDN)

Never hardcode limits, use PRODUCT_POLICY / capabilities.policy.
`,
  idempotency: `# Idempotency

Send Idempotency-Key on mutating writes (pay, fund, withdraw, recycle, resource patch, webhook create, policy templates).
MCP auto-generates a UUID when omitted on pay / fund / withdraw / recycle.

Same key + same body → replay (Idempotency-Replayed: true).
Same key + different body → 409 idempotency_conflict.
`,
  webhooks: `# Webhooks

POST /webhooks with https URL (localhost allowed outside production).

Headers on delivery:
- X-Rill-Webhook-Id
- X-Rill-Timestamp
- X-Rill-Signature (v1,<hex hmac of eventId.timestamp.rawBody>)

Verify timestamp within 300s. Deliveries retry with backoff; use POST …/test and …/deliveries/:id/retry.
Events include payment.succeeded, transfer.received, funding.paid, withdrawal.paid, vw.revoked, resource.updated, …
`,
  errors: `# Errors

Envelope:
{ "ok": false, "error": { "code", "message", "details": { "next": … } }, "request_id": "…" }

402 responses may include payment_terms. Rate limits set Retry-After and X-RateLimit-* headers.
`,
  recipes: `# Recipes

## Closed loop (Accept × Spend), hero
1. Seller: rill_create_seller → rill_create_pay_link → rill_enable_payments → share gate_url → rill_webhooks payment.succeeded
2. Buyer: rill_register_agent OR claim_handle → rill_fund → rill_create_wallet
3. rill_pay_url { url: gate_url or capabilities.urls.seed_gate }
4. Unlock = successful response body/headers (Rill gates return unlocked + receipt_id); webhook notifies seller backend
5. rill_balance with vw_key to stay inside budget

## Cold-start spend (MCP)
1. Fund VW as above
2. Prefer known Accept gate before browsing catalogs
3. Else rill_discover (payment_ready only; skip stale) → rill_pay_url
4. Do not pass marketing/docs URLs

## Background ledger (seed / in-Rill A2A)
1. Funded VW → rill_pay { resource_id: "SEED23" } OR { to: "research.acme.userill.com", amount }
2. rill_verify_receipt; unlock seed with GET /demo/echo + X-Rill-Receipt

## Accept go-live (gate URL + webhook)
1. rill_create_seller → rill_create_pay_link → share gate_url (agents pay this; pay_page_url is the same SKU for humans)
2. rill_enable_payments (required for open-rail 402)
3. rill_webhooks action=create for payment.succeeded, unlocks your product
4. Test: agent rill_pay_url against gate_url
5. Open rails settle in Stripe; ledger Connect withdraw only for background Rill balance

## Discover
1. rill_capabilities (seed_gate, happy_paths.closed_loop, directory_catalog)
2. Prefer Accept gates; else rill_discover
3. rill_resolve_handle with @handle, handle.userill.com, or agent.handle.userill.com

## Connect Express payouts
1. rill_create_seller → save rill_sk_*
2. Enable payments; agent pays the gate; seller balance is credited
3. rill_connect action=onboard (pass country) → human opens onboard_url (Stripe Express KYC)
4. Poll rill_connect action=sync until connect.payouts_enabled / onboarded
5. If requirements remain: rill_connect action=login
6. Auto Transfer when balance meets the minimum, or rill_withdraw with Idempotency-Key. Owner rill_recycle moves balance to the account wallet without Stripe.

Money model: platform Checkout funds wallets; open Accept/Spend settle via MPP/x402 in Stripe; Accept credits seller balance then Connect Transfer; background ledger pays use the same seller balance and withdraw.

## Fleet spend
1. Claim handle
2. Create policy templates (POST /policies)
3. Mint many VWs with policy_template_id
4. Agents pay under shared caps
`,
};

export function registerRillDocsResources(server: McpServer) {
  for (const [name, text] of Object.entries(DOCS)) {
    const uri = `rill://docs/${name}`;
    server.registerResource(
      name,
      uri,
      {
        description: `Rill docs: ${name}`,
        mimeType: "text/markdown",
      },
      async () => ({
        contents: [
          {
            uri,
            mimeType: "text/markdown",
            text,
          },
        ],
      }),
    );
  }
}
