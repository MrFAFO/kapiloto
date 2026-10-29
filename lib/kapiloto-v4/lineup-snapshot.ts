import { canonicalJson, sha256Hex } from "./canonical-json";
import { validateLineupForecastOutput, type LineupForecastOutput, type LineupModelInput } from "./lineup-model";
import {
  LINEUP_INPUT_ROLES,
  PREDICTION_REGISTRY_FUNCTIONS,
  buildPredictionSnapshotV2Payload,
  validatePredictionSnapshotV2,
  type IdentityBinding,
  type PredictionPurpose,
  type PredictionSnapshotV2Input,
  type RecordPredictionSnapshotResult,
  type SquadStateContext,
} from "./prediction-registry";
import {
  buildFixtureSquadState,
  loadSquadStateInputs,
  type FixtureSquadState,
  type HistoryObservationInput,
  type HistorySelectionPolicy,
  type SquadStateInputs,
  type SquadStateRpc,
} from "./squad-state";
import {
  AVAILABILITY_NORMALIZATION_VERSION,
  HISTORY_SELECTION_POLICY_VERSION,
  LINEUP_MODEL_VERSION,
  LINEUP_OUTPUT_CONTRACT_VERSION,
  LINEUP_PARAMETERS_VERSION,
  SQUAD_FEATURES_VERSION,
  SQUAD_STATE_BUILDER_VERSION,
  SQUAD_STATE_CONTRACT_VERSION,
  SQUAD_STATE_INPUTS_CONTRACT_VERSION,
} from "./versions";

/**
 * Layering (V4 1D): load squad inputs -> build squad state -> run the pure
 * lineup model -> build the V2 snapshot payload -> persist via
 * public.prediction_record_snapshot_v2. Only the load and persist helpers
 * call the database, through injected RPC functions.
 */

/**
 * Loads 1C inputs for a lineup forecast. The history window passed to the
 * as-of read is the policy's maxFixtures: the registry re-runs exactly this
 * read at commit and refuses any difference.
 */
export function loadLineupSquadInputs(
  rpc: SquadStateRpc,
  params: { fixtureId: string; teamId: string; cutoff: string; policy: HistorySelectionPolicy },
): Promise<SquadStateInputs> {
  return loadSquadStateInputs(rpc, { fixtureId: params.fixtureId, teamId: params.teamId, cutoff: params.cutoff, historyFixtureLimit: params.policy.maxFixtures });
}

/** The exact state bytes a forecast consumes, and their SHA-256. */
export function squadStateArtifact(state: FixtureSquadState): { canonicalJson: string; sha256: string } {
  const text = canonicalJson(state);
  return { canonicalJson: text, sha256: sha256Hex(text) };
}

/** SHA-256 of the exact canonical state bytes. */
export function squadStateSha256(state: FixtureSquadState): string {
  return squadStateArtifact(state).sha256;
}

/**
 * Retrieves the exact squad state a historical forecast consumed from its
 * frozen artifact. Throws unless the bytes hash to the frozen SHA-256 and are
 * canonical JSON.
 */
export function parseSquadStateArtifact(canonicalText: string, expectedSha256: string): FixtureSquadState {
  if (sha256Hex(canonicalText) !== expectedSha256) throw new Error("squad-state artifact does not hash to its frozen SHA-256");
  const state = JSON.parse(canonicalText) as FixtureSquadState;
  if (canonicalJson(state) !== canonicalText) throw new Error("squad-state artifact is not canonical JSON");
  return state;
}

/**
 * Rebuilds the state from current 1C inputs and compares hashes. This only
 * matches a historical artifact while no later identity merge changed what
 * the as-of read resolves; the frozen artifact is the replay record.
 */
export function verifySquadStateReconstruction(inputs: SquadStateInputs, policy: HistorySelectionPolicy, expectedSha256: string): boolean {
  return squadStateSha256(buildFixtureSquadState(inputs, policy)) === expectedSha256;
}

/** The lineup model's input for a state: the state, its hash and its selected ledger observations. */
export function lineupModelInput(inputs: SquadStateInputs, state: FixtureSquadState): LineupModelInput {
  const selected = new Set(state.provenance.ledger_observation_ids);
  return { state, squad_state_sha256: squadStateSha256(state), selected_history: inputs.history.filter((o) => selected.has(o.observation_id)) };
}

