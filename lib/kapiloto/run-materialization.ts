import type {
  EntailmentJudgeCall,
  UnsupportedEntailment,
} from "./entailment-verifier";
import type { KapilotoFixtureCard } from "./fixture-card";
import {
  applyGroundingPolicy,
  KAPILOTO_GROUNDING_POLICY_VERSION,
  type GroundingPolicyDecision,
} from "./grounding-policy";
import {
  deriveFixtureAnalysis,
  type DerivedAnalyzedFixture,
  type GroundingSummary,
} from "./derivation";
import type {
  FrozenFixtureContext,
  ResearchIneligibilityReason,
} from "./research-run-plan";
import type { SolFixtureResearchOutput } from "./research-output";
import {
  canonicalClaimTypeForDimension,
  itemTrustTier,
} from "./research-v3-rules";
import type { GroundingResult } from "./source-grounding";
import {
  structuredRefTrustTier,
  type KapilotoStructuredRef,
} from "./structured-refs";

export type ValidatedFixtureResearch = {
  gameNumber: number;
  roundGameId: string;
  fixtureId: string;
  card: KapilotoFixtureCard;
  output: SolFixtureResearchOutput;
  grounding: GroundingResult;
  /** Audit detail when entailment rejected material evidence. */
  entailment?: {
    unsupported: UnsupportedEntailment[];
    calls: EntailmentJudgeCall[];
  };
};

export const ENTAILMENT_DOWNGRADE_REASON = "material_entailment_unsupported";

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
  status: "accepted" | "rejected";
  rejected_reason: string | null;
};

export type MaterializedFactor = {
  dimension: string;
  favors: "home" | "draw" | "away" | "none";
  magnitude: "small" | "medium" | "large";
  rationale: string;
  evidence_model_ids: string[];
  structured_refs: string[];
  /** Research v3 only; absent for v1/v2 factors (persisted as []). */
  matchup_ids?: string[];
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
  expected_lineups: SolFixtureResearchOutput["expected_lineups"] | null;
  tactical_facts: SolFixtureResearchOutput["tactical_facts"] | null;
  matchup_analysis: SolFixtureResearchOutput["matchup_analysis"] | null;
  regime_changes: SolFixtureResearchOutput["regime_changes"] | null;
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

function acceptedEvidenceIds(grounding: GroundingResult): Set<string> {
  return new Set(
    grounding.accepted
      .filter((item) => item.entailment !== "unsupported")
      .map((item) => item.modelEvidenceId),
  );
}

function onlyAcceptedReferences(
  ids: string[],
  acceptedIds: Set<string>,
): string[] {
  return ids.filter((id) => acceptedIds.has(id));
}

function acceptedEvidence(
  grounding: GroundingResult,
): MaterializedEvidence[] {
  return grounding.accepted.map((item) => {
    const unsupported = item.entailment === "unsupported";
    return {
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
      status: unsupported ? ("rejected" as const) : ("accepted" as const),
      rejected_reason: unsupported ? "entailment_unsupported" : null,
    };
  });
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
  const acceptedIds = acceptedEvidenceIds(grounding);

  const availability = output.availability
    .map((item) => ({
      ...item,
      evidence_ids: onlyAcceptedReferences(item.evidence_ids, acceptedIds),
    }))
    .filter((item) => item.evidence_ids.length > 0);

  const factors = output.factors
    .map((factor) => ({
      dimension: factor.dimension,
      favors: factor.favors,
      magnitude: factor.magnitude,
      rationale: factor.rationale,
      evidence_model_ids: onlyAcceptedReferences(
        factor.evidence_ids,
        acceptedIds,
      ),
      structured_refs: [...(factor.structured_refs ?? [])].sort(),
      ...(output.protocol_version === "kapiloto-research-v3"
        ? { matchup_ids: [...(factor.matchup_ids ?? [])].sort() }
        : {}),
    }))
    .filter(
      (factor) =>
        factor.evidence_model_ids.length > 0 ||
        factor.structured_refs.length > 0,
    );

  const conflicts = output.conflicts
    .map((conflict) => ({
      ...conflict,
      evidence_ids_a: onlyAcceptedReferences(
        conflict.evidence_ids_a,
        acceptedIds,
      ),
      evidence_ids_b: onlyAcceptedReferences(
        conflict.evidence_ids_b,
        acceptedIds,
      ),
    }))
    .filter(
      (conflict) =>
        conflict.evidence_ids_a.length > 0 &&
        conflict.evidence_ids_b.length > 0,
    );

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
    availability,
    expected_lineups:
      output.protocol_version === "kapiloto-research-v3"
        ? output.expected_lineups ?? null
        : null,
    tactical_facts:
      output.protocol_version === "kapiloto-research-v3"
        ? output.tactical_facts ?? []
        : null,
    matchup_analysis:
      output.protocol_version === "kapiloto-research-v3"
        ? output.matchup_analysis ?? []
        : null,
    regime_changes:
      output.protocol_version === "kapiloto-research-v3"
        ? output.regime_changes ?? []
        : null,
    dimension_coverage: output.dimension_coverage,
    conflicts,
    watch_items: output.watch_items,
    key_assumptions: output.key_assumptions,
    data_quality: output.data_quality,
    suspicious_content: output.suspicious_content_observed,
    valid_until: null,
    generated_at: null,
    evidence: acceptedEvidence(grounding),
    factors,
    inputs: [
      {
        input_type: "fixture_card",
        input_version: card.fixture_card_version,
        metadata: {
          fixture_id: card.fixture_id,
          market_snapshot_id: card.structured.prior.snapshot_id,
          structured_snapshot_id:
            card.structured.structured_snapshot?.id ?? null,
          structured_snapshot_sha256:
            card.structured.structured_snapshot?.sha256 ?? null,
          structured_feature_version:
            card.structured.structured_snapshot?.feature_version ?? null,
        },
      },
      ...(factors.some((factor) => factor.structured_refs.length > 0)
        ? [
            {
              input_type: "structured_factor_refs",
              input_version: "kapiloto-structured-refs-v1",
              metadata: {
                factors: factors
                  .filter((factor) => factor.structured_refs.length > 0)
                  .map((factor) => ({
                    dimension: factor.dimension,
                    favors: factor.favors,
                    magnitude: factor.magnitude,
                    structured_refs: factor.structured_refs,
                  })),
              },
            },
          ]
        : []),
      {
        input_type: "grounding_report",
        input_version: "kapiloto-grounding-v1",
        metadata: {
          accepted_count: grounding.accepted.length,
          rejected: grounding.rejected,
          requires_entailment_verification:
            grounding.requiresEntailmentVerification,
          ...(output.protocol_version === "kapiloto-research-v3"
            ? {
                item_entailment_verdicts: grounding.itemEntailmentVerdicts ?? {},
                item_evidence_exclusions: grounding.itemEvidenceExclusions ?? {},
              }
            : {}),
        },
      },
    ],
  };
}

