import type { KapilotoFixtureCard } from "./fixture-card";
import {
  deriveFixtureAnalysis,
  type DerivedAnalyzedFixture,
} from "./derivation";
import type {
  FrozenFixtureContext,
  ResearchIneligibilityReason,
} from "./research-run-plan";
import type { SolFixtureResearchOutput } from "./research-output";
import type { GroundingResult } from "./source-grounding";

export type ValidatedFixtureResearch = {
  gameNumber: number;
  roundGameId: string;
  fixtureId: string;
  card: KapilotoFixtureCard;
  output: SolFixtureResearchOutput;
  grounding: GroundingResult;
};

export type MaterializedEvidence = {
  model_evidence_id: string;
  url_canonical: string;
  domain: string;
  claim_type: string;
  about_team: "home" | "away" | "both" | "none";
  quote: string;
  claim: string;
  source_event_time: string | null;
  published_at: string | null;
  retrieved_at: string;
  trust_tier: number;
  quote_verified: true;
  entailment: "supported" | "unsupported" | "not_checked";
  syndication_cluster_id: string | null;
  content_sha256: string;
  status: "accepted";
  rejected_reason: null;
};

export type MaterializedFactor = {
  dimension: string;
  favors: "home" | "draw" | "away" | "none";
  magnitude: "small" | "medium" | "large";
  rationale: string;
  evidence_model_ids: string[];
};

export type MaterializedAnalysis = {
  round_game_id: string;
  fixture_id: string;
  outcome:
    | "analyzed"
    | "insufficient_data"
    | "void"
    | "carried_forward"
    | "research_unavailable";
  carried_from_analysis_id: string | null;
  research_cutoff_at: string;
  kickoff_at_snapshot: string;
  settlement_rule_snapshot: string;
  neutral_venue_snapshot: boolean;
  orientation_verified: boolean;
  prior_type: "market" | "rating" | "league_base" | null;
  market_snapshot_id: string | null;
  p_prior_1_bp: number | null;
  p_prior_x_bp: number | null;
  p_prior_2_bp: number | null;
  p_sol_1_bp: number | null;
  p_sol_x_bp: number | null;
  p_sol_2_bp: number | null;
  p_final_1_bp: number | null;
  p_final_x_bp: number | null;
  p_final_2_bp: number | null;
  reliability: number | null;
  reliability_band: "low" | "medium" | "high" | null;
  reliability_reasons: string[];
  model_self_confidence: "low" | "medium" | "high" | null;
  primary_pick: "1" | "X" | "2" | null;
  suggested_double: "1X" | "X2" | "12" | null;
  double_priority_rank: number | null;
  double_gain_score: number | null;
  blend_weight: number | null;
  deviation_cap_applied: boolean;
  summary: string | null;
  main_risk: string | null;
  availability: SolFixtureResearchOutput["availability"];
  dimension_coverage: SolFixtureResearchOutput["dimension_coverage"];
  conflicts: SolFixtureResearchOutput["conflicts"];
  watch_items: SolFixtureResearchOutput["watch_items"];
  key_assumptions: string[];
  data_quality: SolFixtureResearchOutput["data_quality"];
  suspicious_content: SolFixtureResearchOutput["suspicious_content_observed"];
  valid_until: string | null;
  generated_at: string | null;
  evidence: MaterializedEvidence[];
  factors: MaterializedFactor[];
  inputs: Array<{
    input_type: string;
    input_version: string | null;
    metadata: Record<string, unknown>;
  }>;
};

export type CarryForwardSource = {
  analysisId: string;
  analysis: MaterializedAnalysis;
};

export type MaterializableFixture =
  | ({ mode: "research" } & ValidatedFixtureResearch)
  | {
      mode: "carried_forward";
      gameNumber: number;
      roundGameId: string;
      fixtureId: string;
      carriedFromAnalysisId: string;
      reason: Exclude<ResearchIneligibilityReason, "invalid_fixture">;
      context: FrozenFixtureContext;
      researchCutoffAt: string;
      source: CarryForwardSource;
    }
  | {
      mode: "research_unavailable";
      gameNumber: number;
      roundGameId: string;
      fixtureId: string;
      reason: ResearchIneligibilityReason;
      context: FrozenFixtureContext;
      researchCutoffAt: string;
    };

