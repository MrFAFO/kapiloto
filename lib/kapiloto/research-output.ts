import type { KapilotoFixtureCard } from "./fixture-card";
import { validateStructuredRefs } from "./structured-refs";

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

export type KapilotoResearchProtocolVersion =
  | "kapiloto-research-v1"
  | "kapiloto-research-v2"
  | "kapiloto-research-v3";

export const KAPILOTO_ROLE_FUNCTIONS = [
  "ball_progressor",
  "creator",
  "finisher",
  "depth_runner",
  "target_outlet",
  "defensive_anchor",
  "aerial_centre_back",
  "width_provider",
  "press_leader",
  "set_piece_taker",
  "goalkeeper",
] as const;

export type KapilotoRoleFunction = (typeof KAPILOTO_ROLE_FUNCTIONS)[number];

export const KAPILOTO_TACTICAL_PHASES = [
  "possession",
  "attacking_transition",
  "defending",
  "defensive_transition",
  "set_pieces",
] as const;

export type KapilotoTacticalPhase =
  (typeof KAPILOTO_TACTICAL_PHASES)[number];

export const KAPILOTO_MATCHUP_KINDS = [
  "press_vs_buildup",
  "transition_vs_rest_defence",
  "line_vs_pace",
  "flank_overload",
  "midfield_control",
  "aerial_set_piece",
  "absence_impact",
  "formation_change",
] as const;

export type KapilotoMatchupKind = (typeof KAPILOTO_MATCHUP_KINDS)[number];

export type SolEvidence = {
  evidence_id: string;
  url: string;
  quote: string;
  claim: string;
  claim_type: string;
  about_team: "home" | "away" | "both" | "none";
  event_time: string | null;
};

export type SolExpectedStarter = {
  player_name: string;
  position: "GK" | "DF" | "MF" | "FW" | "unknown";
  confidence: "low" | "medium" | "high";
  evidence_ids: string[];
};

export type SolExpectedLineup = {
  status: "supported" | "partial" | "insufficient_data";
  formation: string | null;
  formation_evidence_ids: string[];
  starters: SolExpectedStarter[];
};

export type SolTacticalFact = {
  fact_id: "t1" | "t2" | "t3" | "t4" | "t5" | "t6" | "t7" | "t8";
  team: "home" | "away";
  phase: KapilotoTacticalPhase;
  attribute: string;
  value: string;
  evidence_ids: string[];
};

export type SolMatchupAnalysis = {
  matchup_id: "m1" | "m2" | "m3";
  kind: KapilotoMatchupKind;
  fact_ids: string[];
  favors: "home" | "draw" | "away" | "none";
  magnitude: "small" | "medium" | "large";
  description: string;
  evidence_ids: string[];
};

export type SolRegimeChange = {
  team: "home" | "away";
  type: "coach_change" | "formation_change";
  effective_date: string;
  evidence_ids: string[];
};

