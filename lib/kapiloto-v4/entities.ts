/**
 * Canonical football entities (V4). Kapiloto identity is the internal UUID;
 * provider ids and spellings are mappings and aliases that point at it.
 *
 * Identity rules:
 * - A provider id maps to exactly one canonical entity, and a canonical entity
 *   has at most one id per provider. Two provider ids never collapse silently.
 * - Aliases are unique per entity, not globally. An alias that matches several
 *   entities is ambiguous and must not be resolved automatically.
 * - When in doubt, create a new canonical entity. Duplicates are repaired by an
 *   explicit merge (identityStatus "merged" + mergedIntoId, one hop).
 *
 * Merge semantics (kapiloto-canonical-identity-v1):
 * - A merge is a data-quality correction, not football information. Ledger
 *   rows keep the ids they were written with; model-facing reads resolve every
 *   stored id to its current survivor, at every cutoff. Because nothing is
 *   rewritten, undoing a wrong merge restores the previous reads exactly.
 * - Reads: any member of an identity class addresses the whole class (a merged
 *   id redirects), and rows report the canonical id next to the observed one.
 * - Writes: only surviving ids are accepted; a merged id is an error, never
 *   silently canonicalized.
 * - A merge is refused when the two identities appear as two people in one
 *   stored observation version (two squad rows, or a coach on both benches).
 * - Alias and provider-mapping resolution return survivors. A mapping that
 *   predates a merge may keep pointing at the merged id.
 */

export const IDENTITY_STATUSES = ["active", "merged"] as const;
export type IdentityStatus = (typeof IDENTITY_STATUSES)[number];

export const ALIAS_KINDS = [
  "canonical",
  "official",
  "transliteration",
  "provider_spelling",
  "nickname",
  "former_name",
] as const;
export type AliasKind = (typeof ALIAS_KINDS)[number];

export const MAPPING_STATUSES = ["unverified", "confirmed", "manual_override"] as const;
export type MappingStatus = (typeof MAPPING_STATUSES)[number];

/** Only these statuses may resolve a provider id automatically. */
export const RESOLVING_MAPPING_STATUSES: readonly MappingStatus[] = [
  "confirmed",
  "manual_override",
];