function groundingSummary(
  grounding: GroundingResult,
  output: SolFixtureResearchOutput,
  card: KapilotoFixtureCard,
  rawOutput: SolFixtureResearchOutput = output,
  decision: GroundingPolicyDecision | null = null,
): GroundingSummary {
  const structuredRefs = new Set<KapilotoStructuredRef>();
  for (const factor of output.factors) {
    for (const ref of factor.structured_refs ?? []) {
      structuredRefs.add(ref as KapilotoStructuredRef);
    }
  }
  const structuredTrustTiers = [...structuredRefs]
    .map((ref) => structuredRefTrustTier(ref, card))
    .filter((tier): tier is 1 | 3 => tier != null);

  if (output.protocol_version !== "kapiloto-research-v3") {
    // Legacy reliability scope (reliability-shadow-v4 and earlier) for
    // replayed v1/v2 research.
    const usable = grounding.accepted.filter(
      (item) => item.entailment !== "unsupported",
    );
    return {
      acceptedTrustTiers: usable.map((item) => item.trustTier),
      structuredTrustTiers,
      rejectedCount:
        grounding.rejected.length +
        grounding.accepted.filter((item) => item.entailment === "unsupported")
          .length,
    };
  }

  // Research v3 (reliability-shadow-v5): only evidence that supports a
  // surviving probability-moving factor counts, rated by that factor's
  // canonical claim class. Descriptive lineup/fact/regime rows neither raise
  // nor lower reliability merely by existing.
  const accepted = new Map(
    grounding.accepted.map((item) => [item.modelEvidenceId, item]),
  );
  const tierById = new Map<string, number>();
  for (const factor of output.factors) {
    const canonical = canonicalClaimTypeForDimension(factor.dimension);
    for (const id of factor.evidence_ids) {
      const evidence = accepted.get(id);
      if (!evidence || evidence.entailment === "unsupported") continue;
      const tier = itemTrustTier(evidence, canonical);
      tierById.set(id, Math.max(tierById.get(id) ?? 0, tier));
    }
  }
  const proposedFactorEvidence = new Set(
    rawOutput.factors.flatMap((factor) => factor.evidence_ids),
  );

  return {
    acceptedTrustTiers: [...tierById.values()],
    structuredTrustTiers,
    rejectedCount:
      grounding.rejected.filter((item) =>
        proposedFactorEvidence.has(item.evidenceId),
      ).length +
      grounding.accepted.filter(
        (item) =>
          proposedFactorEvidence.has(item.modelEvidenceId) &&
          item.entailment === "unsupported",
      ).length,
    preRegimeStructuredInputs:
      (decision?.preRegimeStructuredTeams?.length ?? 0) > 0,
  };
}

