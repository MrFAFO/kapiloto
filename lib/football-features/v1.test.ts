import assert from "node:assert/strict";
import test from "node:test";

import type {
  ProviderCompletedMatch,
  ProviderStanding,
} from "@/lib/providers/types";
import { buildTeamStructuredFeaturesV1 } from "./v1";

function match(
  id: number,
  daysBeforeTarget: number,
  home: string,
  away: string,
  homeScore: number,
  awayScore: number,
  competitionId = "league-1",
): ProviderCompletedMatch {
  const target = Date.parse("2026-10-30T18:00:00.000Z");
  return {
    provider: "sportmonks",
    providerFixtureId: String(id),
    kickoffAt: new Date(
      target - daysBeforeTarget * 86_400_000,
    ).toISOString(),
    competition: {
      id: competitionId,
      name: "League",
      country: "Israel",
    },
    season: 2026,
    home: { id: home, name: home },
    away: { id: away, name: away },
    homeScore,
    awayScore,
  };
}

const standing: ProviderStanding = {
  provider: "sportmonks",
  competitionId: "league-1",
  season: 2026,
  teamId: "team-a",
  position: 3,
  points: 18,
  played: 9,
  goalDifference: 7,
  pointsDeducted: null,
};

test("builds deterministic last-six, venue, rest and table features", () => {
  const matches = [
    match(1, 4, "team-a", "x1", 2, 0),
    match(2, 7, "x2", "team-a", 1, 1),
    match(3, 10, "team-a", "x3", 3, 1),
    match(4, 13, "x4", "team-a", 2, 0),
    match(5, 17, "team-a", "x5", 1, 0),
    match(6, 21, "x6", "team-a", 0, 2),
    match(7, 25, "team-a", "x7", 1, 1),
    match(8, 29, "team-a", "x8", 4, 0),
    match(9, 2, "team-a", "cup", 5, 0, "cup-1"),
  ];

  const result = buildTeamStructuredFeaturesV1({
    teamId: "team-a",
    venue: "home",
    targetCompetitionId: "league-1",
    targetSeason: 2026,
    targetKickoffAt: "2026-10-30T18:00:00.000Z",
    researchCutoffAt: "2026-10-29T12:00:00.000Z",
    matches,
    standing,
  });

  assert.deepEqual(result.form, {
    played: 6,
    points: 13,
    gf: 9,
    ga: 4,
    venue_played: 5,
    venue_points: 13,
    venue_gf: 11,
    venue_ga: 2,
    last_match_at: match(1, 4, "team-a", "x1", 2, 0).kickoffAt,
  });
  assert.equal(result.coverage.form, "partial");
  assert.deepEqual(result.rest, {
    rest_days: 2,
    matches_last_14d: 5,
  });
  assert.equal(result.coverage.rest, "available");
  assert.deepEqual(result.table, {
    position: 3,
    points: 18,
    played: 9,
    goal_difference: 7,
    points_deducted: null,
  });
});

test("never treats missing history or standings as zero", () => {
  const result = buildTeamStructuredFeaturesV1({
    teamId: "team-a",
    venue: "home",
    targetCompetitionId: "league-1",
    targetSeason: 2026,
    targetKickoffAt: "2026-10-30T18:00:00.000Z",
    researchCutoffAt: "2026-10-29T12:00:00.000Z",
    matches: [],
    standing: null,
  });

  assert.equal(result.form, null);
  assert.equal(result.rest, null);
  assert.equal(result.table, null);
  assert.deepEqual(result.coverage, {
    form: "unavailable",
    rest: "unavailable",
    table: "unavailable",
  });
});

test("excludes matches at or after the frozen research cutoff", () => {
  const target = "2026-10-30T18:00:00.000Z";
  const cutoff = "2026-10-29T12:00:00.000Z";
  const afterCutoff: ProviderCompletedMatch = {
    ...match(20, 1, "team-a", "x", 9, 0),
    kickoffAt: "2026-10-29T13:00:00.000Z",
  };
  const beforeCutoff: ProviderCompletedMatch = {
    ...match(21, 2, "team-a", "y", 1, 0),
    kickoffAt: "2026-10-29T11:59:00.000Z",
  };

  const result = buildTeamStructuredFeaturesV1({
    teamId: "team-a",
    venue: "home",
    targetCompetitionId: "league-1",
    targetSeason: 2026,
    targetKickoffAt: target,
    researchCutoffAt: cutoff,
    matches: [afterCutoff, beforeCutoff],
    standing: null,
  });

  assert.equal(result.form?.played, 1);
  assert.equal(result.form?.gf, 1);
  assert.equal(result.form?.last_match_at, beforeCutoff.kickoffAt);
});

test("ignores standings for a different competition or team", () => {
  const result = buildTeamStructuredFeaturesV1({
    teamId: "team-a",
    venue: "away",
    targetCompetitionId: "league-1",
    targetSeason: 2026,
    targetKickoffAt: "2026-10-30T18:00:00.000Z",
    researchCutoffAt: "2026-10-29T12:00:00.000Z",
    matches: [match(1, 4, "x", "team-a", 0, 1)],
    standing: { ...standing, competitionId: "other-league" },
  });

  assert.equal(result.table, null);
  assert.equal(result.coverage.table, "unavailable");
});
