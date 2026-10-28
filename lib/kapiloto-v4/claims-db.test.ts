import assert from "node:assert/strict";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import type { ClaimInput, ClaimResolutionAsOfRow, ClaimSupportAsOfRow } from "./claims";
import { buildClaimPayload, buildClaimResolutionPayload } from "./claims";
import {
  createFixture,
  createLedgerDatabase,
  realisticObservation,
  recordObservation,
  seedLedger,
  setClock,
  type LedgerSeed,
} from "./test-support/ledger-fixtures";
import {
  addObservation,
  articleInput,
  recordClaim,
  recordDocument,
  recordResolution,
} from "./test-support/knowledge-fixtures";

const OCT_28 = "2026-10-28T09:00:00.000Z";
const OCT_29 = "2026-10-29T09:00:00.000Z";
const OCT_30 = "2026-10-30T12:00:00.000Z";
const NOV_2_KICKOFF = "2026-11-02T18:00:00.000Z";

async function setup() {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  const fixture = await createFixture(db, seed, NOV_2_KICKOFF);
  return { db, seed, fixture };
}

const availability = (seed: LedgerSeed, fixtureId: string, status: string): ClaimInput => ({
  claimKind: "reported_expectation",
  claimType: "player_availability",
  predicate: "availability_status",
  fixtureId,
  playerId: seed.home.playerIds[10],
  teamId: seed.home.teamId,
  objectValue: { status },
  temporalScope: "fixture",
  statementText: `Striker is ${status} for Monday`,
});

async function resolutionsAsOf(db: PGlite, claimIds: string[], cutoff: string): Promise<ClaimResolutionAsOfRow[]> {
  return (await db.query<ClaimResolutionAsOfRow>("select * from public.knowledge_claim_resolutions_as_of($1, $2)", [claimIds, cutoff])).rows;
}

async function support(db: PGlite, claimId: string, cutoff: string): Promise<Record<string, Omit<ClaimSupportAsOfRow, "relationship">>> {
  const rows = (await db.query<ClaimSupportAsOfRow>("select * from public.knowledge_claim_support_as_of($1, $2)", [claimId, cutoff])).rows;
  return Object.fromEntries(rows.map(({ relationship, ...counts }) => [relationship, counts]));
}

test("claims are deduplicated by structured proposition, never by prose", async () => {
  const { db, seed, fixture } = await setup();
  const first = await recordClaim(db, availability(seed, fixture.fixtureId, "doubtful"), OCT_28);
  assert.equal(first.status, "recorded");
  // Different wording, same structured proposition: the same claim.
  const reworded = await recordClaim(db, { ...availability(seed, fixture.fixtureId, "doubtful"), statementText: "Big doubt over the No. 9" }, OCT_29);
  assert.deepEqual([reworded.status, reworded.claim_id], ["existing", first.claim_id]);

  // Similar prose, different propositions: distinct claims.
  const distinct = [];
  for (const variant of [
    availability(seed, fixture.fixtureId, "out"),
    { ...availability(seed, fixture.fixtureId, "doubtful"), polarity: "negated" as const },
    { ...availability(seed, fixture.fixtureId, "doubtful"), playerId: seed.home.playerIds[9] },
    { ...availability(seed, fixture.fixtureId, "doubtful"), claimKind: "observed_fact" as const },
  ]) {
    distinct.push(await recordClaim(db, variant, OCT_29));
  }
  assert.equal(new Set([first.claim_id, ...distinct.map((r) => r.claim_id)]).size, 5);

  // Claims need a subject and reference surviving canonical ids.
  await assert.rejects(recordClaim(db, { ...availability(seed, fixture.fixtureId, "doubtful"), fixtureId: null, playerId: null, teamId: null, temporalScope: "ongoing" }, OCT_29), /check constraint/);
  await db.query("update public.players set identity_status = 'merged', merged_into_player_id = $2 where id = $1", [seed.home.playerIds[16], seed.home.playerIds[15]]);
  await assert.rejects(recordClaim(db, { ...availability(seed, fixture.fixtureId, "fit"), playerId: seed.home.playerIds[16] }, OCT_29), /claims reference surviving canonical ids/);
  await assert.rejects(db.query("update public.knowledge_claims set statement_text = 'x'"), /immutable/);
  await db.close();
});

