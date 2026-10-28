import assert from "node:assert/strict";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import type { CanonicalClaimRow, ClaimInput, ClaimResolutionAsOfRow, ClaimSupportAsOfRow } from "./claims";
import { createFixture, createLedgerDatabase, seedLedger } from "./test-support/ledger-fixtures";
import {
  addObservation,
  articleInput,
  basePrediction,
  recordClaim,
  recordDocument,
  recordPrediction,
  recordResolution,
} from "./test-support/knowledge-fixtures";

/**
 * Canonical claims after identity merges (kapiloto-canonical-claim-v1): raw
 * claims stay immutable, predictions stay frozen, and the current canonical
 * proposition follows D-050 survivor semantics.
 */

const KICKOFF = "2026-11-02T18:00:00.000Z";
const OCT_28 = "2026-10-28T09:00:00.000Z";
const OCT_29 = "2026-10-29T09:00:00.000Z";
const NOV_1 = "2026-11-01T00:00:00.000Z";

const playerId = (n: number) => `63000000-0000-4000-8000-0000000c${String(n).padStart(4, "0")}`;
const coachId = (n: number) => `62000000-0000-4000-8000-0000000c${String(n).padStart(4, "0")}`;

async function count(db: PGlite, table: string): Promise<number> {
  return (await db.query<{ n: number }>(`select count(*)::int as n from public.${table}`)).rows[0].n;
}

const canonical = async (db: PGlite, ids: string[]) =>
  (await db.query<CanonicalClaimRow>("select * from public.knowledge_canonical_claims($1)", [ids])).rows;
const resolutionsAsOf = async (db: PGlite, ids: string[], cutoff: string) =>
  (await db.query<ClaimResolutionAsOfRow>("select * from public.knowledge_claim_resolutions_as_of($1, $2)", [ids, cutoff])).rows;
const support = async (db: PGlite, id: string, cutoff: string) =>
  (await db.query<ClaimSupportAsOfRow>("select * from public.knowledge_claim_support_as_of($1, $2)", [id, cutoff])).rows;

async function setup() {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  const fixture = await createFixture(db, seed, KICKOFF);
  const availability = (player: string, status: string): ClaimInput => ({
    claimKind: "reported_expectation",
    claimType: "player_availability",
    predicate: "availability_status",
    fixtureId: fixture.fixtureId,
    playerId: player,
    objectValue: { status },
    temporalScope: "fixture",
  });
  const formationChange = (coach: string, to: string): ClaimInput => ({
    claimKind: "reported_expectation",
    claimType: "formation_change",
    predicate: "changes_formation",
    fixtureId: fixture.fixtureId,
    teamId: seed.home.teamId,
    coachId: coach,
    objectValue: { to },
    temporalScope: "fixture",
  });
  return { db, seed, fixture, availability, formationChange };
}

