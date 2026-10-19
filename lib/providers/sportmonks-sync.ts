import {
  ingestSportmonksFixtureAnalytics,
  type SportmonksFactContext,
  type SportmonksFactStore,
  type SportmonksAnalyticsSource,
} from "./sportmonks-facts";
import type {
  ProviderFixture,
  ProviderFixtureCoverage,
  ProviderSpikeFixtureInput,
} from "./types";

export type SportmonksRoundTeam = {
  teamId: string;
  canonicalName: string;
  aliases: string[];
  providerTeamId: string | null;
};

export type SportmonksRoundGame = {
  roundGameId: string;
  fixtureId: string;
  gameNumber: number;
  kickoffAt: string;
  competitionId: string | null;
  competitionName: string;
  home: SportmonksRoundTeam;
  away: SportmonksRoundTeam;
  providerFixtureId: number | null;
};

export type SportmonksResolvedFixture = {
  game: SportmonksRoundGame;
  fixture: ProviderFixture;
  capturedAt: string;
  resolution: "provided_id" | "name_match";
};

export interface SportmonksSyncStore extends SportmonksFactStore {
  loadRoundGames(roundId: string): Promise<SportmonksRoundGame[]>;
  saveResolvedFixture(snapshot: SportmonksResolvedFixture): Promise<void>;
}

export interface SportmonksSyncClient extends SportmonksAnalyticsSource {
  resolveFixture(input: ProviderSpikeFixtureInput): Promise<{
    fixture: ProviderFixture | null;
    resolution: ProviderFixtureCoverage["fixtureResolution"];
  }>;
}

export type SportmonksFixtureSyncResult = {
  gameNumber: number;
  roundGameId: string;
  fixtureId: string;
  status: "saved" | "not_found" | "ambiguous" | "error";
  providerFixtureId: string | null;
  statistics: number;
  xg: number;
  pressure: number;
  factsWritten: number;
  error: string | null;
};

export type SportmonksRoundSyncResult = {
  roundId: string;
  startedAt: string;
  completedAt: string;
  fixtures: SportmonksFixtureSyncResult[];
  summary: {
    requested: number;
    saved: number;
    notFound: number;
    ambiguous: number;
    errors: number;
    statisticsRows: number;
    xgRows: number;
    pressureRows: number;
    factsWritten: number;
  };
};

function validateRoundGames(games: SportmonksRoundGame[]): void {
  if (games.length !== 16) {
    throw new Error(
      `Sportmonks round sync requires exactly 16 fixtures; got ${games.length}.`,
    );
  }

  const ordered = [...games].sort((a, b) => a.gameNumber - b.gameNumber);
  const fixtureIds = new Set<string>();

  for (let index = 0; index < ordered.length; index += 1) {
    const game = ordered[index];
    if (game.gameNumber !== index + 1) {
      throw new Error("Round sync requires Toto game numbers 1..16 exactly once.");
    }
    if (!game.fixtureId || fixtureIds.has(game.fixtureId)) {
      throw new Error("Round sync requires 16 distinct canonical fixture ids.");
    }
    fixtureIds.add(game.fixtureId);
  }
}

function ensureOrientation(
  game: SportmonksRoundGame,
  fixture: ProviderFixture,
): void {
  if (
    game.home.providerTeamId != null &&
    game.home.providerTeamId !== fixture.home.id
  ) {
    throw new Error(
      `Sportmonks home-team mapping mismatch for Toto game ${game.gameNumber}.`,
    );
  }

  if (
    game.away.providerTeamId != null &&
    game.away.providerTeamId !== fixture.away.id
  ) {
    throw new Error(
      `Sportmonks away-team mapping mismatch for Toto game ${game.gameNumber}.`,
    );
  }
}

function fixtureInput(game: SportmonksRoundGame): ProviderSpikeFixtureInput {
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
    sportmonksFixtureId: game.providerFixtureId ?? undefined,
  };
}

function factContext(
  game: SportmonksRoundGame,
  fixture: ProviderFixture,
  capturedAt: string,
): SportmonksFactContext {
  return {
    fixtureId: game.fixtureId,
    providerFixtureId: fixture.providerFixtureId,
    capturedAt,
    home: {
      canonicalTeamId: game.home.teamId,
      providerTeamId: fixture.home.id,
    },
    away: {
      canonicalTeamId: game.away.teamId,
      providerTeamId: fixture.away.id,
    },
  };
}

export async function syncSportmonksRoundAnalytics(
  store: SportmonksSyncStore,
  client: SportmonksSyncClient,
  roundId: string,
  clock: () => Date = () => new Date(),
): Promise<SportmonksRoundSyncResult> {
  const startedAt = clock().toISOString();
  const games = await store.loadRoundGames(roundId);
  validateRoundGames(games);

  const fixtures: SportmonksFixtureSyncResult[] = [];

  for (const game of [...games].sort((a, b) => a.gameNumber - b.gameNumber)) {
    try {
      const resolved = await client.resolveFixture(fixtureInput(game));

      if (!resolved.fixture) {
        fixtures.push({
          gameNumber: game.gameNumber,
          roundGameId: game.roundGameId,
          fixtureId: game.fixtureId,
          status:
            resolved.resolution === "ambiguous" ? "ambiguous" : "not_found",
          providerFixtureId: null,
          statistics: 0,
          xg: 0,
          pressure: 0,
          factsWritten: 0,
          error: null,
        });
        continue;
      }

      ensureOrientation(game, resolved.fixture);

      const capturedAt = clock().toISOString();
      await store.saveResolvedFixture({
        game,
        fixture: resolved.fixture,
        capturedAt,
        resolution:
          resolved.resolution === "provided_id" ? "provided_id" : "name_match",
      });

      const analytics = await ingestSportmonksFixtureAnalytics(
        client,
        store,
        factContext(game, resolved.fixture, capturedAt),
      );

      fixtures.push({
        gameNumber: game.gameNumber,
        roundGameId: game.roundGameId,
        fixtureId: game.fixtureId,
        status: "saved",
        providerFixtureId: resolved.fixture.providerFixtureId,
        statistics: analytics.statistics,
        xg: analytics.xg,
        pressure: analytics.pressure,
        factsWritten: analytics.factsWritten,
        error: null,
      });
    } catch (error) {
      fixtures.push({
        gameNumber: game.gameNumber,
        roundGameId: game.roundGameId,
        fixtureId: game.fixtureId,
        status: "error",
        providerFixtureId: null,
        statistics: 0,
        xg: 0,
        pressure: 0,
        factsWritten: 0,
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
      notFound: fixtures.filter((fixture) => fixture.status === "not_found").length,
      ambiguous: fixtures.filter((fixture) => fixture.status === "ambiguous").length,
      errors: fixtures.filter((fixture) => fixture.status === "error").length,
      statisticsRows: fixtures.reduce(
        (total, fixture) => total + fixture.statistics,
        0,
      ),
      xgRows: fixtures.reduce((total, fixture) => total + fixture.xg, 0),
      pressureRows: fixtures.reduce(
        (total, fixture) => total + fixture.pressure,
        0,
      ),
      factsWritten: fixtures.reduce(
        (total, fixture) => total + fixture.factsWritten,
        0,
      ),
    },
  };
}
