import assert from "node:assert/strict";
import test from "node:test";

import {
  devig,
  devigPower,
  devigProportional,
  devigShin,
  overround,
  type DecimalOdds,
} from "./devig";
import { assertValidProbabilities } from "./probabilities";

const close = (actual: number, expected: number, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);

const truth = { home: 0.5, draw: 0.3, away: 0.2 };

test("proportional de-vig divides implied probabilities by the book sum", () => {
  const odds = { home: 1.9, draw: 3.6, away: 4.2 };
  const implied = [1 / 1.9, 1 / 3.6, 1 / 4.2];
  const total = implied[0] + implied[1] + implied[2];
  close(overround(odds), total - 1, 1e-12);
  const { probabilities } = devigProportional(odds);
  close(probabilities.home, implied[0] / total, 1e-12);
  close(probabilities.draw, implied[1] / total, 1e-12);
  assertValidProbabilities(probabilities);
});

test("power de-vig recovers a known exponent and distribution", () => {
  const k = 1.1;
  const odds: DecimalOdds = {
    home: 1 / truth.home ** (1 / k),
    draw: 1 / truth.draw ** (1 / k),
    away: 1 / truth.away ** (1 / k),
  };
  assert.ok(overround(odds) > 0);
  const result = devigPower(odds);
  close(result.exponent, k);
  close(result.probabilities.home, truth.home);
  close(result.probabilities.draw, truth.draw);
  close(result.probabilities.away, truth.away);
});

test("Shin de-vig recovers a known insider share and distribution", () => {
  const z = 0.03;
  const root = (p: number) => Math.sqrt(z * p + (1 - z) * p * p);
  const scale = root(truth.home) + root(truth.draw) + root(truth.away);
  const odds: DecimalOdds = {
    home: 1 / (root(truth.home) * scale),
    draw: 1 / (root(truth.draw) * scale),
    away: 1 / (root(truth.away) * scale),
  };
  const result = devigShin(odds);
  close(result.z, z);
  close(result.probabilities.home, truth.home);
  close(result.probabilities.draw, truth.draw);
  close(result.probabilities.away, truth.away);
});

test("power and Shin shift margin away from the longshot relative to proportional", () => {
  const odds = { home: 1.45, draw: 4.4, away: 7.5 };
  const proportional = devig(odds, "proportional");
  for (const method of ["power", "shin"] as const) {
    const p = devig(odds, method);
    assertValidProbabilities(p);
    assert.ok(p.home > proportional.home, `${method} favourite`);
    assert.ok(p.away < proportional.away, `${method} longshot`);
  }
});

test("a margin-free book is unchanged by the power method", () => {
  const odds = { home: 2, draw: 4, away: 4 };
  const result = devigPower(odds);
  close(result.exponent, 1);
  close(result.probabilities.home, 0.5);
  assert.throws(() => devigShin(odds), /positive overround/);
});

test("invalid decimal odds are rejected", () => {
  assert.throws(() => devig({ home: 1, draw: 3, away: 4 }, "power"));
  assert.throws(() => devig({ home: Number.NaN, draw: 3, away: 4 }, "proportional"));
});
