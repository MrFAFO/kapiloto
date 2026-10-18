import assert from "node:assert/strict";
import test from "node:test";

import { assembleFixtureCardInputs } from "./fixture-input-store";

const games = Array.from({ length: 16 }, (_, index) => ({
  id: `game-${index + 1}`,
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
      round_game_id: game.id,
      captured_at: "2026-10-18T09:00:00Z",
      p_1_bp: 4000,
      p_x_bp: 3000,
      p_2_bp: 3000,
    },
    {
      id: `latest-${game.game_number}`,
      round_game_id: game.id,
      captured_at: "2026-10-18T11:59:00Z",
      p_1_bp: 4200,
      p_x_bp: 2800,
      p_2_bp: 3000,
    },
    {
      id: `future-${game.game_number}`,
      round_game_id: game.id,
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
        },
      ],
      marketSnapshots,
    },
    "2026-10-18T12:00:00Z",
  );

  assert.equal(inputs.length, 16);
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

test("fails closed when a fixture lacks a pre-cutoff market prior", () => {
  const marketSnapshots = games.slice(1).map((game) => ({
    id: `market-${game.game_number}`,
    round_game_id: game.id,
    captured_at: "2026-10-18T10:00:00Z",
    p_1_bp: 4000,
    p_x_bp: 3000,
    p_2_bp: 3000,
  }));

  assert.throws(
    () =>
      assembleFixtureCardInputs(
        {
          games,
          teams,
          teamAliases: [],
          teamMappings: [],
          marketSnapshots,
        },
        "2026-10-18T12:00:00Z",
      ),
    /Missing pre-cutoff market prior for Toto game 1/,
  );
});
