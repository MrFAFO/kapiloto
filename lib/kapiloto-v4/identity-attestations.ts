import { PROVIDER_IDENTITY_ATTESTATION_EVIDENCE_VERSION } from "./versions";

/**
 * V4 provider identity attestations (Stage 1, D-058).
 *
 * Historical-ingest trust is owned by V4: a team or competition identity is
 * trusted only when the current V3 mapping is manual_override AND agrees with
 * the active attestation. Attest/revoke go through service-role RPCs, one
 * identity per transaction; a canonical re-point is revoke -> mapping
 * correction -> re-attest in separate transactions. Evidence is audit data:
 * validated for shape and size, never interpreted as policy and never an
 * authorization input. Stage 1 accepts Sportmonks only.
 */

export const ATTESTATION_PROVIDERS = ["sportmonks"] as const;
export type AttestationProvider = (typeof ATTESTATION_PROVIDERS)[number];

export const ATTESTATION_BASES = [
  "operator_manual",
  "cross_provider_verified",
  "provider_official_reference",
  "fixture_identity_crosscheck",
  "multi_source_verified",
] as const;
export type AttestationBasis = (typeof ATTESTATION_BASES)[number];

export const ATTESTATION_EVENT_KINDS = ["attest", "evidence_refresh", "revoke"] as const;
export type AttestationEventKind = (typeof ATTESTATION_EVENT_KINDS)[number];

export const ATTESTATION_ENTITY_KINDS = ["team", "competition"] as const;
export type AttestationEntityKind = (typeof ATTESTATION_ENTITY_KINDS)[number];

export const MAX_ATTESTATION_EVIDENCE_BYTES = 65_536;

export const PROVIDER_IDENTITY_FUNCTIONS = {
  attestTeam: "provider_identity_attest_team",
  revokeTeam: "provider_identity_revoke_team",
  attestCompetition: "provider_identity_attest_competition",
  revokeCompetition: "provider_identity_revoke_competition",
  conflicts: "provider_identity_attestation_conflicts",
  revocationImpact: "provider_identity_revocation_impact",
} as const;

/** kapiloto-provider-identity-attestation-evidence-v1; extra source-specific keys are allowed. */
export type AttestationEvidence = {
  contract_version: typeof PROVIDER_IDENTITY_ATTESTATION_EVIDENCE_VERSION;
  /** Non-empty: URLs/labels or structured source objects. */
  sources: Array<string | Record<string, unknown>>;
  /** Audit text, never authorization. */
  reviewed_by: string;
  /** Proves the canonical-duplicate review (same-normalized-name/alias candidates) was done. */
  duplicate_audit_sha256: string;
  [key: string]: unknown;
};

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mirrors private.provider_identity_evidence_issue; returns the first issue or null. */
export function attestationEvidenceIssue(evidence: unknown): string | null {
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) return "evidence must be a JSON object";
  if (new TextEncoder().encode(JSON.stringify(evidence)).length > MAX_ATTESTATION_EVIDENCE_BYTES) return "evidence exceeds 64 KiB";
  const record = evidence as Record<string, unknown>;
  if (record.contract_version !== PROVIDER_IDENTITY_ATTESTATION_EVIDENCE_VERSION) {
    return `evidence contract_version must be ${PROVIDER_IDENTITY_ATTESTATION_EVIDENCE_VERSION}`;
  }
  if (!Array.isArray(record.sources) || record.sources.length === 0) return "evidence sources must be a non-empty array";
  if (record.sources.some((s) => !((typeof s === "object" && s !== null && !Array.isArray(s)) || (typeof s === "string" && s.trim() !== "")))) {
    return "evidence sources must be non-empty strings or objects";
  }
  if (typeof record.reviewed_by !== "string" || record.reviewed_by.trim().length < 1 || record.reviewed_by.trim().length > 200) {
    return "evidence reviewed_by must be a non-empty string of at most 200 characters";
  }
  if (typeof record.duplicate_audit_sha256 !== "string" || !SHA256.test(record.duplicate_audit_sha256)) {
    return "evidence duplicate_audit_sha256 must be 64 lowercase hex characters";
  }
  return null;
}

const isProviderRef = (value: unknown): value is string =>
  typeof value === "string" && value === value.trim() && value.length >= 1 && value.length <= 80;
const isAuditLabel = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length >= 1 && value.trim().length <= max;

export type TeamAttestationInput = {
  provider: AttestationProvider;
  providerTeamId: string;
  teamId: string;
  basis: AttestationBasis;
  evidence: AttestationEvidence;
  attestedBy: string;
};

export type CompetitionAttestationInput = {
  provider: AttestationProvider;
  providerCompetitionId: string;
  competitionId: string;
  basis: AttestationBasis;
  evidence: AttestationEvidence;
  attestedBy: string;
};

export type TeamRevocationInput = {
  provider: AttestationProvider;
  providerTeamId: string;
  expectedTeamId: string;
  reason: string;
  revokedBy: string;
};

export type CompetitionRevocationInput = {
  provider: AttestationProvider;
  providerCompetitionId: string;
  expectedCompetitionId: string;
  reason: string;
  revokedBy: string;
};