function policyAuditInput(decision: GroundingPolicyDecision) {
  return {
    input_type: "grounding_policy",
    input_version: decision.policyVersion ?? KAPILOTO_GROUNDING_POLICY_VERSION,
    metadata: {
      mode: decision.mode,
      p_sol_valid: decision.pSolValid,
      removed_items: decision.removedItems,
      removed_directional_dimensions:
        decision.removedDirectionalDimensions,
      non_directional_removal_count: decision.nonDirectionalRemovalCount,
      reasons: decision.reasons,
    },
  };
}

function marketOnlyPayload(
  input: ValidatedFixtureResearch,
  decision: GroundingPolicyDecision,
): MaterializedAnalysis {
  const effective = { ...input, output: decision.output };
  const base = baseMaterialization(effective);
  const prior = input.card.structured.prior;
  const ordered = [
    { pick: "1" as const, bp: prior.p_home_bp },
    { pick: "X" as const, bp: prior.p_draw_bp },
    { pick: "2" as const, bp: prior.p_away_bp },
  ].sort(
    (a, b) =>
      b.bp - a.bp ||
      OUTCOME_ORDER.indexOf(a.pick) - OUTCOME_ORDER.indexOf(b.pick),
  );

  return {
    ...base,
    outcome: "analyzed",
    p_prior_1_bp: prior.p_home_bp,
    p_prior_x_bp: prior.p_draw_bp,
    p_prior_2_bp: prior.p_away_bp,
    p_sol_1_bp: null,
    p_sol_x_bp: null,
    p_sol_2_bp: null,
    p_final_1_bp: prior.p_home_bp,
    p_final_x_bp: prior.p_draw_bp,
    p_final_2_bp: prior.p_away_bp,
    reliability: 0.2,
    reliability_band: "low",
    reliability_reasons: decision.reasons,
    model_self_confidence: null,
    primary_pick: ordered[0].pick,
    suggested_double: null,
    double_priority_rank: null,
    double_gain_score: null,
    blend_weight: 0,
    deviation_cap_applied: false,
    summary:
      "Kapiloto found no verified reason to move away from the market baseline.",
    main_risk:
      "The research probability was withheld because a directional signal failed evidence policy.",
    factors: base.factors.filter((factor) => factor.favors === "none"),
    matchup_analysis:
      base.matchup_analysis?.filter((matchup) => matchup.favors === "none") ??
      null,
    inputs: [...base.inputs, policyAuditInput(decision)],
  };
}