export type CanonicalPlayer = {
  id: string;
  canonicalName: string;
  dateOfBirth: string | null;
  /** ISO 3166 alpha-2/alpha-3, upper case. */
  nationalityCode: string | null;
  heightCm: number | null;
  identityStatus: IdentityStatus;
  mergedIntoPlayerId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CanonicalCoach = {
  id: string;
  canonicalName: string;
  dateOfBirth: string | null;
  nationalityCode: string | null;
  identityStatus: IdentityStatus;
  mergedIntoCoachId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EntityAlias = {
  id: string;
  alias: string;
  /** Database-generated with private.normalize_entity_alias. */
  normalizedAlias: string;
  /** ISO 639 code such as "he" or "en"; null when unknown. */
  languageCode: string | null;
  aliasKind: AliasKind;
  provider: string | null;
  source: string;
  createdAt: string;
};

export type PlayerAlias = EntityAlias & { playerId: string };
export type CoachAlias = EntityAlias & { coachId: string };

export type ProviderEntityMapping = {
  provider: string;
  providerName: string | null;
  mappingStatus: MappingStatus;
  mappingConfidence: number | null;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProviderPlayerMapping = ProviderEntityMapping & {
  providerPlayerId: string;
  playerId: string;
};

export type ProviderCoachMapping = ProviderEntityMapping & {
  providerCoachId: string;
  coachId: string;
};

export const TENURE_ROLES = ["head_coach", "interim_head_coach", "caretaker"] as const;
export type TenureRole = (typeof TENURE_ROLES)[number];

export const TENURE_SOURCE_KINDS = [
  "provider",
  "official_club",
  "federation",
  "news_report",
  "manual",
] as const;
export type TenureSourceKind = (typeof TENURE_SOURCE_KINDS)[number];

/** Inclusive date interval (YYYY-MM-DD). Exactly known dates use equal bounds. */
export type DateBounds = { earliest: string; latest: string };

export type TeamCoachTenure = {
  id: string;
  /** Stable across versions of the same tenure. */
  tenureKey: string;
  tenureVersion: number;
  teamId: string;
  coachId: string;
  role: TenureRole;
  startsOn: DateBounds;
  /** Null while the tenure is open as far as this version knows. */
  endsOn: DateBounds | null;
  assertionStatus: "asserted" | "retracted";
  sourceKind: TenureSourceKind;
  provider: string | null;
  providerRecordId: string | null;
  sourceReference: string | null;
  sourceFingerprint: string | null;
  rawObservationId: string | null;
  retrievedAt: string | null;
  /** Database-stamped information time. */
  firstSeenAt: string;
  ingestVersion: string;
};

/** One alias match: the entity whose alias matched and its current survivor. */
export type AliasCandidate = { entityId: string; canonicalEntityId: string };

export type AliasResolution =
  | { status: "unresolved" }
  /** entityId is the surviving canonical id. */
  | { status: "unique"; entityId: string }
  | { status: "ambiguous"; candidateIds: string[] };

/**
 * Turns alias-lookup candidates into a decision without ever choosing between
 * different people. Candidates are compared by canonical (surviving) id, so a
 * merged duplicate and its survivor are one candidate; two different
 * survivors stay ambiguous. Feed it public.player_alias_candidates /
 * coach_alias_candidates rows, or in-memory entities via survivingEntityId.
 */
export function resolveAliasCandidates(candidates: readonly AliasCandidate[]): AliasResolution {
  const distinct = [...new Set(candidates.map((candidate) => candidate.canonicalEntityId))].sort();
  if (distinct.length === 0) return { status: "unresolved" };
  if (distinct.length === 1) return { status: "unique", entityId: distinct[0] };
  return { status: "ambiguous", candidateIds: distinct };
}

/** Follows a one-hop merge redirect to the surviving canonical id. */
export function survivingEntityId(entity: {
  id: string;
  identityStatus: IdentityStatus;
  mergedIntoId: string | null;
}): string {
  return entity.identityStatus === "merged" && entity.mergedIntoId ? entity.mergedIntoId : entity.id;
}

/**
 * Whether a tenure version covers a calendar date, honoring date uncertainty:
 * "certain" when every admissible start/end satisfies it, "possible" when some
 * do, "no" otherwise.
 */
export function tenureCoversDate(
  tenure: Pick<TeamCoachTenure, "startsOn" | "endsOn" | "assertionStatus">,
  date: string,
): "certain" | "possible" | "no" {
  if (tenure.assertionStatus !== "asserted") return "no";
  if (date < tenure.startsOn.earliest) return "no";
  if (tenure.endsOn && date > tenure.endsOn.latest) return "no";
  const startCertain = date >= tenure.startsOn.latest;
  const endCertain = !tenure.endsOn || date <= tenure.endsOn.earliest;
  return startCertain && endCertain ? "certain" : "possible";
}

/** Identity-resolution RPCs (service_role only). All return surviving ids. */
export const KAPILOTO_IDENTITY_FUNCTIONS = {
  playerAliasCandidates: "player_alias_candidates",
  coachAliasCandidates: "coach_alias_candidates",
  resolveProviderPlayerIds: "resolve_provider_player_ids",
  resolveProviderCoachIds: "resolve_provider_coach_ids",
  mappingConflicts: "match_ledger_mapping_conflicts",
} as const;

/** Row returned by public.player_alias_candidates. */
export type PlayerAliasCandidateRow = { player_id: string; canonical_player_id: string };

/** Row returned by public.coach_alias_candidates. */
export type CoachAliasCandidateRow = { coach_id: string; canonical_coach_id: string };

/**
 * Row returned by public.resolve_provider_player_ids: authoritative mappings
 * only; mapped_player_id may be a merged id, canonical_player_id never is.
 */
export type ProviderPlayerResolutionRow = {
  provider_player_id: string;
  mapped_player_id: string;
  canonical_player_id: string;
};

/** Row returned by public.resolve_provider_coach_ids. */
export type ProviderCoachResolutionRow = {
  provider_coach_id: string;
  mapped_coach_id: string;
  canonical_coach_id: string;
};

/**
 * Row returned by public.match_ledger_mapping_conflicts: a current ledger
 * version whose stored canonical assignment disagrees with the current
 * authoritative mapping of the raw provider id. Repaired by a corrected
 * observation version or a withdrawal, never by rewriting the ledger.
 */
export type MatchLedgerMappingConflictRow = {
  conflict_kind: "fixture" | "player" | "coach";
  observation_id: string;
  fixture_id: string;
  provider_entity_id: string;
  stored_canonical_id: string;
  mapped_canonical_id: string | null;
};
