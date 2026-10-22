import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSportmonksCompletedMatches,
  parseSportmonksStandings,
  parseSportmonksThreeWayQuotes,
} from "./sportmonks";
import type { ProviderFixture } from "./types";

const fixture: ProviderFixture = {
  provider: "sportmonks",
  providerFixtureId: "18557891",
  kickoffAt: "2026-10-18 18:00:00",
  status: "NS",
  season: 2026,
  competition: {
    id: "383",
    name: "Ligat Ha'al",
    country: null,
    round: "7",
  },
  home: { id: "1", name: "Maccabi Tel Aviv" },
  away: { id: "2", name: "Hapoel Be'er Sheva" },
};

test("groups complete Sportmonks 1X2 rows by bookmaker", () => {
  const quotes = parseSportmonksThreeWayQuotes(
    [
      {
        fixture_id: 18557891,
        market_id: 1,
        bookmaker_id: 28,
        label: "1",
        value: "2.05",
        market_description: "Match Winner",
        latest_bookmaker_update: "2026-10-18 10:00:00",
        bookmaker: { id: 28, name: "Book A" },
      },
      {
        fixture_id: 18557891,
        market_id: 1,
        bookmaker_id: 28,
        label: "X",
        value: "3.20",
        market_description: "Match Winner",
        bookmaker: { id: 28, name: "Book A" },
      },
      {
        fixture_id: 18557891,
        market_id: 1,
        bookmaker_id: 28,
        label: "2",
        value: "3.60",
        market_description: "Match Winner",
        bookmaker: { id: 28, name: "Book A" },
      },
      {
        fixture_id: 18557891,
        market_id: 14,
        bookmaker_id: 28,
        label: "Yes",
        value: "1.70",
        market_description: "Both Teams To Score",
        bookmaker: { id: 28, name: "Book A" },
      },
    ],
    fixture,
  );

  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].bookmakerName, "Book A");
  assert.deepEqual(quotes[0].odds, {
    home: 2.05,
    draw: 3.2,
    away: 3.6,
  });
});

test("accepts Home/Draw/Away labels for Match Winner", () => {
  const quotes = parseSportmonksThreeWayQuotes(
    [
      {
        market_id: 1,
        bookmaker_id: 5,
        label: "Home",
        value: "1.95",
        market_description: "Match Winner",
      },
      {
        market_id: 1,
        bookmaker_id: 5,
        label: "Draw",
        value: "3.40",
        market_description: "Match Winner",
      },
      {
        market_id: 1,
        bookmaker_id: 5,
        label: "Away",
        value: "4.10",
        market_description: "Match Winner",
      },
    ],
    fixture,
  );

  assert.equal(quotes.length, 1);
  assert.deepEqual(quotes[0].odds, {
    home: 1.95,
    draw: 3.4,
    away: 4.1,
  });
});


test("normalizes finished Sportmonks fixtures using regular-time score", () => {
  const matches = parseSportmonksCompletedMatches([
    {
      id: 700,
      league_id: 372,
      season_id: 20260,
      starting_at: "2026-10-10 18:00:00",
      state: { developer_name: "FT" },
      participants: [
        { id: 1, name: "Home", meta: { location: "home" } },
        { id: 2, name: "Away", meta: { location: "away" } },
      ],
      league: { id: 372, name: "Ligat Ha'al" },
      scores: [
        {
          description: "2ND_HALF",
          score: { participant: "home", goals: 2 },
        },
        {
          description: "2ND_HALF",
          score: { participant: "away", goals: 1 },
        },
      ],
    },
    {
      id: 701,
      league_id: 372,
      season_id: 20260,
      starting_at: "2026-10-11 18:00:00",
      state: { developer_name: "NS" },
      participants: [
        { id: 1, name: "Home", meta: { location: "home" } },
        { id: 3, name: "Future", meta: { location: "away" } },
      ],
      league: { id: 372, name: "Ligat Ha'al" },
      scores: [],
    },
  ]);

  assert.equal(matches.length, 1);
  assert.equal(matches[0].providerFixtureId, "700");
  assert.equal(matches[0].homeScore, 2);
  assert.equal(matches[0].awayScore, 1);
});

test("normalizes Sportmonks standings details", () => {
  const standings = parseSportmonksStandings([
    {
      participant_id: 1,
      league_id: 372,
      season_id: 20260,
      position: 3,
      points: 18,
      details: [
        { value: 9, type: { name: "Overall Matches Played" } },
        { value: 7, type: { name: "Goal Difference" } },
      ],
    },
  ]);

  assert.deepEqual(standings, [
    {
      provider: "sportmonks",
      competitionId: "372",
      season: 20260,
      teamId: "1",
      position: 3,
      points: 18,
      played: 9,
      goalDifference: 7,
      pointsDeducted: null,
    },
  ]);
});
