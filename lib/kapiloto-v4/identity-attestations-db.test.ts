import assert from "node:assert/strict";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { attestTeam as attestTeamTs, loadProviderIdentityAttestationConflicts, revokeTeam as revokeTeamTs } from "./identity-attestations";
import { createLedgerDatabase, setClock } from "./test-support/ledger-fixtures";
import {
  attestCompetition,
  attestTeam,
  callIdentityRpc,
  competitionAttestation,
  operatorSql,
  revokeCompetition,
  revokeTeam,
  seedAttestedIdentities,
  syntheticEvidence,
  teamAttestation,
} from "./test-support/attestation-fixtures";
import { pgliteRpc, seedIngestIdentities } from "./test-support/provider-ingest-fixtures";

/** V4 provider identity attestation state, RPCs and guards (D-058), on SYNTHETIC identities. */

let n = 0;
const ids = () => {
  n += 1;
  return { leagueId: String(4_100 + n), homeTeamId: String(41_000 + n * 2), awayTeamId: String(41_001 + n * 2) };
};

type EventRow = {
  event_kind: string;
  attestation_version: number;
  attestation_generation_id: string;
  team_id: string;
  evidence_sha256: string;
  mapping_status_snapshot: string | null;
  mapping_confidence_snapshot: string | null;
  provider_name_snapshot: string | null;
  revoke_reason: string | null;
  actor_current_user: string;
  recorded_at: string;
};

const teamEvents = async (db: PGlite, providerTeamId: string) =>
  (await db.query<EventRow>(
    "select * from private.provider_team_identity_attestation_events where provider = 'sportmonks' and provider_team_id = $1 order by attestation_version",
    [providerTeamId],
  )).rows;

const teamProjection = async (db: PGlite, providerTeamId: string) =>
  (await db.query<{ team_id: string; attestation_generation_id: string; attestation_version: number; latest_event_id: string; first_attested_at: string; attested_at: string; evidence_sha256: string; attestation_basis: string }>(
    "select * from private.provider_team_identity_attestations where provider = 'sportmonks' and provider_team_id = $1",
    [providerTeamId],
  )).rows[0];

async function teamRow(db: PGlite, name: string): Promise<string> {
  return (await db.query<{ id: string }>("insert into public.teams (canonical_name) values ($1) returning id", [name])).rows[0].id;
}

test("attest requires an existing, agreeing manual_override mapping; V3 confirmed rows (even at confidence 1) are refused", async () => {
  const db = await createLedgerDatabase();
  const i = ids();
  const seed = await seedIngestIdentities(db, { ...i, teamMappingStatus: "confirmed" });

  await assert.rejects(attestTeam(db, "no-such-team", seed.homeTeamId), /no sportmonks mapping exists for provider team no-such-team/);
  // confirmed at confidence 1 is not enough: Stage 1 never grandfathers it.
  await assert.rejects(attestTeam(db, i.homeTeamId, seed.homeTeamId), /mapped as confirmed, not manual_override/);
  await operatorSql(db, "update public.provider_team_mappings set mapping_status = 'unverified' where provider = 'sportmonks' and provider_team_id = $1", [i.awayTeamId]);
  await assert.rejects(attestTeam(db, i.awayTeamId, seed.awayTeamId), /mapped as unverified, not manual_override/);

  await operatorSql(db, "update public.provider_team_mappings set mapping_status = 'manual_override' where provider = 'sportmonks' and provider_team_id = $1", [i.homeTeamId]);
  await assert.rejects(attestTeam(db, i.homeTeamId, seed.awayTeamId), /is mapped to canonical team .*, not /);
  // Competition: the same rules.
  await assert.rejects(attestCompetition(db, "no-such-league", seed.competitionId), /no sportmonks mapping exists for provider competition/);
  assert.equal((await db.query("select 1 from private.provider_team_identity_attestation_events")).rows.length, 0);

  const attested = await attestTeam(db, i.homeTeamId, seed.homeTeamId);
  assert.equal(attested.status, "attested");
  await db.close();
});

