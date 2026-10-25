import { findForbiddenModelKeys, forecastLanguageFindings } from "./model-output-guards";

/**
 * Research v2 discovery contract v2 (D-047). Sol reports factual claims for
 * planned information needs, with citations. It has no field for a
 * probability, a winner, a recommendation, a direction, an impact or a
 * magnitude: direction and size come from deterministic impact rules.
 * Everything Sol states about publishers, authors, dates and squad status is
 * advisory and recomputed by the server.
 */

export const DISCOVERY_V2_CONTRACT_VERSION = "kapiloto-research-v2-discovery-v2" as const;
export const CLAIM_KINDS_VERSION = "claim-kinds-v2" as const;

/** Kinds that can reach impact-rules-v1. Every one must have a deterministic rule. */
export const FORECAST_CHANGING_CLAIM_KINDS = ["absence", "suspension", "doubtful", "expected_return", "rotation_statement"] as const;
/**
 * Context only; never adjusting in v1. `lineup_confirmed` may add a
 * corroborating cluster to an existing claim; `shape_change` is a formation or
 * player-role change that a source states directly.
 */
export const EXPLANATORY_CLAIM_KINDS = [
  "lineup_confirmed",
  "schedule_disruption",
  "manager_change",
  "squad_change",
  "shape_change",
  "other_context",
] as const;
export const CLAIM_KINDS_V2 = [...FORECAST_CHANGING_CLAIM_KINDS, ...EXPLANATORY_CLAIM_KINDS] as const;

export type ForecastChangingClaimKind = (typeof FORECAST_CHANGING_CLAIM_KINDS)[number];
export type ClaimKindV2 = (typeof CLAIM_KINDS_V2)[number];

export const SUBJECT_TYPES = ["player", "team", "manager"] as const;
export const PLAYER_ROLES_V2 = ["goalkeeper", "defender", "midfielder", "forward", "unknown"] as const;
export const SQUAD_STATUSES_V2 = ["first_choice", "rotation", "fringe", "unknown"] as const;
export const STATED_STATUSES = ["confirmed", "expected", "doubtful", "denied"] as const;
export const OBSERVATIONS = ["direct_statement", "reported", "inferred"] as const;
export const EXTRACTION_CONFIDENCE = ["high", "medium", "low"] as const;
export const NEED_STATUSES = ["found", "nothing_found", "inconclusive", "budget_exhausted"] as const;

export type Side = "home" | "away";
export type PlayerRole = (typeof PLAYER_ROLES_V2)[number];
export type SquadStatus = (typeof SQUAD_STATUSES_V2)[number];
export type StatedStatus = (typeof STATED_STATUSES)[number];
export type Observation = (typeof OBSERVATIONS)[number];

export type DiscoveryCitation = {
  url: string;
  quote: string;
  publisher_claimed: string | null;
  author_claimed: string | null;
  published_at_claimed: string | null;
};

export type DiscoveryClaim = {
  claim_id: string;
  need_id: string;
  claim_kind: ClaimKindV2;
  side: Side;
  subject: {
    type: (typeof SUBJECT_TYPES)[number];
    name_in_source: string;
    name_normalized_en: string | null;
    role: PlayerRole;
    squad_status_claimed: SquadStatus;
    squad_status_quote: string | null;
    named_players: string[];
  };
  claim: string;
  stated_status: StatedStatus;
  applies_to_this_fixture: boolean;
  event_time: string | null;
  observation: Observation;
  extraction_confidence: (typeof EXTRACTION_CONFIDENCE)[number];
  corroboration_claimed: boolean;
  citations: DiscoveryCitation[];
};

export type DiscoveryOutputV2 = {
  contract_version: typeof DISCOVERY_V2_CONTRACT_VERSION;
  fixture_ref: string;
  needs_addressed: Array<{ need_id: string; status: (typeof NEED_STATUSES)[number] }>;
  claims: DiscoveryClaim[];
};

// ---- strict Structured Outputs schema (supported subset only) -------------

type JsonSchema = Record<string, unknown>;
const str = (): JsonSchema => ({ type: "string" });
const nullableStr = (): JsonSchema => ({ type: ["string", "null"] });
const bool = (): JsonSchema => ({ type: "boolean" });
const oneOf = (values: readonly string[]): JsonSchema => ({ type: "string", enum: [...values] });
const list = (items: JsonSchema): JsonSchema => ({ type: "array", items });
/** Every object: closed, and every property required (nullable fields use a type union). */
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

/**
 * Strict JSON schema sent to Sol. Length and count limits are not expressed
 * here (they are outside the portable strict subset) and are enforced by
 * `parseDiscoveryOutputV2` after parsing.
 */
