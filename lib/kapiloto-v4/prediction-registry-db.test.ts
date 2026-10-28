import assert from "node:assert/strict";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import type { ProviderPlayerMatchAsOfRow } from "./as-of";
import type { MatchLedgerObservationInput } from "./match-ledger";
import { buildPredictionSnapshotPayload, type PredictionSnapshotInput } from "./prediction-registry";
import {
  createFixture,
  createLedgerDatabase,
  realisticObservation,
  recordObservation,
  seedLedger,
  setClock,
} from "./test-support/ledger-fixtures";
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
 * Prediction Registry: exact frozen inputs, a fail-closed cutoff, fixture
 * scoping, immutability, idempotent replay only, and identity bindings that
 * survive later merges.
 */

const KICKOFF = "2026-11-02T18:00:00.000Z";
const CUTOFF = "2026-10-30T12:00:00.000Z";
const RECORDED = "2026-10-30T12:10:00.000Z";
const AFTER = "2026-10-31T09:00:00.000Z";

async function count(db: PGlite, table: string): Promise<number> {
  return (await db.query<{ n: number }>(`select count(*)::int as n from public.${table}`)).rows[0].n;
}

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

async function setup() {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  const fixture = await createFixture(db, seed, KICKOFF);
  const historyFixture = await createFixture(db, seed, "2026-10-25T18:00:00.000Z");
  const history = await recordObservation(
    db,
    realisticObservation(seed, historyFixture, { kickoffAt: "2026-10-25T18:00:00.000Z", retrievedAt: "2026-10-26T08:59:00.000Z" }),
    "2026-10-26T09:00:00.000Z",
  );
  const doc = await recordDocument(db, articleInput(), "2026-10-28T09:00:00.000Z");
  const claim = await recordClaim(db, {
    claimKind: "reported_expectation",
    claimType: "player_availability",
    predicate: "availability_status",
    fixtureId: fixture.fixtureId,
    playerId: seed.home.playerIds[10],
    objectValue: { status: "doubtful" },
    temporalScope: "fixture",
  }, "2026-10-28T09:00:00.000Z");
  const observation = await addObservation(db, { claimId: claim.claim_id, documentVersionId: doc.document_version_id, relationship: "supports" }, "2026-10-28T09:00:00.000Z");
  await recordResolution(db, { claimId: claim.claim_id, status: "unresolved", resolverKind: "grounding", resolverVersion: "g1", reasonCode: "single_report" }, "2026-10-28T10:00:00.000Z");
  const degraded = await recordResolution(db, {
    claimId: claim.claim_id,
    status: "verified_degraded",
    resolverKind: "grounding",
    resolverVersion: "g1",
    reasonCode: "quote_verified_metadata_incomplete",
    qualityFlags: ["missing_author"],
    evidence: [{ evidenceRole: "supporting", claimObservationId: observation.id }],
  }, "2026-10-29T10:00:00.000Z");
  const structured = await db.query<{ id: string }>(
    `insert into public.fixture_structured_snapshots
       (fixture_id, feature_version, research_cutoff_at, computed_at, features, input_payload, sha256)
     values ($1, 'features-test-v1', '2026-10-30T10:00:00Z', '2026-10-30T10:01:00Z', '{}', '{}', $2) returning id`,
    [fixture.fixtureId, "a".repeat(64)],
  );
  const inputs = (): PredictionSnapshotInput["inputs"] => ({
    ledger: [{ ledgerObservationId: history.observation_id }],
    documents: [{ documentVersionId: doc.document_version_id }],
    claims: [{ claimId: claim.claim_id, resolutionId: degraded.resolution_id }],
    claimObservations: [{ claimObservationId: observation.id }],
    references: [
      { referenceKind: "structured_snapshot", referenceId: structured.rows[0].id },
      { referenceKind: "v3_analysis", referenceId: "22222222-2222-4222-8222-222222222222", inputRole: "legacy_provenance" },
    ],
    identities: [
      { entityType: "player", entityId: seed.home.playerIds[10], bindingRole: "doubtful_starter", contextTeamId: seed.home.teamId, provider: "sportmonks", providerEntityId: "p-1-11" },
      { entityType: "coach", entityId: seed.home.coachId, bindingRole: "home_head_coach" },
      { entityType: "team", entityId: seed.home.teamId, bindingRole: "home_team" },
    ],
  });
  return { db, seed, fixture, historyFixture, history, doc, claim, observation, degraded, structured: structured.rows[0].id, inputs };
}