test("Stage 1 accepts Sportmonks only, exact provider refs, a closed basis and the evidence contract", async () => {
  const db = await createLedgerDatabase();
  const i = ids();
  const seed = await seedAttestedIdentities(db, i, { attest: false });
  const attempt = (payload: unknown) => callIdentityRpc(db, "provider_identity_attest_team", payload);

  await assert.rejects(attempt(teamAttestation(i.homeTeamId, seed.homeTeamId, { provider: "api_football" })), /enabled for sportmonks only/);
  await assert.rejects(attempt({ ...teamAttestation(i.homeTeamId, seed.homeTeamId), provider_team_id: ` ${i.homeTeamId}` }), /invalid provider team id/);
  await assert.rejects(attempt({ ...teamAttestation(i.homeTeamId, seed.homeTeamId), attestation_basis: "name_match" }), /unknown attestation basis/);
  await assert.rejects(attempt({ ...teamAttestation(i.homeTeamId, seed.homeTeamId), extra: true }), /unknown key|extra/);
  await assert.rejects(attempt({ ...teamAttestation(i.homeTeamId, seed.homeTeamId), attested_by: "  " }), /attested_by must be a non-empty/);

  const bad: Array<[unknown, RegExp]> = [
    [[], /evidence must be a JSON object/],
    [syntheticEvidence({ contract_version: "v0" }), /contract_version/],
    [syntheticEvidence({ sources: [] }), /sources must be a non-empty array/],
    [syntheticEvidence({ sources: ["  "] }), /sources must be non-empty strings or objects/],
    [syntheticEvidence({ reviewed_by: "" }), /reviewed_by/],
    [syntheticEvidence({ duplicate_audit_sha256: "A".repeat(64) }), /duplicate_audit_sha256/],
    [syntheticEvidence({ note: "x".repeat(66_000) }), /exceeds 64 KiB/],
  ];
  for (const [evidence, pattern] of bad) {
    await assert.rejects(attempt(teamAttestation(i.homeTeamId, seed.homeTeamId, { evidence })), pattern);
  }
  // Extra source-specific evidence keys are allowed.
  const ok = await attempt(teamAttestation(i.homeTeamId, seed.homeTeamId, { evidence: syntheticEvidence({ crosscheck: { provider: "synthetic" } }) }));
  assert.equal(ok.status, "attested");
  await db.close();
});

test("first attest opens a generation; identical refresh is a no-op; changed evidence refreshes within the generation", async () => {
  const db = await createLedgerDatabase();
  const i = ids();
  const seed = await seedAttestedIdentities(db, i, { attest: false });
  await setClock(db, "2026-10-31T10:00:00.000Z");
  const first = await attestTeam(db, i.homeTeamId, seed.homeTeamId);
  assert.deepEqual([first.status, first.attestation_version], ["attested", 1]);
  let projection = await teamProjection(db, i.homeTeamId);
  assert.equal(projection.attestation_generation_id, first.attestation_generation_id);
  assert.equal(projection.latest_event_id, first.event_id);
  assert.equal(new Date(projection.first_attested_at).toISOString(), "2026-10-31T10:00:00.000Z");
  const [attestEvent] = await teamEvents(db, i.homeTeamId);
  assert.deepEqual(
    [attestEvent.event_kind, attestEvent.mapping_status_snapshot, Number(attestEvent.mapping_confidence_snapshot), attestEvent.actor_current_user.length > 0],
    ["attest", "manual_override", 1, true],
  );

  // Same basis + same evidence (key order is irrelevant): unchanged, no event.
  await setClock(db, "2026-10-31T11:00:00.000Z");
  const reordered = { duplicate_audit_sha256: "a".repeat(64), reviewed_by: "synthetic reviewer", sources: ["synthetic:offline-test-fixture"], contract_version: "kapiloto-provider-identity-attestation-evidence-v1" };
  const same = await attestTeam(db, i.homeTeamId, seed.homeTeamId, { evidence: reordered });
  assert.deepEqual([same.status, same.attestation_version, same.event_id], ["unchanged", 1, first.event_id]);
  assert.equal((await teamEvents(db, i.homeTeamId)).length, 1);

  // Changed evidence: refresh in the SAME generation, version 2, first_attested_at kept.
  const refreshed = await attestTeam(db, i.homeTeamId, seed.homeTeamId, { evidence: syntheticEvidence({ sources: ["synthetic:second-source"] }) });
  assert.deepEqual([refreshed.status, refreshed.attestation_version, refreshed.attestation_generation_id], ["refreshed", 2, first.attestation_generation_id]);
  projection = await teamProjection(db, i.homeTeamId);
  assert.deepEqual([projection.attestation_version, projection.latest_event_id], [2, refreshed.event_id]);
  assert.equal(new Date(projection.first_attested_at).toISOString(), "2026-10-31T10:00:00.000Z");
  assert.equal(new Date(projection.attested_at).toISOString(), "2026-10-31T11:00:00.000Z");
  // A basis change alone is also a refresh.
  const basis = await attestTeam(db, i.homeTeamId, seed.homeTeamId, { evidence: syntheticEvidence({ sources: ["synthetic:second-source"] }), basis: "multi_source_verified" });
  assert.deepEqual([basis.status, basis.attestation_version], ["refreshed", 3]);
  assert.deepEqual((await teamEvents(db, i.homeTeamId)).map((e) => e.event_kind), ["attest", "evidence_refresh", "evidence_refresh"]);
  await db.close();
});

