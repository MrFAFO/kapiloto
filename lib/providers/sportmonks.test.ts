import assert from "node:assert/strict";
import test from "node:test";

import { parseSportmonksThreeWayQuotes } from "./sportmonks";
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
