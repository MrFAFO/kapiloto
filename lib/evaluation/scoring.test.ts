import assert from "node:assert/strict";
import test from "node:test";

import { KAPILOTO_EVAL_SCORING_VERSION } from "./metrics";
import { resolveNinetyMinuteOutcome } from "./outcome";
import { compareArms, evaluateFixtures, summarizeByArm } from "./scoring";
import {
  KAPILOTO_EVAL_SELECTION_RULE_VERSION,
  type FixtureForEvaluation,
  type StoredEvalPrediction,
} from "./selection";

const HOME = "00000000-0000-4000-8000-0000000000a1";
const AWAY = "00000000-0000-4000-8000-0000000000a2";
const KICKOFF = "2026-10-24T14:00:00.000Z";
const at = (minutesBeforeKickoff: number) =>
  new Date(Date.parse(KICKOFF) - minutesBeforeKickoff * 60_000).toISOString();

function fixture(id: string, overrides: Partial<FixtureForEvaluation> = {}): FixtureForEvaluation {
  return {
    fixtureId: id,
    homeTeamId: HOME,
    awayTeamId: AWAY,
    kickoffAt: KICKOFF,
    actualKickoffAt: null,
    status: "finished",
    homeScore: 2,
    awayScore: 1,
    ...overrides,
  };
}

function prediction(
  id: string,
  fixtureId: string,
  arm: string,
  p: [number, number, number] | null,
  issuedMinutesBefore = 60,
): StoredEvalPrediction {
  return {
    id,
    fixture_id: fixtureId,
    arm,
    arm_version: `${arm}-v1`,
    evaluation_mode: "forward",
    deterministic: arm !== "kapiloto_published",
    information_cutoff_at: at(issuedMinutesBefore),
    issued_at: at(issuedMinutesBefore),
    recorded_at: at(issuedMinutesBefore),
    kickoff_at_snapshot: KICKOFF,
    home_team_id: HOME,
    away_team_id: AWAY,
    valid: p != null,
    invalid_reason: p ? null : "no_quotes_before_cutoff",
    p_home: p?.[0] ?? null,
    p_draw: p?.[1] ?? null,
    p_away: p?.[2] ?? null,
  };
}

test("90-minute outcome comes from the regular-time field score only", () => {
  assert.deepEqual(resolveNinetyMinuteOutcome(fixture("f")), {
    status: "final",
    outcome: "1",
    homeGoals: 2,
    awayGoals: 1,
  });
  assert.equal(
    resolveNinetyMinuteOutcome(fixture("f", { homeScore: 1, awayScore: 1 })).status === "final" &&
      (resolveNinetyMinuteOutcome(fixture("f", { homeScore: 1, awayScore: 1 })) as { outcome: string }).outcome,
    "X",
  );
  assert.deepEqual(resolveNinetyMinuteOutcome(fixture("f", { status: "cancelled" })), {
    status: "void",
    reason: "cancelled",
  });
  for (const status of ["postponed", "suspended", "live", "upcoming", "under_review"]) {
    assert.equal(resolveNinetyMinuteOutcome(fixture("f", { status })).status, "not_final");
  }
  assert.deepEqual(
    resolveNinetyMinuteOutcome(fixture("f", { homeScore: null, awayScore: null })),
    { status: "not_final", reason: "score_missing" },
  );
});

test("evaluation scores every arm, defers unfinished fixtures and voids cancelled ones", () => {
  const fixtures = [
    fixture("f-finished"),
    fixture("f-cancelled", { status: "cancelled", homeScore: null, awayScore: null }),
    fixture("f-postponed", { status: "postponed", homeScore: null, awayScore: null }),
  ];
  const predictions = [
    prediction("u1", "f-finished", "uniform", [1 / 3, 1 / 3, 1 / 3]),
    prediction("m1", "f-finished", "market", null),
    prediction("k-late", "f-finished", "kapiloto_published", [0.6, 0.25, 0.15], -10),
    prediction("u2", "f-cancelled", "uniform", [1 / 3, 1 / 3, 1 / 3]),
    prediction("u3", "f-postponed", "uniform", [1 / 3, 1 / 3, 1 / 3]),
  ];
  const { scores, skipped } = evaluateFixtures(fixtures, predictions, "forward");

  assert.deepEqual(skipped, [
    { fixtureId: "f-cancelled", reason: "fixture_void" },
    { fixtureId: "f-postponed", reason: "status_postponed" },
  ]);
  assert.deepEqual(
    scores.map((score) => [score.arm, score.status, score.prediction_id]),
    [
      ["kapiloto_published", "no_eligible_prediction", null],
      ["market", "prediction_unavailable", "m1"],
      ["uniform", "scored", "u1"],
    ],
  );
  const uniform = scores.find((score) => score.arm === "uniform");
  assert.ok(uniform);
  assert.equal(uniform.outcome, "1");
  assert.equal(uniform.selection_rule_version, KAPILOTO_EVAL_SELECTION_RULE_VERSION);
  assert.equal(uniform.scoring_version, KAPILOTO_EVAL_SCORING_VERSION);
  assert.ok(Math.abs((uniform.rps ?? 0) - 5 / 18) < 1e-12);
  assert.ok(Math.abs((uniform.top_pick_score ?? 0) - 1 / 3) < 1e-12);
});

test("arm summaries count coverage separately from metric means", () => {
  const fixtures = [fixture("f1"), fixture("f2", { homeScore: 0, awayScore: 0 })];
  const predictions = [
    prediction("a1", "f1", "p_stat", [0.5, 0.3, 0.2]),
    prediction("a2", "f2", "p_stat", null),
    prediction("u1", "f1", "uniform", [1 / 3, 1 / 3, 1 / 3]),
    prediction("u2", "f2", "uniform", [1 / 3, 1 / 3, 1 / 3]),
  ];
  const { scores } = evaluateFixtures(fixtures, predictions, "forward");
  const summary = summarizeByArm(scores);
  const pStat = summary.find((item) => item.arm === "p_stat");
  assert.ok(pStat);
  assert.equal(pStat.fixtures, 2);
  assert.equal(pStat.scored, 1);
  assert.equal(pStat.unavailable, 1);
  assert.ok(Math.abs((pStat.metrics?.meanLogLoss ?? 0) - Math.log(2)) < 1e-12);

  const paired = compareArms(
    scores,
    { arm: "p_stat", armVersion: "p_stat-v1" },
    { arm: "uniform", armVersion: "uniform-v1" },
    "log_loss",
  );
  assert.equal(paired.n, 1);
  assert.deepEqual(paired.fixtureIds, ["f1"]);
  assert.ok(Math.abs((paired.meanDifference ?? 0) - (Math.log(2) - Math.log(3))) < 1e-12);
});