test("injectivity: a provider ref cannot re-point while active and a canonical entity cannot take a second provider ref", async () => {
  const db = await createLedgerDatabase();
  const i = ids();
  const seed = await seedAttestedIdentities(db, i);
  const other = await teamRow(db, "Synthetic Other");

  // Mapping corrected under the operator path, but the active attestation still names the old team.
  await operatorSql(db, "update public.provider_team_mappings set team_id = $2 where provider = 'sportmonks' and provider_team_id = $1", [i.homeTeamId, other]);
  await assert.rejects(attestTeam(db, i.homeTeamId, other), /actively attested to canonical team .*; revoke it first/);
  assert.equal((await teamProjection(db, i.homeTeamId)).team_id, seed.homeTeamId);

  // A second provider id for an already attested canonical team.
  await db.query("insert into public.provider_team_mappings (provider, provider_team_id, team_id, mapping_status) values ('sportmonks', 'shadow-1', $1, 'manual_override')", [seed.awayTeamId]);
  await assert.rejects(attestTeam(db, "shadow-1", seed.awayTeamId), /already actively attested to provider team/);

  // Competitions: the same two directions.
  await db.query("insert into public.provider_competition_mappings (provider, provider_competition_id, competition_id, mapping_status) values ('sportmonks', 'shadow-league', $1, 'manual_override')", [seed.competitionId]);
  await assert.rejects(attestCompetition(db, "shadow-league", seed.competitionId), /already actively attested to provider competition/);

  // The constraints themselves (the last line of defense under any schedule).
  const constraints = (await db.query<{ def: string }>(
    `select pg_get_constraintdef(oid) as def from pg_constraint
     where conrelid in ('private.provider_team_identity_attestations'::regclass, 'private.provider_competition_identity_attestations'::regclass)
       and contype in ('p', 'u') order by 1`,
  )).rows.map((r) => r.def);
  for (const def of ["PRIMARY KEY (provider, provider_team_id)", "UNIQUE (provider, team_id)", "PRIMARY KEY (provider, provider_competition_id)", "UNIQUE (provider, competition_id)"]) {
    assert.ok(constraints.includes(def), def);
  }
  await db.close();
});

