import assert from "node:assert/strict";
import test from "node:test";

import { canonicalSha256 } from "./canonical-json";
import { buildLineupForecast } from "./lineup-model";
import { lineupModelInput, squadStateArtifact } from "./lineup-snapshot";
import { buildFixtureSquadState } from "./squad-state";
import { GOLDEN_INPUTS, GOLDEN_POLICY, GOLDEN_TEAM as TEAM } from "./test-support/squad-golden-inputs";
import { createLedgerDatabase } from "./test-support/ledger-fixtures";

/**
 * V1 squad-state goldens, captured on main (5cd6c86) BEFORE the
 * membership-aware V2 builder existed. kapiloto-squad-state-builder-v1 /
 * kapiloto-squad-features-v1 must keep producing exactly these bytes, so
 * every frozen 1D snapshot stays replayable.
 */
const GOLDEN_V1_STATE_SHA256 = "98c0ffeabe47a84e2dfb1b8d83d0adb7ae4e5cf9b35e27ca9281bf793c5aa8a5";
const GOLDEN_V1_LINEUP_OUTPUT_SHA256 = "c10a57d18f526c7eba0baf4c3a745f3db9ea2af3195a70f5ab1835c8420dada2";
const GOLDEN_V2_BUNDLE_V1_CONTEXT_SHA256 = "e0bbbca93dc2d9df1cb5bd3c74e34489621e3cae4583fe47717279bc5f191db2";

const capture = process.env.KAPILOTO_CAPTURE_GOLDENS === "1";
const check = (label: string, actual: string, expected: string) => {
  if (capture) console.log(`GOLDEN ${label} ${actual}`);
  else assert.equal(actual, expected, label);
};

test("V1 squad state and the 1D lineup output on it are byte-for-byte unchanged", () => {
  const state = buildFixtureSquadState(GOLDEN_INPUTS, GOLDEN_POLICY);
  assert.equal(state.builder_version, "kapiloto-squad-state-builder-v1");
  assert.equal(state.features_version, "kapiloto-squad-features-v1");
  check("V1_STATE", squadStateArtifact(state).sha256, GOLDEN_V1_STATE_SHA256);
  check("V1_LINEUP_OUTPUT", canonicalSha256(buildLineupForecast(lineupModelInput(GOLDEN_INPUTS, state))), GOLDEN_V1_LINEUP_OUTPUT_SHA256);
});

test("the V2 canonical input bundle of a V1-context lineup snapshot is unchanged", async () => {
  const db = await createLedgerDatabase();
  const state = buildFixtureSquadState(GOLDEN_INPUTS, GOLDEN_POLICY);
  const artifact = squadStateArtifact(state);
  const inputs = {
    ledger: [{ ledger_observation_id: "11111111-1111-4111-8111-111111111111", input_role: "squad_history_selected" }],
    documents: [], claims: [], claim_observations: [], references: [],
    identities: [{ entity_type: "team", entity_id: TEAM, observed_entity_id: null, binding_role: "lineup_subject_team", context_team_id: null, provider: null, provider_entity_id: null }],
    memberships: [{ membership_id: "22222222-2222-4222-8222-222222222222", input_role: "squad_membership" }],
    tenures: [{ tenure_id: "33333333-3333-4333-8333-333333333333", input_role: "squad_coach_tenure" }],
    squad_state_context: {
      subject_team_id: TEAM,
      squad_state_inputs_contract: "kapiloto-squad-state-inputs-v1",
      squad_state_contract: "kapiloto-squad-state-v1",
      squad_state_builder_version: "kapiloto-squad-state-builder-v1",
      squad_features_version: "kapiloto-squad-features-v1",
      history_selection_policy_version: "kapiloto-history-selection-v1",
      availability_normalization_version: "kapiloto-availability-normalization-v1",
      target_date_policy: "kapiloto-target-date-utc-v1",
      provider_priority: ["sportmonks", "api_football"],
      history_max_fixtures: 10,
      squad_state_sha256: artifact.sha256,
      squad_state_canonical_json: artifact.canonicalJson,
    },
  };
  const result = await db.query<{ v: string }>("select private.prediction_input_bundle_sha256_v2($1::jsonb) as v", [JSON.stringify(inputs)]);
  check("V2_BUNDLE_V1_CONTEXT", result.rows[0].v, GOLDEN_V2_BUNDLE_V1_CONTEXT_SHA256);
  await db.close();
});
