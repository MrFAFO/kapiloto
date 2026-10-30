import assert from "node:assert/strict";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import type { ProviderPlayerMatchAsOfRow, ProviderTeamMatchAsOfRow } from "./as-of";
import { resolveAliasCandidates, type MatchLedgerMappingConflictRow } from "./entities";
import {
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
  setClock,
} from "./test-support/ledger-fixtures";

/**
 * Canonical identity after merges (kapiloto-canonical-identity-v1): ledger
 * rows keep their written ids, model-facing reads follow the survivor, writes
 * accept survivors only, and a merge never makes one observation version list
 * one person twice.
 */

const NOV_1 = "2026-11-01T00:00:00.000Z";

const playerId = (n: number) => `63000000-0000-4000-8000-0000000a${String(n).padStart(4, "0")}`;
const coachId = (n: number) => `62000000-0000-4000-8000-0000000a${String(n).padStart(4, "0")}`;

async function addPlayer(db: PGlite, id: string, name: string, providerPlayerId?: string): Promise<void> {
  await db.query("insert into public.players (id, canonical_name) values ($1, $2)", [id, name]);
  if (providerPlayerId) {
    await db.query(
      "insert into public.provider_player_mappings (provider, provider_player_id, player_id, mapping_status) values ('sportmonks', $1, $2, 'confirmed')",
      [providerPlayerId, id],
    );
  }
}

async function addCoach(db: PGlite, id: string, name: string, providerCoachId?: string): Promise<void> {
  await db.query("insert into public.coaches (id, canonical_name) values ($1, $2)", [id, name]);
  if (providerCoachId) {
    await db.query(
      "insert into public.provider_coach_mappings (provider, provider_coach_id, coach_id, mapping_status) values ('sportmonks', $1, $2, 'confirmed')",
      [providerCoachId, id],
    );
  }
}

const mergePlayer = (db: PGlite, duplicate: string, survivor: string) =>
  db.query("update public.players set identity_status = 'merged', merged_into_player_id = $2 where id = $1", [duplicate, survivor]);
const mergeCoach = (db: PGlite, duplicate: string, survivor: string) =>
  db.query("update public.coaches set identity_status = 'merged', merged_into_coach_id = $2 where id = $1", [duplicate, survivor]);

/** Rewrites every reference to one player (squad, substitutions, events). */
function swapPlayer(input: MatchLedgerObservationInput, from: string, to: string): MatchLedgerObservationInput {
  for (const player of input.players ?? []) if (player.playerId === from) player.playerId = to;
  for (const sub of input.substitutions ?? []) {
    if (sub.playerOffId === from) sub.playerOffId = to;
    if (sub.playerOnId === from) sub.playerOnId = to;
  }
  for (const event of input.events ?? []) {
    if (event.playerId === from) event.playerId = to;
    if (event.relatedPlayerId === from) event.relatedPlayerId = to;
  }
  return input;
}

/** Rewrites one team's head coach and that team's coach cards. */
function swapHomeCoach(input: MatchLedgerObservationInput, to: string): MatchLedgerObservationInput {
  const home = input.teams.find((team) => team.side === "home")!;
  for (const event of input.events ?? []) if (event.coachId && event.coachId === home.coachId) event.coachId = to;
  home.coachId = to;
  return input;
}

async function playerHistory(db: PGlite, id: string, cutoff: string, limit = 10): Promise<ProviderPlayerMatchAsOfRow[]> {
  return (
    await db.query<ProviderPlayerMatchAsOfRow>(
      "select * from public.match_ledger_provider_player_matches_as_of('sportmonks', $1, $2, $3)",
      [id, cutoff, limit],
    )
  ).rows;
}

async function teamHistory(db: PGlite, teamId: string, cutoff: string): Promise<ProviderTeamMatchAsOfRow[]> {
  return (
    await db.query<ProviderTeamMatchAsOfRow>(
      "select * from public.match_ledger_provider_team_matches_as_of('sportmonks', $1, $2, 10)",
      [teamId, cutoff],
    )
  ).rows;
}

async function observationCount(db: PGlite): Promise<number> {
  return (await db.query<{ n: number }>("select count(*)::int as n from public.match_ledger_observations")).rows[0].n;
}