export type MaterializedRound = {
  analyses: MaterializedAnalysis[];
  synthesis: {
    analyzed_fixtures: number;
    insufficient_data_fixtures: number;
    carried_forward_fixtures: number;
    research_unavailable_fixtures: number;
    double_ranking: Array<{
      fixture_id: string;
      round_game_id: string;
      game_number: number;
      rank: number;
      primary_pick: "1" | "X" | "2";
      suggested_double: "1X" | "X2" | "12";
      double_gain_score: number;
      reliability: number;
    }>;
  };
};

const OUTCOME_ORDER = ["1", "X", "2"] as const;

function assertFixtureIdentity(input: ValidatedFixtureResearch): void {
  if (
    input.card.fixture_id !== input.fixtureId ||
    input.card.fixture_key !== input.fixtureId ||
    input.card.round_game_id !== input.roundGameId ||
    input.card.toto_number !== input.gameNumber
  ) {
    throw new Error(
      "Validated research does not match its frozen fixture identity.",
    );
  }
}

function acceptedEvidence(
  grounding: GroundingResult,
): MaterializedEvidence[] {
  return grounding.accepted.map((item) => ({
    model_evidence_id: item.modelEvidenceId,
    url_canonical: item.canonicalUrl,
    domain: item.domain,
    claim_type: item.claimType,
    about_team: item.aboutTeam,
    quote: item.quote,
    claim: item.claim,
    source_event_time: item.sourceEventTime,
    published_at: item.publishedAt,
    retrieved_at: item.retrievedAt,
    trust_tier: item.trustTier,
    quote_verified: true,
    entailment: item.entailment,
    syndication_cluster_id: item.syndicationClusterId,
    content_sha256: item.contentSha256,
    status: "accepted",
    rejected_reason: null,
  }));
}

function baseMaterialization(
  input: ValidatedFixtureResearch,
): Omit<
  MaterializedAnalysis,
  | "outcome"
  | "p_prior_1_bp"
  | "p_prior_x_bp"
  | "p_prior_2_bp"
  | "p_sol_1_bp"
  | "p_sol_x_bp"
  | "p_sol_2_bp"
  | "p_final_1_bp"
  | "p_final_x_bp"
  | "p_final_2_bp"
  | "reliability"
  | "reliability_band"
  | "reliability_reasons"
  | "primary_pick"
  | "suggested_double"
  | "double_priority_rank"
  | "double_gain_score"
  | "blend_weight"
  | "deviation_cap_applied"
> {
  const { card, output, grounding } = input;

  return {
    round_game_id: input.roundGameId,
    fixture_id: input.fixtureId,
    carried_from_analysis_id: null,
    research_cutoff_at: card.research_cutoff_at,
    kickoff_at_snapshot: card.kickoff_at,
    settlement_rule_snapshot: card.settlement,
    neutral_venue_snapshot: card.neutral_venue,
    orientation_verified: true,
    prior_type: card.structured.prior.type,
    market_snapshot_id: card.structured.prior.snapshot_id,
    model_self_confidence: output.model_self_confidence,
    summary: output.summary,
    main_risk: output.main_risk,
    availability: output.availability,
    dimension_coverage: output.dimension_coverage,
    conflicts: output.conflicts,
    watch_items: output.watch_items,
    key_assumptions: output.key_assumptions,
    data_quality: output.data_quality,
    suspicious_content: output.suspicious_content_observed,
    valid_until: null,
    generated_at: null,
    evidence: acceptedEvidence(grounding),
    factors: output.factors.map((factor) => ({
      dimension: factor.dimension,
      favors: factor.favors,
      magnitude: factor.magnitude,
      rationale: factor.rationale,
      evidence_model_ids: [...factor.evidence_ids],
    })),
    inputs: [
      {
        input_type: "fixture_card",
        input_version: card.fixture_card_version,
        metadata: {
          fixture_id: card.fixture_id,
          market_snapshot_id: card.structured.prior.snapshot_id,
        },
      },
      {
        input_type: "grounding_report",
        input_version: "kapiloto-grounding-v1",
        metadata: {
          accepted_count: grounding.accepted.length,
          rejected: grounding.rejected,
          requires_entailment_verification:
            grounding.requiresEntailmentVerification,
        },
      },
    ],
  };
}

