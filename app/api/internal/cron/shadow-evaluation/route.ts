import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";
import { getApiFootballMinRequestIntervalMs } from "@/lib/kapiloto/research-config";
import { ApiFootballClient } from "@/lib/providers/api-football";
import { SupabaseApiFootballSyncStore } from "@/lib/providers/api-football-supabase-store";
import { SupabaseCurrentRoundLoader } from "@/lib/rounds/current-round";
import { shadowCycleConfigFromEnv, shadowEvaluationFlags } from "@/lib/evaluation/env";
import type { ProviderRequestMeter } from "@/lib/evaluation/market-capture";
import { runShadowEvaluationCycle } from "@/lib/evaluation/shadow-cycle";
import { SupabaseShadowEvaluationStore } from "@/lib/evaluation/supabase-store";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Shadow evaluation cycle (Research v2). Observes and records evaluation data
 * only: it never writes research, publication, prior, ticket or sync-control
 * tables, and its output is not served to users.
 */
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const flags = shadowEvaluationFlags(process.env);
  if (!flags.enabled) {
    return Response.json({ ok: true, enabled: false });
  }

  try {
    const admin = createAdminClient();
    const currentRound = await new SupabaseCurrentRoundLoader(admin).load();
    if (!currentRound) {
      return Response.json({ ok: false, error: "current_round_missing" }, { status: 503 });
    }

    const apiFootballKey = process.env.API_FOOTBALL_API_KEY?.trim();
    const meter: ProviderRequestMeter = { requests: 0, dailyRemaining: null };
    const market =
      flags.marketCapture && apiFootballKey
        ? {
            source: new ApiFootballClient(apiFootballKey, {
              minRequestIntervalMs: getApiFootballMinRequestIntervalMs(),
              onResponse: (info) => {
                meter.requests += 1;
                if (info.dailyRemaining != null) meter.dailyRemaining = info.dailyRemaining;
              },
            }),
            meter,
          }
        : null;

    const summary = await runShadowEvaluationCycle({
      store: new SupabaseShadowEvaluationStore(admin as unknown as SupabaseClient),
      roundId: currentRound.roundId,
      loadRoundGames: (roundId) => new SupabaseApiFootballSyncStore(admin).loadRoundGames(roundId),
      market,
      now: new Date(),
      config: shadowCycleConfigFromEnv(process.env),
    });

    const failed = [summary.market, summary.predictions, summary.kapiloto, summary.scoring].some(
      (step) => step.status === "failed",
    );
    console.info("Kapiloto shadow evaluation cycle", {
      roundId: summary.roundId,
      marketStatus: summary.market.status,
      marketRequests: summary.market.requestsUsed,
      predictionsDue: summary.predictions.due,
      kapilotoInserted: summary.kapiloto.inserted,
      scoresPersisted: summary.scoring.persisted,
      failed,
    });
    return Response.json(
      { ok: !failed, enabled: true, marketProviderConfigured: Boolean(apiFootballKey), ...summary },
      { status: failed ? 207 : 200 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Kapiloto shadow evaluation cycle failed", { error: message });
    return Response.json({ ok: false, error: message }, { status: 503 });
  }
}