test("a prediction freezes its exact inputs, including the claim resolution version it saw", async () => {
  const ctx = await setup();
  const { db } = ctx;
  const snapshot = basePrediction(ctx.fixture.fixtureId, { inputs: ctx.inputs() });
  const recorded = await recordPrediction(db, snapshot, RECORDED);
  assert.equal(recorded.status, "recorded");

  const row = await db.query<{ first_seen_at: Date; p_1_bp: number; input_bundle_sha256: string; output_bundle_sha256: string }>(
    "select first_seen_at, p_1_bp, input_bundle_sha256, output_bundle_sha256 from public.prediction_snapshots where id = $1",
    [recorded.snapshot_id],
  );
  assert.equal(row.rows[0].first_seen_at.toISOString(), RECORDED);
  assert.equal(row.rows[0].input_bundle_sha256, recorded.input_bundle_sha256);
  for (const [table, n] of [
    ["prediction_ledger_inputs", 1],
    ["prediction_document_inputs", 1],
    ["prediction_claim_inputs", 1],
    ["prediction_claim_observation_inputs", 1],
    ["prediction_reference_inputs", 2],
    ["prediction_identity_bindings", 3],
  ] as const) {
    assert.equal(await count(db, table), n, table);
  }

  // A later resolution (v3, verified) does not change what the prediction used.
  await recordResolution(db, {
    claimId: ctx.claim.claim_id,
    status: "verified",
    resolverKind: "grounding",
    resolverVersion: "g1",
    reasonCode: "official_squad_announcement",
    evidence: [{ evidenceRole: "supporting", documentVersionId: ctx.doc.document_version_id }],
  }, AFTER);
  const used = await db.query("select resolution_id, resolution_status, input_first_seen_at from public.prediction_claim_inputs where snapshot_id = $1", [recorded.snapshot_id]);
  assert.deepEqual(used.rows, [{ resolution_id: ctx.degraded.resolution_id, resolution_status: "verified_degraded", input_first_seen_at: new Date("2026-10-29T10:00:00.000Z") }]);

  // Replay of the same intended write is idempotent; reusing the key for
  // anything else is refused.
  const replay = await recordPrediction(db, snapshot, "2026-10-30T12:20:00.000Z");
  assert.deepEqual([replay.status, replay.snapshot_id], ["unchanged", recorded.snapshot_id]);
  await assert.rejects(recordPrediction(db, { ...snapshot, probabilities: { p1Bp: 4500, pXBp: 2900, p2Bp: 2600 } }, RECORDED), /already used for a different snapshot/);
  await assert.rejects(recordPrediction(db, { ...snapshot, inputs: { ...ctx.inputs(), documents: [] } }, RECORDED), /already used for a different snapshot/);
  assert.equal(await count(db, "prediction_snapshots"), 1);

  // Snapshots and links are immutable and sealed.
  await assert.rejects(db.query("update public.prediction_snapshots set p_1_bp = 5000"), /immutable/);
  await assert.rejects(db.query("delete from public.prediction_claim_inputs"), /immutable/);
  await assert.rejects(db.query("delete from public.prediction_identity_bindings"), /immutable/);
  await assert.rejects(
    db.query(
      "insert into public.prediction_document_inputs (snapshot_id, document_version_id, input_role, input_first_seen_at) values ($1, $2, 'source', now())",
      [recorded.snapshot_id, ctx.doc.document_version_id],
    ),
    /is sealed/,
  );
  await db.close();
});