function groundingSummary(grounding: GroundingResult) {
  return {
    acceptedTrustTiers: grounding.accepted.map((item) => item.trustTier),
    rejectedCount: grounding.rejected.length,
  };
}

function analyzedPayload(
  input: ValidatedFixtureResearch,
  derived: DerivedAnalyzedFixture,
): MaterializedAnalysis {
  return {
    ...baseMaterialization(input),
    outcome: "analyzed",
    p_prior_1_bp: derived.pPrior["1"],
    p_prior_x_bp: derived.pPrior.X,
    p_prior_2_bp: derived.pPrior["2"],
    p_sol_1_bp: derived.pSol["1"],
    p_sol_x_bp: derived.pSol.X,
    p_sol_2_bp: derived.pSol["2"],
    p_final_1_bp: derived.pFinal["1"],
    p_final_x_bp: derived.pFinal.X,
    p_final_2_bp: derived.pFinal["2"],
    reliability: derived.reliability,
    reliability_band: derived.reliabilityBand,
    reliability_reasons: derived.reliabilityReasons,
    primary_pick: derived.primaryPick,
    suggested_double: derived.suggestedDouble,
    double_priority_rank: null,
    double_gain_score:
      Math.round(derived.doubleGainScore * 100_000_000) / 100_000_000,
    blend_weight: derived.blendWeight,
    deviation_cap_applied: derived.deviationCapApplied,
  };
}

function materializeResearchFixture(
  input: ValidatedFixtureResearch,
): MaterializedAnalysis {
  assertFixtureIdentity(input);

  if (
    input.output.outcome === "analyzed" &&
    input.grounding.accepted.length === 0
  ) {
    throw new Error(
      `Analyzed fixture ${input.fixtureId} has no accepted grounded evidence.`,
    );
  }

  if (input.grounding.requiresEntailmentVerification.length > 0) {
    throw new Error(
      `Fixture ${input.fixtureId} still requires material-factor entailment verification.`,
    );
  }

  const derived = deriveFixtureAnalysis(
    input.output,
    input.card,
    groundingSummary(input.grounding),
  );

  if (derived.outcome === "analyzed") {
    return analyzedPayload(input, derived);
  }

  return {
    ...baseMaterialization(input),
    outcome: "insufficient_data",
    p_prior_1_bp: input.card.structured.prior.p_home_bp,
    p_prior_x_bp: input.card.structured.prior.p_draw_bp,
    p_prior_2_bp: input.card.structured.prior.p_away_bp,
    p_sol_1_bp: null,
    p_sol_x_bp: null,
    p_sol_2_bp: null,
    p_final_1_bp: null,
    p_final_x_bp: null,
    p_final_2_bp: null,
    reliability: derived.reliability,
    reliability_band: "low",
    reliability_reasons: derived.reliabilityReasons,
    primary_pick: null,
    suggested_double: null,
    double_priority_rank: null,
    double_gain_score: null,
    blend_weight: null,
    deviation_cap_applied: false,
  };
}

