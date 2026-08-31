import {
  getApiBaseUrl,
  getMcpPublicOrigin,
  merchantOAuthEnabled,
} from "./env-config.js";

export function buildProtectedResourceMetadata() {
  const resource = `${getMcpPublicOrigin()}/mcp`;
  const apiBase = getApiBaseUrl();
  return {
    resource,
    ...(merchantOAuthEnabled()
      ? { authorization_servers: [apiBase.replace(/\/$/, "")] }
      : {}),
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp.read", "mcp.write"],
    resource_documentation: "https://userill.com/docs/mcp/overview",
  };
}
