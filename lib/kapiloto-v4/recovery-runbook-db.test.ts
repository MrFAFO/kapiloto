import assert from "node:assert/strict";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { buildProviderIngestRunRow, type ProviderIngestResult } from "./provider-ingest";
import {
  attestCompetition,
  attestTeam,
  attestedWorld,
  canonicalFixtureFor,
  createScopedRun,
  ingestV2,
  operatorSql,
  revokeCompetition,
  revokeTeam,
  syntheticEvidence,
  type AttestedWorld,
} from "./test-support/attestation-fixtures";
import { createLedgerDatabase, setClock } from "./test-support/ledger-fixtures";
import { ATTESTED_LINEUP_IDS, LINEUP_RECORDED, forecastSnapshot, recordPredictionV2, setupAttestedLineupWorld } from "./test-support/lineup-fixtures";
import { observationFrom, writeFootprint } from "./test-support/provider-ingest-fixtures";
import { runRunbookSql, runbookReport, runbookSql } from "./test-support/recovery-runbook";

/**
 * Synthetic rehearsal of the M2B/M2C recovery runbook
 * (docs/operations/2026-11-02-v4-m2b-m2c-recovery-runbook.md). Every operator
 * write runs the reviewed template in docs/operations/sql verbatim; identity
 * changes go through the attest/revoke RPCs. Production ingest runs as
 * service_role after a simulated M2B grant; once M2C has paused it, the
 * recovery re-ingest is an operator (owner) call and service_role stays
 * paused throughout.
 */

const KICKOFF = "2026-08-15T18:00:00.000Z";
const KICKOFF_RETURN = "2026-09-14T18:00:00.000Z";
const CAPTURED = "2026-10-30T08:59:00.000Z";
const SEEN = "2026-10-30T09:00:00.000Z";
const V2 = "public.match_ledger_ingest_provider_fixture_v2(jsonb)";
const INCIDENT = "SYNTHETIC-INC-1";

type ImpactRow = {
  impact_kind: string;
  observation_id: string | null;
  is_latest_version: boolean | null;
  fixture_id: string | null;
  provider_fixture_id: string | null;
  attestation_generation_id: string | null;
  generation_state: string | null;
};

type Identity = { competition: string; home: string; away: string };

