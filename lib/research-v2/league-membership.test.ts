import assert from "node:assert/strict";
import test from "node:test";

import {
  CANDIDATE_LEAGUE_MEMBERSHIP_CONFIG as CONFIG,
  deriveCompetitionMembership,
  segmentSeasons,
  type LeagueMembershipConfig,
  type SeasonedMatch,
} from "./league-membership";

const DAY = 86_400_000;
const START = Date.parse("2024-08-20T15:00:00.000Z");
let counter = 0;

function row(atMs: number, home: string, away: string, season: string | null = null): SeasonedMatch {
  counter += 1;
  return {
    provider: "sportmonks",
    providerFixtureId: `m${counter}`,
    competitionKey: "sportmonks:8",
    kickoffAt: new Date(atMs).toISOString(),
    homeTeamKey: `sportmonks:${home}`,
    awayTeamKey: `sportmonks:${away}`,
    homeGoals: 1,
    awayGoals: 0,
    providerSeasonId: season,
  };
}

/** Weekly rounds of a four-team league starting at `startMs`. */
function season(startMs: number, teams: string[], seasonId: string | null, rounds = 6): SeasonedMatch[] {
  const rows: SeasonedMatch[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const at = startMs + round * 7 * DAY;
    rows.push(row(at, teams[round % 4], teams[(round + 1) % 4], seasonId), row(at, teams[(round + 2) % 4], teams[(round + 3) % 4], seasonId));
  }
  return rows;
}

const FIRST = season(START, ["a", "b", "c", "d"], "100");
const SECOND_START = START + 140 * DAY;
const SECOND = season(SECOND_START, ["a", "b", "c", "e"], "200");
const LAST_KICKOFF = Date.parse(SECOND.at(-1)!.kickoffAt);

const membership = (overrides: Partial<Parameters<typeof deriveCompetitionMembership>[0]> = {}, config: LeagueMembershipConfig = CONFIG) =>
  deriveCompetitionMembership(
    {
      history: [...FIRST, ...SECOND],
      competitionKey: "sportmonks:8",
      homeTeamKey: "sportmonks:e",
      awayTeamKey: "sportmonks:a",
      targetKickoffAt: new Date(LAST_KICKOFF + 7 * DAY).toISOString(),
      coverageStartDate: "2024-08-01",
      ...overrides,
    },
    config,
  );

test("provider season ids decide when every row has one and seasons do not overlap", () => {
  const result = segmentSeasons([...FIRST, ...SECOND], CONFIG);
  assert.equal(result.source, "provider_season_id");
  assert.equal(result.fallbackReason, null);
  assert.deepEqual(result.seasons.map((s) => s.key), ["season:100", "season:200"]);
});

test("one missing season id, or overlapping ids, falls back to the inactivity gap with a reason", () => {
  const missing = segmentSeasons([...FIRST, ...SECOND.map((m, i) => (i === 0 ? { ...m, providerSeasonId: null } : m))], CONFIG);
  assert.equal(missing.source, "inactivity_gap");
  assert.equal(missing.fallbackReason, "season_id_missing:1");
  assert.equal(missing.seasons.length, 2);

  const overlapping = segmentSeasons([...FIRST, ...SECOND, row(START + 7 * DAY + 1, "x", "y", "200")], CONFIG);
  assert.equal(overlapping.source, "inactivity_gap");
  assert.equal(overlapping.fallbackReason, "season_id_overlap");
});

test("gap boundary: exactly 60 days starts a season, one millisecond less does not", () => {
  const before = season(START, ["a", "b", "c", "d"], null, 2);
  const lastMs = Date.parse(before.at(-1)!.kickoffAt);
  assert.equal(segmentSeasons([...before, row(lastMs + 60 * DAY, "a", "b")], CONFIG).seasons.length, 2);
  assert.equal(segmentSeasons([...before, row(lastMs + 60 * DAY - 1, "a", "b")], CONFIG).seasons.length, 1);
});