test("observations from several documents support or contradict one claim; syndication is one source", async () => {
  const { db, seed, fixture } = await setup();
  const claim = await recordClaim(db, availability(seed, fixture.fixtureId, "doubtful"), OCT_28);
  const wire = await recordDocument(db, articleInput({ syndicationCluster: "wire:ifa-1" }), OCT_28);
  const reprint = await recordDocument(db, articleInput({ canonicalUrl: "https://www.one.co.il/a/1", domain: "one.co.il", publisher: "ONE", syndicationCluster: "wire:ifa-1" }), OCT_28);
  const exactCopy = await recordDocument(db, articleInput({ canonicalUrl: "https://www.walla.co.il/a/1", domain: "walla.co.il", publisher: "Walla" }), OCT_28);
  const independent = await recordDocument(db, articleInput({ canonicalUrl: "https://www.ynet.co.il/a/9", domain: "ynet.co.il", publisher: "ynet", extractedText: "Our reporter at training saw the striker limp; he is doubtful." }), OCT_28);
  const denial = await recordDocument(db, articleInput({ canonicalUrl: "https://www.hapoel.co.il/news/1", sourceKind: "official_announcement", domain: "hapoel.co.il", publisher: "Hapoel", extractedText: "The striker is fully fit and available." }), OCT_29);

  const quoted = await addObservation(db, { claimId: claim.claim_id, documentVersionId: wire.document_version_id, relationship: "supports", quote: "the striker is doubtful for Monday" }, OCT_28);
  assert.equal(quoted.quote_found, true);
  await addObservation(db, { claimId: claim.claim_id, documentVersionId: reprint.document_version_id, relationship: "supports" }, OCT_28);
  await addObservation(db, { claimId: claim.claim_id, documentVersionId: exactCopy.document_version_id, relationship: "supports" }, OCT_28);
  const own = await addObservation(db, { claimId: claim.claim_id, documentVersionId: independent.document_version_id, relationship: "supports", quote: "he will definitely miss the season" }, OCT_28);
  // An invented quote is recorded as such (fabrication review signal).
  assert.equal(own.quote_found, false);
  await addObservation(db, { claimId: claim.claim_id, documentVersionId: denial.document_version_id, relationship: "contradicts" }, OCT_29);

  // Four supporting documents, but the wire story, its labeled reprint and
  // its unlabeled exact copy are one source: two independent sources.
  assert.deepEqual(await support(db, claim.claim_id, OCT_28), {
    supports: { observation_count: 4, document_count: 4, independent_source_count: 2 },
  });
  // The contradiction coexists and is invisible before it was seen.
  assert.deepEqual((await support(db, claim.claim_id, OCT_30)).contradicts, { observation_count: 1, document_count: 1, independent_source_count: 1 });

  // Re-extraction by the same extractor is idempotent; rights gate quotes.
  await assert.rejects(addObservation(db, { claimId: claim.claim_id, documentVersionId: wire.document_version_id, relationship: "supports" }, OCT_29), /duplicate key/);
  const noText = await recordDocument(db, articleInput({ canonicalUrl: "https://paywall.example.com/1", rights: { accessBasis: "licensed", mayRetainRaw: false, mayRetainText: false, mayExposeExcerpts: false } }), OCT_29);
  await assert.rejects(addObservation(db, { claimId: claim.claim_id, documentVersionId: noText.document_version_id, relationship: "supports", quote: "doubtful" }, OCT_29), /does not permit retaining excerpts/);
  await addObservation(db, { claimId: claim.claim_id, documentVersionId: noText.document_version_id, relationship: "supports", v3EvidenceId: "11111111-1111-4111-8111-111111111111" }, OCT_29);
  await assert.rejects(db.query("delete from public.knowledge_claim_observations"), /immutable/);

  // Labeling order does not matter: an unlabeled copy seen first and the
  // labeled wire story seen later are one source once the label is known.
  const second = await recordClaim(db, availability(seed, fixture.fixtureId, "out"), OCT_28);
  const wireText = "Wire: the striker is out for Monday.";
  const unlabeledFirst = await recordDocument(db, articleInput({ canonicalUrl: "https://www.walla.co.il/a/2", extractedText: wireText }), OCT_28);
  await addObservation(db, { claimId: second.claim_id, documentVersionId: unlabeledFirst.document_version_id, relationship: "supports" }, OCT_28);
  const labeledLater = await recordDocument(db, articleInput({ canonicalUrl: "https://www.ifa.org.il/n/2", extractedText: wireText, syndicationCluster: "wire:ifa-2" }), OCT_29);
  await addObservation(db, { claimId: second.claim_id, documentVersionId: labeledLater.document_version_id, relationship: "supports" }, OCT_29);
  assert.equal((await support(db, second.claim_id, OCT_28)).supports.independent_source_count, 1);
  assert.deepEqual((await support(db, second.claim_id, OCT_30)).supports, { observation_count: 2, document_count: 2, independent_source_count: 1 });
  await db.close();
});