test("an input first seen after the prediction cutoff is refused, whatever its kind", async () => {
  const ctx = await setup();
  const { db, seed } = ctx;
  // Each of these became known after the Oct 30 12:00 cutoff.
  const lateFixture = await createFixture(db, seed, "2026-10-29T18:00:00.000Z");
  const lateLedger = await recordObservation(
    db,
    realisticObservation(seed, lateFixture, { kickoffAt: "2026-10-29T18:00:00.000Z", retrievedAt: "2026-10-30T12:59:00.000Z" }),
    "2026-10-30T13:00:00.000Z",
  );
  const lateDoc = await recordDocument(db, articleInput({ extractedText: "Late news." }), "2026-10-30T13:00:00.000Z");
  const lateObservation = await addObservation(db, { claimId: ctx.claim.claim_id, documentVersionId: lateDoc.document_version_id, relationship: "contradicts" }, "2026-10-30T13:00:00.000Z");
  const lateClaim = await recordClaim(db, { claimKind: "observed_fact", claimType: "formation_used", predicate: "uses_formation", teamId: seed.away.teamId, objectValue: { formation: "5-3-2" }, temporalScope: "ongoing" }, "2026-10-30T13:00:00.000Z");
  const lateResolution = await recordResolution(db, {
    claimId: ctx.claim.claim_id,
    status: "contradicted",
    resolverKind: "grounding",
    resolverVersion: "g1",
    reasonCode: "club_denial",
    evidence: [{ evidenceRole: "contradicting", claimObservationId: lateObservation.id }],
  }, "2026-10-30T13:00:00.000Z");
  const lateStructured = await db.query<{ id: string }>(
    `insert into public.fixture_structured_snapshots (fixture_id, feature_version, research_cutoff_at, computed_at, features, input_payload, sha256)
     values ($1, 'features-test-v2', '2026-10-30T12:00:00Z', '2026-10-30T12:30:00Z', '{}', '{}', $2) returning id`,
    [ctx.fixture.fixtureId, "b".repeat(64)],
  );

  const cases: Array<[string, PredictionSnapshotInput["inputs"], RegExp]> = [
    ["ledger", { ...ctx.inputs(), ledger: [{ ledgerObservationId: lateLedger.observation_id }] }, /match ledger observation .* after the prediction cutoff/],
    ["document", { ...ctx.inputs(), documents: [{ documentVersionId: lateDoc.document_version_id }] }, /document version .* after the prediction cutoff/],
    ["claim observation", { ...ctx.inputs(), claimObservations: [{ claimObservationId: lateObservation.id }] }, /claim observation .* after the prediction cutoff/],
    ["claim", { ...ctx.inputs(), claims: [{ claimId: lateClaim.claim_id, resolutionId: null }] }, /claim .* first seen after the prediction cutoff/],
    ["resolution", { ...ctx.inputs(), claims: [{ claimId: ctx.claim.claim_id, resolutionId: lateResolution.resolution_id }] }, /claim .* first seen after the prediction cutoff/],
    ["structured snapshot", { ...ctx.inputs(), references: [{ referenceKind: "structured_snapshot", referenceId: lateStructured.rows[0].id }] }, /structured_snapshot reference was captured after the prediction cutoff/],
  ];
  for (const [label, inputs, error] of cases) {
    // Recorded long after the cutoff (a backtest): still fail-closed.
    await assert.rejects(recordPrediction(db, basePrediction(ctx.fixture.fixtureId, { inputs }), "2026-11-05T00:00:00.000Z"), error, label);
  }
  // A resolution must belong to the claim it is attached to.
  await assert.rejects(
    recordPrediction(db, basePrediction(ctx.fixture.fixtureId, { inputs: { ...ctx.inputs(), claims: [{ claimId: lateClaim.claim_id, resolutionId: ctx.degraded.resolution_id }] } }), "2026-11-05T00:00:00.000Z"),
    /does not belong to claim/,
  );
  assert.equal(await count(db, "prediction_snapshots"), 0);
  for (const table of ["prediction_ledger_inputs", "prediction_identity_bindings", "prediction_reference_inputs"]) assert.equal(await count(db, table), 0, table);

  // The same inputs with a cutoff after they were known are accepted.
  const accepted = await recordPrediction(db, basePrediction(ctx.fixture.fixtureId, {
    researchCutoffAt: "2026-10-30T14:00:00.000Z",
    generatedAt: "2026-10-30T14:00:00.000Z",
    inputs: { ...ctx.inputs(), ledger: [{ ledgerObservationId: lateLedger.observation_id }], claims: [{ claimId: ctx.claim.claim_id, resolutionId: lateResolution.resolution_id }] },
  }), "2026-10-30T14:01:00.000Z");
  assert.equal(accepted.status, "recorded");
  await db.close();
});

