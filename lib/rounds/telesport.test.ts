import assert from "node:assert/strict";
import test from "node:test";

import {
  israelLocalDateTimeToIso,
  normalizeTelesportCompetition,
  parseTelesportWinner16Html,
} from "./telesport";

function row(
  number: number,
  kickoff: string,
  home: string,
  away: string,
): string {
  return `
    <tr>
      <td>${number}.</td>
      <td>${kickoff}</td>
      <td><p>${home}</p></td>
      <td>-</td>
      <td><p>${away}</p></td>
      <td></td><td></td><td></td>
    </tr>
  `;
}

test("parses only the Winner 16 section and preserves game order", () => {
  const first = Array.from({ length: 8 }, (_, index) =>
    row(index + 1, "24/10 19:00", `בית ${index + 1}`, `חוץ ${index + 1}`),
  ).join("");

  const second = Array.from({ length: 8 }, (_, index) =>
    row(
      index + 9,
      index === 7 ? "ת. סיום" : "25/10 16:00",
      `בית ${index + 9}`,
      `חוץ ${index + 9}`,
    ),
  ).join("");

  const html = `
    <h2>ווינר 16 - מספר מחזור : 264201</h2>
    <h3>ישראל - ליגת Winner</h3>
    <table>${first}</table>
    <h3>אנגליה - פרמייר ליג</h3>
    <table>${second}</table>
    <h2>ווינר מחצית - מספר מחזור : 999999</h2>
    <h3>ישראל - ליגת Winner</h3>
    <table>${row(1, "26/10 20:00", "לא", "לקרוא")}</table>
  `;

  const parsed = parseTelesportWinner16Html(
    html,
    new Date("2026-10-20T08:00:00Z"),
  );

  assert.equal(parsed.externalRoundNumber, "264201");
  assert.equal(parsed.games.length, 16);
  assert.equal(parsed.games[0].homeTeam, "בית 1");
  assert.equal(parsed.games[15].awayTeam, "חוץ 16");
  assert.equal(parsed.games[15].kickoffAt, null);
  assert.equal(parsed.completeKickoffs, false);
  assert.equal(parsed.games[0].competition.canonicalName, "Ligat Ha'al");
  assert.equal(parsed.games[8].competition.canonicalName, "Premier League");
});

test("converts Israel local kickoff time across the DST boundary", () => {
  assert.equal(
    israelLocalDateTimeToIso({
      year: 2026,
      month: 10,
      day: 24,
      hour: 19,
      minute: 0,
    }),
    "2026-10-24T16:00:00.000Z",
  );

  assert.equal(
    israelLocalDateTimeToIso({
      year: 2026,
      month: 10,
      day: 25,
      hour: 16,
      minute: 0,
    }),
    "2026-10-25T14:00:00.000Z",
  );
});

test("normalizes known competition headings without inventing unknown leagues", () => {
  assert.deepEqual(normalizeTelesportCompetition("ספרד - לה ליגה"), {
    canonicalName: "La Liga",
    countryCode: "ES",
    competitionType: "league",
    sourceLabel: "ספרד - לה ליגה",
  });

  assert.deepEqual(normalizeTelesportCompetition("גביע כלשהו"), {
    canonicalName: "גביע כלשהו",
    countryCode: null,
    competitionType: "league",
    sourceLabel: "גביע כלשהו",
  });
});
