import type { KapilotoFixtureCard } from "./fixture-card";

export const KAPILOTO_RESEARCH_DIMENSIONS = [
  "baseline_form",
  "home_away_draw",
  "availability",
  "load_schedule",
  "tactical_matchup",
  "competition_context",
  "club_coach_news",
  "independent_model",
  "conditions",
  "head_to_head",
] as const;

export type KapilotoResearchDimension =
  (typeof KAPILOTO_RESEARCH_DIMENSIONS)[number];

export type SolEvidence = {
  evidence_id: string;
  url: string;
  quote: string;
  claim: string;
  claim_type: string;
  about_team: "home" | "away" | "both" | "none";
  event_time: string | null;
};

export type SolFixtureResearchOutput = {
  protocol_version: "kapiloto-research-v1";
  fixture_key: string;
  home_team_id: string;
  away_team_id: string;
  outcome: "analyzed" | "insufficient_data";
  evidence: SolEvidence[];
  availability: Array<{
    team: "home" | "away";
    player_name: string;
    status: "out" | "doubtful" | "suspended" | "returning" | "rotation_risk";
    role: "key_starter" | "regular" | "squad" | "unknown";
    certainty: "confirmed" | "probable" | "reported";
    evidence_ids: string[];
  }>;
  factors: Array<{
    dimension: KapilotoResearchDimension;
    favors: "home" | "draw" | "away" | "none";
    magnitude: "small" | "medium" | "large";
    evidence_ids: string[];
    rationale: string;
  }>;
  dimension_coverage: Array<{
    dimension: KapilotoResearchDimension;
    status: "material_signal" | "no_material_signal" | "insufficient_data";
  }>;
  conflicts: Array<{
    topic: string;
    evidence_ids_a: string[];
    evidence_ids_b: string[];
    resolution:
      | "unresolved"
      | "superseded_by_newer"
      | "resolved_by_higher_tier";
  }>;
  p_sol: {
    home_bp: number;
    draw_bp: number;
    away_bp: number;
  };
  market_deviation: {
    summary: string;
    evidence_ids: string[];
  } | null;
  key_assumptions: string[];
  main_risk: string;
  summary: string;
  watch_items: Array<{
    signal_type:
      | "lineup"
      | "injury"
      | "suspension"
      | "odds_move"
      | "kickoff_change"
      | "coach_news"
      | "weather"
      | "postponement";
    team: "home" | "away" | "both";
    player_name: string | null;
    condition: string;
    impact_if_triggered:
      | "favors_home"
      | "favors_draw"
      | "favors_away"
      | "uncertain";
  }>;
  data_quality: {
    sparse_coverage: boolean;
    language_limited: boolean;
    notes: string;
  };
  suspicious_content_observed: Array<{
    url: string;
    description: string;
  }>;
  model_self_confidence: "low" | "medium" | "high";
};

export type SolOutputValidation = {
  output: SolFixtureResearchOutput;
  normalizedSourceUrls: string[];
};

const TRACKING_PARAMS = new Set([
  "gclid",
  "fbclid",
  "mc_cid",
  "mc_eid",
]);

