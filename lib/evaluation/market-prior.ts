import {
  devig,
  DEVIG_METHOD_VERSIONS,
  overround,
  type DecimalOdds,
  type DevigMethod,
} from "./devig";
import { parseInstant } from "./history";
import { normalizeProbabilities, type ThreeWayProbabilities } from "./probabilities";

export const KAPILOTO_MARKET_PRIOR_VERSION = "kapiloto-market-prior-v1";

/** One bookmaker's complete 1/X/2 price as captured by Kapiloto. */
export type MarketQuoteRecord = {
  id: string;
  fixtureId: string;
  provider: string;
  bookmakerId: string;
  bookmakerName: string;
  /** Server capture time (database-stamped). Freshness is measured from here. */
  capturedAt: string;
  /** The provider's own last-update time, when supplied. */
  sourceUpdatedAt: string | null;
  odds: DecimalOdds;
};

export type MarketPriorConfig = {
  devigMethod: DevigMethod;
  /** Quotes older than this at the cutoff are stale and never used. */
  maxQuoteAgeMinutes: number;
  /** Quotes at most this old qualify for the `standard` quality label. */
  freshQuoteAgeMinutes: number;
  /** Distinct bookmakers required for any market prediction. */
  minBookmakers: number;
  /** Distinct fresh bookmakers required for the `standard` quality label. */
  standardMinBookmakers: number;
  minOverround: number;
  maxOverround: number;
};

export const DEFAULT_MARKET_PRIOR_CONFIG: MarketPriorConfig = {
  devigMethod: "power",
  maxQuoteAgeMinutes: 24 * 60,
  freshQuoteAgeMinutes: 6 * 60,
  minBookmakers: 2,
  standardMinBookmakers: 3,
  minOverround: 0,
  maxOverround: 0.25,
};

export type MarketQuoteExclusionReason =
  | "wrong_fixture"
  | "captured_after_cutoff"
  | "source_updated_after_cutoff"
  | "superseded_by_newer_quote"
  | "stale"
  | "invalid_odds"
  | "implausible_overround";

export type UsedMarketQuote = {
  quoteId: string;
  bookmakerKey: string;
  capturedAt: string;
  ageMinutes: number;
  overround: number;
  probabilities: ThreeWayProbabilities;
};

export type MarketPriorResult =
  | {
      status: "available";
      version: typeof KAPILOTO_MARKET_PRIOR_VERSION;
      devigMethodVersion: string;
      probabilities: ThreeWayProbabilities;
      quality: "standard" | "thin";
      bookmakers: UsedMarketQuote[];
      excluded: Array<{ quoteId: string; reason: MarketQuoteExclusionReason }>;
      config: MarketPriorConfig;
    }
  | {
      status: "unavailable";
      version: typeof KAPILOTO_MARKET_PRIOR_VERSION;
      devigMethodVersion: string;
      reason: "no_quotes_before_cutoff" | "stale_market" | "insufficient_bookmakers";
      usableBookmakers: number;
      excluded: Array<{ quoteId: string; reason: MarketQuoteExclusionReason }>;
      config: MarketPriorConfig;
    };

