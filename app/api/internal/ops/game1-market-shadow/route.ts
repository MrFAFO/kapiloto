import { getApiFootballMinRequestIntervalMs } from "@/lib/kapiloto/research-config";
import { ApiFootballClient } from "@/lib/providers/api-football";
import { SupabaseApiFootballSyncStore } from "@/lib/providers/api-football-supabase-store";
import { aggregateMarketPrior } from "@/lib/providers/market";
import type { ProviderSpikeFixtureInput } from "@/lib/providers/types";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(): Promise<Response> {
  if (process.env.VERCEL_ENV !== "preview") {
    return Response.json({ ok: false, error: "preview_only" }, { status: 403 });
  }

  const apiKey = process.env.API_FOOTBALL_API_KEY?.trim();
  if (!apiKey) {
    return Response.json(
      { ok: false, error: "API_FOOTBALL_API_KEY_missing" },
      { status: 503 },
    );
  }

  const admin = createAdminClient();
  const { data: round, error: roundError } = await admin
    .from("rounds")
    .select("id,external_round_number")
    .eq("external_round_number", "264301")
    .maybeSingle();

  if (roundError) throw new Error(roundError.message);
  if (!round) {
    return Response.json({ ok: false, error: "round_not_found" }, { status: 404 });
  }

  const store = new SupabaseApiFootballSyncStore(admin);
  const games = await store.loadRoundGames(String(round.id));
  const game = games.find((item) => item.gameNumber === 1);
  if (!game) {
    return Response.json({ ok: false, error: "game_1_not_found" }, { status: 404 });
  }

  const client = new ApiFootballClient(apiKey, {
    minRequestIntervalMs: getApiFootballMinRequestIntervalMs(),
  });

  const input: ProviderSpikeFixtureInput = {
    gameNumber: game.gameNumber,
    homeTeam: game.home.canonicalName,
    awayTeam: game.away.canonicalName,
    kickoffAt: game.kickoffAt,
    competition: game.competitionName,
    aliases: {
      home: game.home.aliases,
      away: game.away.aliases,
    },
    apiFootballFixtureId: game.providerFixtureId ?? undefined,
    providerTeamIds: {
      home: game.home.providerTeamId,
      away: game.away.providerTeamId,
    },
    providerCompetitionId: game.providerCompetitionId ?? null,
  };

  const resolved = await client.resolveFixture(input);
  if (!resolved.fixture) {
    return Response.json({
      ok: false,
      error: "fixture_not_resolved",
      resolution: resolved.resolution,
    }, { status: 409 });
  }

  if (
    game.home.providerTeamId != null &&
    game.home.providerTeamId !== resolved.fixture.home.id
  ) {
    return Response.json({ ok: false, error: "home_mapping_mismatch" }, { status: 409 });
  }
  if (
    game.away.providerTeamId != null &&
    game.away.providerTeamId !== resolved.fixture.away.id
  ) {
    return Response.json({ ok: false, error: "away_mapping_mismatch" }, { status: 409 });
  }

  const quotes = await client.getThreeWayQuotes(resolved.fixture);
  const marketPrior = aggregateMarketPrior(quotes);
  if (!marketPrior) {
    return Response.json({
      ok: false,
      error: "no_market",
      providerFixtureId: resolved.fixture.providerFixtureId,
      bookmakerCount: 0,
    }, { status: 207 });
  }

  const capturedAt = new Date().toISOString();
  await store.saveResolvedSnapshot({
    game,
    fixture: resolved.fixture,
    marketPrior,
    capturedAt,
    resolution:
      resolved.resolution === "provided_id" ||
      resolved.resolution === "provider_team_ids"
        ? resolved.resolution
        : "name_match",
  });

  return Response.json({
    ok: true,
    round: round.external_round_number,
    gameNumber: game.gameNumber,
    home: game.home.canonicalName,
    away: game.away.canonicalName,
    providerFixtureId: resolved.fixture.providerFixtureId,
    resolution: resolved.resolution,
    capturedAt,
    marketPrior,
  });
}
