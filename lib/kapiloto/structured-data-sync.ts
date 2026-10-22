import type { SupabaseClient } from "@supabase/supabase-js";

import {
  buildFixtureStructuredSnapshotV1,
  type TeamStructuredProviderInput,
} from "@/lib/football-features/snapshot";
import { SupabaseFixtureStructuredSnapshotStore } from "@/lib/football-features/supabase-store";
import type {
  ProviderCompletedMatch,
  ProviderFixture,
  ProviderSpikeFixtureInput,
  ProviderStanding,
} from "@/lib/providers/types";
import type { ApiFootballClient } from "@/lib/providers/api-football";
import {
  SupabaseApiFootballSyncStore,
} from "@/lib/providers/api-football-supabase-store";
import type { ApiFootballRoundGame } from "@/lib/providers/api-football-sync";
import type { SportmonksClient } from "@/lib/providers/sportmonks";
import {
  SupabaseSportmonksSyncStore,
} from "@/lib/providers/sportmonks-supabase-store";
import type { SportmonksRoundGame } from "@/lib/providers/sportmonks-sync";

export type StructuredFixtureSyncStatus =
  | "saved_sportmonks"
  | "saved_api_football"
  | "skipped_kickoff"
  | "unavailable";

export type StructuredFixtureSyncResult = {
  fixtureId: string;
  gameNumber: number;
  status: StructuredFixtureSyncStatus;
  snapshotId: string | null;
  provider: "sportmonks" | "api-football" | null;
  error: string | null;
};

export type StructuredRoundSyncResult = {
  roundId: string;
  capturedAt: string;
  fixtures: StructuredFixtureSyncResult[];
};

type StructuredSportmonksSource = Pick<
  SportmonksClient,
  "resolveFixture" | "getTeamCompletedMatches" | "getStandings"
>;

type StructuredApiFootballSource = Pick<
  ApiFootballClient,
  "resolveFixture" | "getTeamCompletedMatches" | "getStandings"
>;

