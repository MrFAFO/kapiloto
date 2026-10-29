import { sha256Hex } from "./canonical-json";
import { isSupportedSquadStateBuild, type SquadFeaturesVersion, type SquadStateBuilderVersion } from "./squad-state";
import {
  AVAILABILITY_NORMALIZATION_VERSION,
  HISTORY_SELECTION_POLICY_VERSION,
  PREDICTION_SNAPSHOT_CONTRACT_VERSION,
  PREDICTION_SNAPSHOT_V2_CONTRACT_VERSION,
  SQUAD_STATE_CONTRACT_VERSION,
  SQUAD_STATE_INPUTS_CONTRACT_VERSION,
  SQUAD_TARGET_DATE_POLICY_VERSION,
  UNCERTAINTY_DECOMPOSITION_VERSION,
} from "./versions";

/**
 * Prediction Registry contracts (V4 Foundation 1B).
 *
 * A prediction snapshot is the immutable scientific record of one prediction:
 * versions and hashes, the information cutoff, the outputs, the EXACT input
 * rows it used (ledger versions, document versions, claims with the exact
 * resolution version, claim observations, market/structured snapshots,
 * optional legacy V3 provenance) and the canonical identities it used.
 * Later truth, merges, model changes or market moves never update it; future
 * evaluation lives in separate append-only structures.
 *
 * Not coupled to Sol output types: model sections are versioned, bounded
 * JSON keyed by PREDICTION_PAYLOAD_SECTIONS.
 */

export const PREDICTION_PURPOSES = ["production", "shadow", "benchmark", "backtest", "challenger"] as const;
export type PredictionPurpose = (typeof PREDICTION_PURPOSES)[number];

export const PREDICTION_OUTCOMES = ["predicted", "abstained"] as const;
export type PredictionOutcome = (typeof PREDICTION_OUTCOMES)[number];

/** Allowed top-level payload keys (the database refuses any other key). */
export const PREDICTION_PAYLOAD_SECTIONS = [
  "formation_estimate",
  "lineup_estimate",
  "scenarios",
  "tactical_state",
  "matchup_hypotheses",
  "recommendation",
  /** Auditable rationale artifacts only, never hidden reasoning traces. */
  "rationale",
] as const;
export type PredictionPayloadSection = (typeof PREDICTION_PAYLOAD_SECTIONS)[number];

export const PREDICTION_REFERENCE_KINDS = [
  "market_quote",
  "market_snapshot",
  "structured_snapshot",
  "fact_snapshot",
  /** Legacy V3 provenance: soft ids, not validated, not leakage-checked. */
  "v3_research_run",
  "v3_analysis",
  "v3_evidence",
] as const;
export type PredictionReferenceKind = (typeof PREDICTION_REFERENCE_KINDS)[number];

export const IDENTITY_ENTITY_TYPES = ["player", "coach", "team"] as const;
export type IdentityEntityType = (typeof IDENTITY_ENTITY_TYPES)[number];

/**
 * Uncertainty decomposition (kapiloto-uncertainty-v1). Components are
 * non-negative and need not sum to total; absent means not estimated.
 */
export const UNCERTAINTY_COMPONENTS = [
  "total",
  "outcome_noise",
  "model_epistemic",
  "information_gap",
  "lineup",
  "market_disagreement",
] as const;
export type UncertaintyComponent = (typeof UNCERTAINTY_COMPONENTS)[number];
export type UncertaintyDecomposition = {
  contract_version: typeof UNCERTAINTY_DECOMPOSITION_VERSION;
} & Partial<Record<UncertaintyComponent, number>>;

/** One canonical identity as the prediction used it. */
export type IdentityBinding = {
  entityType: IdentityEntityType;
  /** The surviving canonical id the prediction used (active when recorded). */
  entityId: string;
  /** Raw id as stored in an input, when it differed (players/coaches). */
  observedEntityId?: string | null;
  bindingRole: string;
  contextTeamId?: string | null;
  provider?: string | null;
  providerEntityId?: string | null;
};

export type PredictionInputs = {
  ledger?: { ledgerObservationId: string; inputRole?: string }[];
  documents?: { documentVersionId: string; inputRole?: string }[];
  /** resolutionId: the exact resolution version used; null = unadjudicated. */
  claims?: { claimId: string; resolutionId: string | null; inputRole?: string }[];
  claimObservations?: { claimObservationId: string; inputRole?: string }[];
  references?: { referenceKind: PredictionReferenceKind; referenceId: string; inputRole?: string }[];
  identities?: IdentityBinding[];
};