async function setup() {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  const fixtureAt = async (day: number) => {
    const kickoff = `2026-10-${String(day).padStart(2, "0")}T18:00:00.000Z`;
    const fixture = await createFixture(db, seed, kickoff);
    const seen = `2026-10-${String(day + 1).padStart(2, "0")}T09:00:00.000Z`;
    const base = () => realisticObservation(seed, fixture, { kickoffAt: kickoff, retrievedAt: seen });
    return { fixture, seen, base };
  };
  return { db, seed, fixtureAt };
}

test("a merged duplicate's matches join the survivor's history, retroactively and once per fixture", async () => {
  const { db, seed, fixtureAt } = await setup();
  const keep = seed.home.playerIds[10];
  const dup = playerId(1);
  await addPlayer(db, dup, "Striker (provider duplicate)", "sm-dup-1");

  // F1 lists the duplicate, F2 the survivor; F3 v1 lists the duplicate and
  // its correction v2 the survivor. The two ids never share a version.
  const f1 = await fixtureAt(1);
  await recordObservation(db, swapPlayer(f1.base(), keep, dup), f1.seen);
  const f2 = await fixtureAt(8);
  await recordObservation(db, f2.base(), f2.seen);
  const f3 = await fixtureAt(15);
  await recordObservation(db, swapPlayer(f3.base(), keep, dup), f3.seen);
  await recordObservation(db, f3.base(), "2026-10-17T09:00:00.000Z");

  assert.deepEqual((await playerHistory(db, keep, NOV_1)).map((r) => r.fixture_id), [f3.fixture.fixtureId, f2.fixture.fixtureId]);
  assert.deepEqual((await playerHistory(db, dup, NOV_1)).map((r) => r.fixture_id), [f1.fixture.fixtureId]);

  await mergePlayer(db, dup, keep);

  const merged = await playerHistory(db, keep, NOV_1);
  assert.deepEqual(
    merged.map((r) => [r.fixture_id, r.observation_version, r.observed_player_id, r.canonical_player_id]),
    [
      [f3.fixture.fixtureId, 2, keep, keep],
      [f2.fixture.fixtureId, 1, keep, keep],
      [f1.fixture.fixtureId, 1, dup, keep],
    ],
  );
  assert.equal(new Set(merged.map((r) => r.fixture_id)).size, merged.length);
  // The striker's F1 minutes and substitution survive the merge unchanged.
  assert.deepEqual([merged[2].lineup_role, merged[2].minutes_played, merged[2].exited_minute], ["starter", 70, 70]);

  // A merged id redirects to the survivor's history.
  assert.deepEqual(await playerHistory(db, dup, NOV_1), merged);

  // Identity is current at every cutoff; football information is not.
  const oct16 = await playerHistory(db, keep, "2026-10-16T12:00:00.000Z");
  assert.deepEqual(
    oct16.map((r) => [r.fixture_id, r.observation_version, r.observed_player_id]),
    [
      [f3.fixture.fixtureId, 1, dup],
      [f2.fixture.fixtureId, 1, keep],
      [f1.fixture.fixtureId, 1, dup],
    ],
  );
  assert.deepEqual((await playerHistory(db, keep, "2026-10-05T00:00:00.000Z")).map((r) => r.observed_player_id), [dup]);
  assert.deepEqual((await playerHistory(db, keep, NOV_1, 2)).map((r) => r.fixture_id), [f3.fixture.fixtureId, f2.fixture.fixtureId]);

  // Raw rows are untouched, so undoing a wrong merge restores the old reads.
  const stored = await db.query<{ n: number }>("select count(*)::int as n from public.match_ledger_players where player_id = $1", [dup]);
  assert.equal(stored.rows[0].n, 2);
  await db.query("update public.players set identity_status = 'active', merged_into_player_id = null where id = $1", [dup]);
  assert.deepEqual((await playerHistory(db, keep, NOV_1)).map((r) => r.fixture_id), [f3.fixture.fixtureId, f2.fixture.fixtureId]);
  await db.close();
});

