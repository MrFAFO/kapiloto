import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

// The contingency SQL template (D-062), executed verbatim, as an operator would.
const CORRECTION_SQL = readFileSync(
  join(process.cwd(), "docs", "operations", "sql", "winner16-264301-orientation-correction.sql"),
  "utf8",
);

test("the guarded correction settles the stored round 264301 once and is idempotent", async () => {
  const db = await createMigratedDatabase();
  try {
    await seedStoredRound264301(db);
    const before = await readGames264301(db);

    await db.exec(CORRECTION_SQL);
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
        assert.deepEqual(row, before[expected.game - 1], `game ${expected.game} untouched`);
      } else {
        assert.equal(
          row.settlement_source,
          `kapiloto-operator:d062-264301-orientation;telesport-winner16:score_1-score_2;365scores:event=${expected.eventId}`,
        );
      }
    }
    assert.equal(await readRoundStatus264301(db), "settled");
    assert.deepEqual(await readTicketResults264301(db), [
      [roundGameId(7), "hit", true, "2"],
      [roundGameId(10), "miss", false, "1"],
    ]);

    await db.exec(CORRECTION_SQL);
    assert.deepEqual(await readGames264301(db), after);
  } finally {
    await db.close();
  }
});

test("a game outside the reviewed states aborts the whole correction with no effect", async () => {
  const db = await createMigratedDatabase();
  try {
    await seedStoredRound264301(db);
    await db.query(
      "update public.round_games set field_home_score = 2, field_away_score = 0 where id = $1",
      [roundGameId(7)],
    );
    const before = await readGames264301(db);

    await assert.rejects(db.exec(CORRECTION_SQL), /w16_264301_unexpected_state: game 7/);
    assert.deepEqual(await readGames264301(db), before);
    assert.equal(await readRoundStatus264301(db), "under_review");
  } finally {
    await db.close();
  }
});

test("NULL field scores abort the whole correction instead of passing three-valued SQL logic", async () => {
  const db = await createMigratedDatabase();
  try {
    await seedStoredRound264301(db);
    await db.query(
      "update public.round_games set field_home_score = null, field_away_score = null where id = $1",
      [roundGameId(7)],
    );
    const before = await readGames264301(db);

    await assert.rejects(db.exec(CORRECTION_SQL), /w16_264301_unexpected_state: game 7/);
    assert.deepEqual(await readGames264301(db), before);
    assert.equal(await readRoundStatus264301(db), "under_review");
  } finally {
    await db.close();
  }
});

test("a non-under-review round aborts any attempted correction and rolls back every game write", async () => {
  const db = await createMigratedDatabase();
  try {
    await seedStoredRound264301(db);
    await db.query(
      "update public.rounds set status = 'finished' where id = $1",
      [ROUND_ID],
    );
    const before = await readGames264301(db);

    await assert.rejects(
      db.exec(CORRECTION_SQL),
      /w16_264301_unexpected_round_status: finished/,
    );
    assert.deepEqual(await readGames264301(db), before);
    assert.equal(await readRoundStatus264301(db), "finished");
  } finally {
    await db.close();
  }
});

test("a team identity that differs from the evidence aborts the correction", async () => {
  const db = await createMigratedDatabase();
  try {
    await seedStoredRound264301(db);
    await db.query(
      `update public.teams set canonical_name = 'מכבי פתח תקווה'
       where id = (select away_team_id from public.round_games where id = $1)`,
      [roundGameId(4)],
    );
    const before = await readGames264301(db);

    await assert.rejects(db.exec(CORRECTION_SQL), /w16_264301_identity_mismatch: game 4/);
    assert.deepEqual(await readGames264301(db), before);
  } finally {
    await db.close();
  }
});

test("after a partial fixed sync the correction settles only what is left", async () => {
  const db = await createMigratedDatabase();
  const providers = stubRound264301Providers({
    scores365: (_date, list) => list.filter((event) => event.id !== 4739083),
  });
  try {
    await seedStoredRound264301(db);
    const synced = await runAutomaticLiveSync(pgliteSupabaseClient(db), ROUND_ID, {
      now: new Date("2026-11-03T05:17:00.000Z"),
    });
    assert.equal(synced.status === "synced" && synced.settledGames, 12);
    const partial = await readGames264301(db);
    // Maccabi Jaffa: corrected field score, still under review.
    assert.deepEqual(
      [partial[5].field_home_score, partial[5].field_away_score, partial[5].settlement_status],
      [0, 3, "under_review"],
    );

    await db.exec(CORRECTION_SQL);
    const after = await readGames264301(db);
    for (const expected of ROUND_264301) {
      if (expected.game === 6) continue;
      assert.deepEqual(after[expected.game - 1], partial[expected.game - 1], `game ${expected.game} untouched`);
    }
    assert.deepEqual(
      [after[5].settlement_status, after[5].pool_settlement_outcome, after[5].field_home_score, after[5].field_away_score],
      ["settled", "2", 0, 3],
    );
    assert.equal(await readRoundStatus264301(db), "settled");
  } finally {
    providers.restore();
    await db.close();
  }
});
