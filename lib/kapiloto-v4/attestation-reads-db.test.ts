import assert from "node:assert/strict";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { blockingAttestationConflicts, loadProviderIdentityAttestationConflicts, loadProviderIdentityRevocationImpact } from "./identity-attestations";
import { buildMatchLedgerWithdrawalPayload } from "./match-ledger";
import { loadProviderRefConflictsV2 } from "./provider-ingest";
import { loadTeamMatchStats, loadTeamMatchStatsV2 } from "./team-match-stats";
import { loadRetrospectiveTrainingExclusionsV2, loadTeamMatchStatsForTrainingV2 } from "./training/team-match-stats";
import { createLedgerDatabase, recordObservation, resultOnlyObservation } from "./test-support/ledger-fixtures";
import {
  attestTeam,
  attestedWorld,
  canonicalFixtureFor,
  ingestV2,
  operatorSql,
  revokeCompetition,
  revokeTeam,
  type AttestedWorld,
} from "./test-support/attestation-fixtures";
import { ingest, observationFrom, pgliteRpc, seedIngestIdentities, syntheticCapture, writeFootprint } from "./test-support/provider-ingest-fixtures";

/** V2 model-facing reads, trust-aware exclusions, reports and the recovery path (D-058), on SYNTHETIC data. */

const KICKOFF = "2026-08-15T18:00:00.000Z";
const CAPTURED = "2026-10-30T08:59:00.000Z";
const SEEN = "2026-10-30T09:00:00.000Z";
const LATER = "2026-10-30T10:00:00.000Z";
const NOW = "2026-10-31T00:00:00.000Z";
const TRAINING_CUTOFF = "2026-09-10T00:00:00.000Z";

const world = (db: PGlite, options: { attest?: boolean } = {}) => attestedWorld(db, { kickoffAt: KICKOFF, capturedAt: CAPTURED, ...options });
const rpc = (db: PGlite) => pgliteRpc(db) as never;

async function strictV2(db: PGlite, provider = "sportmonks", competitionIds: string[] | null = null) {
  return (await loadTeamMatchStatsV2(rpc(db), { provider, competitionIds, from: null, cutoff: NOW })).rows;
}
async function trainingV2(db: PGlite, trainingCutoff = TRAINING_CUTOFF, competitionIds: string[] | null = null) {
  return (await loadTeamMatchStatsForTrainingV2(rpc(db), { provider: "sportmonks", competitionIds, from: null, trainingCutoff })).rows;
}
async function exclusionsV2(db: PGlite, trainingCutoff = TRAINING_CUTOFF, competitionIds: string[] | null = null) {
  return loadRetrospectiveTrainingExclusionsV2(rpc(db), { provider: "sportmonks", competitionIds, from: null, trainingCutoff });
}
const fixturesOf = (rows: Array<{ fixture_id: string }>) => [...new Set(rows.map((r) => r.fixture_id))].sort();

async function recorded(db: PGlite, w: AttestedWorld) {
  const result = await ingestV2(db, w.observation(), SEEN);
  assert.equal(result.status, "recorded");
  return result;
}

