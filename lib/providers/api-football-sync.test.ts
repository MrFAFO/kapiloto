import assert from "node:assert/strict";
import test from "node:test";

import {
  syncApiFootballRoundMarket,
  type ApiFootballResolvedSnapshot,
  type ApiFootballRoundGame,
  type ApiFootballSyncClient,
  type ApiFootballSyncStore,
} from "./api-football-sync";
import type { BookmakerThreeWayQuote, ProviderFixture } from "./types";

function games(): ApiFootballRoundGame[] {
  return Array.from({ length: 16 }, (_, index) => ({
    roundGameId: `game-${index + 1}`,
    gameNumber: index + 1,
    kickoffAt: "2026-10-20T18:00:00Z",
    competitionId: "competition-1",
    competitionName: "League",
    home: {
      teamId: `home-${index + 1}`,
      canonicalName: `Home ${index + 1}`,
      aliases: [],
      providerTeamId: null,
    },
    away: {
      teamId: `away-${index + 1}`,
      canonicalName: `Away ${index + 1}`,
      aliases: [],
      providerTeamId: null,
    },
    providerFixtureId: null,
  }));
}

function providerFixture(gameNumber: number): ProviderFixture {
  return {
    provider: "api-football",
    providerFixtureId: String(10_000 + gameNumber),
    kickoffAt: "2026-10-20T18:00:00Z",
    status: "NS",
    season: 2026,
    competition: {
      id: "100",
      name: "League",
      country: "Test",
      round: "1",
    },
    home: { id: String(20_000 + gameNumber), name: `Home ${gameNumber}` },
    away: { id: String(30_000 + gameNumber), name: `Away ${gameNumber}` },
  };
}

function quotes(fixture: ProviderFixture): BookmakerThreeWayQuote[] {
  return [
    {
      provider: "api-football",
      providerFixtureId: fixture.providerFixtureId,
      bookmakerId: "1",
      bookmakerName: "A",
      capturedAt: null,
      odds: { home: 2, draw: 3.2, away: 3.8 },
    },
    {
      provider: "api-football",
      providerFixtureId: fixture.providerFixtureId,
      bookmakerId: "2",
      bookmakerName: "B",
      capturedAt: null,
      odds: { home: 2.1, draw: 3.1, away: 3.7 },
    },
  ];
}

class MemoryStore implements ApiFootballSyncStore {
  readonly saved: ApiFootballResolvedSnapshot[] = [];

  async loadRoundGames(): Promise<ApiFootballRoundGame[]> {
    return games();
  }

  async saveResolvedSnapshot(
    snapshot: ApiFootballResolvedSnapshot,
  ): Promise<void> {
    this.saved.push(snapshot);
  }
}

test("sync resolves and persists a complete 16-game market snapshot", async () => {
  const store = new MemoryStore();
  const client: ApiFootballSyncClient = {
    async resolveFixture(input) {
      return {
        fixture: providerFixture(input.gameNumber),
        resolution: "name_match",
      };
    },
    async getThreeWayQuotes(fixture) {
      return quotes(fixture);
    },
  };

  let tick = 0;
  const result = await syncApiFootballRoundMarket(
    store,
    client,
    "round-1",
    () => new Date(Date.parse("2026-10-18T12:00:00Z") + tick++ * 1000),
  );

  assert.equal(result.summary.saved, 16);
  assert.equal(result.summary.errors, 0);
  assert.equal(store.saved.length, 16);
  assert.ok(
    store.saved.every(
      (snapshot) =>
        snapshot.marketPrior.probabilitiesBp.home +
          snapshot.marketPrior.probabilitiesBp.draw +
          snapshot.marketPrior.probabilitiesBp.away ===
        10_000,
    ),
  );
});

test("missing market on one fixture is explicit and does not fail other games", async () => {
  const store = new MemoryStore();
  const client: ApiFootballSyncClient = {
    async resolveFixture(input) {
      return {
        fixture: providerFixture(input.gameNumber),
        resolution: "name_match",
      };
    },
    async getThreeWayQuotes(fixture) {
      return fixture.providerFixtureId === "10005" ? [] : quotes(fixture);
    },
  };

  const result = await syncApiFootballRoundMarket(
    store,
    client,
    "round-1",
    () => new Date("2026-10-18T12:00:00Z"),
  );

  assert.equal(result.summary.saved, 15);
  assert.equal(result.summary.noMarket, 1);
  assert.equal(store.saved.length, 15);
  assert.equal(result.fixtures[4].status, "no_market");
});

test("known provider-team orientation mismatch is rejected", async () => {
  const store = new MemoryStore();
  const withMapping = games();
  withMapping[0].home.providerTeamId = "unexpected";

  store.loadRoundGames = async () => withMapping;

  const client: ApiFootballSyncClient = {
    async resolveFixture(input) {
      return {
        fixture: providerFixture(input.gameNumber),
        resolution: "name_match",
      };
    },
    async getThreeWayQuotes(fixture) {
      return quotes(fixture);
    },
  };

  const result = await syncApiFootballRoundMarket(
    store,
    client,
    "round-1",
    () => new Date("2026-10-18T12:00:00Z"),
  );

  assert.equal(result.fixtures[0].status, "error");
  assert.match(result.fixtures[0].error ?? "", /home-team mapping mismatch/);
  assert.equal(result.summary.saved, 15);
});

test("skips fixtures that are already inside the kickoff safety window", async () => {
  const store = new MemoryStore();
  const lateGames = games();
  lateGames[0].kickoffAt = "2026-10-18T12:10:00Z";
  store.loadRoundGames = async () => lateGames;

  let resolveCalls = 0;
  const client: ApiFootballSyncClient = {
    async resolveFixture(input) {
      resolveCalls += 1;
      return {
        fixture: providerFixture(input.gameNumber),
        resolution: "name_match",
      };
    },
    async getThreeWayQuotes(fixture) {
      return quotes(fixture);
    },
  };

  const result = await syncApiFootballRoundMarket(
    store,
    client,
    "round-1",
    () => new Date("2026-10-18T12:00:00Z"),
  );

  assert.equal(result.fixtures[0].status, "skipped_kickoff");
  assert.equal(result.summary.skippedKickoff, 1);
  assert.equal(resolveCalls, 15);
  assert.equal(store.saved.length, 15);
});
