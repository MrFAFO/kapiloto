import {
  assertValidProbabilities,
  probabilityOf,
  topOutcomes,
  type Outcome,
  type ThreeWayProbabilities,
} from "./probabilities";

export const KAPILOTO_EVAL_SCORING_VERSION = "kapiloto-eval-scoring-v1";

/** Log loss clamps the realized-outcome probability to avoid infinite loss. */
export const LOG_LOSS_EPSILON = 1e-15;

function indicator(outcome: Outcome): ThreeWayProbabilities {
  return {
    home: outcome === "1" ? 1 : 0,
    draw: outcome === "X" ? 1 : 0,
    away: outcome === "2" ? 1 : 0,
  };
}

/** Multiclass Brier score: sum over 1/X/2 of (p - y)^2. Range [0, 2]. */
export function multiclassBrier(
  probabilities: ThreeWayProbabilities,
  outcome: Outcome,
): number {
  assertValidProbabilities(probabilities);
  const y = indicator(outcome);
  return (
    (probabilities.home - y.home) ** 2 +
    (probabilities.draw - y.draw) ** 2 +
    (probabilities.away - y.away) ** 2
  );
}

/**
 * Ranked Probability Score over the ordered categories 1 < X < 2:
 * RPS = 1/(r-1) * sum_{i=1}^{r-1} (sum_{j<=i} (p_j - y_j))^2 with r = 3.
 * Range [0, 1].
 */
export function rankedProbabilityScore(
  probabilities: ThreeWayProbabilities,
  outcome: Outcome,
): number {
  assertValidProbabilities(probabilities);
  const y = indicator(outcome);
  const first = probabilities.home - y.home;
  const second = probabilities.home + probabilities.draw - (y.home + y.draw);
  return (first ** 2 + second ** 2) / 2;
}

/** Natural-log loss of the realized outcome, clamped at LOG_LOSS_EPSILON. */
export function logLoss(
  probabilities: ThreeWayProbabilities,
  outcome: Outcome,
): number {
  assertValidProbabilities(probabilities);
  return -Math.log(Math.max(probabilityOf(probabilities, outcome), LOG_LOSS_EPSILON));
}

/**
 * Top-pick credit. A tie for the maximum splits one unit of credit across the
 * tied outcomes (the expected accuracy of a uniformly random tie-break), so a
 * uniform forecast scores exactly 1/3 regardless of the result.
 */
export function topPickScore(
  probabilities: ThreeWayProbabilities,
  outcome: Outcome,
): number {
  assertValidProbabilities(probabilities);
  const tops = topOutcomes(probabilities);
  return tops.includes(outcome) ? 1 / tops.length : 0;
}

export type FixtureScore = {
  brier: number;
  rps: number;
  logLoss: number;
  topPickScore: number;
  /** Deterministic display pick: first maximum in 1, X, 2 order. */
  topPick: Outcome;
};

export function scorePrediction(
  probabilities: ThreeWayProbabilities,
  outcome: Outcome,
): FixtureScore {
  return {
    brier: multiclassBrier(probabilities, outcome),
    rps: rankedProbabilityScore(probabilities, outcome),
    logLoss: logLoss(probabilities, outcome),
    topPickScore: topPickScore(probabilities, outcome),
    topPick: topOutcomes(probabilities)[0],
  };
}

/**
 * Per-fixture metric extractors. Aggregate statistics (means today; bootstrap
 * intervals and calibration bins later) consume these vectors rather than
 * re-deriving scores, so new summaries never change per-fixture values.
 */
export const SCORE_METRICS = {
  brier: (score: FixtureScore) => score.brier,
  rps: (score: FixtureScore) => score.rps,
  log_loss: (score: FixtureScore) => score.logLoss,
  top_pick_accuracy: (score: FixtureScore) => score.topPickScore,
} as const;

export type ScoreMetric = keyof typeof SCORE_METRICS;

export type ScoreSummary = {
  n: number;
  meanBrier: number;
  meanRps: number;
  meanLogLoss: number;
  topPickAccuracy: number;
};

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarizeScores(scores: FixtureScore[]): ScoreSummary | null {
  if (scores.length === 0) return null;
  return {
    n: scores.length,
    meanBrier: mean(scores.map(SCORE_METRICS.brier)),
    meanRps: mean(scores.map(SCORE_METRICS.rps)),
    meanLogLoss: mean(scores.map(SCORE_METRICS.log_loss)),
    topPickAccuracy: mean(scores.map(SCORE_METRICS.top_pick_accuracy)),
  };
}

/**
 * Paired per-fixture differences (a - b) on the fixtures both arms scored.
 * Negative values favour arm a for loss metrics. This is the input a future
 * round-clustered bootstrap will resample.
 */
export function pairedDifferences(
  a: ReadonlyMap<string, FixtureScore>,
  b: ReadonlyMap<string, FixtureScore>,
  metric: ScoreMetric,
): { fixtureIds: string[]; differences: number[] } {
  const extract = SCORE_METRICS[metric];
  const fixtureIds = [...a.keys()].filter((id) => b.has(id)).sort();
  return {
    fixtureIds,
    differences: fixtureIds.map(
      (id) => extract(a.get(id) as FixtureScore) - extract(b.get(id) as FixtureScore),
    ),
  };
}