test("derived claims cite premises, and derived_from / supersedes graphs cannot form cycles", async () => {
  const { db, seed, fixture } = await setup();
  const fact = await recordClaim(db, availability(seed, fixture.fixtureId, "doubtful"), OCT_28);
  const inference = (status: string, premises: string[]): ClaimInput => ({
    claimKind: "derived_inference",
    claimType: "expected_lineup",
    predicate: "starts",
    fixtureId: fixture.fixtureId,
    playerId: seed.home.playerIds[10],
    objectValue: { likelihood: status },
    temporalScope: "fixture",
    premises,
    assertedByVersion: "lineup-reasoner-test-v1",
  });
  // A derived claim without premises is refused atomically.
  await assert.rejects(recordClaim(db, inference("low", []), OCT_29), /must cite at least one derived_from premise/);
  const derived = await recordClaim(db, inference("low", [fact.claim_id]), OCT_29);
  const premises = await db.query("select to_claim_id from public.knowledge_claim_relations where from_claim_id = $1 and relation_type = 'derived_from'", [derived.claim_id]);
  assert.deepEqual(premises.rows, [{ to_claim_id: fact.claim_id }]);
  // A document can report a source claim but never "observe" Kapiloto's own
  // inference: reported facts and derived conclusions stay separate layers.
  const doc = await recordDocument(db, articleInput(), OCT_29);
  await assert.rejects(
    addObservation(db, { claimId: derived.claim_id, documentVersionId: doc.document_version_id, relationship: "supports" }, OCT_29),
    /can only be observed reporting source claims, not derived_inference claims/,
  );

  const hypothesis = await recordClaim(db, {
    claimKind: "matchup_hypothesis",
    claimType: "set_piece_defending",
    predicate: "weakness",
    fixtureId: fixture.fixtureId,
    teamId: seed.away.teamId,
    objectValue: { level: "high" },
    temporalScope: "fixture",
    premises: [derived.claim_id],
    assertedByVersion: "matchup-test-v1",
  }, OCT_29);

  const relate = (from: string, to: string, type: string) =>
    db.query(
      "insert into public.knowledge_claim_relations (from_claim_id, to_claim_id, relation_type, asserted_by_kind, asserted_by_version) values ($1, $2, $3, 'manual', 'test')",
      [from, to, type],
    );
  // Direct and transitive cycles are refused; a source claim has no premises.
  await assert.rejects(relate(derived.claim_id, hypothesis.claim_id, "derived_from"), /would create a cycle/);
  await assert.rejects(relate(fact.claim_id, derived.claim_id, "derived_from"), /only derived claims can have derived_from premises/);
  await assert.rejects(relate(fact.claim_id, fact.claim_id, "supports"), /check constraint/);
  const out = await recordClaim(db, availability(seed, fixture.fixtureId, "out"), OCT_30);
  await relate(out.claim_id, fact.claim_id, "supersedes");
  await assert.rejects(relate(fact.claim_id, out.claim_id, "supersedes"), /would create a cycle/);
  // supports/contradicts may be mutual.
  await relate(out.claim_id, fact.claim_id, "contradicts");
  await relate(fact.claim_id, out.claim_id, "contradicts");
  await db.close();
});