function median(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

/**
 * B4: de-vigged consensus of the latest pre-cutoff quote per bookmaker.
 *
 * Eligibility (market-prior-v1):
 * - only quotes captured (and provider-updated) at or before the cutoff;
 * - the latest such quote per provider+bookmaker;
 * - age at the cutoff <= maxQuoteAgeMinutes;
 * - complete, valid 1/X/2 decimal odds with a plausible overround;
 * - at least minBookmakers distinct bookmakers, otherwise no prediction.
 *
 * Each bookmaker is de-vigged individually, the per-outcome median is taken
 * and renormalized. `standard` quality additionally needs
 * standardMinBookmakers bookmakers all within freshQuoteAgeMinutes.
 */
export function buildMarketPrior(
  quotes: readonly MarketQuoteRecord[],
  options: { fixtureId: string; cutoffAt: string },
  config: MarketPriorConfig = DEFAULT_MARKET_PRIOR_CONFIG,
): MarketPriorResult {
  const cutoffMs = parseInstant(options.cutoffAt, "cutoffAt");
  const devigMethodVersion = DEVIG_METHOD_VERSIONS[config.devigMethod];
  const excluded: Array<{ quoteId: string; reason: MarketQuoteExclusionReason }> = [];
  const latestByBookmaker = new Map<string, MarketQuoteRecord>();
  let sawPreCutoffQuote = false;

  const ordered = [...quotes].sort((a, b) => a.id.localeCompare(b.id));
  for (const quote of ordered) {
    if (quote.fixtureId !== options.fixtureId) {
      excluded.push({ quoteId: quote.id, reason: "wrong_fixture" });
      continue;
    }
    const capturedMs = parseInstant(quote.capturedAt, "capturedAt");
    if (capturedMs > cutoffMs) {
      excluded.push({ quoteId: quote.id, reason: "captured_after_cutoff" });
      continue;
    }
    if (
      quote.sourceUpdatedAt != null &&
      parseInstant(quote.sourceUpdatedAt, "sourceUpdatedAt") > cutoffMs
    ) {
      excluded.push({ quoteId: quote.id, reason: "source_updated_after_cutoff" });
      continue;
    }
    sawPreCutoffQuote = true;
    const key = `${quote.provider}:${quote.bookmakerId}`;
    const existing = latestByBookmaker.get(key);
    if (!existing || Date.parse(existing.capturedAt) < capturedMs) {
      if (existing) {
        excluded.push({ quoteId: existing.id, reason: "superseded_by_newer_quote" });
      }
      latestByBookmaker.set(key, quote);
    } else {
      excluded.push({ quoteId: quote.id, reason: "superseded_by_newer_quote" });
    }
  }

  const used: UsedMarketQuote[] = [];
  let staleCount = 0;
  for (const [bookmakerKey, quote] of [...latestByBookmaker.entries()].sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const ageMinutes = (cutoffMs - Date.parse(quote.capturedAt)) / 60_000;
    if (ageMinutes > config.maxQuoteAgeMinutes) {
      staleCount += 1;
      excluded.push({ quoteId: quote.id, reason: "stale" });
      continue;
    }
    let margin: number;
    let probabilities: ThreeWayProbabilities;
    try {
      margin = overround(quote.odds);
    } catch {
      excluded.push({ quoteId: quote.id, reason: "invalid_odds" });
      continue;
    }
    if (margin < config.minOverround || margin > config.maxOverround) {
      excluded.push({ quoteId: quote.id, reason: "implausible_overround" });
      continue;
    }
    try {
      probabilities = devig(quote.odds, config.devigMethod);
    } catch {
      excluded.push({ quoteId: quote.id, reason: "invalid_odds" });
      continue;
    }
    used.push({
      quoteId: quote.id,
      bookmakerKey,
      capturedAt: quote.capturedAt,
      ageMinutes,
      overround: margin,
      probabilities,
    });
  }

  if (used.length < config.minBookmakers) {
    return {
      status: "unavailable",
      version: KAPILOTO_MARKET_PRIOR_VERSION,
      devigMethodVersion,
      reason: !sawPreCutoffQuote
        ? "no_quotes_before_cutoff"
        : staleCount > 0 && used.length === 0
          ? "stale_market"
          : "insufficient_bookmakers",
      usableBookmakers: used.length,
      excluded,
      config,
    };
  }

  const probabilities = normalizeProbabilities({
    home: median(used.map((quote) => quote.probabilities.home)),
    draw: median(used.map((quote) => quote.probabilities.draw)),
    away: median(used.map((quote) => quote.probabilities.away)),
  });
  const allFresh = used.every(
    (quote) => quote.ageMinutes <= config.freshQuoteAgeMinutes,
  );

  return {
    status: "available",
    version: KAPILOTO_MARKET_PRIOR_VERSION,
    devigMethodVersion,
    probabilities,
    quality:
      used.length >= config.standardMinBookmakers && allFresh ? "standard" : "thin",
    bookmakers: used,
    excluded,
    config,
  };
}
