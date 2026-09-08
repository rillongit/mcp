/**
 * Assert MCP catalog hard-cut: 23 live tools, no retired names registered.
 */
import { MCP_TOOL_NAMES, RETIRED_MCP_TOOL_NAMES } from "@rill/shared";
import { TOOL_CATALOG } from "../src/register-tools.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

assert(
  MCP_TOOL_NAMES.length === 23,
  `expected 23 tools, got ${MCP_TOOL_NAMES.length}`,
);
assert(
  TOOL_CATALOG.length === MCP_TOOL_NAMES.length,
  "TOOL_CATALOG length must match MCP_TOOL_NAMES",
);

const live = new Set<string>([...MCP_TOOL_NAMES]);
const catalogNames = new Set<string>(TOOL_CATALOG.map((t) => t.name));

for (const name of MCP_TOOL_NAMES) {
  assert(catalogNames.has(name), `TOOL_CATALOG missing ${name}`);
}

const required = [
  "rill_pay_url",
  "rill_fund",
  "rill_connect",
  "rill_webhooks",
  "rill_resources",
  "rill_balance",
  "rill_create_pay_link",
];
for (const name of required) {
  assert(live.has(name), `missing required tool ${name}`);
}

for (const retired of RETIRED_MCP_TOOL_NAMES as readonly string[]) {
  assert(!live.has(retired), `retired tool still live: ${retired}`);
  assert(
    !catalogNames.has(retired),
    `retired tool still in TOOL_CATALOG: ${retired}`,
  );
}

console.log(
  `smoke-tools: ok (${MCP_TOOL_NAMES.length} tools, ${RETIRED_MCP_TOOL_NAMES.length} retired forbidden)`,
);
