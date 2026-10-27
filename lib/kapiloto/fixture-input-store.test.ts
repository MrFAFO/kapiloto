import assert from "node:assert/strict";
import test from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";

import { assembleFixtureCardInputs, loadRoundFixtureCardInputs } from "./fixture-input-store";

const games = Array.from({ length: 16 }, (_, index) => ({
  id: `game-${index + 1}`,
  fixture_id: `fixture-${index + 1}`,
  round_id: "round-1",
  game_number: index + 1,
  home_team_id: `home-${index + 1}`,
  away_team_id: `away-${index + 1}`,
  competition_id: "league-1",
  competition_name_snapshot: "League",
  competition_stage_snapshot: "Regular Season",
  leg_number: null,
  aggregate_home_score: null,
  aggregate_away_score: null,
  neutral_venue: false,
  kickoff_at: "2026-10-20T18:00:00Z",
  settlement_rule: "result_after_90_minutes_including_stoppage_time",
}));

const teams = games.flatMap((game) => [
  { id: game.home_team_id, canonical_name: `Home ${game.game_number}` },
  { id: game.away_team_id, canonical_name: `Away ${game.game_number}` },
]);

test("assembles 16 fixture inputs and uses the latest pre-cutoff prior", () => {
  const marketSnapshots = games.flatMap((game) => [
    {
      id: `older-${game.game_number}`,
      fixture_id: game.fixture_id,
      captured_at: "2026-10-18T09:00:00Z",
      p_1_bp: 4000,
      p_x_bp: 3000,
      p_2_bp: 3000,
    },
    {
      id: `latest-${game.game_number}`,
      fixture_id: game.fixture_id,
      captured_at: "2026-10-18T11:59:00Z",
      p_1_bp: 4200,
      p_x_bp: 2800,
      p_2_bp: 3000,
    },
    {
      id: `future-${game.game_number}`,
      fixture_id: game.fixture_id,
      captured_at: "2026-10-18T12:01:00Z",
      p_1_bp: 9000,
      p_x_bp: 500,
      p_2_bp: 500,
    },
  ]);

  const inputs = assembleFixtureCardInputs(
    {
      games,
      teams,
      teamAliases: [
        {
          team_id: "home-1",
          alias: "בית אחת",
        },
      ],
      teamMappings: [
        {
          team_id: "home-1",
          provider_name: "Provider Home One",
          mapping_status: "confirmed",
        },
      ],
      marketSnapshots,
    },
    "2026-10-18T12:00:00Z",
  );

  assert.equal(inputs.length, 16);
  assert.equal(inputs[0].fixtureId, "fixture-1");
  assert.ok(inputs[0].prior);
  assert.equal(inputs[0].prior.snapshotId, "latest-1");
  assert.deepEqual(inputs[0].prior.probabilitiesBp, {
    home: 4200,
    draw: 2800,
    away: 3000,
  });
  assert.deepEqual(inputs[0].home.aliases, [
    "בית אחת",
    "Provider Home One",
  ]);
});

test("falls back to an explicit uninformative league-base prior when market data is unavailable", () => {
  const marketSnapshots = games.slice(1).map((game) => ({
    id: `market-${game.game_number}`,
    fixture_id: game.fixture_id,
    captured_at: "2026-10-18T10:00:00Z",
    p_1_bp: 4000,
    p_x_bp: 3000,
    p_2_bp: 3000,
  }));

  const inputs = assembleFixtureCardInputs(
    {
      games,
      teams,
      teamAliases: [],
      teamMappings: [],
      marketSnapshots,
    },
    "2026-10-18T12:00:00Z",
  );

  assert.deepEqual(inputs[0].prior, {
    type: "league_base",
    snapshotId: null,
    capturedAt: null,
    probabilitiesBp: {
      home: 3334,
      draw: 3333,
      away: 3333,
    },
  });
  assert.equal(inputs[1].prior?.type, "market");
  assert.equal(inputs[1].prior?.snapshotId, "market-2");
});

test("only trusted provider mappings contribute provider-name aliases; Hebrew canonical names are unchanged", () => {
  const hebrewTeams = teams.map((team) =>
    team.id === "home-1" ? { ...team, canonical_name: "הפועל ירושלים" } : team.id === "away-1" ? { ...team, canonical_name: "הפועל תל אביב" } : team,
  );
  const inputs = assembleFixtureCardInputs(
    {
      games,
      teams: hebrewTeams,
      teamAliases: [{ team_id: "home-1", alias: "הפועל ירושלים" }],
      teamMappings: [
        { team_id: "home-1", provider_name: "Hapoel Katamon", mapping_status: "confirmed" },
        { team_id: "home-1", provider_name: "Manual Name", mapping_status: "manual_override" },
        { team_id: "away-1", provider_name: "Bootstrap Guess", mapping_status: "unverified" },
        { team_id: "away-2", provider_name: "No Status", mapping_status: null },
      ],
      marketSnapshots: [],
    },
    "2026-10-18T12:00:00Z",
  );

  assert.equal(inputs[0].home.canonicalName, "הפועל ירושלים");
  assert.equal(inputs[0].away.canonicalName, "הפועל תל אביב");
  assert.deepEqual(inputs[0].home.aliases, ["הפועל ירושלים", "Hapoel Katamon", "Manual Name"]);
  assert.deepEqual(inputs[0].away.aliases, [], "an unverified provider name is never a research alias");
  assert.deepEqual(inputs[1].away.aliases, [], "a mapping without a status is not trusted");
});

