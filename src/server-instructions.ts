import { AGENT_PLAYBOOK } from "@rill/shared";

export function buildServerInstructions(mode: "stdio" | "http"): string {
  const p = AGENT_PLAYBOOK;
  return [
    p.tagline,
    `Motto: ${p.motto}`,
    "",
    "Roles:",
    ...p.roles.map((line) => `- ${line}`),
    "",
    "Hero loop (Accept × Spend):",
    ...p.heroLoop.map((step, i) => `${i + 1}. ${step}`),
    "",
    "Spend (buyer agent), fund is required before pay:",
    ...p.spendSteps.map((step, i) => `${i + 1}. ${step}`),
    "",
    "Accept (seller) go-live:",
    ...p.acceptSteps.map((step, i) => `${i + 1}. ${step}`),
    "",
    "Transfers inside Rill (seed / handle sends):",
    ...p.backgroundLedger.map((step, i) => `${i + 1}. ${step}`),
    "",
    `Discover: ${p.discoverTools.join(" · ")}`,
    "Advanced catalog: rill_list_directory payment_ready=false (research only)",
    "",
    "Response fields to save: rill_sk_* · rill_vw_* · account_wallet_id · gate_url · pay_page_url/short_id · receipt_id · webhook signing secret · request_id",
    "",
    mode === "http"
      ? "HTTP: pass Authorization Bearer rill_vw_* / rill_sk_* / eyJ… owner JWT (or x-rill-*-key headers). Guest /mcp/guest: discover, register, fund (Checkout URL), pay, balance, verify, no owner JWT required for Spend cold-start."
      : "Stdio: set RILL_VW_KEY / RILL_SELLER_KEY / RILL_OWNER_JWT, or rill_register_agent / rill_fund (auto-registers) for a starter wallet.",
  ].join("\n");
}