test("a merge is refused when the identities co-occur in one observation version, superseded versions included", async () => {
  const { db, seed, fixtureAt } = await setup();
  const keep = seed.home.playerIds[10];
  const unusedBench = seed.home.playerIds[17];
  const dup = playerId(2);
  await addPlayer(db, dup, "Listed twice by the provider");

  // F1 v1 lists the duplicate as an extra bench player beside the survivor.
  const f1 = await fixtureAt(1);
  await recordObservation(db, swapPlayer(f1.base(), unusedBench, dup), f1.seen);
  await assert.rejects(mergePlayer(db, dup, keep), /both appear in match ledger observation/);
  // A corrected version does not repair v1: earlier cutoffs still read it.
  await recordObservation(db, f1.base(), "2026-10-03T09:00:00.000Z");
  await assert.rejects(mergePlayer(db, dup, keep), /both appear in match ledger observation/);

  // The check covers the target's whole identity class: x and y share F2,
  // x merges into keep, so y cannot merge into keep either.
  const x = playerId(3);
  const y = playerId(4);
  await addPlayer(db, x, "X");
  await addPlayer(db, y, "Y");
  const f2 = await fixtureAt(8);
  await recordObservation(db, swapPlayer(swapPlayer(f2.base(), keep, x), unusedBench, y), f2.seen);
  await mergePlayer(db, x, keep);
  await assert.rejects(mergePlayer(db, y, keep), /both appear in match ledger observation/);

  // Coaches: opposite benches of one observation are refused ...
  const homeCoach = seed.home.coachId;
  const awayCoach = seed.away.coachId;
  await assert.rejects(mergeCoach(db, awayCoach, homeCoach), /opposite sides of match ledger observation/);
  const awayAssistant = coachId(1);
  await addCoach(db, awayAssistant, "Away assistant");
  const f3 = await fixtureAt(15);
  const withAwayCard = f3.base();
  withAwayCard.events!.push({
    ...withAwayCard.events!.find((e) => e.coachId)!,
    teamId: seed.away.teamId,
    sequenceNo: 9,
    coachId: awayAssistant,
    staffRole: "assistant_coach",
    providerEventId: "ev-9",
  });
  await recordObservation(db, withAwayCard, f3.seen);
  await assert.rejects(mergeCoach(db, awayAssistant, homeCoach), /opposite sides/);

  // ... same-side staff appearances are not.
  const homeAssistant = coachId(2);
  await addCoach(db, homeAssistant, "Home assistant (duplicate of the head coach)");
  const f4 = await fixtureAt(22);
  const withHomeCard = f4.base();
  withHomeCard.events!.push({
    ...withHomeCard.events!.find((e) => e.coachId)!,
    sequenceNo: 9,
    coachId: homeAssistant,
    staffRole: "assistant_coach",
    providerEventId: "ev-9",
  });
  await recordObservation(db, withHomeCard, f4.seen);
  await mergeCoach(db, homeAssistant, homeCoach);
  await db.close();
});

test("ingestion refuses a merged id in every position and never treats it as unchanged", async () => {
  const { db, seed, fixtureAt } = await setup();
  const keep = seed.home.playerIds[10];
  const dup = playerId(5);
  await addPlayer(db, dup, "Duplicate");

  const f1 = await fixtureAt(1);
  const stale = () => swapPlayer(f1.base(), keep, dup);
  assert.equal((await recordObservation(db, stale(), f1.seen)).status, "recorded");
  await mergePlayer(db, dup, keep);

  // The identical payload resolved with the stale id is an error, not a no-op.
  await assert.rejects(recordObservation(db, stale(), "2026-10-03T09:00:00.000Z"), /players\.player_id .* is a merged player; record its surviving canonical id/);
  // The survivor is accepted: same football, new canonical ids, so one new
  // version (no hidden normalization, so the hash matches what is stored).
  const resolved = await recordObservation(db, f1.base(), "2026-10-03T09:00:00.000Z");
  assert.deepEqual([resolved.status, resolved.observation_version], ["recorded", 2]);
  assert.equal((await recordObservation(db, f1.base(), "2026-10-04T09:00:00.000Z")).status, "unchanged");

  const homeCoach = seed.home.coachId;
  const dupCoach = coachId(3);
  await addCoach(db, dupCoach, "Duplicate coach");
  await mergeCoach(db, dupCoach, homeCoach);

  const f2 = await fixtureAt(8);
  const before = await observationCount(db);
  const cases: Array<[string, (input: MatchLedgerObservationInput) => void]> = [
    ["players.player_id", (i) => swapPlayer(i, seed.home.playerIds[17], dup)],
    ["substitutions.player_off_id", (i) => { i.substitutions![0].playerOffId = dup; }],
    ["substitutions.player_on_id", (i) => { i.substitutions![0].playerOnId = dup; }],
    ["events.player_id", (i) => { i.events![0].playerId = dup; }],
    ["events.related_player_id", (i) => { i.events![0].relatedPlayerId = dup; }],
    ["teams.coach_id", (i) => swapHomeCoach(i, dupCoach)],
    ["events.coach_id", (i) => { i.events!.find((e) => e.coachId)!.coachId = dupCoach; }],
  ];
  for (const [position, mutate] of cases) {
    const input = f2.base();
    mutate(input);
    await assert.rejects(
      recordObservation(db, input, f2.seen),
      new RegExp(`${position.replace(".", "\\.")} .* is a merged (player|coach)`),
      position,
    );
  }
  assert.equal(await observationCount(db), before);

  // Tenures name surviving coaches too.
  await assert.rejects(
    db.query(
      `insert into public.team_coach_tenures
         (tenure_key, team_id, coach_id, starts_on_earliest, starts_on_latest, source_kind, ingest_version)
       values ('90000000-0000-4000-8000-0000000a0001', $1, $2, '2026-06-01', '2026-06-01', 'manual', 'test')`,
      [seed.home.teamId, dupCoach],
    ),
    /is merged into/,
  );
  await db.close();
});

