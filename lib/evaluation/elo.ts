import {
  ageInDays,
  historyBeforeCutoff,
  parseInstant,
  type HistoricalMatchResult,
} from "./history";
import {
  computeLeagueBaseline,
  DEFAULT_LEAGUE_BASELINE_CONFIG,
  type LeagueBaselineConfig,
} from "./league-baseline";
import type { ThreeWayProbabilities } from "./probabilities";

export const KAPILOTO_PSTAT_VERSION = "kapiloto-pstat-elo-v1";

export type EloConfig = {
  initialRating: number;
  kFactor: number;
  /** A team's distance from the initial rating halves over this many idle days. */
  ratingDecayHalfLifeDays: number;
  lookbackDays: number;
  /** Rated league matches each side needs inside the lookback window. */
  minTeamMatches: number;
  /** Home-advantage and draw thresholds come from this league baseline. */
  baseline: LeagueBaselineConfig;
};

export const DEFAULT_ELO_CONFIG: EloConfig = {
  initialRating: 1500,
  kFactor: 20,
  ratingDecayHalfLifeDays: 365,
  lookbackDays: 1460,
  minTeamMatches: 5,
  baseline: DEFAULT_LEAGUE_BASELINE_CONFIG,
};

export type TeamRating = {
  rating: number;
  matches: number;
  lastMatchMs: number;
};

export type PStatUnavailableReason =
  | "neutral_venue_unsupported"
  | "insufficient_league_history"
  | "insufficient_team_history";

export type PStatResult =
  | {
      status: "available";
      version: typeof KAPILOTO_PSTAT_VERSION;
      probabilities: ThreeWayProbabilities;
      home: TeamRating;
      away: TeamRating;
      ratingDifference: number;
      homeAdvantage: number;
      slope: number;
      thresholds: { awayUpper: number; drawUpper: number };
      baseline: ThreeWayProbabilities;
      leagueMatches: number;
      config: EloConfig;
      usedMatches: HistoricalMatchResult[];
    }
  | {
      status: "unavailable";
      version: typeof KAPILOTO_PSTAT_VERSION;
      reason: PStatUnavailableReason;
      detail: Record<string, number | string | null>;
      config: EloConfig;
      usedMatches: HistoricalMatchResult[];
    };

const LN10 = Math.log(10);

function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function logit(p: number): number {
  return Math.log(p / (1 - p));
}

/** World Football Elo goal-difference multiplier. */
export function goalDifferenceMultiplier(goalDifference: number): number {
  const margin = Math.abs(goalDifference);
  if (margin <= 1) return 1;
  if (margin === 2) return 1.5;
  return (11 + margin) / 8;
}

export function eloExpectedHomeScore(
  homeRating: number,
  awayRating: number,
  homeAdvantage: number,
): number {
  return 1 / (1 + 10 ** (-(homeRating + homeAdvantage - awayRating) / 400));
}

/**
 * Home advantage in Elo points such that two equal teams have the league's
 * expected home score E = pH + pD/2:  HA = 400 * log10(E / (1 - E)).
 */
export function homeAdvantageFromBaseline(base: ThreeWayProbabilities): number {
  const expected = base.home + base.draw / 2;
  return 400 * Math.log10(expected / (1 - expected));
}

export function decayTowardInitial(
  rating: number,
  idleDays: number,
  config: Pick<EloConfig, "initialRating" | "ratingDecayHalfLifeDays">,
): number {
  const factor = 2 ** (-idleDays / config.ratingDecayHalfLifeDays);
  return config.initialRating + (rating - config.initialRating) * factor;
}

/**
 * Ordered-logit mapping from Elo difference to 1/X/2.
 *
 *   d       = (R_home - R_away) / 400        (home advantage lives in c1, c2)
 *   c1      = logit(pA_base), c2 = logit(pA_base + pD_base)
 *   P(2)    = sigma(c1 - s d)
 *   P(X)    = sigma(c2 - s d) - sigma(c1 - s d)
 *   P(1)    = 1 - sigma(c2 - s d)
 *
 * At d = 0 this reproduces the league baseline exactly. The slope s makes
 * dE/dd at d = 0 equal the Elo curve's slope at the same point,
 * ln(10) * E_b * (1 - E_b), so ratings and probabilities share one scale:
 *   s = 2 ln(10) E_b (1 - E_b) / (sigma'(c1) + sigma'(c2)).
 */
export function orderedLogitFromBaseline(base: ThreeWayProbabilities): {
  awayUpper: number;
  drawUpper: number;
  slope: number;
} {
  const awayUpper = logit(base.away);
  const drawUpper = logit(base.away + base.draw);
  const expected = base.home + base.draw / 2;
  const derivative = (p: number) => p * (1 - p);
  const slope =
    (2 * LN10 * expected * (1 - expected)) /
    (derivative(base.away) + derivative(base.away + base.draw));
  return { awayUpper, drawUpper, slope };
}

