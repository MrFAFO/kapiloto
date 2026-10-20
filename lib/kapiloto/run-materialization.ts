import type { KapilotoFixtureCard } from "./fixture-card";
import {
  deriveFixtureAnalysis,
  rankDoubleCandidates,
  type DerivedAnalyzedFixture,
} from "./derivation";
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
  entailment: "not_checked";
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
  outcome: "analyzed" | "insufficient_data";
  carried_from_analysis_id: null;
  research_cutoff_at: string;
  kickoff_at_snapshot: string;
  settlement_rule_snapshot: string;
  neutral_venue_snapshot: boolean;
  orientation_verified: boolean;
  prior_type: "market" | "rating" | "league_base";
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
  reliability: number;
  reliability_band: "low" | "medium" | "high";
  reliability_reasons: string[];
  model_self_confidence: "low" | "medium" | "high";
  primary_pick: "1" | "X" | "2" | null;
  suggested_double: "1X" | "X2" | "12" | null;
  double_priority_rank: number | null;
  double_gain_score: number | null;
  blend_weight: number | null;
  deviation_cap_applied: boolean;
  summary: string;
  main_risk: string;
  availability: SolFixtureResearchOutput["availability"];
  dimension_coverage: SolFixtureResearchOutput["dimension_coverage"];
  conflicts: SolFixtureResearchOutput["conflicts"];
  watch_items: SolFixtureResearchOutput["watch_items"];
  key_assumptions: string[];
  data_quality: SolFixtureResearchOutput["data_quality"];
  suspicious_content: SolFixtureResearchOutput["suspicious_content_observed"];
  valid_until: null;
  evidence: MaterializedEvidence[];
  factors: MaterializedFactor[];
  inputs: Array<{
    input_type: string;
    input_version: string | null;
    metadata: Record<string, unknown>;
  }>;
};

export type MaterializedRound = {
  analyses: MaterializedAnalysis[];
  synthesis: {
    analyzed_fixtures: number;
    insufficient_data_fixtures: number;
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

function assertFixtureIdentity(input: ValidatedFixtureResearch): void {
  if (
    input.card.fixture_id !== input.fixtureId ||
    input.card.fixture_key !== input.fixtureId ||
    input.card.round_game_id !== input.roundGameId ||
    input.card.toto_number !== input.gameNumber
  ) {
    throw new Error("Validated research does not match its frozen fixture identity.");
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
  rank: number,
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
    double_priority_rank: rank,
    double_gain_score: Math.round(derived.doubleGainScore * 100_000_000) / 100_000_000,
    blend_weight: derived.blendWeight,
    deviation_cap_applied: derived.deviationCapApplied,
  };
}

export function materializeValidatedResearchRound(
  fixtures: ValidatedFixtureResearch[],
): MaterializedRound {
  if (fixtures.length !== 16) {
    throw new Error(
      `Validated Kapiloto round requires exactly 16 fixtures; got ${fixtures.length}.`,
    );
  }

  const sorted = [...fixtures].sort((a, b) => a.gameNumber - b.gameNumber);
  const seenGames = new Set<number>();
  const seenFixtures = new Set<string>();

  const derived = sorted.map((fixture) => {
    assertFixtureIdentity(fixture);

    if (
      seenGames.has(fixture.gameNumber) ||
      seenFixtures.has(fixture.fixtureId)
    ) {
      throw new Error("Validated Kapiloto round contains duplicate fixture identity.");
    }
    seenGames.add(fixture.gameNumber);
    seenFixtures.add(fixture.fixtureId);

    if (fixture.output.outcome === "analyzed" && fixture.grounding.accepted.length === 0) {
      throw new Error(
        `Analyzed fixture ${fixture.fixtureId} has no accepted grounded evidence.`,
      );
    }

    if (fixture.grounding.requiresEntailmentVerification.length > 0) {
      throw new Error(
        `Fixture ${fixture.fixtureId} still requires material-factor entailment verification.`,
      );
    }

    return {
      fixture,
      result: deriveFixtureAnalysis(
        fixture.output,
        fixture.card,
        groundingSummary(fixture.grounding),
      ),
    };
  });

  const ranked = rankDoubleCandidates(
    derived
      .filter(
        (
          item,
        ): item is typeof item & { result: DerivedAnalyzedFixture } =>
          item.result.outcome === "analyzed",
      )
      .map((item) => ({
        gameNumber: item.fixture.gameNumber,
        roundGameId: item.fixture.roundGameId,
        fixtureId: item.fixture.fixtureId,
        derived: item.result,
      })),
  );

  const rankByFixture = new Map(
    ranked.map((item) => [item.fixtureId, item.doublePriorityRank]),
  );

  const analyses: MaterializedAnalysis[] = derived.map(({ fixture, result }) => {
    if (result.outcome === "analyzed") {
      const rank = rankByFixture.get(fixture.fixtureId);
      if (rank == null) {
        throw new Error("Analyzed fixture is missing deterministic double rank.");
      }
      return analyzedPayload(fixture, result, rank);
    }

    return {
      ...baseMaterialization(fixture),
      outcome: "insufficient_data",
      p_prior_1_bp: fixture.card.structured.prior.p_home_bp,
      p_prior_x_bp: fixture.card.structured.prior.p_draw_bp,
      p_prior_2_bp: fixture.card.structured.prior.p_away_bp,
      p_sol_1_bp: null,
      p_sol_x_bp: null,
      p_sol_2_bp: null,
      p_final_1_bp: null,
      p_final_x_bp: null,
      p_final_2_bp: null,
      reliability: result.reliability,
      reliability_band: "low",
      reliability_reasons: result.reliabilityReasons,
      primary_pick: null,
      suggested_double: null,
      double_priority_rank: null,
      double_gain_score: null,
      blend_weight: null,
      deviation_cap_applied: false,
    };
  });

  return {
    analyses,
    synthesis: {
      analyzed_fixtures: analyses.filter((item) => item.outcome === "analyzed").length,
      insufficient_data_fixtures: analyses.filter(
        (item) => item.outcome === "insufficient_data",
      ).length,
      double_ranking: ranked.map((item) => ({
        fixture_id: item.fixtureId,
        round_game_id: item.roundGameId,
        game_number: item.gameNumber,
        rank: item.doublePriorityRank,
        primary_pick: item.derived.primaryPick,
        suggested_double: item.derived.suggestedDouble,
        double_gain_score:
          Math.round(item.derived.doubleGainScore * 100_000_000) / 100_000_000,
        reliability: item.derived.reliability,
      })),
    },
  };
}