/**
 * Replay input for a historical forecast: its frozen state plus its selected
 * ledger observations (immutable rows, read again by id), with each row's
 * canonical player id taken from the FROZEN state (the candidate whose
 * observed ids contain the row's raw id), not from today's survivors.
 */
export function lineupReplayInput(frozenState: FixtureSquadState, frozenSha256: string, history: readonly HistoryObservationInput[]): LineupModelInput {
  const canonicalOf = new Map<string, string>();
  for (const candidate of frozenState.candidates) for (const id of candidate.observed_player_ids) canonicalOf.set(id, candidate.canonical_player_id);
  const selected = new Set(frozenState.provenance.ledger_observation_ids);
  return {
    state: frozenState,
    squad_state_sha256: frozenSha256,
    selected_history: history
      .filter((o) => selected.has(o.observation_id))
      .map((o) => ({ ...o, players: o.players.map((p) => ({ ...p, canonical_player_id: canonicalOf.get(p.observed_player_id) ?? p.observed_player_id })) })),
  };
}

export type LineupSnapshotMeta = {
  idempotencyKey: string;
  purpose: PredictionPurpose;
  predictionProtocolVersion: string;
  pipelineVersion: string;
  codeRevision: string;
  generatedAt: string;
};

/**
 * Freezes everything whose presence could change the 1C state: every
 * considered ledger observation (selected and alternatives), every membership
 * the as-of read returned, every target-fixture claim with its exact
 * resolution version, every tenure, the exact state artifact and an identity
 * binding for every player in the output.
 */
export function buildLineupForecastSnapshot(args: {
  inputs: SquadStateInputs;
  state: FixtureSquadState;
  policy: HistorySelectionPolicy;
  output: LineupForecastOutput;
  meta: LineupSnapshotMeta;
}): PredictionSnapshotV2Input {
  const { inputs, state, policy, output, meta } = args;
  const artifact = squadStateArtifact(state);
  if (output.squad_state_sha256 !== artifact.sha256) throw new Error("lineup output was not computed from this squad state");
  if (output.subject_team_id !== state.fixture.team_id || inputs.team_id !== state.fixture.team_id) throw new Error("team mismatch between inputs, state and output");

  const selected = new Set(state.history_selection.map((s) => s.observation_id));
  const context: SquadStateContext = {
    subjectTeamId: state.fixture.team_id,
    squadStateInputsContract: SQUAD_STATE_INPUTS_CONTRACT_VERSION,
    squadStateContract: SQUAD_STATE_CONTRACT_VERSION,
    squadStateBuilderVersion: SQUAD_STATE_BUILDER_VERSION,
    squadFeaturesVersion: SQUAD_FEATURES_VERSION,
    historySelectionPolicyVersion: HISTORY_SELECTION_POLICY_VERSION,
    availabilityNormalizationVersion: AVAILABILITY_NORMALIZATION_VERSION,
    targetDatePolicy: inputs.target_date_policy,
    providerPriority: [...policy.providerPriority],
    historyMaxFixtures: policy.maxFixtures,
    squadStateSha256: artifact.sha256,
    squadStateCanonicalJson: artifact.canonicalJson,
  };

  const identities: IdentityBinding[] = [
    { entityType: "team", entityId: state.fixture.team_id, bindingRole: "lineup_subject_team" },
    ...output.players.map((p): IdentityBinding => ({
      entityType: "player",
      entityId: p.canonical_player_id,
      // One observed raw id per binding; the full list stays in the payload.
      observedEntityId: p.observed_player_ids.find((id) => id !== p.canonical_player_id) ?? null,
      bindingRole: "lineup_candidate",
      contextTeamId: state.fixture.team_id,
    })),
    ...state.coach.candidate_coach_ids.map((id): IdentityBinding => ({ entityType: "coach", entityId: id, bindingRole: "lineup_coach_candidate", contextTeamId: state.fixture.team_id })),
  ];

  const projected = output.status === "projected";
  return {
    idempotencyKey: meta.idempotencyKey,
    fixtureId: state.fixture.fixture_id,
    purpose: meta.purpose,
    predictionKind: "lineup_forecast",
    subjectTeamId: state.fixture.team_id,
    predictionProtocolVersion: meta.predictionProtocolVersion,
    pipelineVersion: meta.pipelineVersion,
    codeRevision: meta.codeRevision,
    modelIdentifiers: { lineup_model: LINEUP_MODEL_VERSION, lineup_parameters: LINEUP_PARAMETERS_VERSION },
    featureVersions: { squad_features: SQUAD_FEATURES_VERSION, history_selection: HISTORY_SELECTION_POLICY_VERSION },
    researchCutoffAt: state.fixture.cutoff,
    kickoffAtSnapshot: state.fixture.kickoff_at,
    generatedAt: meta.generatedAt,
    outcome: projected ? "predicted" : "abstained",
    abstainReason: projected ? null : output.status,
    probabilities: null,
    reliability: null,
    payloadSchemaVersion: LINEUP_OUTPUT_CONTRACT_VERSION,
    payload: { lineup_estimate: output },
    inputs: {
      ledger: inputs.history.map((o) => ({
        ledgerObservationId: o.observation_id,
        inputRole: selected.has(o.observation_id) ? LINEUP_INPUT_ROLES.historySelected : LINEUP_INPUT_ROLES.historyAlternative,
      })),
      claims: inputs.claims.map((c) => ({
        claimId: c.resolution_claim_id ?? c.claim_id,
        resolutionId: c.resolution_id,
        inputRole: c.claim_type === "player_availability" ? LINEUP_INPUT_ROLES.availabilityClaim : LINEUP_INPUT_ROLES.lineupClaim,
      })),
      memberships: inputs.memberships.map((m) => ({ membershipId: m.membership_id, inputRole: LINEUP_INPUT_ROLES.membership })),
      tenures: inputs.tenures.map((t) => ({ tenureId: t.tenure_id, inputRole: LINEUP_INPUT_ROLES.coachTenure })),
      identities,
      squadStateContext: context,
    },
  };
}

