import assert from "node:assert/strict";
import test from "node:test";

import {
  auditSportmonksA2BCapture,
  auditSportmonksLeagueIdentity,
  buildSportmonksA2BCapture,
  buildSportmonksSeasonCoverageProfile,
  pilotAcceptanceFailures,
  SPORTMONKS_A2B_TARGET_LEAGUES,
} from "./sportmonks-pilot";

const hash = "a".repeat(64);

function stat(
  participant_id: number,
  type_id: number,
  developer_name: string,
  value: number,
) {
  return {
    participant_id,
    type_id,
    type: { developer_name },
    data: { value },
  };
}

function fixture(overrides: Record<string, unknown> = {}) {
  const participants = [
    { id: 100, name: "Home FC", meta: { location: "home" } },
    { id: 200, name: "Away FC", meta: { location: "away" } },
  ];
  const starters = (team: number, firstPlayer: number) => [
    { player_id: firstPlayer, team_id: team, type_id: 11, position_id: 24, formation_position: 1, formation_field: "1:1", player_name: "GK", jersey_number: 1 },
    { player_id: firstPlayer + 1, team_id: team, type_id: 11, position_id: 25, formation_position: 2, formation_field: "2:1", player_name: "DF1", jersey_number: 2 },
    { player_id: firstPlayer + 2, team_id: team, type_id: 11, position_id: 25, formation_position: 3, formation_field: "2:2", player_name: "DF2", jersey_number: 3 },
    { player_id: firstPlayer + 3, team_id: team, type_id: 11, position_id: 25, formation_position: 4, formation_field: "2:3", player_name: "DF3", jersey_number: 4 },
    { player_id: firstPlayer + 4, team_id: team, type_id: 11, position_id: 25, formation_position: 5, formation_field: "2:4", player_name: "DF4", jersey_number: 5 },
    { player_id: firstPlayer + 5, team_id: team, type_id: 11, position_id: 26, formation_position: 6, formation_field: "3:1", player_name: "MF1", jersey_number: 6 },
    { player_id: firstPlayer + 6, team_id: team, type_id: 11, position_id: 26, formation_position: 7, formation_field: "3:2", player_name: "MF2", jersey_number: 7 },
    { player_id: firstPlayer + 7, team_id: team, type_id: 11, position_id: 26, formation_position: 8, formation_field: "3:3", player_name: "MF3", jersey_number: 8 },
    { player_id: firstPlayer + 8, team_id: team, type_id: 11, position_id: 27, formation_position: 9, formation_field: "4:1", player_name: "FW1", jersey_number: 9 },
    { player_id: firstPlayer + 9, team_id: team, type_id: 11, position_id: 27, formation_position: 10, formation_field: "4:2", player_name: "FW2", jersey_number: 10 },
    { player_id: firstPlayer + 10, team_id: team, type_id: 11, position_id: 27, formation_position: 11, formation_field: "4:3", player_name: "FW3", jersey_number: 11 },
    { player_id: firstPlayer + 11, team_id: team, type_id: 12, position_id: 25, formation_position: null, formation_field: null, player_name: "Bench", jersey_number: 12 },
  ];

  return {
    id: 9001,
    league_id: 8,
    season_id: 28083,
    starting_at_timestamp: 1790708400,
    state: { developer_name: "FT" },
    participants,
    scores: [
      { description: "2ND_HALF", score: { goals: 2, participant: "home" } },
      { description: "2ND_HALF", score: { goals: 1, participant: "away" } },
      { description: "CURRENT", score: { goals: 2, participant: "home" } },
      { description: "CURRENT", score: { goals: 1, participant: "away" } },
    ],
    lineups: [...starters(100, 1), ...starters(200, 101)],
    formations: [
      { participant_id: 100, formation: "4-3-3" },
      { participant_id: 200, formation: "4-4-2" },
    ],
    statistics: [
      stat(100, 45, "BALL_POSSESSION", 55),
      stat(200, 45, "BALL_POSSESSION", 45),
      stat(100, 42, "SHOTS_TOTAL", 14),
      stat(100, 86, "SHOTS_ON_TARGET", 6),
      stat(200, 42, "SHOTS_TOTAL", 8),
      stat(200, 86, "SHOTS_ON_TARGET", 3),
      stat(100, 34, "CORNERS", 0),
      stat(200, 34, "CORNERS", 4),
    ],
    xgfixture: [
      stat(100, 5304, "EXPECTED_GOALS", 1.8),
      stat(100, 7943, "EXPECTED_NON_PENALTY_GOALS", 1.6),
      stat(200, 5304, "EXPECTED_GOALS", 0.8),
      stat(200, 7943, "EXPECTED_NON_PENALTY_GOALS", 0.8),
    ],
    ...overrides,
  };
}

function capture(overrides: Record<string, unknown> = {}) {
  return buildSportmonksA2BCapture({
    fixture: fixture(overrides),
    capturedAt: "2026-11-02T06:00:00.000Z",
    rawPayloadSha256: hash,
    providerEndpoint: "/v3/football/fixtures/9001",
  });
}

