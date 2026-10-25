import { assertCutoffBeforeDeadline } from "@/lib/evaluation/arms";
import { computePStat, DEFAULT_ELO_CONFIG, type EloConfig } from "@/lib/evaluation/elo";
import { parseInstant, resultKnownAtMs, type HistoricalMatchResult } from "@/lib/evaluation/history";
import {
  computeLeagueBaseline,
  DEFAULT_LEAGUE_BASELINE_CONFIG,
  type LeagueBaselineConfig,
} from "@/lib/evaluation/league-baseline";
import {
  buildMarketPrior,
  DEFAULT_MARKET_PRIOR_CONFIG,
  type MarketPriorConfig,
  type MarketQuoteRecord,
} from "@/lib/evaluation/market-prior";

import type { ThreeWayProbabilities } from "./probability";
import { configProvenance, sha256Canonical, type ConfigProvenance, type VersionedConfig } from "./provenance";

/** Probability arms of the deterministic base. No arm is produced by a language model. */
export type BaseArmId = "p_league_base_v1" | "p_stat_elo_v1" | "p_stat_goal_model_v1" | "p_market_v1";
export type StatArmId = "p_stat_elo_v1" | "p_stat_goal_model_v1";

export type ArmResult =
  | {
      arm: BaseArmId;
      version: string;
      status: "available";
      probabilities: ThreeWayProbabilities;
      detail: Record<string, number | string | null>;
    }
  | {
      arm: BaseArmId;
      version: string;
      status: "unavailable";
      reason: string;
      detail: Record<string, number | string | null>;
    };

/** The fixture being forecast. It carries identity and schedule only, never a result. */
export type ResearchV2Fixture = {
  fixtureId: string;
  roundGameId: string | null;
  gameNumber: number | null;
  homeTeamId: string;
  awayTeamId: string;
  kickoffAt: string;
  neutralVenue: boolean;
  competitionKey: string | null;
  homeTeamKey: string | null;
  awayTeamKey: string | null;
};

/** Availability already known from structured data feeds (not from research). */
export type StructuredAvailability = {
  team: "home" | "away";
  playerKey: string;
  playerName: string;
  status: "out" | "suspended" | "doubtful";
  source: string;
};

export type DeterministicBaseInputs = {
  fixture: ResearchV2Fixture;
  informationCutoffAt: string;
  /** League results; only rows provably known before the cutoff are accepted. */
  history: HistoricalMatchResult[];
  /** Frozen quote set the market arm is built from. */
  marketSnapshotId: string | null;
  marketQuotes: MarketQuoteRecord[];
  structuredAvailability: StructuredAvailability[];
};

export type MarketQuality = "standard" | "thin" | "stale" | "missing";

export type MarketState = {
  quality: MarketQuality;
  snapshotId: string | null;
  /** Latest capture among quotes the market arm used (null when unavailable). */
  capturedAt: string | null;
  ageMinutesAtCutoff: number | null;
  bookmakers: number;
  reason: string | null;
};

export type DeterministicBaseConfig = VersionedConfig & {
  leagueBaseline: LeagueBaselineConfig;
  elo: EloConfig;
  marketPrior: MarketPriorConfig;
  /** Stat arms evaluated side by side; selection between them is deferred to forward evaluation. */
  statArms: StatArmId[];
};

export type DeterministicBase = {
  fixtureId: string;
  informationCutoffAt: string;
  arms: Record<BaseArmId, ArmResult>;
  market: MarketState;
  structuredAvailability: StructuredAvailability[];
  inputSha256: string;
  config: ConfigProvenance;
};

const FORBIDDEN_RESULT_KEY = /(score|goals|outcome|result|winner|settle|finished|full_?time|half_?time)/i;

/** Paths of result-like keys anywhere in a value (empty when clean). */
export function findResultLikeKeys(value: unknown, path = "$"): string[] {
  const found: string[] = [];
  scanForResultKeys(value, path, found);
  return found;
}