test("provider mappings and aliases resolve to the surviving identity", async () => {
  const { db, seed, fixtureAt } = await setup();
  const keep = seed.home.playerIds[10];
  const dup = playerId(6);
  const other = playerId(7);
  await addPlayer(db, dup, "Yossi Cohen (duplicate)", "sm-dup-6");
  await addPlayer(db, other, "Yossi Cohen (another person)");
  const alias = (id: string, text: string, language: string) =>
    db.query("insert into public.player_aliases (player_id, alias, language_code, alias_kind) values ($1, $2, $3, 'transliteration')", [id, text, language]);
  await alias(dup, "יוסי כהן", "he");
  await alias(keep, "יוסי כהן", "he");
  await alias(dup, "Y. Kohen", "en");
  await alias(other, "Y. Kohen", "en");
  await alias(keep, "Yossi Cohen", "en");
  await alias(other, "Yossi Cohen", "en");
  const resolveAlias = async (text: string) =>
    resolveAliasCandidates(
      (await db.query<{ player_id: string; canonical_player_id: string }>("select * from public.player_alias_candidates($1)", [text])).rows.map(
        (row) => ({ entityId: row.player_id, canonicalEntityId: row.canonical_player_id }),
      ),
    );

  assert.deepEqual(await resolveAlias("יוסי כהן"), { status: "ambiguous", candidateIds: [dup, keep].sort() });
  await mergePlayer(db, dup, keep);
  // [dup, keep] collapse to keep; a merged id never hides a second person.
  assert.deepEqual(await resolveAlias("יוסי כהן"), { status: "unique", entityId: keep });
  assert.deepEqual(await resolveAlias("y. kohen"), { status: "ambiguous", candidateIds: [keep, other].sort() });
  assert.deepEqual(await resolveAlias("Yossi Cohen"), { status: "ambiguous", candidateIds: [keep, other].sort() });
  // Aliases of the merged row are kept, not deleted.
  assert.equal((await db.query("select 1 from public.player_aliases where player_id = $1", [dup])).rows.length, 2);

  // Provider P -> dup, dup -> keep resolves to keep; unverified never resolves.
  await db.query(
    "insert into public.provider_player_mappings (provider, provider_player_id, player_id, mapping_status) values ('sportmonks', 'sm-unverified', $1, 'unverified')",
    [other],
  );
  const resolved = await db.query<{ provider_player_id: string; mapped_player_id: string; canonical_player_id: string }>(
    "select * from public.resolve_provider_player_ids('sportmonks', array['sm-dup-6', 'sm-unverified', 'sm-unknown'])",
  );
  assert.deepEqual(resolved.rows, [{ provider_player_id: "sm-dup-6", mapped_player_id: dup, canonical_player_id: keep }]);
  // The pre-merge mapping stays editable; new or re-pointed mappings must
  // target a survivor.
  await db.query("update public.provider_player_mappings set mapping_confidence = 0.99, last_verified_at = now() where provider_player_id = 'sm-dup-6'");
  await assert.rejects(
    db.query("update public.provider_player_mappings set player_id = $1 where provider_player_id = 'sm-unverified'", [dup]),
    /active canonical player/,
  );

  // Coaches resolve the same way.
  const homeCoach = seed.home.coachId;
  const dupCoach = coachId(4);
  await addCoach(db, dupCoach, "Coach duplicate", "sm-coach-dup");
  await db.query("insert into public.coach_aliases (coach_id, alias, language_code, alias_kind) values ($1, 'המאמן', 'he', 'nickname'), ($2, 'המאמן', 'he', 'nickname')", [dupCoach, homeCoach]);
  await mergeCoach(db, dupCoach, homeCoach);
  const coachCandidates = await db.query<{ coach_id: string; canonical_coach_id: string }>("select * from public.coach_alias_candidates('המאמן')");
  assert.deepEqual(
    resolveAliasCandidates(coachCandidates.rows.map((row) => ({ entityId: row.coach_id, canonicalEntityId: row.canonical_coach_id }))),
    { status: "unique", entityId: homeCoach },
  );
  const coachResolved = await db.query("select canonical_coach_id from public.resolve_provider_coach_ids('sportmonks', array['sm-coach-dup'])");
  assert.deepEqual(coachResolved.rows, [{ canonical_coach_id: homeCoach }]);

  // Ingestion checks are merge-aware in both directions: the survivor may
  // carry its duplicate's provider id, and an unmapped id on a survivor whose
  // identity class already has an id for this provider is a contradiction.
  const orphan = playerId(8);
  const orphanDup = playerId(9);
  await addPlayer(db, orphan, "Survivor without its own mapping");
  await addPlayer(db, orphanDup, "Duplicate holding the mapping", "sm-orphan-dup");
  await mergePlayer(db, orphanDup, orphan);
  const fixture = await fixtureAt(1);
  const withOrphan = (providerPlayerId: string) => {
    const input = swapPlayer(fixture.base(), seed.home.playerIds[17], orphan);
    input.players!.find((p) => p.playerId === orphan)!.providerPlayerId = providerPlayerId;
    input.players!.find((p) => p.playerId === keep)!.providerPlayerId = "sm-dup-6";
    return input;
  };
  await assert.rejects(recordObservation(db, withOrphan("sm-unmapped"), fixture.seen), /canonical player is mapped to a different provider player id/);
  assert.equal((await recordObservation(db, withOrphan("sm-orphan-dup"), fixture.seen)).status, "recorded");
  await db.close();
});