test("revoke needs the expected canonical id and a reason; it closes the generation and re-attest opens a new one with continued versions", async () => {
  const db = await createLedgerDatabase();
  const i = ids();
  const seed = await seedAttestedIdentities(db, i);
  const g1 = (await teamProjection(db, i.homeTeamId)).attestation_generation_id;

  await assert.rejects(revokeTeam(db, i.homeTeamId, seed.awayTeamId), /not the expected/);
  await assert.rejects(revokeTeam(db, i.homeTeamId, seed.homeTeamId, "   "), /non-empty reason/);
  await assert.rejects(
    callIdentityRpc(db, "provider_identity_revoke_team", { provider: "sportmonks", provider_team_id: i.homeTeamId, expected_team_id: seed.homeTeamId, revoked_by: "x" }),
    /needs provider, provider_team_id, expected_team_id, reason and revoked_by/,
  );
  await assert.rejects(revokeTeam(db, "never-attested", seed.homeTeamId), /has no active attestation/);

  const revoked = await revokeTeam(db, i.homeTeamId, seed.homeTeamId, "synthetic doubt");
  assert.deepEqual([revoked.status, revoked.attestation_generation_id, revoked.attestation_version], ["revoked", g1, 2]);
  assert.equal(await teamProjection(db, i.homeTeamId), undefined);
  const afterRevoke = await teamEvents(db, i.homeTeamId);
  assert.deepEqual(afterRevoke.map((e) => [e.event_kind, e.attestation_generation_id, e.team_id, e.revoke_reason]), [
    ["attest", g1, seed.homeTeamId, null],
    ["revoke", g1, seed.homeTeamId, "synthetic doubt"],
  ]);
  await assert.rejects(revokeTeam(db, i.homeTeamId, seed.homeTeamId), /has no active attestation/);

  // Re-attesting the SAME canonical team starts a new generation; versions continue.
  const again = await attestTeam(db, i.homeTeamId, seed.homeTeamId);
  assert.equal(again.status, "attested");
  assert.notEqual(again.attestation_generation_id, g1);
  assert.equal(again.attestation_version, 3);
  assert.deepEqual((await teamEvents(db, i.homeTeamId)).map((e) => e.attestation_version), [1, 2, 3]);

  // Revoke still works after the V3 mapping row was deleted (the snapshot is null).
  await db.query("delete from public.provider_team_mappings where provider = 'sportmonks' and provider_team_id = $1", [i.awayTeamId]);
  const orphanRevoke = await revokeTeam(db, i.awayTeamId, seed.awayTeamId, "mapping removed first");
  assert.equal(orphanRevoke.status, "revoked");
  const orphanEvents = await teamEvents(db, i.awayTeamId);
  assert.deepEqual(orphanEvents.map((e) => [e.event_kind, e.mapping_status_snapshot]), [["attest", "manual_override"], ["revoke", null]]);

  // Competition revoke/re-attest behaves the same.
  const cg1 = (await db.query<{ g: string }>("select attestation_generation_id as g from private.provider_competition_identity_attestations where provider_competition_id = $1", [i.leagueId])).rows[0].g;
  await assert.rejects(revokeCompetition(db, i.leagueId, seed.homeTeamId), /not the expected/);
  assert.equal((await revokeCompetition(db, i.leagueId, seed.competitionId)).attestation_generation_id, cg1);
  const cAgain = await attestCompetition(db, i.leagueId, seed.competitionId);
  assert.notEqual(cAgain.attestation_generation_id, cg1);
  assert.equal(cAgain.attestation_version, 3);
  await db.close();
});

test("re-pointing is revoke -> mapping correction -> re-attest, each in its own transaction", async () => {
  const db = await createLedgerDatabase();
  const i = ids();
  const seed = await seedAttestedIdentities(db, i);
  const real = await teamRow(db, "Synthetic Real");

  await revokeTeam(db, i.homeTeamId, seed.homeTeamId, "attested to a duplicate canonical row");
  await operatorSql(
    db,
    "update public.provider_team_mappings set team_id = $2 where provider = 'sportmonks' and provider_team_id = $1 and team_id = $3",
    [i.homeTeamId, real, seed.homeTeamId],
  );
  const reattested = await attestTeam(db, i.homeTeamId, real);
  assert.equal(reattested.status, "attested");
  assert.equal((await teamProjection(db, i.homeTeamId)).team_id, real);

  // A correction and an attest in ONE transaction is refused (first-write rule).
  const j = ids();
  const seed2 = await seedAttestedIdentities(db, j, { attest: false });
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query("select set_config('kapiloto.identity_operator', 'on', true)");
      await tx.query("update public.provider_team_mappings set provider_name = 'x' where provider = 'sportmonks' and provider_team_id = $1", [j.homeTeamId]);
      await tx.query("select public.provider_identity_attest_team($1::jsonb)", [JSON.stringify(teamAttestation(j.homeTeamId, seed2.homeTeamId))]);
    }),
    /must be the first write of its transaction/,
  );
  await db.close();
});