test("resolutions are versioned on the lattice, and later truth never leaks into an earlier cutoff", async () => {
  const { db, seed, fixture } = await setup();
  const claim = await recordClaim(db, availability(seed, fixture.fixtureId, "doubtful"), OCT_28);
  const report = await recordDocument(db, articleInput({ publishedAt: null, author: null }), OCT_28);
  const observation = await addObservation(db, { claimId: claim.claim_id, documentVersionId: report.document_version_id, relationship: "supports" }, OCT_28);
  const club = await recordDocument(db, articleInput({ canonicalUrl: "https://www.hapoel.co.il/squad", sourceKind: "official_announcement", extractedText: "Squad list: the striker is listed as doubtful." }), "2026-10-29T15:00:00.000Z");

  const base = { claimId: claim.claim_id, resolverKind: "grounding" as const, resolverVersion: "grounding-test-v1" };
  const v1 = await recordResolution(db, { ...base, status: "unresolved", reasonCode: "single_unverified_report" }, "2026-10-28T10:00:00.000Z");
  // True information with missing metadata is verified_degraded, not dropped.
  const v2 = await recordResolution(db, {
    ...base,
    status: "verified_degraded",
    reasonCode: "quote_verified_metadata_incomplete",
    qualityFlags: ["missing_published_at", "missing_author"],
    evidence: [{ evidenceRole: "supporting", claimObservationId: observation.id }],
  }, "2026-10-29T09:30:00.000Z");
  const v3 = await recordResolution(db, {
    ...base,
    status: "verified",
    reasonCode: "official_squad_announcement",
    evidence: [{ evidenceRole: "supporting", documentVersionId: club.document_version_id }],
  }, "2026-10-29T16:00:00.000Z");
  assert.deepEqual([v1, v2, v3].map((r) => r.resolution_version), [1, 2, 3]);

  const statusAt = async (cutoff: string) => (await resolutionsAsOf(db, [claim.claim_id], cutoff)).map((r) => [r.status, r.resolution_version]);
  assert.deepEqual(await statusAt("2026-10-28T08:00:00.000Z"), []); // claim not yet known
  assert.deepEqual(await statusAt("2026-10-28T09:30:00.000Z"), [["unresolved", null]]);
  assert.deepEqual(await statusAt("2026-10-28T12:00:00.000Z"), [["unresolved", 1]]);
  assert.deepEqual(await statusAt("2026-10-29T12:00:00.000Z"), [["verified_degraded", 2]]);
  assert.deepEqual(await statusAt(OCT_30), [["verified", 3]]);

  // Oct 28: "the striker will start". Nov 2: he does not start.
  const starts = await recordClaim(db, {
    claimKind: "reported_expectation",
    claimType: "expected_lineup",
    predicate: "starts",
    fixtureId: fixture.fixtureId,
    playerId: seed.home.playerIds[15],
    temporalScope: "fixture",
  }, OCT_28);
  const ledger = await recordObservation(
    db,
    realisticObservation(seed, fixture, { kickoffAt: NOV_2_KICKOFF, retrievedAt: "2026-11-02T20:59:00.000Z" }),
    "2026-11-02T21:00:00.000Z",
  );
  const benchRow = await db.query<{ id: string }>(
    "select id from public.match_ledger_players where observation_id = $1 and player_id = $2",
    [ledger.observation_id, seed.home.playerIds[15]],
  );
  // Evidence cannot be cited before Kapiloto had it.
  await assert.rejects(
    recordResolution(db, { claimId: starts.claim_id, status: "contradicted", resolverKind: "post_match", resolverVersion: "post-match-test-v1", reasonCode: "player_did_not_start", evidence: [{ evidenceRole: "contradicting", ledgerPlayerId: benchRow.rows[0].id }] }, "2026-11-02T20:00:00.000Z"),
    /first seen after the resolution/,
  );
  await recordResolution(db, {
    claimId: starts.claim_id,
    status: "contradicted",
    resolverKind: "post_match",
    resolverVersion: "post-match-test-v1",
    reasonCode: "player_did_not_start",
    evidence: [
      { evidenceRole: "contradicting", ledgerPlayerId: benchRow.rows[0].id },
      { evidenceRole: "context", ledgerObservationId: ledger.observation_id },
    ],
  }, "2026-11-02T21:30:00.000Z");
  assert.deepEqual((await resolutionsAsOf(db, [starts.claim_id], OCT_30)).map((r) => r.status), ["unresolved"]);
  assert.deepEqual((await resolutionsAsOf(db, [starts.claim_id], "2026-11-03T00:00:00.000Z")).map((r) => r.status), ["contradicted"]);
  await db.close();
});