function materializeCarriedFixture(
  input: Extract<MaterializableFixture, { mode: "carried_forward" }>,
): MaterializedAnalysis {
  if (
    input.source.analysisId !== input.carriedFromAnalysisId ||
    input.source.analysis.fixture_id !== input.fixtureId
  ) {
    throw new Error(
      `Carry-forward source does not match fixture ${input.fixtureId}.`,
    );
  }

  return {
    ...input.source.analysis,
    round_game_id: input.roundGameId,
    fixture_id: input.fixtureId,
    outcome: "carried_forward",
    carried_from_analysis_id: input.carriedFromAnalysisId,
    research_cutoff_at: input.researchCutoffAt,
    kickoff_at_snapshot: input.context.kickoffAt,
    settlement_rule_snapshot: input.context.settlementRule,
    neutral_venue_snapshot: input.context.neutralVenue,
    double_priority_rank: null,
    evidence: [],
    factors: [],
    inputs: [
      {
        input_type: "carried_forward",
        input_version: "kapiloto-run-plan-v1",
        metadata: {
          source_analysis_id: input.carriedFromAnalysisId,
          reason: input.reason,
        },
      },
    ],
  };
}

function materializeUnavailableFixture(
  input: Extract<MaterializableFixture, { mode: "research_unavailable" }>,
): MaterializedAnalysis {
  return {
    round_game_id: input.roundGameId,
    fixture_id: input.fixtureId,
    outcome: "research_unavailable",
    carried_from_analysis_id: null,
    research_cutoff_at: input.researchCutoffAt,
    kickoff_at_snapshot: input.context.kickoffAt,
    settlement_rule_snapshot: input.context.settlementRule,
    neutral_venue_snapshot: input.context.neutralVenue,
    orientation_verified: true,
    prior_type: null,
    market_snapshot_id: null,
    p_prior_1_bp: null,
    p_prior_x_bp: null,
    p_prior_2_bp: null,
    p_sol_1_bp: null,
    p_sol_x_bp: null,
    p_sol_2_bp: null,
    p_final_1_bp: null,
    p_final_x_bp: null,
    p_final_2_bp: null,
    reliability: null,
    reliability_band: null,
    reliability_reasons: [`research_unavailable:${input.reason}`],
    model_self_confidence: null,
    primary_pick: null,
    suggested_double: null,
    double_priority_rank: null,
    double_gain_score: null,
    blend_weight: null,
    deviation_cap_applied: false,
    summary: null,
    main_risk: null,
    availability: [],
    dimension_coverage: [],
    conflicts: [],
    watch_items: [],
    key_assumptions: [],
    data_quality: {
      sparse_coverage: true,
      language_limited: false,
      notes: `research_unavailable:${input.reason}`,
    },
    suspicious_content: [],
    valid_until: null,
    generated_at: null,
    evidence: [],
    factors: [],
    inputs: [
      {
        input_type: "research_unavailable",
        input_version: "kapiloto-run-plan-v1",
        metadata: { reason: input.reason },
      },
    ],
  };
}

function doubleFrom(
  first: "1" | "X" | "2",
  second: "1" | "X" | "2",
): "1X" | "X2" | "12" {
  const set = new Set([first, second]);
  if (set.has("1") && set.has("X")) return "1X";
  if (set.has("X") && set.has("2")) return "X2";
  return "12";
}

