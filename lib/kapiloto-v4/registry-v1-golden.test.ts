import assert from "node:assert/strict";
import test from "node:test";

import { createFixture, createLedgerDatabase, seedLedger } from "./test-support/ledger-fixtures";
import { basePrediction, recordPrediction } from "./test-support/knowledge-fixtures";

/**
 * V1 golden hashes, captured on main (f3e1e16, before the 1D migration) and
 * re-asserted with the full migration chain. Prediction Registry V2 must not
 * change V1 canonicalization, V1 output hashing or V1 recording.
 * Seed ids are deterministic per file (node --test runs each file in its own
 * process), so the end-to-end hashes are stable.
 */
const GOLDEN_BUNDLE = "c68cbe1357d429e765bd230d2bffe0ed4c3dfe91e48e34409689ca4f21c0d44b";
const GOLDEN_OUTPUT = "26f10d792db0df558f6f55d6bbfa46d61bda195bb8d27d705014438214675189";
const GOLDEN_E2E_INPUT = "08b3013a8b227166ac252fe31f77aaf910bf8bcf7832849fba2d8b5574aff9d7";
const GOLDEN_E2E_OUTPUT = "58cdf268dab88c464bf3407e84875d84b193c9efe6061e5d6aaa50ff96728cd3";

const FIXED_INPUTS = {
  ledger: [{ ledger_observation_id: "11111111-1111-4111-8111-111111111111", input_role: null }],
  documents: [{ document_version_id: "22222222-2222-4222-8222-222222222222", input_role: "source" }],
  claims: [{ claim_id: "33333333-3333-4333-8333-333333333333", resolution_id: "44444444-4444-4444-8444-444444444444", input_role: null }],
  claim_observations: [{ claim_observation_id: "55555555-5555-4555-8555-555555555555", input_role: null }],
  references: [{ reference_kind: "v3_analysis", reference_id: "66666666-6666-4666-8666-666666666666", input_role: "legacy" }],
  identities: [{ entity_type: "player", entity_id: "77777777-7777-4777-8777-777777777777", observed_entity_id: null, binding_role: "starter", context_team_id: null, provider: null, provider_entity_id: null }],
};

test("V1 input-bundle and output hashes are byte-identical after Prediction Registry V2", async () => {
  const db = await createLedgerDatabase();
  const bundle = await db.query<{ v: string }>("select private.prediction_input_bundle_sha256($1::jsonb) as v", [JSON.stringify(FIXED_INPUTS)]);
  assert.equal(bundle.rows[0].v, GOLDEN_BUNDLE);
  const output = await db.query<{ v: string }>(
    "select private.prediction_output_sha256('predicted', null, 4600::smallint, 2800::smallint, 2600::smallint, 0.62, $1::jsonb, 'payload-v1', $2::jsonb) as v",
    [JSON.stringify({ contract_version: "kapiloto-uncertainty-v1", total: 0.4 }), JSON.stringify({ rationale: { summary: "golden" } })],
  );
  assert.equal(output.rows[0].v, GOLDEN_OUTPUT);
  // The V2 canonical form of a V1-shaped bundle (no V2 families) is not the V1 hash:
  // the versions are hashed separately and never collide by accident.
  const v2 = await db.query<{ v: string }>("select private.prediction_input_bundle_sha256_v2($1::jsonb) as v", [
    JSON.stringify({ ...FIXED_INPUTS, memberships: [], tenures: [], squad_state_context: null }),
  ]);
  assert.notEqual(v2.rows[0].v, GOLDEN_BUNDLE);
  await db.close();
});

test("a V1 snapshot recorded end to end keeps its golden hashes, kind and null subject", async () => {
  const db = await createLedgerDatabase();
  const seed = await seedLedger(db);
  const fixture = await createFixture(db, seed, "2026-11-02T18:00:00.000Z");
  const payload = basePrediction(fixture.fixtureId, {
    idempotencyKey: "golden-v1",
    inputs: { identities: [{ entityType: "player", entityId: seed.home.playerIds[0], bindingRole: "starter" }] },
  });
  const recorded = await recordPrediction(db, payload, "2026-10-30T12:10:00.000Z");
  assert.equal(recorded.input_bundle_sha256, GOLDEN_E2E_INPUT);
  assert.equal(recorded.output_bundle_sha256, GOLDEN_E2E_OUTPUT);
  const row = await db.query<{ contract_version: string; prediction_kind: string; subject_team_id: string | null }>(
    "select contract_version, prediction_kind, subject_team_id from public.prediction_snapshots where id = $1",
    [recorded.snapshot_id],
  );
  assert.deepEqual(row.rows[0], { contract_version: "kapiloto-prediction-snapshot-v1", prediction_kind: "match_outcome", subject_team_id: null });
  // Exact replay through the unchanged V1 RPC is still idempotent.
  const replay = await recordPrediction(db, payload, "2026-10-30T12:11:00.000Z");
  assert.equal(replay.status, "unchanged");
  assert.equal(replay.snapshot_id, recorded.snapshot_id);
  await db.close();
});
