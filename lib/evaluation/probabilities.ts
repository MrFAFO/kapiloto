/**
 * 1/X/2 probability primitives for shadow evaluation.
 *
 * Probabilities are always oriented to the canonical fixture: `home` is
 * `fixtures.home_team_id`. Evaluation never re-orients a prediction; a record
 * whose stored team identity disagrees with the fixture is rejected instead.
 */

export const OUTCOMES = ["1", "X", "2"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export type ThreeWayProbabilities = {
  home: number;
  draw: number;
  away: number;
};

export const PROBABILITY_SUM_TOLERANCE = 1e-9;

export function isOutcome(value: unknown): value is Outcome {
  return value === "1" || value === "X" || value === "2";
}

export function probabilityOf(
  probabilities: ThreeWayProbabilities,
  outcome: Outcome,
): number {
  if (outcome === "1") return probabilities.home;
  if (outcome === "X") return probabilities.draw;
  return probabilities.away;
}

export function assertValidProbabilities(
  probabilities: ThreeWayProbabilities,
  context = "probabilities",
): void {
  for (const [name, value] of Object.entries(probabilities)) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`Invalid ${context}.${name}: ${value}`);
    }
  }
  const total = probabilities.home + probabilities.draw + probabilities.away;
  if (Math.abs(total - 1) > PROBABILITY_SUM_TOLERANCE) {
    throw new Error(`${context} must sum to 1; got ${total}`);
  }
}

export function normalizeProbabilities(
  raw: ThreeWayProbabilities,
): ThreeWayProbabilities {
  for (const [name, value] of Object.entries(raw)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Cannot normalize ${name}=${value}`);
    }
  }
  const total = raw.home + raw.draw + raw.away;
  if (!(total > 0)) throw new Error("Cannot normalize an all-zero distribution.");
  return {
    home: raw.home / total,
    draw: raw.draw / total,
    away: raw.away / total,
  };
}

export function fromBasisPoints(bp: {
  home: number;
  draw: number;
  away: number;
}): ThreeWayProbabilities {
  const total = bp.home + bp.draw + bp.away;
  if (total !== 10_000) {
    throw new Error(`Basis points must sum to 10000; got ${total}`);
  }
  return {
    home: bp.home / 10_000,
    draw: bp.draw / 10_000,
    away: bp.away / 10_000,
  };
}

const ARGMAX_TOLERANCE = 1e-12;

/** Every outcome tied for the maximum probability, in 1, X, 2 order. */
export function topOutcomes(probabilities: ThreeWayProbabilities): Outcome[] {
  const max = Math.max(probabilities.home, probabilities.draw, probabilities.away);
  return OUTCOMES.filter(
    (outcome) => max - probabilityOf(probabilities, outcome) <= ARGMAX_TOLERANCE,
  );
}
