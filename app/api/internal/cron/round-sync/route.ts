import { createAdminClient } from "@/lib/supabase/admin";
import { syncKapilotoStructuredRound } from "@/lib/kapiloto/structured-data-sync";
import { getApiFootballMinRequestIntervalMs } from "@/lib/kapiloto/research-config";
import { ApiFootballClient } from "@/lib/providers/api-football";
import { SupabaseApiFootballSyncStore } from "@/lib/providers/api-football-supabase-store";
import { syncApiFootballRoundMarket } from "@/lib/providers/api-football-sync";
import { SportmonksClient } from "@/lib/providers/sportmonks";
import { runAutomaticRoundSync } from "@/lib/rounds/automatic-sync";
import { SupabaseCurrentRoundLoader } from "@/lib/rounds/current-round";
import { runAutomaticLiveSync } from "@/lib/rounds/live-sync";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  const authorization = request.headers.get("authorization");

  if (!secret || authorization !== `Bearer ${secret}`) {
    return Response.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  try {
    const admin = createAdminClient();
    const roundSync = await runAutomaticRoundSync(admin);
    const currentRound = await new SupabaseCurrentRoundLoader(admin).load();

    const apiFootballKey = process.env.API_FOOTBALL_API_KEY?.trim();
    const sportmonksToken = process.env.SPORTMONKS_API_TOKEN?.trim();
    const apiFootball = apiFootballKey
      ? new ApiFootballClient(apiFootballKey, {
          minRequestIntervalMs: getApiFootballMinRequestIntervalMs(),
        })
      : null;
    const sportmonks = sportmonksToken
      ? new SportmonksClient(sportmonksToken)
      : null;

    let marketSync = null;
    let structuredSync = null;
    if (currentRound) {
      if (apiFootball) {
        marketSync = await syncApiFootballRoundMarket(
          new SupabaseApiFootballSyncStore(admin),
          apiFootball,
          currentRound.roundId,
        );
      }

      if (sportmonks || apiFootball) {
        structuredSync = await syncKapilotoStructuredRound(
          admin,
          currentRound.roundId,
          { sportmonks, apiFootball },
        );
      }
    }

    const liveSync = currentRound
      ? await runAutomaticLiveSync(admin, currentRound.roundId)
      : null;

    return Response.json({
      ok: true,
      checkedAt: new Date().toISOString(),
      roundSync,
      marketSync,
      structuredSync,
      liveSync,
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }
}
