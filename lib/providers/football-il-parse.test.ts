import assert from "node:assert/strict";
import test from "node:test";

import {
  FootballIlParseClient,
  validateFootballIlStandings,
  type FootballIlStandings,
} from "./football-il-parse";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("FootballIlParseClient sends the pinned snapshot header and normalizes team statistics", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedHeaders: Headers | null = null;

  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedHeaders = new Headers(init?.headers);
    return jsonResponse({
      status: "success",
      data: {
        stats: [
          {
            teamId: 4539,
            seasonName: "25/26",
            tournamentId: 902,
            stage: "totalStage",
            expectedGoals: 66.6481,
            Goal: 66,
            CopedGoal: 47,
          },
        ],
      },
    });
  };

  try {
    const client = new FootballIlParseClient(
      "test-key",
      "https://example.test/scraper/provider",
    );
    const result = await client.getTeamStatistics("25/26", 4539);

    assert.equal(result.stats[0]?.expectedGoals, 66.6481);
    assert.equal(result.stats[0]?.Goal, 66);
    assert.match(capturedUrl, /get_team_statistics/);
    assert.match(capturedUrl, /season=25%2F26/);
    assert.match(capturedUrl, /team_id=4539/);
    assert.equal(capturedHeaders?.get("X-API-Key"), "test-key");
    assert.equal(capturedHeaders?.get("API-Snapshot-Version"), "11");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("FootballIlParseClient rejects provider-level error envelopes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    jsonResponse({ status: "error", message: "bad request" });

  try {
    const client = new FootballIlParseClient(
      "test-key",
      "https://example.test/scraper/provider",
    );

    await assert.rejects(
      () => client.getTeamProfile(4536),
      /bad request/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects historical standings stages that are all zero or exceed a sane match count", () => {
  const standings: FootballIlStandings = {
    RegularSeason: [
      {
        id: 4536,
        position: 1,
        points: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        goalsScored: 0,
        goalsReceived: 0,
        gamesCount: 0,
      },
      {
        id: 4554,
        position: 2,
        points: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        goalsScored: 0,
        goalsReceived: 0,
        gamesCount: 0,
      },
    ],
    ChampionshipRound: [
      {
        id: 4554,
        position: 1,
        points: 219,
        wins: 66,
        draws: 21,
        losses: 10,
        goalsScored: 159,
        goalsReceived: 52,
        gamesCount: 97,
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
  };

  const validation = validateFootballIlStandings(standings, {
    requirePlayedMatches: true,
  });

  assert.equal(validation.trustworthy, false);
  assert.ok(
    validation.issues.some((issue) => issue.code === "all_zero_played"),
  );
  assert.ok(
    validation.issues.some((issue) => issue.code === "played_out_of_range"),
  );
});

test("accepts plausible current Ligat HaAl standings", () => {
  const standings: FootballIlStandings = {
    RegularSeason: [
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
    ],
  };

  const validation = validateFootballIlStandings(standings);

  assert.deepEqual(validation, {
    trustworthy: true,
    issues: [],
  });
});

test("player match stats request defaults to the safe 2000-record page size", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";

  globalThis.fetch = async (input) => {
    capturedUrl = String(input);
    return jsonResponse({
      status: "success",
      data: {
        season: "26/27",
        tournament_id: 902,
        team_id: 4536,
        total_records: 1,
        page: 1,
        limit: 2000,
        has_more: false,
        records: [
          {
            player_id: 168966,
            player_hebrew_name: "דור פרץ",
            team_id: 4536,
            game_id: 310787,
            matchday: 8,
            season: "26/27",
            tournament_id: 902,
            appeared: true,
            minutes_played: 76,
            goals: 1,
            assists: 0,
            expected_goals: 0.4472,
          },
        ],
      },
    });
  };

  try {
    const client = new FootballIlParseClient(
      "test-key",
      "https://example.test/scraper/provider",
    );
    const result = await client.getPlayerMatchStats("26/27", {
      teamId: 4536,
    });

    assert.equal(result.records[0]?.player_hebrew_name, "דור פרץ");
    assert.equal(result.records[0]?.expected_goals, 0.4472);
    assert.match(capturedUrl, /limit=2000/);
    assert.match(capturedUrl, /team_id=4536/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
