import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";

import { syncKapilotoStructuredRound } from "@/lib/kapiloto/structured-data-sync";
import { ensureServerKapilotoResearch } from "@/lib/kapiloto/server-research";
import { verifyKapilotoWorkerAuthorization } from "@/lib/kapiloto/worker-auth";
import { getApiFootballMinRequestIntervalMs } from "@/lib/kapiloto/research-config";
import { ApiFootballClient } from "@/lib/providers/api-football";
import { SportmonksClient } from "@/lib/providers/sportmonks";
import { runAutomaticRoundSync } from "@/lib/rounds/automatic-sync";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const STRUCTURED_FRESHNESS_MS = 12 * 60 * 60 * 1000;
const PRECOMPUTE_BUCKET_MS = 15 * 60 * 1000;

type ProactiveCycleResult =
  | {
      status: "research_already_available";
      roundId: string;
      externalRoundNumber: string;
      runId: string;
    }
  | {
      status: "research_already_running";
      roundId: string;
      externalRoundNumber: string;
      runId: string;
    }
  | {
      status: "structured_incomplete";
      roundId: string;
      externalRoundNumber: string;
      structuredReady: number;
    }
  | {
      status: "research_request";
      roundId: string;
      externalRoundNumber: string;
      outcome: string;
      runId: string | null;
      runsConsumed: number;
    };

async function freshStructuredFixtureCount(
  admin: SupabaseClient,
  fixtureIds: string[],
  nowMs: number,
): Promise<number> {
  if (fixtureIds.length !== 16) return 0;

  const cutoff = new Date(nowMs - STRUCTURED_FRESHNESS_MS).toISOString();
  const { data, error } = await admin
    .from("fixture_structured_snapshots")
    .select("fixture_id,computed_at")
    .in("fixture_id", fixtureIds)
    .gte("computed_at", cutoff);

  if (error) {
    throw new Error(
      `Failed to inspect proactive structured snapshots: ${error.message}`,
    );
  }

  return new Set((data ?? []).map((row) => String(row.fixture_id))).size;
}

async function runProactiveRoundResearchCycle(
  requestStartedAt: number,
): Promise<ProactiveCycleResult> {
  const admin = createAdminClient();
  const roundSync = await runAutomaticRoundSync(admin);

  const { data: round, error: roundError } = await admin
    .from("rounds")
    .select("id,external_round_number")
    .eq("external_round_number", roundSync.roundNumber)
    .maybeSingle();

  if (roundError) {
    throw new Error(
      `Failed to resolve proactively synced round: ${roundError.message}`,
    );
  }
  if (!round) {
    throw new Error(
      `Proactively synced round ${roundSync.roundNumber} was not persisted.`,
    );
  }

  const [{ data: games, error: gamesError }, { data: state, error: stateError }] =
    await Promise.all([
      admin
        .from("round_games")
        .select("id,fixture_id")
        .eq("round_id", round.id)
        .order("game_number", { ascending: true }),
      admin
        .from("kapiloto_round_research_state")
        .select("active_run_id,current_run_id,runs_consumed")
        .eq("round_id", round.id)
        .maybeSingle(),
    ]);

  if (gamesError) {
    throw new Error(
      `Failed to load proactive round fixtures: ${gamesError.message}`,
    );
  }
  if (stateError) {
    throw new Error(
      `Failed to load proactive research state: ${stateError.message}`,
    );
  }

  if ((games ?? []).length !== 16) {
    throw new Error(
      `Winner 16 proactive research requires exactly 16 games; got ${games?.length ?? 0}.`,
    );
  }

  if (state?.current_run_id) {
    return {
      status: "research_already_available",
      roundId: String(round.id),
      externalRoundNumber: String(round.external_round_number),
      runId: String(state.current_run_id),
    };
  }

  if (state?.active_run_id) {
    return {
      status: "research_already_running",
      roundId: String(round.id),
      externalRoundNumber: String(round.external_round_number),
      runId: String(state.active_run_id),
    };
  }

  const fixtureIds = (games ?? []).map((game) => String(game.fixture_id));
  let structuredReady = await freshStructuredFixtureCount(
    admin as unknown as SupabaseClient,
    fixtureIds,
    requestStartedAt,
  );

  if (structuredReady < 16) {
    const sportmonksToken = process.env.SPORTMONKS_API_TOKEN?.trim();
    const apiFootballKey = process.env.API_FOOTBALL_API_KEY?.trim();

    const sportmonks = sportmonksToken
      ? new SportmonksClient(sportmonksToken)
      : null;
    const apiFootball = apiFootballKey
      ? new ApiFootballClient(apiFootballKey, {
          minRequestIntervalMs: getApiFootballMinRequestIntervalMs(),
        })
      : null;

    if (!sportmonks && !apiFootball) {
      throw new Error(
        "At least one structured football provider is required for proactive research.",
      );
    }

    await syncKapilotoStructuredRound(admin, String(round.id), {
      sportmonks,
      apiFootball,
    });

    structuredReady = await freshStructuredFixtureCount(
      admin as unknown as SupabaseClient,
      fixtureIds,
      Date.now(),
    );
  }

  if (structuredReady < 16) {
    return {
      status: "structured_incomplete",
      roundId: String(round.id),
      externalRoundNumber: String(round.external_round_number),
      structuredReady,
    };
  }

  const systemUserId = process.env.KAPILOTO_SYSTEM_USER_ID?.trim();
  if (!systemUserId) {
    throw new Error(
      "KAPILOTO_SYSTEM_USER_ID is required for proactive research during the demo phase.",
    );
  }

  const { data: actor, error: actorError } = await admin
    .from("profiles")
    .select("id")
    .eq("id", systemUserId)
    .maybeSingle();

  if (actorError) {
    throw new Error(
      `Failed to validate proactive research actor: ${actorError.message}`,
    );
  }
  if (!actor) {
    throw new Error("Configured proactive research actor does not exist.");
  }

  const bucket = Math.floor(requestStartedAt / PRECOMPUTE_BUCKET_MS);
  const research = await ensureServerKapilotoResearch(admin, {
    userId: systemUserId,
    roundId: String(round.id),
    roundGameId: null,
    intent: "consult",
    idempotencyKey: `system-precompute-${round.external_round_number}-${bucket}`,
    basedOnRunId: null,
    breakerOpen: false,
  });

  return {
    status: "research_request",
    roundId: String(round.id),
    externalRoundNumber: String(round.external_round_number),
    outcome: research.outcome,
    runId: research.run_id ?? null,
    runsConsumed: research.runs_consumed,
  };
}

export async function POST(request: Request): Promise<Response> {
  const requestStartedAt = Date.now();

  if (
    !verifyKapilotoWorkerAuthorization(
      request.headers.get("authorization"),
      process.env.KAPILOTO_WORKER_SECRET_SHA256,
    )
  ) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  after(async () => {
    try {
      const result = await runProactiveRoundResearchCycle(requestStartedAt);
      console.info("Kapiloto proactive round research cycle completed", result);
    } catch (error) {
      console.error("Kapiloto proactive round research cycle failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return Response.json(
    {
      ok: true,
      accepted: true,
      acceptedAt: new Date(requestStartedAt).toISOString(),
    },
    { status: 202 },
  );
}
