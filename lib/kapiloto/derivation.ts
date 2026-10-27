import type { KapilotoFixtureCard } from "./fixture-card";
import type { SolFixtureResearchOutput } from "./research-output";

export const KAPILOTO_RELIABILITY_FORMULA_VERSION =
  "kapiloto-reliability-shadow-v5" as const;
export const KAPILOTO_BLEND_POLICY_VERSION = "kapiloto-blend-shadow-v2" as const;

export type Outcome = "1" | "X" | "2";

export type GroundingSummary = {
  acceptedTrustTiers: number[];
  structuredTrustTiers?: number[];
  rejectedCount: number;
  /**
   * Research v3: a grounded regime change provably post-dates the frozen
   * structured form/xG for at least one team.
   */
  preRegimeStructuredInputs?: boolean;
};

export type DerivedAnalyzedFixture = {
  outcome: "analyzed";
  pPrior: Record<Outcome, number>;
  pSol: Record<Outcome, number>;
  pFinal: Record<Outcome, number>;
  reliability: number;
  reliabilityBand: "low" | "medium" | "high";
  reliabilityReasons: string[];
  blendWeight: number;
  deviationCapApplied: false;
  primaryPick: Outcome;
  suggestedDouble: "1X" | "X2" | "12";
  singleCoverageBp: number;
  secondCoverageBp: number;
  doubleGainScore: number;
};

export type DerivedInsufficientFixture = {
  outcome: "insufficient_data";
  reliability: number;
  reliabilityBand: "low";
  reliabilityReasons: string[];
};

export type DerivedFixture =
  | DerivedAnalyzedFixture
  | DerivedInsufficientFixture;

const OUTCOME_ORDER: Outcome[] = ["1", "X", "2"];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function probabilitiesFromCard(
  card: KapilotoFixtureCard,
): Record<Outcome, number> {
  return {
    "1": card.structured.prior.p_home_bp,
    X: card.structured.prior.p_draw_bp,
    "2": card.structured.prior.p_away_bp,
  };
}

function probabilitiesFromSol(
  output: SolFixtureResearchOutput,
): Record<Outcome, number> {
  return {
    "1": output.p_sol.home_bp,
    X: output.p_sol.draw_bp,
    "2": output.p_sol.away_bp,
  };
}

function normalizeBasisPoints(
  raw: Record<Outcome, number>,
): Record<Outcome, number> {
  const floors: Record<Outcome, number> = {
    "1": Math.floor(raw["1"]),
    X: Math.floor(raw.X),
    "2": Math.floor(raw["2"]),
  };
  let remainder = 10_000 - floors["1"] - floors.X - floors["2"];

  const rankedFractions = OUTCOME_ORDER.map((outcome) => ({
    outcome,
    fraction: raw[outcome] - floors[outcome],
  })).sort(
    (a, b) =>
      b.fraction - a.fraction ||
      OUTCOME_ORDER.indexOf(a.outcome) - OUTCOME_ORDER.indexOf(b.outcome),
  );

  for (let index = 0; remainder > 0; index += 1) {
    floors[rankedFractions[index % rankedFractions.length].outcome] += 1;
    remainder -= 1;
  }

  return floors;
}

function sortedOutcomes(probabilities: Record<Outcome, number>): Outcome[] {
  return [...OUTCOME_ORDER].sort(
    (a, b) =>
      probabilities[b] - probabilities[a] ||
      OUTCOME_ORDER.indexOf(a) - OUTCOME_ORDER.indexOf(b),
  );
}

function doubleFrom(top: Outcome, second: Outcome): "1X" | "X2" | "12" {
  const set = new Set<Outcome>([top, second]);
  if (set.has("1") && set.has("X")) return "1X";
  if (set.has("X") && set.has("2")) return "X2";
  return "12";
}

function priorDivergenceBp(
  prior: Record<Outcome, number>,
  sol: Record<Outcome, number>,
): number {
  return Math.max(
    ...OUTCOME_ORDER.map((outcome) => Math.abs(prior[outcome] - sol[outcome])),
  );
}