type Row = Record<string, unknown>;

/** Read-only query fake: projects the selected columns and applies eq/in/lte filters. */
function fakeClient(tables: Record<string, Row[]>): SupabaseClient {
  return {
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = [];
      let columns: string[] | null = null;
      const builder = {
        select(list: string) {
          columns = list.split(",").map((column) => column.trim());
          return builder;
        },
        order: () => builder,
        eq(column: string, value: unknown) {
          filters.push((row) => row[column] === value);
          return builder;
        },
        in(column: string, values: unknown[]) {
          filters.push((row) => values.includes(row[column]));
          return builder;
        },
        lte(column: string, value: string) {
          filters.push((row) => String(row[column]) <= value);
          return builder;
        },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          const data = (tables[table] ?? [])
            .filter((row) => filters.every((filter) => filter(row)))
            .map((row) => (columns ? Object.fromEntries(columns.map((column) => [column, row[column]])) : row));
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

function storedRows(): Record<string, Row[]> {
  return {
    round_games: games,
    teams: teams.map((team) => (team.id === "home-1" ? { ...team, canonical_name: "הפועל ירושלים" } : team)),
    team_aliases: [],
    provider_team_mappings: [
      { provider: "api-football", team_id: "home-1", provider_name: "Hapoel Katamon", mapping_status: "confirmed" },
      { provider: "api-football", team_id: "away-1", provider_name: "Bootstrap Guess", mapping_status: "unverified" },
      { provider: "sportmonks", team_id: "home-1", provider_name: "Hapoel Jerusalem", mapping_status: "confirmed" },
      { provider: "sportmonks", team_id: "away-1", provider_name: "Hapoel Tel Aviv", mapping_status: "confirmed" },
    ],
    fixture_market_snapshots: [],
    fixture_structured_snapshots: [],
  };
}

test("research inputs loaded from storage exclude unverified API-Football provider names", async () => {
  const inputs = await loadRoundFixtureCardInputs(fakeClient(storedRows()), "round-1", "2026-10-18T12:00:00Z", "api-football");

  assert.equal(inputs[0].home.canonicalName, "הפועל ירושלים");
  assert.deepEqual(inputs[0].home.aliases, ["Hapoel Katamon"]);
  assert.deepEqual(inputs[0].away.aliases, []);
});

test("trusted Sportmonks provider names still become research aliases", async () => {
  const inputs = await loadRoundFixtureCardInputs(fakeClient(storedRows()), "round-1", "2026-10-18T12:00:00Z", "sportmonks");

  assert.deepEqual(inputs[0].home.aliases, ["Hapoel Jerusalem"]);
  assert.deepEqual(inputs[0].away.aliases, ["Hapoel Tel Aviv"]);
});


test("provider analytics are exposed only after both teams have five validated matches", () => {
  const snapshots = [4, 5].map((played, index) => {
    const game = games[index];
    return {
      fixture_id: game.fixture_id,
      provider: "football-il-parse" as const,
      source_version: "football-il-parse-v11",
      captured_at: "2026-10-18T11:50:00Z",
      season: "26/27",
      teams: [
        {
          team_id: game.home_team_id,
          xg_expected: played * 1.5,
          games_played: played,
          xg_per_match: 1.5,
          goals_scored: played * 2,
          shots_total: played * 10,
          shots_on_target: played * 4,
          possession: 55,
        },
        {
          team_id: game.away_team_id,
          xg_expected: played * 1.1,
          games_played: played,
          xg_per_match: 1.1,
          goals_scored: played,
          shots_total: played * 8,
          shots_on_target: played * 3,
          possession: 45,
        },
      ],
    };
  });

  const inputs = assembleFixtureCardInputs(
    {
      games,
      teams,
      teamAliases: [],
      teamMappings: [],
      marketSnapshots: [],
      providerAnalyticsSnapshots: snapshots,
    },
    "2026-10-18T12:00:00Z",
  );

  assert.equal(inputs[0].providerAnalytics, null);
  assert.ok(inputs[1].providerAnalytics);
  assert.equal(inputs[1].providerAnalytics?.home.xg_per_match, 1.5);
  assert.equal(inputs[1].providerAnalytics?.away.xg_per_match, 1.1);
});