function scanForResultKeys(value: unknown, path: string, found: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForResultKeys(item, `${path}[${index}]`, found));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_RESULT_KEY.test(key)) found.push(`${path}.${key}`);
      scanForResultKeys(child, `${path}.${key}`, found);
    }
  }
}

/**
 * Rejects inputs that could carry the outcome of the fixture being forecast,
 * or any league result that was not knowable at the information cutoff.
 * Historical goals are the only result data allowed, and only through
 * `history`, and only for matches finished before the cutoff.
 */
export function assertNoResultLeakage(inputs: DeterministicBaseInputs): void {
  const found: string[] = [];
  scanForResultKeys(inputs.fixture, "fixture", found);
  scanForResultKeys(inputs.marketQuotes, "marketQuotes", found);
  scanForResultKeys(inputs.structuredAvailability, "structuredAvailability", found);
  if (found.length > 0) {
    throw new Error(`research_v2_result_leakage: result-like fields in inputs: ${found.join(", ")}`);
  }
  assertCutoffBeforeDeadline(inputs.fixture.kickoffAt, inputs.informationCutoffAt);
  const cutoffMs = parseInstant(inputs.informationCutoffAt, "informationCutoffAt");
  const targetKickoffMs = parseInstant(inputs.fixture.kickoffAt, "fixture.kickoffAt");
  for (const match of inputs.history) {
    if (resultKnownAtMs(match) > cutoffMs) {
      throw new Error(
        `research_v2_result_leakage: history ${match.provider}:${match.providerFixtureId} was not known at the cutoff`,
      );
    }
    if (Date.parse(match.kickoffAt) >= targetKickoffMs) {
      throw new Error(
        `research_v2_result_leakage: history ${match.provider}:${match.providerFixtureId} is not before the fixture`,
      );
    }
  }
}

function marketState(inputs: DeterministicBaseInputs, config: DeterministicBaseConfig) {
  const prior = buildMarketPrior(
    inputs.marketQuotes,
    { fixtureId: inputs.fixture.fixtureId, cutoffAt: inputs.informationCutoffAt },
    config.marketPrior,
  );
  if (prior.status === "unavailable") {
    const quality: MarketQuality = prior.reason === "stale_market" ? "stale" : "missing";
    return {
      prior,
      state: {
        quality,
        snapshotId: inputs.marketSnapshotId,
        capturedAt: null,
        ageMinutesAtCutoff: null,
        bookmakers: prior.usableBookmakers,
        reason: prior.reason,
      } satisfies MarketState,
    };
  }
  const capturedAt = prior.bookmakers.map((quote) => quote.capturedAt).sort().at(-1) ?? null;
  return {
    prior,
    state: {
      quality: prior.quality === "standard" ? "standard" : "thin",
      snapshotId: inputs.marketSnapshotId,
      capturedAt,
      ageMinutesAtCutoff:
        capturedAt == null
          ? null
          : Math.round((Date.parse(inputs.informationCutoffAt) - Date.parse(capturedAt)) / 60_000),
      bookmakers: prior.bookmakers.length,
      reason: prior.quality === "standard" ? null : "fewer_fresh_bookmakers_than_standard",
    } satisfies MarketState,
  };
}

/**
 * Stage 1: versioned deterministic probabilities for one fixture. A pure
 * function of the stored inputs and config; replaying the same inputs gives
 * bit-identical output.
 */
