import assert from "node:assert/strict";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import {
  buildMatchLedgerObservationPayload,
  buildMatchLedgerWithdrawalPayload,
  validateMatchLedgerObservation,
  type MatchLedgerObservationInput,
} from "./match-ledger";
import {
  createFixture,
  createLedgerDatabase,
  realisticObservation,
  recordObservation,
  seedLedger,
  type LedgerSeed,
} from "./test-support/ledger-fixtures";

/**
 * Regression tests for the Foundation 1A review: information time, provider
 * fixture concurrency, database-authoritative validation, provider/identity
 * consistency, related entities, multi-provider safety and lock coverage.
 * PGlite has one connection, so concurrency is proven by asserting that the
 * serializing advisory locks are held until commit and that non-READ
 * COMMITTED writers are refused; the race outcomes are covered sequentially.
 */

const KICKOFF = "2026-10-30T18:00:00.000Z";
const RETRIEVED = "2026-10-31T08:59:30.000Z";
const SEEN = "2026-10-31T09:00:00.000Z";

async function advisoryLockHeld(db: PGlite, key: string): Promise<boolean> {
  const result = await db.query<{ n: number }>(
    `select count(*)::int as n from pg_locks
     where locktype = 'advisory' and objsubid = 1
       and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
    [key],
  );
  return result.rows[0].n > 0;
}

async function observationCount(db: PGlite): Promise<number> {
  return (await db.query<{ n: number }>("select count(*)::int as n from public.match_ledger_observations")).rows[0].n;
}

async function providerPlayerId(db: PGlite, playerId: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    "select provider_player_id as id from public.provider_player_mappings where provider = 'sportmonks' and player_id = $1",
    [playerId],
  );
  return result.rows[0].id;
}

async function setup() {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  const fixture = await createFixture(db, seed, KICKOFF);
  const base = (): MatchLedgerObservationInput =>
    realisticObservation(seed, fixture, { kickoffAt: KICKOFF, retrievedAt: RETRIEVED });
  return { db, seed, fixture, base };
}

test("an early BEGIN does not backdate knowledge; one observation shares one information time", async () => {
  const db = await createLedgerDatabase({ testClock: false });
  const seed = await seedLedger(db);
  const kickoff = "2024-02-03T18:00:00.000Z";
  const fixture = await createFixture(db, seed, kickoff);
  const payload = buildMatchLedgerObservationPayload(
    realisticObservation(seed, fixture, { kickoffAt: kickoff, retrievedAt: "2024-02-04T00:00:00.000Z" }),
  );

  await db.exec("begin");
  const start = (await db.query<{ t: Date }>("select now() as t")).rows[0].t;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const recorded = await db.query<{ r: { observation_id: string } }>(
    "select public.match_ledger_record_observation($1::jsonb) as r",
    [JSON.stringify(payload)],
  );
  await db.exec("commit");

  const id = recorded.rows[0].r.observation_id;
  const header = (await db.query<{ first_seen_at: Date; contract_version: string }>(
    "select first_seen_at, contract_version from public.match_ledger_observations where id = $1",
    [id],
  )).rows[0];
  assert.ok(header.first_seen_at.getTime() - start.getTime() >= 1000, "information time is not the transaction start");
  assert.equal(header.contract_version, "kapiloto-match-ledger-observation-v1");
  const copies = await db.query<{ n: number }>(
    `select count(distinct first_seen_at)::int as n from (
       select first_seen_at from public.match_ledger_team_records where observation_id = $1
       union all
       select first_seen_at from public.match_ledger_players where observation_id = $1
     ) t where first_seen_at = $2`,
    [id, header.first_seen_at],
  );
  assert.equal(copies.rows[0].n, 1);
  const total = await db.query<{ n: number }>(
    `select count(*)::int as n from (
       select first_seen_at from public.match_ledger_team_records where observation_id = $1
       union all
       select first_seen_at from public.match_ledger_players where observation_id = $1
     ) t where first_seen_at <> $2`,
    [id, header.first_seen_at],
  );
  assert.equal(total.rows[0].n, 0);
  await db.close();
});

test("a later statement in the same transaction cannot append to an observation", async () => {
  const { db, seed, base } = await setup();
  await db.exec("begin");
  const recorded = await recordObservation(db, base(), SEEN);
  await assert.rejects(
    db.query(
      `insert into public.match_ledger_events (observation_id, team_id, sequence_no, event_type, player_id)
       values ($1, $2, 99, 'red_card', $3)`,
      [recorded.observation_id, seed.away.teamId, seed.away.playerIds[4]],
    ),
    /sealed/,
  );
  await db.exec("rollback");
  assert.equal(await observationCount(db), 0);
  await db.close();
});

test("provider fixture identity is serialized by a lock held until commit", async () => {
  const { db, fixture, base } = await setup();
  const providerKey = `kapiloto_match_ledger_provider_fixture:sportmonks:${fixture.providerFixtureId}`;
  const fixtureKey = `kapiloto_match_ledger_fixture:${fixture.fixtureId}:sportmonks`;

  await db.exec("begin");
  await recordObservation(db, base(), SEEN);
  assert.equal(await advisoryLockHeld(db, providerKey), true);
  assert.equal(await advisoryLockHeld(db, fixtureKey), true);
  await db.exec("commit");
  assert.equal(await advisoryLockHeld(db, providerKey), false);

  // Snapshot-isolated writers could miss a competitor's commit: refused.
  await db.exec("begin isolation level repeatable read");
  await assert.rejects(
    recordObservation(db, { ...base(), homeGoals90: 3, awayGoals90: 1 }, "2026-11-01T00:00:00.000Z"),
    /requires READ COMMITTED/,
  );
  await db.exec("rollback");
  await db.close();
});

test("one provider fixture id resolves to one canonical fixture, re-pointable only after withdrawal", async () => {
  const { db, seed, fixture, base } = await setup();
  const duplicate = await createFixture(db, seed, KICKOFF);
  const onDuplicate = (providerFixtureId: string) =>
    realisticObservation(seed, { fixtureId: duplicate.fixtureId, providerFixtureId }, { kickoffAt: KICKOFF, retrievedAt: RETRIEVED });

  await recordObservation(db, base(), SEEN);
  await assert.rejects(recordObservation(db, onDuplicate(fixture.providerFixtureId), SEEN), /different canonical fixture/);

  // Withdraw the wrong attachment; the id may now move to the right fixture.
  await recordObservation(
    db,
    buildMatchLedgerWithdrawalPayload({
      fixtureId: fixture.fixtureId,
      provider: "sportmonks",
      providerFixtureId: fixture.providerFixtureId,
      captureMode: "manual_import",
      ingestVersion: "test",
      retrievedAt: "2026-11-01T00:00:00.000Z",
      withdrawalReason: "attached to the wrong canonical fixture",
    }),
    "2026-11-01T00:00:10.000Z",
  );
  const moved = await recordObservation(db, onDuplicate(fixture.providerFixtureId), "2026-11-01T00:01:00.000Z");
  assert.equal(moved.status, "recorded");
  // The original fixture can take its correct provider id; the moved id is now taken.
  const corrected = await recordObservation(
    db,
    realisticObservation(seed, { fixtureId: fixture.fixtureId, providerFixtureId: "sm-correct" }, { kickoffAt: KICKOFF, retrievedAt: "2026-11-01T00:01:30.000Z" }),
    "2026-11-01T00:02:00.000Z",
  );
  assert.equal(corrected.observation_version, 3);
  await assert.rejects(
    recordObservation(
      db,
      realisticObservation(seed, { fixtureId: fixture.fixtureId, providerFixtureId: fixture.providerFixtureId }, { kickoffAt: KICKOFF, retrievedAt: "2026-11-01T00:02:30.000Z", homeGoals: 3 }),
      "2026-11-01T00:03:00.000Z",
    ),
    /provider fixture id changed|different canonical fixture/,
  );
  await db.close();
});

test("direct RPC calls cannot persist logically invalid data, atomically", async () => {
  const { db, seed, base } = await setup();
  // Raw payloads: the TypeScript validator is never called on these paths.
  const raw = (mutate: (payload: Record<string, any>) => void) => {
    const payload = buildMatchLedgerObservationPayload(base()) as Record<string, any>;
    mutate(payload);
    return payload;
  };
  const awayId = seed.away.teamId;
  const cases: Array<[string, (payload: Record<string, any>) => void, RegExp]> = [
    ["finished without score", (p) => { p.home_goals_90 = null; p.away_goals_90 = null; }, /check constraint/],
    ["complete lineup with 10 starters", (p) => { p.players = p.players.filter((x: any) => x.player_id !== seed.away.playerIds[0]); }, /complete but has 10 starters/],
    ["players on a not_provided lineup", (p) => { p.teams.find((t: any) => t.team_id === awayId).lineup_status = "not_provided"; }, /not_provided but has matchday players/],
    ["substitutions marked not_provided", (p) => { p.teams.find((t: any) => t.team_id === awayId).substitutions_status = "not_provided"; }, /substitutions are not_provided/],
    ["events marked not_provided", (p) => { p.teams.find((t: any) => t.team_id === awayId).events_status = "not_provided"; }, /events are not_provided/],
    ["statistics marked not_provided", (p) => { p.teams.find((t: any) => t.team_id === awayId).statistics_status = "not_provided"; }, /statistics are not_provided/],
  ];
  for (const [label, mutate, error] of cases) {
    await assert.rejects(recordObservation(db, raw(mutate), SEEN), error, label);
  }
  assert.equal(await observationCount(db), 0);
  for (const table of ["match_ledger_team_records", "match_ledger_players", "match_ledger_events", "match_ledger_team_stats"]) {
    assert.equal((await db.query<{ n: number }>(`select count(*)::int as n from public.${table}`)).rows[0].n, 0, table);
  }

  // The validator agrees with the database on the same inputs.
  const tsInput = base();
  tsInput.teams[1].eventsStatus = "not_provided";
  assert.ok(validateMatchLedgerObservation(tsInput).some((issue) => issue.includes("events are marked not_provided")));

  // "complete" with zero substitutions is valid: completeness is a claim, not a minimum.
  const noSubs = base();
  noSubs.substitutions = noSubs.substitutions!.filter((s) => s.teamId !== awayId);
  noSubs.players!.filter((p) => p.teamId === awayId && p.lineupRole === "bench").forEach((p) => {
    p.appeared = false;
    p.enteredMinute = null;
  });
  assert.deepEqual(validateMatchLedgerObservation(noSubs), []);
  assert.equal((await recordObservation(db, noSubs, SEEN)).status, "recorded");
  await db.close();
});

test("an observation can only use its own provider's stat definitions", async () => {
  const { db, base } = await setup();
  const foreign = await db.query<{ id: string }>(
    `insert into public.match_ledger_stat_definitions (provider, provider_stat_type, definition_version, stat_key, unit)
     values ('api_football', 'Ball Possession', 'af-v3', 'possession_pct', 'percent') returning id`,
  );
  const input = base();
  input.teamStats![0].statDefinitionId = foreign.rows[0].id;
  await assert.rejects(recordObservation(db, input, SEEN), /does not belong to provider sportmonks/);
  assert.equal(await observationCount(db), 0);
  await db.close();
});

test("provider player and coach ids cannot contradict authoritative mappings", async () => {
  const { db, seed, base } = await setup();
  const [p1, p2] = seed.home.playerIds;
  const p2ProviderId = await providerPlayerId(db, p2);

  const forward = base();
  forward.players![0].providerPlayerId = p2ProviderId;
  await assert.rejects(recordObservation(db, forward, SEEN), /mapped to a different canonical player/);

  const reverse = base();
  reverse.players![0].providerPlayerId = "sm-unmapped-999";
  await assert.rejects(recordObservation(db, reverse, SEEN), /canonical player is mapped to a different provider player id/);

  const coachConflict = base();
  const awayCoachProviderId = (await db.query<{ id: string }>(
    "select provider_coach_id as id from public.provider_coach_mappings where coach_id = $1",
    [seed.away.coachId],
  )).rows[0].id;
  coachConflict.teams[0].providerCoachId = awayCoachProviderId;
  await assert.rejects(recordObservation(db, coachConflict, SEEN), /mapped to a different canonical coach/);

  const coachReverse = base();
  coachReverse.teams[0].providerCoachId = "sm-coach-unmapped";
  await assert.rejects(recordObservation(db, coachReverse, SEEN), /canonical coach is mapped to a different provider coach id/);
  assert.equal(await observationCount(db), 0);

  // Unknown is not contradiction: an unverified mapping never blocks, and a
  // merged duplicate resolves to the same survivor.
  await db.query("update public.provider_player_mappings set mapping_status = 'unverified' where player_id = $1", [p2]);
  const duplicate = "63000000-0000-4000-8000-0000000d0001";
  await db.query("insert into public.players (id, canonical_name) values ($1, 'Duplicate of P1')", [duplicate]);
  await db.query(
    "insert into public.provider_player_mappings (provider, provider_player_id, player_id, mapping_status) values ('sportmonks', 'sm-dup-1', $1, 'confirmed')",
    [duplicate],
  );
  await db.query("update public.players set identity_status = 'merged', merged_into_player_id = $2 where id = $1", [duplicate, p1]);
  const allowed = base();
  allowed.players![0].providerPlayerId = "sm-dup-1";
  allowed.players![1].providerPlayerId = p2ProviderId;
  assert.equal((await recordObservation(db, allowed, SEEN)).status, "recorded");
  await db.close();
});

test("related players must be in the match; staff cards cannot contradict the team's coach", async () => {
  const { db, seed, base } = await setup();
  const outsider = "63000000-0000-4000-8000-0000000e0001";
  await db.query("insert into public.players (id, canonical_name) values ($1, 'Not in squad')", [outsider]);
  const thirdCoach = "62000000-0000-4000-8000-0000000e0001";
  await db.query("insert into public.coaches (id, canonical_name) values ($1, 'Assistant')", [thirdCoach]);
  const coachCard = (input: MatchLedgerObservationInput) => input.events!.find((e) => e.coachId)!;

  const notInMatch = base();
  notInMatch.events![0].relatedPlayerId = outsider;
  await assert.rejects(recordObservation(db, notInMatch, SEEN), /foreign key/);

  const onCard = base();
  onCard.events![1].relatedPlayerId = seed.away.playerIds[3];
  await assert.rejects(recordObservation(db, onCard, SEEN), /check constraint/);

  const opponentCoach = base();
  coachCard(opponentCoach).coachId = seed.away.coachId;
  await assert.rejects(recordObservation(db, opponentCoach, SEEN), /opponent's head coach/);

  const otherHeadCoach = base();
  coachCard(otherHeadCoach).coachId = thirdCoach;
  await assert.rejects(recordObservation(db, otherHeadCoach, SEEN), /other than the team's head coach/);

  const headAsAssistant = base();
  coachCard(headAsAssistant).staffRole = "assistant_coach";
  await assert.rejects(recordObservation(db, headAsAssistant, SEEN), /head coach as non-head-coach staff/);

  const noRole = buildMatchLedgerObservationPayload(base()) as Record<string, any>;
  noRole.events.find((e: any) => e.coach_id).staff_role = null;
  await assert.rejects(recordObservation(db, noRole, SEEN), /check constraint/);
  assert.equal(await observationCount(db), 0);

  // Valid: an assist from a teammate, the opponent goalkeeper on a penalty
  // miss, an assistant's card, and a head-coach card when the team's head
  // coach is unknown.
  const valid = base();
  valid.events![0].relatedPlayerId = seed.home.playerIds[9];
  valid.events!.find((e) => e.eventType === "penalty_missed")!.relatedPlayerId = seed.away.playerIds[0];
  coachCard(valid).coachId = thirdCoach;
  coachCard(valid).staffRole = "assistant_coach";
  assert.equal((await recordObservation(db, valid, SEEN)).status, "recorded");

  const unknownHead = realisticObservation(seed, await createFixture(db, seed, "2026-10-20T18:00:00.000Z"), {
    kickoffAt: "2026-10-20T18:00:00.000Z",
    retrievedAt: RETRIEVED,
  });
  unknownHead.teams[0].coachId = null;
  coachCard(unknownHead).coachId = thirdCoach;
  assert.equal((await recordObservation(db, unknownHead, SEEN)).status, "recorded");
  await db.close();
});

test("identity merges and tenure versions are serialized and refuse snapshot isolation", async () => {
  const db = await createLedgerDatabase();
  const seed: LedgerSeed = await seedLedger(db);
  const [a, b] = seed.home.playerIds;

  await db.exec("begin");
  await db.query("update public.players set identity_status = 'merged', merged_into_player_id = $2 where id = $1", [a, b]);
  assert.equal(await advisoryLockHeld(db, "kapiloto_identity_merge:players"), true);
  await db.exec("commit");
  // The reverse merge, which a concurrent transaction would attempt, now fails.
  await assert.rejects(
    db.query("update public.players set identity_status = 'merged', merged_into_player_id = $2 where id = $1", [b, a]),
    /merged into an active player|merge target/,
  );

  await db.exec("begin isolation level repeatable read");
  await assert.rejects(
    db.query("update public.players set identity_status = 'merged', merged_into_player_id = $2 where id = $1", [seed.home.playerIds[2], b]),
    /requires READ COMMITTED/,
  );
  await db.exec("rollback");
  // Ordinary metadata edits are not serialized or restricted.
  await db.exec("begin isolation level repeatable read");
  await db.query("update public.players set height_cm = 181 where id = $1", [b]);
  await db.exec("commit");

  const tenureKey = "90000000-0000-4000-8000-0000000f0001";
  const insertTenure = () =>
    db.query<{ tenure_version: number }>(
      `insert into public.team_coach_tenures
         (tenure_key, team_id, coach_id, starts_on_earliest, starts_on_latest, source_kind, ingest_version)
       values ($1, $2, $3, '2026-06-01', '2026-06-01', 'manual', 'test') returning tenure_version`,
      [tenureKey, seed.home.teamId, seed.home.coachId],
    );
  await db.exec("begin");
  assert.equal((await insertTenure()).rows[0].tenure_version, 1);
  assert.equal(await advisoryLockHeld(db, `kapiloto_tenure:${tenureKey}`), true);
  await db.exec("commit");
  assert.equal((await insertTenure()).rows[0].tenure_version, 2);
  await db.exec("begin isolation level repeatable read");
  await assert.rejects(insertTenure(), /requires READ COMMITTED/);
  await db.exec("rollback");
  await db.close();
});
