import type { ThreeWayProbabilities } from "./probabilities";

export type DecimalOdds = { home: number; draw: number; away: number };

export type DevigMethod = "proportional" | "power" | "shin";

export const DEVIG_METHOD_VERSIONS: Record<DevigMethod, string> = {
  proportional: "devig-proportional-v1",
  power: "devig-power-v1",
  shin: "devig-shin-v1",
};

const KEYS = ["home", "draw", "away"] as const;
const BISECTION_ITERATIONS = 200;
const SOLVE_TOLERANCE = 1e-12;

function assertOdds(odds: DecimalOdds): void {
  for (const key of KEYS) {
    const value = odds[key];
    if (!Number.isFinite(value) || value <= 1) {
      throw new Error(`Invalid decimal odds for ${key}: ${value}`);
    }
  }
}

export function impliedProbabilities(odds: DecimalOdds): ThreeWayProbabilities {
  assertOdds(odds);
  return { home: 1 / odds.home, draw: 1 / odds.draw, away: 1 / odds.away };
}

/** Bookmaker margin: sum of implied probabilities minus one. */
export function overround(odds: DecimalOdds): number {
  const implied = impliedProbabilities(odds);
  return implied.home + implied.draw + implied.away - 1;
}

function map(
  p: ThreeWayProbabilities,
  fn: (value: number) => number,
): ThreeWayProbabilities {
  return { home: fn(p.home), draw: fn(p.draw), away: fn(p.away) };
}

function sum(p: ThreeWayProbabilities): number {
  return p.home + p.draw + p.away;
}

/** Bisection for the root of a function that is decreasing on [lo, hi]. */
function solveDecreasing(fn: (x: number) => number, lo: number, hi: number): number {
  if (fn(lo) < 0 || fn(hi) > 0) {
    throw new Error("De-vig root is not bracketed.");
  }
  let low = lo;
  let high = hi;
  for (let i = 0; i < BISECTION_ITERATIONS; i += 1) {
    const mid = (low + high) / 2;
    if (fn(mid) > 0) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** p_i = pi_i / sum(pi). Spreads the margin in proportion to price. */
export function devigProportional(odds: DecimalOdds): {
  probabilities: ThreeWayProbabilities;
} {
  const implied = impliedProbabilities(odds);
  const total = sum(implied);
  return { probabilities: map(implied, (value) => value / total) };
}

/**
 * Power method: p_i = pi_i^k with k solved so that sum(p) = 1. For a positive
 * margin k > 1, which removes relatively more margin from long shots than the
 * proportional method (the favourite-longshot bias).
 */
export function devigPower(odds: DecimalOdds): {
  probabilities: ThreeWayProbabilities;
  exponent: number;
} {
  const implied = impliedProbabilities(odds);
  const total = (k: number) => sum(map(implied, (value) => value ** k)) - 1;
  const exponent = solveDecreasing(total, 1e-6, 64);
  const probabilities = map(implied, (value) => value ** exponent);
  const residual = Math.abs(sum(probabilities) - 1);
  if (residual > SOLVE_TOLERANCE) {
    throw new Error(`Power de-vig did not converge (residual ${residual}).`);
  }
  const normalized = map(probabilities, (value) => value / sum(probabilities));
  return { probabilities: normalized, exponent };
}

/**
 * Shin (1993) insider-trading model. With pi_i = 1/o_i and B = sum(pi):
 *   p_i(z) = (sqrt(z^2 + 4 (1 - z) pi_i^2 / B) - z) / (2 (1 - z))
 * and z in [0, 1) solved so that sum(p) = 1. Requires a positive margin.
 */
export function devigShin(odds: DecimalOdds): {
  probabilities: ThreeWayProbabilities;
  z: number;
} {
  const implied = impliedProbabilities(odds);
  const booksum = sum(implied);
  if (booksum <= 1) {
    throw new Error("Shin de-vig requires a positive overround.");
  }
  const at = (z: number) =>
    map(
      implied,
      (value) =>
        (Math.sqrt(z * z + (4 * (1 - z) * value * value) / booksum) - z) /
        (2 * (1 - z)),
    );
  const z = solveDecreasing((candidate) => sum(at(candidate)) - 1, 0, 0.99);
  const probabilities = at(z);
  const residual = Math.abs(sum(probabilities) - 1);
  if (residual > SOLVE_TOLERANCE) {
    throw new Error(`Shin de-vig did not converge (residual ${residual}).`);
  }
  const normalized = map(probabilities, (value) => value / sum(probabilities));
  return { probabilities: normalized, z };
}

export function devig(
  odds: DecimalOdds,
  method: DevigMethod,
): ThreeWayProbabilities {
  if (method === "proportional") return devigProportional(odds).probabilities;
  if (method === "power") return devigPower(odds).probabilities;
  return devigShin(odds).probabilities;
}