test("fabrication is distinct from missing metadata, and resolutions are auditable, sealed and immutable", async () => {
  const { db, seed, fixture } = await setup();
  const claim = await recordClaim(db, availability(seed, fixture.fixtureId, "injured"), OCT_28);
  const doc = await recordDocument(db, articleInput({ extractedText: "Nothing about injuries here." }), OCT_28);
  const observation = await addObservation(db, { claimId: claim.claim_id, documentVersionId: doc.document_version_id, relationship: "supports", quote: "ruled out for a month" }, OCT_28);
  assert.equal(observation.quote_found, false);
  const at = "2026-10-28T12:00:00.000Z";
  const base = { claimId: claim.claim_id, resolverKind: "model_verifier" as const, resolverVersion: "verifier-test-v1" };

  // Missing metadata can never be the reason for "fabricated".
  await assert.rejects(recordResolution(db, { ...base, status: "fabricated", reasonCode: "missing_published_at", evidence: [{ evidenceRole: "absence", claimObservationId: observation.id }] }, at), /check constraint/);
  // verified_degraded must say what is incomplete; adjudications need evidence.
  await assert.rejects(recordResolution(db, { ...base, status: "verified_degraded", reasonCode: "partial_metadata", evidence: [{ evidenceRole: "supporting", claimObservationId: observation.id }] }, at), /check constraint/);
  await assert.rejects(recordResolution(db, { ...base, status: "verified", reasonCode: "trust_me" }, at), /must cite evidence/);
  await assert.rejects(
    recordResolution(db, { ...buildClaimResolutionPayload({ ...base, status: "contradicted", reasonCode: "x" }), evidence: [{ evidence_role: "context", claim_observation_id: observation.id, document_version_id: doc.document_version_id }] }, at),
    /check constraint/,
  );
  assert.equal(await count(db, "knowledge_claim_resolutions"), 0);

  const fabricated = await recordResolution(db, {
    ...base,
    status: "fabricated",
    reasonCode: "quote_not_in_source",
    idempotencyKey: "verifier-run-1",
    evidence: [{ evidenceRole: "absence", claimObservationId: observation.id }],
  }, at);
  // Replay of the same adjudication is idempotent; a different one under the
  // same key is refused.
  const replay = await recordResolution(db, { ...base, status: "fabricated", reasonCode: "quote_not_in_source", idempotencyKey: "verifier-run-1", evidence: [{ evidenceRole: "absence", claimObservationId: observation.id }] }, "2026-10-28T13:00:00.000Z");
  assert.deepEqual([replay.status, replay.resolution_id], ["unchanged", fabricated.resolution_id]);
  await assert.rejects(recordResolution(db, { ...base, status: "quarantined", reasonCode: "x", idempotencyKey: "verifier-run-1" }, at), /already used/);
  // Same status and reason but different evidence, flags or confidence is a
  // different write, never a silent "unchanged".
  const differently = { ...base, status: "fabricated" as const, reasonCode: "quote_not_in_source", idempotencyKey: "verifier-run-1" };
  await assert.rejects(recordResolution(db, { ...differently, evidence: [{ evidenceRole: "absence", documentVersionId: doc.document_version_id }] }, at), /already used/);
  await assert.rejects(recordResolution(db, { ...differently, confidence: 0.4, evidence: [{ evidenceRole: "absence", claimObservationId: observation.id }] }, at), /already used/);
  await assert.rejects(recordResolution(db, { ...differently, qualityFlags: ["missing_author"], evidence: [{ evidenceRole: "absence", claimObservationId: observation.id }] }, at), /already used/);

  // Evidence cannot be appended to an old resolution; rows are immutable.
  await assert.rejects(
    db.query("insert into public.knowledge_resolution_evidence (resolution_id, evidence_role, document_version_id, evidence_first_seen_at) values ($1, 'context', $2, now())", [fabricated.resolution_id, doc.document_version_id]),
    /is sealed/,
  );
  await assert.rejects(db.query("update public.knowledge_claim_resolutions set status = 'verified'"), /immutable/);
  await assert.rejects(db.query("delete from public.knowledge_resolution_evidence"), /immutable/);
  // The claim builder emits the contract, and unknown fields are refused.
  await setClock(db, at);
  await assert.rejects(
    db.query("select public.knowledge_record_claim($1::jsonb)", [JSON.stringify({ ...buildClaimPayload(availability(seed, fixture.fixtureId, "fit")), confidence: 1 })]),
    /unknown claim field: confidence/,
  );
  await db.close();
});

