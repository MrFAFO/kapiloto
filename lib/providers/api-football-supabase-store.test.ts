import assert from "node:assert/strict";
import test from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";

import { SupabaseApiFootballSyncStore } from "./api-football-supabase-store";
import type { ApiFootballResolvedSnapshot, ApiFootballRoundGame } from "./api-football-sync";
import type { ProviderFixture } from "./types";

type Row = Record<string, unknown>;

/**
 * In-memory stand-in for the Supabase query builder: select/eq/in/order reads,
 * insert, update().eq(), and upsert with Postgres ON CONFLICT semantics
 * (`ignoreDuplicates` = DO NOTHING, otherwise DO UPDATE).
 */
function fakeClient(tables: Record<string, Row[]>): SupabaseClient {
  return {
    from(table: string) {
      const rows = (tables[table] ??= []);
      const filters: Array<(row: Row) => boolean> = [];
      let patch: Row | null = null;
      const builder = {
        select: () => builder,
        order: () => builder,
        eq(column: string, value: unknown) {
          filters.push((row) => row[column] === value);
          return builder;
        },
        in(column: string, values: unknown[]) {
          filters.push((row) => values.includes(row[column]));
          return builder;
        },
        insert(row: Row) {
          rows.push({ ...row });
          return Promise.resolve({ error: null });
        },
        update(values: Row) {
          patch = values;
          return builder;
        },
        upsert(row: Row, options: { onConflict: string; ignoreDuplicates?: boolean }) {
          const keys = options.onConflict.split(",");
          const existing = rows.find((candidate) => keys.every((key) => candidate[key] === row[key]));
          if (!existing) rows.push({ ...row });
          else if (!options.ignoreDuplicates) Object.assign(existing, row);
          return Promise.resolve({ error: null });
        },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          const matched = rows.filter((row) => filters.every((filter) => filter(row)));
          if (patch) for (const row of matched) Object.assign(row, patch);
          return Promise.resolve({ data: matched, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const JERUSALEM = "449dd8ed-10e5-4e55-a095-bb2202c6c9ce";
const TEL_AVIV = "6fc76117-e2fa-483b-9fb0-bc52ed86c430";
const LIGAT = "06b70ffa-847c-44d2-a346-3683ac9115c3";

function tables(): Record<string, Row[]> {
  return {
    round_games: [
      {
        id: "rg-2", round_id: "round-1", fixture_id: "fx-2", game_number: 2,
        kickoff_at: "2026-10-24T15:45:00Z", competition_id: LIGAT,
        competition_name_snapshot: "Ligat Ha'al", home_team_id: JERUSALEM, away_team_id: TEL_AVIV,
      },
    ],
    teams: [
      { id: JERUSALEM, canonical_name: "הפועל ירושלים" },
      { id: TEL_AVIV, canonical_name: "הפועל תל אביב" },
    ],
    team_aliases: [
      { team_id: JERUSALEM, alias: "הפועל ירושלים" },
      { team_id: JERUSALEM, alias: "Hapoel Katamon" },
    ],
    provider_team_mappings: [
      { provider: "sportmonks", team_id: JERUSALEM, provider_team_id: "3229", provider_name: "Hapoel Jerusalem", mapping_status: "confirmed" },
      { provider: "sportmonks", team_id: TEL_AVIV, provider_team_id: "6963", provider_name: "Hapoel Tel Aviv", mapping_status: "confirmed" },
      { provider: "sportmonks", team_id: TEL_AVIV, provider_team_id: "1", provider_name: "Wrong Club", mapping_status: "unverified" },
      { provider: "api-football", team_id: JERUSALEM, provider_team_id: "4486", provider_name: "Hapoel Katamon", mapping_status: "confirmed" },
      { provider: "api-football", team_id: TEL_AVIV, provider_team_id: "9999", provider_name: "Guess", mapping_status: "unverified" },
    ],
    provider_fixture_mappings: [],
    provider_competition_mappings: [
      { provider: "sportmonks", competition_id: LIGAT, provider_competition_id: "372", mapping_status: "confirmed" },
      { provider: "api-football", competition_id: LIGAT, provider_competition_id: "383", mapping_status: "confirmed" },
    ],
  };
}

test("round games carry trusted API-Football ids and other providers' English names, Hebrew names untouched", async () => {
  const [game] = await new SupabaseApiFootballSyncStore(fakeClient(tables())).loadRoundGames("round-1");

  assert.equal(game.home.canonicalName, "הפועל ירושלים");
  assert.equal(game.away.canonicalName, "הפועל תל אביב");
  assert.equal(game.home.providerTeamId, "4486");
  assert.equal(game.away.providerTeamId, null, "unverified mappings are never trusted");
  assert.equal(game.providerCompetitionId, "383");
  assert.deepEqual(game.home.aliases.sort(), ["Hapoel Jerusalem", "Hapoel Katamon", "הפועל ירושלים"].sort());
  assert.deepEqual(game.away.aliases, ["Hapoel Tel Aviv"]);
});

test("without any API-Football mapping the game still gets an English identity for bootstrap", async () => {
  const data = tables();
  data.provider_team_mappings = data.provider_team_mappings.filter((row) => row.provider !== "api-football");
  data.provider_competition_mappings = data.provider_competition_mappings.filter((row) => row.provider !== "api-football");
  const [game] = await new SupabaseApiFootballSyncStore(fakeClient(data)).loadRoundGames("round-1");

  assert.equal(game.home.providerTeamId, null);
  assert.equal(game.providerCompetitionId, null);
  assert.ok(game.home.aliases.includes("Hapoel Jerusalem"));
});

function resolvedSnapshot(
  game: ApiFootballRoundGame,
  resolution: ApiFootballResolvedSnapshot["resolution"],
  fixture: ProviderFixture,
): ApiFootballResolvedSnapshot {
  return {
    game,
    fixture,
    marketPrior: { probabilitiesBp: { home: 4000, draw: 3000, away: 3000 }, bookmakerCount: 9, method: "median-devig-v1", degraded: false },
    capturedAt: "2026-10-24T11:20:00Z",
    resolution,
  };
}

const KATAMON_FIXTURE: ProviderFixture = {
  provider: "api-football",
  providerFixtureId: "1555528",
  kickoffAt: "2026-10-24T15:45:00+00:00",
  status: "NS",
  season: 2026,
  competition: { id: "383", name: "Ligat Ha'al", country: "Israel", round: null },
  home: { id: "4486", name: "Hapoel Katamon" },
  away: { id: "4501", name: "Hapoel Tel Aviv" },
};

function unmappedTables(): Record<string, Row[]> {
  const data = tables();
  data.provider_team_mappings = data.provider_team_mappings.filter((row) => row.provider !== "api-football");
  data.provider_competition_mappings = data.provider_competition_mappings.filter((row) => row.provider !== "api-football");
  return data;
}

test("a name-bootstrapped sync stores only unverified mappings, and the next run does not trust them", async () => {
  const data = unmappedTables();
  const store = new SupabaseApiFootballSyncStore(fakeClient(data));
  const [game] = await store.loadRoundGames("round-1");

  await store.saveResolvedSnapshot(resolvedSnapshot(game, "name_match", KATAMON_FIXTURE));

  const apiFootball = (rows: Row[]) => rows.filter((row) => row.provider === "api-football");
  assert.deepEqual(
    [...apiFootball(data.provider_team_mappings), ...apiFootball(data.provider_fixture_mappings), ...apiFootball(data.provider_competition_mappings)]
      .map((row) => row.mapping_status),
    ["unverified", "unverified", "unverified", "unverified"],
  );
  assert.equal(data.fixture_market_snapshots.length, 1, "the market snapshot itself is still saved");

  const [next] = await store.loadRoundGames("round-1");
  assert.equal(next.home.providerTeamId, null);
  assert.equal(next.away.providerTeamId, null);
  assert.equal(next.providerFixtureId, null, "an unverified fixture mapping is not a provided id");
  assert.equal(next.providerCompetitionId, null);
});

test("a wrong name bootstrap can never overwrite or downgrade a trusted mapping", async () => {
  const data = tables();
  const store = new SupabaseApiFootballSyncStore(fakeClient(data));
  const [game] = await store.loadRoundGames("round-1");
  // A bogus name match that claims provider team 4486 belongs to the away club.
  const swappedClaim = { ...game, home: game.away, away: game.home };
  await store.saveResolvedSnapshot(resolvedSnapshot(swappedClaim, "name_match", KATAMON_FIXTURE));

  const row = data.provider_team_mappings.find((r) => r.provider === "api-football" && r.provider_team_id === "4486");
  assert.equal(row?.team_id, JERUSALEM);
  assert.equal(row?.mapping_status, "confirmed");
  const [next] = await store.loadRoundGames("round-1");
  assert.equal(next.home.providerTeamId, "4486");
});

test("an id-confirmed sync stores confirmed mappings at confidence 1 and promotes an unverified row", async () => {
  const data = tables();
  data.provider_team_mappings.push({ provider: "api-football", team_id: TEL_AVIV, provider_team_id: "4501", provider_name: "Hapoel Tel Aviv", mapping_status: "unverified", mapping_confidence: 0.9 });
  const store = new SupabaseApiFootballSyncStore(fakeClient(data));
  const [game] = await store.loadRoundGames("round-1");
  const mapped = { ...game, away: { ...game.away, providerTeamId: "4501" } };

  await store.saveResolvedSnapshot(resolvedSnapshot(mapped, "provider_team_ids", KATAMON_FIXTURE));

  const team = (id: string) => data.provider_team_mappings.find((r) => r.provider === "api-football" && r.provider_team_id === id);
  assert.equal(team("4486")?.mapping_status, "confirmed");
  assert.equal(team("4501")?.mapping_status, "confirmed");
  assert.equal(team("4501")?.mapping_confidence, 1);
  const fixtureRow = data.provider_fixture_mappings.find((r) => r.provider === "api-football");
  assert.equal(fixtureRow?.mapping_status, "confirmed");
});