export const DISCOVERY_V2_OUTPUT_SCHEMA: JsonSchema = object({
  contract_version: oneOf([DISCOVERY_V2_CONTRACT_VERSION]),
  fixture_ref: str(),
  needs_addressed: list(object({ need_id: str(), status: oneOf(NEED_STATUSES) })),
  claims: list(
    object({
      claim_id: str(),
      need_id: str(),
      claim_kind: oneOf(CLAIM_KINDS_V2),
      side: oneOf(["home", "away"]),
      subject: object({
        type: oneOf(SUBJECT_TYPES),
        name_in_source: str(),
        name_normalized_en: nullableStr(),
        role: oneOf(PLAYER_ROLES_V2),
        squad_status_claimed: oneOf(SQUAD_STATUSES_V2),
        squad_status_quote: nullableStr(),
        named_players: list(str()),
      }),
      claim: str(),
      stated_status: oneOf(STATED_STATUSES),
      applies_to_this_fixture: bool(),
      event_time: nullableStr(),
      observation: oneOf(OBSERVATIONS),
      extraction_confidence: oneOf(EXTRACTION_CONFIDENCE),
      corroboration_claimed: bool(),
      citations: list(
        object({
          url: str(),
          quote: str(),
          publisher_claimed: nullableStr(),
          author_claimed: nullableStr(),
          published_at_claimed: nullableStr(),
        }),
      ),
    }),
  ),
});

/** Keywords allowed in Research v2 strict schemas (a conservative portable subset). */
export const STRICT_SCHEMA_KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "description"]);

/** Violations of the strict subset: unknown keywords, open objects, optional properties. */
export function strictSchemaViolations(schema: unknown, path = "$"): string[] {
  const found: string[] = [];
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [`${path}: not a schema object`];
  const node = schema as JsonSchema;
  for (const key of Object.keys(node)) if (!STRICT_SCHEMA_KEYWORDS.has(key)) found.push(`${path}: keyword ${key}`);
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (types.includes("object")) {
    const properties = (node.properties ?? {}) as Record<string, unknown>;
    if (node.additionalProperties !== false) found.push(`${path}: additionalProperties must be false`);
    const required = Array.isArray(node.required) ? (node.required as string[]) : [];
    for (const name of Object.keys(properties)) if (!required.includes(name)) found.push(`${path}.${name}: not required`);
    for (const name of required) if (!(name in properties)) found.push(`${path}.${name}: required but undefined`);
    for (const [name, child] of Object.entries(properties)) found.push(...strictSchemaViolations(child, `${path}.${name}`));
  }
  if (types.includes("array")) found.push(...strictSchemaViolations(node.items, `${path}[]`));
  return found;
}

/** Shape errors of `value` against a schema in the strict subset. */
export function schemaShapeErrors(value: unknown, schema: JsonSchema, path = "$"): string[] {
  const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (!types.includes(kind)) return [`${path}: expected ${types.join("|")}, got ${kind}`];
  if (kind === "string" && Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) return [`${path}: not in enum`];
  if (kind === "array") {
    return (value as unknown[]).flatMap((item, index) => schemaShapeErrors(item, schema.items as JsonSchema, `${path}[${index}]`));
  }
  if (kind === "object") {
    const properties = schema.properties as Record<string, JsonSchema>;
    const record = value as Record<string, unknown>;
    const errors = Object.keys(record).filter((key) => !(key in properties)).map((key) => `${path}.${key}: unexpected property`);
    for (const [name, child] of Object.entries(properties)) {
      if (!(name in record)) errors.push(`${path}.${name}: missing`);
      else errors.push(...schemaShapeErrors(record[name], child, `${path}.${name}`));
    }
    return errors;
  }
  return [];
}

// ---- server-side limits and per-claim admission ---------------------------

export const DISCOVERY_V2_LIMITS = {
  idLength: 80,
  claimLength: 200,
  quoteLength: 300,
  nameLength: 120,
  urlLength: 2000,
  shortTextLength: 40,
  maxNamedPlayers: 6,
  minCitations: 1,
  maxCitations: 3,
  maxNeedsAddressed: 16,
} as const;

/** What the parser needs from the deterministic plan. */
export type DiscoveryPlanSummary = {
  fixtureRef: string;
  maxClaims: number;
  needs: ReadonlyArray<{ needId: string; scope: readonly Side[]; allowedClaimKinds: readonly ClaimKindV2[] }>;
};