test("first-write rule: refused after a write or a row lock, and for a second identity in the same transaction; plain reads are fine", async () => {
  const db = await createLedgerDatabase();
  const i = ids();
  const seed = await seedAttestedIdentities(db, i, { attest: false });
  const attestSql = "select public.provider_identity_attest_team($1::jsonb)";

  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query("select 1 from public.provider_team_mappings where provider_team_id = $1 for share", [i.homeTeamId]);
      await tx.query(attestSql, [JSON.stringify(teamAttestation(i.homeTeamId, seed.homeTeamId))]);
    }),
    /first write of its transaction/,
  );
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query(attestSql, [JSON.stringify(teamAttestation(i.homeTeamId, seed.homeTeamId))]);
      await tx.query(attestSql, [JSON.stringify(teamAttestation(i.awayTeamId, seed.awayTeamId))]);
    }),
    /first write of its transaction/,
  );
  // Nothing from the refused transactions survived.
  assert.equal((await db.query("select 1 from private.provider_team_identity_attestation_events")).rows.length, 0);

  await db.transaction(async (tx) => {
    await tx.query("select * from public.provider_team_mappings where provider_team_id = $1", [i.homeTeamId]);
    await tx.query(attestSql, [JSON.stringify(teamAttestation(i.homeTeamId, seed.homeTeamId))]);
  });
  assert.equal((await teamEvents(db, i.homeTeamId)).length, 1);
  await db.close();
});

test("attest/revoke/V2 ingest declare a function-level 5s lock_timeout that does not leak into the caller's transaction", async () => {
  const db = await createLedgerDatabase();
  const config = await db.query<{ fn: string; proconfig: string[] }>(
    `select p.oid::regprocedure::text as fn, p.proconfig from pg_proc p
     where p.oid in ('public.provider_identity_attest_team(jsonb)'::regprocedure, 'public.provider_identity_revoke_team(jsonb)'::regprocedure,
                     'public.provider_identity_attest_competition(jsonb)'::regprocedure, 'public.provider_identity_revoke_competition(jsonb)'::regprocedure,
                     'public.match_ledger_ingest_provider_fixture_v2(jsonb)'::regprocedure)`,
  );
  assert.equal(config.rows.length, 5);
  for (const row of config.rows) {
    assert.ok(row.proconfig.includes("lock_timeout=5s"), row.fn);
    assert.ok(row.proconfig.includes('search_path=""'), row.fn);
  }

  const i = ids();
  const seed = await seedAttestedIdentities(db, i, { attest: false });
  await db.transaction(async (tx) => {
    const before = (await tx.query<{ t: string }>("select current_setting('lock_timeout') as t")).rows[0].t;
    await tx.query("select public.provider_identity_attest_team($1::jsonb)", [JSON.stringify(teamAttestation(i.homeTeamId, seed.homeTeamId))]);
    const after = (await tx.query<{ t: string; flag: string | null }>("select current_setting('lock_timeout') as t, current_setting('kapiloto.identity_attestation_rpc', true) as flag")).rows[0];
    assert.equal(after.t, before);
    // The internal DML flag lives only around the RPC's own writes.
    assert.equal(after.flag, "off");
  });
  await db.close();
});

