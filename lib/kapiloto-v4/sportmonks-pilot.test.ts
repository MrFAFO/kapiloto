import assert from "node:assert/strict";
import test from "node:test";

import {
  auditSportmonksA2BCapture,
  buildSportmonksA2BCapture,
  buildSportmonksA2BCompetitionProfile,
  sportmonksLeagueNameMatches,
  summarizeSportmonksA2BGateEvidence,
  summarizeSportmonksA2BProviderSemantics,
} from "./sportmonks-pilot";

const hash = "a".repeat(64);

function lineup(teamId: number, firstPlayerId: number) {
  const positions = [24, 25, 25, 25, 25, 26, 26, 26, 27, 27, 27];
  return [
    ...positions.map((position_id, index) => ({
      player_id: firstPlayerId + index,
      team_id: teamId,
      type_id: 11,
      position_id,
      formation_position: index + 1,
      formation_field: `${Math.min(4, Math.floor(index / 3) + 1)}:${(index % 4) + 1}`,
      player_name: `Starter ${firstPlayerId + index}`,
      jersey_number: index + 1,
    })),
    {
      player_id: firstPlayerId + 50,
      team_id: teamId,
      type_id: 12,
      position_id: 26,
      formation_position: null,
      formation_field: null,
      player_name: `Bench ${firstPlayerId + 50}`,
      jersey_number: 20,
    },
  ];
}

