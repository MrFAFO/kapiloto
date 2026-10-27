import assert from "node:assert/strict";
import test from "node:test";

import {
  israelLocalDateTimeToIso,
  normalizeTelesportCompetition,
  parseTelesportWinner16Html,
  parseTelesportWinner16StateHtml,
  TelesportWinner16Provider,
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


function modernDocument(lines: string[]): string {
  return `
    <html>
      <head>
        <style>.hidden { display: none; }</style>
        <script>window.fake = "מחזור: 999999";</script>
      </head>
      <body>
        ${lines.map((line) => `<div><span>${line}</span></div>`).join("")}
      </body>
    </html>
  `;
}

function modernRoundLines(): string[] {
  const lines = [
    "טוטו Winner 16",
    "מחזור נוכחי",
    "מחזור: 264301",
  ];

  const competitions = new Map<number, string>([
    [1, "ישראל - ליגת Winner"],
    [5, "ישראל - ליגה לאומית"],
    [7, "אנגליה - פרמייר ליג"],
    [11, "ספרד - לה ליגה"],
    [15, "איטליה - סרייה א'"],
  ]);

  for (let gameNumber = 1; gameNumber <= 16; gameNumber += 1) {
    const competition = competitions.get(gameNumber);
    if (competition) lines.push(competition);
    lines.push(
      String(gameNumber),
      gameNumber === 1 ? "02/11 20:30" : "31/10 17:00",
      `בית מודרני ${gameNumber}`,
      "-",
      `חוץ מודרני ${gameNumber}`,
      "?",
    );
  }

  return lines;
}

test("parses the modern Telesport Winner 16 text layout and ignores script decoys", () => {
  const parsed = parseTelesportWinner16Html(
    modernDocument(modernRoundLines()),
    new Date("2026-10-27T12:00:00Z"),
  );

  assert.equal(parsed.externalRoundNumber, "264301");
  assert.equal(parsed.games.length, 16);
  assert.equal(parsed.games[0].homeTeam, "בית מודרני 1");
  assert.equal(parsed.games[0].awayTeam, "חוץ מודרני 1");
  assert.equal(parsed.games[0].competition.canonicalName, "Ligat Ha'al");
  assert.equal(parsed.games[4].competition.sourceLabel, "ישראל - ליגה לאומית");
  assert.equal(parsed.games[6].competition.canonicalName, "Premier League");
  assert.equal(parsed.games[10].competition.canonicalName, "La Liga");
  assert.equal(parsed.games[14].competition.canonicalName, "Serie A");
  assert.equal(parsed.games[0].kickoffAt, "2026-11-02T18:30:00.000Z");
  assert.equal(parsed.completeKickoffs, true);
});

test("parses modern live, finished and upcoming Winner 16 state", () => {
  const lines = modernRoundLines();
  const firstGame = lines.indexOf("1");
  lines.splice(
    firstGame,
    6,
    "1",
    "37'",
    "בית מודרני 1",
    "1 - 0",
    "חוץ מודרני 1",
    "1",
  );

  const secondGame = lines.indexOf("2", firstGame + 1);
  lines.splice(
    secondGame,
    6,
    "2",
    "הסתיים",
    "בית מודרני 2",
    "1 - 2",
    "חוץ מודרני 2",
    "2",
  );

  const parsed = parseTelesportWinner16StateHtml(modernDocument(lines));

  assert.equal(parsed.externalRoundNumber, "264301");
  assert.equal(parsed.games[0].status, "live");
  assert.equal(parsed.games[0].homeScore, 1);
  assert.equal(parsed.games[0].awayScore, 0);
  assert.equal(parsed.games[0].outcome, "1");
  assert.equal(parsed.games[1].status, "finished");
  assert.equal(parsed.games[1].homeScore, 1);
  assert.equal(parsed.games[1].awayScore, 2);
  assert.equal(parsed.games[1].outcome, "2");
  assert.equal(parsed.games[2].status, "upcoming");
  assert.equal(parsed.games[2].homeScore, null);
});

test("default Telesport provider fetches the current winner-16 endpoint", async () => {
  let requestedUrl = "";
  const html = modernDocument(modernRoundLines());

  const provider = new TelesportWinner16Provider({
    now: () => new Date("2026-10-27T12:00:00Z"),
    fetch: async (input) => {
      requestedUrl = input;
      return new Response(html, { status: 200 });
    },
  });

  const discovery = await provider.discoverCurrent();

  assert.equal(requestedUrl, "https://www.telesport.co.il/winner-16");
  assert.equal(discovery.externalRoundNumber, "264301");
  assert.equal(discovery.games.length, 16);
});