test("projection DML and event INSERT need the RPC flag AND the held exclusive provider lock; events are immutable", async () => {
  const db = await createLedgerDatabase();
  const i = ids();
  const seed = await seedAttestedIdentities(db, i);
  const projection = await teamProjection(db, i.homeTeamId);
  const guard = /change only through the attest\/revoke RPCs/;

  // Direct writes, as application code holding service_role would try them.
  await assert.rejects(db.query("delete from private.provider_team_identity_attestations where provider_team_id = $1", [i.homeTeamId]), guard);
  await assert.rejects(db.query("update private.provider_team_identity_attestations set attested_by = 'x' where provider_team_id = $1", [i.homeTeamId]), guard);
  const forgeEvent = `insert into private.provider_team_identity_attestation_events
      (provider, provider_team_id, team_id, attestation_generation_id, attestation_version, event_kind, attestation_basis, evidence, evidence_sha256, attested_by, revoke_reason)
    values ('sportmonks', $1, $2, $3, 2, 'revoke', 'operator_manual', $4::jsonb, $5, 'forger', 'forged')`;
  const forgeParams = [i.homeTeamId, seed.homeTeamId, projection.attestation_generation_id, JSON.stringify(syntheticEvidence()), projection.evidence_sha256];
  await assert.rejects(db.query(forgeEvent, forgeParams), guard);

  // The flag alone, or the lock alone, is not enough.
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query("select set_config('kapiloto.identity_attestation_rpc', 'on', true)");
      await tx.query(forgeEvent, forgeParams);
    }),
    guard,
  );
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtextextended('kapiloto_v4_provider_identity:sportmonks', 0))");
      await tx.query(forgeEvent, forgeParams);
    }),
    guard,
  );
  // A SHARED provider lock (the ingest mode) is not the exclusive lock.
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query("select set_config('kapiloto.identity_attestation_rpc', 'on', true)");
      await tx.query("select pg_advisory_xact_lock_shared(hashtextextended('kapiloto_v4_provider_identity:sportmonks', 0))");
      await tx.query(forgeEvent, forgeParams);
    }),
    guard,
  );

  for (const table of ["provider_team_identity_attestation_events", "provider_competition_identity_attestation_events"]) {
    await assert.rejects(db.query(`update private.${table} set attested_by = 'x'`), /immutable/, table);
    await assert.rejects(db.query(`delete from private.${table}`), /immutable/, table);
    // CASCADE gets past the referencing foreign keys, so the truncate trigger itself answers.
    await assert.rejects(db.query(`truncate private.${table} cascade`), /immutable/, table);
  }
  for (const table of ["provider_team_identity_attestations", "provider_competition_identity_attestations"]) {
    await assert.rejects(db.query(`truncate private.${table} cascade`), /immutable/, table);
  }
  assert.equal((await teamProjection(db, i.homeTeamId)).latest_event_id, projection.latest_event_id);
  await db.close();
});

test("even with the flag and the lock held deliberately, a projection must equal its latest event and identities never change in place", async () => {
  const db = await createLedgerDatabase();
  const i = ids();
  const seed = await seedAttestedIdentities(db, i);
  const other = await teamRow(db, "Synthetic Other");
  const deliberate = (sql: string, params: unknown[] = []) =>
    db.transaction(async (tx) => {
      await tx.query("select set_config('kapiloto.identity_attestation_rpc', 'on', true)");
      await tx.query("select pg_advisory_xact_lock(hashtextextended('kapiloto_v4_provider_identity:sportmonks', 0))");
      await tx.query(sql, params);
    });
  await assert.rejects(
    deliberate("update private.provider_team_identity_attestations set team_id = $2 where provider_team_id = $1", [i.homeTeamId, other]),
    /keeps its provider ref, canonical team and generation/,
  );
  await assert.rejects(
    deliberate("update private.provider_team_identity_attestations set evidence_sha256 = $2 where provider_team_id = $1", [i.homeTeamId, "b".repeat(64)]),
    /must equal its latest event/,
  );
  await assert.rejects(
    deliberate("delete from private.provider_team_identity_attestations where provider_team_id = $1", [i.homeTeamId]),
    /removed only by a revoke event/,
  );
  // A revoked generation can never be reactivated, not even by re-inserting
  // its old attest event as the current projection with flag and lock held.
  const projection = await teamProjection(db, i.homeTeamId);
  await revokeTeam(db, i.homeTeamId, seed.homeTeamId, "closing the generation");
  await assert.rejects(
    deliberate(
      `insert into private.provider_team_identity_attestations
         (provider, provider_team_id, team_id, attestation_generation_id, attestation_version, latest_event_id, attestation_basis, evidence, evidence_sha256, first_attested_at, attested_at, attested_by)
       values ('sportmonks', $1, $2, $3, 1, $4, $5, $6::jsonb, $7, now(), now(), 'resurrect')`,
      [i.homeTeamId, seed.homeTeamId, projection.attestation_generation_id, projection.latest_event_id, projection.attestation_basis, JSON.stringify(syntheticEvidence()), projection.evidence_sha256],
    ),
    /is revoked and cannot be reactivated/,
  );
  assert.equal(await teamProjection(db, i.homeTeamId), undefined);
  // The guard limits accidents; it is not presented as a cryptographic
  // boundary against a deliberately malicious service_role.
  await db.close();
});