export type ClaimRejection =
  | "duplicate_claim_id"
  | "unknown_need"
  | "claim_kind_not_allowed_for_need"
  | "side_out_of_scope"
  | "citation_count"
  | "field_too_long"
  | "forecast_language_in_claim"
  | "over_claim_budget";

export type DiscoveryParseResult =
  | {
      status: "accepted";
      output: DiscoveryOutputV2;
      claims: Array<{ claim: DiscoveryClaim; status: "admitted" | "rejected"; rejections: ClaimRejection[] }>;
      ignoredNeedStatuses: string[];
    }
  | { status: "rejected"; reason: "schema_invalid" | "forecast_field_in_output" | "fixture_ref_mismatch" | "too_many_need_statuses"; errors: string[] };

const tooLong = (value: string | null, limit: number) => value != null && value.length > limit;

function claimTooLong(claim: DiscoveryClaim): boolean {
  const L = DISCOVERY_V2_LIMITS;
  return (
    tooLong(claim.claim_id, L.idLength) ||
    tooLong(claim.need_id, L.idLength) ||
    tooLong(claim.claim, L.claimLength) ||
    tooLong(claim.subject.name_in_source, L.nameLength) ||
    tooLong(claim.subject.name_normalized_en, L.nameLength) ||
    tooLong(claim.subject.squad_status_quote, L.quoteLength) ||
    tooLong(claim.event_time, L.shortTextLength) ||
    claim.subject.named_players.length > L.maxNamedPlayers ||
    claim.subject.named_players.some((name) => tooLong(name, L.nameLength)) ||
    claim.citations.some(
      (citation) =>
        tooLong(citation.url, L.urlLength) ||
        tooLong(citation.quote, L.quoteLength) ||
        tooLong(citation.publisher_claimed, L.nameLength) ||
        tooLong(citation.author_claimed, L.nameLength) ||
        tooLong(citation.published_at_claimed, L.shortTextLength),
    )
  );
}

/**
 * Validates one parsed Sol output against the strict schema, the recursive
 * model guard and the plan. A shape or guard failure rejects the whole call;
 * plan, limit and language violations reject only the affected claim.
 */
export function parseDiscoveryOutputV2(raw: unknown, plan: DiscoveryPlanSummary): DiscoveryParseResult {
  const forbidden = findForbiddenModelKeys(raw);
  if (forbidden.length > 0) return { status: "rejected", reason: "forecast_field_in_output", errors: forbidden };
  const shape = schemaShapeErrors(raw, DISCOVERY_V2_OUTPUT_SCHEMA);
  if (shape.length > 0) return { status: "rejected", reason: "schema_invalid", errors: shape };
  const output = raw as DiscoveryOutputV2;
  if (output.fixture_ref !== plan.fixtureRef) {
    return { status: "rejected", reason: "fixture_ref_mismatch", errors: [`${output.fixture_ref} ≠ ${plan.fixtureRef}`] };
  }
  if (output.needs_addressed.length > DISCOVERY_V2_LIMITS.maxNeedsAddressed) {
    return { status: "rejected", reason: "too_many_need_statuses", errors: [String(output.needs_addressed.length)] };
  }

  const needs = new Map(plan.needs.map((need) => [need.needId, need]));
  const seen = new Set<string>();
  let admitted = 0;
  const claims = output.claims.map((claim) => {
    const rejections: ClaimRejection[] = [];
    if (seen.has(claim.claim_id)) rejections.push("duplicate_claim_id");
    seen.add(claim.claim_id);
    const need = needs.get(claim.need_id);
    if (!need) rejections.push("unknown_need");
    else {
      if (!need.allowedClaimKinds.includes(claim.claim_kind)) rejections.push("claim_kind_not_allowed_for_need");
      if (!need.scope.includes(claim.side)) rejections.push("side_out_of_scope");
    }
    if (claim.citations.length < DISCOVERY_V2_LIMITS.minCitations || claim.citations.length > DISCOVERY_V2_LIMITS.maxCitations) {
      rejections.push("citation_count");
    }
    if (claimTooLong(claim)) rejections.push("field_too_long");
    if (forecastLanguageFindings(claim.claim).length > 0) rejections.push("forecast_language_in_claim");
    if (rejections.length === 0) {
      if (admitted >= plan.maxClaims) rejections.push("over_claim_budget");
      else admitted += 1;
    }
    return { claim, status: rejections.length === 0 ? ("admitted" as const) : ("rejected" as const), rejections };
  });
  const ignoredNeedStatuses = output.needs_addressed.filter((entry) => !needs.has(entry.need_id)).map((entry) => entry.need_id);
  return { status: "accepted", output, claims, ignoredNeedStatuses };
}