export type PredictionSnapshotInput = {
  /** Replay key of ONE intended write; never derived from content. */
  idempotencyKey: string;
  fixtureId: string;
  roundGameId?: string | null;
  purpose: PredictionPurpose;
  predictionProtocolVersion: string;
  pipelineVersion: string;
  codeRevision: string;
  modelIdentifiers?: Record<string, string>;
  promptHashes?: Record<string, string>;
  featureVersions?: Record<string, string>;
  derivationVersion?: string | null;
  calibrationVersion?: string | null;
  settlementRule?: string | null;
  researchCutoffAt: string;
  kickoffAtSnapshot: string;
  generatedAt: string;
  outcome: PredictionOutcome;
  abstainReason?: string | null;
  probabilities?: { p1Bp: number; pXBp: number; p2Bp: number } | null;
  reliability?: number | null;
  uncertainty?: UncertaintyDecomposition | Record<string, never>;
  payloadSchemaVersion: string;
  payload?: Partial<Record<PredictionPayloadSection, unknown>>;
  inputs: PredictionInputs;
};

export type RecordPredictionSnapshotResult = {
  status: "recorded" | "unchanged";
  snapshot_id: string;
  first_seen_at: string;
  input_bundle_sha256: string;
  output_bundle_sha256: string;
};

/**
 * Deterministic 1/X/2 basis points that always sum to 10,000: floor each
 * share, then hand the remaining points to the largest remainders, ties in
 * 1, X, 2 order.
 */
export function toBasisPoints(p1: number, pX: number, p2: number): { p1Bp: number; pXBp: number; p2Bp: number } {
  const values = [p1, pX, p2];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("probabilities must be finite and non-negative");
  const sum = values.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new Error("probabilities must not all be zero");
  const scaled = values.map((value) => (value / sum) * 10_000);
  const floors = scaled.map(Math.floor);
  let remaining = 10_000 - floors.reduce((a, b) => a + b, 0);
  const order = scaled
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of order) {
    if (remaining === 0) break;
    floors[index] += 1;
    remaining -= 1;
  }
  return { p1Bp: floors[0], pXBp: floors[1], p2Bp: floors[2] };
}

export function validatePredictionSnapshot(input: PredictionSnapshotInput): string[] {
  const issues: string[] = [];
  const probabilities = input.probabilities;
  if (input.outcome === "predicted") {
    if (!probabilities) issues.push("a predicted snapshot needs probabilities");
    else {
      const parts = [probabilities.p1Bp, probabilities.pXBp, probabilities.p2Bp];
      if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 10_000)) issues.push("basis points must be integers in 0..10000");
      if (parts.reduce((a, b) => a + b, 0) !== 10_000) issues.push("basis points must sum to 10000");
    }
    if (input.abstainReason) issues.push("a predicted snapshot has no abstain reason");
  } else {
    if (probabilities) issues.push("an abstained snapshot has no probabilities");
    if (!input.abstainReason) issues.push("an abstained snapshot needs an abstain reason");
  }
  if (Date.parse(input.researchCutoffAt) > Date.parse(input.kickoffAtSnapshot)) issues.push("research cutoff is after kickoff");
  if (Date.parse(input.generatedAt) < Date.parse(input.researchCutoffAt)) issues.push("generated before its own cutoff");
  for (const key of Object.keys(input.payload ?? {})) {
    if (!(PREDICTION_PAYLOAD_SECTIONS as readonly string[]).includes(key)) issues.push(`unknown payload section ${key}`);
  }
  const seen = new Set<string>();
  for (const binding of input.inputs.identities ?? []) {
    const key = `${binding.entityType}:${binding.entityId.toLowerCase()}:${binding.bindingRole}`;
    if (seen.has(key)) issues.push(`identity binding ${key} repeats`);
    seen.add(key);
    if (binding.entityType === "team" && binding.observedEntityId) issues.push("team bindings have no observed id");
  }
  return issues;
}

const lowerId = (value: string | null | undefined): string | null =>
  value === undefined || value === null ? null : value.toLowerCase();

