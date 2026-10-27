import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFootballIlMatchFacts,
  buildFootballIlStandingFacts,
  ingestFootballIlMatchAnalytics,
  ingestFootballIlSeasonAnalytics,
  type FootballIlFactContext,
  type FootballIlFactStore,
} from "./football-il-parse-facts";
import type { FootballIlTeamStatistics } from "./football-il-parse";

const context: FootballIlFactContext = {
  fixtureId: "fixture-1",
  providerGameId: "310781",
  capturedAt: "2026-10-27T08:00:00.000Z",
  home: {
    canonicalTeamId: "canonical-home",
    providerTeamId: "4539",
  },
  away: {
    canonicalTeamId: "canonical-away",
    providerTeamId: "4536",
  },
};

function row(
  teamId: number,
  values: Partial<FootballIlTeamStatistics>,
): FootballIlTeamStatistics {
  return {
    teamId,
    seasonName: "26/27",
    tournamentId: 902,
    stage: "RegularSeason",
    ...values,
  };
}

test("normalizes football.co.il match xG and core team metrics into provider raw facts", () => {
  const facts = buildFootballIlMatchFacts(context, [
    row(4539, {
      expectedGoals: 1.6217,
      Goal: 1,
      CopedGoal: 2,
      AttemptonGoal: 15,
      OnTarget: 5,
      ballPossession: 54.6,
      passes: 410,
      accuratePasses: 350,
      Corner: 5,
      chanceTotal: 8,
    }),
    row(4536, {
      expectedGoals: 1.2899,
      Goal: 2,
      CopedGoal: 1,
      AttemptonGoal: 11,
      OnTarget: 4,
      ballPossession: 45.4,
    }),
  ]);

  const homeXg = facts.find(
    (fact) =>
      fact.subject_team_id === "canonical-home" &&
      fact.fact_key === "xg.expected",
  );
  const awayXg = facts.find(
    (fact) =>
      fact.subject_team_id === "canonical-away" &&
      fact.fact_key === "xg.expected",
  );

  assert.equal(homeXg?.value_numeric, 1.6217);
  assert.equal(awayXg?.value_numeric, 1.2899);
  assert.equal(homeXg?.provider, "football-il-parse");
  assert.equal(homeXg?.source_version, "football-il-parse-v11");
  assert.equal(
    homeXg?.provider_endpoint,
    "get_match_statistics?game_id=310781",
  );
  assert.equal(homeXg?.metadata.raw_field, "expectedGoals");
  assert.ok(
    facts.some(
      (fact) =>
        fact.subject_team_id === "canonical-home" &&
        fact.fact_key === "possession" &&
        fact.value_numeric === 54.6,
    ),
  );
  assert.ok(
    facts.some(
      (fact) =>
        fact.subject_team_id === "canonical-home" &&
        fact.fact_key === "passes.accurate" &&
        fact.value_numeric === 350,
    ),
  );
});

test("unknown provider team ids stay fixture-scoped instead of being misattributed", () => {
  const facts = buildFootballIlMatchFacts(context, [
    row(999999, { expectedGoals: 0.75 }),
  ]);

  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.subject_type, "fixture");
  assert.equal(facts[0]?.subject_team_id, null);
  assert.equal(facts[0]?.subject_ref, "999999");
});

test("source fingerprints are deterministic and change with the raw metric value", () => {
  const a = buildFootballIlMatchFacts(context, [
    row(4539, { expectedGoals: 1.5 }),
  ]);
  const b = buildFootballIlMatchFacts(context, [
    row(4539, { expectedGoals: 1.5 }),
  ]);
  const c = buildFootballIlMatchFacts(context, [
    row(4539, { expectedGoals: 1.6 }),
  ]);

  assert.equal(a[0]?.source_fingerprint, b[0]?.source_fingerprint);
  assert.notEqual(a[0]?.source_fingerprint, c[0]?.source_fingerprint);
});

test("ingestion fetches match statistics and writes one immutable fact batch", async () => {
  const saved: unknown[] = [];
  const store: FootballIlFactStore = {
    async saveFacts(facts) {
      saved.push(...facts);
      return facts.length;
    },
  };

  const result = await ingestFootballIlMatchAnalytics(
    {
      async getMatchStatistics(gameId) {
        assert.equal(gameId, 310781);
        return {
          stats: [
            row(4539, { expectedGoals: 1.6217, Goal: 1 }),
            row(4536, { expectedGoals: 1.2899, Goal: 2 }),
          ],
        };
      },
    },
    store,
    context,
  );

  assert.equal(result.rawRows, 2);
  assert.equal(result.factsWritten, 4);
  assert.equal(saved.length, 4);
});

