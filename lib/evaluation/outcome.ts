import type { Outcome } from "./probabilities";
import type { FixtureForEvaluation } from "./selection";

export const KAPILOTO_EVAL_OUTCOME_SOURCE = "fixtures.regular_time_score";

export type EvaluationOutcome =
  | { status: "final"; outcome: Outcome; homeGoals: number; awayGoals: number }
  | { status: "void"; reason: "cancelled" }
  | { status: "not_final"; reason: string };

/**
 * The evaluated quantity is the 90-minute field result of the canonical
 * fixture. Live sync stores the regular-time score on `fixtures` once a match
 * is finished (extra time and penalties excluded). Toto pool settlement is a
 * different quantity and is never read here.
 */
export function resolveNinetyMinuteOutcome(
  fixture: FixtureForEvaluation,
): EvaluationOutcome {
  if (fixture.status === "cancelled") return { status: "void", reason: "cancelled" };
  if (fixture.status !== "finished") {
    return { status: "not_final", reason: `status_${fixture.status}` };
  }
  const { homeScore, awayScore } = fixture;
  if (
    homeScore == null ||
    awayScore == null ||
    !Number.isInteger(homeScore) ||
    !Number.isInteger(awayScore) ||
    homeScore < 0 ||
    awayScore < 0
  ) {
    return { status: "not_final", reason: "score_missing" };
  }
  return {
    status: "final",
    outcome: homeScore > awayScore ? "1" : homeScore < awayScore ? "2" : "X",
    homeGoals: homeScore,
    awayGoals: awayScore,
  };
}
