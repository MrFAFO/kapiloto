import assert from "node:assert/strict";
import test from "node:test";

import {
  logLoss,
  LOG_LOSS_EPSILON,
  multiclassBrier,
  pairedDifferences,
  rankedProbabilityScore,
  scorePrediction,
  summarizeScores,
  topPickScore,
} from "./metrics";
import {
  assertValidProbabilities,
  fromBasisPoints,
  normalizeProbabilities,
  topOutcomes,
} from "./probabilities";

const close = (actual: number, expected: number, tolerance = 1e-12) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${expected}, got ${actual}`,
  );

const p = { home: 0.5, draw: 0.3, away: 0.2 };
const uniform = { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };

test("multiclass Brier matches hand-computed values", () => {
  close(multiclassBrier(p, "1"), 0.25 + 0.09 + 0.04);
  close(multiclassBrier(p, "X"), 0.25 + 0.49 + 0.04);
  close(multiclassBrier(p, "2"), 0.25 + 0.09 + 0.64);
  close(multiclassBrier(uniform, "X"), 6 / 9);
  close(multiclassBrier({ home: 1, draw: 0, away: 0 }, "1"), 0);
  close(multiclassBrier({ home: 0, draw: 0, away: 1 }, "1"), 2);
});

test("RPS uses the ordered 1 < X < 2 cumulative form", () => {
  // ((0.5-1)^2 + (0.8-1)^2) / 2
  close(rankedProbabilityScore(p, "1"), 0.145);
  // ((0.5-0)^2 + (0.8-1)^2) / 2
  close(rankedProbabilityScore(p, "X"), 0.145);
  // ((0.5-0)^2 + (0.8-0)^2) / 2
  close(rankedProbabilityScore(p, "2"), 0.445);
  close(rankedProbabilityScore(uniform, "1"), 5 / 18);
  close(rankedProbabilityScore(uniform, "X"), 1 / 9);
  close(rankedProbabilityScore({ home: 1, draw: 0, away: 0 }, "1"), 0);
});

test("RPS penalizes a distant miss more than an adjacent miss; Brier does not", () => {
  const adjacent = { home: 0, draw: 1, away: 0 };
  const distant = { home: 0, draw: 0, away: 1 };
  close(rankedProbabilityScore(adjacent, "1"), 0.5);
  close(rankedProbabilityScore(distant, "1"), 1);
  close(multiclassBrier(adjacent, "1"), multiclassBrier(distant, "1"));
});

test("log loss is the natural log of the realized probability, clamped", () => {
  close(logLoss(p, "1"), Math.log(2));
  close(logLoss(p, "X"), -Math.log(0.3));
  close(logLoss(p, "2"), -Math.log(0.2));
  close(logLoss(uniform, "2"), Math.log(3));
  close(logLoss({ home: 1, draw: 0, away: 0 }, "1"), 0);
  close(logLoss({ home: 1, draw: 0, away: 0 }, "2"), -Math.log(LOG_LOSS_EPSILON));
  assert.ok(Number.isFinite(logLoss({ home: 1, draw: 0, away: 0 }, "X")));
});

test("top-pick accuracy splits credit across ties", () => {
  assert.equal(topPickScore(p, "1"), 1);
  assert.equal(topPickScore(p, "X"), 0);
  assert.equal(topPickScore({ home: 0.4, draw: 0.4, away: 0.2 }, "X"), 0.5);
  assert.equal(topPickScore({ home: 0.4, draw: 0.4, away: 0.2 }, "2"), 0);
  close(topPickScore(uniform, "2"), 1 / 3);
  assert.deepEqual(topOutcomes(uniform), ["1", "X", "2"]);
  assert.equal(scorePrediction(uniform, "2").topPick, "1");
});

test("metrics reject invalid probability vectors", () => {
  assert.throws(() => multiclassBrier({ home: 0.5, draw: 0.5, away: 0.5 }, "1"));
  assert.throws(() => logLoss({ home: -0.1, draw: 0.6, away: 0.5 }, "1"));
  assert.throws(() => rankedProbabilityScore({ home: Number.NaN, draw: 0.5, away: 0.5 }, "1"));
});

test("normalization and basis-point conversion produce valid distributions", () => {
  const normalized = normalizeProbabilities({ home: 2, draw: 1, away: 1 });
  assert.deepEqual(normalized, { home: 0.5, draw: 0.25, away: 0.25 });
  assertValidProbabilities(normalized);
  assert.deepEqual(fromBasisPoints({ home: 4500, draw: 2600, away: 2900 }), {
    home: 0.45,
    draw: 0.26,
    away: 0.29,
  });
  assert.throws(() => fromBasisPoints({ home: 4500, draw: 2600, away: 2800 }));
  assert.throws(() => normalizeProbabilities({ home: 0, draw: 0, away: 0 }));
});

test("summaries and paired differences aggregate per-fixture scores", () => {
  const a = new Map([
    ["f1", scorePrediction(p, "1")],
    ["f2", scorePrediction(p, "2")],
  ]);
  const b = new Map([
    ["f1", scorePrediction(uniform, "1")],
    ["f3", scorePrediction(uniform, "X")],
  ]);
  const summary = summarizeScores([...a.values()]);
  assert.ok(summary);
  assert.equal(summary.n, 2);
  close(summary.meanRps, (0.145 + 0.445) / 2);
  close(summary.topPickAccuracy, 0.5);
  assert.equal(summarizeScores([]), null);

  const paired = pairedDifferences(a, b, "log_loss");
  assert.deepEqual(paired.fixtureIds, ["f1"]);
  close(paired.differences[0], Math.log(2) - Math.log(3));
});