test("ingestion rejects non-numeric provider game ids before calling the provider", async () => {
  let called = false;
  const badContext = { ...context, providerGameId: "not-a-number" };

  await assert.rejects(
    () =>
      ingestFootballIlMatchAnalytics(
        {
          async getMatchStatistics() {
            called = true;
            return { stats: [] };
          },
        },
        { async saveFacts() { return 0; } },
        badContext,
      ),
    /positive integer/,
  );

  assert.equal(called, false);
});


test("normalizes season aggregates as fixture-scoped pre-match team facts", async () => {
  const saved: any[] = [];
  const result = await ingestFootballIlSeasonAnalytics(
    {
      async getTeamStatistics(season, teamId) {
        assert.equal(season, "26/27");
        return {
          stats: [
            row(teamId, {
              seasonName: season,
              expectedGoals: teamId === 4539 ? 18.4651 : 20.25,
              Goal: teamId === 4539 ? 20 : 24,
              ballPossession: teamId === 4539 ? 58.84 : 55.2,
            }),
          ],
        };
      },
    },
    {
      async saveFacts(facts) {
        saved.push(...facts);
        return facts.length;
      },
    },
    context,
    "26/27",
  );

  assert.equal(result.rawRows, 2);
  assert.ok(result.factsWritten > 0);

  const homeSeasonXg = saved.find(
    (fact) =>
      fact.subject_team_id === "canonical-home" &&
      fact.fact_key === "season.xg.expected",
  );

  assert.equal(homeSeasonXg?.value_numeric, 18.4651);
  assert.equal(homeSeasonXg?.metadata.scope, "season");
  assert.equal(homeSeasonXg?.metadata.season, "26/27");
  assert.match(homeSeasonXg?.provider_endpoint ?? "", /get_team_statistics/);
});

test("season ingestion rejects invalid provider team ids before any API call", async () => {
  let called = false;

  await assert.rejects(
    () =>
      ingestFootballIlSeasonAnalytics(
        {
          async getTeamStatistics() {
            called = true;
            return { stats: [] };
          },
        },
        { async saveFacts() { return 0; } },
        {
          ...context,
          home: { ...context.home, providerTeamId: "invalid" },
        },
        "26/27",
      ),
    /positive integers/,
  );

  assert.equal(called, false);
});


test("standing facts are emitted only from validator-approved stages", () => {
  const facts = buildFootballIlStandingFacts(
    context,
    "26/27",
    902,
    {
      RegularSeason: [
        {
          id: 4539,
          position: 2,
          points: 18,
          wins: 5,
          draws: 3,
          losses: 0,
          goalsScored: 20,
          goalsReceived: 14,
          gamesCount: 8,
        },
        {
          id: 4536,
          position: 1,
          points: 20,
          wins: 6,
          draws: 2,
          losses: 0,
          goalsScored: 24,
          goalsReceived: 8,
          gamesCount: 8,
        },
      ],
      ChampionshipRound: [
        {
          id: 4539,
          position: 1,
          points: 168,
          wins: 49,
          draws: 21,
          losses: 25,
          goalsScored: 153,
          goalsReceived: 107,
          gamesCount: 95,
        },
        {
          id: 4536,
          position: 2,
          points: 213,
          wins: 64,
          draws: 21,
          losses: 11,
          goalsScored: 185,
          goalsReceived: 80,
          gamesCount: 96,
        },
      ],
    },
  );

  const homePlayed = facts.find(
    (fact) =>
      fact.subject_team_id === "canonical-home" &&
      fact.fact_key === "season.games_played",
  );
  const awayPlayed = facts.find(
    (fact) =>
      fact.subject_team_id === "canonical-away" &&
      fact.fact_key === "season.games_played",
  );

  assert.equal(homePlayed?.value_numeric, 8);
  assert.equal(awayPlayed?.value_numeric, 8);
  assert.equal(homePlayed?.metadata.stage, "RegularSeason");
  assert.ok(
    facts.every(
      (fact) => fact.provider_endpoint.includes("get_league_standings"),
    ),
  );
});
