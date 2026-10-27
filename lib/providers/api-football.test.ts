import assert from "node:assert/strict";
import test from "node:test";

import {
  parseApiFootballCompletedMatches,
  parseApiFootballStandings,
  parseApiFootballThreeWayQuotes,
} from "./api-football";
import type { ProviderFixture } from "./types";

const fixture: ProviderFixture = {
  provider: "api-football",
  providerFixtureId: "123",
  kickoffAt: "2026-10-18T18:00:00Z",
  status: "NS",
  season: 2026,
  competition: {
    id: "383",
    name: "Ligat Ha'al",
    country: "Israel",
    round: "Regular Season - 7",
  },
  home: { id: "1", name: "Maccabi Tel Aviv" },
  away: { id: "2", name: "Hapoel Be'er Sheva" },
};

test("parses only complete 1X2 Match Winner bookmaker quotes", () => {
  const quotes = parseApiFootballThreeWayQuotes(
    [
      {
        fixture: { id: 123 },
        update: "2026-10-18T10:00:00Z",
        bookmakers: [
          {
            id: 10,
            name: "Complete Book",
            bets: [
              {
                id: 1,
                name: "Match Winner",
                values: [
                  { value: "Home", odd: "2.10" },
                  { value: "Draw", odd: "3.20" },
                  { value: "Away", odd: "3.50" },
                ],
              },
            ],
          },
          {
            id: 11,
            name: "Incomplete Book",
            bets: [
              {
                id: 1,
                name: "Match Winner",
                values: [
                  { value: "Home", odd: "2.00" },
                  { value: "Away", odd: "3.80" },
                ],
              },
            ],
          },
        ],
      },
    ],
    fixture,
  );

  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].bookmakerName, "Complete Book");
  assert.deepEqual(quotes[0].odds, {
    home: 2.1,
    draw: 3.2,
    away: 3.5,
  });
});

test("accepts team names when provider labels outcomes by team", () => {
  const quotes = parseApiFootballThreeWayQuotes(
    [
      {
        bookmakers: [
          {
            id: 10,
            name: "Book",
            bets: [
              {
                id: 1,
                name: "Match Winner",
                values: [
                  { value: "Maccabi Tel Aviv", odd: "2.05" },
                  { value: "Draw", odd: "3.30" },
                  { value: "Hapoel Be'er Sheva", odd: "3.60" },
                ],
              },
            ],
          },
        ],
      },
    ],
    fixture,
  );

  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].odds.home, 2.05);
  assert.equal(quotes[0].odds.away, 3.6);
});


test("normalizes only completed 90-minute team fixtures", () => {
  const matches = parseApiFootballCompletedMatches([
    {
      fixture: {
        id: 500,
        date: "2026-10-10T18:00:00Z",
        status: { short: "FT" },
      },
      league: {
        id: 383,
        name: "Ligat Ha'al",
        country: "Israel",
        season: 2026,
      },
      teams: {
        home: { id: 1, name: "Home" },
        away: { id: 2, name: "Away" },
      },
      goals: { home: 2, away: 1 },
      score: { fulltime: { home: 2, away: 1 } },
    },
    {
      fixture: {
        id: 501,
        date: "2026-10-11T18:00:00Z",
        status: { short: "NS" },
      },
      league: {
        id: 383,
        name: "Ligat Ha'al",
        country: "Israel",
        season: 2026,
      },
      teams: {
        home: { id: 1, name: "Home" },
        away: { id: 3, name: "Future" },
      },
      goals: { home: 0, away: 0 },
    },
  ]);

  assert.equal(matches.length, 1);
  assert.equal(matches[0].providerFixtureId, "500");
  assert.equal(matches[0].homeScore, 2);
  assert.equal(matches[0].awayScore, 1);
});

test("normalizes API-Football standings", () => {
  const standings = parseApiFootballStandings([
    {
      league: {
        id: 383,
        season: 2026,
        standings: [
          [
            {
              rank: 2,
              team: { id: 1, name: "Home" },
              points: 18,
              goalsDiff: 7,
              all: { played: 9 },
            },
          ],
        ],
      },
    },
  ]);

  assert.deepEqual(standings, [
    {
      provider: "api-football",
      competitionId: "383",
      season: 2026,
      teamId: "1",
      position: 2,
      points: 18,
      played: 9,
      goalDifference: 7,
      pointsDeducted: null,
    },
  ]);
});