test("V2 reads return attested V2 observations only: plain 1A writes, V1-ingested rows and providers without attestations yield nothing", async () => {
  const db = await createLedgerDatabase();
  const w = await world(db);
  const v2 = await recorded(db, w);
  assert.deepEqual(fixturesOf(await strictV2(db, "sportmonks", [w.seed.competitionId])), [v2.fixture_id]);
  // Training V2: version 1 of a finished backfill is backdated to kickoff + 24 h as in V1.
  const training = await trainingV2(db, TRAINING_CUTOFF, [w.seed.competitionId]);
  assert.deepEqual([training.length, training[0].availability_basis], [2, "retrospective_backfill"]);

  // A plain 1A Sportmonks write on attested teams: V1 shows it, V2 never does.
  const plainFixture = await canonicalFixtureFor(db, w.seed, "2026-08-01T18:00:00.000Z");
  await recordObservation(
    db,
    resultOnlyObservation({ fixtureId: plainFixture, providerFixtureId: "plain-1a" }, w.seed.homeTeamId, w.seed.awayTeamId, { kickoffAt: "2026-08-01T18:00:00.000Z", retrievedAt: SEEN, homeGoals: 1, awayGoals: 0 }),
    SEEN,
  );
  const v1Rows = (await loadTeamMatchStats(rpc(db), { provider: "sportmonks", competitionIds: [w.seed.competitionId], from: null, cutoff: NOW })).rows;
  assert.deepEqual(fixturesOf(v1Rows), [plainFixture, v2.fixture_id].sort());
  assert.deepEqual(fixturesOf(await strictV2(db, "sportmonks", [w.seed.competitionId])), [v2.fixture_id]);

  // A provider with no Stage 1 attestation system: zero V2 rows.
  const ifaFixture = await canonicalFixtureFor(db, w.seed, "2026-07-01T18:00:00.000Z");
  await recordObservation(
    db,
    resultOnlyObservation({ fixtureId: ifaFixture, providerFixtureId: "ifa-1" }, w.seed.homeTeamId, w.seed.awayTeamId, { kickoffAt: "2026-07-01T18:00:00.000Z", retrievedAt: SEEN, homeGoals: 2, awayGoals: 2, provider: "ifa" }),
    SEEN,
  );
  assert.equal((await loadTeamMatchStats(rpc(db), { provider: "ifa", competitionIds: null, from: null, cutoff: NOW })).rows.length, 2);
  assert.deepEqual(await strictV2(db, "ifa"), []);

  // An A2-A (V1) ingest with sealed refs but no attestation provenance is excluded too.
  const legacyIds = { leagueId: "8999", homeTeamId: "89998", awayTeamId: "89999" };
  const legacy = await seedIngestIdentities(db, legacyIds);
  const v1 = await ingest(db, observationFrom(syntheticCapture({ ...legacyIds, providerFixtureId: "28999999", playerIdBase: [8_800_000, 8_900_000], kickoffAt: KICKOFF, capturedAt: CAPTURED })), SEEN);
  assert.equal(v1.status, "recorded");
  assert.deepEqual(await strictV2(db, "sportmonks", [legacy.competitionId]), []);
  const reasons = (await exclusionsV2(db, TRAINING_CUTOFF, [legacy.competitionId])).map((e) => e.exclusion_reason);
  assert.deepEqual(reasons, ["attestation_missing"]);
  await db.close();
});