/** Maps the camelCase input to the RPC payload with canonical id casing. */
export function buildPredictionSnapshotPayload(input: PredictionSnapshotInput): Record<string, unknown> {
  const inputs = input.inputs;
  return {
    contract_version: PREDICTION_SNAPSHOT_CONTRACT_VERSION,
    idempotency_key: input.idempotencyKey,
    fixture_id: lowerId(input.fixtureId),
    round_game_id: lowerId(input.roundGameId),
    purpose: input.purpose,
    prediction_protocol_version: input.predictionProtocolVersion,
    pipeline_version: input.pipelineVersion,
    code_revision: input.codeRevision,
    model_identifiers: input.modelIdentifiers ?? {},
    prompt_hashes: input.promptHashes ?? {},
    feature_versions: input.featureVersions ?? {},
    derivation_version: input.derivationVersion ?? null,
    calibration_version: input.calibrationVersion ?? null,
    settlement_rule: input.settlementRule ?? null,
    research_cutoff_at: input.researchCutoffAt,
    kickoff_at_snapshot: input.kickoffAtSnapshot,
    generated_at: input.generatedAt,
    outcome: input.outcome,
    abstain_reason: input.abstainReason ?? null,
    p_1_bp: input.probabilities?.p1Bp ?? null,
    p_x_bp: input.probabilities?.pXBp ?? null,
    p_2_bp: input.probabilities?.p2Bp ?? null,
    reliability: input.reliability ?? null,
    uncertainty: input.uncertainty ?? {},
    payload_schema_version: input.payloadSchemaVersion,
    payload: input.payload ?? {},
    inputs: {
      ledger: (inputs.ledger ?? []).map((item) => ({
        ledger_observation_id: item.ledgerObservationId.toLowerCase(),
        input_role: item.inputRole ?? null,
      })),
      documents: (inputs.documents ?? []).map((item) => ({
        document_version_id: item.documentVersionId.toLowerCase(),
        input_role: item.inputRole ?? null,
      })),
      claims: (inputs.claims ?? []).map((item) => ({
        claim_id: item.claimId.toLowerCase(),
        resolution_id: lowerId(item.resolutionId),
        input_role: item.inputRole ?? null,
      })),
      claim_observations: (inputs.claimObservations ?? []).map((item) => ({
        claim_observation_id: item.claimObservationId.toLowerCase(),
        input_role: item.inputRole ?? null,
      })),
      references: (inputs.references ?? []).map((item) => ({
        reference_kind: item.referenceKind,
        reference_id: item.referenceId.toLowerCase(),
        input_role: item.inputRole ?? null,
      })),
      identities: (inputs.identities ?? []).map((binding) => ({
        entity_type: binding.entityType,
        entity_id: binding.entityId.toLowerCase(),
        observed_entity_id: lowerId(binding.observedEntityId),
        binding_role: binding.bindingRole,
        context_team_id: lowerId(binding.contextTeamId),
        provider: binding.provider ?? null,
        provider_entity_id: binding.providerEntityId ?? null,
      })),
    },
  };
}

export const PREDICTION_REGISTRY_FUNCTIONS = {
  recordSnapshot: "prediction_record_snapshot",
  recordSnapshotV2: "prediction_record_snapshot_v2",
} as const;

// ---------------------------------------------------------------------------
// Prediction Registry V2 (kapiloto-prediction-snapshot-v2)
// ---------------------------------------------------------------------------

/**
 * V1 snapshots are always match_outcome. V2 adds lineup_forecast: no 1/X/2,
 * team-scoped by subjectTeamId, lineup_estimate payload required when
 * predicted. A V2 snapshot freezes the 1C inputs too.
 */
export const PREDICTION_KINDS = ["match_outcome", "lineup_forecast"] as const;
export type PredictionKind = (typeof PREDICTION_KINDS)[number];

/** Input roles a lineup forecast must use (enforced by the database). */
export const LINEUP_INPUT_ROLES = {
  historySelected: "squad_history_selected",
  historyAlternative: "squad_history_alternative",
  membership: "squad_membership",
  availabilityClaim: "squad_availability_claim",
  lineupClaim: "squad_lineup_claim",
  coachTenure: "squad_coach_tenure",
} as const;

/** One row of prediction_squad_state_context: the exact 1C state a lineup forecast consumed. */
export type SquadStateContext = {
  subjectTeamId: string;
  squadStateInputsContract: typeof SQUAD_STATE_INPUTS_CONTRACT_VERSION;
  squadStateContract: typeof SQUAD_STATE_CONTRACT_VERSION;
  /** builder-v1 + features-v1 (frozen 1D replay) or builder-v2 + features-v2 (membership-aware). */
  squadStateBuilderVersion: SquadStateBuilderVersion;
  squadFeaturesVersion: SquadFeaturesVersion;
  historySelectionPolicyVersion: typeof HISTORY_SELECTION_POLICY_VERSION;
  availabilityNormalizationVersion: typeof AVAILABILITY_NORMALIZATION_VERSION;
  targetDatePolicy: typeof SQUAD_TARGET_DATE_POLICY_VERSION;
  providerPriority: string[];
  historyMaxFixtures: number;
  squadStateSha256: string;
  /** canonicalJson(state): the exact bytes the model consumed; squadStateSha256 is their SHA-256. */
  squadStateCanonicalJson: string;
};