function rankMaterializedAnalyses(
  analyses: MaterializedAnalysis[],
  gameNumberByFixture: Map<string, number>,
) {
  const candidates = analyses.flatMap((analysis) => {
    if (
      analysis.p_final_1_bp == null ||
      analysis.p_final_x_bp == null ||
      analysis.p_final_2_bp == null ||
      analysis.reliability == null
    ) {
      analysis.double_priority_rank = null;
      return [];
    }

    const probabilities = {
      "1": analysis.p_final_1_bp,
      X: analysis.p_final_x_bp,
      "2": analysis.p_final_2_bp,
    };

    const ordered = [...OUTCOME_ORDER].sort(
      (a, b) =>
        probabilities[b] - probabilities[a] ||
        OUTCOME_ORDER.indexOf(a) - OUTCOME_ORDER.indexOf(b),
    );
    const primary = ordered[0];
    const second = ordered[1];
    const singleCoverageBp = probabilities[primary];
    const secondCoverageBp = probabilities[second];
    const doubleGainScore =
      singleCoverageBp > 0
        ? Math.log(
            (singleCoverageBp + secondCoverageBp) / singleCoverageBp,
          )
        : 0;

    analysis.primary_pick = primary;
    analysis.suggested_double = doubleFrom(primary, second);
    analysis.double_gain_score =
      Math.round(doubleGainScore * 100_000_000) / 100_000_000;

    return [
      {
        analysis,
        gameNumber: gameNumberByFixture.get(analysis.fixture_id) ?? 99,
        singleCoverageBp,
        secondCoverageBp,
      },
    ];
  });

  candidates.sort((a, b) => {
    const ratioCrossA =
      a.secondCoverageBp * b.singleCoverageBp;
    const ratioCrossB =
      b.secondCoverageBp * a.singleCoverageBp;

    if (ratioCrossA !== ratioCrossB) return ratioCrossB - ratioCrossA;
    if (a.analysis.reliability !== b.analysis.reliability) {
      return (
        (a.analysis.reliability ?? 0) -
        (b.analysis.reliability ?? 0)
      );
    }
    return a.gameNumber - b.gameNumber;
  });

  candidates.forEach((candidate, index) => {
    candidate.analysis.double_priority_rank = index + 1;
  });

  return candidates;
}

export function materializeKapilotoResearchRun(
  fixtures: MaterializableFixture[],
): MaterializedRound {
  if (fixtures.length !== 16) {
    throw new Error(
      `Kapiloto run materialization requires exactly 16 fixtures; got ${fixtures.length}.`,
    );
  }

  const sorted = [...fixtures].sort((a, b) => a.gameNumber - b.gameNumber);
  const seenGames = new Set<number>();
  const seenFixtures = new Set<string>();

  const analyses = sorted.map((fixture, index) => {
    if (
      fixture.gameNumber !== index + 1 ||
      seenGames.has(fixture.gameNumber) ||
      seenFixtures.has(fixture.fixtureId)
    ) {
      throw new Error(
        "Kapiloto run materialization contains duplicate or invalid fixture identity.",
      );
    }

    seenGames.add(fixture.gameNumber);
    seenFixtures.add(fixture.fixtureId);

    if (fixture.mode === "research") {
      return materializeResearchFixture(fixture);
    }
    if (fixture.mode === "carried_forward") {
      return materializeCarriedFixture(fixture);
    }
    return materializeUnavailableFixture(fixture);
  });

  const gameNumberByFixture = new Map(
    sorted.map((fixture) => [fixture.fixtureId, fixture.gameNumber]),
  );
  const ranked = rankMaterializedAnalyses(analyses, gameNumberByFixture);

  return {
    analyses,
    synthesis: {
      analyzed_fixtures: analyses.filter(
        (item) => item.outcome === "analyzed",
      ).length,
      insufficient_data_fixtures: analyses.filter(
        (item) => item.outcome === "insufficient_data",
      ).length,
      carried_forward_fixtures: analyses.filter(
        (item) => item.outcome === "carried_forward",
      ).length,
      research_unavailable_fixtures: analyses.filter(
        (item) => item.outcome === "research_unavailable",
      ).length,
      double_ranking: ranked.map((item) => ({
        fixture_id: item.analysis.fixture_id,
        round_game_id: item.analysis.round_game_id,
        game_number: item.gameNumber,
        rank: item.analysis.double_priority_rank!,
        primary_pick: item.analysis.primary_pick!,
        suggested_double: item.analysis.suggested_double!,
        double_gain_score: item.analysis.double_gain_score!,
        reliability: item.analysis.reliability!,
      })),
    },
  };
}

export function materializeValidatedResearchRound(
  fixtures: ValidatedFixtureResearch[],
): MaterializedRound {
  return materializeKapilotoResearchRun(
    fixtures.map((fixture) => ({
      ...fixture,
      mode: "research" as const,
    })),
  );
}