function fixture(overrides: Record<string, unknown> = {}) {
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
    participants: [
      { id: 100, name: "Home FC", meta: { location: "home" } },
      { id: 200, name: "Away FC", meta: { location: "away" } },
    ],
    scores: [
      { description: "2ND_HALF", score: { goals: 2, participant: "home" } },
      { description: "2ND_HALF", score: { goals: 1, participant: "away" } },
      { description: "CURRENT", score: { goals: 2, participant: "home" } },
      { description: "CURRENT", score: { goals: 1, participant: "away" } },
    ],
    lineups: [...lineup(100, 1), ...lineup(200, 101)],
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

function capture(value: Record<string, unknown> = fixture()) {
  return buildSportmonksA2BCapture({
    fixture: value,
    capturedAt: "2026-10-30T20:00:00.000Z",
    rawPayloadSha256: hash,
    providerEndpoint: "/v3/football/fixtures/9001",
  });
}

test("builds an A2-B capture with exact response hash on every requested family", () => {
  const result = capture();
  assert.equal(result.raw_payload_sha256, hash);
  assert.equal(result.capture_mode, "backfill");
  assert.deepEqual(
    Object.values(result.families).map((family) => family.fetch_status),
    ["fetched", "fetched", "fetched", "fetched"],
  );
  assert.ok(Object.values(result.families).every((family) => family.raw_response_sha256 === hash));
});

test("pilot audit validates discriminating score, lineup and position semantics", () => {
  const audit = auditSportmonksA2BCapture(capture());
  assert.equal(audit.gates.participantLocations.status, "pass");
  assert.equal(audit.gates.scoreSemantics.status, "pass");
  assert.equal(audit.gates.lineupTypes.status, "pass");
  assert.equal(audit.gates.broadPositions.status, "pass");
  assert.equal(audit.gates.possessionSum.status, "pass");
  assert.equal(audit.gates.shotsOnTarget.status, "pass");
  assert.equal(audit.gates.nonPenaltyXg.status, "pass");
  assert.deepEqual(audit.observed.lineupStarterCounts, { home: 11, away: 11 });
  assert.deepEqual(audit.observed.lineupBenchCounts, { home: 1, away: 1 });
  assert.deepEqual(audit.observed.explicitZeroStatTypes, ["34"]);
});

test("explicit zero is coverage evidence, not an acceptance gate", () => {
  const audit = auditSportmonksA2BCapture(capture({
    ...fixture(),
    statistics: (fixture().statistics as unknown[]).filter((row) => {
      const value = row as { type_id?: number };
      return value.type_id !== 34;
    }),
  }));
  assert.deepEqual(audit.observed.explicitZeroStatTypes, []);
  assert.ok(!("explicitZero" in audit.gates));
});

test("pilot audit fails contradictory provider semantics instead of normalizing them away", () => {
  const broken = fixture({
    scores: [
      { description: "2ND_HALF", score: { goals: 2, participant: "home" } },
      { description: "2ND_HALF", score: { goals: 1, participant: "away" } },
      { description: "CURRENT", score: { goals: 3, participant: "home" } },
      { description: "CURRENT", score: { goals: 1, participant: "away" } },
    ],
    lineups: [
      ...lineup(100, 1),
      ...lineup(200, 101),
      { player_id: 999, team_id: 100, type_id: 99, position_id: 99 },
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
  const audit = auditSportmonksA2BCapture(capture(broken));
  assert.equal(audit.gates.scoreSemantics.status, "fail");
  assert.equal(audit.gates.lineupTypes.status, "fail");
  assert.equal(audit.gates.broadPositions.status, "fail");
  assert.equal(audit.gates.possessionSum.status, "fail");
  assert.equal(audit.gates.shotsOnTarget.status, "fail");
  assert.equal(audit.gates.nonPenaltyXg.status, "fail");
});

test("extra-time semantics require CURRENT to be no lower than the 90-minute pair", () => {
  const good = auditSportmonksA2BCapture(capture(fixture({
    state: { developer_name: "AET" },
    scores: [
      { description: "2ND_HALF", score: { goals: 1, participant: "home" } },
      { description: "2ND_HALF", score: { goals: 1, participant: "away" } },
      { description: "CURRENT", score: { goals: 2, participant: "home" } },
      { description: "CURRENT", score: { goals: 1, participant: "away" } },
    ],
  })));
  assert.equal(good.gates.scoreSemantics.status, "pass");

  const impossible = auditSportmonksA2BCapture(capture(fixture({
    state: { developer_name: "AET" },
    scores: [
      { description: "2ND_HALF", score: { goals: 2, participant: "home" } },
      { description: "2ND_HALF", score: { goals: 1, participant: "away" } },
      { description: "CURRENT", score: { goals: 1, participant: "home" } },
      { description: "CURRENT", score: { goals: 1, participant: "away" } },
    ],
  })));
  assert.equal(impossible.gates.scoreSemantics.status, "fail");
});

test("strict gate evidence never upgrades pass+unverified into a pooled pass", () => {
  const good = auditSportmonksA2BCapture(capture());
  const missingXg = auditSportmonksA2BCapture(capture(fixture({ xgfixture: [] })));
  const evidence = summarizeSportmonksA2BGateEvidence([good, missingXg]);
  assert.equal(evidence.nonPenaltyXg.status, "unverified");
  assert.equal(evidence.nonPenaltyXg.passFixtures, 1);
  assert.equal(evidence.nonPenaltyXg.unverifiedFixtures, 1);
});

test("provider semantics separate optional coverage from contradictions", () => {
  const good = auditSportmonksA2BCapture(capture());
  const missingXg = auditSportmonksA2BCapture(capture(fixture({ id: 9002, xgfixture: [] })));
  const summary = summarizeSportmonksA2BProviderSemantics([good, missingXg]);
  assert.equal(summary.status, "pass");
  assert.equal(summary.gateEvidence.nonPenaltyXg.status, "unverified");

  const broken = auditSportmonksA2BCapture(capture(fixture({
    id: 9003,
    scores: [{ description: "2ND_HALF", score: { goals: 1, participant: "home" } }],
  })));
  const failed = summarizeSportmonksA2BProviderSemantics([good, broken]);
  assert.equal(failed.status, "fail");
  assert.ok(failed.blockers.some((item) => item.includes("score")));
});

test("competition profiles keep family/stat coverage per league", () => {
  const good = auditSportmonksA2BCapture(capture());
  const missingXg = auditSportmonksA2BCapture(capture(fixture({ id: 9002, xgfixture: [] })));
  const profile = buildSportmonksA2BCompetitionProfile("8", [good, missingXg]);
  assert.equal(profile.fixtures, 2);
  assert.equal(profile.familyCoverage.xg.nonEmptyFixtures, 1);
  assert.equal(profile.statTypeCoverage["5304"].fixturesPresent, 1);
  assert.equal(profile.statTypeCoverage["34"].fixturesExplicitZero, 2);
  assert.deepEqual(profile.contradictions, []);
});

test("league-name comparison is case and punctuation insensitive", () => {
  assert.equal(sportmonksLeagueNameMatches("Ligat Ha'Al", "Ligat ha'Al"), true);
  assert.equal(sportmonksLeagueNameMatches("Premier League", "La Liga"), false);
});
