import assert from "node:assert/strict";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { buildProviderMatchObservationPayload } from "./provider-ingest";
import { setClock } from "./test-support/ledger-fixtures";
import { advisoryLockModes, createInspectableLedgerDatabase, heldRowLocks, withNestedPlans, type NestedPlan } from "./test-support/lock-inspection";
import { attestedWorld, canonicalFixtureFor, mapProviderFixture, seedAttestedIdentities, teamAttestation, type AttestedWorld } from "./test-support/attestation-fixtures";

/**
 * Lock modes and acquisition order of the V2 ingest and the attest RPC
 * (D-058), from heap tuple lock bits, pg_locks and auto_explain nested plans.
 * PGlite runs a single backend: these tests prove WHICH locks are held and in
 * WHICH order they are taken, not that a second session actually waits. The
 * blocking itself rests on PostgreSQL's lock conflict tables (an exclusive
 * advisory lock conflicts with a shared one; FOR UPDATE with FOR SHARE).
 */

const KICKOFF = "2026-08-15T18:00:00.000Z";
const CAPTURED = "2026-10-30T08:59:00.000Z";
const SEEN = "2026-10-30T09:00:00.000Z";
const V2 = "select public.match_ledger_ingest_provider_fixture_v2($1::jsonb) as r";
const PROVIDER_IDENTITY_KEY = "kapiloto_v4_provider_identity:sportmonks";

const world = (db: PGlite) => attestedWorld(db, { kickoffAt: KICKOFF, capturedAt: CAPTURED });
const payload = (w: AttestedWorld) => JSON.stringify(buildProviderMatchObservationPayload(w.observation()));