function insufficientPolicyPayload(
  input: ValidatedFixtureResearch,
  decision: GroundingPolicyDecision,
): MaterializedAnalysis {
  const effective = { ...input, output: decision.output };
  const base = baseMaterialization(effective);
  return {
    ...base,
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
    reliability: 0.2,
    reliability_band: "low",
    reliability_reasons: decision.reasons,
    model_self_confidence: null,
    primary_pick: null,
    suggested_double: null,
    double_priority_rank: null,
    double_gain_score: null,
    blend_weight: null,
    deviation_cap_applied: false,
    summary:
      decision.output.outcome === "insufficient_data"
        ? decision.output.summary
        : "No Kapiloto pick was published because no grounded directional signal remained.",
    main_risk: decision.output.main_risk,
    factors: base.factors.filter((factor) => factor.favors === "none"),
    matchup_analysis:
      base.matchup_analysis?.filter((matchup) => matchup.favors === "none") ??
      null,
    inputs: [...base.inputs, policyAuditInput(decision)],
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

/**
 * Fail-closed fixture-level fallback when entailment rejected material
 * evidence. The fixture keeps its identity and frozen prior/context, but
 * publishes no Sol estimate, pick, double, factor or model narrative. The
 * rejected evidence is persisted with status `rejected` for audit and can
 * never count as accepted support.
 */
function materializeEntailmentDowngrade(
  input: ValidatedFixtureResearch,
): MaterializedAnalysis {
  const { card, output, grounding } = input;
  const unsupportedIds = grounding.accepted
    .filter((item) => item.entailment === "unsupported")
    .map((item) => item.modelEvidenceId)
    .sort();

  return {
    round_game_id: input.roundGameId,
    fixture_id: input.fixtureId,
    outcome: "insufficient_data",
    carried_from_analysis_id: null,
    research_cutoff_at: card.research_cutoff_at,
    kickoff_at_snapshot: card.kickoff_at,
    settlement_rule_snapshot: card.settlement,
    neutral_venue_snapshot: card.neutral_venue,
    orientation_verified: true,
    prior_type: card.structured.prior.type,
    market_snapshot_id: card.structured.prior.snapshot_id,
    p_prior_1_bp: card.structured.prior.p_home_bp,
    p_prior_x_bp: card.structured.prior.p_draw_bp,
    p_prior_2_bp: card.structured.prior.p_away_bp,
    p_sol_1_bp: null,
    p_sol_x_bp: null,
    p_sol_2_bp: null,
    p_final_1_bp: null,
    p_final_x_bp: null,
    p_final_2_bp: null,
    reliability: null,
    reliability_band: "low",
    reliability_reasons: [
      ENTAILMENT_DOWNGRADE_REASON,
      ...unsupportedIds.map((id) => `entailment_unsupported:${id}`),
    ],
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
    expected_lineups: null,
    tactical_facts: null,
    matchup_analysis: null,
    regime_changes: null,
    dimension_coverage: [],
    conflicts: [],
    watch_items: [],
    key_assumptions: [],
    data_quality: {
      sparse_coverage: output.data_quality.sparse_coverage,
      language_limited: output.data_quality.language_limited,
      notes: `${ENTAILMENT_DOWNGRADE_REASON}: ${unsupportedIds.length} material claim(s) failed entailment verification; fixture withheld.`,
    },
    suspicious_content: output.suspicious_content_observed,
    valid_until: null,
    generated_at: null,
    evidence: grounding.accepted.map((item) => {
      const rejected = item.entailment === "unsupported";
      return {
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
        status: rejected ? ("rejected" as const) : ("accepted" as const),
        rejected_reason: rejected ? "entailment_unsupported" : null,
      };
    }),
    factors: [],
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
        },
      },
      {
        input_type: "entailment_downgrade",
        input_version: "kapiloto-entailment-downgrade-v1",
        metadata: {
          reason: ENTAILMENT_DOWNGRADE_REASON,
          unsupported_evidence_ids: unsupportedIds,
          unsupported: (input.entailment?.unsupported ?? []).map((item) => ({
            evidence_id: item.evidenceId,
            claim: item.claim,
            quote: item.quote,
            domain: item.domain,
            url: item.canonicalUrl,
          })),
          judge_calls: (input.entailment?.calls ?? []).map((call) => ({
            response_id: call.responseId,
            model: call.model,
            claims: call.claims,
          })),
          withheld: [
            "p_sol",
            "p_final",
            "primary_pick",
            "suggested_double",
            "double_priority_rank",
            "factors",
            "summary",
            "main_risk",
            "availability",
            "watch_items",
            "key_assumptions",
          ],
        },
      },
    ],
  };
}

function materializeResearchFixture(
  input: ValidatedFixtureResearch,
): MaterializedAnalysis {
  assertFixtureIdentity(input);

  if (input.grounding.requiresEntailmentVerification.length > 0) {
    throw new Error(
      `Fixture ${input.fixtureId} still requires material-factor entailment verification.`,
    );
  }

  const decision = applyGroundingPolicy(
    input.output,
    input.grounding,
    input.card,
  );

  if (decision.mode === "market_only") {
    return marketOnlyPayload(input, decision);
  }
  if (decision.mode === "insufficient_data") {
    return insufficientPolicyPayload(input, decision);
  }

  const effective = { ...input, output: decision.output };
  const hasStructuredSupport = effective.output.factors.some(
    (factor) => (factor.structured_refs?.length ?? 0) > 0,
  );
  if (
    effective.grounding.accepted.length === 0 &&
    !hasStructuredSupport
  ) {
    throw new Error(
      `Analyzed fixture ${input.fixtureId} has no accepted grounded evidence.`,
    );
  }

  const derived = deriveFixtureAnalysis(
    effective.output,
    effective.card,
    groundingSummary(
      effective.grounding,
      effective.output,
      effective.card,
      input.output,
      decision,
    ),
  );

  if (derived.outcome === "analyzed") {
    const analyzed = analyzedPayload(effective, derived);
    analyzed.inputs.push(policyAuditInput(decision));
    return analyzed;
  }

  return insufficientPolicyPayload(input, {
    ...decision,
    mode: "insufficient_data",
    pSolValid: false,
    reasons: [...decision.reasons, ...derived.reliabilityReasons],
  });
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
    expected_lineups: null,
    tactical_facts: null,
    matchup_analysis: null,
    regime_changes: null,
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
    expected_lineups: null,
    tactical_facts: null,
    matchup_analysis: null,
    regime_changes: null,
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
      analysis.reliability == null ||
      analysis.blend_weight === 0
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