test("observations and resolutions are never known before what they depend on", async () => {
  const { db, seed, fixture } = await setup();
  const claim = await recordClaim(db, availability(seed, fixture.fixtureId, "doubtful"), OCT_28);
  const doc = await recordDocument(db, articleInput(), OCT_29);
  // A backwards clock step must not make an observation precede its document
  // version (it would be counted at a cutoff when the document was unknown).
  await assert.rejects(
    addObservation(db, { claimId: claim.claim_id, documentVersionId: doc.document_version_id, relationship: "supports" }, "2026-10-28T12:00:00.000Z"),
    /would precede its document version or claim/,
  );
  assert.deepEqual(await support(db, claim.claim_id, "2026-10-28T13:00:00.000Z"), {});
  await assert.rejects(
    recordResolution(db, { claimId: claim.claim_id, status: "unresolved", resolverKind: "grounding", resolverVersion: "g1", reasonCode: "early" }, "2026-10-27T00:00:00.000Z"),
    /would precede its claim/,
  );
  await addObservation(db, { claimId: claim.claim_id, documentVersionId: doc.document_version_id, relationship: "supports" }, OCT_29);
  await db.close();
});

test("derived claims and relations are never visible before the premises and claims they connect", async () => {
  const { db, seed, fixture } = await setup();
  const premise = await recordClaim(db, availability(seed, fixture.fixtureId, "doubtful"), OCT_29);
  const derived = (premises: string[]): ClaimInput => ({
    claimKind: "derived_inference",
    claimType: "expected_lineup",
    predicate: "starts",
    fixtureId: fixture.fixtureId,
    playerId: seed.home.playerIds[10],
    objectValue: { likelihood: "low" },
    temporalScope: "fixture",
    premises,
    assertedByVersion: "lineup-reasoner-test-v1",
  });

  // The clock steps back between the premise (Oct 29) and the derived claim
  // (Oct 28): the atomic recording is refused, nothing is stored.
  const claimsBefore = await count(db, "knowledge_claims");
  await assert.rejects(recordClaim(db, derived([premise.claim_id]), OCT_28), /would precede one of its claims|visible before one of its premises/);
  assert.equal(await count(db, "knowledge_claims"), claimsBefore);
  assert.equal(await count(db, "knowledge_claim_relations"), 0);

  // A direct writer that stamps the derived claim early and its premise
  // relation late is refused when the transaction commits.
  await db.exec("begin");
  await setClock(db, OCT_28);
  await db.query(
    `insert into public.knowledge_claims (contract_version, claim_kind, claim_type, predicate, fixture_id, player_id, temporal_scope, claim_fingerprint)
     values ('kapiloto-claim-v1', 'derived_inference', 'expected_lineup', 'starts', $1, $2, 'fixture', $3)`,
    [fixture.fixtureId, seed.home.playerIds[9], "0".repeat(64)],
  );
  const early = await db.query<{ id: string }>("select id from public.knowledge_claims where player_id = $1", [seed.home.playerIds[9]]);
  await setClock(db, OCT_30);
  await db.query(
    "insert into public.knowledge_claim_relations (from_claim_id, to_claim_id, relation_type, asserted_by_kind, asserted_by_version) values ($1, $2, 'derived_from', 'derivation', 'test')",
    [early.rows[0].id, premise.claim_id],
  );
  await assert.rejects(db.exec("commit"), /would be visible before one of its premises/);
  assert.equal(await count(db, "knowledge_claims"), claimsBefore);

  // In clock order the derived claim is accepted and is never earlier than
  // its premise, so any cutoff that sees it also sees the premise.
  const valid = await recordClaim(db, derived([premise.claim_id]), OCT_30);
  const times = await db.query<{ derived_seen: Date; premise_seen: Date; relation_seen: Date }>(
    `select d.first_seen_at as derived_seen, p.first_seen_at as premise_seen, r.first_seen_at as relation_seen
     from public.knowledge_claim_relations r
     join public.knowledge_claims d on d.id = r.from_claim_id
     join public.knowledge_claims p on p.id = r.to_claim_id
     where r.from_claim_id = $1`,
    [valid.claim_id],
  );
  assert.ok(times.rows[0].derived_seen >= times.rows[0].premise_seen);
  assert.ok(times.rows[0].relation_seen >= times.rows[0].derived_seen);

  // Every relation type obeys endpoint ordering, supersedes and refines too.
  const newer = await recordClaim(db, availability(seed, fixture.fixtureId, "out"), "2026-10-31T09:00:00.000Z");
  await setClock(db, "2026-10-30T18:00:00.000Z");
  for (const relationType of ["supersedes", "refines", "contradicts"]) {
    await assert.rejects(
      db.query(
        "insert into public.knowledge_claim_relations (from_claim_id, to_claim_id, relation_type, asserted_by_kind, asserted_by_version) values ($1, $2, $3, 'manual', 'test')",
        [newer.claim_id, premise.claim_id, relationType],
      ),
      /would precede one of its claims/,
      relationType,
    );
  }
  await db.close();
});