export type PredictionRegistryV2Rpc = (
  fn: typeof PREDICTION_REGISTRY_FUNCTIONS.recordSnapshotV2,
  args: { p_snapshot: Record<string, unknown> },
) => Promise<unknown>;

/**
 * Persists a lineup forecast snapshot through public.prediction_record_snapshot_v2
 * (service_role) after validating the snapshot and its lineup output contract.
 */
export async function recordLineupForecastSnapshot(
  rpc: PredictionRegistryV2Rpc,
  snapshot: PredictionSnapshotV2Input,
): Promise<RecordPredictionSnapshotResult> {
  const issues = validatePredictionSnapshotV2(snapshot);
  if (snapshot.predictionKind !== "lineup_forecast") issues.push("not a lineup forecast");
  const estimate = snapshot.payload?.lineup_estimate as LineupForecastOutput | undefined;
  const context = snapshot.inputs.squadStateContext;
  if (estimate && context && snapshot.subjectTeamId) {
    issues.push(...validateLineupForecastOutput(estimate, { fixtureId: snapshot.fixtureId, subjectTeamId: snapshot.subjectTeamId, squadStateSha256: context.squadStateSha256 }));
    try {
      const state = parseSquadStateArtifact(context.squadStateCanonicalJson, context.squadStateSha256);
      const candidates = [...state.provenance.canonical_player_ids].sort();
      const players = estimate.players.map((p) => p.canonical_player_id).sort();
      if (players.length > 0 && (players.length !== candidates.length || players.some((id, i) => id !== candidates[i]))) {
        issues.push("lineup estimate players are not exactly the frozen squad-state candidates");
      }
    } catch (error) {
      issues.push((error as Error).message);
    }
  }
  if (issues.length > 0) throw new Error(`invalid lineup forecast snapshot: ${issues.join("; ")}`);
  return (await rpc(PREDICTION_REGISTRY_FUNCTIONS.recordSnapshotV2, { p_snapshot: buildPredictionSnapshotV2Payload(snapshot) })) as RecordPredictionSnapshotResult;
}
