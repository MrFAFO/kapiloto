import type { CombinationResult } from "./combination";
import { outcomeProbability, rankedOutcomes, type Outcome, type ThreeWayProbabilities } from "./probability";
import { configProvenance, type ConfigProvenance, type VersionedConfig } from "./provenance";

export type RecommendationState = "pick" | "double" | "no_signal" | "insufficient_data";

export type RecommendationPolicyConfig = VersionedConfig & {
  /**
   * Combination candidates tried in order; the first available one is used.
   * Which candidate leads is itself a candidate choice, not an approved one.
   */
  candidateChain: string[];
  /** Below this top-two margin (basis points) a fixture has no signal. */
  noSignalMarginBp: number;
};

/** Candidate values only; the threshold is not tuned on any outcome. */
export const CANDIDATE_RECOMMENDATION_POLICY: RecommendationPolicyConfig = {
  id: "research-v2-recommendation",
  version: "recommendation-v1",
  status: "candidate",
  candidateChain: ["log_market65_elo", "market_only", "stat_elo_only"],
  noSignalMarginBp: 300,
};

export type FixtureRecommendation = {
  fixtureId: string;
  gameNumber: number;
  state: Exclude<RecommendationState, "double">;
  candidateId: string | null;
  probabilities: ThreeWayProbabilities | null;
  topOutcome: Outcome | null;
  secondOutcome: Outcome | null;
  marginBp: number | null;
  /** Probability the second outcome adds when the fixture is doubled. */
  doubleGain: number | null;
};

export function recommendFixture(
  input: { fixtureId: string; gameNumber: number; candidates: readonly CombinationResult[] },
  policy: RecommendationPolicyConfig,
): FixtureRecommendation {
  const byId = new Map(input.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const chosen = policy.candidateChain
    .map((id) => byId.get(id))
    .find((candidate): candidate is Extract<CombinationResult, { status: "available" }> => candidate?.status === "available");
  if (!chosen) {
    return {
      fixtureId: input.fixtureId,
      gameNumber: input.gameNumber,
      state: "insufficient_data",
      candidateId: null,
      probabilities: null,
      topOutcome: null,
      secondOutcome: null,
      marginBp: null,
      doubleGain: null,
    };
  }
  const [top, second] = rankedOutcomes(chosen.probabilities);
  const marginBp = Math.round(
    10_000 * (outcomeProbability(chosen.probabilities, top) - outcomeProbability(chosen.probabilities, second)),
  );
  return {
    fixtureId: input.fixtureId,
    gameNumber: input.gameNumber,
    state: marginBp < policy.noSignalMarginBp ? "no_signal" : "pick",
    candidateId: chosen.candidateId,
    probabilities: chosen.probabilities,
    topOutcome: top,
    secondOutcome: second,
    marginBp,
    doubleGain: outcomeProbability(chosen.probabilities, second),
  };
}

export type TicketRecommendation = {
  fixtures: Array<FixtureRecommendation & { finalState: RecommendationState; doubleRank: number | null }>;
  policy: ConfigProvenance;
};

/**
 * Ticket-level doubles: among fixtures with a usable forecast, double the
 * ones whose second outcome adds the most probability, up to maxDoubles.
 * Ties break by smaller margin, then Toto game number.
 */
export function allocateDoubles(
  fixtures: readonly FixtureRecommendation[],
  maxDoubles: number,
  policy: RecommendationPolicyConfig,
): TicketRecommendation {
  if (!Number.isInteger(maxDoubles) || maxDoubles < 0) throw new Error("maxDoubles must be a non-negative integer.");
  const ranked = fixtures
    .filter((fixture) => fixture.state !== "insufficient_data" && fixture.doubleGain != null)
    .sort(
      (a, b) =>
        (b.doubleGain as number) - (a.doubleGain as number) ||
        (a.marginBp as number) - (b.marginBp as number) ||
        a.gameNumber - b.gameNumber,
    );
  const rankById = new Map(ranked.map((fixture, index) => [fixture.fixtureId, index + 1]));
  return {
    fixtures: [...fixtures]
      .sort((a, b) => a.gameNumber - b.gameNumber)
      .map((fixture) => {
        const rank = rankById.get(fixture.fixtureId) ?? null;
        const doubled = rank != null && rank <= maxDoubles;
        return { ...fixture, finalState: doubled ? "double" : fixture.state, doubleRank: rank };
      }),
    policy: configProvenance(policy),
  };
}
