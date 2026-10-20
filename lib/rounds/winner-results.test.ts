import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWinnerResultsRequestBody,
  parseWinnerResultsResponse,
  WinnerOfficialResultsClient,
} from "./winner-results";

test("builds the Winner GetResults date-range payload", () => {
  assert.deepEqual(
    buildWinnerResultsRequestBody("2026-10-19", "2026-10-20"),
    {
      startDate: "2026-10-19T00:00:00+02:00",
      endDate: "2026-10-20T23:59:59+02:00",
      sports: [],
      leagues: [],
    },
  );
});

test("parses scored and no-score Winner result events", () => {
  const events = parseWinnerResultsResponse({
    results: {
      events: [
        {
          sportid: "240",
          date: "20/10/2026",
          time: "20:00",
          league: "ליגת העל",
          teamA: "מכבי חיפה",
          teamB: "הפועל באר שבע",
          scoreA: "2",
          scoreB: "1",
        },
        {
          sportid: 240,
          date: "20/10/2026",
          time: "21:00",
          league: "פרמייר ליג",
          teamA: "ארסנל",
          teamB: "צ'לסי",
          noScoreLabel: "בוטל",
          scoreA: "",
          scoreB: "",
        },
      ],
    },
  });

  assert.deepEqual(events[0], {
    sportId: 240,
    date: "20/10/2026",
    time: "20:00",
    league: "ליגת העל",
    homeTeam: "מכבי חיפה",
    awayTeam: "הפועל באר שבע",
    homeScore: 2,
    awayScore: 1,
    noScoreLabel: null,
  });
  assert.equal(events[1].homeScore, null);
  assert.equal(events[1].awayScore, null);
  assert.equal(events[1].noScoreLabel, "בוטל");
});

test("client POSTs to the official Winner results endpoint and validates schema", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new WinnerOfficialResultsClient({
    now: () => new Date("2026-10-20T12:00:00.000Z"),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          results: {
            events: [
              {
                sportid: 240,
                date: "20/10/2026",
                time: "20:00",
                league: "ליגת העל",
                teamA: "מכבי חיפה",
                teamB: "הפועל באר שבע",
                scoreA: 2,
                scoreB: 1,
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  const snapshot = await client.getResults("2026-10-19", "2026-10-20");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://www.winner.co.il/api/v2/publicapi/GetResults");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(
    new Headers(calls[0].init?.headers).get("origin"),
    "https://www.winner.co.il",
  );
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.fetchedAt, "2026-10-20T12:00:00.000Z");
});

test("invalid Winner result schema fails closed", () => {
  assert.throws(
    () => parseWinnerResultsResponse({ results: { events: [{}] } }),
    /missing sportid/,
  );
});