test("revocation removes a generation from V2 reads at once; an evidence refresh does not; re-attesting the same team never resurrects it", async () => {
  const db = await createLedgerDatabase();
  const w = await world(db);
  const v1 = await recorded(db, w);
  const only = [w.seed.competitionId];

  await attestTeam(db, w.ids.homeTeamId, w.seed.homeTeamId, { evidence: { contract_version: "kapiloto-provider-identity-attestation-evidence-v1", sources: ["synthetic:more"], reviewed_by: "r", duplicate_audit_sha256: "a".repeat(64) } });
  assert.equal((await strictV2(db, "sportmonks", only)).length, 2);

  await revokeTeam(db, w.ids.homeTeamId, w.seed.homeTeamId, "synthetic doubt");
  assert.deepEqual(await strictV2(db, "sportmonks", only), []);
  assert.deepEqual(await trainingV2(db, TRAINING_CUTOFF, only), []);
  assert.deepEqual((await exclusionsV2(db, TRAINING_CUTOFF, only)).map((e) => [e.exclusion_reason, e.selected_observation_id]), [["generation_revoked", v1.observation_id]]);
  let conflicts = (await loadProviderRefConflictsV2(rpc(db), "sportmonks")).filter((c) => c.observation_id === v1.observation_id);
  assert.deepEqual(conflicts.map((c) => c.issue_code), ["team_attestation_missing"]);

  await attestTeam(db, w.ids.homeTeamId, w.seed.homeTeamId);
  assert.deepEqual(await strictV2(db, "sportmonks", only), []);
  assert.deepEqual((await exclusionsV2(db, TRAINING_CUTOFF, only)).map((e) => e.exclusion_reason), ["attestation_generation_stale"]);
  conflicts = (await loadProviderRefConflictsV2(rpc(db), "sportmonks")).filter((c) => c.observation_id === v1.observation_id);
  assert.deepEqual(conflicts.map((c) => [c.issue_code, c.ref_kind]), [["team_attestation_generation_stale", "team_home"]]);

  // A competition revoke excludes the same way.
  const c = await world(db);
  const cv1 = await recorded(db, c);
  const cOnly = [c.seed.competitionId];
  assert.equal((await strictV2(db, "sportmonks", cOnly)).length, 2);
  await revokeCompetition(db, c.ids.leagueId, c.seed.competitionId, "synthetic doubt");
  assert.deepEqual(await strictV2(db, "sportmonks", cOnly), []);
  assert.deepEqual((await exclusionsV2(db, TRAINING_CUTOFF, cOnly)).map((e) => [e.exclusion_reason, e.selected_observation_id]), [["generation_revoked", cv1.observation_id]]);
  assert.deepEqual(
    (await loadProviderRefConflictsV2(rpc(db), "sportmonks")).filter((x) => x.observation_id === cv1.observation_id).map((x) => [x.issue_code, x.ref_kind]),
    [["competition_attestation_missing", "league"]],
  );
  await db.close();
});

test("the current mapping must stay an agreeing manual_override row: demotion, deletion + V3 reinsert and re-pointing all exclude", async () => {
  const db = await createLedgerDatabase();
  const w = await world(db);
  await recorded(db, w);
  const only = [w.seed.competitionId];

  await operatorSql(db, "update public.provider_team_mappings set mapping_status = 'confirmed' where provider = 'sportmonks' and provider_team_id = $1", [w.ids.awayTeamId]);
  assert.deepEqual(await strictV2(db, "sportmonks", only), []);
  assert.deepEqual((await exclusionsV2(db, TRAINING_CUTOFF, only)).map((e) => e.exclusion_reason), ["mapping_not_manual_override"]);
  // Re-promotion by an operator restores the rows: the generation never changed.
  await operatorSql(db, "update public.provider_team_mappings set mapping_status = 'manual_override' where provider = 'sportmonks' and provider_team_id = $1", [w.ids.awayTeamId]);
  assert.equal((await strictV2(db, "sportmonks", only)).length, 2);

  await db.query("delete from public.provider_team_mappings where provider = 'sportmonks' and provider_team_id = $1", [w.ids.awayTeamId]);
  assert.deepEqual(await strictV2(db, "sportmonks", only), []);
  assert.deepEqual((await exclusionsV2(db, TRAINING_CUTOFF, only)).map((e) => e.exclusion_reason), ["mapping_missing"]);
  await db.query("insert into public.provider_team_mappings (provider, provider_team_id, team_id, mapping_status, mapping_confidence) values ('sportmonks', $1, $2, 'confirmed', 0.9)", [w.ids.awayTeamId, w.seed.awayTeamId]);
  assert.deepEqual(await strictV2(db, "sportmonks", only), []);
  assert.deepEqual((await exclusionsV2(db, TRAINING_CUTOFF, only)).map((e) => e.exclusion_reason), ["mapping_not_manual_override"]);

  const other = (await db.query<{ id: string }>("insert into public.teams (canonical_name) values ('Synthetic Elsewhere') returning id")).rows[0].id;
  await operatorSql(db, "update public.provider_team_mappings set team_id = $2, mapping_status = 'manual_override' where provider = 'sportmonks' and provider_team_id = $1", [w.ids.awayTeamId, other]);
  assert.deepEqual((await exclusionsV2(db, TRAINING_CUTOFF, only)).map((e) => e.exclusion_reason), ["mapping_disagrees"]);
  await db.close();
});