function assertCommon(provider: string, providerRef: string, canonicalId: string): void {
  if (!(ATTESTATION_PROVIDERS as readonly string[]).includes(provider)) throw new Error("Stage 1 attestations are enabled for sportmonks only");
  if (!isProviderRef(providerRef)) throw new Error("provider ref must be an exact, non-empty id of at most 80 characters");
  if (!UUID.test(canonicalId)) throw new Error("canonical id must be a uuid");
}

function assertAttestation(basis: string, evidence: unknown, attestedBy: string): void {
  if (!(ATTESTATION_BASES as readonly string[]).includes(basis)) throw new Error("unknown attestation basis");
  const issue = attestationEvidenceIssue(evidence);
  if (issue) throw new Error(`invalid attestation evidence: ${issue}`);
  if (!isAuditLabel(attestedBy, 200)) throw new Error("attestedBy must be a non-empty audit label of at most 200 characters");
}

function assertRevocation(reason: string, revokedBy: string): void {
  if (!isAuditLabel(reason, 500)) throw new Error("a revocation needs a non-empty reason of at most 500 characters");
  if (!isAuditLabel(revokedBy, 200)) throw new Error("revokedBy must be a non-empty audit label of at most 200 characters");
}

export function buildTeamAttestationPayload(input: TeamAttestationInput): Record<string, unknown> {
  assertCommon(input.provider, input.providerTeamId, input.teamId);
  assertAttestation(input.basis, input.evidence, input.attestedBy);
  return {
    provider: input.provider,
    provider_team_id: input.providerTeamId,
    team_id: input.teamId.toLowerCase(),
    attestation_basis: input.basis,
    evidence: input.evidence,
    attested_by: input.attestedBy,
  };
}

export function buildCompetitionAttestationPayload(input: CompetitionAttestationInput): Record<string, unknown> {
  assertCommon(input.provider, input.providerCompetitionId, input.competitionId);
  assertAttestation(input.basis, input.evidence, input.attestedBy);
  return {
    provider: input.provider,
    provider_competition_id: input.providerCompetitionId,
    competition_id: input.competitionId.toLowerCase(),
    attestation_basis: input.basis,
    evidence: input.evidence,
    attested_by: input.attestedBy,
  };
}

export function buildTeamRevocationPayload(input: TeamRevocationInput): Record<string, unknown> {
  assertCommon(input.provider, input.providerTeamId, input.expectedTeamId);
  assertRevocation(input.reason, input.revokedBy);
  return {
    provider: input.provider,
    provider_team_id: input.providerTeamId,
    expected_team_id: input.expectedTeamId.toLowerCase(),
    reason: input.reason,
    revoked_by: input.revokedBy,
  };
}

export function buildCompetitionRevocationPayload(input: CompetitionRevocationInput): Record<string, unknown> {
  assertCommon(input.provider, input.providerCompetitionId, input.expectedCompetitionId);
  assertRevocation(input.reason, input.revokedBy);
  return {
    provider: input.provider,
    provider_competition_id: input.providerCompetitionId,
    expected_competition_id: input.expectedCompetitionId.toLowerCase(),
    reason: input.reason,
    revoked_by: input.revokedBy,
  };
}

/** attested: new generation; refreshed: changed evidence, same generation; unchanged: identical evidence + basis (no event). */
export type AttestationResult = {
  status: "attested" | "refreshed" | "unchanged" | "revoked";
  provider: string;
  provider_team_id?: string;
  team_id?: string;
  provider_competition_id?: string;
  competition_id?: string;
  attestation_generation_id: string;
  attestation_version: number;
  event_id: string;
};

