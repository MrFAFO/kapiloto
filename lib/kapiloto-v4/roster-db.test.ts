import assert from "node:assert/strict";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { membershipCoverage } from "./roster";
import { createLedgerDatabase, seedLedger, setClock } from "./test-support/ledger-fixtures";
import { articleInput, recordDocument } from "./test-support/knowledge-fixtures";
import { insertMembership, membershipKey, membershipsAsOf } from "./test-support/roster-fixtures";

/**
 * Roster membership: immutable, versioned assertions with uncertain dates,
 * database information time, D-050 identity and per-key serialization.
 */

async function advisoryLockModes(db: PGlite, key: string): Promise<string[]> {
  const result = await db.query<{ mode: string }>(
    `select mode from pg_locks
     where locktype = 'advisory' and objsubid = 1
       and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
    [key],
  );
  return result.rows.map((row) => row.mode).sort();
}

test("memberships are versioned assertions: correction, retraction, uncertain dates and as-of reads", async () => {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  const team = seed.home.teamId;
  const player = seed.home.playerIds[0];
  const key = membershipKey();

  const v1 = await insertMembership(db, { membership_key: key, team_id: team, player_id: player, starts_on_earliest: "2026-07-01", starts_on_latest: "2026-07-15", shirt_number: 9 }, "2026-09-01T00:00:00.000Z");
  // Writers cannot choose the version or the information time.
  assert.equal(v1.membership_version, 1);
  assert.equal(v1.first_seen_at.toISOString(), "2026-09-01T00:00:00.000Z");

  const coverageAt = async (cutoff: string, date: string) => (await membershipsAsOf(db, team, cutoff, date)).map((m) => [m.membership_version, m.coverage]);
  // Start known only within Jul 1..Jul 15: possible inside it, certain after.
  assert.deepEqual(await coverageAt("2026-10-01T00:00:00.000Z", "2026-06-30"), [[1, "outside"]]);
  assert.deepEqual(await coverageAt("2026-10-01T00:00:00.000Z", "2026-07-10"), [[1, "possible"]]);
  assert.deepEqual(await coverageAt("2026-10-01T00:00:00.000Z", "2026-08-01"), [[1, "certain"]]);

  // A correction learns the end (last day Oct 1..Oct 3).
  await insertMembership(db, { membership_key: key, team_id: team, player_id: player, starts_on_earliest: "2026-07-01", starts_on_latest: "2026-07-15", ends_on_earliest: "2026-10-01", ends_on_latest: "2026-10-03" }, "2026-10-05T00:00:00.000Z");
  assert.deepEqual(await coverageAt("2026-10-01T00:00:00.000Z", "2026-10-02"), [[1, "certain"]]);
  assert.deepEqual(await coverageAt("2026-10-06T00:00:00.000Z", "2026-09-30"), [[2, "certain"]]);
  assert.deepEqual(await coverageAt("2026-10-06T00:00:00.000Z", "2026-10-02"), [[2, "possible"]]);
  assert.deepEqual(await coverageAt("2026-10-06T00:00:00.000Z", "2026-10-04"), [[2, "outside"]]);

  // A retraction removes it from later reads only.
  const v3 = await insertMembership(db, { membership_key: key, team_id: team, player_id: player, assertion_status: "retracted" }, "2026-10-10T00:00:00.000Z");
  assert.equal(v3.membership_version, 3);
  assert.deepEqual(await coverageAt("2026-10-11T00:00:00.000Z", "2026-08-01"), []);
  assert.deepEqual(await coverageAt("2026-10-06T00:00:00.000Z", "2026-09-30"), [[2, "certain"]]);

  // Backfill: a membership first stored on Nov 1 is invisible at Oct 30,
  // even though its dates cover Oct 30.
  const backfilled = seed.home.playerIds[1];
  await insertMembership(db, { membership_key: membershipKey(), team_id: team, player_id: backfilled, starts_on_earliest: "2026-01-01", starts_on_latest: "2026-01-01" }, "2026-11-01T00:00:00.000Z");
  assert.deepEqual((await membershipsAsOf(db, team, "2026-10-30T00:00:00.000Z", "2026-10-30")).map((m) => m.canonical_player_id), []);
  assert.deepEqual((await membershipsAsOf(db, team, "2026-11-02T00:00:00.000Z", "2026-10-30")).map((m) => m.canonical_player_id), [backfilled]);

  // Overlapping assertions from different sources coexist; nothing infers
  // which one is "true".
  await insertMembership(db, { membership_key: membershipKey(), team_id: team, player_id: backfilled, source_kind: "news_report", squad_group: "reserve" }, "2026-11-01T01:00:00.000Z");
  await insertMembership(db, { membership_key: membershipKey(), team_id: seed.away.teamId, player_id: backfilled, source_kind: "provider", provider: "sportmonks" }, "2026-11-01T02:00:00.000Z");
  assert.equal((await membershipsAsOf(db, team, "2026-11-02T00:00:00.000Z", "2026-10-30")).length, 2);
  assert.equal((await membershipsAsOf(db, seed.away.teamId, "2026-11-02T00:00:00.000Z", "2026-10-30")).length, 1);

  // Rows are immutable; bounds and provenance are checked.
  await assert.rejects(db.query("update public.team_player_memberships set shirt_number = 10"), /immutable/);
  await assert.rejects(db.query("delete from public.team_player_memberships"), /immutable/);
  await assert.rejects(insertMembership(db, { membership_key: membershipKey(), team_id: team, player_id: player, starts_on_earliest: "2026-07-10", starts_on_latest: "2026-07-01" }, "2026-11-03T00:00:00.000Z"), /check constraint/);
  await assert.rejects(insertMembership(db, { membership_key: membershipKey(), team_id: team, player_id: player, ends_on_earliest: "2026-08-01" }, "2026-11-03T00:00:00.000Z"), /check constraint/);
  await assert.rejects(insertMembership(db, { membership_key: membershipKey(), team_id: team, player_id: player, source_kind: "provider" }, "2026-11-03T00:00:00.000Z"), /check constraint/);
  // The SQL coverage rule and the TypeScript mirror agree.
  const bounds = { starts_on_earliest: "2026-07-01", starts_on_latest: "2026-07-15", ends_on_earliest: "2026-10-01", ends_on_latest: "2026-10-03" };
  assert.deepEqual(["2026-06-30", "2026-07-10", "2026-09-30", "2026-10-02", "2026-10-04"].map((d) => membershipCoverage(bounds, d)), ["outside", "possible", "certain", "possible", "outside"]);
  await db.close();
});

test("membership identity follows D-050: survivors on write, observed and canonical on read", async () => {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  const team = seed.home.teamId;
  const a = "63000000-0000-4000-8000-0000000d0001";
  const b = seed.home.playerIds[10];
  const unrelated = seed.home.playerIds[9];
  await db.query("insert into public.players (id, canonical_name) values ($1, 'Striker (duplicate record)')", [a]);
  const key = membershipKey();
  await insertMembership(db, { membership_key: key, team_id: team, player_id: a }, "2026-09-01T00:00:00.000Z");

  await db.query("update public.players set identity_status = 'merged', merged_into_player_id = $2 where id = $1", [a, b]);
  // The raw row stays A; reads report observed A, canonical B.
  const read = await membershipsAsOf(db, team, "2026-10-01T00:00:00.000Z", "2026-08-01");
  assert.deepEqual(read.map((m) => [m.observed_player_id, m.canonical_player_id]), [[a, b]]);
  const raw = await db.query("select player_id from public.team_player_memberships where membership_key = $1", [key]);
  assert.deepEqual(raw.rows, [{ player_id: a }]);

  // A stale merged id is refused (never silently canonicalized); a later
  // version of the same key names the survivor; a key never changes person
  // or team.
  await assert.rejects(insertMembership(db, { membership_key: key, team_id: team, player_id: a, ends_on_earliest: "2026-12-31", ends_on_latest: "2026-12-31" }, "2026-10-02T00:00:00.000Z"), /is merged into .*record the surviving canonical id/);
  await assert.rejects(insertMembership(db, { membership_key: membershipKey(), team_id: team, player_id: a }, "2026-10-02T00:00:00.000Z"), /record the surviving canonical id/);
  await assert.rejects(insertMembership(db, { membership_key: key, team_id: team, player_id: unrelated }, "2026-10-02T00:00:00.000Z"), /cannot change its team or player identity/);
  await assert.rejects(insertMembership(db, { membership_key: key, team_id: seed.away.teamId, player_id: b }, "2026-10-02T00:00:00.000Z"), /cannot change its team or player identity/);
  const v2 = await insertMembership(db, { membership_key: key, team_id: team, player_id: b, ends_on_earliest: "2026-12-31", ends_on_latest: "2026-12-31" }, "2026-10-02T00:00:00.000Z");
  assert.equal(v2.membership_version, 2);
  assert.deepEqual((await membershipsAsOf(db, team, "2026-10-03T00:00:00.000Z", "2026-08-01")).map((m) => [m.membership_version, m.observed_player_id, m.canonical_player_id]), [[2, b, b]]);
  // Earlier reads still see version 1 (observed A).
  assert.deepEqual((await membershipsAsOf(db, team, "2026-10-01T00:00:00.000Z", "2026-08-01")).map((m) => m.observed_player_id), [a]);
  await db.close();
});

test("membership versions are serialized per key, refuse snapshot isolation and never precede their information", async () => {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  const team = seed.home.teamId;
  const player = seed.home.playerIds[0];
  const key = membershipKey();

  await db.exec("begin");
  await insertMembership(db, { membership_key: key, team_id: team, player_id: player }, "2026-09-01T00:00:00.000Z");
  assert.deepEqual(await advisoryLockModes(db, `kapiloto_membership:${key}`), ["ExclusiveLock"]);
  // Identity checks run under the shared canonical identity lock (1A).
  assert.deepEqual(await advisoryLockModes(db, "kapiloto_identity:players"), ["ShareLock"]);
  await db.exec("commit");
  const second = await insertMembership(db, { membership_key: key, team_id: team, player_id: player, squad_group: "reserve" }, "2026-09-02T00:00:00.000Z");
  assert.equal(second.membership_version, 2);

  await db.exec("begin isolation level repeatable read");
  await assert.rejects(insertMembership(db, { membership_key: key, team_id: team, player_id: player }, "2026-09-03T00:00:00.000Z"), /requires READ COMMITTED/);
  await db.exec("rollback");

  // A backwards clock step cannot make a version precede the previous one or
  // its source document.
  await assert.rejects(insertMembership(db, { membership_key: key, team_id: team, player_id: player }, "2026-08-01T00:00:00.000Z"), /would precede version 2/);
  const doc = await recordDocument(db, articleInput({ retrievedAt: "2026-10-20T00:00:00.000Z" }), "2026-10-20T00:00:00.000Z");
  await assert.rejects(
    insertMembership(db, { membership_key: membershipKey(), team_id: team, player_id: player, document_version_id: doc.document_version_id }, "2026-10-15T00:00:00.000Z"),
    /would precede its source document version/,
  );
  await setClock(db, null);
  await db.close();
});