export function deriveReliability(
  output: SolFixtureResearchOutput,
  card: KapilotoFixtureCard,
  grounding: GroundingSummary,
): {
  reliability: number;
  band: "low" | "medium" | "high";
  reasons: string[];
} {
  const reasons: string[] = [];
  const coveredDimensions = output.dimension_coverage.filter(
    (item) => item.status !== "insufficient_data",
  ).length;
  const coverageRatio = coveredDimensions / 10;

  let score = 0.35 + coverageRatio * 0.3;

  if (card.structured.prior.type === "league_base") {
    score -= 0.05;
    reasons.push("uninformative_league_base_prior");
  }

  if (coverageRatio >= 0.8) {
    reasons.push("broad_dimension_coverage");
  } else if (coverageRatio < 0.5) {
    reasons.push("limited_dimension_coverage");
  }

  const verifiedTrustTiers = [
    ...grounding.acceptedTrustTiers,
    ...(grounding.structuredTrustTiers ?? []),
  ];
  if (verifiedTrustTiers.length > 0) {
    const averageTier =
      verifiedTrustTiers.reduce((sum, tier) => sum + tier, 0) /
      verifiedTrustTiers.length;
    const sourceQuality = clamp((4 - averageTier) / 3, 0, 1);
    score += sourceQuality * 0.18;

    if ((grounding.structuredTrustTiers?.length ?? 0) > 0) {
      reasons.push("verified_structured_evidence");
    }
    if (averageTier <= 2) reasons.push("strong_verified_sources");
    if (averageTier >= 3.5) reasons.push("mostly_low_tier_sources");
  } else {
    score -= 0.12;
    reasons.push("no_verified_evidence");
  }

  if (grounding.preRegimeStructuredInputs) {
    score -= 0.05;
    reasons.push("structured_inputs_pre_regime");
  }

  if (grounding.rejectedCount > 0) {
    score -= Math.min(0.12, grounding.rejectedCount * 0.025);
    reasons.push("grounding_rejections");
  }

  const unresolvedConflicts = output.conflicts.filter(
    (conflict) => conflict.resolution === "unresolved",
  ).length;
  if (unresolvedConflicts > 0) {
    score -= Math.min(0.18, unresolvedConflicts * 0.08);
    reasons.push("unresolved_conflicts");
  }

  if (output.data_quality.sparse_coverage) {
    score -= 0.15;
    reasons.push("sparse_coverage");
  }
  if (output.data_quality.language_limited) {
    score -= 0.08;
    reasons.push("language_limited");
  }

  const prior = probabilitiesFromCard(card);
  const sol = probabilitiesFromSol(output);

  // Divergence is informative only when the prior itself carries information.
  // A league_base fallback is deliberately uninformative (near-uniform), so
  // penalizing Sol for moving away from it would double-penalize missing market
  // data and suppress well-grounded signals.
  if (card.structured.prior.type !== "league_base") {
    const divergence = priorDivergenceBp(prior, sol);
    if (divergence >= 2_000) {
      score -= 0.12;
      reasons.push("large_prior_divergence");
    } else if (divergence >= 1_200) {
      score -= 0.06;
      reasons.push("moderate_prior_divergence");
    }
  }

  // Shadow-v1 deliberately avoids extreme trust before forward calibration.
  const reliability = round4(clamp(score, 0.2, 0.85));
  const band =
    reliability < 0.45 ? "low" : reliability < 0.7 ? "medium" : "high";

  if (reasons.length === 0) reasons.push("baseline_shadow_formula");

  return { reliability, band, reasons };
}

export function deriveFixtureAnalysis(
  output: SolFixtureResearchOutput,
  card: KapilotoFixtureCard,
  grounding: GroundingSummary,
): DerivedFixture {
  const reliability = deriveReliability(output, card, grounding);

  if (output.outcome === "insufficient_data") {
    return {
      outcome: "insufficient_data",
      reliability: reliability.reliability,
      reliabilityBand: "low",
      reliabilityReasons: [
        ...reliability.reasons,
        "sol_reported_insufficient_data",
      ],
    };
  }

  const pPrior = probabilitiesFromCard(card);
  const pSol = probabilitiesFromSol(output);
  const blendWeight = reliability.reliability;

  const pFinal = normalizeBasisPoints({
    "1": pPrior["1"] * (1 - blendWeight) + pSol["1"] * blendWeight,
    X: pPrior.X * (1 - blendWeight) + pSol.X * blendWeight,
    "2": pPrior["2"] * (1 - blendWeight) + pSol["2"] * blendWeight,
  });

  const ordered = sortedOutcomes(pFinal);
  const primaryPick = ordered[0];
  const second = ordered[1];
  const singleCoverageBp = pFinal[primaryPick];
  const secondCoverageBp = pFinal[second];
  const doubleGainScore =
    singleCoverageBp > 0
      ? Math.log((singleCoverageBp + secondCoverageBp) / singleCoverageBp)
      : 0;

  return {
    outcome: "analyzed",
    pPrior,
    pSol,
    pFinal,
    reliability: reliability.reliability,
    reliabilityBand: reliability.band,
    reliabilityReasons: reliability.reasons,
    blendWeight,
    deviationCapApplied: false,
    primaryPick,
    suggestedDouble: doubleFrom(primaryPick, second),
    singleCoverageBp,
    secondCoverageBp,
    doubleGainScore,
  };
}

export type DoubleRankCandidate = {
  gameNumber: number;
  roundGameId: string;
  fixtureId: string;
  derived: DerivedAnalyzedFixture;
};

export function rankDoubleCandidates(
  candidates: DoubleRankCandidate[],
): Array<DoubleRankCandidate & { doublePriorityRank: number }> {
  return [...candidates]
    .sort((a, b) => {
      // Compare second/top ratios without floating-point division.
      const ratioCrossA =
        a.derived.secondCoverageBp * b.derived.singleCoverageBp;
      const ratioCrossB =
        b.derived.secondCoverageBp * a.derived.singleCoverageBp;

      if (ratioCrossA !== ratioCrossB) return ratioCrossB - ratioCrossA;
      if (a.derived.reliability !== b.derived.reliability) {
        return a.derived.reliability - b.derived.reliability;
      }
      return a.gameNumber - b.gameNumber;
    })
    .map((candidate, index) => ({
      ...candidate,
      doublePriorityRank: index + 1,
    }));
}
