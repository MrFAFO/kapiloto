import assert from "node:assert/strict";
import test from "node:test";

import {
  israelLocalDateTimeToIso,
  normalizeTelesportCompetition,
  parseTelesportWinner16Html,
  parseTelesportWinner16StateHtml,
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


test("parses live and final Winner 16 state without settling unfinished games", () => {
  function stateRow(
    number: number,
    status: string,
    home: string,
    score: string,
    away: string,
    outcome = "",
  ): string {
    return `
      <tr>
        <td>${number}.</td>
        <td>${status}</td>
        <td><p>${home}</p></td>
        <td>${score}</td>
        <td><p>${away}</p></td>
        <td></td><td>${outcome}</td>
      </tr>
    `;
  }

  const rows = [
    stateRow(1, "37'", "בית 1", "1 - 0", "חוץ 1", "1"),
    stateRow(2, "מחצית", "בית 2", "0 - 0", "חוץ 2", "X"),
    stateRow(3, "הסתיים", "בית 3", "2 - 1", "חוץ 3", "1"),
    stateRow(4, "נדחה", "בית 4", "-", "חוץ 4"),
    ...Array.from({ length: 12 }, (_, index) =>
      stateRow(index + 5, "24/10 19:00", `בית ${index + 5}`, "-", `חוץ ${index + 5}`),
    ),
  ].join("");

  const html = `
    <h2>ווינר 16 - מספר מחזור : 264201</h2>
    <h3>ישראל - ליגת Winner</h3>
    <table>${rows}</table>
    <h2>ווינר מחצית - מספר מחזור : 999999</h2>
  `;

  const parsed = parseTelesportWinner16StateHtml(html);

  assert.equal(parsed.externalRoundNumber, "264201");
  assert.equal(parsed.games[0].status, "live");
  assert.equal(parsed.games[0].homeScore, 1);
  assert.equal(parsed.games[0].outcome, "1");
  assert.equal(parsed.games[1].status, "halftime");
  assert.equal(parsed.games[2].status, "finished");
  assert.equal(parsed.games[2].outcome, "1");
  assert.equal(parsed.games[3].status, "postponed");
  assert.equal(parsed.games[4].status, "upcoming");
});

test("treats unknown scored Telesport states as under review", () => {
  const rows = Array.from({ length: 16 }, (_, index) => {
    const number = index + 1;
    const status = number === 1 ? "החלטה" : "24/10 19:00";
    const score = number === 1 ? "3 : 0" : "-";
    const outcome = number === 1 ? "1" : "";
    return `
      <tr>
        <td>${number}.</td><td>${status}</td><td>בית ${number}</td>
        <td>${score}</td><td>חוץ ${number}</td><td></td><td>${outcome}</td>
      </tr>
    `;
  }).join("");

  const parsed = parseTelesportWinner16StateHtml(
    `<h2>ווינר 16 - מספר מחזור : 264201</h2><h3>ליגה</h3><table>${rows}</table>`,
  );

  assert.equal(parsed.games[0].status, "under_review");
  assert.equal(parsed.games[0].homeScore, 3);
  assert.equal(parsed.games[0].awayScore, 0);
});