test("trust-aware exclusions keep the V1 supersession reasons; a recovered later version is not backdated by availability policy V1", async () => {
  const db = await createLedgerDatabase();
  const w = await world(db);
  const v1 = await recorded(db, w);
  const only = [w.seed.competitionId];

  // Revoke + re-attest, then the explicit recovery: withdraw and re-ingest.
  await revokeTeam(db, w.ids.homeTeamId, w.seed.homeTeamId, "synthetic doubt");
  await attestTeam(db, w.ids.homeTeamId, w.seed.homeTeamId);
  await recordObservation(
    db,
    buildMatchLedgerWithdrawalPayload({ fixtureId: v1.fixture_id!, provider: "sportmonks", providerFixtureId: w.providerFixtureId, captureMode: "backfill", ingestVersion: "test", retrievedAt: LATER, withdrawalReason: "attestation recovery" }),
    LATER,
  );
  const recoveredAt = "2026-10-30T12:00:00.000Z";
  const v3 = await ingestV2(db, w.observation(), recoveredAt);
  assert.deepEqual([v3.status, v3.observation_version, v3.fixture_id], ["recorded", 3, v1.fixture_id]);

  // Before the recovery, training sees nothing: v1 is superseded (and untrusted), v3 is
  // not backdated - only version 1 ever is under kapiloto-retrospective-training-availability-v1.
  assert.deepEqual(await trainingV2(db, TRAINING_CUTOFF, only), []);
  assert.deepEqual((await exclusionsV2(db, TRAINING_CUTOFF, only)).map((e) => [e.exclusion_reason, e.selected_observation_version, e.latest_observation_version]), [["later_correction", 1, 3]]);
  const after = await trainingV2(db, recoveredAt, only);
  assert.deepEqual([after.length, after[0].observation_id, after[0].availability_basis, new Date(after[0].effective_available_at).toISOString()], [2, v3.observation_id, "actual", recoveredAt]);
  assert.deepEqual(fixturesOf(await strictV2(db, "sportmonks", only)), [v1.fixture_id]);
  await db.close();
});

test("entity readiness report works with zero observations and reports every blocking code", async () => {
  const db = await createLedgerDatabase();
  const w = await world(db);
  const report = async () => loadProviderIdentityAttestationConflicts(rpc(db), "sportmonks");
  const scope = { teams: [w.ids.homeTeamId, w.ids.awayTeamId], competitions: [w.ids.leagueId] };
  assert.equal((await db.query("select 1 from public.match_ledger_observations")).rows.length, 0);
  assert.deepEqual(blockingAttestationConflicts(await report(), scope), []);

  // Unattested mappings are the informational worklist.
  await db.query("insert into public.provider_team_mappings (provider, provider_team_id, team_id, mapping_status) values ('sportmonks', 'worklist-1', $1, 'manual_override')", [
    (await db.query<{ id: string }>("insert into public.teams (canonical_name) values ('Synthetic Worklist') returning id")).rows[0].id,
  ]);
  assert.ok((await report()).some((c) => c.issue_code === "mapping_unattested" && c.severity === "info" && c.provider_ref === "worklist-1"));

  // A V3-style shadow mapping for an attested canonical team: blocking unless unverified.
  await db.query("insert into public.provider_team_mappings (provider, provider_team_id, team_id, mapping_status, mapping_confidence) values ('sportmonks', 'shadow-9', $1, 'confirmed', 0.9)", [w.seed.homeTeamId]);
  let blocking = blockingAttestationConflicts(await report(), scope);
  assert.deepEqual(blocking.map((c) => [c.issue_code, c.provider_ref, c.related_provider_ref]), [["shadow_mapping_for_attested_canonical", w.ids.homeTeamId, "shadow-9"]]);
  await operatorSql(db, "update public.provider_team_mappings set mapping_status = 'unverified' where provider = 'sportmonks' and provider_team_id = 'shadow-9'");
  assert.ok((await report()).some((c) => c.issue_code === "shadow_mapping_for_attested_canonical" && c.severity === "warning"));
  assert.deepEqual(blockingAttestationConflicts(await report(), scope), []);

  await operatorSql(db, "update public.provider_team_mappings set mapping_status = 'confirmed' where provider = 'sportmonks' and provider_team_id = $1", [w.ids.homeTeamId]);
  const other = (await db.query<{ id: string }>("insert into public.teams (canonical_name) values ('Synthetic Disagree') returning id")).rows[0].id;
  await operatorSql(db, "update public.provider_team_mappings set team_id = $2 where provider = 'sportmonks' and provider_team_id = $1", [w.ids.awayTeamId, other]);
  await db.query("delete from public.provider_competition_mappings where provider = 'sportmonks' and provider_competition_id = $1", [w.ids.leagueId]);
  blocking = blockingAttestationConflicts(await report(), scope);
  assert.deepEqual(blocking.map((c) => [c.entity_kind, c.provider_ref, c.issue_code]).sort(), [
    ["competition", w.ids.leagueId, "attested_mapping_missing"],
    ["team", w.ids.awayTeamId, "attested_mapping_disagrees"],
    ["team", w.ids.homeTeamId, "attested_mapping_not_manual_override"],
  ].sort());
  await db.close();
});

