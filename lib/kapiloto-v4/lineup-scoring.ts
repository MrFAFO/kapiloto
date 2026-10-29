/**
 * Pure benchmark metrics for lineup forecasts (no persistence, no fitting).
 * Ground truth that is not actually known is never scored as zero: players
 * whose start or minutes truth is unknown are left out, and the sample count
 * says how many were scored.
 */

export type MetricResult = { mean: number | null; sample_count: number };

/** started: true/false when known; null when the truth is not known. */
export type StartTruth = { player_id: string; started: boolean | null };
export type MinutesTruth = { player_id: string; regulation_minutes: number | null };
export type StartPrediction = { player_id: string; start_probability_bp: number };
export type MinutesPrediction = { player_id: string; expected_minutes_tenths: number };

/** Probabilities are clipped to [epsilon, 1 - epsilon] for log loss. */
export const START_LOG_LOSS_EPSILON = 1e-6;

function knownPairs(predictions: readonly StartPrediction[], truths: readonly StartTruth[]) {
  const truth = new Map(truths.map((t) => [t.player_id, t.started]));
  return predictions
    .map((p) => ({ p: p.start_probability_bp / 10000, y: truth.get(p.player_id) }))
    .filter((pair): pair is { p: number; y: boolean } => typeof pair.y === "boolean");
}

export function startBrierScore(predictions: readonly StartPrediction[], truths: readonly StartTruth[]): MetricResult {
  const pairs = knownPairs(predictions, truths);
  if (pairs.length === 0) return { mean: null, sample_count: 0 };
  return { mean: pairs.reduce((sum, { p, y }) => sum + (p - (y ? 1 : 0)) ** 2, 0) / pairs.length, sample_count: pairs.length };
}

export function startLogLoss(predictions: readonly StartPrediction[], truths: readonly StartTruth[], epsilon = START_LOG_LOSS_EPSILON): MetricResult {
  const pairs = knownPairs(predictions, truths);
  if (pairs.length === 0) return { mean: null, sample_count: 0 };
  const loss = pairs.reduce((sum, { p, y }) => {
    const q = Math.min(1 - epsilon, Math.max(epsilon, p));
    return sum - (y ? Math.log(q) : Math.log(1 - q));
  }, 0);
  return { mean: loss / pairs.length, sample_count: pairs.length };
}

/** Intersection of the modal XI with the actual XI; null unless exactly 11 actual starters are known. */
export function modalXiHitCount(modalXi: readonly string[], actualStarters: readonly string[] | null): number | null {
  if (actualStarters === null || new Set(actualStarters).size !== 11) return null;
  const actual = new Set(actualStarters);
  return new Set(modalXi.filter((id) => actual.has(id))).size;
}

/** Mean absolute error in minutes, only where actual regulation minutes are explicitly known. */
export function minutesMeanAbsoluteError(predictions: readonly MinutesPrediction[], truths: readonly MinutesTruth[]): MetricResult {
  const truth = new Map(truths.map((t) => [t.player_id, t.regulation_minutes]));
  const pairs = predictions
    .map((p) => ({ predicted: p.expected_minutes_tenths / 10, actual: truth.get(p.player_id) }))
    .filter((pair): pair is { predicted: number; actual: number } => typeof pair.actual === "number");
  if (pairs.length === 0) return { mean: null, sample_count: 0 };
  return { mean: pairs.reduce((sum, { predicted, actual }) => sum + Math.abs(predicted - Math.min(actual, 90)), 0) / pairs.length, sample_count: pairs.length };
}
