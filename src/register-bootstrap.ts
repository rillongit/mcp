import { solveAgentRegisterPow } from "@rill/shared";
import { callRillApi } from "./api-client.js";

const REGISTER_ATTEMPTS = 3;

function isRetryablePowFailure(status: number, body: unknown): boolean {
  if (status === 429) return false;
  if (status !== 400) return false;
  if (!body || typeof body !== "object") return true;
  const err = body as { error?: { code?: unknown }; code?: unknown };
  const code =
    typeof err.error === "object" && err.error && "code" in err.error
      ? (err.error as { code?: unknown }).code
      : err.code;
  if (typeof code !== "string") return true;
  return (
    code === "pow_required" ||
    code === "invalid_challenge" ||
    code === "expired_challenge" ||
    code === "insufficient_work" ||
    code === "pow_reused" ||
    code === "ip_mismatch"
  );
}

/** Challenge + easy PoW + register, with a few fresh-challenge retries. */
export async function registerBootstrapAgent(
  label?: string,
  environment: "live" | "test" = "live",
): Promise<{
  ok: boolean;
  status: number;
  body: unknown;
}> {
  let last: { ok: boolean; status: number; body: unknown } = {
    ok: false,
    status: 500,
    body: { error: "Register failed" },
  };

  for (let attempt = 0; attempt < REGISTER_ATTEMPTS; attempt += 1) {
    const challenge = await callRillApi({
      method: "POST",
      path: "/agent/register/challenge",
    });
    if (
      !challenge.ok ||
      !challenge.body ||
      typeof challenge.body !== "object"
    ) {
      last = challenge;
      if (challenge.status === 429) return challenge;
      continue;
    }

    const challengeBody = challenge.body as {
      challenge_id?: string;
      difficulty?: number;
    };
    if (
      !challengeBody.challenge_id ||
      typeof challengeBody.difficulty !== "number"
    ) {
      last = {
        ok: false,
        status: challenge.status,
        body: { error: "Invalid register challenge response" },
      };
      continue;
    }

    let nonce: string;
    try {
      nonce = solveAgentRegisterPow(
        challengeBody.challenge_id,
        challengeBody.difficulty,
      );
    } catch {
      last = {
        ok: false,
        status: 500,
        body: { error: "Failed to solve register proof-of-work" },
      };
      continue;
    }

    const result = await callRillApi({
      method: "POST",
      path: "/agent/register",
      environment,
      body: {
        label,
        challenge_id: challengeBody.challenge_id,
        nonce,
        environment,
      },
    });
    last = result;
    if (result.ok) return result;
    if (!isRetryablePowFailure(result.status, result.body)) return result;
  }

  return last;
}
