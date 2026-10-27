import assert from "node:assert/strict";
import test from "node:test";

import {
  israelDateKey,
  matchScores365FinalResult,
  parseScores365FinalResults,
  Scores365ResultsProvider,
} from "./scores365";

test("Israel date conversion follows Jerusalem local date", () => {
  assert.equal(
    israelDateKey("2026-10-24T21:30:00.000Z"),
    "2026-10-25",
  );
});

test("parses only scored final football results", () => {
  const results = parseScores365FinalResults(
    {
      games: [
        {
          id: 11,
          statusGroup: 4,
          statusText: "Final",
          startTime: "2026-10-24T16:00:00Z",
          homeCompetitor: { name: "נאפולי", score: 2 },
          awayCompetitor: { name: "רומא", score: 1 },
        },
        {
          id: 12,
          statusGroup: 3,
          statusText: "Live",
          homeCompetitor: { name: "A", score: 1 },
          awayCompetitor: { name: "B", score: 0 },
        },
      ],
    },
    "2026-10-24",
  );

  assert.deepEqual(results, [
    {
      eventId: "11",
      date: "2026-10-24",
      startTime: "2026-10-24T16:00:00Z",
      homeTeam: "נאפולי",
      awayTeam: "רומא",
      homeScore: 2,
      awayScore: 1,
      outcome: "1",
    },
  ]);
});

test("matches only exact normalized home/away names or explicit aliases", () => {
  const results = [
    {
      eventId: "11",
      date: "2026-10-24",
      startTime: null,
      homeTeam: "FC Schalke 04",
      awayTeam: "Hamburger SV",
      homeScore: 1,
      awayScore: 2,
      outcome: "2" as const,
    },
  ];

  const matched = matchScores365FinalResult(
    {
      kickoffAt: "2026-10-24T13:30:00.000Z",
      homeNames: ["שאלקה 04", "Schalke 04"],
      awayNames: ["המבורג", "Hamburger SV"],
    },
    results,
  );
  assert.equal(matched?.eventId, "11");

  const reversed = matchScores365FinalResult(
    {
      kickoffAt: "2026-10-24T13:30:00.000Z",
      homeNames: ["Hamburger SV"],
      awayNames: ["Schalke 04"],
    },
    results,
  );
  assert.equal(reversed, null);
});

test("ambiguous exact matches fail closed", () => {
  const duplicate = {
    eventId: "11",
    date: "2026-10-24",
    startTime: null,
    homeTeam: "Napoli",
    awayTeam: "Roma",
    homeScore: 2,
    awayScore: 1,
    outcome: "1" as const,
  };

  assert.equal(
    matchScores365FinalResult(
      {
        kickoffAt: "2026-10-24T16:00:00.000Z",
        homeNames: ["Napoli"],
        awayNames: ["Roma"],
      },
      [duplicate, { ...duplicate, eventId: "12" }],
    ),
    null,
  );
});

test("provider uses the public endpoint contract and validates payload", async () => {
  let requested = "";
  const provider = new Scores365ResultsProvider({
    now: () => new Date("2026-10-20T12:00:00.000Z"),
    fetch: async (url) => {
      requested = url;
      return new Response(
        JSON.stringify({
          games: [
            {
              id: 1,
              statusGroup: 4,
              homeCompetitor: { name: "A", score: 0 },
              awayCompetitor: { name: "B", score: 0 },
            },
          ],
        }),
        { status: 200 },
      );
    },
  });

  const snapshot = await provider.getFinalResultsForDate("2026-10-19");
  assert.match(requested, /webws\.365scores\.com\/web\/games/);
  assert.match(requested, /startDate=19%2F10%2F2026/);
  assert.equal(snapshot.results.length, 1);
  assert.match(snapshot.sourceVersion, /^sha256:[a-f0-9]{64}$/);
});


test("exact names outside the kickoff tolerance do not cross-match", () => {
  const matched = matchScores365FinalResult(
    {
      kickoffAt: "2026-10-24T13:30:00.000Z",
      homeNames: ["Napoli"],
      awayNames: ["Roma"],
    },
    [
      {
        eventId: "late",
        date: "2026-10-24",
        startTime: "2026-10-24T23:00:00.000Z",
        homeTeam: "Napoli",
        awayTeam: "Roma",
        homeScore: 2,
        awayScore: 1,
        outcome: "1",
      },
    ],
  );

  assert.equal(matched, null);
});


test("uses the explicit 90-minute stage when a match continues to extra time or penalties", () => {
  const results = parseScores365FinalResults(
    {
      games: [
        {
          id: 21,
          statusGroup: 4,
          statusText: "After Penalties",
          gameTime: 125,
          startTime: "2026-06-30T01:00:00Z",
          homeCompetitor: { name: "Netherlands", score: 2 },
          awayCompetitor: { name: "Morocco", score: 3 },
          stages: [
            {
              id: 9,
              name: "End of 90 Minutes",
              homeCompetitorScore: 1,
              awayCompetitorScore: 1,
              isEnded: true,
            },
            {
              id: 10,
              name: "Extra Time",
              homeCompetitorScore: 1,
              awayCompetitorScore: 1,
              isEnded: true,
            },
            {
              id: 11,
              name: "Penalties",
              homeCompetitorScore: 2,
              awayCompetitorScore: 3,
              isEnded: true,
            },
          ],
        },
      ],
    },
    "2026-06-30",
  );

  assert.deepEqual(results, [
    {
      eventId: "21",
      date: "2026-06-30",
      startTime: "2026-06-30T01:00:00Z",
      homeTeam: "Netherlands",
      awayTeam: "Morocco",
      homeScore: 1,
      awayScore: 1,
      outcome: "X",
    },
  ]);
});

test("fails closed on a post-90 final when 365Scores does not provide the 90-minute stage", () => {
  const results = parseScores365FinalResults(
    {
      games: [
        {
          id: 22,
          statusGroup: 4,
          statusText: "Final (OT)",
          gameTime: 120,
          homeCompetitor: { name: "A", score: 2 },
          awayCompetitor: { name: "B", score: 1 },
        },
      ],
    },
    "2026-06-30",
  );

  assert.deepEqual(results, []);
});