test("revocation impact lists sealed observations by generation state, their fixture mappings and mints, and the unattested writes V2 already excludes", async () => {
  const db = await createLedgerDatabase();
  const w = await world(db);
  const v1 = await recorded(db, w);
  const plainFixture = await canonicalFixtureFor(db, w.seed, "2026-08-01T18:00:00.000Z");
  const plain = await recordObservation(
    db,
    resultOnlyObservation({ fixtureId: plainFixture, providerFixtureId: "plain-impact" }, w.seed.homeTeamId, w.seed.awayTeamId, { kickoffAt: "2026-08-01T18:00:00.000Z", retrievedAt: SEEN, homeGoals: 0, awayGoals: 0 }),
    SEEN,
  );
  const impact = () => loadProviderIdentityRevocationImpact(rpc(db), { provider: "sportmonks", entityKind: "team", providerRef: w.ids.homeTeamId });
  let rows = await impact();
  const kinds = (rs: typeof rows) => rs.map((r) => [r.impact_kind, r.observation_id ?? r.fixture_id, r.generation_state]);
  assert.deepEqual(kinds(rows), [
    ["fixture_mapping", v1.fixture_id, null],
    ["fixture_mint", v1.fixture_id, null],
    ["observation_under_generation", v1.observation_id, "active"],
    ["unattested_observation", plain.observation_id, null],
  ]);
  assert.equal(rows.find((r) => r.impact_kind === "observation_under_generation")!.is_latest_version, true);

  await revokeTeam(db, w.ids.homeTeamId, w.seed.homeTeamId);
  rows = await impact();
  assert.equal(rows.find((r) => r.impact_kind === "observation_under_generation")!.generation_state, "revoked");
  await assert.rejects(loadProviderIdentityRevocationImpact(rpc(db), { provider: "sportmonks", entityKind: "player" as never, providerRef: "x" }), /team or competition/);
  await db.close();
});