test("a 39.9-day mid-season interruption does not split a season", () => {
  const before = season(START, ["a", "b", "c", "d"], null, 3);
  const lastMs = Date.parse(before.at(-1)!.kickoffAt);
  const after = season(lastMs + 39.9 * DAY, ["a", "b", "c", "d"], null, 3);
  assert.equal(segmentSeasons([...before, ...after], CONFIG).seasons.length, 1);
});

test("present in the previous season is false, absent is true, never 'promoted'", () => {
  const result = membership();
  assert.equal(result.seasonSource, "provider_season_id");
  assert.equal(result.targetOpensNewSeason, false);
  assert.equal(result.previousSeason?.key, "season:100");
  assert.deepEqual(result.newToCompetitionThisSeason, { home: true, away: false });
  assert.deepEqual(result.unknownReason, { home: null, away: null });
  assert.ok(!("promoted" in result));
});

test("target-season boundary: 60 days after the last match opens a new season, one millisecond less does not", () => {
  const opens = membership({ targetKickoffAt: new Date(LAST_KICKOFF + 60 * DAY).toISOString() });
  assert.equal(opens.targetOpensNewSeason, true);
  assert.equal(opens.previousSeason?.key, "season:200");
  assert.deepEqual(opens.newToCompetitionThisSeason, { home: false, away: false }, "e played last season");
  const within = membership({ targetKickoffAt: new Date(LAST_KICKOFF + 60 * DAY - 1).toISOString() });
  assert.equal(within.targetOpensNewSeason, false);
  assert.equal(within.previousSeason?.key, "season:100");
});

test("coverage boundary: a previous season starting exactly 14 days after the window is covered, 1 ms less is unknown", () => {
  // Window starts are whole UTC days, so the previous season is moved against a fixed window.
  const windowStart = "2024-08-06";
  const shifted = (offsetMs: number) => {
    const base = Date.parse(`${windowStart}T00:00:00.000Z`) + 14 * DAY + offsetMs;
    const first = season(base, ["a", "b", "c", "d"], "100");
    const second = season(base + 140 * DAY, ["a", "b", "c", "e"], "200");
    return deriveCompetitionMembership(
      {
        history: [...first, ...second],
        competitionKey: "sportmonks:8",
        homeTeamKey: "sportmonks:e",
        awayTeamKey: "sportmonks:a",
        targetKickoffAt: new Date(Date.parse(second.at(-1)!.kickoffAt) + 7 * DAY).toISOString(),
        coverageStartDate: windowStart,
      },
      CONFIG,
    );
  };
  assert.deepEqual(shifted(0).newToCompetitionThisSeason, { home: true, away: false });
  const truncated = shifted(-1);
  assert.deepEqual(truncated.newToCompetitionThisSeason, { home: null, away: null });
  assert.deepEqual(truncated.unknownReason, { home: "previous_season_possibly_truncated", away: "previous_season_possibly_truncated" });
});

test("no previous season, or an unmapped team, is unknown with its reason", () => {
  const single = membership({ history: SECOND });
  assert.deepEqual(single.newToCompetitionThisSeason, { home: null, away: null });
  assert.equal(single.unknownReason.home, "no_previous_season");
  const unmapped = membership({ homeTeamKey: null });
  assert.equal(unmapped.newToCompetitionThisSeason.home, null);
  assert.equal(unmapped.unknownReason.home, "team_unmapped");
  assert.equal(unmapped.newToCompetitionThisSeason.away, false);
});

test("other competitions in the history are ignored, and an unknown config version is refused", () => {
  const foreign = FIRST.map((m) => ({ ...m, competitionKey: "sportmonks:9", providerFixtureId: `f-${m.providerFixtureId}` }));
  assert.equal(membership({ history: [...foreign, ...SECOND] }).unknownReason.home, "no_previous_season");
  assert.throws(() => membership({}, { ...CONFIG, version: "membership-v0" } as unknown as LeagueMembershipConfig), /membership_config_unsupported/);
});