export type PredictionInputsV2 = PredictionInputs & {
  memberships?: { membershipId: string; inputRole?: string }[];
  tenures?: { tenureId: string; inputRole?: string }[];
  squadStateContext?: SquadStateContext | null;
};

export type PredictionSnapshotV2Input = Omit<PredictionSnapshotInput, "inputs"> & {
  predictionKind: PredictionKind;
  /** Required for lineup_forecast (home or away of the fixture); null for match_outcome. */
  subjectTeamId: string | null;
  inputs: PredictionInputsV2;
};

export function validatePredictionSnapshotV2(input: PredictionSnapshotV2Input): string[] {
  if (input.predictionKind === "match_outcome") {
    const issues = validatePredictionSnapshot({ ...input, inputs: input.inputs });
    if (input.subjectTeamId) issues.push("a match outcome has no subject team");
    if (input.inputs.squadStateContext) issues.push("only lineup forecasts carry a squad-state context");
    return issues;
  }
  const issues: string[] = [];
  if (!input.subjectTeamId) issues.push("a lineup forecast needs a subject team");
  if (input.probabilities) issues.push("a lineup forecast has no 1/X/2 probabilities");
  if (input.outcome === "predicted" && !input.payload?.lineup_estimate) issues.push("a predicted lineup forecast needs lineup_estimate");
  if (input.outcome === "abstained" && !input.abstainReason) issues.push("an abstained snapshot needs an abstain reason");
  if (!input.inputs.squadStateContext) issues.push("a lineup forecast needs its squad-state context");
  else {
    if (input.inputs.squadStateContext.subjectTeamId.toLowerCase() !== input.subjectTeamId?.toLowerCase()) {
      issues.push("squad-state context team differs from the subject team");
    }
    if (sha256Hex(input.inputs.squadStateContext.squadStateCanonicalJson) !== input.inputs.squadStateContext.squadStateSha256) {
      issues.push("squad-state artifact does not hash to its SHA-256");
    }
    if (!isSupportedSquadStateBuild(input.inputs.squadStateContext.squadStateBuilderVersion, input.inputs.squadStateContext.squadFeaturesVersion)) {
      issues.push("unsupported squad-state builder/features version pair");
    }
  }
  if (Date.parse(input.researchCutoffAt) > Date.parse(input.kickoffAtSnapshot)) issues.push("research cutoff is after kickoff");
  return issues;
}

/** V1 payload fields plus kind, subject team and the V2 input families. */
export function buildPredictionSnapshotV2Payload(input: PredictionSnapshotV2Input): Record<string, unknown> {
  const { memberships, tenures, squadStateContext, ...v1Inputs } = input.inputs;
  const base = buildPredictionSnapshotPayload({ ...input, inputs: v1Inputs });
  const context = squadStateContext ?? null;
  return {
    ...base,
    contract_version: PREDICTION_SNAPSHOT_V2_CONTRACT_VERSION,
    prediction_kind: input.predictionKind,
    subject_team_id: lowerId(input.subjectTeamId),
    inputs: {
      ...(base.inputs as Record<string, unknown>),
      memberships: (memberships ?? []).map((item) => ({ membership_id: item.membershipId.toLowerCase(), input_role: item.inputRole ?? null })),
      tenures: (tenures ?? []).map((item) => ({ tenure_id: item.tenureId.toLowerCase(), input_role: item.inputRole ?? null })),
      squad_state_context: context && {
        subject_team_id: context.subjectTeamId.toLowerCase(),
        squad_state_inputs_contract: context.squadStateInputsContract,
        squad_state_contract: context.squadStateContract,
        squad_state_builder_version: context.squadStateBuilderVersion,
        squad_features_version: context.squadFeaturesVersion,
        history_selection_policy_version: context.historySelectionPolicyVersion,
        availability_normalization_version: context.availabilityNormalizationVersion,
        target_date_policy: context.targetDatePolicy,
        provider_priority: [...context.providerPriority],
        history_max_fixtures: context.historyMaxFixtures,
        squad_state_sha256: context.squadStateSha256,
        squad_state_canonical_json: context.squadStateCanonicalJson,
      },
    },
  };
}
