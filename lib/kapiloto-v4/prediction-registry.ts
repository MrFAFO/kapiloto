import { PREDICTION_SNAPSHOT_CONTRACT_VERSION, UNCERTAINTY_DECOMPOSITION_VERSION } from "./versions";

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
} as const;