test("validates target league identity including country and current season", () => {
  const target = SPORTMONKS_A2B_TARGET_LEAGUES[0];
  const audit = auditSportmonksLeagueIdentity(
    {
      id: 8,
      name: "Premier League",
      type: "league",
      sub_type: "domestic",
      country: { name: "England" },
      currentseason: {
        id: 28083,
        league_id: 8,
        name: "2026/2027",
        is_current: true,
      },
    },
    target,
  );

  assert.ok(Object.values(audit.gates).every((gate) => gate.status === "pass"));

  const wrongCountry = auditSportmonksLeagueIdentity(
    {
      id: 8,
      name: "Premier League",
      type: "league",
      sub_type: "domestic",
      country: { name: "Spain" },
      currentseason: {
        id: 28083,
        league_id: 8,
        name: "2026/2027",
        is_current: true,
      },
    },
    target,
  );
  assert.equal(wrongCountry.gates.country.status, "fail");
});

test("builds a capture with requested families and immutable response hash", () => {
  const built = capture();
  assert.equal(built.raw_payload_sha256, hash);
  assert.equal(built.fixture.league_id, 8);
  assert.equal(built.fixture.season_id, 28083);
  assert.deepEqual(
    Object.values(built.families).map((family) => family.fetch_status),
    ["fetched", "fetched", "fetched", "fetched"],
  );
  assert.ok(
    Object.values(built.families).every(
      (family) => family.raw_response_sha256 === hash,
    ),
  );
});

test("strong fixture audit passes coherent full-family evidence", () => {
  const audit = auditSportmonksA2BCapture(capture());
  assert.deepEqual(pilotAcceptanceFailures(audit), []);
  assert.equal(audit.gates.lineupStarterCounts.status, "pass");
  assert.equal(audit.gates.lineupParticipants.status, "pass");
  assert.equal(audit.gates.formationSemantics.status, "pass");
  assert.equal(audit.gates.broadPositions.status, "pass");
  assert.equal(audit.gates.explicitZero.status, "pass");
  assert.deepEqual(audit.observed.startersBySide, { home: 11, away: 11 });
});

test("explicit-zero observation is diagnostic and never an acceptance requirement", () => {
  const noZero = fixture();
  noZero.statistics = noZero.statistics.map((row) => {
    if (row.type_id === 34 && row.participant_id === 100) {
      return { ...row, data: { value: 2 } };
    }
    return row;
  });
  const audit = auditSportmonksA2BCapture(
    buildSportmonksA2BCapture({
      fixture: noZero,
      capturedAt: "2026-11-02T06:00:00.000Z",
      rawPayloadSha256: hash,
      providerEndpoint: "/v3/football/fixtures/9001",
    }),
  );
  assert.equal(audit.gates.explicitZero.status, "unverified");
  assert.deepEqual(pilotAcceptanceFailures(audit), []);
});

test("fails unknown lineup positions and participant drift", () => {
  const broken = fixture();
  const rows = broken.lineups as Array<Record<string, unknown>>;
  rows[0] = { ...rows[0], position_id: 999 };
  rows[1] = { ...rows[1], team_id: 9999 };
  const audit = auditSportmonksA2BCapture(
    buildSportmonksA2BCapture({
      fixture: broken,
      capturedAt: "2026-11-02T06:00:00.000Z",
      rawPayloadSha256: hash,
      providerEndpoint: "/v3/football/fixtures/9001",
    }),
  );
  assert.equal(audit.gates.broadPositions.status, "fail");
  assert.equal(audit.gates.lineupParticipants.status, "fail");
  assert.ok(pilotAcceptanceFailures(audit).includes("broadPositions"));
  assert.ok(pilotAcceptanceFailures(audit).includes("lineupParticipants"));
});

test("FT score semantics accept one valid cumulative score pair but reject disagreement", () => {
  const onePair = auditSportmonksA2BCapture(
    capture({
      scores: [
        { description: "2ND_HALF", score: { goals: 2, participant: "home" } },
        { description: "2ND_HALF", score: { goals: 1, participant: "away" } },
      ],
    }),
  );
  assert.equal(onePair.gates.scoreSemantics.status, "pass");

  const disagreement = auditSportmonksA2BCapture(
    capture({
      scores: [
        { description: "2ND_HALF", score: { goals: 2, participant: "home" } },
        { description: "2ND_HALF", score: { goals: 1, participant: "away" } },
        { description: "CURRENT", score: { goals: 3, participant: "home" } },
        { description: "CURRENT", score: { goals: 1, participant: "away" } },
      ],
    }),
  );
  assert.equal(disagreement.gates.scoreSemantics.status, "fail");
});

test("coverage is calculated per season rather than pooled globally", () => {
  const full = auditSportmonksA2BCapture(capture());
  const noXg = auditSportmonksA2BCapture(capture({ xgfixture: [] }));
  const profile = buildSportmonksSeasonCoverageProfile({
    providerLeagueId: "8",
    providerSeasonId: "28083",
    seasonName: "2026/2027",
    audits: [full, noXg],
    parseStatuses: ["pass", "pass"],
  });

  assert.equal(profile.sampledFixtures, 2);
  assert.equal(profile.families.lineups.coverageRatio, 1);
  assert.equal(profile.families.xg.coverageRatio, 0.5);
  assert.equal(profile.completeLineupFixtures, 2);
  assert.equal(profile.parseFailures, 0);
  assert.equal(profile.semanticFailures, 0);
});