function fixtureInput(
  game: ApiFootballRoundGame | SportmonksRoundGame,
  provider: "sportmonks" | "api-football",
): ProviderSpikeFixtureInput {
  return {
    gameNumber: game.gameNumber,
    homeTeam: game.home.canonicalName,
    awayTeam: game.away.canonicalName,
    kickoffAt: game.kickoffAt,
    competition: game.competitionName,
    aliases: {
      home: game.home.aliases,
      away: game.away.aliases,
    },
    ...(provider === "sportmonks" && game.providerFixtureId != null
      ? { sportmonksFixtureId: game.providerFixtureId }
      : {}),
    ...(provider === "api-football" && game.providerFixtureId != null
      ? { apiFootballFixtureId: game.providerFixtureId }
      : {}),
  };
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function enoughHistory(
  home: ProviderCompletedMatch[],
  away: ProviderCompletedMatch[],
): boolean {
  return home.length > 0 && away.length > 0;
}

function teamInput(
  provider: "sportmonks" | "api-football",
  providerTeamId: string,
  target: ProviderFixture,
  matches: ProviderCompletedMatch[],
  standings: ProviderStanding[],
  observedAt: string,
): TeamStructuredProviderInput {
  return {
    provider,
    providerTeamId,
    providerCompetitionId: target.competition.id,
    providerSeason: target.season,
    matches,
    standings,
    observedAt,
  };
}

async function collectSportmonks(
  source: StructuredSportmonksSource,
  game: SportmonksRoundGame,
  cutoffAt: string,
  standingsCache: Map<string, Promise<ProviderStanding[]>>,
): Promise<{
  target: ProviderFixture;
  home: TeamStructuredProviderInput;
  away: TeamStructuredProviderInput;
} | null> {
  const resolved = await source.resolveFixture(
    fixtureInput(game, "sportmonks"),
  );
  const target = resolved.fixture;
  if (!target || target.season == null) return null;

  const endMs = Date.parse(cutoffAt);
  const startMs = endMs - 210 * 86_400_000;
  const [homeMatches, awayMatches] = await Promise.all([
    source.getTeamCompletedMatches(
      target.home.id,
      isoDate(startMs),
      isoDate(endMs),
    ),
    source.getTeamCompletedMatches(
      target.away.id,
      isoDate(startMs),
      isoDate(endMs),
    ),
  ]);
  if (!enoughHistory(homeMatches, awayMatches)) return null;

  const standingsKey = String(target.season);
  let standingsPromise = standingsCache.get(standingsKey);
  if (!standingsPromise) {
    standingsPromise = source.getStandings(target.season);
    standingsCache.set(standingsKey, standingsPromise);
  }
  const standings = await standingsPromise.catch(() => []);

  return {
    target,
    home: teamInput(
      "sportmonks",
      target.home.id,
      target,
      homeMatches,
      standings,
      cutoffAt,
    ),
    away: teamInput(
      "sportmonks",
      target.away.id,
      target,
      awayMatches,
      standings,
      cutoffAt,
    ),
  };
}

async function collectApiFootball(
  source: StructuredApiFootballSource,
  game: ApiFootballRoundGame,
  cutoffAt: string,
  standingsCache: Map<string, Promise<ProviderStanding[]>>,
): Promise<{
  target: ProviderFixture;
  home: TeamStructuredProviderInput;
  away: TeamStructuredProviderInput;
} | null> {
  const resolved = await source.resolveFixture(
    fixtureInput(game, "api-football"),
  );
  const target = resolved.fixture;
  if (!target || target.season == null) return null;

  const [homeMatches, awayMatches] = await Promise.all([
    source.getTeamCompletedMatches(target.home.id, 24),
    source.getTeamCompletedMatches(target.away.id, 24),
  ]);
  if (!enoughHistory(homeMatches, awayMatches)) return null;

  const standingsKey = `${target.competition.id}:${target.season}`;
  let standingsPromise = standingsCache.get(standingsKey);
  if (!standingsPromise) {
    standingsPromise = source.getStandings(
      target.competition.id,
      target.season,
    );
    standingsCache.set(standingsKey, standingsPromise);
  }
  const standings = await standingsPromise.catch(() => []);

  return {
    target,
    home: teamInput(
      "api-football",
      target.home.id,
      target,
      homeMatches,
      standings,
      cutoffAt,
    ),
    away: teamInput(
      "api-football",
      target.away.id,
      target,
      awayMatches,
      standings,
      cutoffAt,
    ),
  };
}

export async function syncKapilotoStructuredRound(
  client: SupabaseClient,
  roundId: string,
  options: {
    sportmonks?: StructuredSportmonksSource | null;
    apiFootball?: StructuredApiFootballSource | null;
    now?: Date;
    safetyWindowMinutes?: number;
  } = {},
): Promise<StructuredRoundSyncResult> {
  const now = options.now ?? new Date();
  const capturedAt = now.toISOString();
  const safetyMs = (options.safetyWindowMinutes ?? 15) * 60_000;

  const [sportmonksGames, apiGames] = await Promise.all([
    options.sportmonks
      ? new SupabaseSportmonksSyncStore(client).loadRoundGames(roundId)
      : Promise.resolve([]),
    options.apiFootball
      ? new SupabaseApiFootballSyncStore(client).loadRoundGames(roundId)
      : Promise.resolve([]),
  ]);

  const smByFixture = new Map(
    sportmonksGames.map((game) => [game.fixtureId, game]),
  );
  const apiByFixture = new Map(
    apiGames.map((game) => [game.fixtureId, game]),
  );
  const allGames = (
    sportmonksGames.length > 0 ? sportmonksGames : apiGames
  ).slice().sort((a, b) => a.gameNumber - b.gameNumber);

  const snapshots = new SupabaseFixtureStructuredSnapshotStore(client);
  const smStandings = new Map<string, Promise<ProviderStanding[]>>();
  const apiStandings = new Map<string, Promise<ProviderStanding[]>>();
  const results: StructuredFixtureSyncResult[] = [];

  for (const canonicalGame of allGames) {
    const kickoffMs = Date.parse(canonicalGame.kickoffAt);
    if (
      !Number.isFinite(kickoffMs) ||
      now.getTime() >= kickoffMs - safetyMs
    ) {
      results.push({
        fixtureId: canonicalGame.fixtureId,
        gameNumber: canonicalGame.gameNumber,
        status: "skipped_kickoff",
        snapshotId: null,
        provider: null,
        error: null,
      });
      continue;
    }

    let collected:
      | Awaited<ReturnType<typeof collectSportmonks>>
      | Awaited<ReturnType<typeof collectApiFootball>>
      | null = null;
    let provider: "sportmonks" | "api-football" | null = null;
    const errors: string[] = [];

    const smGame = smByFixture.get(canonicalGame.fixtureId);
    if (options.sportmonks && smGame) {
      try {
        collected = await collectSportmonks(
          options.sportmonks,
          smGame,
          capturedAt,
          smStandings,
        );
        if (collected) provider = "sportmonks";
      } catch (error) {
        errors.push(
          `sportmonks: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const apiGame = apiByFixture.get(canonicalGame.fixtureId);
    if (!collected && options.apiFootball && apiGame) {
      try {
        collected = await collectApiFootball(
          options.apiFootball,
          apiGame,
          capturedAt,
          apiStandings,
        );
        if (collected) provider = "api-football";
      } catch (error) {
        errors.push(
          `api-football: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (!collected || !provider) {
      results.push({
        fixtureId: canonicalGame.fixtureId,
        gameNumber: canonicalGame.gameNumber,
        status: "unavailable",
        snapshotId: null,
        provider: null,
        error: errors.join("; ") || "No provider returned usable history.",
      });
      continue;
    }

    const draft = buildFixtureStructuredSnapshotV1(
      {
        fixtureId: canonicalGame.fixtureId,
        researchCutoffAt: capturedAt,
        targetKickoffAt: canonicalGame.kickoffAt,
        home: collected.home,
        away: collected.away,
      },
      capturedAt,
    );
    const saved = await snapshots.save(draft);

    results.push({
      fixtureId: canonicalGame.fixtureId,
      gameNumber: canonicalGame.gameNumber,
      status:
        provider === "sportmonks"
          ? "saved_sportmonks"
          : "saved_api_football",
      snapshotId: saved.id,
      provider,
      error: errors.length > 0 ? errors.join("; ") : null,
    });
  }

  return {
    roundId,
    capturedAt,
    fixtures: results,
  };
}
