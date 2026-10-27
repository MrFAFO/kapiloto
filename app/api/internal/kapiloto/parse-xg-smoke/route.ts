import { loadRoundFixtureCardInputs } from "@/lib/kapiloto/fixture-input-store";
import { FootballIlParseClient } from "@/lib/providers/football-il-parse";
import { SupabaseFootballIlSyncStore } from "@/lib/providers/football-il-parse-supabase-store";
import {
  syncFootballIlRoundAnalytics,
  type FootballIlSyncStore,
} from "@/lib/providers/football-il-parse-sync";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  if (process.env.VERCEL_ENV !== "preview") {
    return new Response(null, { status: 404 });
  }

  const apiKey = process.env.PARSE_API_KEY?.trim();
  if (!apiKey) {
    return Response.json(
      { ok: false, error: "configuration_missing" },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const roundId = url.searchParams.get("round_id")?.trim() ?? "";
  const gameNumber = Number(url.searchParams.get("game") ?? "1");

  if (!/^[0-9a-f-]{36}$/i.test(roundId)) {
    return Response.json({ ok: false, error: "invalid_round_id" }, { status: 400 });
  }
  if (!Number.isInteger(gameNumber) || gameNumber < 1 || gameNumber > 16) {
    return Response.json(
      { ok: false, error: "invalid_game_number" },
      { status: 400 },
    );
  }

  try {
    const admin = createAdminClient();
    const baseStore = new SupabaseFootballIlSyncStore(admin);
    const store: FootballIlSyncStore = {
      async loadRoundGames(id) {
        const games = await baseStore.loadRoundGames(id);
        return games.filter((game) => game.gameNumber === gameNumber);
      },
      saveResolvedFixture(snapshot) {
        return baseStore.saveResolvedFixture(snapshot);
      },
      saveFacts(facts) {
        return baseStore.saveFacts(facts);
      },
      hasFreshSeasonFacts(fixtureId, season, capturedAfter) {
        return baseStore.hasFreshSeasonFacts(
          fixtureId,
          season,
          capturedAfter,
        );
      },
    };

    const sync = await syncFootballIlRoundAnalytics(
      store,
      new FootballIlParseClient(apiKey),
      roundId,
    );

    const cutoff = new Date(Date.now() + 1000).toISOString();
    const cards = await loadRoundFixtureCardInputs(admin, roundId, cutoff);
    const card = cards.find((item) => item.gameNumber === gameNumber);

    return Response.json({
      ok: true,
      sync,
      providerAnalytics: card?.providerAnalytics ?? null,
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }
}
