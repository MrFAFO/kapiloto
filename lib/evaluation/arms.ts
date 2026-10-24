import { sha256Hex } from "@/lib/kapiloto/snapshot";

import {
  computePStat,
  DEFAULT_ELO_CONFIG,
  KAPILOTO_PSTAT_VERSION,
  type EloConfig,
} from "./elo";
import { historyFingerprint, parseInstant, type HistoricalMatchResult } from "./history";
import {
  computeLeagueBaseline,
  DEFAULT_LEAGUE_BASELINE_CONFIG,
  KAPILOTO_LEAGUE_BASELINE_VERSION,
  type LeagueBaselineConfig,
} from "./league-baseline";
import {
  buildMarketPrior,
  DEFAULT_MARKET_PRIOR_CONFIG,
  type MarketPriorConfig,
  type MarketQuoteRecord,
} from "./market-prior";
import { assertValidProbabilities, type ThreeWayProbabilities } from "./probabilities";

/**
 * Arms are open-ended text identifiers so new arms need no schema change. The
 * database enforces only the identifier shape.
 */
export const EVAL_ARM = {
  uniform: "uniform",
  leagueBase: "league_base",
  pStat: "p_stat",
  market: "market",
  kapilotoPublished: "kapiloto_published",
  kapilotoSol: "kapiloto_sol",
} as const;

export const EVAL_ARM_PATTERN = /^[a-z][a-z0-9_]{1,62}$/;

export const UNIFORM_ARM_VERSION = "kapiloto-uniform-v1";

/** Matches the research/sync kickoff safety window. */
export const EVAL_SAFETY_MARGIN_MINUTES = 15;

export type EvaluationMode = "forward" | "replay";

export type EvalPredictionDraft = {
  fixture_id: string;
  round_game_id: string | null;
  arm: string;
  arm_version: string;
  evaluation_mode: EvaluationMode;
  deterministic: boolean;
  information_cutoff_at: string;
  issued_at_source: "recorded" | "kapiloto_publication";
  source_analysis_id: string | null;
  kickoff_at_snapshot: string;
  home_team_id: string;
  away_team_id: string;
  valid: boolean;
  invalid_reason: string | null;
  p_home: number | null;
  p_draw: number | null;
  p_away: number | null;
  basis: Record<string, unknown>;
  input_sha256: string;
};

/** Canonical fixture identity plus the provider keys used to read history. */
export type ShadowFixtureContext = {
  fixtureId: string;
  roundGameId: string | null;
  homeTeamId: string;
  awayTeamId: string;
  kickoffAt: string;
  neutralVenue: boolean;
  competitionKey: string | null;
  homeTeamKey: string | null;
  awayTeamKey: string | null;
};

export type DeterministicArmConfig = {
  leagueBaseline: LeagueBaselineConfig;
  elo: EloConfig;
  market: MarketPriorConfig;
};

export const DEFAULT_DETERMINISTIC_ARM_CONFIG: DeterministicArmConfig = {
  leagueBaseline: DEFAULT_LEAGUE_BASELINE_CONFIG,
  elo: DEFAULT_ELO_CONFIG,
  market: DEFAULT_MARKET_PRIOR_CONFIG,
};

/** History lookback the store must load to serve every deterministic arm. */
export function requiredHistoryLookbackDays(
  config: DeterministicArmConfig = DEFAULT_DETERMINISTIC_ARM_CONFIG,
): number {
  return Math.max(config.leagueBaseline.lookbackDays, config.elo.lookbackDays);
}

export function assertCutoffBeforeDeadline(
  kickoffAt: string,
  cutoffAt: string,
  safetyMarginMinutes = EVAL_SAFETY_MARGIN_MINUTES,
): void {
  const deadline =
    parseInstant(kickoffAt, "kickoffAt") - safetyMarginMinutes * 60_000;
  if (parseInstant(cutoffAt, "cutoffAt") > deadline) {
    throw new Error(
      "Shadow prediction cutoff is after kickoff minus the safety margin.",
    );
  }
}

type DraftCore = Pick<
  EvalPredictionDraft,
  | "fixture_id"
  | "round_game_id"
  | "evaluation_mode"
  | "information_cutoff_at"
  | "kickoff_at_snapshot"
  | "home_team_id"
  | "away_team_id"
>;

function draft(
  core: DraftCore,
  arm: string,
  armVersion: string,
  result:
    | { valid: true; probabilities: ThreeWayProbabilities }
    | { valid: false; reason: string },
  basis: Record<string, unknown>,
  inputs: unknown,
): EvalPredictionDraft {
  if (!EVAL_ARM_PATTERN.test(arm)) throw new Error(`Invalid arm id: ${arm}`);
  if (result.valid) assertValidProbabilities(result.probabilities, arm);
  return {
    ...core,
    arm,
    arm_version: armVersion,
    deterministic: true,
    issued_at_source: "recorded",
    source_analysis_id: null,
    valid: result.valid,
    invalid_reason: result.valid ? null : result.reason,
    p_home: result.valid ? result.probabilities.home : null,
    p_draw: result.valid ? result.probabilities.draw : null,
    p_away: result.valid ? result.probabilities.away : null,
    basis,
    input_sha256: sha256Hex({
      arm,
      arm_version: armVersion,
      fixture_id: core.fixture_id,
      information_cutoff_at: core.information_cutoff_at,
      home_team_id: core.home_team_id,
      away_team_id: core.away_team_id,
      inputs,
    }),
  };
}

/**
 * B1-B4 for one fixture at one information cutoff. Pure: every input is
 * passed in, and history/quotes after the cutoff are filtered by the arm
 * implementations, not trusted from the caller.
 */
