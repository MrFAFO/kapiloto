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

type CronStep<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

async function runStep<T>(
  step: string,
  work: () => Promise<T>,
): Promise<CronStep<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Kapiloto cron step failed", { step, error: message });
    return { ok: false, error: message };
  }
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  const authorization = request.headers.get("authorization");

  if (!secret || authorization !== `Bearer ${secret}`) {
    return Response.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  const admin = createAdminClient();
  const startedAt = new Date().toISOString();

  await admin
    .from("round_sync_control")
    .update({
      last_started_at: startedAt,
      last_finished_at: null,
      last_status: "running",
      last_detail: {},
      updated_at: startedAt,
    })
    .eq("id", 1);

  // The Winner 16 import is useful, but provider snapshots must not depend on
  // it succeeding. Existing canonical rounds remain usable even when the
  // discovery/import source is temporarily unavailable.
  const roundSync = await runStep("round_sync", () =>
    runAutomaticRoundSync(admin),
  );
  const currentRound = await runStep("current_round", () =>
    new SupabaseCurrentRoundLoader(admin).load(),
  );

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

  let marketSync: CronStep<unknown> | null = null;
  let structuredSync: CronStep<unknown> | null = null;
  let liveSync: CronStep<unknown> | null = null;

  if (currentRound.ok && currentRound.value) {
    const roundId = currentRound.value.roundId;

    marketSync = apiFootball
      ? await runStep("market_sync", () =>
          syncApiFootballRoundMarket(
            new SupabaseApiFootballSyncStore(admin),
            apiFootball,
            roundId,
          ),
        )
      : { ok: false, error: "API_FOOTBALL_API_KEY_missing" };

    structuredSync =
      sportmonks || apiFootball
        ? await runStep("structured_sync", () =>
            syncKapilotoStructuredRound(admin, roundId, {
              sportmonks,
              apiFootball,
            }),
          )
        : {
            ok: false,
            error: "SPORTMONKS_API_TOKEN_and_API_FOOTBALL_API_KEY_missing",
          };

    liveSync = await runStep("live_sync", () =>
      runAutomaticLiveSync(admin, roundId),
    );
  }

  const steps = [roundSync, currentRound, marketSync, structuredSync, liveSync]
    .filter((step): step is CronStep<unknown> => step !== null);
  const hasFailure = steps.some((step) => !step.ok);
  const checkedAt = new Date().toISOString();
  const detail = {
    roundSync,
    currentRound,
    marketSync,
    structuredSync,
    liveSync,
  };
  const persistedDetail = JSON.parse(JSON.stringify(detail));

  const { error: controlError } = await admin
    .from("round_sync_control")
    .update({
      last_finished_at: checkedAt,
      last_status: hasFailure ? "partial_failure" : "ok",
      last_detail: persistedDetail,
      updated_at: checkedAt,
    })
    .eq("id", 1);

  if (controlError) {
    console.error("Kapiloto cron control write failed", {
      error: controlError.message,
    });
  }

  return Response.json(
    {
      ok: !hasFailure,
      checkedAt,
      ...detail,
      observability: {
        controlPersisted: !controlError,
      },
    },
    { status: hasFailure ? 207 : 200 },
  );
}
