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
 *   explicit merge (identityStatus "merged" + mergedIntoId, one hop); wrongly
 *   merged identities cannot be repaired without rewriting history.
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

export type AliasResolution =
  | { status: "unresolved" }
  | { status: "unique"; entityId: string }
  | { status: "ambiguous"; candidateIds: string[] };

/**
 * Turns alias-lookup candidates into a decision without ever choosing between
 * different entities. Duplicate rows for the same entity count once.
 */
export function resolveAliasCandidates(candidateEntityIds: readonly string[]): AliasResolution {
  const distinct = [...new Set(candidateEntityIds)].sort();
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