test("team history and tenures expose observed and canonical coach after a coach merge", async () => {
  const { db, seed, fixtureAt } = await setup();
  const homeCoach = seed.home.coachId;
  const dupCoach = coachId(5);
  await addCoach(db, dupCoach, "Head coach (duplicate)");

  const f1 = await fixtureAt(1);
  await recordObservation(db, swapHomeCoach(f1.base(), dupCoach), f1.seen);
  const f2 = await fixtureAt(8);
  await recordObservation(db, f2.base(), f2.seen);

  const tenureKey = "90000000-0000-4000-8000-0000000a0002";
  const insertTenure = (coach: string, endsOn: string | null) =>
    db.query<{ tenure_version: number }>(
      `insert into public.team_coach_tenures
         (tenure_key, team_id, coach_id, starts_on_earliest, starts_on_latest, ends_on_earliest, ends_on_latest, source_kind, ingest_version)
       values ($1, $2, $3, '2026-07-01', '2026-07-01', $4, $4, 'official_club', 'test') returning tenure_version`,
      [tenureKey, seed.home.teamId, coach, endsOn],
    );
  await setClock(db, "2026-09-01T00:00:00.000Z");
  await insertTenure(dupCoach, null);

  const coachesOf = (rows: ProviderTeamMatchAsOfRow[]) => rows.map((r) => [r.fixture_id, r.observed_coach_id, r.canonical_coach_id]);
  assert.deepEqual(coachesOf(await teamHistory(db, seed.home.teamId, NOV_1)), [
    [f2.fixture.fixtureId, homeCoach, homeCoach],
    [f1.fixture.fixtureId, dupCoach, dupCoach],
  ]);

  await mergeCoach(db, dupCoach, homeCoach);
  assert.deepEqual(coachesOf(await teamHistory(db, seed.home.teamId, NOV_1)), [
    [f2.fixture.fixtureId, homeCoach, homeCoach],
    [f1.fixture.fixtureId, dupCoach, homeCoach],
  ]);
  // The opponent's history is unaffected; the stored row is unchanged.
  assert.ok((await teamHistory(db, seed.away.teamId, NOV_1)).every((r) => r.canonical_coach_id === seed.away.coachId));
  const stored = await db.query("select coach_id from public.match_ledger_team_records where fixture_id = $1 and side = 'home'", [f1.fixture.fixtureId]);
  assert.deepEqual(stored.rows, [{ coach_id: dupCoach }]);

  // Tenures: raw assertion plus canonical id; a later version of a tenure
  // first asserted for the duplicate names the survivor.
  const tenures = async (cutoff: string) =>
    (await db.query<{ coach_id: string; canonical_coach_id: string; tenure_version: number }>(
      "select coach_id, canonical_coach_id, tenure_version from public.team_coach_tenures_as_of($1, $2)",
      [seed.home.teamId, cutoff],
    )).rows;
  assert.deepEqual(await tenures(NOV_1), [{ coach_id: dupCoach, canonical_coach_id: homeCoach, tenure_version: 1 }]);
  await setClock(db, "2026-11-03T00:00:00.000Z");
  await assert.rejects(insertTenure(dupCoach, "2026-10-30"), /is merged into/);
  assert.equal((await insertTenure(homeCoach, "2026-10-30")).rows[0].tenure_version, 2);
  assert.deepEqual(await tenures("2026-11-04T00:00:00.000Z"), [{ coach_id: homeCoach, canonical_coach_id: homeCoach, tenure_version: 2 }]);
  assert.deepEqual(await tenures(NOV_1), [{ coach_id: dupCoach, canonical_coach_id: homeCoach, tenure_version: 1 }]);

  // One coach cannot lead both teams (database and validator agree).
  const f3 = await fixtureAt(15);
  const sameCoach = f3.base();
  sameCoach.teams[1].coachId = homeCoach;
  assert.ok(validateMatchLedgerObservation(sameCoach).includes("the same coach cannot lead both teams"));
  await assert.rejects(recordObservation(db, sameCoach, f3.seen), /same coach cannot lead both teams/);
  await db.close();
});

