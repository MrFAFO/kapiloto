import {
  ageInDays,
  historyBeforeCutoff,
  matchOutcome,
  parseInstant,
  type HistoricalMatchResult,
} from "./history";
import type { ThreeWayProbabilities } from "./probabilities";

export const KAPILOTO_LEAGUE_BASELINE_VERSION = "kapiloto-league-base-v1";

export type LeagueBaselineConfig = {
  /** Matches older than this (relative to the cutoff) are ignored. */
  lookbackDays: number;
  /** Exponential recency weight: a match this old counts half. */
  halfLifeDays: number;
  /** Kish effective sample size required before rates are published. */
  minEffectiveMatches: number;
  /** Additive pseudo-count per outcome, applied to weighted counts. */
  pseudoCountPerOutcome: number;
};

export const DEFAULT_LEAGUE_BASELINE_CONFIG: LeagueBaselineConfig = {
  lookbackDays: 1095,
  halfLifeDays: 730,
  minEffectiveMatches: 100,
  pseudoCountPerOutcome: 1,
};

export type LeagueBaselineResult =
  | {
      status: "available";
      version: typeof KAPILOTO_LEAGUE_BASELINE_VERSION;
      probabilities: ThreeWayProbabilities;
      matches: number;
      effectiveMatches: number;
      weightedCounts: ThreeWayProbabilities;
      config: LeagueBaselineConfig;
      usedMatches: HistoricalMatchResult[];
    }
  | {
      status: "unavailable";
      version: typeof KAPILOTO_LEAGUE_BASELINE_VERSION;
      reason: "insufficient_league_history";
      matches: number;
      effectiveMatches: number;
      config: LeagueBaselineConfig;
      usedMatches: HistoricalMatchResult[];
    };

export function recencyWeight(ageDays: number, halfLifeDays: number): number {
  return 2 ** (-ageDays / halfLifeDays);
}

/**
 * B2: recency-weighted home/draw/away rates of one competition, using only
 * results knowable at the cutoff. Neutral-venue matches are excluded because
 * they carry no home advantage.
 *
 *   w_i   = 2^(-age_i / halfLife)
 *   p_k   = (sum_i w_i [y_i = k] + c) / (sum_i w_i + 3c)
 *   n_eff = (sum_i w_i)^2 / sum_i w_i^2
 */
export function computeLeagueBaseline(
  matches: readonly HistoricalMatchResult[],
  options: { competitionKey: string; cutoffAt: string },
  config: LeagueBaselineConfig = DEFAULT_LEAGUE_BASELINE_CONFIG,
): LeagueBaselineResult {
  const cutoffMs = parseInstant(options.cutoffAt, "cutoffAt");
  const used = historyBeforeCutoff(matches, {
    competitionKey: options.competitionKey,
    cutoffAt: options.cutoffAt,
    lookbackDays: config.lookbackDays,
  }).filter((match) => !match.neutralVenue);

  const counts = { home: 0, draw: 0, away: 0 };
  let weightSum = 0;
  let weightSquares = 0;
  for (const match of used) {
    const weight = recencyWeight(
      ageInDays(Date.parse(match.kickoffAt), cutoffMs),
      config.halfLifeDays,
    );
    weightSum += weight;
    weightSquares += weight * weight;
    const outcome = matchOutcome(match);
    if (outcome === "1") counts.home += weight;
    else if (outcome === "X") counts.draw += weight;
    else counts.away += weight;
  }

  const effectiveMatches =
    weightSquares > 0 ? (weightSum * weightSum) / weightSquares : 0;

  if (effectiveMatches < config.minEffectiveMatches) {
    return {
      status: "unavailable",
      version: KAPILOTO_LEAGUE_BASELINE_VERSION,
      reason: "insufficient_league_history",
      matches: used.length,
      effectiveMatches,
      config,
      usedMatches: used,
    };
  }

  const c = config.pseudoCountPerOutcome;
  const denominator = weightSum + 3 * c;
  return {
    status: "available",
    version: KAPILOTO_LEAGUE_BASELINE_VERSION,
    probabilities: {
      home: (counts.home + c) / denominator,
      draw: (counts.draw + c) / denominator,
      away: (counts.away + c) / denominator,
    },
    matches: used.length,
    effectiveMatches,
    weightedCounts: counts,
    config,
    usedMatches: used,
  };
}