function lockSequence(plans: NestedPlan[]): string[] {
  const rules: Array<[string, (p: NestedPlan) => boolean]> = [
    ["provider_fixture_advisory", (p) => p.queryText.includes("'kapiloto_match_ledger_provider_fixture:' || v.provider")],
    ["provider_identity_shared", (p) => p.queryText.includes("pg_advisory_xact_lock_shared(hashtextextended('kapiloto_v4_provider_identity:'")],
    ["provider_identity_exclusive", (p) => /pg_advisory_xact_lock\(hashtextextended\('kapiloto_v4_provider_identity:'/.test(p.queryText)],
    ["competition_row_share", (p) => p.queryText.includes("from public.provider_competition_mappings m") && p.plan.startsWith("LockRows")],
    ["competition_projection_share", (p) => p.queryText.includes("from private.provider_competition_identity_attestations a") && p.plan.startsWith("LockRows")],
    ["team_rows_share", (p) => p.queryText.includes("from public.provider_team_mappings m") && p.plan.startsWith("LockRows")],
    ["team_projection_rows", (p) => p.queryText.includes("from private.provider_team_identity_attestations a") && p.plan.startsWith("LockRows")],
    ["fixture_mapping_row_share", (p) => /from public\.provider_fixture_mappings m\s+where m\.provider = v\.provider and m\.provider_fixture_id/.test(p.queryText) && p.plan.startsWith("LockRows")],
    ["team_pair_advisory", (p) => p.queryText.includes("'kapiloto_canonical_fixture_pair:'")],
    ["candidate_mapping_rows_share", (p) => p.queryText.includes("join public.fixtures f on f.id = m.fixture_id") && p.plan.startsWith("LockRows")],
    ["fixture_row_share", (p) => /from public\.fixtures f where f\.id = v_(map_fixture|candidate) for share/.test(p.queryText) && p.plan.startsWith("LockRows")],
    ["ledger_fixture_advisory", (p) => p.queryText.includes("'kapiloto_match_ledger_fixture:'")],
    ["players_identity_advisory", (p) => p.queryText.includes("'kapiloto_identity:'")],
  ];
  return rules
    .map(([label, match]) => [label, plans.findIndex(match)] as const)
    .filter(([, index]) => index >= 0)
    .sort((a, b) => a[1] - b[1])
    .map(([label]) => label);
}

const PREFIX = [
  "provider_fixture_advisory",
  "provider_identity_shared",
  "competition_row_share",
  "competition_projection_share",
  "team_rows_share",
  "team_projection_rows",
  "fixture_mapping_row_share",
  "team_pair_advisory",
  "candidate_mapping_rows_share",
];

test("V2 lock order on every fixture path: provider fixture, shared provider identity, mapping then projection rows, pair lock on BOTH paths, selected fixture row", async () => {
  const db = await createInspectableLedgerDatabase();
  const sequence = async (w: AttestedWorld) => {
    await setClock(db, SEEN);
    await db.exec("begin");
    const { rows, plans } = await withNestedPlans<{ r: { status: string; fixture_resolution: string } }>(db, V2, [payload(w)]);
    await db.exec("rollback");
    return { result: rows[0].r, order: lockSequence(plans) };
  };

  const minted = await sequence(await world(db));
  assert.deepEqual([minted.result.status, minted.result.fixture_resolution], ["recorded", "minted"]);
  assert.deepEqual(minted.order, [...PREFIX, "ledger_fixture_advisory", "players_identity_advisory"]);

  const mapped = await world(db);
  await mapProviderFixture(db, await canonicalFixtureFor(db, mapped.seed, KICKOFF), mapped.providerFixtureId);
  const existing = await sequence(mapped);
  assert.deepEqual([existing.result.status, existing.result.fixture_resolution], ["recorded", "existing_mapping"]);
  // Unlike A2-A, the existing-mapping path also takes the pair lock and classifies.
  assert.deepEqual(existing.order, [...PREFIX, "fixture_row_share", "ledger_fixture_advisory", "players_identity_advisory"]);

  const attach = await world(db);
  await canonicalFixtureFor(db, attach.seed, KICKOFF);
  const attached = await sequence(attach);
  assert.deepEqual([attached.result.status, attached.result.fixture_resolution], ["recorded", "attached"]);
  assert.deepEqual(attached.order, [...PREFIX, "fixture_row_share", "ledger_fixture_advisory", "players_identity_advisory"]);
  // The attest exclusive lock is never taken by ingest.
  assert.ok(!minted.order.includes("provider_identity_exclusive"));
  await db.close();
});

test("the V2 ingest transaction holds the shared provider lock and FOR SHARE on mappings, projections and the selected fixture row until commit", async () => {
  const db = await createInspectableLedgerDatabase();
  const w = await world(db);
  const fixture = await canonicalFixtureFor(db, w.seed, KICKOFF);
  await mapProviderFixture(db, fixture, w.providerFixtureId);
  await setClock(db, SEEN);

  await db.exec("begin");
  const result = (await db.query<{ r: { status: string } }>(V2, [payload(w)])).rows[0].r;
  assert.equal(result.status, "recorded");
  assert.deepEqual(await advisoryLockModes(db, PROVIDER_IDENTITY_KEY), ["ShareLock"]);
  const pairKey = `kapiloto_canonical_fixture_pair:${[w.seed.homeTeamId, w.seed.awayTeamId].sort().join(":")}`;
  assert.deepEqual(await advisoryLockModes(db, pairKey), ["ExclusiveLock"]);
  const teams = [w.ids.homeTeamId, w.ids.awayTeamId];
  assert.deepEqual(await heldRowLocks(db, "provider_competition_mappings", "provider_competition_id = $1", [w.ids.leagueId]), ["for share"]);
  assert.deepEqual(await heldRowLocks(db, "private.provider_competition_identity_attestations", "provider_competition_id = $1", [w.ids.leagueId]), ["for share"]);
  assert.deepEqual(await heldRowLocks(db, "provider_team_mappings", "provider_team_id = any($1::text[])", [teams]), ["for share", "for share"]);
  assert.deepEqual(await heldRowLocks(db, "private.provider_team_identity_attestations", "provider_team_id = any($1::text[])", [teams]), ["for share", "for share"]);
  assert.deepEqual(await heldRowLocks(db, "provider_fixture_mappings", "provider_fixture_id = $1", [w.providerFixtureId]), ["for share"]);
  assert.deepEqual(await heldRowLocks(db, "fixtures", "id = $1", [fixture]), ["for share"]);
  await db.exec("commit");
  assert.deepEqual(await advisoryLockModes(db, PROVIDER_IDENTITY_KEY), []);
  assert.deepEqual(await heldRowLocks(db, "fixtures", "id = $1", [fixture]), ["none"]);
  await db.close();
});

test("attest takes the provider identity lock exclusive FIRST, then the mapping row FOR SHARE, then the projection rows FOR UPDATE", async () => {
  const db = await createInspectableLedgerDatabase();
  const ids = { leagueId: "4999", homeTeamId: "49998", awayTeamId: "49999" };
  const seed = await seedAttestedIdentities(db, ids, { attest: false });
  await db.exec("begin");
  const { plans } = await withNestedPlans(db, "select public.provider_identity_attest_team($1::jsonb)", [JSON.stringify(teamAttestation(ids.homeTeamId, seed.homeTeamId))]);
  const order = lockSequence(plans);
  assert.deepEqual(order.slice(0, 3), ["provider_identity_exclusive", "team_rows_share", "team_projection_rows"]);
  const projectionLock = plans.find((p) => p.queryText.includes("from private.provider_team_identity_attestations a") && p.plan.startsWith("LockRows"))!;
  assert.match(projectionLock.queryText, /for update$/);
  assert.deepEqual(await advisoryLockModes(db, PROVIDER_IDENTITY_KEY), ["ExclusiveLock"]);
  assert.deepEqual(await heldRowLocks(db, "provider_team_mappings", "provider_team_id = $1", [ids.homeTeamId]), ["for share"]);
  await db.exec("rollback");
  // Attest never takes the ingest-only locks (provider fixture, team pair, ledger fixture, players).
  for (const label of ["provider_fixture_advisory", "team_pair_advisory", "ledger_fixture_advisory", "players_identity_advisory"]) {
    assert.ok(!order.includes(label), label);
  }
  await db.close();
});
