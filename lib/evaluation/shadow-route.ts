import { randomUUID } from "node:crypto";

import { shadowCadenceProfile, shadowCycleConfigFromEnv, shadowEvaluationFlags } from "./env";

type Env = Record<string, string | undefined>;

export type ShadowCycleOutcome = {
  failed: boolean;
  summary: Record<string, unknown>;
};

type Logger = {
  info: (message: string, detail: Record<string, unknown>) => void;
  error: (message: string, detail: Record<string, unknown>) => void;
};

/**
 * Request handling for the scheduled shadow evaluation route, kept apart from
 * the Next.js route so it can be tested. The caller decides authorization
 * (worker-secret hash, same as the research worker) and supplies `defer`
 * (Next.js `after`): the request is acknowledged with 202 before the cycle
 * runs, so a database HTTP client with a short timeout never cuts the work.
 *
 * - unauthorized: 401, nothing runs;
 * - shadow evaluation disabled: 200 `enabled: false`, nothing runs;
 * - `{ "preflight": true }`: 200 with configuration only, nothing runs;
 * - otherwise: 202 and one deferred cycle.
 */
export async function handleShadowEvaluationRequest(deps: {
  request: Request;
  authorized: boolean;
  env: Env;
  runCycle: () => Promise<ShadowCycleOutcome>;
  defer: (task: () => Promise<void>) => void;
  log?: Logger;
  now?: () => Date;
}): Promise<Response> {
  const log = deps.log ?? console;
  const now = deps.now ?? (() => new Date());

  if (!deps.authorized) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const flags = shadowEvaluationFlags(deps.env);
  if (!flags.enabled) {
    return Response.json({ ok: true, enabled: false, workStarted: false });
  }

  let preflight = false;
  try {
    const body = (await deps.request.json()) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body) && "preflight" in body) {
      const requested = (body as { preflight?: unknown }).preflight;
      if (typeof requested !== "boolean") {
        return Response.json({ ok: false, error: "invalid_preflight_flag" }, { status: 400 });
      }
      preflight = requested;
    }
  } catch {
    // An empty or malformed body is a normal scheduled invocation.
  }

  if (preflight) {
    const config = shadowCycleConfigFromEnv(deps.env);
    return Response.json({
      ok: true,
      preflight: true,
      enabled: true,
      marketCapture: flags.marketCapture,
      marketProviderConfigured: Boolean(deps.env.API_FOOTBALL_API_KEY?.trim()),
      cadence: shadowCadenceProfile(deps.env),
      budget: config.budget,
      workStarted: false,
      checkedAt: now().toISOString(),
    });
  }

  const runId = `shadow:${randomUUID()}`;
  deps.defer(async () => {
    try {
      const outcome = await deps.runCycle();
      (outcome.failed ? log.error : log.info)("Kapiloto shadow evaluation cycle", {
        runId,
        failed: outcome.failed,
        ...outcome.summary,
      });
    } catch (error) {
      log.error("Kapiloto shadow evaluation cycle failed", {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return Response.json(
    { ok: true, accepted: true, runId, acceptedAt: now().toISOString() },
    { status: 202 },
  );
}