test("synthetic recovery: a wrong attestation is revoked, its chain withdrawn and mapping repaired, the right team attested, and V2 then holds only the corrected chain", async () => {
  const db = await createLedgerDatabase();
  const w = await world(db, { attest: false });
  // The canonical row the provider team really is, with a Toto-style fixture already present.
  const real = (await db.query<{ id: string }>("insert into public.teams (canonical_name) values ('Synthetic Real Home') returning id")).rows[0].id;
  const realFixture = (await db.query<{ id: string }>(
    "insert into public.fixtures (competition_id, home_team_id, away_team_id, kickoff_at, status) values ($1, $2, $3, $4, 'finished') returning id",
    [w.seed.competitionId, real, w.seed.awayTeamId, KICKOFF],
  )).rows[0].id;
  // Mistake: the home provider id was mapped and attested to a duplicate canonical row.
  const { attestCompetition } = await import("./test-support/attestation-fixtures");
  await attestCompetition(db, w.ids.leagueId, w.seed.competitionId);
  await attestTeam(db, w.ids.homeTeamId, w.seed.homeTeamId);
  await attestTeam(db, w.ids.awayTeamId, w.seed.awayTeamId);
  const wrong = await ingestV2(db, w.observation(), SEEN);
  assert.deepEqual([wrong.status, wrong.fixture_resolution], ["recorded", "minted"]);
  const only = [w.seed.competitionId];

  // 1. revoke; V2 reads are safe immediately.
  await revokeTeam(db, w.ids.homeTeamId, w.seed.homeTeamId, "attested to a duplicate canonical team");
  assert.deepEqual(await strictV2(db, "sportmonks", only), []);
  // 2. impact.
  const impact = await loadProviderIdentityRevocationImpact(rpc(db), { provider: "sportmonks", entityKind: "team", providerRef: w.ids.homeTeamId });
  assert.deepEqual(impact.map((r) => r.impact_kind).sort(), ["fixture_mapping", "fixture_mint", "observation_under_generation"]);
  // 3. withdraw the affected chain (immutable 1A withdrawal).
  await recordObservation(
    db,
    buildMatchLedgerWithdrawalPayload({ fixtureId: wrong.fixture_id!, provider: "sportmonks", providerFixtureId: w.providerFixtureId, captureMode: "backfill", ingestVersion: "test", retrievedAt: LATER, withdrawalReason: "wrong team identity" }),
    LATER,
  );
  // 4. remove the provider fixture mapping that points at the wrong mint (expected old value in the predicate).
  await operatorSql(db, "delete from public.provider_fixture_mappings where provider = 'sportmonks' and provider_fixture_id = $1 and fixture_id = $2", [w.providerFixtureId, wrong.fixture_id]);
  // 5. correct the team mapping in its own transaction; 6. attest the right team (new generation).
  await operatorSql(db, "update public.provider_team_mappings set team_id = $2 where provider = 'sportmonks' and provider_team_id = $1 and team_id = $3", [w.ids.homeTeamId, real, w.seed.homeTeamId]);
  await attestTeam(db, w.ids.homeTeamId, real);
  // 7. re-ingest under the allow-listed run: it attaches to the real fixture.
  const fixed = await ingestV2(db, w.observation({}, { mint: false }), "2026-10-30T12:00:00.000Z");
  assert.deepEqual([fixed.status, fixed.fixture_resolution, fixed.fixture_id, fixed.observation_version], ["recorded", "attached", realFixture, 1]);
  // 8. V2 holds only the corrected chain; current-version reports and the entity report are clean.
  const rows = await strictV2(db, "sportmonks", only);
  assert.deepEqual([fixturesOf(rows), rows.find((r) => r.side === "home")!.team_id], [[realFixture], real]);
  assert.deepEqual((await trainingV2(db, TRAINING_CUTOFF, only)).map((r) => r.fixture_id), [realFixture, realFixture]);
  const current = (await loadProviderRefConflictsV2(rpc(db), "sportmonks")).filter((c) => c.is_current_version);
  assert.deepEqual(current, []);
  assert.deepEqual(blockingAttestationConflicts(await loadProviderIdentityAttestationConflicts(rpc(db), "sportmonks"), { teams: [w.ids.homeTeamId, w.ids.awayTeamId], competitions: [w.ids.leagueId] }), []);
  await db.close();
});

