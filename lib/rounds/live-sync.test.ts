import assert from "node:assert/strict";
import test from "node:test";

import {
  ROUND_264301,
  SCORES365_264301_FINALS,
  TELESPORT_264301_MODERN_HTML,
} from "./fixtures/round-264301";
import { buildTelesportGameUpdate } from "./live-sync";
import { matchScores365FinalResult } from "./scores365";
import { parseTelesportWinner16StateHtml } from "./telesport";

const game = {
  id: "00000000-0000-4000-8000-000000000001",
  game_number: 1,
  home_team_id: "home",
  away_team_id: "away",
  kickoff_at: "2026-10-24T16:00:00.000Z",
  status: "live",
  field_home_score: 1,
  field_away_score: 0,
  settlement_status: "pending",
  pool_settlement_outcome: null,
  last_synced_at: null,
};

test("live Telesport outcome stays provisional", () => {
  const payload = buildTelesportGameUpdate(
    game,
    {
      gameNumber: 1,
      status: "live",
      homeScore: 2,
      awayScore: 0,
      outcome: "1",
      rawStatus: "67'",
      rawScore: "2 - 0",
    },
    "sha256:test",
    "2026-10-24T15:00:00.000Z",
  ) as Record<string, unknown>;

  assert.equal(payload.status, "live");
  assert.equal(payload.home_score, 2);
  assert.equal(payload.away_score, 0);
  assert.equal(payload.pool_settlement_status, undefined);
  assert.equal(payload.pool_outcome, undefined);
});

test("finished Telesport row stays under review until 365Scores corroborates", () => {
  const payload = buildTelesportGameUpdate(
    game,
    {
      gameNumber: 1,
      status: "finished",
      homeScore: 2,
      awayScore: 1,
      outcome: "1",
      rawStatus: "הסתיים",
      rawScore: "2 - 1",
    },
    "sha256:official",
    "2026-10-24T16:00:00.000Z",
  ) as Record<string, unknown>;

  assert.equal(payload.status, "finished");
  assert.equal(payload.pool_settlement_status, "under_review");
  assert.equal(payload.pool_outcome, undefined);
  assert.equal(
    payload.settlement_source,
    "telesport-winner16:sha256:official;365scores:unverified",
  );
});

test("exceptional source states go under review instead of settling", () => {
  const payload = buildTelesportGameUpdate(
    game,
    {
      gameNumber: 1,
      status: "postponed",
      homeScore: null,
      awayScore: null,
      outcome: null,
      rawStatus: "נדחה",
      rawScore: "-",
    },
    "sha256:official",
    "2026-10-24T16:00:00.000Z",
  ) as Record<string, unknown>;

  assert.equal(payload.status, "postponed");
  assert.equal(payload.pool_settlement_status, "under_review");
  assert.equal(payload.pool_outcome, undefined);
});

test("stale source state cannot regress an already live game to upcoming", () => {
  const payload = buildTelesportGameUpdate(
    game,
    {
      gameNumber: 1,
      status: "upcoming",
      homeScore: null,
      awayScore: null,
      outcome: null,
      rawStatus: "24/10 19:00",
      rawScore: "-",
    },
    "sha256:stale",
    "2026-10-24T15:00:00.000Z",
  ) as Record<string, unknown>;

  assert.equal(payload.status, "live");
});


test("matching 365Scores final corroborates Telesport settlement", () => {
  const payload = buildTelesportGameUpdate(
    game,
    {
      gameNumber: 1,
      status: "finished",
      homeScore: 2,
      awayScore: 1,
      outcome: "1",
      rawStatus: "הסתיים",
      rawScore: "2 - 1",
    },
    "sha256:telesport",
    "2026-10-24T16:00:00.000Z",
    {
      sourceVersion: "sha256:365",
      result: {
        eventId: "365-1",
        date: "2026-10-24",
        startTime: null,
        homeTeam: "Home",
        awayTeam: "Away",
        homeScore: 2,
        awayScore: 1,
        outcome: "1",
      },
    },
  ) as Record<string, unknown>;

  assert.equal(payload.pool_settlement_status, "settled");
  assert.equal(payload.pool_outcome, "1");
  assert.equal(
    payload.settlement_source,
    "telesport-winner16:sha256:telesport;365scores:event=365-1:sha256:365",
  );
});

test("365Scores disagreement forces under-review and never publishes a pool outcome", () => {
  const payload = buildTelesportGameUpdate(
    game,
    {
      gameNumber: 1,
      status: "finished",
      homeScore: 2,
      awayScore: 1,
      outcome: "1",
      rawStatus: "הסתיים",
      rawScore: "2 - 1",
    },
    "sha256:telesport",
    "2026-10-24T16:00:00.000Z",
    {
      sourceVersion: "sha256:365",
      result: {
        eventId: "365-1",
        date: "2026-10-24",
        startTime: null,
        homeTeam: "Home",
        awayTeam: "Away",
        homeScore: 1,
        awayScore: 1,
        outcome: "X",
      },
    },
  ) as Record<string, unknown>;

  assert.equal(payload.pool_settlement_status, "under_review");
  assert.equal(payload.pool_outcome, undefined);
  assert.match(
    String(payload.settlement_source),
    /telesport-winner16:.*365scores:/,
  );
});


