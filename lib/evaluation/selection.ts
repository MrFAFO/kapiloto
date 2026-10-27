import { EVAL_SAFETY_MARGIN_MINUTES, type EvaluationMode } from "./arms";
import { parseInstant } from "./history";
import type { ThreeWayProbabilities } from "./probabilities";

export const KAPILOTO_EVAL_SELECTION_RULE_VERSION = "kapiloto-eval-selection-v1";

/**
 * A prediction made for a kickoff that later moved by more than this was
 * issued for a different scheduled match and is never scored.
 */
export const RESCHEDULE_TOLERANCE_MINUTES = 360;

export type StoredEvalPrediction = {
  id: string;
  fixture_id: string;
  arm: string;
  arm_version: string;
  evaluation_mode: EvaluationMode;
  deterministic: boolean;
  information_cutoff_at: string;
  issued_at: string;
  recorded_at: string;
  kickoff_at_snapshot: string;
  home_team_id: string;
  away_team_id: string;
  valid: boolean;
  invalid_reason: string | null;
  p_home: number | null;
  p_draw: number | null;
  p_away: number | null;
};

export type FixtureForEvaluation = {
  fixtureId: string;
  homeTeamId: string;
  awayTeamId: string;
  kickoffAt: string;
  actualKickoffAt: string | null;
  status: string;
  homeScore: number | null;
  awayScore: number | null;
};

export type SelectionRejectionReason =
  | "wrong_fixture"
  | "mode_mismatch"
  | "non_deterministic_replay"
  | "orientation_mismatch"
  | "kickoff_rescheduled"
  | "information_after_issue"
  | "information_after_deadline"
  | "issued_after_deadline";

export type SelectionResult =
  | {
      status: "selected";
      prediction: StoredEvalPrediction;
      deadline: string;
      rejected: Array<{ id: string; reason: SelectionRejectionReason }>;
    }
  | {
      status: "no_eligible_prediction";
      deadline: string;
      rejected: Array<{ id: string; reason: SelectionRejectionReason }>;
    };

export function effectiveKickoffMs(fixture: FixtureForEvaluation): number {
  return parseInstant(fixture.actualKickoffAt ?? fixture.kickoffAt, "kickoffAt");
}

export function selectionDeadlineMs(
  fixture: FixtureForEvaluation,
  safetyMarginMinutes = EVAL_SAFETY_MARGIN_MINUTES,
): number {
  return effectiveKickoffMs(fixture) - safetyMarginMinutes * 60_000;
}

function rejection(
  prediction: StoredEvalPrediction,
  fixture: FixtureForEvaluation,
  mode: EvaluationMode,
  deadlineMs: number,
): SelectionRejectionReason | null {
  if (prediction.fixture_id !== fixture.fixtureId) return "wrong_fixture";
  if (prediction.evaluation_mode !== mode) return "mode_mismatch";
  if (mode === "replay" && !prediction.deterministic) {
    return "non_deterministic_replay";
  }
  if (
    prediction.home_team_id !== fixture.homeTeamId ||
    prediction.away_team_id !== fixture.awayTeamId
  ) {
    return "orientation_mismatch";
  }
  const kickoffShiftMinutes =
    Math.abs(
      parseInstant(prediction.kickoff_at_snapshot, "kickoff_at_snapshot") -
        effectiveKickoffMs(fixture),
    ) / 60_000;
  if (kickoffShiftMinutes > RESCHEDULE_TOLERANCE_MINUTES) {
    return "kickoff_rescheduled";
  }
  const informationMs = parseInstant(
    prediction.information_cutoff_at,
    "information_cutoff_at",
  );
  if (informationMs > deadlineMs) return "information_after_deadline";
  if (mode === "forward") {
    const issuedMs = parseInstant(prediction.issued_at, "issued_at");
    if (informationMs > issuedMs) return "information_after_issue";
    if (issuedMs > deadlineMs) return "issued_after_deadline";
  }
  return null;
}

/**
 * Selection rule v1. Input: every stored prediction for ONE fixture and ONE
 * (arm, arm_version, mode). Output: the single prediction to score.
 *
 * deadline = (actual kickoff, else scheduled kickoff) - safety margin.
 * A prediction is time-eligible when it belongs to this fixture/mode, matches
 * the fixture's home/away orientation, was made for this kickoff (within the
 * reschedule tolerance), used information no later than the deadline and
 * (forward mode) was issued no later than the deadline.
 *
 * Forward mode selects the latest issue time; replay mode (deterministic arms
 * recomputed from historical data) selects the latest information cutoff.
 * Ties break by later information cutoff, later recorded_at, then smallest id.
 * Validity is NOT a selection criterion: if the latest eligible record is an
 * "unavailable" prediction, that is what gets scored (as unavailable), so an
 * arm can never fall back to an earlier, luckier record after the fact.
 */
export function selectScoredPrediction(
  predictions: readonly StoredEvalPrediction[],
  fixture: FixtureForEvaluation,
  mode: EvaluationMode,
  safetyMarginMinutes = EVAL_SAFETY_MARGIN_MINUTES,
): SelectionResult {
  const deadlineMs = selectionDeadlineMs(fixture, safetyMarginMinutes);
  const deadline = new Date(deadlineMs).toISOString();
  const rejected: Array<{ id: string; reason: SelectionRejectionReason }> = [];
  const eligible: StoredEvalPrediction[] = [];

  for (const prediction of predictions) {
    const reason = rejection(prediction, fixture, mode, deadlineMs);
    if (reason) rejected.push({ id: prediction.id, reason });
    else eligible.push(prediction);
  }

  const key = (prediction: StoredEvalPrediction) =>
    mode === "forward"
      ? Date.parse(prediction.issued_at)
      : Date.parse(prediction.information_cutoff_at);

  eligible.sort(
    (a, b) =>
      key(b) - key(a) ||
      Date.parse(b.information_cutoff_at) - Date.parse(a.information_cutoff_at) ||
      Date.parse(b.recorded_at) - Date.parse(a.recorded_at) ||
      a.id.localeCompare(b.id),
  );

  const selected = eligible[0];
  if (!selected) return { status: "no_eligible_prediction", deadline, rejected };
  return { status: "selected", prediction: selected, deadline, rejected };
}

export function predictionProbabilities(
  prediction: StoredEvalPrediction,
): ThreeWayProbabilities | null {
  if (
    !prediction.valid ||
    prediction.p_home == null ||
    prediction.p_draw == null ||
    prediction.p_away == null
  ) {
    return null;
  }
  return {
    home: prediction.p_home,
    draw: prediction.p_draw,
    away: prediction.p_away,
  };
}