test("recovery limit: a wrongly MINTED chain is never re-minted under the same provider fixture id; it quarantines fixture_mint_exists, the orphan mint is reported, and attaching to a reviewed canonical fixture recovers it", async () => {
  const db = await createLedgerDatabase();
  const w = await world(db, { attest: false });
  const real = (await db.query<{ id: string }>("insert into public.teams (canonical_name) values ('Synthetic Real Home 2') returning id")).rows[0].id;
  const { attestCompetition } = await import("./test-support/attestation-fixtures");
  await attestCompetition(db, w.ids.leagueId, w.seed.competitionId);
  await attestTeam(db, w.ids.homeTeamId, w.seed.homeTeamId);
  await attestTeam(db, w.ids.awayTeamId, w.seed.awayTeamId);
  const wrong = await ingestV2(db, w.observation(), SEEN);
  await revokeTeam(db, w.ids.homeTeamId, w.seed.homeTeamId);
  await recordObservation(
    db,
    buildMatchLedgerWithdrawalPayload({ fixtureId: wrong.fixture_id!, provider: "sportmonks", providerFixtureId: w.providerFixtureId, captureMode: "backfill", ingestVersion: "test", retrievedAt: LATER, withdrawalReason: "wrong team identity" }),
    LATER,
  );
  await operatorSql(db, "delete from public.provider_fixture_mappings where provider = 'sportmonks' and provider_fixture_id = $1 and fixture_id = $2", [w.providerFixtureId, wrong.fixture_id]);
  await operatorSql(db, "update public.provider_team_mappings set team_id = $2 where provider = 'sportmonks' and provider_team_id = $1", [w.ids.homeTeamId, real]);
  await attestTeam(db, w.ids.homeTeamId, real);
  // No correct canonical fixture exists, so the re-ingest would have to mint
  // again; the applied A2-A mint provenance allows one mint per provider
  // fixture id. V2 quarantines (audited, nothing written) instead of raising.
  const before = await writeFootprint(db);
  const blocked = await ingestV2(db, w.observation(), "2026-10-30T12:00:00.000Z");
  assert.deepEqual([blocked.status, blocked.reason_code], ["quarantined", "fixture_mint_exists"]);
  assert.deepEqual(await writeFootprint(db), before);
  const detail = (await db.query<{ detail: { minted_fixture_id: string } }>("select detail from public.provider_ingest_items where reason_code = 'fixture_mint_exists'")).rows[0].detail;
  assert.equal(detail.minted_fixture_id, wrong.fixture_id);
  // The readiness report shows the orphaned mint as a warning until recovery completes.
  const orphan = (await loadProviderIdentityAttestationConflicts(rpc(db), "sportmonks")).filter((c) => c.issue_code === "mint_without_mapping");
  assert.deepEqual(orphan.map((c) => [c.severity, c.entity_kind, c.provider_ref, c.mapping_canonical_id]), [["warning", "fixture", w.providerFixtureId, wrong.fixture_id]]);
  assert.deepEqual(blockingAttestationConflicts(await loadProviderIdentityAttestationConflicts(rpc(db), "sportmonks"), { teams: [w.ids.homeTeamId, w.ids.awayTeamId], competitions: [w.ids.leagueId] }), []);

  // Recovery: the operator creates the reviewed canonical fixture; the re-ingest attaches.
  const reviewedFixture = (await db.query<{ id: string }>(
    "insert into public.fixtures (competition_id, home_team_id, away_team_id, kickoff_at, status) values ($1, $2, $3, $4, 'finished') returning id",
    [w.seed.competitionId, real, w.seed.awayTeamId, KICKOFF],
  )).rows[0].id;
  const fixed = await ingestV2(db, w.observation({}, { mint: false }), "2026-10-30T13:00:00.000Z");
  assert.deepEqual([fixed.status, fixed.fixture_resolution, fixed.fixture_id], ["recorded", "attached", reviewedFixture]);
  assert.deepEqual(fixturesOf(await strictV2(db, "sportmonks", [w.seed.competitionId])), [reviewedFixture]);
  // The orphan mint stays reported until an operator decision about the orphan row itself.
  assert.equal((await loadProviderIdentityAttestationConflicts(rpc(db), "sportmonks")).filter((c) => c.issue_code === "mint_without_mapping").length, 1);
  await db.close();
});
