# Rill MCP

Agent tools for Rill payments (Accept / Spend / Network).

Portable marketplace packaging (Agent Plugins 1.0 + Cursor/Codex manifests) lives in [`rillongit/agent-plugin`](https://github.com/rillongit/agent-plugin).

Tool results wrap `{ ok, status, body }` and append next-step hints (fund checkout, Connect URLs, receipts, shared error hints).

## Transports

| Mode | Entry | Default |
| --- | --- | --- |
| stdio | `rill-mcp` / `pnpm dev` | Cursor local |
| HTTP | `rill-mcp-http` / `pnpm dev:http` | Railway / hosted |

HTTP routes: `/mcp`, `/mcp/guest`, `/health`, `/ready`.

## Env

See [`.env.example`](.env.example).

| Variable | Purpose |
| --- | --- |
| `RILL_API_URL` | API base (default `http://localhost:3001`) |
| `RILL_VW_KEY` | Agent virtual wallet key `rill_vw_*` or `rill_vw_test_*` |
| `RILL_SELLER_KEY` | Seller key for resources/balance/Connect |
| `RILL_OWNER_JWT` | Supabase JWT for claim/fund/mint/seller/recycle |
| `RILL_ENVIRONMENT` | `live` (default) or `test` for owner JWT tools (`X-Rill-Environment`) |
| `RILL_MCP_TRANSPORT` | `stdio` (default) or `http` |
| `RILL_MCP_PORT` / `PORT` | HTTP port (default 3101) |
| `RILL_MCP_REQUIRE_AUTH` | Require transport bearer in production |
| `RILL_MERCHANT_OAUTH_ENABLED` | `true` to advertise `https://api.userill.com` as the authorization server |
| `INTERNAL_API_KEY` | Shared with the API for `POST /oauth/introspect/mcp` |

## Tools

| Tool | Auth | Description |
| --- | --- | --- |
| `rill_search_tools` | None | Catalog + happy path |
| `rill_capabilities` | None | Agent capabilities JSON |
| `rill_resolve_handle` | None | Resolve `@handle` / agent FQDN |
| `rill_list_directory` | None | List directory (defaults to payment_ready) |
| `rill_discover` | None | Verified payment_ready gates for Spend |
| `rill_register_agent` | None (PoW) | Bootstrap `rill_vw_*` / `rill_vw_test_*` + handle (`environment` arg) |
| `rill_claim_handle` | Owner JWT | Claim handle + account wallet |
| `rill_accounts` | Owner JWT | List wallets / me |
| `rill_create_wallet` | Owner JWT | Create `rill_vw_*` wallet with budget |
| `rill_verify_receipt` | None | Verify receipt |
| `rill_pay_url` | VW | Pay any MPP/x402 HTTPS URL (primary) |
| `rill_pay` | VW | Background ledger: resource pay or FQDN transfer |
| `rill_balance` | Seller or VW | Balances + Connect flags / VW allowance |
| `rill_fund` | VW or owner JWT | `action`: `checkout` \| `intent` \| `mock` (auto-registers on guest) |
| `rill_resources` | Seller | `action`: `list` \| `create` \| `update` \| `deactivate` |
| `rill_create_pay_link` | Seller | Create `gate_url` (agents pay); `pay_page_url` for humans |
| `rill_enable_payments` | Seller | Enable MPP/x402 on gate URLs |
| `rill_webhooks` | Owner JWT | `payment.succeeded` unlocks your product (`create` \| `list` \| `test` \| `delete`) |
| `rill_sellers` | Owner JWT / seller | `action`: `create` \| `list` \| `me` \| `update` \| `rotate`. Session adopts `rill_sk_*` on create/rotate |
| `rill_connect` | Seller | `action`: `status` \| `onboard` \| `link` \| `oauth` \| `sync` \| `login` |
| `rill_withdraw` | Seller | Transfer seller balance via Connect |
| `rill_recycle` | Owner JWT | Seller balance → account wallet |
| `rill_sync_directory` | Owner JWT | Refresh + probe MPP/x402 directory |

Resources: `rill://docs/{authentication,money,idempotency,webhooks,errors,recipes}`.

Guest HTTP (`/mcp/guest`): search, capabilities, resolve, list_directory, discover, register_agent, verify, fund, pay_url, pay, balance.

## Hero loop (Accept × Spend)

1. **Seller go-live:** `rill_sellers` list or create → `rill_create_pay_link` → `rill_enable_payments` → share `gate_url` → `rill_webhooks` `payment.succeeded`
2. **Buyer (guest):** `rill_fund action=checkout` (auto-registers) → send `checkout_url` to a human → poll `action=intent` → `rill_pay_url`
3. **Buyer (owner):** `claim_handle` → `rill_fund` → `rill_create_wallet` → `rill_pay_url`
4. Optional reach: `rill_discover` (recent `payment_ready` only) → `rill_pay_url`

**Background ledger (seed / A2A):**
1. Fund → `rill_pay` with `resource_id=SEED23` or `to=<FQDN>`
2. `rill_verify_receipt`; unlock seed with `GET /demo/echo` + `X-Rill-Receipt`

## Accept go-live

1. `rill_sellers` `action=list` (or `action=create`) → `rill_create_pay_link` → share `gate_url` (agents pay this; `pay_page_url` is the same SKU for humans)
2. `rill_enable_payments`, enables MPP + x402 (optional `stripe_profile_id`; defaults adopt platform profile for the seller environment)
3. `rill_webhooks` `action=create` for `payment.succeeded`, unlocks your product
4. Test with a funded VW via `rill_pay_url` against `gate_url`

## Connect recipe

1. `rill_sellers` `action=create` → save `rill_sk_*`
2. Earn via resources / pays
3. `rill_connect` `action=onboard` → human opens `onboard_url`
4. Poll `rill_connect` `action=sync` until `connect.payouts_enabled`
5. If stuck: `rill_connect` `action=login`
6. `rill_withdraw` (or owner `rill_recycle`)

Stripe model: platform Checkout on-ramp + Express Transfer off-ramp (separate charges and transfers).

## Examples

- [`examples/cursor-stdio.mcp.json`](examples/cursor-stdio.mcp.json)
- [`examples/cursor-http.mcp.json`](examples/cursor-http.mcp.json)
- [`examples/cursor-http-with-key.mcp.json`](examples/cursor-http-with-key.mcp.json)

## Run

```bash
pnpm --filter @rill/mcp dev
RILL_MCP_TRANSPORT=http pnpm --filter @rill/mcp dev:http
pnpm --filter @rill/mcp smoke:env
pnpm --filter @rill/mcp smoke:http
```

## Deploy

Hosted HTTP: `https://mcp.userill.com/mcp`. Railway builds from the private monorepo using `deploy/mcp/Dockerfile` (clones this public repo at the SHA in `deploy/mcp/submodule.sha`, then builds `@rill/shared` + this package). `apps/mcp/Dockerfile` remains the local/submodule-checkout image.

## Monorepo

This repo is the public submodule [`rillongit/mcp`](https://github.com/rillongit/mcp) at `apps/mcp`. In the private monorepo, `@rill/shared` is resolved via the pnpm workspace.
