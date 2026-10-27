import assert from "node:assert/strict";
import test from "node:test";

import {
  footballIlSeasonForKickoff,
  footballIlTournamentId,
  syncFootballIlRoundAnalytics,
  type FootballIlRoundGame,
  type FootballIlSyncClient,
  type FootballIlSyncStore,
} from "./football-il-parse-sync";
import type {
  FootballIlFixture,
  FootballIlTeamStatistics,
} from "./football-il-parse";

function game(
  overrides: Partial<FootballIlRoundGame> = {},
): FootballIlRoundGame {
  return {
    roundGameId: "round-game-1",
    fixtureId: "fixture-1",
    gameNumber: 1,
    kickoffAt: "2026-11-02T18:30:00.000Z",
    competitionId: "competition-israel",
    competitionName: "Ligat Ha'al",
    home: {
      teamId: "canonical-home",
      canonicalName: "הפועל תל אביב",
      aliases: ["הפועל תל אביב"],
      providerTeamId: null,
      providerName: null,
    },
    away: {
      teamId: "canonical-away",
      canonicalName: "מכבי חיפה",
      aliases: ["מכבי חיפה"],
      providerTeamId: null,
      providerName: null,
    },
    providerFixtureId: null,
    ...overrides,
  };
}

function providerFixture(
  overrides: Partial<FootballIlFixture> = {},
): FootballIlFixture {
  return {
    id: 310779,
    status: null,
    homeTeamId: {
      id: 4530,
      name: "Hapoel Tel Aviv",
      hebrewName: 'הפועל ת"א',
      hebrewFullName: "הפועל תל אביב",
    },
    awayTeamId: {
      id: 4539,
      name: "Maccabi Haifa",
      hebrewName: "מכבי חיפה",
      hebrewFullName: "מכבי חיפה",
    },
    league: 902,
    round: 9,
    stage: "RegularSeason",
    homeScore: null,
    awayScore: null,
    date: { sec: Date.parse("2026-11-02T18:30:00.000Z") / 1000 },
    season: "26/27",
    ...overrides,
  };
}

function seasonRow(
  teamId: number,
): FootballIlTeamStatistics {
  return {
    teamId,
    seasonName: "26/27",
    tournamentId: 902,
    stage: "totalStage",
    expectedGoals: teamId === 4530 ? 17.1 : 18.4651,
    Goal: teamId === 4530 ? 18 : 20,
  };
}

function validStandings() {
  return {
    RegularSeason: [
      {
        id: 4530,
        position: 2,
        points: 19,
        wins: 6,
        draws: 1,
        losses: 1,
        goalsScored: 18,
        goalsReceived: 5,
        gamesCount: 8,
      },
      {
        id: 4539,
        position: 4,
        points: 18,
        wins: 5,
        draws: 3,
        losses: 0,
        goalsScored: 20,
        goalsReceived: 14,
        gamesCount: 8,
      },
    ],
  };
}

test("maps supported Israeli competitions and derives the football season from kickoff", () => {
  assert.equal(footballIlTournamentId("Ligat Ha'al"), 902);
  assert.equal(footballIlTournamentId("ישראל - ליגה לאומית"), 719);
  assert.equal(footballIlTournamentId("Premier League"), null);
  assert.equal(
    footballIlSeasonForKickoff("2026-11-02T18:30:00.000Z"),
    "26/27",
  );
  assert.equal(
    footballIlSeasonForKickoff("2027-03-01T18:30:00.000Z"),
    "26/27",
  );
});

test("resolves an Israeli fixture by exact team identity plus kickoff and stores season facts", async () => {
  const savedMappings: any[] = [];
  const savedFacts: any[] = [];
  let allTeamsCalls = 0;
  let teamFixturesCalls = 0;

  const store: FootballIlSyncStore = {
    async loadRoundGames() {
      return [
        game(),
        game({
          roundGameId: "round-game-2",
          fixtureId: "fixture-2",
          gameNumber: 2,
          competitionName: "Premier League",
        }),
      ];
    },
    async saveResolvedFixture(snapshot) {
      savedMappings.push(snapshot);
    },
    async saveFacts(facts) {
      savedFacts.push(...facts);
      return facts.length;
    },
  };

  const client: FootballIlSyncClient = {
    async getAllTeams(tournamentId) {
      allTeamsCalls += 1;
      assert.equal(tournamentId, 902);
      return {
        teams: [
          {
            id: 4530,
            name: "Hapoel Tel Aviv",
            hebrewName: 'הפועל ת"א',
            hebrewFullName: "הפועל תל אביב",
          },
          {
            id: 4539,
            name: "Maccabi Haifa",
            hebrewName: "מכבי חיפה",
            hebrewFullName: "מכבי חיפה",
          },
        ],
      };
    },
    async getTeamFixtures(teamId) {
      teamFixturesCalls += 1;
      assert.equal(teamId, 4530);
      return [providerFixture()];
    },
    async getMatchDetails() {
      throw new Error("should not use by-id lookup");
    },
    async getTeamStatistics(season, teamId) {
      assert.equal(season, "26/27");
      return { stats: [seasonRow(teamId)] };
    },
    async getLeagueStandings(season, tournamentId) {
      assert.equal(season, "26/27");
      assert.equal(tournamentId, 902);
      return validStandings();
    },
  };

  const result = await syncFootballIlRoundAnalytics(
    store,
    client,
    "round-1",
    () => new Date("2026-10-27T08:00:00.000Z"),
  );

  assert.equal(result.summary.requested, 2);
  assert.equal(result.summary.saved, 1);
  assert.equal(result.summary.unsupported, 1);
  assert.equal(result.fixtures[0]?.providerFixtureId, "310779");
  assert.equal(result.fixtures[0]?.season, "26/27");
  assert.equal(savedMappings.length, 1);
  assert.equal(savedMappings[0]?.home.providerTeamId, 4530);
  assert.equal(savedMappings[0]?.away.providerTeamId, 4539);
  assert.ok(
    savedFacts.some(
      (fact) =>
        fact.fact_key === "season.xg.expected" &&
        fact.subject_team_id === "canonical-away" &&
        fact.value_numeric === 18.4651,
    ),
  );
  assert.equal(allTeamsCalls, 1);
  assert.equal(teamFixturesCalls, 1);
});