export function probabilitiesFromRatingDifference(
  ratingDifference: number,
  base: ThreeWayProbabilities,
): ThreeWayProbabilities {
  const { awayUpper, drawUpper, slope } = orderedLogitFromBaseline(base);
  const d = ratingDifference / 400;
  const away = logistic(awayUpper - slope * d);
  const awayOrDraw = logistic(drawUpper - slope * d);
  return {
    home: 1 - awayOrDraw,
    draw: awayOrDraw - away,
    away,
  };
}

/**
 * Chronological Elo fold over already cutoff-filtered, oldest-first matches.
 * Ratings decay toward the initial rating with idle time before every update.
 */
export function runEloRatings(
  matches: readonly HistoricalMatchResult[],
  homeAdvantage: number,
  config: EloConfig = DEFAULT_ELO_CONFIG,
): Map<string, TeamRating> {
  const ratings = new Map<string, TeamRating>();

  const current = (team: string, atMs: number): TeamRating => {
    const existing = ratings.get(team);
    if (!existing) {
      return { rating: config.initialRating, matches: 0, lastMatchMs: atMs };
    }
    return {
      ...existing,
      rating: decayTowardInitial(
        existing.rating,
        ageInDays(existing.lastMatchMs, atMs),
        config,
      ),
    };
  };

  for (const match of matches) {
    const atMs = Date.parse(match.kickoffAt);
    const home = current(match.homeTeamKey, atMs);
    const away = current(match.awayTeamKey, atMs);
    const advantage = match.neutralVenue ? 0 : homeAdvantage;
    const expected = eloExpectedHomeScore(home.rating, away.rating, advantage);
    const actual =
      match.homeGoals > match.awayGoals
        ? 1
        : match.homeGoals === match.awayGoals
          ? 0.5
          : 0;
    const delta =
      config.kFactor *
      goalDifferenceMultiplier(match.homeGoals - match.awayGoals) *
      (actual - expected);

    ratings.set(match.homeTeamKey, {
      rating: home.rating + delta,
      matches: home.matches + 1,
      lastMatchMs: atMs,
    });
    ratings.set(match.awayTeamKey, {
      rating: away.rating - delta,
      matches: away.matches + 1,
      lastMatchMs: atMs,
    });
  }

  return ratings;
}

/**
 * B3 p_stat: league-scoped Elo with league-derived home advantage and draw
 * thresholds. Pure function of history knowable at `cutoffAt`.
 */
export function computePStat(
  matches: readonly HistoricalMatchResult[],
  options: {
    competitionKey: string;
    homeTeamKey: string;
    awayTeamKey: string;
    cutoffAt: string;
    neutralVenue: boolean;
  },
  config: EloConfig = DEFAULT_ELO_CONFIG,
): PStatResult {
  const cutoffMs = parseInstant(options.cutoffAt, "cutoffAt");
  const used = historyBeforeCutoff(matches, {
    competitionKey: options.competitionKey,
    cutoffAt: options.cutoffAt,
    lookbackDays: config.lookbackDays,
  });

  const unavailable = (
    reason: PStatUnavailableReason,
    detail: Record<string, number | string | null>,
  ): PStatResult => ({
    status: "unavailable",
    version: KAPILOTO_PSTAT_VERSION,
    reason,
    detail,
    config,
    usedMatches: used,
  });

  if (options.neutralVenue) {
    return unavailable("neutral_venue_unsupported", {});
  }
  if (options.homeTeamKey === options.awayTeamKey) {
    throw new Error("p_stat requires two different teams.");
  }

  const baseline = computeLeagueBaseline(
    used,
    { competitionKey: options.competitionKey, cutoffAt: options.cutoffAt },
    config.baseline,
  );
  if (baseline.status !== "available") {
    return unavailable("insufficient_league_history", {
      league_matches: baseline.matches,
      effective_matches: baseline.effectiveMatches,
    });
  }

  const homeAdvantage = homeAdvantageFromBaseline(baseline.probabilities);
  const ratings = runEloRatings(used, homeAdvantage, config);
  const atCutoff = (team: string): TeamRating | null => {
    const rating = ratings.get(team);
    if (!rating) return null;
    return {
      ...rating,
      rating: decayTowardInitial(
        rating.rating,
        ageInDays(rating.lastMatchMs, cutoffMs),
        config,
      ),
    };
  };

  const home = atCutoff(options.homeTeamKey);
  const away = atCutoff(options.awayTeamKey);
  if (
    !home ||
    !away ||
    home.matches < config.minTeamMatches ||
    away.matches < config.minTeamMatches
  ) {
    return unavailable("insufficient_team_history", {
      home_matches: home?.matches ?? 0,
      away_matches: away?.matches ?? 0,
      required: config.minTeamMatches,
    });
  }

  const ratingDifference = home.rating - away.rating;
  const mapping = orderedLogitFromBaseline(baseline.probabilities);
  return {
    status: "available",
    version: KAPILOTO_PSTAT_VERSION,
    probabilities: probabilitiesFromRatingDifference(
      ratingDifference,
      baseline.probabilities,
    ),
    home,
    away,
    ratingDifference,
    homeAdvantage,
    slope: mapping.slope,
    thresholds: { awayUpper: mapping.awayUpper, drawUpper: mapping.drawUpper },
    baseline: baseline.probabilities,
    leagueMatches: baseline.matches,
    config,
    usedMatches: used,
  };
}