test("365Scores event id is retained in settlement provenance", () => {
  const payload = buildTelesportGameUpdate(
    game,
    {
      gameNumber: 1,
      status: "finished",
      homeScore: 0,
      awayScore: 0,
      outcome: "X",
      rawStatus: "הסתיים",
      rawScore: "0 - 0",
    },
    "sha256:telesport",
    "2026-10-24T16:00:00.000Z",
    {
      sourceVersion: "sha256:365snapshot",
      result: {
        eventId: "4739302",
        date: "2026-10-24",
        startTime: "2026-10-24T16:00:00.000Z",
        homeTeam: "Home",
        awayTeam: "Away",
        homeScore: 0,
        awayScore: 0,
        outcome: "X",
      },
    },
  ) as Record<string, unknown>;

  assert.match(
    String(payload.settlement_source),
    /365scores:event=4739302:sha256:365snapshot$/,
  );
});

const corroboration = (homeScore: number, awayScore: number, outcome: "1" | "X" | "2") => ({
  sourceVersion: "sha256:365",
  result: {
    eventId: "365-1",
    date: "2026-10-24",
    startTime: null,
    homeTeam: "Home",
    awayTeam: "Away",
    homeScore,
    awayScore,
    outcome,
  },
});

test("a finished Telesport row without its own score never settles on outcome alone", () => {
  const payload = buildTelesportGameUpdate(
    game,
    {
      gameNumber: 1,
      status: "finished",
      homeScore: null,
      awayScore: null,
      outcome: "1",
      rawStatus: "הסתיים",
      rawScore: "-",
    },
    "sha256:telesport",
    "2026-10-24T16:00:00.000Z",
    corroboration(2, 1, "1"),
  ) as Record<string, unknown>;

  assert.equal(payload.pool_settlement_status, "under_review");
  assert.equal(payload.pool_outcome, undefined);
  assert.equal(payload.home_score, undefined);
});

test("a score disagreement with the same outcome still goes under review", () => {
  const payload = buildTelesportGameUpdate(
    game,
    {
      gameNumber: 1,
      status: "finished",
      homeScore: 2,
      awayScore: 1,
      outcome: "1",
      rawStatus: "הסתיים",
      rawScore: "1 - 2",
    },
    "sha256:telesport",
    "2026-10-24T16:00:00.000Z",
    corroboration(3, 1, "1"),
  ) as Record<string, unknown>;

  assert.equal(payload.pool_settlement_status, "under_review");
  assert.equal(payload.pool_outcome, undefined);
});

test("a row withheld by the parser goes under review with its reason and writes no score", () => {
  const html = TELESPORT_264301_MODERN_HTML.replace(
    /(>ליברפול<\/span><span class="tt-score">1 - 0<\/span>[\s\S]*?<span class="tt-result tt-result-known">)2</,
    (_match, prefix: string) => `${prefix}1<`,
  );
  const source = parseTelesportWinner16StateHtml(html).games[6];
  const payload = buildTelesportGameUpdate(
    { ...game, status: "finished", settlement_status: "under_review" },
    source,
    "sha256:telesport",
    "2026-11-01T19:00:00.000Z",
    corroboration(0, 1, "2"),
  ) as Record<string, unknown>;

  assert.deepEqual(payload, {
    round_game_id: game.id,
    status: "under_review",
    observed_at: "2026-11-01T19:00:00.000Z",
    pool_settlement_status: "under_review",
    settlement_source: "telesport-winner16:sha256:telesport;review=score_outcome_conflict",
  });
});

test("the real round 264301 page and 365Scores finals corroborate all 16 games", () => {
  const source = parseTelesportWinner16StateHtml(TELESPORT_264301_MODERN_HTML);

  for (const expected of ROUND_264301) {
    const scores365 = matchScores365FinalResult(expected, SCORES365_264301_FINALS);
    assert.ok(scores365, `game ${expected.game} 365Scores match`);

    // The row as production holds it now: the swapped score, under review.
    const payload = buildTelesportGameUpdate(
      {
        ...game,
        game_number: expected.game,
        status: "finished",
        field_home_score: expected.score[1],
        field_away_score: expected.score[0],
        settlement_status: "under_review",
      },
      source.games[expected.game - 1],
      "sha256:telesport",
      "2026-11-03T05:17:00.000Z",
      { result: scores365, sourceVersion: "sha256:365" },
    ) as Record<string, unknown>;

    assert.deepEqual(
      [payload.status, payload.home_score, payload.away_score, payload.pool_settlement_status, payload.pool_outcome],
      ["finished", ...expected.score, "settled", expected.outcome],
      `game ${expected.game}`,
    );
    assert.equal(
      payload.settlement_source,
      `telesport-winner16:sha256:telesport;365scores:event=${expected.eventId}:sha256:365`,
    );
  }
});
