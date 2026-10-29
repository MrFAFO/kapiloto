import assert from "node:assert/strict";
import test from "node:test";

import { START_LOG_LOSS_EPSILON, minutesMeanAbsoluteError, modalXiHitCount, startBrierScore, startLogLoss } from "./lineup-scoring";

/** Benchmark metrics never score unknown ground truth as zero. */

const ids = Array.from({ length: 14 }, (_, k) => `p${String(k + 1).padStart(2, "0")}`);

test("start Brier and log loss use only players whose start truth is known", () => {
  const predictions = [
    { player_id: "a", start_probability_bp: 8000 },
    { player_id: "b", start_probability_bp: 2000 },
    { player_id: "c", start_probability_bp: 5000 },
    { player_id: "d", start_probability_bp: 9000 },
  ];
  const truths = [
    { player_id: "a", started: true },
    { player_id: "b", started: false },
    { player_id: "c", started: null }, // unknown: not scored
    // d has no truth row at all: not scored
  ];
  const brier = startBrierScore(predictions, truths);
  assert.equal(brier.sample_count, 2);
  assert.ok(Math.abs(brier.mean! - (0.2 ** 2 + 0.2 ** 2) / 2) < 1e-12);
  const logLoss = startLogLoss(predictions, truths);
  assert.equal(logLoss.sample_count, 2);
  assert.ok(Math.abs(logLoss.mean! - -Math.log(0.8)) < 1e-12);

  // Certain and wrong: clipped at epsilon instead of infinite.
  const wrong = startLogLoss([{ player_id: "a", start_probability_bp: 0 }], [{ player_id: "a", started: true }]);
  assert.ok(Math.abs(wrong.mean! - -Math.log(START_LOG_LOSS_EPSILON)) < 1e-9);
  assert.ok(Number.isFinite(startLogLoss([{ player_id: "a", start_probability_bp: 10000 }], [{ player_id: "a", started: false }]).mean));

  // Nothing known: no score, not zero.
  assert.deepEqual(startBrierScore(predictions, []), { mean: null, sample_count: 0 });
  assert.deepEqual(startLogLoss(predictions, [{ player_id: "a", started: null }]), { mean: null, sample_count: 0 });
});

test("modal XI hit count needs exactly 11 known starters", () => {
  const modal = ids.slice(0, 11);
  assert.equal(modalXiHitCount(modal, ids.slice(0, 11)), 11);
  assert.equal(modalXiHitCount(modal, [...ids.slice(3, 11), ...ids.slice(11, 14)]), 8);
  assert.equal(modalXiHitCount(modal, ids.slice(0, 10)), null);
  assert.equal(modalXiHitCount(modal, [...ids.slice(0, 10), ids[0]]), null);
  assert.equal(modalXiHitCount(modal, null), null);
  assert.equal(modalXiHitCount([], ids.slice(0, 11)), 0);
});

test("minutes MAE scores only explicitly known regulation minutes", () => {
  const predictions = [
    { player_id: "a", expected_minutes_tenths: 800 },
    { player_id: "b", expected_minutes_tenths: 100 },
    { player_id: "c", expected_minutes_tenths: 450 },
  ];
  const result = minutesMeanAbsoluteError(predictions, [
    { player_id: "a", regulation_minutes: 95 }, // capped at 90 (regulation only)
    { player_id: "b", regulation_minutes: 0 }, // known zero is scored
    { player_id: "c", regulation_minutes: null }, // unknown is not
  ]);
  assert.equal(result.sample_count, 2);
  assert.ok(Math.abs(result.mean! - (10 + 10) / 2) < 1e-12);
  assert.deepEqual(minutesMeanAbsoluteError(predictions, []), { mean: null, sample_count: 0 });
});
