import { CLAIM_CONTRACT_VERSION, CLAIM_RESOLUTION_CONTRACT_VERSION } from "./versions";

/**
 * Claim contracts (V4 Foundation 1B).
 *
 * CLAIM: a structured proposition ("player X availability for fixture Y is
 * doubtful"), deduplicated by a database fingerprint of every structured
 * dimension. Prose is a label and never identity.
 * CLAIM OBSERVATION: what one document version appears to say about a claim.
 * CLAIM RESOLUTION: Kapiloto's versioned adjudication of a claim.
 * DERIVED claims (inference, hypothesis, scenario, adjustment) are not
 * reported by sources; they cite derived_from premises.
 */

export const CLAIM_KINDS = [
  "observed_fact",
  "reported_expectation",
  "derived_inference",
  "matchup_hypothesis",
  "scenario",
  "probability_adjustment",
] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

/** Kinds a source can report; observations attach to these. */
export const SOURCE_CLAIM_KINDS: readonly ClaimKind[] = ["observed_fact", "reported_expectation"];
/** Kinds that must cite at least one derived_from premise. */
export const DERIVED_CLAIM_KINDS: readonly ClaimKind[] = [
  "derived_inference",
  "matchup_hypothesis",
  "scenario",
  "probability_adjustment",
];

export const CLAIM_POLARITIES = ["affirmed", "negated"] as const;
export type ClaimPolarity = (typeof CLAIM_POLARITIES)[number];

export const CLAIM_TEMPORAL_SCOPES = ["fixture", "date_range", "season", "ongoing", "instant"] as const;
export type ClaimTemporalScope = (typeof CLAIM_TEMPORAL_SCOPES)[number];

/**
 * Known claim types and predicates (open vocabulary: the database checks the
 * key format, this registry documents the meaning).
 */
export const CLAIM_TYPE_REGISTRY = {
  player_availability: { predicates: ["availability_status"], objectKeys: ["status"] },
  expected_lineup: { predicates: ["starts", "on_bench", "not_in_squad"], objectKeys: [] },
  formation_used: { predicates: ["uses_formation"], objectKeys: ["formation"] },
  formation_change: { predicates: ["changes_formation"], objectKeys: ["from", "to"] },
  fixture_congestion: { predicates: ["rest_days_before"], objectKeys: ["days", "previous_fixture_id"] },
  set_piece_defending: { predicates: ["weakness"], objectKeys: ["level"] },
} as const;

export const OBSERVATION_RELATIONSHIPS = ["supports", "contradicts", "mentions"] as const;
export type ObservationRelationship = (typeof OBSERVATION_RELATIONSHIPS)[number];

export const EXTRACTOR_KINDS = ["model", "rule", "manual"] as const;
export type ExtractorKind = (typeof EXTRACTOR_KINDS)[number];

export const CLAIM_RELATION_TYPES = ["derived_from", "supports", "contradicts", "supersedes", "refines"] as const;
export type ClaimRelationType = (typeof CLAIM_RELATION_TYPES)[number];
/** The database refuses any insert that would close a cycle of these. */
export const ACYCLIC_CLAIM_RELATION_TYPES: readonly ClaimRelationType[] = ["derived_from", "supersedes", "refines"];

/**
 * Resolution lattice. verified_degraded = likely true but with incomplete
 * metadata/provenance (never a reason to drop true information);
 * quarantined = possibly useful, not safe to drive conclusions; contradicted
 * = later evidence says it is false; fabricated = the source, quote or fact
 * itself was invented. Missing metadata is never fabrication.
 */
export const RESOLUTION_STATUSES = [
  "unresolved",
  "verified",
  "verified_degraded",
  "quarantined",
  "contradicted",
  "fabricated",
] as const;
export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];

/** Statuses that must cite at least one evidence row. */
export const EVIDENCED_RESOLUTION_STATUSES: readonly ResolutionStatus[] = [
  "verified",
  "verified_degraded",
  "contradicted",
  "fabricated",
];

export const RESOLVER_KINDS = [
  "grounding",
  "ledger_truth",
  "provider_truth",
  "post_match",
  "manual_review",
  "model_verifier",
] as const;
export type ResolverKind = (typeof RESOLVER_KINDS)[number];