export type ProviderIdentityRpc = (
  fn: (typeof PROVIDER_IDENTITY_FUNCTIONS)[keyof typeof PROVIDER_IDENTITY_FUNCTIONS],
  args: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Each call must be the first write of its own transaction (the RPC refuses
 * otherwise), so run every identity change as its own RPC call.
 */
export async function attestTeam(rpc: ProviderIdentityRpc, input: TeamAttestationInput): Promise<AttestationResult> {
  return (await rpc(PROVIDER_IDENTITY_FUNCTIONS.attestTeam, { p_attestation: buildTeamAttestationPayload(input) })) as AttestationResult;
}

export async function revokeTeam(rpc: ProviderIdentityRpc, input: TeamRevocationInput): Promise<AttestationResult> {
  return (await rpc(PROVIDER_IDENTITY_FUNCTIONS.revokeTeam, { p_revocation: buildTeamRevocationPayload(input) })) as AttestationResult;
}

export async function attestCompetition(rpc: ProviderIdentityRpc, input: CompetitionAttestationInput): Promise<AttestationResult> {
  return (await rpc(PROVIDER_IDENTITY_FUNCTIONS.attestCompetition, {
    p_attestation: buildCompetitionAttestationPayload(input),
  })) as AttestationResult;
}

export async function revokeCompetition(rpc: ProviderIdentityRpc, input: CompetitionRevocationInput): Promise<AttestationResult> {
  return (await rpc(PROVIDER_IDENTITY_FUNCTIONS.revokeCompetition, {
    p_revocation: buildCompetitionRevocationPayload(input),
  })) as AttestationResult;
}

// ---------------------------------------------------------------------------
// Entity-level readiness report (works before any ingest)
// ---------------------------------------------------------------------------

export const ATTESTATION_CONFLICT_CODES = [
  "attested_mapping_missing",
  "attested_mapping_disagrees",
  "attested_mapping_not_manual_override",
  "shadow_mapping_for_attested_canonical",
  "mapping_unattested",
] as const;
export type AttestationConflictCode = (typeof ATTESTATION_CONFLICT_CODES)[number];
export const ATTESTATION_CONFLICT_SEVERITIES = ["blocking", "warning", "info"] as const;
export type AttestationConflictSeverity = (typeof ATTESTATION_CONFLICT_SEVERITIES)[number];

export type AttestationConflict = {
  issue_code: AttestationConflictCode;
  severity: AttestationConflictSeverity;
  entity_kind: AttestationEntityKind;
  provider_ref: string;
  attested_canonical_id: string | null;
  attestation_generation_id: string | null;
  mapping_canonical_id: string | null;
  mapping_status: string | null;
  /** The shadow mapping's provider ref (shadow_mapping_for_attested_canonical only). */
  related_provider_ref: string | null;
};

export async function loadProviderIdentityAttestationConflicts(rpc: ProviderIdentityRpc, provider: string): Promise<AttestationConflict[]> {
  if (!/^[a-z0-9_]{1,40}$/.test(provider)) throw new Error("invalid provider");
  const value = await rpc(PROVIDER_IDENTITY_FUNCTIONS.conflicts, { p_provider: provider });
  if (!Array.isArray(value)) throw new Error("attestation conflicts must be an array");
  return value.map((item, index) => {
    const row = item as Record<string, unknown>;
    if (!(ATTESTATION_CONFLICT_CODES as readonly string[]).includes(row.issue_code as string)) throw new Error(`attestation conflict ${index} has an unknown code`);
    if (!(ATTESTATION_CONFLICT_SEVERITIES as readonly string[]).includes(row.severity as string)) throw new Error(`attestation conflict ${index} has an unknown severity`);
    if (!(ATTESTATION_ENTITY_KINDS as readonly string[]).includes(row.entity_kind as string)) throw new Error(`attestation conflict ${index} has an unknown entity kind`);
    return row as unknown as AttestationConflict;
  });
}

/** Readiness gate for a pilot scope: no blocking issue on any listed provider ref. */
export function blockingAttestationConflicts(
  conflicts: AttestationConflict[],
  scope: { teams: string[]; competitions: string[] },
): AttestationConflict[] {
  const teams = new Set(scope.teams);
  const competitions = new Set(scope.competitions);
  return conflicts.filter(
    (c) => c.severity === "blocking" && (c.entity_kind === "team" ? teams.has(c.provider_ref) : competitions.has(c.provider_ref)),
  );
}

// ---------------------------------------------------------------------------
// Revocation impact (recovery runbook input)
// ---------------------------------------------------------------------------

export const REVOCATION_IMPACT_KINDS = ["observation_under_generation", "fixture_mapping", "fixture_mint", "unattested_observation"] as const;
export type RevocationImpactKind = (typeof REVOCATION_IMPACT_KINDS)[number];

export type RevocationImpactRow = {
  impact_kind: RevocationImpactKind;
  observation_id: string | null;
  observation_version: number | null;
  is_latest_version: boolean | null;
  latest_observation_kind: "observation" | "withdrawal" | null;
  fixture_id: string | null;
  provider_fixture_id: string | null;
  attestation_generation_id: string | null;
  generation_state: "active" | "revoked" | null;
  canonical_id: string | null;
  detail: Record<string, unknown>;
};

export async function loadProviderIdentityRevocationImpact(
  rpc: ProviderIdentityRpc,
  query: { provider: string; entityKind: AttestationEntityKind; providerRef: string },
): Promise<RevocationImpactRow[]> {
  if (!/^[a-z0-9_]{1,40}$/.test(query.provider)) throw new Error("invalid provider");
  if (!(ATTESTATION_ENTITY_KINDS as readonly string[]).includes(query.entityKind)) throw new Error("entity kind must be team or competition");
  if (!isProviderRef(query.providerRef)) throw new Error("invalid provider ref");
  const value = await rpc(PROVIDER_IDENTITY_FUNCTIONS.revocationImpact, {
    p_provider: query.provider,
    p_entity_kind: query.entityKind,
    p_provider_ref: query.providerRef,
  });
  if (!Array.isArray(value)) throw new Error("revocation impact must be an array");
  return value.map((item, index) => {
    const row = item as Record<string, unknown>;
    if (!(REVOCATION_IMPACT_KINDS as readonly string[]).includes(row.impact_kind as string)) throw new Error(`revocation impact ${index} has an unknown kind`);
    return row as unknown as RevocationImpactRow;
  });
}
