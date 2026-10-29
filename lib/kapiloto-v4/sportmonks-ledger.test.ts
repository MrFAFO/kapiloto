import assert from "node:assert/strict";
import test from "node:test";

import {
  SPORTMONKS_STAT_ALLOW_LIST,
  parseSportmonksLedgerFixture,
  sportmonksSeededDefinitionRows,
  type RawSportmonksLedgerFixture,
} from "./sportmonks-ledger";

function rawFixture(overrides: Partial<RawSportmonksLedgerFixture> = {}): RawSportmonksLedgerFixture {
  const lineups = ["101", "202"].flatMap((teamId, side) =>
    Array.from({ length: 13 }, (_, index) => ({
      player_id: Number(`${side + 1}${String(index + 1).padStart(2, "0")}`),
      team_id: Number(teamId),
      type_id: index < 11 ? 11 : 12,
      position_id: index === 0 ? 24 : index < 5 ? 25 : index < 9 ? 26 : 27,
      formation_position: index < 11 ? index + 1 : null,
      formation_field: index < 11 ? `${Math.floor(index / 4) + 1}:${(index % 4) + 1}` : null,
      player_name: `Synthetic ${teamId} ${index + 1}`,
      jersey_number: index + 1,
    })),
  );
  return {
    id: 9001,
    league_id: 8,
    season_id: 24000,
    starting_at: "2026-01-10T18:00:00Z",
    state: { developer_name: "FT" },
    participants: [
      { id: 101, meta: { location: "home" } },
      { id: 202, meta: { location: "away" } },
    ],
    scores: [
      { description: "2ND_HALF", score: { participant: "home", goals: 2 } },
      { description: "2ND_HALF", score: { participant: "away", goals: 1 } },
      { description: "CURRENT", score: { participant: "home", goals: 2 } },
      { description: "CURRENT", score: { participant: "away", goals: 1 } },
    ],
    lineups,
    formations: [
      { participant_id: 101, formation: "4-2-3-1" },
      { participant_id: 202, formation: "4-3-3" },
    ],
    statistics: [
      { participant_id: 101, type_id: 42, data: { value: 14 }, type: { developer_name: "SHOTS_TOTAL" } },
      { participant_id: 101, type_id: 86, data: { value: 5 }, type: { developer_name: "SHOTS_ON_TARGET" } },
      { participant_id: 101, type_id: 45, data: { value: 54 }, type: { developer_name: "BALL_POSSESSION" } },
      { participant_id: 101, type_id: 34, data: { value: 6 }, type: { developer_name: "CORNERS" } },
      { participant_id: 202, type_id: 42, data: { value: 9 }, type: { developer_name: "SHOTS_TOTAL" } },
      { participant_id: 202, type_id: 86, data: { value: 3 }, type: { developer_name: "SHOTS_ON_TARGET" } },
      { participant_id: 202, type_id: 45, data: { value: 46 }, type: { developer_name: "BALL_POSSESSION" } },
      { participant_id: 202, type_id: 34, data: { value: 4 }, type: { developer_name: "CORNERS" } },
    ],
    xgfixture: [
      { participant_id: 101, type_id: 5304, data: { value: 1.82 }, type: { developer_name: "EXPECTED_GOALS" } },
      { participant_id: 101, type_id: 5305, data: { value: 1.2 }, type: { developer_name: "EXPECTED_GOALS_ON_TARGET" } },
      { participant_id: 101, type_id: 7943, data: { value: 1.6 }, type: { developer_name: "EXPECTED_NON_PENALTY_GOALS" } },
      { participant_id: 202, type_id: 5304, data: { value: 1.11 }, type: { developer_name: "EXPECTED_GOALS" } },
      { participant_id: 202, type_id: 5305, data: { value: 0.9 }, type: { developer_name: "EXPECTED_GOALS_ON_TARGET" } },
      { participant_id: 202, type_id: 7943, data: { value: 0.8 }, type: { developer_name: "EXPECTED_NON_PENALTY_GOALS" } },
    ],
    ...overrides,
  };
}

