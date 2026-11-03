import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTeamName } from "@/lib/providers/match";
import {
  ROUND_264301,
  SCORES365_264301_FINALS as ROUND_264301_FINALS,
} from "./fixtures/round-264301";
import {
  israelDateKey,
  matchScores365FinalResult,
  parseScores365FinalResults,
  SCORES365_REVIEWED_TEAM_ALIASES,
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

function round264301Game(game: number) {
  const fixture = ROUND_264301.find((item) => item.game === game);
  assert.ok(fixture, `game ${game}`);
  return fixture;
}

test("matches every round 264301 game to its exact 365Scores event and side", () => {
  for (const fixture of ROUND_264301) {
    const matched = matchScores365FinalResult(fixture, ROUND_264301_FINALS);
    assert.deepEqual(
      matched && [matched.eventId, matched.homeScore, matched.awayScore],
      [fixture.eventId, ...fixture.score],
      `game ${fixture.game}`,
    );
  }
});

test("games 4, 5, 6 and 11 match only through a reviewed 365Scores spelling", () => {
  const cases: Array<[game: number, kapiloto: string, scores365: string]> = [
    [4, "הפועל פתח תקווה", "הפועל פתח תקוה"],
    [5, "בני יהודה", 'בני יהודה ת"א'],
    [6, "מכבי יפו", "מכבי קביליו יפו"],
    [11, "ראיו ואייקאנו", "ראיו ואיקנו"],
  ];
  for (const [game, kapiloto, scores365] of cases) {
    const fixture = round264301Game(game);
    const event = ROUND_264301_FINALS.find((result) => result.eventId === fixture.eventId);
    assert.ok(event && [event.homeTeam, event.awayTeam].includes(scores365), `game ${game} provider name`);
    assert.notEqual(normalizeTeamName(kapiloto), normalizeTeamName(scores365), `game ${game} differs`);
    assert.ok(
      SCORES365_REVIEWED_TEAM_ALIASES.some(
        (alias) => alias.kapilotoName === kapiloto && alias.scores365Name === scores365,
      ),
      `game ${game} reviewed alias`,
    );
  }
});

test("punctuation-only spellings already normalize equal and need no alias", () => {
  assert.equal(normalizeTeamName("מ.ס אשדוד"), normalizeTeamName("מ.ס. אשדוד"));
  assert.equal(normalizeTeamName("בורנמות'"), normalizeTeamName("בורנמות׳"));
  assert.equal(normalizeTeamName('בני יהודה ת"א'), normalizeTeamName("בני יהודה ת״א"));
  assert.equal(normalizeTeamName('בני יהודה ת"א'), normalizeTeamName("בני יהודה ת'א"));
  assert.ok(
    !SCORES365_REVIEWED_TEAM_ALIASES.some((alias) => /אשדוד|בורנמות/.test(alias.kapilotoName)),
  );
});

test("reviewed 365Scores aliases are one-to-one and never chain", () => {
  const keys = SCORES365_REVIEWED_TEAM_ALIASES.map((alias) => normalizeTeamName(alias.kapilotoName));
  const values = SCORES365_REVIEWED_TEAM_ALIASES.map((alias) => normalizeTeamName(alias.scores365Name));
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(new Set(values).size, values.length);
  for (const value of values) assert.ok(!keys.includes(value), value);
  for (const [index, key] of keys.entries()) assert.notEqual(key, values[index]);
});

test("a reviewed alias keeps the home/away side, date, kickoff tolerance and uniqueness rules", () => {
  const jaffa = round264301Game(6);

  // The aliased club listed on the other side.
  assert.equal(
    matchScores365FinalResult(
      { kickoffAt: jaffa.kickoffAt, homeNames: jaffa.awayNames, awayNames: jaffa.homeNames },
      ROUND_264301_FINALS,
    ),
    null,
  );
  // Another Israel date.
  assert.equal(
    matchScores365FinalResult({ ...jaffa, kickoffAt: "2026-11-01T17:00:00.000Z" }, ROUND_264301_FINALS),
    null,
  );
  // Same date, more than six hours from the 365Scores kickoff (19:00 local).
  assert.equal(
    matchScores365FinalResult({ ...jaffa, kickoffAt: "2026-11-02T09:59:00.000Z" }, ROUND_264301_FINALS),
    null,
  );
  // Two plausible 365Scores events.
  const event = ROUND_264301_FINALS.find((result) => result.eventId === jaffa.eventId)!;
  assert.equal(
    matchScores365FinalResult(jaffa, [...ROUND_264301_FINALS, { ...event, eventId: "duplicate" }]),
    null,
  );
});

test("look-alike clubs on the same days never match a reviewed alias", () => {
  const decoys: Array<{ kickoffAt: string; homeNames: string[]; awayNames: string[] }> = [
    // Hapoel Petah Tikva youth side, 2026-10-31 11:00.
    { kickoffAt: "2026-10-31T09:00:00.000Z", homeNames: ["הפועל פתח תקווה"], awayNames: ["הפועל רעננה"] },
    // Beitar Petah Tikva, 2026-10-30 12:00.
    { kickoffAt: "2026-10-30T10:00:00.000Z", homeNames: ['בית"ר כפר סבא'], awayNames: ["הפועל פתח תקווה"] },
    // Bnei Yehuda youth side, 2026-10-31 11:00.
    { kickoffAt: "2026-10-31T09:00:00.000Z", homeNames: ["הפועל חיפה"], awayNames: ["בני יהודה"] },
    // Bnei Yafo Ortodoksim, 2026-10-30 13:30.
    { kickoffAt: "2026-10-30T11:30:00.000Z", homeNames: ["הפועל יהוד"], awayNames: ["מכבי יפו"] },
    // Rayo Majadahonda, 2026-11-01 21:30.
    { kickoffAt: "2026-11-01T19:30:00.000Z", homeNames: ["הרקולס"], awayNames: ["ראיו ואייקאנו"] },
    // Maccabi (not Hapoel) Petah Tikva, 2026-11-01 20:00.
    { kickoffAt: "2026-11-01T18:00:00.000Z", homeNames: ["הפועל פתח תקווה"], awayNames: ["הפועל באר שבע"] },
  ];
  for (const decoy of decoys) {
    assert.equal(matchScores365FinalResult(decoy, ROUND_264301_FINALS), null, JSON.stringify(decoy));
  }
});