test("an existing provider fixture mapping bypasses discovery calls", async () => {
  let discoveryCalls = 0;
  let byIdCalls = 0;

  const mappedGame = game({
    providerFixtureId: 310779,
    home: {
      ...game().home,
      providerTeamId: "4530",
      providerName: "Hapoel Tel Aviv",
    },
    away: {
      ...game().away,
      providerTeamId: "4539",
      providerName: "Maccabi Haifa",
    },
  });

  const store: FootballIlSyncStore = {
    async loadRoundGames() {
      return [mappedGame];
    },
    async saveResolvedFixture() {},
    async saveFacts(facts) {
      return facts.length;
    },
  };

  const client: FootballIlSyncClient = {
    async getAllTeams() {
      discoveryCalls += 1;
      return { teams: [] };
    },
    async getTeamFixtures() {
      discoveryCalls += 1;
      return [];
    },
    async getMatchDetails() {
      byIdCalls += 1;
      throw new Error("trusted fixture and team mappings must bypass lookup");
    },
    async getTeamStatistics(_season, teamId) {
      return { stats: [seasonRow(teamId)] };
    },
    async getLeagueStandings() {
      return validStandings();
    },
  };

  const result = await syncFootballIlRoundAnalytics(
    store,
    client,
    "round-1",
    () => new Date("2026-10-27T08:00:00.000Z"),
  );

  assert.equal(result.summary.saved, 1);
  assert.equal(result.fixtures[0]?.status, "saved");
  assert.equal(byIdCalls, 0);
  assert.equal(discoveryCalls, 0);
});

test("a team that has no exact canonical or alias match is not guessed", async () => {
  let statsCalls = 0;

  const store: FootballIlSyncStore = {
    async loadRoundGames() {
      return [
        game({
          home: {
            ...game().home,
            canonicalName: "קבוצה שלא קיימת",
            aliases: [],
          },
        }),
      ];
    },
    async saveResolvedFixture() {
      throw new Error("must not save unresolved fixture");
    },
    async saveFacts() {
      throw new Error("must not save unresolved facts");
    },
  };

  const client: FootballIlSyncClient = {
    async getAllTeams() {
      return {
        teams: [
          {
            id: 4530,
            name: "Hapoel Tel Aviv",
            hebrewFullName: "הפועל תל אביב",
          },
          {
            id: 4539,
            name: "Maccabi Haifa",
            hebrewFullName: "מכבי חיפה",
          },
        ],
      };
    },
    async getTeamFixtures() {
      throw new Error("must not fetch fixtures after team resolution fails");
    },
    async getMatchDetails() {
      throw new Error("must not use by-id lookup");
    },
    async getTeamStatistics() {
      statsCalls += 1;
      return { stats: [] };
    },
    async getLeagueStandings() {
      statsCalls += 1;
      return validStandings();
    },
  };

  const result = await syncFootballIlRoundAnalytics(
    store,
    client,
    "round-1",
  );

  assert.equal(result.fixtures[0]?.status, "not_found");
  assert.equal(statsCalls, 0);
});


test("fresh season facts skip all Parse calls for the fixture", async () => {
  let providerCalls = 0;
  const mappedGame = game({
    providerFixtureId: 310779,
    home: {
      ...game().home,
      providerTeamId: "4530",
      providerName: "Hapoel Tel Aviv",
    },
    away: {
      ...game().away,
      providerTeamId: "4539",
      providerName: "Maccabi Haifa",
    },
  });

  const store: FootballIlSyncStore = {
    async loadRoundGames() {
      return [mappedGame];
    },
    async hasFreshSeasonFacts(fixtureId, season, capturedAfter) {
      assert.equal(fixtureId, "fixture-1");
      assert.equal(season, "26/27");
      assert.equal(
        capturedAfter,
        "2026-10-26T12:00:00.000Z",
      );
      return true;
    },
    async saveResolvedFixture() {
      throw new Error("fresh fixture must not rewrite mappings");
    },
    async saveFacts() {
      throw new Error("fresh fixture must not rewrite facts");
    },
  };

  const client: FootballIlSyncClient = {
    async getAllTeams() {
      providerCalls += 1;
      return { teams: [] };
    },
    async getTeamFixtures() {
      providerCalls += 1;
      return [];
    },
    async getMatchDetails() {
      providerCalls += 1;
      return providerFixture();
    },
    async getTeamStatistics() {
      providerCalls += 1;
      return { stats: [] };
    },
    async getLeagueStandings() {
      providerCalls += 1;
      return validStandings();
    },
  };

  const result = await syncFootballIlRoundAnalytics(
    store,
    client,
    "round-1",
    () => new Date("2026-10-27T08:00:00.000Z"),
  );

  assert.equal(result.summary.fresh, 1);
  assert.equal(result.summary.saved, 0);
  assert.equal(result.fixtures[0]?.status, "fresh");
  assert.equal(providerCalls, 0);
});