test("after A -> B the same proposition via B is the existing claim; different propositions stay distinct", async () => {
  const { db, seed, fixture, availability, formationChange } = await setup();
  const a = playerId(1);
  const b = seed.home.playerIds[10];
  const coachA = coachId(1);
  const coachB = seed.home.coachId;
  await db.query("insert into public.players (id, canonical_name) values ($1, 'Striker (duplicate record)')", [a]);
  await db.query("insert into public.coaches (id, canonical_name) values ($1, 'Coach (duplicate record)')", [coachA]);

  // Before the merge: claims about A and coach A, evidence, a resolution and
  // a live prediction that uses them.
  const aboutA = await recordClaim(db, availability(a, "doubtful"), OCT_28);
  const aboutCoachA = await recordClaim(db, formationChange(coachA, "5-3-2"), OCT_28);
  const doc = await recordDocument(db, articleInput(), OCT_28);
  const observation = await addObservation(db, { claimId: aboutA.claim_id, documentVersionId: doc.document_version_id, relationship: "supports" }, OCT_28);
  const resolution = await recordResolution(db, {
    claimId: aboutA.claim_id,
    status: "verified_degraded",
    resolverKind: "grounding",
    resolverVersion: "g1",
    reasonCode: "metadata_incomplete",
    qualityFlags: ["missing_author"],
    evidence: [{ evidenceRole: "supporting", claimObservationId: observation.id }],
  }, OCT_29);
  const live = await recordPrediction(db, basePrediction(fixture.fixtureId, {
    purpose: "production",
    inputs: {
      claims: [{ claimId: aboutA.claim_id, resolutionId: resolution.resolution_id }],
      identities: [
        { entityType: "player", entityId: a, bindingRole: "doubtful_starter" },
        { entityType: "coach", entityId: coachA, bindingRole: "home_head_coach" },
      ],
    },
  }), "2026-10-30T12:10:00.000Z");

  await db.query("update public.players set identity_status = 'merged', merged_into_player_id = $2 where id = $1", [a, b]);
  await db.query("update public.coaches set identity_status = 'merged', merged_into_coach_id = $2 where id = $1", [coachA, coachB]);
  const claimsBefore = await count(db, "knowledge_claims");

  // The same structured proposition via the survivor is the existing claim.
  const viaB = await recordClaim(db, availability(b, "doubtful"), NOV_1);
  assert.deepEqual([viaB.status, viaB.claim_id, viaB.member_claim_ids, viaB.collision], ["existing", aboutA.claim_id, [aboutA.claim_id], false]);
  const viaCoachB = await recordClaim(db, formationChange(coachB, "5-3-2"), NOV_1);
  assert.deepEqual([viaCoachB.status, viaCoachB.claim_id], ["existing", aboutCoachA.claim_id]);
  assert.equal(await count(db, "knowledge_claims"), claimsBefore);
  // A merged id is still refused as a write, not matched.
  await assert.rejects(recordClaim(db, availability(a, "doubtful"), NOV_1), /claims reference surviving canonical ids/);

  // Genuinely different propositions do not collapse.
  const out = await recordClaim(db, availability(b, "out"), NOV_1);
  const otherFixture = await createFixture(db, seed, "2026-11-09T18:00:00.000Z");
  const otherMatch = await recordClaim(db, { ...availability(b, "doubtful"), fixtureId: otherFixture.fixtureId }, NOV_1);
  const otherFormation = await recordClaim(db, formationChange(coachB, "4-4-2"), NOV_1);
  for (const result of [out, otherMatch, otherFormation]) assert.equal(result.status, "recorded");
  assert.equal(await count(db, "knowledge_claims"), claimsBefore + 3);

  // Model-facing reads follow the survivor; the raw claim is unchanged.
  assert.deepEqual(await canonical(db, [aboutA.claim_id]), [{ claim_id: aboutA.claim_id, canonical_claim_id: aboutA.claim_id, member_claim_ids: [aboutA.claim_id], collision: false }]);
  const belief = await resolutionsAsOf(db, [aboutA.claim_id], NOV_1);
  assert.deepEqual(belief.map((r) => [r.status, r.resolution_claim_id]), [["verified_degraded", aboutA.claim_id]]);
  const raw = await db.query("select player_id from public.knowledge_claims where id = $1", [aboutA.claim_id]);
  assert.deepEqual(raw.rows, [{ player_id: a }]);

  // The prediction recorded before the merge is exactly as it was.
  const inputs = await db.query("select claim_id, resolution_id, resolution_status from public.prediction_claim_inputs where snapshot_id = $1", [live.snapshot_id]);
  assert.deepEqual(inputs.rows, [{ claim_id: aboutA.claim_id, resolution_id: resolution.resolution_id, resolution_status: "verified_degraded" }]);
  const bindings = await db.query("select entity_type, player_id, coach_id from public.prediction_identity_bindings where snapshot_id = $1 order by entity_type", [live.snapshot_id]);
  assert.deepEqual(bindings.rows, [{ entity_type: "coach", player_id: null, coach_id: coachA }, { entity_type: "player", player_id: a, coach_id: null }]);
  await db.close();
});