test("fixture-scoped references must belong to the predicted fixture and precede the cutoff", async () => {
  const ctx = await setup();
  const { db, seed } = ctx;
  // Market quotes are stamped with the real server time, so this test uses
  // cutoffs around the present.
  const futureFixture = await createFixture(db, seed, "2030-01-10T18:00:00.000Z");
  const quote = async (fixtureId: string) =>
    (await db.query<{ id: string }>(
      `insert into public.fixture_market_quotes
         (fixture_id, provider, provider_fixture_id, bookmaker_id, odds_home, odds_draw, odds_away, overround,
          implied_home, implied_draw, implied_away, devig_method_version, capture_version)
       values ($1, 'api_football', 'af-1', $2, 2.1, 3.3, 3.6, 0.05, 0.45, 0.29, 0.26, 'devig-v1', 'capture-v1') returning id`,
      [fixtureId, `bk-${Math.random()}`],
    )).rows[0].id;
  const ownQuote = await quote(futureFixture.fixtureId);
  const otherQuote = await quote(ctx.historyFixture.fixtureId);
  const future = (overrides: Partial<PredictionSnapshotInput>) =>
    basePrediction(futureFixture.fixtureId, {
      researchCutoffAt: "2029-12-31T00:00:00.000Z",
      kickoffAtSnapshot: "2030-01-10T18:00:00.000Z",
      generatedAt: "2029-12-31T00:01:00.000Z",
      ...overrides,
    });
  const inFuture = "2030-01-01T00:00:00.000Z";

  assert.equal((await recordPrediction(db, future({ inputs: { references: [{ referenceKind: "market_quote", referenceId: ownQuote }] } }), inFuture)).status, "recorded");
  await assert.rejects(recordPrediction(db, future({ inputs: { references: [{ referenceKind: "market_quote", referenceId: otherQuote }] } }), inFuture), /market quote .* belongs to another fixture/);
  // Quotes have no foreign key (shadow tables stay out of the shared types);
  // the trigger still refuses an id that does not exist.
  await assert.rejects(
    recordPrediction(db, future({ inputs: { references: [{ referenceKind: "market_quote", referenceId: "33333333-3333-4333-8333-333333333333" }] } }), inFuture),
    /market quote .* not found/,
  );
  await assert.rejects(recordPrediction(db, future({ inputs: { references: [{ referenceKind: "structured_snapshot", referenceId: ctx.structured }] } }), inFuture), /structured snapshot .* belongs to another fixture/);
  // A quote captured after an (old) cutoff is refused.
  await assert.rejects(
    recordPrediction(db, future({ researchCutoffAt: "2020-01-01T00:00:00.000Z", generatedAt: "2020-01-01T00:01:00.000Z", inputs: { references: [{ referenceKind: "market_quote", referenceId: ownQuote }] } }), inFuture),
    /market_quote reference was captured after the prediction cutoff/,
  );

  // V1 market snapshots are fixture-scoped and mutable: the link records a
  // fingerprint of the row it used, so a later edit is detectable.
  const marketSnapshot = async (fixtureId: string) =>
    (await db.query<{ id: string }>(
      `insert into public.fixture_market_snapshots (fixture_id, provider, captured_at, p_1_bp, p_x_bp, p_2_bp)
       values ($1, 'api_football', '2029-12-30T00:00:00Z', 4500, 2800, 2700) returning id`,
      [fixtureId],
    )).rows[0].id;
  const ownMarket = await marketSnapshot(futureFixture.fixtureId);
  await assert.rejects(
    recordPrediction(db, future({ inputs: { references: [{ referenceKind: "market_snapshot", referenceId: await marketSnapshot(ctx.historyFixture.fixtureId) }] } }), inFuture),
    /market snapshot .* belongs to another fixture/,
  );
  const withMarket = await recordPrediction(db, future({ inputs: { references: [{ referenceKind: "market_snapshot", referenceId: ownMarket }] } }), inFuture);
  const drift = async () =>
    (await db.query<{ unchanged: boolean }>(
      `select r.referenced_row_sha256 = encode(sha256(convert_to(to_jsonb(m)::text, 'UTF8')), 'hex') as unchanged
       from public.prediction_reference_inputs r join public.fixture_market_snapshots m on m.id = r.market_snapshot_id
       where r.snapshot_id = $1`,
      [withMarket.snapshot_id],
    )).rows[0].unchanged;
  await db.exec("set timezone = 'UTC'");
  assert.equal(await drift(), true);
  await db.query("update public.fixture_market_snapshots set p_1_bp = 4400, p_x_bp = 2900 where id = $1", [ownMarket]);
  assert.equal(await drift(), false);

  // The round game must be the predicted fixture's.
  await db.query("insert into public.rounds (id, external_round_number, lock_at, source) values ('30000000-0000-4000-8000-000000000001', '999', '2026-10-25T10:00:00Z', 'test')");
  await db.query(
    `insert into public.round_games (id, round_id, game_number, home_team_id, away_team_id, competition_name_snapshot, kickoff_at, fixture_id)
     values ('31000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 1, $1, $2, 'Test League', '2026-10-25T18:00:00Z', $3)`,
    [seed.home.teamId, seed.away.teamId, ctx.historyFixture.fixtureId],
  );
  await assert.rejects(
    recordPrediction(db, basePrediction(ctx.fixture.fixtureId, { roundGameId: "31000000-0000-4000-8000-000000000001" }), RECORDED),
    /round game .* does not belong to fixture/,
  );
  await db.close();
});