export function normalizeEvidenceUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported evidence URL protocol: ${url.protocol}`);
  }

  url.hash = "";
  url.hostname = url.hostname.toLowerCase();

  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }

  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  url.searchParams.sort();
  return url.toString();
}

/**
 * Hard character limits for Sol free-text fields.
 *
 * The strict JSON Schema enforces the same bounds during generation through a
 * `pattern` (OpenAI strict Structured Outputs rejects `maxLength`), so a
 * length violation can no longer surface only after minutes of paid research.
 * `research-output.test.ts` keeps the schema patterns and these limits equal.
 */
export const KAPILOTO_TEXT_LIMITS = {
  "evidence.quote": 300,
  "evidence.claim": 220,
  "availability.player_name": 80,
  "factors.rationale": 300,
  "conflicts.topic": 150,
  "market_deviation.summary": 300,
  key_assumptions: 150,
  main_risk: 300,
  summary: 700,
  "watch_items.condition": 150,
  "data_quality.notes": 220,
  "suspicious_content_observed.description": 220,
} as const;

export type KapilotoTextLimitField = keyof typeof KAPILOTO_TEXT_LIMITS;

/** Fields whose schema pattern also requires at least one character. */
export const KAPILOTO_NON_EMPTY_TEXT_FIELDS: ReadonlySet<KapilotoTextLimitField> =
  new Set(["evidence.quote", "evidence.claim"]);

export function kapilotoTextLimitPattern(field: KapilotoTextLimitField): string {
  const min = KAPILOTO_NON_EMPTY_TEXT_FIELDS.has(field) ? 1 : 0;
  return `^.{${min},${KAPILOTO_TEXT_LIMITS[field]}}$`;
}

function assertStringLength(
  value: string,
  max: number,
  field: string,
): void {
  if (value.length > max) {
    throw new Error(`${field} exceeds ${max} characters.`);
  }
}

function assertLimit(value: string, field: KapilotoTextLimitField): void {
  assertStringLength(value, KAPILOTO_TEXT_LIMITS[field], field);
}

function assertNoUrl(value: string, field: string): void {
  if (/https?:\/\//i.test(value)) {
    throw new Error(`${field} must not contain a raw URL.`);
  }
}

function filterEvidenceReferences(
  ids: string[],
  known: Set<string>,
): string[] {
  return ids.filter((id) => known.has(id));
}

export function validateSolFixtureResearchOutput(
  raw: unknown,
  card: KapilotoFixtureCard,
  observedSourceUrls: string[],
): SolOutputValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Sol research output must be an object.");
  }

  const output = raw as SolFixtureResearchOutput;

  if (output.protocol_version !== "kapiloto-research-v1") {
    throw new Error("Unexpected Kapiloto research protocol version.");
  }
  if (output.fixture_key !== card.fixture_key) {
    throw new Error("Sol fixture_key does not match the frozen Fixture Card.");
  }
  if (output.home_team_id !== card.teams.home.id) {
    throw new Error("Sol home_team_id does not match the frozen Fixture Card.");
  }
  if (output.away_team_id !== card.teams.away.id) {
    throw new Error("Sol away_team_id does not match the frozen Fixture Card.");
  }
  if (output.outcome !== "analyzed" && output.outcome !== "insufficient_data") {
    throw new Error(
      `Sol cannot author server-only research outcome: ${String(output.outcome)}`,
    );
  }

  const scoreValues = [
    output.p_sol?.home_bp,
    output.p_sol?.draw_bp,
    output.p_sol?.away_bp,
  ];
  if (
    scoreValues.some(
      (value) =>
        !Number.isInteger(value) || (value as number) < 0 || (value as number) > 10_000,
    )
  ) {
    throw new Error("Sol p_sol values must be integer basis points.");
  }
  if (
    (output.p_sol.home_bp + output.p_sol.draw_bp + output.p_sol.away_bp) !==
    10_000
  ) {
    throw new Error("Sol p_sol basis points must sum to exactly 10000.");
  }

  if (!Array.isArray(output.evidence)) {
    throw new Error("Sol evidence must be an array.");
  }

  const observed = new Set(
    observedSourceUrls.map((url) => normalizeEvidenceUrl(url)),
  );
  const evidenceIds = new Set<string>();

  output.evidence = output.evidence.filter((item) => {
    if (!item.evidence_id || evidenceIds.has(item.evidence_id)) {
      throw new Error(
        `Evidence ids must be non-empty and unique: ${item.evidence_id}`,
      );
    }

    const normalized = normalizeEvidenceUrl(item.url);
    if (!observed.has(normalized)) {
      return false;
    }

    evidenceIds.add(item.evidence_id);
    assertLimit(item.quote, "evidence.quote");
    assertLimit(item.claim, "evidence.claim");

    if (item.event_time != null && !Number.isFinite(Date.parse(item.event_time))) {
      throw new Error(
        `evidence.event_time must be ISO/date parseable: ${item.event_time}`,
      );
    }

    return true;
  });

  const dimensions = new Set<string>();
  if (!Array.isArray(output.dimension_coverage) || output.dimension_coverage.length !== 10) {
    throw new Error("dimension_coverage must contain exactly 10 rows.");
  }
  for (const item of output.dimension_coverage) {
    if (!KAPILOTO_RESEARCH_DIMENSIONS.includes(item.dimension)) {
      throw new Error(`Unknown research dimension: ${item.dimension}`);
    }
    if (dimensions.has(item.dimension)) {
      throw new Error(`Duplicate research dimension: ${item.dimension}`);
    }
    dimensions.add(item.dimension);
  }

  for (const item of output.availability ?? []) {
    assertLimit(item.player_name, "availability.player_name");
    item.evidence_ids = filterEvidenceReferences(
      item.evidence_ids,
      evidenceIds,
    );
  }

  for (const factor of output.factors ?? []) {
    factor.evidence_ids = filterEvidenceReferences(
      factor.evidence_ids,
      evidenceIds,
    );
    assertLimit(factor.rationale, "factors.rationale");
    assertNoUrl(factor.rationale, "factor.rationale");
  }

  for (const conflict of output.conflicts ?? []) {
    assertLimit(conflict.topic, "conflicts.topic");
    conflict.evidence_ids_a = filterEvidenceReferences(
      conflict.evidence_ids_a,
      evidenceIds,
    );
    conflict.evidence_ids_b = filterEvidenceReferences(
      conflict.evidence_ids_b,
      evidenceIds,
    );
  }

  if (output.market_deviation != null) {
    output.market_deviation.evidence_ids = filterEvidenceReferences(
      output.market_deviation.evidence_ids,
      evidenceIds,
    );
    assertLimit(output.market_deviation.summary, "market_deviation.summary");
    assertNoUrl(output.market_deviation.summary, "market_deviation.summary");
  }

  for (const assumption of output.key_assumptions ?? []) {
    assertLimit(assumption, "key_assumptions");
    assertNoUrl(assumption, "key_assumptions");
  }

  assertLimit(output.main_risk, "main_risk");
  assertLimit(output.summary, "summary");
  assertLimit(output.data_quality.notes, "data_quality.notes");

  for (const item of output.watch_items ?? []) {
    assertLimit(item.condition, "watch_items.condition");
  }
  assertNoUrl(output.main_risk, "main_risk");
  assertNoUrl(output.summary, "summary");
  assertNoUrl(output.data_quality.notes, "data_quality.notes");

  output.suspicious_content_observed = (
    output.suspicious_content_observed ?? []
  ).filter((suspicious) => {
    const normalized = normalizeEvidenceUrl(suspicious.url);
    if (!observed.has(normalized)) return false;
    assertLimit(
      suspicious.description,
      "suspicious_content_observed.description",
    );
    return true;
  });

  return {
    output,
    normalizedSourceUrls: [...observed].sort(),
  };
}