/** The only reason codes a fabricated resolution may carry. */
export const FABRICATION_REASON_CODES = [
  "source_not_found",
  "document_not_found",
  "quote_not_in_source",
  "fact_invented",
  "identity_invented",
] as const;

export const EVIDENCE_ROLES = ["supporting", "contradicting", "context", "absence"] as const;
export type EvidenceRole = (typeof EVIDENCE_ROLES)[number];

export type ClaimInput = {
  claimKind: ClaimKind;
  claimType: string;
  predicate: string;
  fixtureId?: string | null;
  teamId?: string | null;
  playerId?: string | null;
  coachId?: string | null;
  objectValue?: Record<string, unknown>;
  polarity?: ClaimPolarity;
  temporalScope: ClaimTemporalScope;
  scopeStartsOn?: string | null;
  scopeEndsOn?: string | null;
  /** Label only; never part of identity. */
  statementText?: string | null;
  /** Premise claim ids (required for derived kinds). */
  premises?: string[];
  assertedByVersion?: string | null;
};

export type RecordClaimResult = { status: "recorded" | "existing"; claim_id: string; first_seen_at: string };

/** Exactly one cited row per evidence item. */
export type ResolutionEvidenceInput = {
  evidenceRole: EvidenceRole;
  claimObservationId?: string;
  documentVersionId?: string;
  ledgerObservationId?: string;
  ledgerPlayerId?: string;
  ledgerEventId?: string;
  note?: string | null;
};

export type ClaimResolutionInput = {
  claimId: string;
  status: ResolutionStatus;
  confidence?: number | null;
  resolverKind: ResolverKind;
  resolverVersion: string;
  resolverId?: string | null;
  reasonCode: string;
  /** Metadata/provenance gaps, e.g. missing_published_at. */
  qualityFlags?: string[];
  note?: string | null;
  idempotencyKey?: string | null;
  evidence?: ResolutionEvidenceInput[];
};

export type RecordClaimResolutionResult = {
  status: "recorded" | "unchanged";
  resolution_id: string;
  resolution_version: number;
  first_seen_at: string;
};

const lowerId = (value: string | null | undefined): string | null =>
  value === undefined || value === null ? null : value.toLowerCase();

export function validateClaim(input: ClaimInput): string[] {
  const issues: string[] = [];
  if (![input.fixtureId, input.teamId, input.playerId, input.coachId].some(Boolean)) {
    issues.push("a claim needs at least one subject (fixture, team, player or coach)");
  }
  if (input.temporalScope === "fixture" && !input.fixtureId) issues.push("a fixture-scoped claim needs a fixture");
  if (input.temporalScope === "date_range" && !(input.scopeStartsOn && input.scopeEndsOn)) {
    issues.push("a date-range claim needs both scope dates");
  }
  const derived = DERIVED_CLAIM_KINDS.includes(input.claimKind);
  if (derived && !(input.premises && input.premises.length > 0)) issues.push("a derived claim must cite premises");
  if (!derived && input.premises && input.premises.length > 0) issues.push("only derived claims cite premises");
  return issues;
}

export function buildClaimPayload(input: ClaimInput): Record<string, unknown> {
  return {
    contract_version: CLAIM_CONTRACT_VERSION,
    claim_kind: input.claimKind,
    claim_type: input.claimType,
    predicate: input.predicate,
    fixture_id: lowerId(input.fixtureId),
    team_id: lowerId(input.teamId),
    player_id: lowerId(input.playerId),
    coach_id: lowerId(input.coachId),
    object_value: input.objectValue ?? {},
    polarity: input.polarity ?? "affirmed",
    temporal_scope: input.temporalScope,
    scope_starts_on: input.scopeStartsOn ?? null,
    scope_ends_on: input.scopeEndsOn ?? null,
    statement_text: input.statementText ?? null,
    premises: (input.premises ?? []).map((claimId) => ({ claim_id: claimId.toLowerCase() })),
    asserted_by_version: input.assertedByVersion ?? null,
  };
}

