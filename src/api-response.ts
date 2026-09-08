/**
 * Actionable next-step lines appended after MCP tool JSON results.
 * Mirrors Beecargo's formatToolResult pattern for Rill money flows.
 */

import { hintForError } from "@rill/shared";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function unwrapBody(body: unknown): Record<string, unknown> | null {
  const record = asRecord(body);
  if (!record) return null;
  const nested = asRecord(record.data);
  return nested ?? record;
}

function errorRecord(body: unknown): Record<string, unknown> | null {
  const record = asRecord(body);
  if (!record) return null;
  return asRecord(record.error) ?? record;
}

function errorCode(body: unknown): string | null {
  const err = errorRecord(body);
  if (!err) return null;
  if (typeof err.code === "string") return err.code;
  return null;
}

function strField(
  obj: Record<string, unknown> | null,
  ...keys: string[]
): string | null {
  if (!obj) return null;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/** Success: fund checkout URL or embedded intent + poll next step. */
export function fundCheckoutLines(body: unknown): string[] | null {
  const data = unwrapBody(body);
  const checkoutUrl = strField(data, "checkout_url", "checkoutUrl");
  const clientSecret = strField(data, "client_secret", "clientSecret");
  const intentId = strField(data, "funding_intent_id", "fundingIntentId");
  if (checkoutUrl?.startsWith("http")) {
    const lines = [
      `Checkout: ${checkoutUrl}`,
      "Send this Stripe link to the human to fund the account wallet.",
    ];
    if (intentId) {
      lines.push(
        `After payment, poll rill_fund action=intent with funding_intent_id=${intentId}.`,
      );
    }
    return lines;
  }
  if (!clientSecret && !intentId) return null;
  const lines = [
    "Top-up PaymentIntent ready. Ask the human to add funds in the Rill dashboard (in-app checkout), or retry with hosted=true for a Stripe Checkout URL.",
  ];
  if (intentId) {
    lines.push(
      `After payment, poll rill_fund action=intent with funding_intent_id=${intentId}.`,
    );
  }
  return lines;
}

/** Success: Connect onboard / login URLs. */
export function connectLinkLines(body: unknown): string[] | null {
  const data = unwrapBody(body);
  const onboardUrl = strField(data, "onboard_url", "onboardUrl");
  if (onboardUrl?.startsWith("http")) {
    return [
      `Connect onboarding: ${onboardUrl}`,
      "Send this Stripe Express link to the human for KYC.",
      "After they finish, call rill_connect action=sync, then action=status until onboarded/payouts_enabled.",
    ];
  }
  const loginUrl = strField(data, "login_url", "loginUrl");
  if (loginUrl?.startsWith("http")) {
    return [
      `Express login: ${loginUrl}`,
      "Send this link to the human to finish outstanding Connect requirements, then call rill_connect action=sync.",
    ];
  }
  return null;
}

/** Success: receipt after pay. */
export function receiptLines(body: unknown): string[] | null {
  const data = unwrapBody(body);
  const receiptId = strField(data, "receipt_id", "receiptId");
  if (!receiptId) return null;
  return [
    `Receipt: ${receiptId}`,
    "Call rill_verify_receipt before unlocking. For the seed demo, GET /demo/echo with X-Rill-Receipt.",
  ];
}

/** Success: VW mint adoption. */
export function mintVwLines(body: unknown): string[] | null {
  const data = unwrapBody(body);
  const vw = asRecord(data?.virtual_wallet) ?? data;
  const apiKey = strField(vw, "api_key", "apiKey");
  const fqdn = strField(vw, "fqdn");
  if (!apiKey) return null;
  const lines = [
    "Adopted VW key into session for subsequent pay tools.",
    "Primary: rill_pay_url against any MPP/x402 URL. Background ledger: rill_pay with resource_id or to=<FQDN>.",
  ];
  if (fqdn) lines.push(`Agent FQDN: ${fqdn}`);
  return lines;
}

/** Success: seller create. */
export function sellerCreateLines(body: unknown): string[] | null {
  const data = unwrapBody(body);
  const seller = asRecord(data?.seller) ?? data;
  const apiKey = strField(seller, "api_key", "apiKey");
  if (!apiKey) return null;
  return [
    "Seller key adopted into session when present.",
    "Next: rill_create_pay_link (or rill_resources action=create); for off-ramp use rill_connect action=onboard.",
  ];
}

/** Success: pay link composition is handled in-tool; hint for funding intent paid. */
export function fundingIntentLines(body: unknown): string[] | null {
  const data = unwrapBody(body);
  const status = strField(data, "status");
  if (!status) return null;
  if (status === "paid" || status === "succeeded" || status === "complete") {
    return [
      `Funding intent status: ${status}`,
      "Wallet is funded, mint a VW with rill_create_wallet, then rill_pay_url.",
    ];
  }
  if (
    status === "pending" ||
    status === "open" ||
    status === "requires_payment"
  ) {
    return [
      `Funding intent status: ${status}`,
      "Human still needs to complete Checkout. Re-poll rill_fund action=intent shortly.",
    ];
  }
  return [`Funding intent status: ${status}`];
}

/** Errors: map common Rill codes to next steps (shared hints + MCP extras). */
export function errorHintLines(body: unknown): string[] | null {
  const code = errorCode(body);
  if (!code) return null;
  const shared = hintForError(code);
  if (shared) {
    const lines = [shared.action];
    if (shared.tool) lines.push(`Try MCP tool: ${shared.tool}`);
    if (shared.path) lines.push(`HTTP: ${shared.path}`);
    return lines;
  }
  const extras: Record<string, string[]> = {
    insufficient_seller_balance: [
      "Seller balance too low for withdraw/recycle.",
      "Wait for resource pays to credit the seller, then retry.",
    ],
    allowlist_denied: [
      "Destination/resource not on the VW allowlist.",
      "Mint a VW with a broader allowlist or pay an allowlisted resource_id.",
    ],
    unauthorized: [
      "Auth missing or invalid.",
      "Pass owner_jwt / vw_key / seller_key, or set RILL_OWNER_JWT / RILL_VW_KEY / RILL_SELLER_KEY.",
    ],
  };
  return extras[code] ?? null;
}

export function formatToolResult(
  result: { ok: boolean; status: number; body: unknown },
  extraLines?: string[],
): string {
  const parts = [
    JSON.stringify(
      { ok: result.ok, status: result.status, body: result.body },
      null,
      2,
    ),
  ];
  if (result.ok) {
    for (const lines of [
      fundCheckoutLines(result.body),
      connectLinkLines(result.body),
      receiptLines(result.body),
      mintVwLines(result.body),
      sellerCreateLines(result.body),
      fundingIntentLines(result.body),
    ]) {
      if (lines?.length) parts.push(lines.join("\n"));
    }
  } else {
    const hints = errorHintLines(result.body);
    if (hints?.length) parts.push(hints.join("\n"));
  }
  if (extraLines?.length) parts.push(...extraLines);
  return parts.join("\n\n");
}

export function wrapToolResult(
  result: { ok: boolean; status: number; body: unknown },
  extraLines?: string[],
) {
  const err = errorRecord(result.body);
  const code =
    (typeof err?.code === "string" && err.code) ||
    (!result.ok ? "request_failed" : null);
  const message =
    (typeof err?.message === "string" && err.message) ||
    (!result.ok ? "Request failed" : null);
  return {
    content: [
      {
        type: "text" as const,
        text: formatToolResult(result, extraLines),
      },
    ],
    isError: !result.ok,
    ...(!result.ok && code && message
      ? { structuredContent: { code, message } }
      : {}),
  };
}
