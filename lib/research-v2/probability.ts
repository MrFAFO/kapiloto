import {
  assertValidProbabilities,
  normalizeProbabilities,
  OUTCOMES,
  type Outcome,
  type ThreeWayProbabilities,
} from "@/lib/evaluation/probabilities";

export { assertValidProbabilities, OUTCOMES, type Outcome, type ThreeWayProbabilities };

export type BasisPoints = { home: number; draw: number; away: number };

/** Linear pool: sum of weight * p, then renormalized. Weights must be >= 0. */
export function linearPool(
  parts: ReadonlyArray<{ probabilities: ThreeWayProbabilities; weight: number }>,
): ThreeWayProbabilities {
  assertWeights(parts.map((part) => part.weight));
  const raw = { home: 0, draw: 0, away: 0 };
  for (const { probabilities, weight } of parts) {
    assertValidProbabilities(probabilities);
    raw.home += weight * probabilities.home;
    raw.draw += weight * probabilities.draw;
    raw.away += weight * probabilities.away;
  }
  return normalizeProbabilities(raw);
}

/** Logarithmic pool: product of p^weight, then renormalized. */
export function logarithmicPool(
  parts: ReadonlyArray<{ probabilities: ThreeWayProbabilities; weight: number }>,
): ThreeWayProbabilities {
  assertWeights(parts.map((part) => part.weight));
  const logs = { home: 0, draw: 0, away: 0 };
  for (const { probabilities, weight } of parts) {
    assertValidProbabilities(probabilities);
    if (probabilities.home <= 0 || probabilities.draw <= 0 || probabilities.away <= 0) {
      throw new Error("Logarithmic pooling requires strictly positive probabilities.");
    }
    logs.home += weight * Math.log(probabilities.home);
    logs.draw += weight * Math.log(probabilities.draw);
    logs.away += weight * Math.log(probabilities.away);
  }
  const max = Math.max(logs.home, logs.draw, logs.away);
  return normalizeProbabilities({
    home: Math.exp(logs.home - max),
    draw: Math.exp(logs.draw - max),
    away: Math.exp(logs.away - max),
  });
}

function assertWeights(weights: number[]): void {
  if (weights.length === 0) throw new Error("A pool needs at least one input.");
  if (weights.some((weight) => !Number.isFinite(weight) || weight < 0)) {
    throw new Error("Pool weights must be finite and non-negative.");
  }
  if (!(weights.reduce((sum, weight) => sum + weight, 0) > 0)) {
    throw new Error("Pool weights must not all be zero.");
  }
}

/**
 * Home-versus-away strength shift in log-odds units: home odds are multiplied
 * by e^shift and away odds by e^-shift, the draw is left to renormalization.
 * Positive shift strengthens the home side.
 */
export function shiftHomeAwayStrength(
  probabilities: ThreeWayProbabilities,
  shift: number,
): ThreeWayProbabilities {
  assertValidProbabilities(probabilities);
  if (!Number.isFinite(shift)) throw new Error("Strength shift must be finite.");
  if (shift === 0) return probabilities;
  return normalizeProbabilities({
    home: probabilities.home * Math.exp(shift),
    draw: probabilities.draw,
    away: probabilities.away * Math.exp(-shift),
  });
}

/** Integer basis points summing to exactly 10000 (largest remainder, fixed tie order). */
export function toBasisPoints(probabilities: ThreeWayProbabilities): BasisPoints {
  assertValidProbabilities(probabilities);
  const keys = ["home", "draw", "away"] as const;
  const scaled = keys.map((key) => probabilities[key] * 10_000);
  const floors = scaled.map(Math.floor);
  let remainder = 10_000 - floors.reduce((sum, value) => sum + value, 0);
  const order = keys
    .map((_, index) => index)
    .sort((a, b) => scaled[b] - floors[b] - (scaled[a] - floors[a]) || a - b);
  for (let i = 0; remainder > 0; i += 1, remainder -= 1) floors[order[i % 3]] += 1;
  return { home: floors[0], draw: floors[1], away: floors[2] };
}

export function outcomeProbability(probabilities: ThreeWayProbabilities, outcome: Outcome): number {
  return outcome === "1" ? probabilities.home : outcome === "X" ? probabilities.draw : probabilities.away;
}

/** Outcomes ordered by probability, ties broken in 1, X, 2 order. */
export function rankedOutcomes(probabilities: ThreeWayProbabilities): Outcome[] {
  return [...OUTCOMES].sort(
    (a, b) =>
      outcomeProbability(probabilities, b) - outcomeProbability(probabilities, a) ||
      OUTCOMES.indexOf(a) - OUTCOMES.indexOf(b),
  );
}

/** Largest per-outcome absolute difference, in basis points. */
export function maxDisagreementBp(a: ThreeWayProbabilities, b: ThreeWayProbabilities): number {
  return Math.round(
    10_000 * Math.max(Math.abs(a.home - b.home), Math.abs(a.draw - b.draw), Math.abs(a.away - b.away)),
  );
}
