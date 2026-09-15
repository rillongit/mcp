/**
 * Unit-style checks for env-config bearer parsing (no network).
 */
import {
  parseBearerCsvTokens,
  getMcpReadinessChecks,
  defaultAppBaseUrl,
  getAppBaseUrl,
} from "../src/env-config.js";
import { buildProtectedResourceMetadata } from "../src/oauth-metadata.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

assert(
  defaultAppBaseUrl("https://api.userill.com") === "https://userill.com",
  "prod API infers prod app origin",
);
assert(
  defaultAppBaseUrl("http://localhost:3001") === "http://localhost:3000",
  "local API keeps local app origin",
);
const prevApp = process.env.RILL_APP_URL;
const prevApp2 = process.env.APP_URL;
const prevApp3 = process.env.NEXT_PUBLIC_APP_URL;
const prevApi = process.env.RILL_API_URL;
delete process.env.RILL_APP_URL;
delete process.env.APP_URL;
delete process.env.NEXT_PUBLIC_APP_URL;
process.env.RILL_API_URL = "https://api.userill.com";
assert(
  getAppBaseUrl() === "https://userill.com",
  "unset APP_URL with prod API does not return localhost",
);
if (prevApp !== undefined) process.env.RILL_APP_URL = prevApp;
else delete process.env.RILL_APP_URL;
if (prevApp2 !== undefined) process.env.APP_URL = prevApp2;
else delete process.env.APP_URL;
if (prevApp3 !== undefined) process.env.NEXT_PUBLIC_APP_URL = prevApp3;
else delete process.env.NEXT_PUBLIC_APP_URL;
if (prevApi !== undefined) process.env.RILL_API_URL = prevApi;
else delete process.env.RILL_API_URL;

assert(parseBearerCsvTokens("a,b").length === 2, "CSV parse");
assert(parseBearerCsvTokens("  tok  ")[0] === "tok", "trim");

let threw = false;
try {
  parseBearerCsvTokens("dup,dup");
} catch {
  threw = true;
}
assert(threw, "duplicate segments rejected");

const prevRequire = process.env.RILL_MCP_REQUIRE_AUTH;
const prevBearer = process.env.RILL_MCP_BEARER_TOKEN;
process.env.RILL_MCP_REQUIRE_AUTH = "true";
delete process.env.RILL_MCP_BEARER_TOKEN;
const locked = getMcpReadinessChecks();
assert(
  locked.checks.some((c) => c.name === "mcp_require_auth_bearer" && !c.ok),
  "require auth without bearer fails readiness",
);
process.env.RILL_MCP_REQUIRE_AUTH = prevRequire;
if (prevBearer !== undefined) {
  process.env.RILL_MCP_BEARER_TOKEN = prevBearer;
} else {
  delete process.env.RILL_MCP_BEARER_TOKEN;
}

const prevOauth = process.env.RILL_MERCHANT_OAUTH_ENABLED;
delete process.env.RILL_MERCHANT_OAUTH_ENABLED;
const offMeta = buildProtectedResourceMetadata() as {
  authorization_servers?: string[];
};
assert(
  !("authorization_servers" in offMeta) ||
    offMeta.authorization_servers === undefined,
  "disabled OAuth must not advertise an empty authorization_servers list",
);
process.env.RILL_MERCHANT_OAUTH_ENABLED = "true";
const onMeta = buildProtectedResourceMetadata();
assert(
  Array.isArray(onMeta.authorization_servers) &&
    onMeta.authorization_servers.length === 1,
  "enabled OAuth advertises the API as authorization server",
);
if (prevOauth !== undefined) {
  process.env.RILL_MERCHANT_OAUTH_ENABLED = prevOauth;
} else {
  delete process.env.RILL_MERCHANT_OAUTH_ENABLED;
}

console.log("smoke-env-config: ok");