async function asRole<T>(db: PGlite, role: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

const serviceRoleCanIngest = async (db: PGlite) =>
  (await db.query<{ ok: boolean }>("select has_function_privilege('service_role', $1, 'execute') as ok", [V2])).rows[0].ok;

const impact = async (db: PGlite, kind: "team" | "competition", ref: string) =>
  (await db.query<ImpactRow>(
    `select impact_kind, observation_id, is_latest_version, fixture_id, provider_fixture_id, attestation_generation_id, generation_state
       from public.provider_identity_revocation_impact('sportmonks', $1, $2)`,
    [kind, ref],
  )).rows;

const trustIssue = async (db: PGlite, observationId: string) =>
  (await db.query<{ v: string | null }>("select private.match_ledger_observation_attestation_issue($1) as v", [observationId])).rows[0].v;

const asOfV2 = async (db: PGlite, fixtureId: string, at: string) =>
  (await db.query<{ id: string | null }>("select public.match_ledger_observation_as_of_v2($1, 'sportmonks', $2) as id", [fixtureId, at])).rows[0].id;

const latestKind = async (db: PGlite, fixtureId: string) =>
  (await db.query<{ observation_kind: string; observation_version: number }>(
    `select observation_kind, observation_version from public.match_ledger_observations
      where fixture_id = $1 and provider = 'sportmonks' order by observation_version desc limit 1`,
    [fixtureId],
  )).rows[0];

const fixtureIdentity = async (db: PGlite, fixtureId: string) =>
  (await db.query<{ competition_id: string; home_team_id: string; away_team_id: string }>(
    "select competition_id, home_team_id, away_team_id from public.fixtures where id = $1",
    [fixtureId],
  )).rows[0];

const identityConflicts = async (db: PGlite) =>
  (await db.query<{ issue_code: string; severity: string; provider_ref: string; mapping_canonical_id: string | null }>(
    "select issue_code, severity, provider_ref, mapping_canonical_id from public.provider_identity_attestation_conflicts('sportmonks') where severity <> 'info'",
  )).rows;

const refConflicts = async (db: PGlite) =>
  (await db.query<{ issue_code: string; is_current_version: boolean; observation_id: string }>(
    "select issue_code, is_current_version, observation_id from public.match_ledger_provider_ref_conflicts_v2('sportmonks')",
  )).rows;

/** A fresh immutable recovery run: purpose backfill, exact allowlist, incident metadata, no mint bound. */
async function createRecoveryRun(db: PGlite, providerFixtureIds: string[], recovery: Record<string, unknown>): Promise<string> {
  const row = buildProviderIngestRunRow({
    provider: "sportmonks",
    purpose: "backfill",
    ingestVersion: "kapiloto-sportmonks-ledger-mapping-v1",
    entitlementSnapshotSha256: null,
    scope: { provider_fixture_ids: providerFixtureIds, recovery: { incident_ref: INCIDENT, ...recovery } },
    fixtureMintKickoffBefore: null,
  });
  return (await db.query<{ id: string }>(
    `insert into public.provider_ingest_runs (provider, purpose, ingest_version, entitlement_snapshot_sha256, scope, fixture_mint_kickoff_before)
     values ($1, $2, $3, $4, $5::jsonb, $6) returning id`,
    [row.provider, row.purpose, row.ingest_version, row.entitlement_snapshot_sha256, JSON.stringify(row.scope), row.fixture_mint_kickoff_before],
  )).rows[0].id;
}

const withdraw = (db: PGlite, fixtureId: string, providerFixtureId: string, observationId: string, trust = "untrusted") =>
  runRunbookSql(db, "withdrawChain", {
    incident_ref: INCIDENT,
    fixture_id: fixtureId,
    provider_fixture_id: providerFixtureId,
    observation_id: observationId,
    trust,
    reason: "synthetic wrong canonical identity",
  });

const correctMintedFixture = (db: PGlite, providerFixtureId: string, fixtureId: string, expected: Identity, corrected: Identity) =>
  runRunbookSql(db, "correctMintedFixture", {
    provider_fixture_id: providerFixtureId,
    fixture_id: fixtureId,
    expected_competition_id: expected.competition,
    expected_home_team_id: expected.home,
    expected_away_team_id: expected.away,
    competition_id: corrected.competition,
    home_team_id: corrected.home,
    away_team_id: corrected.away,
  });

const correctMapping = (db: PGlite, kind: "team" | "competition", ref: string, expected: string, canonical: string) =>
  runRunbookSql(db, "correctIdentityMapping", { entity_kind: kind, provider_ref: ref, expected_canonical_id: expected, canonical_id: canonical });

const unmap = (db: PGlite, providerFixtureId: string, fixtureId: string) =>
  runRunbookSql(db, "unmapProviderFixture", { provider_fixture_id: providerFixtureId, fixture_id: fixtureId });

const verifyChain = (db: PGlite, providerFixtureId: string, fixtureId: string) =>
  runRunbookSql(db, "verifyChain", { provider_fixture_id: providerFixtureId, fixture_id: fixtureId });

const has = (notices: string[], text: string) => notices.some((notice) => notice.includes(text));

async function newTeam(db: PGlite, name: string): Promise<string> {
  return (await db.query<{ id: string }>("insert into public.teams (canonical_name) values ($1) returning id", [name])).rows[0].id;
}

async function newCompetition(db: PGlite, name: string): Promise<string> {
  return (await db.query<{ id: string }>(
    "insert into public.competitions (canonical_name, country_code, competition_type) values ($1, 'IL', 'league') returning id",
    [name],
  )).rows[0].id;
}

/** The real match, created by another writer (e.g. a Toto import) after the wrong mint. */
async function realMatch(db: PGlite, w: AttestedWorld, home: string): Promise<string> {
  return (await db.query<{ id: string }>(
    "insert into public.fixtures (competition_id, home_team_id, away_team_id, kickoff_at, status) values ($1, $2, $3, $4, 'finished') returning id",
    [w.seed.competitionId, home, w.seed.awayTeamId, KICKOFF],
  )).rows[0].id;
}

function minted(result: ProviderIngestResult): { fixtureId: string; observationId: string } {
  assert.deepEqual([result.status, result.fixture_resolution], ["recorded", "minted"]);
  assert.ok(result.fixture_id && result.observation_id);
  return { fixtureId: result.fixture_id, observationId: result.observation_id };
}

test("team identity incident: pause, contain, withdraw every chain, correct the minted fixtures in place, re-attest and re-ingest under a fresh run", async () => {
  const db = await createLedgerDatabase({ supabaseDefaultPrivileges: true });
  const w = await attestedWorld(db, { kickoffAt: KICKOFF, capturedAt: CAPTURED });
  const returnId = String(Number(w.providerFixtureId) + 500_000);
  const pilotRun = await createScopedRun(db, [w.providerFixtureId, returnId]);
  const forward = (runId: string, mint = true) => w.observation({}, { runId, mint });
  const returnLeg = (runId: string, mint = true) =>
    observationFrom(
      w.capture({ providerFixtureId: returnId, homeTeamId: w.ids.awayTeamId, awayTeamId: w.ids.homeTeamId, kickoffAt: KICKOFF_RETURN }),
      { runId, mint },
    );
  const wrongHome = w.seed.homeTeamId;
  const { competitionId, awayTeamId } = w.seed;

  // M2B (simulated): service_role ingests two fixtures of provider team
  // homeTeamId, which is attested to the WRONG canonical team. Both mint.
  await db.exec(`grant execute on function ${V2} to service_role`);
  const x1 = minted(await asRole(db, "service_role", () => ingestV2(db, forward(pilotRun), SEEN)));
  const x2Result = await asRole(db, "service_role", () => ingestV2(db, returnLeg(pilotRun), "2026-10-30T09:05:00.000Z"));
  const x2 = minted(x2Result);
  const oldGeneration = x2Result.attestation_generations?.team_away;
  assert.ok(oldGeneration);

  // §A M2C: pause, verify, and service_role can no longer ingest.
  await db.exec(runbookSql("m2cRevoke"));
  assert.ok(has(await runRunbookSql(db, "m2cVerify"), "M2C verification PASSED"));
  await assert.rejects(asRole(db, "service_role", () => ingestV2(db, forward(pilotRun), "2026-10-30T09:30:00.000Z")), /permission denied/);

  // §B scoping before identity changes: both chains, generation still active.
  const scoped = (await impact(db, "team", w.ids.homeTeamId)).filter((r) => r.impact_kind === "observation_under_generation");
  assert.deepEqual(
    scoped.map((r) => [r.observation_id, r.generation_state, r.is_latest_version]).sort(),
    [[x1.observationId, "active", true], [x2.observationId, "active", true]].sort(),
  );

  // §C containment. The identity RPCs stay available to service_role under M2C.
  await setClock(db, "2026-10-30T10:00:00.000Z");
  await asRole(db, "service_role", () => revokeTeam(db, w.ids.homeTeamId, wrongHome, `${INCIDENT}: wrong canonical team`));
  const authoritative = await impact(db, "team", w.ids.homeTeamId);
  assert.deepEqual(
    authoritative.filter((r) => r.impact_kind === "observation_under_generation").map((r) => [r.observation_id, r.generation_state]).sort(),
    [[x1.observationId, "revoked"], [x2.observationId, "revoked"]].sort(),
  );
  assert.deepEqual(authoritative.filter((r) => r.impact_kind === "fixture_mapping").map((r) => r.fixture_id).sort(), [x1.fixtureId, x2.fixtureId].sort());
  assert.deepEqual(authoritative.filter((r) => r.impact_kind === "fixture_mint").map((r) => r.fixture_id).sort(), [x1.fixtureId, x2.fixtureId].sort());
  for (const x of [x1, x2]) {
    assert.equal(await asOfV2(db, x.fixtureId, "2026-10-30T10:01:00.000Z"), null);
    assert.equal(await trustIssue(db, x.observationId), "generation_revoked");
  }

  // §D withdrawal. Out of order (fixture correction first), a stale
  // compare-and-set and a wrong trust declaration are refused without writing.
  await setClock(db, "2026-10-30T10:05:00.000Z");
  const rightHome = await newTeam(db, "Synthetic Correct Home");
  const wrong: Identity = { competition: competitionId, home: wrongHome, away: awayTeamId };
  const corrected: Identity = { competition: competitionId, home: rightHome, away: awayTeamId };
  await assert.rejects(correctMintedFixture(db, w.providerFixtureId, x1.fixtureId, wrong, corrected), /still has a live ledger chain/);
  await assert.rejects(withdraw(db, x1.fixtureId, w.providerFixtureId, x2.observationId), /chain changed since review/);
  await assert.rejects(withdraw(db, x1.fixtureId, w.providerFixtureId, x1.observationId, "trusted"), /untrusted \(generation_revoked\), not trusted/);
  assert.ok(has(await withdraw(db, x1.fixtureId, w.providerFixtureId, x1.observationId), "withdrawn:"));
  assert.ok(has(await withdraw(db, x2.fixtureId, returnId, x2.observationId), "withdrawn:"));
  assert.ok(has(await withdraw(db, x1.fixtureId, w.providerFixtureId, x1.observationId), "already withdrawn"));
  assert.deepEqual(await latestKind(db, x1.fixtureId), { observation_kind: "withdrawal", observation_version: 2 });
  assert.deepEqual(await latestKind(db, x2.fixtureId), { observation_kind: "withdrawal", observation_version: 2 });
  await assert.rejects(
    verifyChain(db, w.providerFixtureId, x1.fixtureId),
    /recovery verification FAILED.*live chains for this provider fixture id: \{\}.*has no live sportmonks observation/,
  );

  // §E1 the minted fixtures are corrected in place (side-preserving).
  await assert.rejects(
    correctMintedFixture(db, w.providerFixtureId, x1.fixtureId, { ...wrong, home: awayTeamId, away: wrongHome }, corrected),
    /changed since review/,
  );
  assert.deepEqual(await fixtureIdentity(db, x1.fixtureId), { competition_id: competitionId, home_team_id: wrongHome, away_team_id: awayTeamId });
  assert.ok(has(await correctMintedFixture(db, w.providerFixtureId, x1.fixtureId, wrong, corrected), "corrected in place"));
  assert.ok(has(
    await correctMintedFixture(db, returnId, x2.fixtureId, { competition: competitionId, home: awayTeamId, away: wrongHome }, { competition: competitionId, home: awayTeamId, away: rightHome }),
    "corrected in place",
  ));
  assert.ok(has(await correctMintedFixture(db, w.providerFixtureId, x1.fixtureId, wrong, corrected), "already carries the corrected identity"));
  assert.deepEqual(await fixtureIdentity(db, x2.fixtureId), { competition_id: competitionId, home_team_id: awayTeamId, away_team_id: rightHome });

  // §F mapping correction (own transaction) and §G re-attestation: a new generation.
  await setClock(db, "2026-10-30T10:10:00.000Z");
  await assert.rejects(correctMapping(db, "team", w.ids.homeTeamId, awayTeamId, rightHome), /changed since review/);
  assert.ok(has(await correctMapping(db, "team", w.ids.homeTeamId, wrongHome, rightHome), "mapping corrected"));
  assert.ok(has(await correctMapping(db, "team", w.ids.homeTeamId, wrongHome, rightHome), "already mapped"));
  await setClock(db, "2026-10-30T10:15:00.000Z");
  const reattested = await asRole(db, "service_role", () => attestTeam(db, w.ids.homeTeamId, rightHome));
  assert.equal(reattested.status, "attested");
  const newGeneration = reattested.attestation_generation_id;
  assert.notEqual(newGeneration, oldGeneration);
  const events = (await db.query<{ attestation_version: number; event_kind: string; attestation_generation_id: string; team_id: string; has_reason: boolean }>(
    `select attestation_version, event_kind, attestation_generation_id, team_id, revoke_reason is not null as has_reason
       from private.provider_team_identity_attestation_events
      where provider = 'sportmonks' and provider_team_id = $1 order by attestation_version`,
    [w.ids.homeTeamId],
  )).rows;
  assert.deepEqual(events, [
    { attestation_version: 1, event_kind: "attest", attestation_generation_id: oldGeneration, team_id: wrongHome, has_reason: false },
    { attestation_version: 2, event_kind: "revoke", attestation_generation_id: oldGeneration, team_id: wrongHome, has_reason: true },
    { attestation_version: 3, event_kind: "attest", attestation_generation_id: newGeneration, team_id: rightHome, has_reason: false },
  ]);
  // The old observations stay excluded forever; an evidence refresh of the
  // new generation does not rehabilitate them.
  const refreshed = await attestTeam(db, w.ids.homeTeamId, rightHome, { evidence: syntheticEvidence({ sources: ["synthetic:refreshed-evidence"] }) });
  assert.deepEqual([refreshed.status, refreshed.attestation_generation_id], ["refreshed", newGeneration]);
  for (const x of [x1, x2]) assert.equal(await trustIssue(db, x.observationId), "attestation_generation_stale");

  // §H a fresh immutable allow-listed recovery run.
  const recoveryRun = await createRecoveryRun(db, [w.providerFixtureId, returnId], {
    revoked_attestation_generation_ids: [oldGeneration],
    withdrawn_observation_ids: [x1.observationId, x2.observationId],
  });
  assert.notEqual(recoveryRun, pilotRun);
  await assert.rejects(db.query("update public.provider_ingest_runs set scope = '{}'::jsonb where id = $1", [recoveryRun]), /immutable/);

  // §I operator re-ingest while service_role stays paused.
  assert.equal(await serviceRoleCanIngest(db), false);
  const outside = await ingestV2(db, w.observation({ providerFixtureId: "39999999" }, { runId: recoveryRun, mint: false }), "2026-10-30T10:55:00.000Z");
  assert.deepEqual([outside.status, outside.reason_code], ["quarantined", "fixture_outside_run_scope"]);
  const r1 = await ingestV2(db, forward(recoveryRun, false), "2026-10-30T11:00:00.000Z");
  const r2 = await ingestV2(db, returnLeg(recoveryRun, false), "2026-10-30T11:01:00.000Z");
  assert.deepEqual([r1.status, r1.fixture_resolution, r1.fixture_id, r1.observation_version], ["recorded", "existing_mapping", x1.fixtureId, 3]);
  assert.deepEqual([r2.status, r2.fixture_resolution, r2.fixture_id, r2.observation_version], ["recorded", "existing_mapping", x2.fixtureId, 3]);
  assert.ok(r1.observation_id && r2.observation_id);
  const sealed = (await db.query<{ observation_id: string; ref_kind: string; attestation_generation_id: string; canonical_id: string }>(
    `select observation_id, ref_kind, attestation_generation_id, canonical_id from public.match_ledger_observation_identity_attestations
      where observation_id = any($1::uuid[]) and ref_kind in ('team_home', 'team_away') and provider_ref = $2 order by ref_kind`,
    [[r1.observation_id, r2.observation_id], w.ids.homeTeamId],
  )).rows;
  assert.deepEqual(sealed, [
    { observation_id: r2.observation_id, ref_kind: "team_away", attestation_generation_id: newGeneration, canonical_id: rightHome },
    { observation_id: r1.observation_id, ref_kind: "team_home", attestation_generation_id: newGeneration, canonical_id: rightHome },
  ]);

  // §J validation.
  assert.ok(has(await verifyChain(db, w.providerFixtureId, x1.fixtureId), "recovery verification PASSED"));
  assert.ok(has(await verifyChain(db, returnId, x2.fixtureId), "recovery verification PASSED"));
  // Strict as-of: nothing before the recovery, only the corrected chain after.
  assert.equal(await asOfV2(db, x1.fixtureId, "2026-10-30T09:59:00.000Z"), null);
  assert.equal(await asOfV2(db, x1.fixtureId, "2026-10-30T10:30:00.000Z"), null);
  assert.equal(await asOfV2(db, x1.fixtureId, "2026-10-30T11:30:00.000Z"), r1.observation_id);
  const again = await ingestV2(db, forward(recoveryRun, false), "2026-10-30T11:30:00.000Z");
  assert.deepEqual([again.status, again.observation_id], ["unchanged", r1.observation_id]);
  // The mint rows stay as immutable provenance of the original run.
  const mints = (await db.query<{ fixture_id: string; provider_fixture_id: string; run_id: string }>(
    "select fixture_id, provider_fixture_id, run_id from public.match_ledger_fixture_mints where provider = 'sportmonks' order by provider_fixture_id",
  )).rows;
  assert.deepEqual(mints, [
    { fixture_id: x1.fixtureId, provider_fixture_id: w.providerFixtureId, run_id: pilotRun },
    { fixture_id: x2.fixtureId, provider_fixture_id: returnId, run_id: pilotRun },
  ]);
  await assert.rejects(db.query("update public.match_ledger_fixture_mints set run_id = $1 where fixture_id = $2", [recoveryRun, x1.fixtureId]), /immutable/);
  await assert.rejects(db.query("delete from public.match_ledger_fixture_mints where fixture_id = $1", [x1.fixtureId]), /immutable/);
  // Reports: no blocking or warning identity issue; only historical
  // (non-current) provider-ref rows for the withdrawn versions.
  assert.deepEqual(await identityConflicts(db), []);
  const refs = await refConflicts(db);
  assert.equal(refs.filter((r) => r.is_current_version).length, 0);
  assert.ok(refs.some((r) => r.observation_id === x1.observationId && r.issue_code === "team_attestation_generation_stale"));
  // service_role is still paused; re-activation is a separate reviewed grant.
  assert.equal(await serviceRoleCanIngest(db), false);
  assert.ok(has(await runRunbookSql(db, "m2cVerify"), "M2C verification PASSED"));
  await db.close();
});

test("competition identity incident: correcting the minted fixture in place recovers it; a parallel canonical fixture blocks recovery", async () => {
  async function wrongCompetitionMint(db: PGlite): Promise<{ w: AttestedWorld; x: { fixtureId: string; observationId: string }; right: string }> {
    const w = await attestedWorld(db, { kickoffAt: KICKOFF, capturedAt: CAPTURED });
    const x = minted(await ingestV2(db, w.observation(), SEEN));
    const right = await newCompetition(db, "Synthetic Correct League");
    await setClock(db, "2026-10-30T10:00:00.000Z");
    await revokeCompetition(db, w.ids.leagueId, w.seed.competitionId, `${INCIDENT}: wrong canonical competition`);
    assert.equal(await trustIssue(db, x.observationId), "generation_revoked");
    await setClock(db, "2026-10-30T10:05:00.000Z");
    assert.ok(has(await withdraw(db, x.fixtureId, w.providerFixtureId, x.observationId), "withdrawn:"));
    return { w, x, right };
  }

  // The superseded procedure: unmap and create a separate correct fixture.
  // The withdrawn mint (same teams and kickoff, other competition) blocks
  // every re-ingest, and the duplicate also blocks the in-place correction.
  const blockedDb = await createLedgerDatabase();
  const b = await wrongCompetitionMint(blockedDb);
  await unmap(blockedDb, b.w.providerFixtureId, b.x.fixtureId);
  await correctMapping(blockedDb, "competition", b.w.ids.leagueId, b.w.seed.competitionId, b.right);
  await setClock(blockedDb, "2026-10-30T10:15:00.000Z");
  await attestCompetition(blockedDb, b.w.ids.leagueId, b.right);
  await canonicalFixtureFor(blockedDb, b.w.seed, KICKOFF, { competitionId: b.right, status: "finished" });
  const blockedRun = await createRecoveryRun(blockedDb, [b.w.providerFixtureId], {});
  const blocked = await ingestV2(blockedDb, b.w.observation({}, { runId: blockedRun, mint: false }), "2026-10-30T11:00:00.000Z");
  assert.deepEqual([blocked.status, blocked.reason_code], ["quarantined", "fixture_competition_conflict"]);
  await assert.rejects(
    correctMintedFixture(
      blockedDb,
      b.w.providerFixtureId,
      b.x.fixtureId,
      { competition: b.w.seed.competitionId, home: b.w.seed.homeTeamId, away: b.w.seed.awayTeamId },
      { competition: b.right, home: b.w.seed.homeTeamId, away: b.w.seed.awayTeamId },
    ),
    /already represent the corrected match/,
  );
  await blockedDb.close();

  // provider_ingest_items.fixture_id is deliberately a soft reference (no FK).
  // A foreign audit row must still stop in-place mutation even though a generic
  // FK scan cannot see it.
  const softRefDb = await createLedgerDatabase();
  const s = await wrongCompetitionMint(softRefDb);
  await softRefDb.query(
    `insert into public.provider_ingest_items
      (run_id, provider, provider_fixture_id, attempt_no, status, reason_code, observation_id, fixture_id, detail)
     values ($1, 'api_football', 'foreign-soft-ref', 1, 'quarantined', 'synthetic_foreign_ref', null, $2, '{}'::jsonb)`,
    [s.w.runId, s.x.fixtureId],
  );
  await assert.rejects(
    correctMintedFixture(
      softRefDb,
      s.w.providerFixtureId,
      s.x.fixtureId,
      { competition: s.w.seed.competitionId, home: s.w.seed.homeTeamId, away: s.w.seed.awayTeamId },
      { competition: s.right, home: s.w.seed.homeTeamId, away: s.w.seed.awayTeamId },
    ),
    /ingest audit reference outside sportmonks fixture/,
  );
  await softRefDb.close();

  // The reviewed procedure: correct the minted fixture's competition in
  // place; its mapping stays and the re-ingest validates it as the unique
  // candidate.
  const db = await createLedgerDatabase();
  const { w, x, right } = await wrongCompetitionMint(db);
  const { homeTeamId, awayTeamId } = w.seed;
  const correctCompetition = () =>
    correctMintedFixture(
      db,
      w.providerFixtureId,
      x.fixtureId,
      { competition: w.seed.competitionId, home: homeTeamId, away: awayTeamId },
      { competition: right, home: homeTeamId, away: awayTeamId },
    );
  // Only a fixture private to the V4 ledger is corrected in place: a V3
  // reference or another provider's mapping stops the template.
  await db.query("insert into public.kapiloto_fixture_intelligence_state (fixture_id) values ($1)", [x.fixtureId]);
  await assert.rejects(correctCompetition(), /referenced by (public\.)?kapiloto_fixture_intelligence_state\.fixture_id \(1 rows\)/);
  await db.query("delete from public.kapiloto_fixture_intelligence_state where fixture_id = $1", [x.fixtureId]);
  await db.query("insert into public.provider_fixture_mappings (fixture_id, provider, provider_fixture_id, mapping_status) values ($1, 'api_football', '777001', 'confirmed')", [x.fixtureId]);
  await assert.rejects(correctCompetition(), /carries another provider fixture mapping/);
  await db.query("delete from public.provider_fixture_mappings where provider = 'api_football' and fixture_id = $1", [x.fixtureId]);
  assert.ok(has(await correctCompetition(), "corrected in place"));
  await setClock(db, "2026-10-30T10:10:00.000Z");
  await correctMapping(db, "competition", w.ids.leagueId, w.seed.competitionId, right);
  await setClock(db, "2026-10-30T10:15:00.000Z");
  const reattested = await attestCompetition(db, w.ids.leagueId, right);
  assert.equal(reattested.status, "attested");
  const run = await createRecoveryRun(db, [w.providerFixtureId], {});
  const recovered = await ingestV2(db, w.observation({}, { runId: run, mint: false }), "2026-10-30T11:00:00.000Z");
  assert.deepEqual([recovered.status, recovered.fixture_resolution, recovered.fixture_id, recovered.observation_version], ["recorded", "existing_mapping", x.fixtureId, 3]);
  assert.equal(recovered.attestation_generations?.league, reattested.attestation_generation_id);
  assert.ok(has(await verifyChain(db, w.providerFixtureId, x.fixtureId), "recovery verification PASSED"));
  assert.deepEqual(await identityConflicts(db), []);
  const refs = await refConflicts(db);
  assert.equal(refs.filter((r) => r.is_current_version).length, 0);
  assert.ok(refs.some((r) => r.observation_id === x.observationId && r.issue_code === "fixture_competition_drift"));
  await db.close();
});

test("team identity incident where another writer already created the real match: unmap, attach, and the orphan stays reported", async () => {
  const db = await createLedgerDatabase();
  const w = await attestedWorld(db, { kickoffAt: KICKOFF, capturedAt: CAPTURED });
  const x = minted(await ingestV2(db, w.observation(), SEEN));
  const rightHome = await newTeam(db, "Synthetic Correct Home");
  await setClock(db, "2026-10-30T10:00:00.000Z");
  await revokeTeam(db, w.ids.homeTeamId, w.seed.homeTeamId, `${INCIDENT}: wrong canonical team`);
  const real = await realMatch(db, w, rightHome);

  await setClock(db, "2026-10-30T10:05:00.000Z");
  await assert.rejects(unmap(db, w.providerFixtureId, x.fixtureId), /is not withdrawn; withdraw it first/);
  await withdraw(db, x.fixtureId, w.providerFixtureId, x.observationId);
  // §E3: the minted row cannot become a second representation of the real match.
  await assert.rejects(
    correctMintedFixture(
      db,
      w.providerFixtureId,
      x.fixtureId,
      { competition: w.seed.competitionId, home: w.seed.homeTeamId, away: w.seed.awayTeamId },
      { competition: w.seed.competitionId, home: rightHome, away: w.seed.awayTeamId },
    ),
    /already represent the corrected match/,
  );
  await assert.rejects(unmap(db, w.providerFixtureId, real), /mapped to fixture .* not the reviewed/);
  assert.ok(has(await unmap(db, w.providerFixtureId, x.fixtureId), "removed the mapping"));
  assert.ok(has(await unmap(db, w.providerFixtureId, x.fixtureId), "has no fixture mapping; nothing changed"));
  await assert.rejects(verifyChain(db, w.providerFixtureId, real), /recovery verification FAILED.*mapping points to nothing/);

  await setClock(db, "2026-10-30T10:10:00.000Z");
  await correctMapping(db, "team", w.ids.homeTeamId, w.seed.homeTeamId, rightHome);
  await setClock(db, "2026-10-30T10:15:00.000Z");
  await attestTeam(db, w.ids.homeTeamId, rightHome);
  const run = await createRecoveryRun(db, [w.providerFixtureId], {});
  const recovered = await ingestV2(db, w.observation({}, { runId: run, mint: false }), "2026-10-30T11:00:00.000Z");
  assert.deepEqual([recovered.status, recovered.fixture_resolution, recovered.fixture_id, recovered.observation_version], ["recorded", "attached", real, 1]);
  assert.ok(has(await verifyChain(db, w.providerFixtureId, real), "recovery verification PASSED"));
  assert.equal(await asOfV2(db, x.fixtureId, "2026-10-30T12:00:00.000Z"), null);
  assert.deepEqual(await latestKind(db, x.fixtureId), { observation_kind: "withdrawal", observation_version: 2 });
  // The withdrawn mint is the one reported warning: a recorded orphan that
  // needs a canonical cleanup decision. Its mint row is unchanged.
  assert.deepEqual(await identityConflicts(db), [
    { issue_code: "mint_without_mapping", severity: "warning", provider_ref: w.providerFixtureId, mapping_canonical_id: x.fixtureId },
  ]);
  assert.equal((await refConflicts(db)).filter((r) => r.is_current_version).length, 0);
  const again = await ingestV2(db, w.observation({}, { runId: run, mint: false }), "2026-10-30T11:30:00.000Z");
  assert.deepEqual([again.status, again.observation_id], ["unchanged", recovered.observation_id]);
  await db.close();
});

test("an out-of-order recovery fails closed without writing, and resumes from where it stopped", async () => {
  const db = await createLedgerDatabase();
  const w = await attestedWorld(db, { kickoffAt: KICKOFF, capturedAt: CAPTURED });
  const x = minted(await ingestV2(db, w.observation(), SEEN));
  const rightHome = await newTeam(db, "Synthetic Correct Home");
  const real = await realMatch(db, w, rightHome);
  await setClock(db, "2026-10-30T10:00:00.000Z");
  await revokeTeam(db, w.ids.homeTeamId, w.seed.homeTeamId, `${INCIDENT}: wrong canonical team`);

  // Operator mistake: raw SQL removes the mapping with no withdrawal.
  await operatorSql(db, "delete from public.provider_fixture_mappings where provider = 'sportmonks' and provider_fixture_id = $1", [w.providerFixtureId]);
  await correctMapping(db, "team", w.ids.homeTeamId, w.seed.homeTeamId, rightHome);
  const run = await createRecoveryRun(db, [w.providerFixtureId], {});
  const footprint = await writeFootprint(db);

  // Re-ingest before re-attestation: a quarantine, nothing written.
  const early = await ingestV2(db, w.observation({}, { runId: run, mint: false }), "2026-10-30T10:20:00.000Z");
  assert.deepEqual([early.status, early.reason_code], ["quarantined", "team_attestation_missing"]);
  assert.deepEqual(await writeFootprint(db), footprint);

  await setClock(db, "2026-10-30T10:25:00.000Z");
  await attestTeam(db, w.ids.homeTeamId, rightHome);
  // The 1A attachment invariant refuses a second live chain for the provider
  // fixture id while the wrong chain is not withdrawn: no duplicate canonical
  // representation can appear, and the whole call rolls back.
  await assert.rejects(
    ingestV2(db, w.observation({}, { runId: run, mint: false }), "2026-10-30T10:30:00.000Z"),
    /already recorded for a different canonical fixture/,
  );
  assert.deepEqual(await writeFootprint(db), footprint);

  // Resume: withdraw (the sealed generation is now stale), then the same re-ingest succeeds.
  await setClock(db, "2026-10-30T10:35:00.000Z");
  assert.equal(await trustIssue(db, x.observationId), "attestation_generation_stale");
  assert.ok(has(await withdraw(db, x.fixtureId, w.providerFixtureId, x.observationId), "withdrawn:"));
  const recovered = await ingestV2(db, w.observation({}, { runId: run, mint: false }), "2026-10-30T11:00:00.000Z");
  assert.deepEqual([recovered.status, recovered.fixture_resolution, recovered.fixture_id], ["recorded", "attached", real]);
  assert.ok(has(await verifyChain(db, w.providerFixtureId, real), "recovery verification PASSED"));

  // Re-running a finished step is a no-op, and a stale step cannot undo the recovery.
  assert.ok(has(await withdraw(db, x.fixtureId, w.providerFixtureId, x.observationId), "already withdrawn"));
  assert.ok(has(await correctMapping(db, "team", w.ids.homeTeamId, w.seed.homeTeamId, rightHome), "already mapped"));
  await assert.rejects(unmap(db, w.providerFixtureId, x.fixtureId), /mapped to fixture .* not the reviewed/);
  await assert.rejects(correctMapping(db, "team", w.ids.homeTeamId, rightHome, w.seed.homeTeamId), /still actively attested; revoke it first/);
  assert.ok(has(await verifyChain(db, w.providerFixtureId, real), "recovery verification PASSED"));
  await db.close();
});

test("provider-data incident: a trusted chain is withdrawn without any revoke and corrected data re-ingests under the same generation", async () => {
  const db = await createLedgerDatabase();
  const w = await attestedWorld(db, { kickoffAt: KICKOFF, capturedAt: CAPTURED });
  const first = await ingestV2(db, w.observation(), SEEN);
  const x = minted(first);
  const generations = first.attestation_generations;
  await setClock(db, "2026-10-30T10:05:00.000Z");

  // An identity withdrawal of a still-trusted chain is refused: revoke first,
  // or declare it a provider-data withdrawal.
  await assert.rejects(withdraw(db, x.fixtureId, w.providerFixtureId, x.observationId), /is still trusted: revoke the incorrect attestation first/);
  assert.equal(await latestKind(db, x.fixtureId).then((r) => r.observation_kind), "observation");
  assert.ok(has(await withdraw(db, x.fixtureId, w.providerFixtureId, x.observationId, "trusted"), "withdrawn:"));
  assert.equal(await asOfV2(db, x.fixtureId, "2026-10-30T10:06:00.000Z"), null);

  const run = await createRecoveryRun(db, [w.providerFixtureId], {});
  const corrected = await ingestV2(db, w.observation({ score90: [3, 1] }, { runId: run, mint: false }), "2026-10-30T11:00:00.000Z");
  assert.deepEqual([corrected.status, corrected.fixture_resolution, corrected.fixture_id, corrected.observation_version], ["recorded", "existing_mapping", x.fixtureId, 3]);
  assert.deepEqual(corrected.attestation_generations, generations);
  assert.ok(has(await verifyChain(db, w.providerFixtureId, x.fixtureId), "recovery verification PASSED"));
  assert.deepEqual(await identityConflicts(db), []);
  await db.close();
});

test("the affected-forecasts report surfaces frozen lineup forecasts that consumed revoked history", async () => {
  const world = await setupAttestedLineupWorld();
  const { db, home, obs } = world;
  const { snapshot } = await forecastSnapshot(world, home.teamId, { idempotencyKey: "recovery-affected-forecast" });
  const recorded = await recordPredictionV2(db, snapshot, LINEUP_RECORDED);
  assert.equal(recorded.status, "recorded");
  const consumed = [obs.t1.observation_id, obs.t2.observation_id, obs.t3.observation_id].sort();
  const params = { entity_kind: "team", provider_ref: ATTESTED_LINEUP_IDS.homeTeamId };
  type Row = { snapshot_id: string; ledger_observation_id: string; generation_state: string; impact_kind: string };

  const before = await runbookReport<Row>(db, "affectedForecasts", params);
  assert.deepEqual(before.map((r) => r.ledger_observation_id).sort(), consumed);
  assert.ok(before.every((r) => r.snapshot_id === recorded.snapshot_id && r.generation_state === "active" && r.impact_kind === "observation_under_generation"));

  await setClock(db, "2026-10-30T13:00:00.000Z");
  await revokeTeam(db, ATTESTED_LINEUP_IDS.homeTeamId, home.teamId, `${INCIDENT}: wrong canonical team`);
  const after = await runbookReport<Row>(db, "affectedForecasts", params);
  assert.deepEqual(after.map((r) => r.ledger_observation_id).sort(), consumed);
  assert.ok(after.every((r) => r.snapshot_id === recorded.snapshot_id && r.generation_state === "revoked"));
  // The snapshot itself is a frozen record: still there, inputs unchanged.
  const inputs = await db.query("select 1 from public.prediction_ledger_inputs where snapshot_id = $1", [recorded.snapshot_id]);
  assert.equal(inputs.rows.length, 3);
  await db.close();
});