const options = {
  retrievedAt: "2026-10-29T20:00:00Z",
  fixtureMint: { allowed: true, kickoff_before: "2026-10-01T00:00:00Z" },
};

test("synthetic Sportmonks parser keeps xG, xGoT and npxG separate", () => {
  const parsed = parseSportmonksLedgerFixture(rawFixture(), options)!;
  assert.equal(parsed.home_goals_90, 2);
  assert.equal(parsed.away_goals_90, 1);
  assert.equal(parsed.teams[0].lineup_status, "complete");
  assert.equal(parsed.teams[1].statistics_status, "complete");
  assert.deepEqual(
    parsed.team_stats.filter((s) => s.provider_team_id === "101" && ["5304", "5305", "7943"].includes(s.provider_stat_type)).map((s) => s.provider_stat_type).sort(),
    ["5304", "5305", "7943"],
  );
});

test("plain FT may fall back to CURRENT, but AET may not", () => {
  const ft = rawFixture({ scores: [
    { description: "CURRENT", score: { participant: "home", goals: 1 } },
    { description: "CURRENT", score: { participant: "away", goals: 0 } },
  ] });
  assert.equal(parseSportmonksLedgerFixture(ft, options)!.home_goals_90, 1);
  const aet = rawFixture({ state: { developer_name: "AET" }, scores: ft.scores });
  assert.throws(() => parseSportmonksLedgerFixture(aet, options), /safe 90-minute score/);
});

test("extra time is explicitly not separable and emits no team stats", () => {
  const parsed = parseSportmonksLedgerFixture(rawFixture({ state: { developer_name: "AET" } }), options)!;
  assert.deepEqual(parsed.team_stats, []);
  assert.equal(parsed.teams[0].statistics_status, "not_provided");
  assert.ok(parsed.quality_flags.includes("stats_not_separable_extra_time"));
});

test("missing xG is missing, never zero", () => {
  const parsed = parseSportmonksLedgerFixture(rawFixture({ xgfixture: [] }), options)!;
  assert.equal(parsed.team_stats.some((s) => ["5304", "5305", "7943"].includes(s.provider_stat_type)), false);
  assert.equal(parsed.teams[0].statistics_status, "partial");
});

test("developer-name drift is dropped and flagged", () => {
  const row = rawFixture();
  row.xgfixture = [{ participant_id: 101, type_id: 5304, data: { value: 9 }, type: { developer_name: "CHANGED_MEANING" } }];
  const parsed = parseSportmonksLedgerFixture(row, options)!;
  assert.equal(parsed.team_stats.some((s) => s.provider_stat_type === "5304"), false);
  assert.ok(parsed.quality_flags.some((flag) => flag.startsWith("type_drift:5304:")));
});

test("duplicate jerseys become null and non-finished fixtures are not emitted", () => {
  const row = rawFixture();
  const home = row.lineups!.filter((p) => String(p.team_id) === "101");
  home[1].jersey_number = home[0].jersey_number;
  const parsed = parseSportmonksLedgerFixture(row, options)!;
  const dupes = parsed.players.filter((p) => p.provider_team_id === "101" && ["101", "102"].includes(p.provider_player_id));
  assert.ok(dupes.every((p) => p.shirt_number === null));
  assert.equal(
    parseSportmonksLedgerFixture(rawFixture({ state: { developer_name: "NS" } }), options),
    null,
  );
});

test("raw payload hash is deterministic and seeded definition contract is exact", () => {
  const a = parseSportmonksLedgerFixture(rawFixture(), options)!;
  const b = parseSportmonksLedgerFixture(rawFixture(), options)!;
  assert.equal(a.raw_payload_sha256, b.raw_payload_sha256);
  assert.equal(a.raw_payload_sha256.length, 64);
  assert.deepEqual(sportmonksSeededDefinitionRows().map((r) => r.provider_stat_type).sort(), Object.keys(SPORTMONKS_STAT_ALLOW_LIST).sort());
});