async function advisoryLockModes(db: PGlite, key: string): Promise<string[]> {
  const result = await db.query<{ mode: string }>(
    `select mode from pg_locks
     where locktype = 'advisory' and objsubid = 1
       and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
    [key],
  );
  return result.rows.map((row) => row.mode).sort();
}

test("player/coach mapping writes serialize with ledger writes; fixture-mapping drift is detected, not prevented", async () => {
  const { db, seed, fixtureAt } = await setup();
  const f1 = await fixtureAt(1);
  const scorer = seed.home.playerIds[3];
  const scorerProviderId = (
    await db.query<{ id: string }>("select provider_player_id as id from public.provider_player_mappings where player_id = $1", [scorer])
  ).rows[0].id;
  const coachProviderId = (
    await db.query<{ id: string }>("select provider_coach_id as id from public.provider_coach_mappings where coach_id = $1", [seed.home.coachId])
  ).rows[0].id;
  const input = f1.base();
  input.players!.find((p) => p.playerId === scorer)!.providerPlayerId = scorerProviderId;
  input.teams[0].providerCoachId = coachProviderId;

  // Ledger writes hold the identity locks shared until commit ...
  await db.exec("begin");
  await recordObservation(db, input, f1.seen);
  assert.deepEqual(await advisoryLockModes(db, "kapiloto_identity:players"), ["ShareLock"]);
  assert.deepEqual(await advisoryLockModes(db, "kapiloto_identity:coaches"), ["ShareLock"]);
  await db.exec("commit");
  // ... mapping writes and merges hold them exclusively.
  await db.exec("begin");
  await db.query(
    "insert into public.provider_player_mappings (provider, provider_player_id, player_id) values ('api_football', 'af-1', $1)",
    [seed.away.playerIds[0]],
  );
  assert.deepEqual(await advisoryLockModes(db, "kapiloto_identity:players"), ["ExclusiveLock"]);
  await db.exec("rollback");
  await addPlayer(db, playerId(11), "Unlisted A");
  await addPlayer(db, playerId(12), "Unlisted B");
  await db.exec("begin");
  await mergePlayer(db, playerId(11), playerId(12));
  assert.deepEqual(await advisoryLockModes(db, "kapiloto_identity:players"), ["ExclusiveLock"]);
  await db.exec("rollback");
  await db.exec("begin isolation level repeatable read");
  await assert.rejects(
    db.query("insert into public.provider_coach_mappings (provider, provider_coach_id, coach_id) values ('api_football', 'af-c', $1)", [seed.away.coachId]),
    /requires READ COMMITTED/,
  );
  await db.exec("rollback");

  // A mapping corrected after ingest is allowed (corrections are the point)
  // and surfaces as a reconciliation conflict; the ledger is not rewritten.
  const realOwner = playerId(10);
  await addPlayer(db, realOwner, "The provider id's real owner");
  await db.query("update public.provider_player_mappings set player_id = $1 where provider_player_id = $2", [realOwner, scorerProviderId]);
  const realCoach = coachId(6);
  await addCoach(db, realCoach, "The provider coach id's real owner");
  await db.query("update public.provider_coach_mappings set coach_id = $1 where provider_coach_id = $2", [realCoach, coachProviderId]);

  // V3's provider_fixture_mappings carries no V4 lock or ledger trigger; its
  // only V4 trigger is the D-057 guard on UPDATE, so a contradicting fixture
  // mapping can still be inserted.
  const v4Triggers = await db.query<{ tgname: string }>(
    `select t.tgname from pg_trigger t join pg_proc p on p.oid = t.tgfoid
     where t.tgrelid = 'public.provider_fixture_mappings'::regclass and not t.tgisinternal
       and (p.proname like '%ledger%' or p.proname like '%identity%')`,
  );
  assert.deepEqual(v4Triggers.rows.map((row) => row.tgname), ["provider_fixture_mappings_identity_guard"]);
  const f2 = await fixtureAt(8);
  await db.query(
    "insert into public.provider_fixture_mappings (fixture_id, provider, provider_fixture_id) values ($1, 'sportmonks', $2)",
    [f2.fixture.fixtureId, f1.fixture.providerFixtureId],
  );

  const conflicts = async () =>
    (await db.query<MatchLedgerMappingConflictRow>("select * from public.match_ledger_mapping_conflicts('sportmonks')")).rows.map(
      (row) => [row.conflict_kind, row.provider_entity_id, row.stored_canonical_id, row.mapped_canonical_id],
    );
  assert.deepEqual(await conflicts(), [
    ["coach", coachProviderId, seed.home.coachId, realCoach],
    ["fixture", f1.fixture.providerFixtureId, f1.fixture.fixtureId, f2.fixture.fixtureId],
    ["player", scorerProviderId, scorer, realOwner],
  ]);
  const ledgerRow = await db.query("select player_id from public.match_ledger_players where provider_player_id = $1", [scorerProviderId]);
  assert.deepEqual(ledgerRow.rows, [{ player_id: scorer }]);

  // Repair: a new version of F1 now fails the point-in-time fixture check, a
  // withdrawal is still possible, and the conflicts disappear with it.
  const correction = f1.base();
  correction.homeGoals90 = 3;
  await assert.rejects(recordObservation(db, correction, "2026-10-03T09:00:00.000Z"), /mapped to a different canonical fixture/);
  await setClock(db, "2026-10-03T09:00:00.000Z");
  await db.query("select public.match_ledger_record_observation($1::jsonb)", [
    JSON.stringify(
      buildMatchLedgerWithdrawalPayload({
        fixtureId: f1.fixture.fixtureId,
        provider: "sportmonks",
        providerFixtureId: f1.fixture.providerFixtureId,
        captureMode: "manual_import",
        ingestVersion: "test",
        retrievedAt: "2026-10-03T09:00:00.000Z",
        withdrawalReason: "provider fixture id belongs to another fixture",
      }),
    ),
  ]);
  assert.deepEqual(await conflicts(), []);
  await db.close();
});
