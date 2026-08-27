import { getApiBaseUrl, getMcpPublicOrigin } from "./env-config.js";

const BANNER = [
  " ____                                     ",
  "|  _ \\ __ _ ___ ___  __ _  __ _  ___      ",
  "| |_) / _` / __/ __|/ _` |/ _` |/ _ \\     ",
  "|  __/ (_| \\__ \\__ \\ (_| | (_| |  __/     ",
  "|_|   \\__,_|___/___/\\__,_|\\__, |\\___|     ",
  "                          |___/           ",
].join("\n");

const TAGLINES = [
  "mcp for agent payments.",
  "accept. spend. settle.",
  "pay a handle. unlock a resource.",
  "tools in. receipt out.",
] as const;

let taglineIndex = -1;

function getTagline(): string {
  taglineIndex = (taglineIndex + 1) % TAGLINES.length;
  return TAGLINES[taglineIndex] ?? TAGLINES[0];
}

export function getMcpBrandText(): string {
  const origin = getMcpPublicOrigin();
  const api = getApiBaseUrl();
  const links = [
    { label: "Documentation", url: "https://userill.com/docs/mcp/overview" },
    { label: "endpoint", url: `${origin}/mcp` },
    { label: "guest", url: `${origin}/mcp/guest` },
    { label: "llms.txt", url: "https://userill.com/llms.txt" },
    { label: "api", url: api },
  ]
    .map(({ label, url }) => `- ${label}  ${url}`)
    .join("\n");
  const auth =
    "Auth: Authorization Bearer rill_vw_* / rill_sk_* / owner JWT.\nGuest tools: /mcp/guest";
  return `▲\n\n${BANNER}\n\n${getTagline()}\n\n${auth}\n\n${links}\n`;
}

export function printMcpConsoleBrand(): void {
  console.log(`\n${getMcpBrandText()}`);
}
