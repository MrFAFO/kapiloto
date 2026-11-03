import assert from "node:assert/strict";
import test from "node:test";

import { createMigratedDatabase } from "@/lib/kapiloto/test-support/pglite-migrations";
import { ROUND_264301 } from "./fixtures/round-264301";
import {
  DRAWS,
  pgliteSupabaseClient,
  readGames264301,
  readRoundStatus264301,
  readTicketResults264301,
  ROUND_ID,
  roundGameId,
  seedStoredRound264301,
  stubRound264301Providers,
} from "./fixtures/round-264301-db";
import { runAutomaticLiveSync } from "./live-sync";

// End to end on the real migration chain: the stored production state of
// round 264301 is re-synced with the fixed parser through the real live sync,
// the 365Scores matcher and toto_apply_game_state_v1.

const SYNC_AT = new Date("2026-11-03T05:17:00.000Z");

test("re-syncing the stored round 264301 corrects every swapped game and settles the round", async () => {
  const db = await createMigratedDatabase();
  const providers = stubRound264301Providers();
  try {
    await seedStoredRound264301(db);
    const before = await readGames264301(db);

    const result = await runAutomaticLiveSync(pgliteSupabaseClient(db), ROUND_ID, { now: SYNC_AT });
    assert.deepEqual(result, {
      status: "synced",
      roundId: ROUND_ID,
      roundNumber: "264301",
      fetchedAt: SYNC_AT.toISOString(),
      touchedGames: 16,
      settledGames: 13,
      underReviewGames: 0,
    });

    const after = await readGames264301(db);
    for (const expected of ROUND_264301) {
      const row = after[expected.game - 1];
      assert.deepEqual(
        [row.status, row.field_home_score, row.field_away_score, row.field_outcome,
          row.settlement_status, row.pool_settlement_outcome, row.home_score, row.away_score],
        ["finished", ...expected.score, expected.outcome, "settled", expected.outcome, ...expected.score],
        `game ${expected.game}`,
      );
      if (DRAWS.has(expected.game)) {
        // Already-settled draws are skipped, not rewritten.
        assert.deepEqual(row, before[expected.game - 1], `game ${expected.game} untouched`);
      } else {
        assert.match(
          row.settlement_source,
          new RegExp(`^telesport-winner16:sha256:[0-9a-f]{64};365scores:event=${expected.eventId}:sha256:[0-9a-f]{64}$`),
        );
      }
    }
    assert.equal(await readRoundStatus264301(db), "settled");
    assert.deepEqual(await readTicketResults264301(db), [
      [roundGameId(7), "hit", true, "2"],
      [roundGameId(10), "miss", false, "1"],
    ]);

    // A repeat sync finds the round settled, fetches nothing and writes nothing.
    const fetches = providers.requests.length;
    assert.deepEqual(
      await runAutomaticLiveSync(pgliteSupabaseClient(db), ROUND_ID, { now: new Date("2026-11-03T06:17:00.000Z") }),
      { status: "round_settled", roundId: ROUND_ID, roundNumber: "264301" },
    );
    assert.deepEqual(await readGames264301(db), after);
    assert.equal(providers.requests.length, fetches);
  } finally {
    providers.restore();
    await db.close();
  }
});

test("a 365Scores disagreement or a missing 365Scores event keeps that game and the round under review", async () => {
  const db = await createMigratedDatabase();
  const providers = stubRound264301Providers({
    scores365: (_date, list) =>
      list
        // Liverpool-Arsenal reported the other way round.
        .map((event) =>
          event.id === 4742014
            ? {
                ...event,
                homeCompetitor: { ...(event.homeCompetitor as object), score: 1 },
                awayCompetitor: { ...(event.awayCompetitor as object), score: 0 },
              }
            : event,
        )
        // Maccabi Jaffa-Hapoel Kfar Saba missing.
        .filter((event) => event.id !== 4739083),
  });
  try {
    await seedStoredRound264301(db);
    const result = await runAutomaticLiveSync(pgliteSupabaseClient(db), ROUND_ID, { now: SYNC_AT });
    assert.equal(result.status, "synced");
    assert.equal(result.status === "synced" && result.settledGames, 11);
    assert.equal(result.status === "synced" && result.underReviewGames, 2);

    const after = await readGames264301(db);
    const liverpool = after[6];
    assert.equal(liverpool.settlement_status, "under_review");
    assert.equal(liverpool.pool_settlement_outcome, null);
    assert.match(liverpool.settlement_source, /;365scores:event=4742014:/);
    // The field score is Telesport's, now read in the right orientation.
    assert.deepEqual([liverpool.field_home_score, liverpool.field_away_score, liverpool.field_outcome], [0, 1, "2"]);

    const jaffa = after[5];
    assert.equal(jaffa.settlement_status, "under_review");
    assert.equal(jaffa.pool_settlement_outcome, null);
    assert.match(jaffa.settlement_source, /;365scores:unverified$/);

    assert.equal(await readRoundStatus264301(db), "under_review");
    assert.deepEqual(await readTicketResults264301(db), [
      [roundGameId(7), "under_review", null, null],
      [roundGameId(10), "miss", false, "1"],
    ]);
  } finally {
    providers.restore();
    await db.close();
  }
});

test("settled games cannot be re-settled with a different outcome", async () => {
  const db = await createMigratedDatabase();
  try {
    await seedStoredRound264301(db);
    await assert.rejects(
      db.query("select public.toto_apply_game_state_v1($1::jsonb)", [
        JSON.stringify({
          round_game_id: roundGameId(2),
          status: "finished",
          home_score: 2,
          away_score: 1,
          observed_at: SYNC_AT.toISOString(),
          pool_settlement_status: "settled",
          pool_outcome: "1",
          settlement_source: "test",
        }),
      ]),
      /game_state_settlement_immutable/,
    );
  } finally {
    await db.close();
  }
});