export function buildDeterministicArmPredictions(input: {
  context: ShadowFixtureContext;
  cutoffAt: string;
  mode: EvaluationMode;
  history: readonly HistoricalMatchResult[];
  quotes: readonly MarketQuoteRecord[];
  config?: DeterministicArmConfig;
}): EvalPredictionDraft[] {
  const config = input.config ?? DEFAULT_DETERMINISTIC_ARM_CONFIG;
  const { context } = input;
  const cutoffAt = new Date(parseInstant(input.cutoffAt, "cutoffAt")).toISOString();
  assertCutoffBeforeDeadline(context.kickoffAt, cutoffAt);

  const core: DraftCore = {
    fixture_id: context.fixtureId,
    round_game_id: context.roundGameId,
    evaluation_mode: input.mode,
    information_cutoff_at: cutoffAt,
    kickoff_at_snapshot: context.kickoffAt,
    home_team_id: context.homeTeamId,
    away_team_id: context.awayTeamId,
  };
  const drafts: EvalPredictionDraft[] = [];

  drafts.push(
    draft(
      core,
      EVAL_ARM.uniform,
      UNIFORM_ARM_VERSION,
      { valid: true, probabilities: { home: 1 / 3, draw: 1 / 3, away: 1 / 3 } },
      { method: "uniform" },
      null,
    ),
  );

  if (!context.competitionKey) {
    drafts.push(
      draft(core, EVAL_ARM.leagueBase, KAPILOTO_LEAGUE_BASELINE_VERSION, {
        valid: false,
        reason: "competition_unmapped",
      }, {}, null),
    );
  } else {
    const baseline = computeLeagueBaseline(
      input.history,
      { competitionKey: context.competitionKey, cutoffAt },
      config.leagueBaseline,
    );
    const inputs = {
      competition_key: context.competitionKey,
      config: config.leagueBaseline,
      history: historyFingerprint(baseline.usedMatches),
    };
    const basis = {
      competition_key: context.competitionKey,
      matches: baseline.matches,
      effective_matches: baseline.effectiveMatches,
      config: config.leagueBaseline,
      ...(baseline.status === "available"
        ? { weighted_counts: baseline.weightedCounts }
        : {}),
    };
    drafts.push(
      draft(
        core,
        EVAL_ARM.leagueBase,
        baseline.version,
        baseline.status === "available"
          ? { valid: true, probabilities: baseline.probabilities }
          : { valid: false, reason: baseline.reason },
        basis,
        inputs,
      ),
    );
  }

  if (!context.competitionKey || !context.homeTeamKey || !context.awayTeamKey) {
    drafts.push(
      draft(core, EVAL_ARM.pStat, KAPILOTO_PSTAT_VERSION, {
        valid: false,
        reason: !context.competitionKey ? "competition_unmapped" : "team_unmapped",
      }, {}, null),
    );
  } else {
    const pStat = computePStat(
      input.history,
      {
        competitionKey: context.competitionKey,
        homeTeamKey: context.homeTeamKey,
        awayTeamKey: context.awayTeamKey,
        cutoffAt,
        neutralVenue: context.neutralVenue,
      },
      config.elo,
    );
    const inputs = {
      competition_key: context.competitionKey,
      home_team_key: context.homeTeamKey,
      away_team_key: context.awayTeamKey,
      neutral_venue: context.neutralVenue,
      config: config.elo,
      history: historyFingerprint(pStat.usedMatches),
    };
    const basis =
      pStat.status === "available"
        ? {
            competition_key: context.competitionKey,
            home_team_key: context.homeTeamKey,
            away_team_key: context.awayTeamKey,
            home_rating: pStat.home.rating,
            away_rating: pStat.away.rating,
            home_rated_matches: pStat.home.matches,
            away_rated_matches: pStat.away.matches,
            rating_difference: pStat.ratingDifference,
            home_advantage: pStat.homeAdvantage,
            slope: pStat.slope,
            thresholds: pStat.thresholds,
            league_baseline: pStat.baseline,
            league_matches: pStat.leagueMatches,
            config: pStat.config,
          }
        : {
            competition_key: context.competitionKey,
            home_team_key: context.homeTeamKey,
            away_team_key: context.awayTeamKey,
            detail: pStat.detail,
            config: pStat.config,
          };
    drafts.push(
      draft(
        core,
        EVAL_ARM.pStat,
        pStat.version,
        pStat.status === "available"
          ? { valid: true, probabilities: pStat.probabilities }
          : { valid: false, reason: pStat.reason },
        basis,
        inputs,
      ),
    );
  }

  const market = buildMarketPrior(
    input.quotes,
    { fixtureId: context.fixtureId, cutoffAt },
    config.market,
  );
  const usedQuoteIds =
    market.status === "available"
      ? market.bookmakers.map((quote) => quote.quoteId)
      : [];
  drafts.push(
    draft(
      core,
      EVAL_ARM.market,
      `${market.version};${market.devigMethodVersion}`,
      market.status === "available"
        ? { valid: true, probabilities: market.probabilities }
        : { valid: false, reason: market.reason },
      market.status === "available"
        ? {
            quality: market.quality,
            devig_method: market.devigMethodVersion,
            bookmakers: market.bookmakers,
            excluded: market.excluded,
            config: market.config,
          }
        : {
            devig_method: market.devigMethodVersion,
            usable_bookmakers: market.usableBookmakers,
            excluded: market.excluded,
            config: market.config,
          },
      {
        config: config.market,
        quotes: input.quotes
          .filter((quote) => usedQuoteIds.includes(quote.id))
          .map((quote) => [quote.id, quote.capturedAt, quote.odds])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      },
    ),
  );

  return drafts;
}
