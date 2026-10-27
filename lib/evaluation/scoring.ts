import type { EvaluationMode } from "./arms";
import {
  KAPILOTO_EVAL_SCORING_VERSION,
  pairedDifferences,
  scorePrediction,
  summarizeScores,
  type FixtureScore,
  type ScoreMetric,
  type ScoreSummary,
} from "./metrics";
import { KAPILOTO_EVAL_OUTCOME_SOURCE, resolveNinetyMinuteOutcome } from "./outcome";
import type { Outcome } from "./probabilities";
import {
  KAPILOTO_EVAL_SELECTION_RULE_VERSION,
  predictionProbabilities,
  selectScoredPrediction,
  type FixtureForEvaluation,
  type StoredEvalPrediction,
} from "./selection";

export type EvalScoreStatus =
  | "scored"
  | "prediction_unavailable"
  | "no_eligible_prediction";

export type EvalScoreDraft = {
  fixture_id: string;
  arm: string;
  arm_version: string;
  evaluation_mode: EvaluationMode;
  selection_rule_version: string;
  scoring_version: string;
  status: EvalScoreStatus;
  prediction_id: string | null;
  outcome: Outcome;
  home_goals_90: number;
  away_goals_90: number;
  outcome_source: string;
  brier: number | null;
  rps: number | null;
  log_loss: number | null;
  top_pick: Outcome | null;
  top_pick_score: number | null;
  details: Record<string, unknown>;
};

export type SkippedFixture = { fixtureId: string; reason: string };

function armKey(prediction: Pick<StoredEvalPrediction, "arm" | "arm_version">) {
  return `${prediction.arm}\u0000${prediction.arm_version}`;
}

/**
 * Scores every (arm, arm_version) present for each fixture whose 90-minute
 * result is final. Cancelled fixtures are void and unfinished fixtures are
 * deferred; neither produces a score row.
 */
export function evaluateFixtures(
  fixtures: readonly FixtureForEvaluation[],
  predictions: readonly StoredEvalPrediction[],
  mode: EvaluationMode,
): { scores: EvalScoreDraft[]; skipped: SkippedFixture[] } {
  const scores: EvalScoreDraft[] = [];
  const skipped: SkippedFixture[] = [];
  const byFixture = new Map<string, StoredEvalPrediction[]>();
  for (const prediction of predictions) {
    const list = byFixture.get(prediction.fixture_id) ?? [];
    list.push(prediction);
    byFixture.set(prediction.fixture_id, list);
  }

  for (const fixture of [...fixtures].sort((a, b) =>
    a.fixtureId.localeCompare(b.fixtureId),
  )) {
    const outcome = resolveNinetyMinuteOutcome(fixture);
    if (outcome.status !== "final") {
      skipped.push({
        fixtureId: fixture.fixtureId,
        reason: outcome.status === "void" ? "fixture_void" : outcome.reason,
      });
      continue;
    }

    const groups = new Map<string, StoredEvalPrediction[]>();
    for (const prediction of byFixture.get(fixture.fixtureId) ?? []) {
      const list = groups.get(armKey(prediction)) ?? [];
      list.push(prediction);
      groups.set(armKey(prediction), list);
    }

    for (const key of [...groups.keys()].sort()) {
      const group = groups.get(key) as StoredEvalPrediction[];
      const { arm, arm_version } = group[0];
      const selection = selectScoredPrediction(group, fixture, mode);
      const base = {
        fixture_id: fixture.fixtureId,
        arm,
        arm_version,
        evaluation_mode: mode,
        selection_rule_version: KAPILOTO_EVAL_SELECTION_RULE_VERSION,
        scoring_version: KAPILOTO_EVAL_SCORING_VERSION,
        outcome: outcome.outcome,
        home_goals_90: outcome.homeGoals,
        away_goals_90: outcome.awayGoals,
        outcome_source: KAPILOTO_EVAL_OUTCOME_SOURCE,
      };
      const emptyMetrics = {
        brier: null,
        rps: null,
        log_loss: null,
        top_pick: null,
        top_pick_score: null,
      };

      if (selection.status !== "selected") {
        scores.push({
          ...base,
          ...emptyMetrics,
          status: "no_eligible_prediction",
          prediction_id: null,
          details: { deadline: selection.deadline, rejected: selection.rejected },
        });
        continue;
      }

      const probabilities = predictionProbabilities(selection.prediction);
      if (!probabilities) {
        scores.push({
          ...base,
          ...emptyMetrics,
          status: "prediction_unavailable",
          prediction_id: selection.prediction.id,
          details: {
            deadline: selection.deadline,
            invalid_reason: selection.prediction.invalid_reason,
            rejected: selection.rejected,
          },
        });
        continue;
      }

      const score = scorePrediction(probabilities, outcome.outcome);
      scores.push({
        ...base,
        status: "scored",
        prediction_id: selection.prediction.id,
        brier: score.brier,
        rps: score.rps,
        log_loss: score.logLoss,
        top_pick: score.topPick,
        top_pick_score: score.topPickScore,
        details: { deadline: selection.deadline, rejected: selection.rejected },
      });
    }
  }

  return { scores, skipped };
}

function asFixtureScore(score: EvalScoreDraft): FixtureScore | null {
  if (
    score.status !== "scored" ||
    score.brier == null ||
    score.rps == null ||
    score.log_loss == null ||
    score.top_pick == null ||
    score.top_pick_score == null
  ) {
    return null;
  }
  return {
    brier: score.brier,
    rps: score.rps,
    logLoss: score.log_loss,
    topPickScore: score.top_pick_score,
    topPick: score.top_pick,
  };
}

export type ArmSummary = {
  arm: string;
  armVersion: string;
  fixtures: number;
  scored: number;
  unavailable: number;
  noEligiblePrediction: number;
  metrics: ScoreSummary | null;
};

export function summarizeByArm(scores: readonly EvalScoreDraft[]): ArmSummary[] {
  const groups = new Map<string, EvalScoreDraft[]>();
  for (const score of scores) {
    const list = groups.get(armKey(score)) ?? [];
    list.push(score);
    groups.set(armKey(score), list);
  }
  return [...groups.keys()].sort().map((key) => {
    const group = groups.get(key) as EvalScoreDraft[];
    const fixtureScores = group
      .map(asFixtureScore)
      .filter((score): score is FixtureScore => score != null);
    return {
      arm: group[0].arm,
      armVersion: group[0].arm_version,
      fixtures: group.length,
      scored: fixtureScores.length,
      unavailable: group.filter((score) => score.status === "prediction_unavailable")
        .length,
      noEligiblePrediction: group.filter(
        (score) => score.status === "no_eligible_prediction",
      ).length,
      metrics: summarizeScores(fixtureScores),
    };
  });
}

/** Paired comparison of two arms on the fixtures both scored. */
export function compareArms(
  scores: readonly EvalScoreDraft[],
  a: { arm: string; armVersion: string },
  b: { arm: string; armVersion: string },
  metric: ScoreMetric,
) {
  const collect = (target: { arm: string; armVersion: string }) => {
    const map = new Map<string, FixtureScore>();
    for (const score of scores) {
      if (score.arm !== target.arm || score.arm_version !== target.armVersion) continue;
      const fixtureScore = asFixtureScore(score);
      if (fixtureScore) map.set(score.fixture_id, fixtureScore);
    }
    return map;
  };
  const paired = pairedDifferences(collect(a), collect(b), metric);
  const n = paired.differences.length;
  return {
    ...paired,
    n,
    meanDifference:
      n === 0 ? null : paired.differences.reduce((sum, d) => sum + d, 0) / n,
  };
}
