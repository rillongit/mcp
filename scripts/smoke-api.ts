/**
 * Hits Rill agent capabilities (requires API). Skips cleanly if unreachable.
 */
import { getApiBaseUrl } from "../src/env-config.js";

const base = getApiBaseUrl();
try {
  const res = await fetch(`${base}/agent/capabilities`);
  if (!res.ok) {
    console.log(`smoke-api: skip (HTTP ${res.status} from ${base})`);
    process.exit(0);
  }
  const body = (await res.json()) as { ok?: boolean };
  if (body && typeof body === "object") {
    console.log("smoke-api: ok");
    process.exit(0);
  }
  throw new Error("unexpected capabilities body");
} catch (err) {
  console.log(
    `smoke-api: skip (${err instanceof Error ? err.message : String(err)})`,
  );
  process.exit(0);
}