test("claim support counts every observation row but corroboration only once per independent source", async () => {
  const { db, seed, fixture } = await setup();
  const claim = await recordClaim(db, availability(seed, fixture.fixtureId, "doubtful"), OCT_28);
  const article = articleInput();
  const v1 = await recordDocument(db, article, OCT_28);
  const v2 = await recordDocument(db, { ...article, extractedText: `${article.extractedText} Updated at noon.` }, OCT_29);
  // Two extractor versions on version 1 and one extraction of version 2.
  await addObservation(db, { claimId: claim.claim_id, documentVersionId: v1.document_version_id, relationship: "supports", extractorVersion: "extractor-a" }, OCT_28);
  await addObservation(db, { claimId: claim.claim_id, documentVersionId: v1.document_version_id, relationship: "supports", extractorVersion: "extractor-b" }, OCT_28);
  await addObservation(db, { claimId: claim.claim_id, documentVersionId: v2.document_version_id, relationship: "supports" }, OCT_29);
  // A syndicated reprint of version 2 is a second document, not a second source.
  const reprint = await recordDocument(db, { ...articleInput({ canonicalUrl: "https://www.one.co.il/a/77", domain: "one.co.il", publisher: "ONE" }), extractedText: `${article.extractedText} Updated at noon.` }, OCT_29);
  await addObservation(db, { claimId: claim.claim_id, documentVersionId: reprint.document_version_id, relationship: "supports" }, OCT_29);

  assert.deepEqual(await support(db, claim.claim_id, OCT_30), {
    supports: { observation_count: 4, document_count: 2, independent_source_count: 1 },
  });
  await db.close();
});

async function count(db: PGlite, table: string): Promise<number> {
  return (await db.query<{ n: number }>(`select count(*)::int as n from public.${table}`)).rows[0].n;
}