export function buildDeterministicBase(
  inputs: DeterministicBaseInputs,
  config: DeterministicBaseConfig,
): DeterministicBase {
  assertNoResultLeakage(inputs);
  const { fixture, informationCutoffAt: cutoffAt } = inputs;
  const arms = {} as Record<BaseArmId, ArmResult>;

  if (fixture.competitionKey) {
    const baseline = computeLeagueBaseline(
      inputs.history,
      { competitionKey: fixture.competitionKey, cutoffAt },
      config.leagueBaseline,
    );
    arms.p_league_base_v1 =
      baseline.status === "available"
        ? {
            arm: "p_league_base_v1",
            version: baseline.version,
            status: "available",
            probabilities: baseline.probabilities,
            detail: { matches: baseline.matches, effectiveMatches: baseline.effectiveMatches },
          }
        : {
            arm: "p_league_base_v1",
            version: baseline.version,
            status: "unavailable",
            reason: baseline.reason,
            detail: { matches: baseline.matches, effectiveMatches: baseline.effectiveMatches },
          };
  } else {
    arms.p_league_base_v1 = unavailable("p_league_base_v1", "kapiloto-league-base-v1", "competition_unmapped");
  }

  if (!config.statArms.includes("p_stat_elo_v1")) {
    arms.p_stat_elo_v1 = unavailable("p_stat_elo_v1", "kapiloto-pstat-elo-v1", "arm_disabled_by_config");
  } else if (!fixture.competitionKey || !fixture.homeTeamKey || !fixture.awayTeamKey) {
    arms.p_stat_elo_v1 = unavailable(
      "p_stat_elo_v1",
      "kapiloto-pstat-elo-v1",
      !fixture.competitionKey ? "competition_unmapped" : "team_unmapped",
    );
  } else {
    const pStat = computePStat(
      inputs.history,
      {
        competitionKey: fixture.competitionKey,
        homeTeamKey: fixture.homeTeamKey,
        awayTeamKey: fixture.awayTeamKey,
        cutoffAt,
        neutralVenue: fixture.neutralVenue,
      },
      config.elo,
    );
    arms.p_stat_elo_v1 =
      pStat.status === "available"
        ? {
            arm: "p_stat_elo_v1",
            version: pStat.version,
            status: "available",
            probabilities: pStat.probabilities,
            detail: {
              homeRating: pStat.home.rating,
              awayRating: pStat.away.rating,
              homeMatches: pStat.home.matches,
              awayMatches: pStat.away.matches,
              ratingDifference: pStat.ratingDifference,
              leagueMatches: pStat.leagueMatches,
            },
          }
        : {
            arm: "p_stat_elo_v1",
            version: pStat.version,
            status: "unavailable",
            reason: pStat.reason,
            detail: pStat.detail,
          };
  }

  // Interface slot for a future Dixon-Coles / Poisson goal model. It runs as
  // a separate stat arm; until it exists it is explicitly unavailable.
  arms.p_stat_goal_model_v1 = unavailable(
    "p_stat_goal_model_v1",
    "kapiloto-pstat-goal-model-v1",
    config.statArms.includes("p_stat_goal_model_v1") ? "not_implemented" : "arm_disabled_by_config",
  );

  const market = marketState(inputs, config);
  arms.p_market_v1 =
    market.prior.status === "available"
      ? {
          arm: "p_market_v1",
          version: market.prior.version,
          status: "available",
          probabilities: market.prior.probabilities,
          detail: {
            quality: market.prior.quality,
            bookmakers: market.prior.bookmakers.length,
            devigMethodVersion: market.prior.devigMethodVersion,
          },
        }
      : {
          arm: "p_market_v1",
          version: market.prior.version,
          status: "unavailable",
          reason: market.prior.reason,
          detail: { usableBookmakers: market.prior.usableBookmakers },
        };

  return {
    fixtureId: fixture.fixtureId,
    informationCutoffAt: cutoffAt,
    arms,
    market: market.state,
    structuredAvailability: inputs.structuredAvailability,
    inputSha256: sha256Canonical(inputs),
    config: configProvenance(config),
  };
}

function unavailable(arm: BaseArmId, version: string, reason: string): ArmResult {
  return { arm, version, status: "unavailable", reason, detail: {} };
}

export const CANDIDATE_DETERMINISTIC_BASE_CONFIG: DeterministicBaseConfig = {
  id: "research-v2-deterministic-base",
  version: "base-v1",
  status: "candidate",
  leagueBaseline: DEFAULT_LEAGUE_BASELINE_CONFIG,
  elo: DEFAULT_ELO_CONFIG,
  marketPrior: DEFAULT_MARKET_PRIOR_CONFIG,
  statArms: ["p_stat_elo_v1", "p_stat_goal_model_v1"],
};
