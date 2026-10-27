import {
  DEFAULT_DETERMINISTIC_ARM_CONFIG,
  EVAL_ARM,
  EVAL_SAFETY_MARGIN_MINUTES,
  UNIFORM_ARM_VERSION,
  type DeterministicArmConfig,
} from "./arms";
import { computePStat, KAPILOTO_PSTAT_VERSION } from "./elo";
import { matchOutcome, parseInstant, type HistoricalMatchResult } from "./history";
import {
  computeLeagueBaseline,
  KAPILOTO_LEAGUE_BASELINE_VERSION,
} from "./league-baseline";
import { scorePrediction, summarizeScores, type FixtureScore, type ScoreSummary } from "./metrics";
import type { ThreeWayProbabilities } from "./probabilities";

export type BacktestArmSummary = {
  arm: string;
  armVersion: string;
  targets: number;
  scored: number;
  unavailable: Record<string, number>;
  metrics: ScoreSummary | null;
};

/**
 * In-memory historical replay of the deterministic arms (B1-B3) over stored
 * league results. Each target match is predicted at kickoff - safety margin
 * using only results knowable at that instant, then scored on its 90-minute
 * result. LLM and market arms are deliberately excluded: they cannot be
 * reconstructed honestly after the fact. Results are not persisted because
 * historical league matches have no canonical fixture rows.
 */
export function backtestDeterministicArms(
  history: readonly HistoricalMatchResult[],
  options: {
    competitionKey: string;
    fromAt: string;
    toAt: string;
    config?: DeterministicArmConfig;
  },
): { summaries: BacktestArmSummary[]; perFixture: Map<string, Map<string, FixtureScore>> } {
  const config = options.config ?? DEFAULT_DETERMINISTIC_ARM_CONFIG;
  const fromMs = parseInstant(options.fromAt, "fromAt");
  const toMs = parseInstant(options.toAt, "toAt");
  const targets = history
    .filter((match) => {
      const kickoffMs = Date.parse(match.kickoffAt);
      return (
        match.competitionKey === options.competitionKey &&
        !match.neutralVenue &&
        kickoffMs >= fromMs &&
        kickoffMs < toMs
      );
    })
    .sort(
      (a, b) =>
        Date.parse(a.kickoffAt) - Date.parse(b.kickoffAt) ||
        a.providerFixtureId.localeCompare(b.providerFixtureId),
    );

  const arms = [
    { arm: EVAL_ARM.uniform, armVersion: UNIFORM_ARM_VERSION },
    { arm: EVAL_ARM.leagueBase, armVersion: KAPILOTO_LEAGUE_BASELINE_VERSION },
    { arm: EVAL_ARM.pStat, armVersion: KAPILOTO_PSTAT_VERSION },
  ];
  const scores = new Map<string, FixtureScore[]>(arms.map(({ arm }) => [arm, []]));
  const unavailable = new Map<string, Record<string, number>>(
    arms.map(({ arm }) => [arm, {}]),
  );
  const perFixture = new Map<string, Map<string, FixtureScore>>();

  const record = (
    arm: string,
    fixtureKey: string,
    result: { probabilities: ThreeWayProbabilities } | { reason: string },
    match: HistoricalMatchResult,
  ) => {
    if ("reason" in result) {
      const counts = unavailable.get(arm) as Record<string, number>;
      counts[result.reason] = (counts[result.reason] ?? 0) + 1;
      return;
    }
    const score = scorePrediction(result.probabilities, matchOutcome(match));
    scores.get(arm)?.push(score);
    const fixtureScores = perFixture.get(fixtureKey) ?? new Map<string, FixtureScore>();
    fixtureScores.set(arm, score);
    perFixture.set(fixtureKey, fixtureScores);
  };

  for (const match of targets) {
    const cutoffAt = new Date(
      Date.parse(match.kickoffAt) - EVAL_SAFETY_MARGIN_MINUTES * 60_000,
    ).toISOString();
    const fixtureKey = `${match.provider}:${match.providerFixtureId}`;

    record(EVAL_ARM.uniform, fixtureKey, {
      probabilities: { home: 1 / 3, draw: 1 / 3, away: 1 / 3 },
    }, match);

    const baseline = computeLeagueBaseline(
      history,
      { competitionKey: options.competitionKey, cutoffAt },
      config.leagueBaseline,
    );
    record(
      EVAL_ARM.leagueBase,
      fixtureKey,
      baseline.status === "available"
        ? { probabilities: baseline.probabilities }
        : { reason: baseline.reason },
      match,
    );

    const pStat = computePStat(
      history,
      {
        competitionKey: options.competitionKey,
        homeTeamKey: match.homeTeamKey,
        awayTeamKey: match.awayTeamKey,
        cutoffAt,
        neutralVenue: false,
      },
      config.elo,
    );
    record(
      EVAL_ARM.pStat,
      fixtureKey,
      pStat.status === "available"
        ? { probabilities: pStat.probabilities }
        : { reason: pStat.reason },
      match,
    );
  }

  return {
    summaries: arms.map(({ arm, armVersion }) => ({
      arm,
      armVersion,
      targets: targets.length,
      scored: scores.get(arm)?.length ?? 0,
      unavailable: unavailable.get(arm) ?? {},
      metrics: summarizeScores(scores.get(arm) ?? []),
    })),
    perFixture,
  };
}
