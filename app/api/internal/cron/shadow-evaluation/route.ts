import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { getApiFootballMinRequestIntervalMs } from "@/lib/kapiloto/research-config";
import { verifyKapilotoWorkerAuthorization } from "@/lib/kapiloto/worker-auth";
import { ApiFootballClient } from "@/lib/providers/api-football";
import { SupabaseApiFootballSyncStore } from "@/lib/providers/api-football-supabase-store";
import { SupabaseCurrentRoundLoader } from "@/lib/rounds/current-round";
import { SportmonksClient } from "@/lib/providers/sportmonks";
import { shadowCycleConfigFromEnv, shadowEvaluationFlags, shadowResultsIngestEnabled } from "@/lib/evaluation/env";
import type { ProviderRequestMeter } from "@/lib/evaluation/market-capture";
import { runShadowEvaluationCycle } from "@/lib/evaluation/shadow-cycle";
import { handleShadowEvaluationRequest } from "@/lib/evaluation/shadow-route";
import {
  SupabaseMatchResultStore,
  SupabaseResultsFreshnessStore,
  SupabaseShadowEvaluationStore,
} from "@/lib/evaluation/supabase-store";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Shadow evaluation cycle (Research v2), invoked by Supabase pg_cron through
 * pg_net with the research worker's secret. Observes and records evaluation
 * data only: it never writes research, publication, prior, ticket or
 * sync-control tables, and its output is not served to users.
 */
export async function POST(request: Request): Promise<Response> {
  return handleShadowEvaluationRequest({
    request,
    authorized: verifyKapilotoWorkerAuthorization(
      request.headers.get("authorization"),
      process.env.KAPILOTO_WORKER_SECRET_SHA256,
    ),
    env: process.env,
    defer: after,
    runCycle: async () => {
      const flags = shadowEvaluationFlags(process.env);
      const admin = createAdminClient();
      const currentRound = await new SupabaseCurrentRoundLoader(admin).load();
      if (!currentRound) throw new Error("current_round_missing");

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

      const client = admin as unknown as SupabaseClient;
      const store = new SupabaseShadowEvaluationStore(client);
      const sportmonksToken = process.env.SPORTMONKS_API_TOKEN?.trim();
      // Recurring results ingestion stays off unless explicitly enabled.
      const results =
        shadowResultsIngestEnabled(process.env) && sportmonksToken
          ? {
              source: new SportmonksClient(sportmonksToken),
              sink: new SupabaseMatchResultStore(client),
              freshness: new SupabaseResultsFreshnessStore(client),
              loadLeagueIds: async () =>
                (await store.loadSupportedCompetitionKeys()).map((key) => key.slice(key.indexOf(":") + 1)),
            }
          : null;

      const summary = await runShadowEvaluationCycle({
        store,
        roundId: currentRound.roundId,
        loadRoundGames: (roundId) => new SupabaseApiFootballSyncStore(admin).loadRoundGames(roundId),
        market,
        results,
        now: new Date(),
        config: shadowCycleConfigFromEnv(process.env),
      });

      return {
        failed: [summary.results, summary.market, summary.predictions, summary.kapiloto, summary.scoring].some(
          (step) => step.status === "failed",
        ),
        summary: {
          roundId: summary.roundId,
          resultsStatus: summary.results.status,
          resultsSaved: summary.results.saved,
          marketProviderConfigured: Boolean(apiFootballKey),
          marketStatus: summary.market.status,
          marketRequests: summary.market.requestsUsed,
          marketDailyRemaining: summary.market.providerDailyRemaining,
          predictionsDue: summary.predictions.due,
          kapilotoInserted: summary.kapiloto.inserted,
          scoresPersisted: summary.scoring.persisted,
          errors: [summary.results, summary.market, summary.predictions, summary.kapiloto, summary.scoring]
            .map((step) => step.error)
            .filter(Boolean),
        },
      };
    },
  });
}
