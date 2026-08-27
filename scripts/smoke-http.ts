/**
 * Boots HTTP MCP briefly and checks /health + /ready.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 3199;
const child = spawn("npx", ["tsx", "src/http-entry.ts"], {
  cwd: mcpRoot,
  env: {
    ...process.env,
    PORT: String(port),
    RILL_MCP_TRANSPORT: "http",
    RILL_MCP_REQUIRE_AUTH: "false",
    RILL_API_URL: process.env.RILL_API_URL ?? "http://localhost:3001",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout?.on("data", (d) => {
  output += String(d);
});
child.stderr?.on("data", (d) => {
  output += String(d);
});

try {
  let ok = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      const ready = await fetch(`http://127.0.0.1:${port}/ready`);
      if (health.ok && ready.ok) {
        ok = true;
        break;
      }
    } catch {
      /* retry */
    }
  }
  if (!ok) {
    throw new Error(`smoke-http failed\n${output}`);
  }
  console.log("smoke-http: ok");
} finally {
  child.kill("SIGTERM");
}
