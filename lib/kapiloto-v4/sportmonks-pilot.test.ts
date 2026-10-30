import assert from "node:assert/strict";
import test from "node:test";

import {
  auditSportmonksA2BCapture,
  buildSportmonksA2BCapture,
  sportmonksLeagueNameMatches,
  summarizeSportmonksA2BGates,
} from "./sportmonks-pilot";

const hash = "a".repeat(64);

function fixture(overrides: Record<string, unknown> = {}) {
  const participants = [
    { id: 100, name: "Home FC", meta: { location: "home" } },
    { id: 200, name: "Away FC", meta: { location: "away" } },
  ];
  const stat = (participant_id: number, type_id: number, developer_name: string, value: number) => ({
    participant_id,
    type_id,
    type: { developer_name },
    data: { value },
  });
  return {
    id: 9001,
    league_id: 8,
    season_id: 2026,
    starting_at_timestamp: 1790708400,
    state: { developer_name: "FT" },
    participants,
    scores: [
      { description: "2ND_HALF", score: { goals: 2, participant: "home" } },
      { description: "2ND_HALF", score: { goals: 1, participant: "away" } },
      { description: "CURRENT", score: { goals: 2, participant: "home" } },
      { description: "CURRENT", score: { goals: 1, participant: "away" } },
    ],
    lineups: [
      { player_id: 1, team_id: 100, type_id: 11, position_id: 24, formation_position: 1, formation_field: "1:1", player_name: "GK", jersey_number: 1 },
      { player_id: 2, team_id: 100, type_id: 11, position_id: 25, formation_position: 2, formation_field: "2:1", player_name: "DF", jersey_number: 2 },
      { player_id: 3, team_id: 100, type_id: 11, position_id: 26, formation_position: 6, formation_field: "3:1", player_name: "MF", jersey_number: 6 },
      { player_id: 4, team_id: 100, type_id: 11, position_id: 27, formation_position: 9, formation_field: "4:1", player_name: "FW", jersey_number: 9 },
      { player_id: 5, team_id: 100, type_id: 12, position_id: 25, formation_position: null, formation_field: null, player_name: "Bench", jersey_number: 12 },
    ],
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

test("builds an A2-B capture with exact response hash on every requested family", () => {
  const capture = buildSportmonksA2BCapture({
    fixture: fixture(),
    capturedAt: "2026-10-30T20:00:00.000Z",
    rawPayloadSha256: hash,
    providerEndpoint: "/v3/football/fixtures/9001",
  });
  assert.equal(capture.raw_payload_sha256, hash);
  assert.equal(capture.capture_mode, "backfill");
  assert.deepEqual(
    Object.values(capture.families).map((family) => family.fetch_status),
    ["fetched", "fetched", "fetched", "fetched"],
  );
  assert.ok(Object.values(capture.families).every((family) => family.raw_response_sha256 === hash));
});

test("pilot audit passes semantic invariants and distinguishes explicit zero", () => {
  const capture = buildSportmonksA2BCapture({
    fixture: fixture(),
    capturedAt: "2026-10-30T20:00:00.000Z",
    rawPayloadSha256: hash,
    providerEndpoint: "/v3/football/fixtures/9001",
  });
  const audit = auditSportmonksA2BCapture(capture);
  assert.equal(audit.gates.participantLocations.status, "pass");
  assert.equal(audit.gates.scoreSemantics.status, "pass");
  assert.equal(audit.gates.lineupTypes.status, "pass");
  assert.equal(audit.gates.broadPositions.status, "pass");
  assert.equal(audit.gates.possessionSum.status, "pass");
  assert.equal(audit.gates.shotsOnTarget.status, "pass");
  assert.equal(audit.gates.nonPenaltyXg.status, "pass");
  assert.equal(audit.gates.explicitZero.status, "pass");
  assert.deepEqual(audit.observed.explicitZeroStatTypes, ["34"]);
});

test("pilot audit fails contradictory provider semantics instead of normalizing them away", () => {
  const broken = fixture({
    participants: [
      { id: 100, meta: { location: "home" } },
      { id: 200, meta: { location: "home" } },
    ],
    scores: [
      { description: "2ND_HALF", score: { goals: 2, participant: "home" } },
      { description: "2ND_HALF", score: { goals: 1, participant: "away" } },
      { description: "CURRENT", score: { goals: 3, participant: "home" } },
      { description: "CURRENT", score: { goals: 1, participant: "away" } },
    ],
    lineups: [
      { player_id: 1, team_id: 100, type_id: 99, position_id: 24 },
    ],
    statistics: [
      { participant_id: 100, type_id: 45, type: { developer_name: "BALL_POSSESSION" }, data: { value: 70 } },
      { participant_id: 200, type_id: 45, type: { developer_name: "BALL_POSSESSION" }, data: { value: 40 } },
      { participant_id: 100, type_id: 42, type: { developer_name: "SHOTS_TOTAL" }, data: { value: 2 } },
      { participant_id: 100, type_id: 86, type: { developer_name: "SHOTS_ON_TARGET" }, data: { value: 3 } },
    ],
    xgfixture: [
      { participant_id: 100, type_id: 5304, type: { developer_name: "EXPECTED_GOALS" }, data: { value: 0.5 } },
      { participant_id: 100, type_id: 7943, type: { developer_name: "EXPECTED_NON_PENALTY_GOALS" }, data: { value: 0.7 } },
    ],
  });
  const audit = auditSportmonksA2BCapture(buildSportmonksA2BCapture({
    fixture: broken,
    capturedAt: "2026-10-30T20:00:00.000Z",
    rawPayloadSha256: hash,
    providerEndpoint: "/v3/football/fixtures/9001",
  }));
  assert.equal(audit.gates.participantLocations.status, "fail");
  assert.equal(audit.gates.scoreSemantics.status, "fail");
  assert.equal(audit.gates.lineupTypes.status, "fail");
  assert.equal(audit.gates.possessionSum.status, "fail");
  assert.equal(audit.gates.shotsOnTarget.status, "fail");
  assert.equal(audit.gates.nonPenaltyXg.status, "fail");
});

test("aggregate gates pass when real evidence passes", () => {
  const good = auditSportmonksA2BCapture(buildSportmonksA2BCapture({
    fixture: fixture(),
    capturedAt: "2026-10-30T20:00:00.000Z",
    rawPayloadSha256: hash,
    providerEndpoint: "/v3/football/fixtures/9001",
  }));
  const summary = summarizeSportmonksA2BGates([good]);
  assert.ok(Object.values(summary).every((status) => status === "pass"));
});

test("league-name comparison is case and punctuation insensitive", () => {
  assert.equal(sportmonksLeagueNameMatches("Ligat Ha'Al", "Ligat ha'Al"), true);
  assert.equal(sportmonksLeagueNameMatches("Premier League", "La Liga"), false);
});