test("two pre-merge claims that become one proposition are a visible, deterministic collision", async () => {
  const { db, availability } = await setup();
  const x = playerId(2);
  const y = playerId(3);
  await db.query("insert into public.players (id, canonical_name) values ($1, 'Winger X'), ($2, 'Winger Y')", [x, y]);
  const aboutX = await recordClaim(db, availability(x, "doubtful"), OCT_28);
  const aboutY = await recordClaim(db, availability(y, "doubtful"), "2026-10-28T10:00:00.000Z");
  assert.notEqual(aboutX.claim_id, aboutY.claim_id);
  const docX = await recordDocument(db, articleInput({ extractedText: "X is doubtful." }), OCT_28);
  const docY = await recordDocument(db, articleInput({ extractedText: "Y is doubtful." }), "2026-10-28T10:00:00.000Z");
  const obsX = await addObservation(db, { claimId: aboutX.claim_id, documentVersionId: docX.document_version_id, relationship: "supports" }, OCT_28);
  const obsY = await addObservation(db, { claimId: aboutY.claim_id, documentVersionId: docY.document_version_id, relationship: "supports" }, "2026-10-28T10:00:00.000Z");
  await recordResolution(db, { claimId: aboutX.claim_id, status: "unresolved", resolverKind: "grounding", resolverVersion: "g1", reasonCode: "single_report" }, "2026-10-28T11:00:00.000Z");
  const verifiedY = await recordResolution(db, {
    claimId: aboutY.claim_id,
    status: "verified",
    resolverKind: "grounding",
    resolverVersion: "g1",
    reasonCode: "official_squad_announcement",
    evidence: [{ evidenceRole: "supporting", claimObservationId: obsY.id }],
  }, OCT_29);

  // The duplicate is discovered: the merge is not blocked by the claims.
  await db.query("update public.players set identity_status = 'merged', merged_into_player_id = $2 where id = $1", [x, y]);

  // Both raw claims remain; the group is exposed with a deterministic
  // representative (earliest first seen).
  const group = [aboutX.claim_id, aboutY.claim_id];
  assert.deepEqual(await canonical(db, [aboutY.claim_id, aboutX.claim_id]), [
    { claim_id: aboutX.claim_id, canonical_claim_id: aboutX.claim_id, member_claim_ids: group, collision: true },
    { claim_id: aboutY.claim_id, canonical_claim_id: aboutX.claim_id, member_claim_ids: group, collision: true },
  ].sort((l, r) => l.claim_id.localeCompare(r.claim_id)));
  const viaY = await recordClaim(db, availability(y, "doubtful"), NOV_1);
  assert.deepEqual([viaY.status, viaY.claim_id, viaY.member_claim_ids, viaY.collision], ["existing", aboutX.claim_id, group, true]);
  assert.equal(await count(db, "knowledge_claims"), 2);

  // The belief is the latest adjudication of any member, with provenance.
  const afterVerified = await resolutionsAsOf(db, [aboutX.claim_id], NOV_1);
  assert.deepEqual(afterVerified.map((r) => [r.canonical_claim_id, r.member_claim_ids, r.status, r.resolution_id, r.resolution_claim_id]), [
    [aboutX.claim_id, group, "verified", verifiedY.resolution_id, aboutY.claim_id],
  ]);
  // Information time still governs: before Y's verification only X's
  // unresolved adjudication was visible, and before Y existed only X counts.
  assert.deepEqual((await resolutionsAsOf(db, [aboutY.claim_id], "2026-10-28T12:00:00.000Z")).map((r) => [r.status, r.resolution_claim_id]), [["unresolved", aboutX.claim_id]]);
  assert.deepEqual((await resolutionsAsOf(db, [aboutY.claim_id], "2026-10-28T09:30:00.000Z")).map((r) => r.member_claim_ids), [[aboutX.claim_id]]);
  // Support aggregates the proposition across members.
  assert.deepEqual((await support(db, aboutX.claim_id, NOV_1)).map((r) => [r.relationship, r.observation_count, r.document_count, r.independent_source_count]), [["supports", 2, 2, 2]]);
  assert.ok(obsX.id);
  await db.close();
});