export type SolFixtureResearchOutput = {
  protocol_version: KapilotoResearchProtocolVersion;
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
    functions?: KapilotoRoleFunction[];
    function_evidence_ids?: string[];
  }>;
  expected_lineups?: {
    home: SolExpectedLineup;
    away: SolExpectedLineup;
  };
  tactical_facts?: SolTacticalFact[];
  matchup_analysis?: SolMatchupAnalysis[];
  regime_changes?: SolRegimeChange[];
  factors: Array<{
    dimension: KapilotoResearchDimension;
    favors: "home" | "draw" | "away" | "none";
    magnitude: "small" | "medium" | "large";
    evidence_ids: string[];
    structured_refs?: string[];
    matchup_ids?: string[];
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

const TRACKING_PARAMS = new Set(["gclid", "fbclid", "mc_cid", "mc_eid"]);

export function normalizeEvidenceUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported evidence URL protocol: ${url.protocol}`);
  }

  url.hash = "";
  url.hostname = url.hostname.toLowerCase();

  for (const key of [...url.searchParams.keys()]) {
    if (
      key.toLowerCase().startsWith("utm_") ||
      TRACKING_PARAMS.has(key.toLowerCase())
    ) {
      url.searchParams.delete(key);
    }
  }

  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  url.searchParams.sort();
  return url.toString();
}

/** V1/V2 limits are frozen for replay compatibility. */
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

/** V3 keeps the new football detail compact enough for one serverless call. */
export const KAPILOTO_V3_TEXT_LIMITS = {
  ...KAPILOTO_TEXT_LIMITS,
  "evidence.claim": 160,
  "availability.player_name": 60,
  "expected_lineups.starters.player_name": 60,
  "matchup_analysis.description": 120,
  "factors.rationale": 220,
  summary: 450,
} as const;

export type KapilotoTextLimitField = keyof typeof KAPILOTO_TEXT_LIMITS;
export type KapilotoV3TextLimitField = keyof typeof KAPILOTO_V3_TEXT_LIMITS;

export const KAPILOTO_NON_EMPTY_TEXT_FIELDS: ReadonlySet<string> = new Set([
  "evidence.quote",
  "evidence.claim",
  "expected_lineups.starters.player_name",
]);

export function kapilotoTextLimitPattern(field: KapilotoTextLimitField): string {
  const min = KAPILOTO_NON_EMPTY_TEXT_FIELDS.has(field) ? 1 : 0;
  return `^.{${min},${KAPILOTO_TEXT_LIMITS[field]}}$`;
}

export function kapilotoV3TextLimitPattern(
  field: KapilotoV3TextLimitField,
): string {
  const min = KAPILOTO_NON_EMPTY_TEXT_FIELDS.has(field) ? 1 : 0;
  return `^.{${min},${KAPILOTO_V3_TEXT_LIMITS[field]}}$`;
}

function assertStringLength(value: string, max: number, field: string): void {
  if (value.length > max) {
    throw new Error(`${field} exceeds ${max} characters.`);
  }
}

function textLimit(
  protocol: KapilotoResearchProtocolVersion,
  field: KapilotoV3TextLimitField,
): number {
  if (protocol === "kapiloto-research-v3") {
    return KAPILOTO_V3_TEXT_LIMITS[field];
  }
  const legacy = KAPILOTO_TEXT_LIMITS[
    field as keyof typeof KAPILOTO_TEXT_LIMITS
  ];
  return legacy ?? KAPILOTO_V3_TEXT_LIMITS[field];
}

function assertLimit(
  protocol: KapilotoResearchProtocolVersion,
  value: string,
  field: KapilotoV3TextLimitField,
): void {
  assertStringLength(value, textLimit(protocol, field), field);
}

function assertNoUrl(value: string, field: string): void {
  if (/https?:\/\//i.test(value)) {
    throw new Error(`${field} must not contain a raw URL.`);
  }
}

function normalizeHumanName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function isValidFormation(value: string): boolean {
  if (!/^[1-5](?:-[1-5]){2,4}$/.test(value)) return false;
  return value
    .split("-")
    .map(Number)
    .reduce((sum, part) => sum + part, 0) === 10;
}

const TACTICAL_VALUES: Record<
  KapilotoTacticalPhase,
  Record<string, readonly string[]>
> = {
  possession: {
    build_up: ["short", "mixed", "direct"],
    progression: ["central", "wide", "long"],
    width: ["wide", "narrow", "overload_left", "overload_right"],
  },
  attacking_transition: {
    counter: ["fast_direct", "measured", "rare"],
    outlet: ["target_forward", "pace_runners", "none"],
  },
  defending: {
    press_height: ["high", "mid", "low"],
    block: ["high", "mid", "low"],
    line: ["high", "medium", "deep"],
  },
  defensive_transition: {
    reaction: ["counterpress", "retreat", "mixed"],
    rest_defence: ["secure", "exposed"],
  },
  set_pieces: {
    attacking: ["strong", "average", "weak"],
    defending: ["strong", "average", "weak"],
    aerial: ["strong", "average", "weak"],
  },
};

function assertV3FieldsAbsent(
  raw: Record<string, unknown>,
  protocol: KapilotoResearchProtocolVersion,
): void {
  if (protocol === "kapiloto-research-v3") return;
  for (const key of [
    "expected_lineups",
    "tactical_facts",
    "matchup_analysis",
    "regime_changes",
  ]) {
    if (raw[key] !== undefined) {
      throw new Error(`${key} is only valid in kapiloto-research-v3.`);
    }
  }
}

export function validateSolFixtureResearchOutput(
  raw: unknown,
  card: KapilotoFixtureCard,
  observedSourceUrls: string[],
  expectedProtocol?: KapilotoResearchProtocolVersion,
): SolOutputValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Sol research output must be an object.");
  }

  const rawRecord = raw as Record<string, unknown>;
  const output = JSON.parse(JSON.stringify(raw)) as SolFixtureResearchOutput;

  if (
    output.protocol_version !== "kapiloto-research-v1" &&
    output.protocol_version !== "kapiloto-research-v2" &&
    output.protocol_version !== "kapiloto-research-v3"
  ) {
    throw new Error("Unexpected Kapiloto research protocol version.");
  }
  if (expectedProtocol && output.protocol_version !== expectedProtocol) {
    throw new Error(
      `Sol protocol ${output.protocol_version} does not match frozen run protocol ${expectedProtocol}.`,
    );
  }
  assertV3FieldsAbsent(rawRecord, output.protocol_version);

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
        !Number.isInteger(value) ||
        (value as number) < 0 ||
        (value as number) > 10_000,
    )
  ) {
    throw new Error("Sol p_sol values must be integer basis points.");
  }
  if (
    output.p_sol.home_bp + output.p_sol.draw_bp + output.p_sol.away_bp !==
    10_000
  ) {
    throw new Error("Sol p_sol basis points must sum to exactly 10000.");
  }

  if (!Array.isArray(output.evidence)) {
    throw new Error("Sol evidence must be an array.");
  }

  const evidenceCap =
    output.protocol_version === "kapiloto-research-v3" ? 24 : 20;
  if (output.evidence.length > evidenceCap) {
    throw new Error(`Sol evidence may contain at most ${evidenceCap} rows.`);
  }

  const observed = new Set(
    observedSourceUrls.map((url) => normalizeEvidenceUrl(url)),
  );
  const evidenceIds = new Set<string>();

  for (const item of output.evidence) {
    if (!item.evidence_id || evidenceIds.has(item.evidence_id)) {
      throw new Error(
        `Evidence ids must be non-empty and unique: ${item.evidence_id}`,
      );
    }

    normalizeEvidenceUrl(item.url);
    evidenceIds.add(item.evidence_id);
    assertLimit(output.protocol_version, item.quote, "evidence.quote");
    assertLimit(output.protocol_version, item.claim, "evidence.claim");

    if (
      item.event_time != null &&
      !Number.isFinite(Date.parse(item.event_time))
    ) {
      throw new Error(
        `evidence.event_time must be ISO/date parseable: ${item.event_time}`,
      );
    }
  }

  const dimensions = new Set<string>();
  if (
    !Array.isArray(output.dimension_coverage) ||
    output.dimension_coverage.length !== 10
  ) {
    throw new Error("dimension_coverage must contain exactly 10 rows.");
  }
  for (const item of output.dimension_coverage) {
    if (
      !KAPILOTO_RESEARCH_DIMENSIONS.includes(
        item.dimension as KapilotoResearchDimension,
      )
    ) {
      throw new Error(`Unknown research dimension: ${item.dimension}`);
    }
    if (dimensions.has(item.dimension)) {
      throw new Error(`Duplicate research dimension: ${item.dimension}`);
    }
    dimensions.add(item.dimension);
  }

  const assertEvidenceReferences = (ids: string[], field: string) => {
    for (const id of ids) {
      if (!evidenceIds.has(id)) {
        throw new Error(`${field} references unknown evidence id ${id}.`);
      }
    }
  };

  for (const item of output.availability ?? []) {
    assertLimit(
      output.protocol_version,
      item.player_name,
      "availability.player_name",
    );
    assertEvidenceReferences(
      item.evidence_ids,
      `availability:${item.player_name}`,
    );

    if (output.protocol_version === "kapiloto-research-v3") {
      item.functions ??= [];
      item.function_evidence_ids ??= [];
      if (item.functions.length > 2) {
        throw new Error("availability.functions may contain at most 2 roles.");
      }
      if (
        item.functions.some(
          (role) =>
            !(KAPILOTO_ROLE_FUNCTIONS as readonly string[]).includes(role),
        )
      ) {
        throw new Error(
          `availability:${item.player_name} contains an unknown role.`,
        );
      }
      if (
        item.functions.length > 0 &&
        item.function_evidence_ids.length === 0
      ) {
        throw new Error(
          `availability:${item.player_name} roles require evidence.`,
        );
      }
      if (item.function_evidence_ids.length > 2) {
        throw new Error(
          `availability:${item.player_name} role evidence exceeds 2 rows.`,
        );
      }
      assertEvidenceReferences(
        item.function_evidence_ids,
        `availability:${item.player_name}:functions`,
      );
    }
  }

  const matchupIds = new Set<string>();
  const matchupById = new Map<string, SolMatchupAnalysis>();

  if (output.protocol_version === "kapiloto-research-v3") {
    if (
      !output.expected_lineups ||
      !Array.isArray(output.tactical_facts) ||
      !Array.isArray(output.matchup_analysis) ||
      !Array.isArray(output.regime_changes)
    ) {
      throw new Error(
        "kapiloto-research-v3 requires expected_lineups, tactical_facts, matchup_analysis and regime_changes.",
      );
    }

    if (output.matchup_analysis.length > 3) {
      throw new Error("matchup_analysis may contain at most 3 items.");
    }
    if (output.tactical_facts.length > 8) {
      throw new Error("tactical_facts may contain at most 8 items.");
    }
    if (output.regime_changes.length > 2) {
      throw new Error("regime_changes may contain at most 2 items.");
    }

    const starterNames = new Set<string>();
    for (const side of ["home", "away"] as const) {
      const lineup = output.expected_lineups[side];
      if (!lineup || !Array.isArray(lineup.starters)) {
        throw new Error(`expected_lineups.${side} is missing.`);
      }
      if (lineup.starters.length > 11) {
        throw new Error(
          `expected_lineups.${side}.starters may contain at most 11 players.`,
        );
      }
      if (lineup.formation == null) {
        if (lineup.formation_evidence_ids.length !== 0) {
          throw new Error(
            `expected_lineups.${side} cannot cite formation evidence without a formation.`,
          );
        }
      } else {
        if (!isValidFormation(lineup.formation)) {
          throw new Error(
            `expected_lineups.${side}.formation is not a valid 10-outfield-player shape.`,
          );
        }
        if (
          lineup.formation_evidence_ids.length < 1 ||
          lineup.formation_evidence_ids.length > 2
        ) {
          throw new Error(
            `expected_lineups.${side}.formation requires 1-2 evidence rows.`,
          );
        }
        assertEvidenceReferences(
          lineup.formation_evidence_ids,
          `expected_lineups.${side}.formation`,
        );
      }

      for (const starter of lineup.starters) {
        assertLimit(
          output.protocol_version,
          starter.player_name,
          "expected_lineups.starters.player_name",
        );
        const normalized = normalizeHumanName(starter.player_name);
        if (!normalized || starterNames.has(normalized)) {
          throw new Error(
            "Predicted starter names must be non-empty and unique across both teams.",
          );
        }
        starterNames.add(normalized);
        if (
          starter.evidence_ids.length < 1 ||
          starter.evidence_ids.length > 2
        ) {
          throw new Error(
            `Starter ${starter.player_name} requires 1-2 evidence rows.`,
          );
        }
        assertEvidenceReferences(
          starter.evidence_ids,
          `expected_lineups.${side}.starter:${starter.player_name}`,
        );
      }

      if (
        card.lineup_research === "disabled" &&
        (lineup.formation != null || lineup.starters.length > 0)
      ) {
        throw new Error(
          `expected_lineups.${side} must stay empty when lineup research is disabled.`,
        );
      }
    }

    const factIds = new Set<string>();
    const factsByTeam = { home: 0, away: 0 };
    for (const fact of output.tactical_facts) {
      if (factIds.has(fact.fact_id)) {
        throw new Error(`Duplicate tactical fact id: ${fact.fact_id}`);
      }
      factIds.add(fact.fact_id);
      factsByTeam[fact.team] += 1;
      if (factsByTeam[fact.team] > 4) {
        throw new Error(
          `tactical_facts may contain at most 4 facts for ${fact.team}.`,
        );
      }
      const phase = TACTICAL_VALUES[fact.phase];
      const values = phase?.[fact.attribute];
      if (!values || !values.includes(fact.value)) {
        throw new Error(
          `Invalid tactical fact pairing: ${fact.phase}/${fact.attribute}/${fact.value}`,
        );
      }
      if (fact.evidence_ids.length < 1 || fact.evidence_ids.length > 2) {
        throw new Error(
          `Tactical fact ${fact.fact_id} requires 1-2 evidence rows.`,
        );
      }
      assertEvidenceReferences(
        fact.evidence_ids,
        `tactical_fact:${fact.fact_id}`,
      );
    }

    for (const matchup of output.matchup_analysis) {
      if (matchupIds.has(matchup.matchup_id)) {
        throw new Error(`Duplicate matchup id: ${matchup.matchup_id}`);
      }
      matchupIds.add(matchup.matchup_id);
      matchupById.set(matchup.matchup_id, matchup);
      assertLimit(
        output.protocol_version,
        matchup.description,
        "matchup_analysis.description",
      );
      assertNoUrl(matchup.description, "matchup_analysis.description");
      if (matchup.fact_ids.length < 1 || matchup.fact_ids.length > 4) {
        throw new Error(
          `Matchup ${matchup.matchup_id} requires 1-4 tactical fact ids.`,
        );
      }
      for (const factId of matchup.fact_ids) {
        if (!factIds.has(factId)) {
          throw new Error(
            `Matchup ${matchup.matchup_id} references unknown fact id ${factId}.`,
          );
        }
      }
      if (matchup.evidence_ids.length < 1 || matchup.evidence_ids.length > 4) {
        throw new Error(
          `Matchup ${matchup.matchup_id} requires 1-4 evidence rows.`,
        );
      }
      assertEvidenceReferences(
        matchup.evidence_ids,
        `matchup:${matchup.matchup_id}`,
      );
    }

    for (const regime of output.regime_changes) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(regime.effective_date)) {
        throw new Error("regime_changes.effective_date must be YYYY-MM-DD.");
      }
      if (
        regime.evidence_ids.length < 1 ||
        regime.evidence_ids.length > 2
      ) {
        throw new Error("regime_changes require 1-2 evidence rows.");
      }
      assertEvidenceReferences(regime.evidence_ids, "regime_changes");
    }
  }

  const linkedMatchups = new Map<string, string>();
  for (const factor of output.factors ?? []) {
    assertEvidenceReferences(
      factor.evidence_ids,
      `factor:${factor.dimension}`,
    );

    const structuredRefs = factor.structured_refs ?? [];
    factor.structured_refs = validateStructuredRefs(structuredRefs, card);

    if (
      factor.evidence_ids.length === 0 &&
      factor.structured_refs.length === 0
    ) {
      throw new Error(
        `factor:${factor.dimension} must cite web evidence or structured refs.`,
      );
    }

    if (output.protocol_version === "kapiloto-research-v3") {
      factor.matchup_ids ??= [];
      if (factor.matchup_ids.length > 3) {
        throw new Error("factor.matchup_ids may contain at most 3 items.");
      }
      for (const matchupId of factor.matchup_ids) {
        const matchup = matchupById.get(matchupId);
        if (!matchup) {
          throw new Error(
            `factor:${factor.dimension} references unknown matchup ${matchupId}.`,
          );
        }
        if (linkedMatchups.has(matchupId)) {
          throw new Error(
            `Matchup ${matchupId} is linked from more than one factor.`,
          );
        }
        linkedMatchups.set(matchupId, factor.dimension);

        const requiredDimension =
          matchup.kind === "absence_impact"
            ? "availability"
            : matchup.kind === "formation_change"
              ? null
              : "tactical_matchup";
        if (
          requiredDimension &&
          factor.dimension !== requiredDimension
        ) {
          throw new Error(
            `Matchup ${matchupId} must link to a ${requiredDimension} factor.`,
          );
        }
        if (
          matchup.kind === "formation_change" &&
          factor.dimension !== "tactical_matchup" &&
          factor.dimension !== "club_coach_news"
        ) {
          throw new Error(
            `formation_change matchup ${matchupId} must link to tactical_matchup or club_coach_news.`,
          );
        }
        if (factor.favors !== matchup.favors) {
          throw new Error(
            `factor:${factor.dimension} and matchup ${matchupId} must agree on favors.`,
          );
        }
        const rank = { small: 1, medium: 2, large: 3 } as const;
        if (rank[factor.magnitude] < rank[matchup.magnitude]) {
          throw new Error(
            `factor:${factor.dimension} magnitude cannot be smaller than linked matchup ${matchupId}.`,
          );
        }
        for (const evidenceId of matchup.evidence_ids) {
          if (!factor.evidence_ids.includes(evidenceId)) {
            throw new Error(
              `factor:${factor.dimension} must include matchup ${matchupId} evidence ${evidenceId}.`,
            );
          }
        }
      }
    }

    assertLimit(
      output.protocol_version,
      factor.rationale,
      "factors.rationale",
    );
    assertNoUrl(factor.rationale, "factor.rationale");
  }

  if (output.protocol_version === "kapiloto-research-v3") {
    for (const matchup of output.matchup_analysis ?? []) {
      if (matchup.favors !== "none" && !linkedMatchups.has(matchup.matchup_id)) {
        throw new Error(
          `Directional matchup ${matchup.matchup_id} must be linked from exactly one factor.`,
        );
      }
    }
  }

  for (const conflict of output.conflicts ?? []) {
    assertLimit(output.protocol_version, conflict.topic, "conflicts.topic");
    assertEvidenceReferences(
      conflict.evidence_ids_a,
      `conflict:${conflict.topic}:a`,
    );
    assertEvidenceReferences(
      conflict.evidence_ids_b,
      `conflict:${conflict.topic}:b`,
    );
  }

  if (output.market_deviation != null) {
    assertEvidenceReferences(
      output.market_deviation.evidence_ids,
      "market_deviation",
    );
    assertLimit(
      output.protocol_version,
      output.market_deviation.summary,
      "market_deviation.summary",
    );
    assertNoUrl(output.market_deviation.summary, "market_deviation.summary");
  }

  for (const assumption of output.key_assumptions ?? []) {
    assertLimit(output.protocol_version, assumption, "key_assumptions");
    assertNoUrl(assumption, "key_assumptions");
  }

  assertLimit(output.protocol_version, output.main_risk, "main_risk");
  assertLimit(output.protocol_version, output.summary, "summary");
  assertLimit(
    output.protocol_version,
    output.data_quality.notes,
    "data_quality.notes",
  );

  for (const item of output.watch_items ?? []) {
    assertLimit(
      output.protocol_version,
      item.condition,
      "watch_items.condition",
    );
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
      output.protocol_version,
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