export function validateClaimResolution(input: ClaimResolutionInput): string[] {
  const issues: string[] = [];
  if (input.status === "verified_degraded" && !(input.qualityFlags && input.qualityFlags.length > 0)) {
    issues.push("verified_degraded must name the incomplete metadata in qualityFlags");
  }
  if (input.status === "fabricated" && !(FABRICATION_REASON_CODES as readonly string[]).includes(input.reasonCode)) {
    issues.push("fabricated requires a fabrication reason code; missing metadata is never fabrication");
  }
  if (EVIDENCED_RESOLUTION_STATUSES.includes(input.status) && !(input.evidence && input.evidence.length > 0)) {
    issues.push(`a ${input.status} resolution must cite evidence`);
  }
  for (const [index, item] of (input.evidence ?? []).entries()) {
    const cited = [item.claimObservationId, item.documentVersionId, item.ledgerObservationId, item.ledgerPlayerId, item.ledgerEventId];
    if (cited.filter(Boolean).length !== 1) issues.push(`evidence ${index} must cite exactly one row`);
  }
  return issues;
}

export function buildClaimResolutionPayload(input: ClaimResolutionInput): Record<string, unknown> {
  return {
    contract_version: CLAIM_RESOLUTION_CONTRACT_VERSION,
    claim_id: input.claimId.toLowerCase(),
    status: input.status,
    confidence: input.confidence ?? null,
    resolver_kind: input.resolverKind,
    resolver_version: input.resolverVersion,
    resolver_id: input.resolverId ?? null,
    reason_code: input.reasonCode,
    quality_flags: input.qualityFlags ?? [],
    note: input.note ?? null,
    idempotency_key: input.idempotencyKey ?? null,
    evidence: (input.evidence ?? []).map((item) => ({
      evidence_role: item.evidenceRole,
      claim_observation_id: lowerId(item.claimObservationId),
      document_version_id: lowerId(item.documentVersionId),
      ledger_observation_id: lowerId(item.ledgerObservationId),
      ledger_player_id: lowerId(item.ledgerPlayerId),
      ledger_event_id: lowerId(item.ledgerEventId),
      note: item.note ?? null,
    })),
  };
}

/**
 * In-memory mirror of knowledge_claim_resolutions_as_of for one claim: the
 * latest resolution first seen at or before the cutoff, else unresolved.
 */
export function resolutionStatusAsOf(
  resolutions: readonly { resolutionVersion: number; firstSeenAt: string; status: ResolutionStatus }[],
  cutoff: string,
): ResolutionStatus {
  const visible = resolutions
    .filter((resolution) => Date.parse(resolution.firstSeenAt) <= Date.parse(cutoff))
    .sort((a, b) => b.resolutionVersion - a.resolutionVersion);
  return visible[0]?.status ?? "unresolved";
}

/**
 * In-memory mirror of the independent-source count: one observation per
 * document, and documents sharing an independence key (syndication cluster
 * or identical content) count once.
 */
export function independentSourceCount(
  observations: readonly { documentId: string; independenceKey: string }[],
): number {
  const perDocument = new Map<string, string>();
  for (const observation of observations) perDocument.set(observation.documentId, observation.independenceKey);
  return new Set(perDocument.values()).size;
}

/** Rows returned by the knowledge as-of functions. */
export type ClaimResolutionAsOfRow = {
  claim_id: string;
  resolution_id: string | null;
  resolution_version: number | null;
  status: ResolutionStatus;
  confidence: number | null;
  resolver_kind: ResolverKind | null;
  reason_code: string | null;
  quality_flags: string[];
  first_seen_at: string | null;
};

export type ClaimSupportAsOfRow = {
  relationship: ObservationRelationship;
  observation_count: number;
  document_count: number;
  independent_source_count: number;
};

export const KNOWLEDGE_FUNCTIONS = {
  recordDocumentVersion: "knowledge_record_document_version",
  recordClaim: "knowledge_record_claim",
  recordClaimResolution: "knowledge_record_claim_resolution",
  documentVersionAsOf: "knowledge_document_version_as_of",
  claimResolutionsAsOf: "knowledge_claim_resolutions_as_of",
  claimSupportAsOf: "knowledge_claim_support_as_of",
} as const;
