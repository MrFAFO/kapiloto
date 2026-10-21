import { aggregateMarketPrior } from "./market";
import type {
  BookmakerThreeWayQuote,
  MarketPrior,
  ProviderFixture,
  ProviderSpikeFixtureInput,
} from "./types";

export type ApiFootballRoundTeam = {
  teamId: string;
  canonicalName: string;
  aliases: string[];
  providerTeamId: string | null;
};

export type ApiFootballRoundGame = {
  roundGameId: string;
  fixtureId: string;
  gameNumber: number;
  kickoffAt: string;
  competitionId: string | null;
  competitionName: string;
  home: ApiFootballRoundTeam;
  away: ApiFootballRoundTeam;
  providerFixtureId: number | null;
};

export type ApiFootballResolvedSnapshot = {
  game: ApiFootballRoundGame;
  fixture: ProviderFixture;
  marketPrior: MarketPrior;
  capturedAt: string;
  resolution: "provided_id" | "name_match";
};

export interface ApiFootballSyncStore {
  loadRoundGames(roundId: string): Promise<ApiFootballRoundGame[]>;
  saveResolvedSnapshot(snapshot: ApiFootballResolvedSnapshot): Promise<void>;
}

export interface ApiFootballSyncClient {
  resolveFixture(input: ProviderSpikeFixtureInput): Promise<{
    fixture: ProviderFixture | null;
    resolution: "provided_id" | "name_match" | "not_found" | "ambiguous";
  }>;
  getThreeWayQuotes(
    fixture: ProviderFixture,
  ): Promise<BookmakerThreeWayQuote[]>;
}

export type ApiFootballFixtureSyncResult = {
  gameNumber: number;
  roundGameId: string;
  status:
    | "saved"
    | "skipped_kickoff"
    | "not_found"
    | "ambiguous"
    | "no_market"
    | "error";
  providerFixtureId: string | null;
  bookmakerCount: number;
  error: string | null;
};

export type ApiFootballRoundSyncResult = {
  roundId: string;
  startedAt: string;
  completedAt: string;
  fixtures: ApiFootballFixtureSyncResult[];
  summary: {
    requested: number;
    saved: number;
    skippedKickoff: number;
    notFound: number;
    ambiguous: number;
    noMarket: number;
    errors: number;
  };
};

function validateRoundGames(games: ApiFootballRoundGame[]): void {
  if (games.length !== 16) {
    throw new Error(
      `API-Football round sync requires exactly 16 fixtures; got ${games.length}.`,
    );
  }

  const ordered = [...games].sort((a, b) => a.gameNumber - b.gameNumber);
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index].gameNumber !== index + 1) {
      throw new Error("Round sync requires Toto game numbers 1..16 exactly once.");
    }
  }
}

function ensureOrientation(
  game: ApiFootballRoundGame,
  fixture: ProviderFixture,
): void {
  if (
    game.home.providerTeamId != null &&
    game.home.providerTeamId !== fixture.home.id
  ) {
    throw new Error(
      `Provider home-team mapping mismatch for Toto game ${game.gameNumber}.`,
    );
  }

  if (
    game.away.providerTeamId != null &&
    game.away.providerTeamId !== fixture.away.id
  ) {
    throw new Error(
      `Provider away-team mapping mismatch for Toto game ${game.gameNumber}.`,
    );
  }
}

export async function syncApiFootballRoundMarket(
  store: ApiFootballSyncStore,
  client: ApiFootballSyncClient,
  roundId: string,
  clock: () => Date = () => new Date(),
  safetyWindowMinutes = 15,
): Promise<ApiFootballRoundSyncResult> {
  const started = clock();
  const startedAt = started.toISOString();
  const syncBoundaryMs = started.getTime();
  const safetyWindowMs = safetyWindowMinutes * 60_000;
  const games = await store.loadRoundGames(roundId);
  validateRoundGames(games);

  const fixtures: ApiFootballFixtureSyncResult[] = [];

  for (const game of [...games].sort((a, b) => a.gameNumber - b.gameNumber)) {
    const kickoffMs = Date.parse(game.kickoffAt);
    if (
      !Number.isFinite(kickoffMs) ||
      kickoffMs - syncBoundaryMs <= safetyWindowMs
    ) {
      fixtures.push({
        gameNumber: game.gameNumber,
        roundGameId: game.roundGameId,
        status: "skipped_kickoff",
        providerFixtureId: game.providerFixtureId?.toString() ?? null,
        bookmakerCount: 0,
        error: Number.isFinite(kickoffMs) ? null : "invalid kickoff timestamp",
      });
      continue;
    }

    try {
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
      };

      const resolved = await client.resolveFixture(input);

      if (!resolved.fixture) {
        fixtures.push({
          gameNumber: game.gameNumber,
          roundGameId: game.roundGameId,
          status:
            resolved.resolution === "ambiguous" ? "ambiguous" : "not_found",
          providerFixtureId: null,
          bookmakerCount: 0,
          error: null,
        });
        continue;
      }

      ensureOrientation(game, resolved.fixture);

      const quotes = await client.getThreeWayQuotes(resolved.fixture);
      const marketPrior = aggregateMarketPrior(quotes);

      if (!marketPrior) {
        fixtures.push({
          gameNumber: game.gameNumber,
          roundGameId: game.roundGameId,
          status: "no_market",
          providerFixtureId: resolved.fixture.providerFixtureId,
          bookmakerCount: 0,
          error: null,
        });
        continue;
      }

      const capturedAt = clock().toISOString();

      await store.saveResolvedSnapshot({
        game,
        fixture: resolved.fixture,
        marketPrior,
        capturedAt,
        resolution:
          resolved.resolution === "provided_id" ? "provided_id" : "name_match",
      });

      fixtures.push({
        gameNumber: game.gameNumber,
        roundGameId: game.roundGameId,
        status: "saved",
        providerFixtureId: resolved.fixture.providerFixtureId,
        bookmakerCount: marketPrior.bookmakerCount,
        error: null,
      });
    } catch (error) {
      fixtures.push({
        gameNumber: game.gameNumber,
        roundGameId: game.roundGameId,
        status: "error",
        providerFixtureId: null,
        bookmakerCount: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    roundId,
    startedAt,
    completedAt: clock().toISOString(),
    fixtures,
    summary: {
      requested: fixtures.length,
      saved: fixtures.filter((fixture) => fixture.status === "saved").length,
      skippedKickoff: fixtures.filter(
        (fixture) => fixture.status === "skipped_kickoff",
      ).length,
      notFound: fixtures.filter((fixture) => fixture.status === "not_found")
        .length,
      ambiguous: fixtures.filter((fixture) => fixture.status === "ambiguous")
        .length,
      noMarket: fixtures.filter((fixture) => fixture.status === "no_market")
        .length,
      errors: fixtures.filter((fixture) => fixture.status === "error").length,
    },
  };
}