test("probabilities, outputs and cutoffs are validated by the database; equal probabilities never dedupe", async () => {
  const ctx = await setup();
  const { db } = ctx;
  const payload = buildPredictionSnapshotPayload(basePrediction(ctx.fixture.fixtureId));
  const direct = (patch: Record<string, unknown>) => recordPrediction(db, { ...payload, idempotency_key: `direct-${Math.random()}`, ...patch }, RECORDED);
  await assert.rejects(direct({ p_1_bp: 4600, p_x_bp: 2800, p_2_bp: 2599 }), /check constraint/);
  await assert.rejects(direct({ outcome: "abstained", abstain_reason: "no lineup" }), /check constraint/);
  await assert.rejects(direct({ payload: { hidden_reasoning: "..." } }), /check constraint/);
  await assert.rejects(direct({ research_cutoff_at: "2026-11-03T00:00:00.000Z", generated_at: "2026-11-03T00:00:00.000Z" }), /after its recording time|check constraint/);
  await assert.rejects(direct({ research_cutoff_at: "2026-10-30T12:30:00.000Z", generated_at: "2026-10-30T12:30:00.000Z" }), /after its recording time/);
  await assert.rejects(direct({ generated_at: "2026-10-30T11:00:00.000Z" }), /check constraint/);
  await assert.rejects(direct({ code_revision: "main" }), /check constraint/);
  await assert.rejects(direct({ inputs: { ledger: [], surprise: [] } }), /unknown prediction inputs field: surprise/);
  assert.equal(await count(db, "prediction_snapshots"), 0);

  const abstained = await recordPrediction(db, basePrediction(ctx.fixture.fixtureId, { outcome: "abstained", probabilities: null, abstainReason: "lineups unknown", reliability: null }), RECORDED);
  assert.equal(abstained.status, "recorded");

  // Same probabilities, different scientific identity: two snapshots.
  const production = await recordPrediction(db, basePrediction(ctx.fixture.fixtureId, { purpose: "production" }), RECORDED);
  const challenger = await recordPrediction(db, basePrediction(ctx.fixture.fixtureId, { purpose: "challenger", modelIdentifiers: { probability: "challenger-v2" } }), RECORDED);
  const sameEverything = await recordPrediction(db, basePrediction(ctx.fixture.fixtureId, { purpose: "production" }), RECORDED);
  assert.equal(new Set([production.snapshot_id, challenger.snapshot_id, sameEverything.snapshot_id]).size, 3);
  assert.equal(production.output_bundle_sha256, sameEverything.output_bundle_sha256);

  // A direct insert whose stored bundle hash does not describe its links is
  // refused when the transaction commits.
  await setClock(db, RECORDED);
  await assert.rejects(
    db.query(
      `insert into public.prediction_snapshots
         (contract_version, idempotency_key, fixture_id, purpose, prediction_protocol_version, pipeline_version,
          code_revision, research_cutoff_at, kickoff_at_snapshot, generated_at, outcome, abstain_reason,
          payload_schema_version, input_bundle_sha256, output_bundle_sha256)
       values ('kapiloto-prediction-snapshot-v1', 'direct-bundle', $1, 'shadow', 'p', 'p', 'abcdef0', $2, $3, $2,
          'abstained', 'x', 'v1', $4, $4)`,
      [ctx.fixture.fixtureId, CUTOFF, KICKOFF, "c".repeat(64)],
    ),
    /do not match its input bundle hash/,
  );
  await db.close();
});

