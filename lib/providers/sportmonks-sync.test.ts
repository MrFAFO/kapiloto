import assert from "node:assert/strict";
import test from "node:test";

import type {
  FixtureFactInsert,
  SportmonksFactStore,
} from "./sportmonks-facts";
import {
  syncSportmonksRoundAnalytics,
  type SportmonksResolvedFixture,
  type SportmonksRoundGame,
  type SportmonksSyncClient,
  type SportmonksSyncStore,
} from "./sportmonks-sync";
import type {
  ProviderFixture,
  ProviderSpikeFixtureInput,
} from "./types";

function games(): SportmonksRoundGame[] {
  return Array.from({ length: 16 }, (_, index) => ({
    roundGameId: `game-${index + 1}`,
    fixtureId: `fixture-${index + 1}`,
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
    provider: "sportmonks",
    providerFixtureId: String(50_000 + gameNumber),
    kickoffAt: "2026-10-20T18:00:00Z",
    status: "NS",
    season: 2026,
    competition: {
      id: "100",
      name: "League",
      country: "Test",
      round: "1",
    },
    home: { id: String(60_000 + gameNumber), name: `Home ${gameNumber}` },
    away: { id: String(70_000 + gameNumber), name: `Away ${gameNumber}` },
  };
}

class MemoryStore implements SportmonksSyncStore, SportmonksFactStore {
  readonly resolved: SportmonksResolvedFixture[] = [];
  readonly facts: FixtureFactInsert[] = [];

  async loadRoundGames(): Promise<SportmonksRoundGame[]> {
    return games();
  }

  async saveResolvedFixture(snapshot: SportmonksResolvedFixture): Promise<void> {
    this.resolved.push(snapshot);
  }

  async saveFacts(facts: FixtureFactInsert[]): Promise<number> {
    this.facts.push(...facts);
    return facts.length;
  }
}

function client(): SportmonksSyncClient {
  return {
    async resolveFixture(input: ProviderSpikeFixtureInput) {
      return {
        fixture: providerFixture(input.gameNumber),
        resolution: "name_match" as const,
      };
    },
    async getStatisticsRows(fixtureId: string) {
      const gameNumber = Number(fixtureId) - 50_000;
      return [
        {
          participant_id: 60_000 + gameNumber,
          type_id: 1,
          data: { value: 10 + gameNumber },
          type: { developer_name: "SHOTS_TOTAL" },
        },
      ];
    },
    async getXgRows(fixtureId: string) {
      const gameNumber = Number(fixtureId) - 50_000;
      return [
        {
          participant_id: 60_000 + gameNumber,
          type_id: 2,
          data: { value: 1.1 },
          type: { developer_name: "EXPECTED_GOALS" },
        },
      ];
    },
    async getPressureRows(fixtureId: string) {
      const gameNumber = Number(fixtureId) - 50_000;
      return [
        {
          participant_id: 70_000 + gameNumber,
          minute: 1,
          pressure: 40 + gameNumber,
        },
      ];
    },
  };
}

test("sync resolves canonical fixtures and persists Sportmonks analytics facts", async () => {
  const store = new MemoryStore();
  let tick = 0;

  const result = await syncSportmonksRoundAnalytics(
    store,
    client(),
    "round-1",
    () => new Date(Date.parse("2026-10-20T12:00:00Z") + tick++ * 1000),
  );

  assert.equal(result.summary.requested, 16);
  assert.equal(result.summary.saved, 16);
  assert.equal(result.summary.errors, 0);
  assert.equal(result.summary.statisticsRows, 16);
  assert.equal(result.summary.xgRows, 16);
  assert.equal(result.summary.pressureRows, 16);
  assert.equal(result.summary.factsWritten, 48);
  assert.equal(store.resolved.length, 16);
  assert.equal(store.facts.length, 48);

  assert.equal(store.resolved[0].game.fixtureId, "fixture-1");
  assert.equal(store.facts[0].fixture_id, "fixture-1");
  assert.equal(store.facts[0].subject_team_id, "home-1");
});

test("missing provider fixture is explicit and does not stop remaining games", async () => {
  const store = new MemoryStore();
  const source = client();

  const wrapped: SportmonksSyncClient = {
    ...source,
    async resolveFixture(input) {
      if (input.gameNumber === 4) {
        return { fixture: null, resolution: "not_found" as const };
      }
      return source.resolveFixture(input);
    },
  };

  const result = await syncSportmonksRoundAnalytics(
    store,
    wrapped,
    "round-1",
    () => new Date("2026-10-20T12:00:00Z"),
  );

  assert.equal(result.summary.saved, 15);
  assert.equal(result.summary.notFound, 1);
  assert.equal(result.fixtures[3].status, "not_found");
  assert.equal(store.resolved.length, 15);
});

test("unavailable xG degrades only that capability and keeps fixture saved", async () => {
  const store = new MemoryStore();
  const source = client();
  const wrapped: SportmonksSyncClient = {
    ...source,
    async getXgRows() {
      throw new Error("xG not covered");
    },
  };

  const result = await syncSportmonksRoundAnalytics(
    store,
    wrapped,
    "round-1",
    () => new Date("2026-10-20T12:00:00Z"),
  );

  assert.equal(result.summary.saved, 16);
  assert.equal(result.summary.errors, 0);
  assert.equal(result.summary.xgRows, 0);
  assert.equal(result.summary.statisticsRows, 16);
  assert.equal(result.summary.pressureRows, 16);
  assert.equal(result.fixtures[0].status, "saved");
  assert.deepEqual(result.fixtures[0].analyticsErrors, ["xg: xG not covered"]);
});

test("known provider orientation mismatch is rejected for that fixture", async () => {
  const store = new MemoryStore();
  const mapped = games();
  mapped[0].home.providerTeamId = "wrong-home";
  store.loadRoundGames = async () => mapped;

  const result = await syncSportmonksRoundAnalytics(
    store,
    client(),
    "round-1",
    () => new Date("2026-10-20T12:00:00Z"),
  );

  assert.equal(result.fixtures[0].status, "error");
  assert.match(result.fixtures[0].error ?? "", /home-team mapping mismatch/);
  assert.equal(result.summary.saved, 15);
  assert.equal(result.summary.errors, 1);
});