test("a canonical team or competition cannot be deleted while actively attested; after revoke it can, and the audit history stays", async () => {
  const db = await createLedgerDatabase();
  const i = ids();
  const seed = await seedAttestedIdentities(db, i);

  await assert.rejects(db.query("delete from public.teams where id = $1", [seed.homeTeamId]), /foreign key|violates/);
  await assert.rejects(db.query("delete from public.competitions where id = $1", [seed.competitionId]), /foreign key|violates/);

  await revokeTeam(db, i.homeTeamId, seed.homeTeamId);
  await revokeCompetition(db, i.leagueId, seed.competitionId);
  await db.query("delete from public.teams where id = $1", [seed.homeTeamId]);
  await db.query("delete from public.competitions where id = $1", [seed.competitionId]);
  const history = await teamEvents(db, i.homeTeamId);
  assert.deepEqual(history.map((e) => [e.event_kind, e.team_id]), [["attest", seed.homeTeamId], ["revoke", seed.homeTeamId]]);
  await db.close();
});

test("the TypeScript wrappers validate before calling and the entity report works through the loader", async () => {
  const db = await createLedgerDatabase();
  const i = ids();
  const seed = await seedAttestedIdentities(db, i, { attest: false });
  const rpc = pgliteRpc(db) as never;
  await assert.rejects(
    attestTeamTs(rpc, { provider: "sportmonks", providerTeamId: i.homeTeamId, teamId: seed.homeTeamId, basis: "operator_manual", evidence: syntheticEvidence({ sources: [] }), attestedBy: "op" }),
    /invalid attestation evidence/,
  );
  const result = await attestTeamTs(rpc, {
    provider: "sportmonks",
    providerTeamId: i.homeTeamId,
    teamId: seed.homeTeamId,
    basis: "operator_manual",
    evidence: syntheticEvidence(),
    attestedBy: "op",
  });
  assert.equal(result.status, "attested");
  const conflicts = await loadProviderIdentityAttestationConflicts(rpc, "sportmonks");
  assert.ok(conflicts.some((c) => c.issue_code === "mapping_unattested" && c.provider_ref === i.awayTeamId));
  assert.equal((await revokeTeamTs(rpc, { provider: "sportmonks", providerTeamId: i.homeTeamId, expectedTeamId: seed.homeTeamId, reason: "r", revokedBy: "op" })).status, "revoked");
  await db.close();
});

test("competition attestations use the same evidence and mapping rules", async () => {
  const db = await createLedgerDatabase();
  const i = ids();
  const seed = await seedIngestIdentities(db, { ...i, teamMappingStatus: "manual_override" });
  await operatorSql(db, "update public.provider_competition_mappings set mapping_status = 'confirmed' where provider = 'sportmonks' and provider_competition_id = $1", [i.leagueId]);
  await assert.rejects(attestCompetition(db, i.leagueId, seed.competitionId), /mapped as confirmed, not manual_override/);
  await operatorSql(db, "update public.provider_competition_mappings set mapping_status = 'manual_override' where provider = 'sportmonks' and provider_competition_id = $1", [i.leagueId]);
  await assert.rejects(
    callIdentityRpc(db, "provider_identity_attest_competition", competitionAttestation(i.leagueId, seed.competitionId, { evidence: syntheticEvidence({ reviewed_by: 7 }) })),
    /reviewed_by/,
  );
  const ok = await attestCompetition(db, i.leagueId, seed.competitionId);
  assert.deepEqual([ok.status, ok.attestation_version], ["attested", 1]);
  await db.close();
});
