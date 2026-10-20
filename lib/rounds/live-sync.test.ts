import assert from "node:assert/strict";
import test from "node:test";

import { buildTelesportGameUpdate } from "./live-sync";

const game = {
  id: "00000000-0000-4000-8000-000000000001",
  game_number: 1,
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

test("finished Telesport row with 1X2 settles the pool result", () => {
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
  assert.equal(payload.pool_settlement_status, "settled");
  assert.equal(payload.pool_outcome, "1");
  assert.equal(
    payload.settlement_source,
    "telesport-winner16:sha256:official",
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
