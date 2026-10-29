import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, canonicalSha256, sha256Hex } from "./canonical-json";
import {
  LINEUP_INPUT_ROLES,
  buildPredictionSnapshotPayload,
  buildPredictionSnapshotV2Payload,
  validatePredictionSnapshotV2,
  type PredictionSnapshotV2Input,
  type SquadStateContext,
} from "./prediction-registry";

/** Pure V2 contract: payload shape, validation and canonical JSON. */

const TEAM = "A0000000-0000-4000-8000-000000000001";
const FIXTURE = "f0000000-0000-4000-8000-000000000001";
const STATE_TEXT = canonicalJson({ fixture: { fixture_id: FIXTURE } });

const context: SquadStateContext = {
  subjectTeamId: TEAM,
  squadStateInputsContract: "kapiloto-squad-state-inputs-v1",
  squadStateContract: "kapiloto-squad-state-v1",
  squadStateBuilderVersion: "kapiloto-squad-state-builder-v1",
  squadFeaturesVersion: "kapiloto-squad-features-v1",
  historySelectionPolicyVersion: "kapiloto-history-selection-v1",
  availabilityNormalizationVersion: "kapiloto-availability-normalization-v1",
  targetDatePolicy: "kapiloto-target-date-utc-v1",
  providerPriority: ["sportmonks", "api_football"],
  historyMaxFixtures: 10,
  squadStateSha256: sha256Hex(STATE_TEXT),
  squadStateCanonicalJson: STATE_TEXT,
};

function lineup(patch: Partial<PredictionSnapshotV2Input> = {}): PredictionSnapshotV2Input {
  return {
    idempotencyKey: "lineup-contract",
    fixtureId: FIXTURE,
    purpose: "shadow",
    predictionKind: "lineup_forecast",
    subjectTeamId: TEAM,
    predictionProtocolVersion: "p",
    pipelineVersion: "p",
    codeRevision: "abcdef0",
    researchCutoffAt: "2026-10-30T12:00:00.000Z",
    kickoffAtSnapshot: "2026-11-02T18:00:00.000Z",
    generatedAt: "2026-10-30T12:05:00.000Z",
    outcome: "predicted",
    probabilities: null,
    payloadSchemaVersion: "kapiloto-lineup-output-v1",
    payload: { lineup_estimate: { status: "projected" } },
    inputs: {
      memberships: [{ membershipId: "B0000000-0000-4000-8000-000000000001", inputRole: LINEUP_INPUT_ROLES.membership }],
      tenures: [{ tenureId: "c0000000-0000-4000-8000-000000000001" }],
      squadStateContext: context,
    },
    ...patch,
  };
}

test("the V2 payload is the V1 payload plus kind, subject team and the 1C families", () => {
  const payload = buildPredictionSnapshotV2Payload(lineup()) as Record<string, any>;
  assert.equal(payload.contract_version, "kapiloto-prediction-snapshot-v2");
  assert.equal(payload.prediction_kind, "lineup_forecast");
  assert.equal(payload.subject_team_id, TEAM.toLowerCase());
  assert.deepEqual(payload.inputs.memberships, [{ membership_id: "b0000000-0000-4000-8000-000000000001", input_role: "squad_membership" }]);
  assert.deepEqual(payload.inputs.tenures, [{ tenure_id: "c0000000-0000-4000-8000-000000000001", input_role: null }]);
  assert.deepEqual(payload.inputs.squad_state_context, {
    subject_team_id: TEAM.toLowerCase(),
    squad_state_inputs_contract: "kapiloto-squad-state-inputs-v1",
    squad_state_contract: "kapiloto-squad-state-v1",
    squad_state_builder_version: "kapiloto-squad-state-builder-v1",
    squad_features_version: "kapiloto-squad-features-v1",
    history_selection_policy_version: "kapiloto-history-selection-v1",
    availability_normalization_version: "kapiloto-availability-normalization-v1",
    target_date_policy: "kapiloto-target-date-utc-v1",
    provider_priority: ["sportmonks", "api_football"],
    history_max_fixtures: 10,
    squad_state_sha256: sha256Hex(STATE_TEXT),
    squad_state_canonical_json: STATE_TEXT,
  });
  // Every V1 field is carried unchanged.
  const { memberships, tenures, squadStateContext, ...v1Inputs } = lineup().inputs;
  const v1 = buildPredictionSnapshotPayload({ ...lineup(), inputs: v1Inputs }) as Record<string, any>;
  for (const key of Object.keys(v1).filter((k) => k !== "contract_version" && k !== "inputs")) assert.deepEqual(payload[key], v1[key], key);
  assert.equal([memberships, tenures, squadStateContext].length, 3);
});

test("V2 validation: kind-specific rules", () => {
  assert.deepEqual(validatePredictionSnapshotV2(lineup()), []);
  assert.ok(validatePredictionSnapshotV2(lineup({ subjectTeamId: null })).includes("a lineup forecast needs a subject team"));
  assert.ok(validatePredictionSnapshotV2(lineup({ probabilities: { p1Bp: 4000, pXBp: 3000, p2Bp: 3000 } })).includes("a lineup forecast has no 1/X/2 probabilities"));
  assert.ok(validatePredictionSnapshotV2(lineup({ payload: {} })).includes("a predicted lineup forecast needs lineup_estimate"));
  assert.ok(validatePredictionSnapshotV2(lineup({ outcome: "abstained" })).includes("an abstained snapshot needs an abstain reason"));
  assert.ok(validatePredictionSnapshotV2(lineup({ inputs: {} })).includes("a lineup forecast needs its squad-state context"));
  assert.ok(validatePredictionSnapshotV2(lineup({ inputs: { squadStateContext: { ...context, subjectTeamId: FIXTURE } } })).includes("squad-state context team differs from the subject team"));
  assert.ok(validatePredictionSnapshotV2(lineup({ researchCutoffAt: "2026-11-03T00:00:00.000Z" })).includes("research cutoff is after kickoff"));
  assert.ok(validatePredictionSnapshotV2(lineup({ inputs: { squadStateContext: { ...context, squadStateCanonicalJson: `${STATE_TEXT} ` } } })).includes("squad-state artifact does not hash to its SHA-256"));

  const outcome = lineup({ predictionKind: "match_outcome", subjectTeamId: null, probabilities: { p1Bp: 4600, pXBp: 2800, p2Bp: 2600 }, payload: {}, inputs: {} });
  assert.deepEqual(validatePredictionSnapshotV2(outcome), []);
  assert.ok(validatePredictionSnapshotV2({ ...outcome, subjectTeamId: TEAM }).includes("a match outcome has no subject team"));
  assert.ok(validatePredictionSnapshotV2({ ...outcome, inputs: { squadStateContext: context } }).includes("only lineup forecasts carry a squad-state context"));
  assert.ok(validatePredictionSnapshotV2({ ...outcome, probabilities: null }).length > 0);
});

test("canonical JSON: sorted keys, no undefined, finite numbers only", () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: undefined, e: null }] }), '{"a":[{"d":2,"e":null}],"b":1}');
  assert.equal(canonicalSha256({ x: 1, y: { b: 2, a: 1 } }), canonicalSha256({ y: { a: 1, b: 2 }, x: 1 }));
  assert.notEqual(canonicalSha256({ x: 1 }), canonicalSha256({ x: 2 }));
  assert.throws(() => canonicalJson({ x: Number.NaN }));
  assert.throws(() => canonicalJson({ x: Number.POSITIVE_INFINITY }));
  assert.match(canonicalSha256([]), /^[0-9a-f]{64}$/);
});
