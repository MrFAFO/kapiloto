/**
 * Research v2 evidence contract. Sol discovers evidence for named information
 * needs; it never outputs probabilities, odds, picks or doubles. Claim kinds
 * are a closed list of forecast-relevant facts: generic head-to-head, tactics,
 * derby narrative, weather, set pieces, motivation and anything the structured
 * base already holds (form, table, rest) are deliberately not claim kinds.
 */

export const DISCOVERY_CONTRACT_VERSION = "kapiloto-research-v2-discovery-v1" as const;

export const EVIDENCE_CLAIM_KINDS = [
  "absence",
  "suspension",
  "doubtful",
  "expected_return",
  "rotation_statement",
  "lineup_confirmed",
  "manager_change",
  "schedule_disruption",
  "other_context",
] as const;
export type EvidenceClaimKind = (typeof EVIDENCE_CLAIM_KINDS)[number];

/** Claim kinds about player availability, matched against structured availability. */
export const AVAILABILITY_CLAIM_KINDS: ReadonlySet<EvidenceClaimKind> = new Set([
  "absence",
  "suspension",
  "doubtful",
  "expected_return",
]);

export const PLAYER_ROLES = ["goalkeeper", "defender", "midfielder", "forward", "unknown"] as const;
export const SQUAD_STATUSES = ["first_choice", "rotation", "fringe", "unknown"] as const;
export const FACTUAL_CONFIDENCE = ["confirmed", "probable", "reported"] as const;
export const EXPECTED_DIRECTION = ["weakens_team", "strengthens_team", "unclear"] as const;
export const IMPACT_CLASSES = ["none", "minor", "moderate", "major"] as const;

export type ImpactClass = (typeof IMPACT_CLASSES)[number];

/** One evidence item as Sol reports it (untrusted until verified). */
export type DiscoveryEvidenceItem = {
  evidence_id: string;
  need_id: string;
  claim_kind: EvidenceClaimKind;
  claim: string;
  quote: string;
  url: string;
  published_at: string | null;
  author: string | null;
  is_direct_quote: boolean;
  team: "home" | "away" | "both";
  player_name: string | null;
  player_role: (typeof PLAYER_ROLES)[number];
  squad_status: (typeof SQUAD_STATUSES)[number];
  expected_return: string | null;
  factual_confidence: (typeof FACTUAL_CONFIDENCE)[number];
  expected_direction: (typeof EXPECTED_DIRECTION)[number];
  tentative_impact_class: ImpactClass;
  /** Sol's view only; the server recomputes duplication against structured inputs. */
  claimed_structured_duplicate: boolean;
};

export type DiscoveryOutput = {
  contract_version: typeof DISCOVERY_CONTRACT_VERSION;
  fixture_id: string;
  needs_addressed: Array<{ need_id: string; status: "found" | "nothing_found" | "inconclusive" }>;
  evidence: DiscoveryEvidenceItem[];
};

const text = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
const enumOf = (values: readonly string[]) => ({ type: "string", enum: [...values] });

/** Strict JSON schema sent to Sol for discovery. It contains no probability field. */
export const DISCOVERY_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["contract_version", "fixture_id", "needs_addressed", "evidence"],
  properties: {
    contract_version: { type: "string", enum: [DISCOVERY_CONTRACT_VERSION] },
    fixture_id: text(80),
    needs_addressed: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["need_id", "status"],
        properties: {
          need_id: text(80),
          status: enumOf(["found", "nothing_found", "inconclusive"]),
        },
      },
    },
    evidence: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "evidence_id",
          "need_id",
          "claim_kind",
          "claim",
          "quote",
          "url",
          "published_at",
          "author",
          "is_direct_quote",
          "team",
          "player_name",
          "player_role",
          "squad_status",
          "expected_return",
          "factual_confidence",
          "expected_direction",
          "tentative_impact_class",
          "claimed_structured_duplicate",
        ],
        properties: {
          evidence_id: text(40),
          need_id: text(80),
          claim_kind: enumOf(EVIDENCE_CLAIM_KINDS),
          claim: text(300),
          quote: text(300),
          url: text(2000),
          published_at: nullable(text(40)),
          author: nullable(text(120)),
          is_direct_quote: { type: "boolean" },
          team: enumOf(["home", "away", "both"]),
          player_name: nullable(text(120)),
          player_role: enumOf(PLAYER_ROLES),
          squad_status: enumOf(SQUAD_STATUSES),
          expected_return: nullable(text(80)),
          factual_confidence: enumOf(FACTUAL_CONFIDENCE),
          expected_direction: enumOf(EXPECTED_DIRECTION),
          tentative_impact_class: enumOf(IMPACT_CLASSES),
          claimed_structured_duplicate: { type: "boolean" },
        },
      },
    },
  },
} as const;

/**
 * Field names that would let a model express a forecast, a price or a ticket
 * decision. No Research v2 model contract may contain one.
 */
export const FORBIDDEN_FIELD = /(^p_|_p$|prob|_bp$|^bp_|basis_?point|odds|price|percent|likelihood|chance|expected_goals|^xg|pick|double|1x2|home_win|away_win|draw_bp|forecast|prediction)/i;

/** All property names anywhere in a JSON schema that look like forecast fields. */
export function forbiddenForecastFields(schema: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${path}[${index}]`));
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.properties && typeof record.properties === "object") {
      for (const name of Object.keys(record.properties as Record<string, unknown>)) {
        if (FORBIDDEN_FIELD.test(name)) found.push(`${path}.${name}`);
      }
    }
    for (const [key, child] of Object.entries(record)) walk(child, `${path}.${key}`);
  };
  walk(schema, "$");
  return found;
}

/** Throws when a model output object carries any forecast-like key. */
export function assertNoForecastKeys(value: unknown, context: string): void {
  const found: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) return node.forEach((child, index) => walk(child, `${path}[${index}]`));
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (FORBIDDEN_FIELD.test(key)) found.push(`${path}.${key}`);
      walk(child, `${path}.${key}`);
    }
  };
  walk(value, context);
  if (found.length > 0) throw new Error(`research_v2_forecast_field_in_model_output: ${found.join(", ")}`);
}