test("identity bindings keep what the live model saw after a later merge", async () => {
  const ctx = await setup();
  const { db, seed } = ctx;
  const a = seed.home.playerIds[10];
  const b = "63000000-0000-4000-8000-0000000b0001";
  await db.query("insert into public.players (id, canonical_name) values ($1, 'Striker (second record)')", [b]);
  // Before the prediction, the ledger holds A in one match and B in another.
  const otherFixture = await createFixture(db, seed, "2026-10-18T18:00:00.000Z");
  const withB = await recordObservation(
    db,
    swapPlayer(realisticObservation(seed, otherFixture, { kickoffAt: "2026-10-18T18:00:00.000Z", retrievedAt: "2026-10-19T08:59:00.000Z" }), a, b),
    "2026-10-19T09:00:00.000Z",
  );

  // The live model treated A and B as two people.
  const inputs = {
    ...ctx.inputs(),
    ledger: [{ ledgerObservationId: ctx.history.observation_id }, { ledgerObservationId: withB.observation_id }],
    identities: [
      { entityType: "player" as const, entityId: a, bindingRole: "doubtful_starter" },
      { entityType: "player" as const, entityId: b, bindingRole: "rotation_option" },
    ],
  };
  const live = await recordPrediction(db, basePrediction(ctx.fixture.fixtureId, { purpose: "production", inputs }), RECORDED);

  // A week later A is found to be a duplicate of B.
  await db.query("update public.players set identity_status = 'merged', merged_into_player_id = $2 where id = $1", [a, b]);

  // The registry still proves the model kept them separate ...
  const bindings = await db.query("select player_id, binding_role from public.prediction_identity_bindings where snapshot_id = $1 order by binding_role", [live.snapshot_id]);
  assert.deepEqual(bindings.rows, [{ player_id: a, binding_role: "doubtful_starter" }, { player_id: b, binding_role: "rotation_option" }]);
  // ... while today's model-facing ledger read unifies them under B.
  const history = await db.query<ProviderPlayerMatchAsOfRow>(
    "select * from public.match_ledger_provider_player_matches_as_of('sportmonks', $1, $2, 10)",
    [b, CUTOFF],
  );
  assert.deepEqual(history.rows.map((r) => [r.fixture_id, r.observed_player_id, r.canonical_player_id]), [
    [ctx.historyFixture.fixtureId, a, b],
    [otherFixture.fixtureId, b, b],
  ]);
  // The frozen inputs are unchanged and still reproduce the live view.
  const ledgerInputs = await db.query<{ ledger_observation_id: string }>("select ledger_observation_id from public.prediction_ledger_inputs where snapshot_id = $1 order by input_first_seen_at", [live.snapshot_id]);
  assert.deepEqual(ledgerInputs.rows.map((row) => row.ledger_observation_id), [withB.observation_id, ctx.history.observation_id]);

  // A new prediction must bind the survivor; the raw ledger id may be kept
  // as the observed id.
  await assert.rejects(
    recordPrediction(db, basePrediction(ctx.fixture.fixtureId, { inputs: { identities: [{ entityType: "player", entityId: a, bindingRole: "doubtful_starter" }] } }), RECORDED),
    /bind the surviving id the prediction used/,
  );
  const backtest = await recordPrediction(db, basePrediction(ctx.fixture.fixtureId, {
    purpose: "backtest",
    inputs: { identities: [{ entityType: "player", entityId: b, observedEntityId: a, bindingRole: "doubtful_starter" }] },
  }), "2026-11-10T00:00:00.000Z");
  const rebound = await db.query("select player_id, observed_player_id from public.prediction_identity_bindings where snapshot_id = $1", [backtest.snapshot_id]);
  assert.deepEqual(rebound.rows, [{ player_id: b, observed_player_id: a }]);
  await db.close();
});
