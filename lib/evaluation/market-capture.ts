import type { ApiFootballRoundGame } from "@/lib/providers/api-football-sync";
import type {
  BookmakerThreeWayQuote,
  ProviderFixture,
  ProviderSpikeFixtureInput,
} from "@/lib/providers/types";

import { devig, DEVIG_METHOD_VERSIONS, overround, type DevigMethod } from "./devig";

export const KAPILOTO_MARKET_QUOTE_CAPTURE_VERSION =
  "kapiloto-market-quotes-capture-v1";

/** De-vig stored alongside each raw quote; B4 re-derives from raw odds. */
export const MARKET_QUOTE_DEVIG_METHOD: DevigMethod = "power";

export type MarketQuoteDraft = {
  fixture_id: string;
  provider: string;
  provider_fixture_id: string;
  provider_home_team_id: string;
  provider_away_team_id: string;
  bookmaker_id: string;
  bookmaker_name: string | null;
  market_type: "1x2_90m";
  odds_home: number;
  odds_draw: number;
  odds_away: number;
  overround: number;
  implied_home: number;
  implied_draw: number;
  implied_away: number;
  devig_method_version: string;
  source_updated_at: string | null;
  capture_version: string;
};

export interface MarketQuoteSource {
  resolveFixture(input: ProviderSpikeFixtureInput): Promise<{
    fixture: ProviderFixture | null;
    resolution: string;
  }>;
  getThreeWayQuotes(fixture: ProviderFixture): Promise<BookmakerThreeWayQuote[]>;
}

export interface MarketQuoteSink {
  saveQuotes(rows: MarketQuoteDraft[]): Promise<number>;
}

export type MarketQuoteCaptureResult = {
  gameNumber: number;
  fixtureId: string;
  status:
    | "saved"
    | "skipped_kickoff"
    | "not_found"
    | "orientation_mismatch"
    | "no_quotes"
    | "error";
  quotes: number;
  error: string | null;
};

function validIso(value: string | null): string | null {
  if (value == null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function marketQuoteDraft(
  fixtureId: string,
  fixture: ProviderFixture,
  quote: BookmakerThreeWayQuote,
): MarketQuoteDraft | null {
  if (quote.providerFixtureId !== fixture.providerFixtureId) return null;
  let probabilities;
  let margin;
  try {
    margin = overround(quote.odds);
    probabilities = devig(quote.odds, MARKET_QUOTE_DEVIG_METHOD);
  } catch {
    return null;
  }
  return {
    fixture_id: fixtureId,
    provider: quote.provider,
    provider_fixture_id: fixture.providerFixtureId,
    provider_home_team_id: fixture.home.id,
    provider_away_team_id: fixture.away.id,
    bookmaker_id: quote.bookmakerId,
    bookmaker_name: quote.bookmakerName || null,
    market_type: "1x2_90m",
    odds_home: quote.odds.home,
    odds_draw: quote.odds.draw,
    odds_away: quote.odds.away,
    overround: margin,
    implied_home: probabilities.home,
    implied_draw: probabilities.draw,
    implied_away: probabilities.away,
    devig_method_version: DEVIG_METHOD_VERSIONS[MARKET_QUOTE_DEVIG_METHOD],
    source_updated_at: validIso(quote.capturedAt),
    capture_version: KAPILOTO_MARKET_QUOTE_CAPTURE_VERSION,
  };
}

/**
 * Appends raw bookmaker quotes for a round to `fixture_market_quotes`.
 * It does not write `fixture_market_snapshots`, provider mappings or fixture
 * sync timestamps, so the production prior path is unaffected.
 */
export async function captureRoundMarketQuotes(
  games: readonly ApiFootballRoundGame[],
  source: MarketQuoteSource,
  sink: MarketQuoteSink,
  options: { clock?: () => Date; safetyWindowMinutes?: number } = {},
): Promise<MarketQuoteCaptureResult[]> {
  const clock = options.clock ?? (() => new Date());
  const safetyMs = (options.safetyWindowMinutes ?? 15) * 60_000;
  const results: MarketQuoteCaptureResult[] = [];

  for (const game of [...games].sort((a, b) => a.gameNumber - b.gameNumber)) {
    const base = { gameNumber: game.gameNumber, fixtureId: game.fixtureId };
    const kickoffMs = Date.parse(game.kickoffAt);
    if (!Number.isFinite(kickoffMs) || kickoffMs - clock().getTime() <= safetyMs) {
      results.push({ ...base, status: "skipped_kickoff", quotes: 0, error: null });
      continue;
    }

    try {
      const resolved = await source.resolveFixture({
        gameNumber: game.gameNumber,
        homeTeam: game.home.canonicalName,
        awayTeam: game.away.canonicalName,
        kickoffAt: game.kickoffAt,
        competition: game.competitionName,
        aliases: { home: game.home.aliases, away: game.away.aliases },
        apiFootballFixtureId: game.providerFixtureId ?? undefined,
      });
      const fixture = resolved.fixture;
      if (!fixture) {
        results.push({ ...base, status: "not_found", quotes: 0, error: resolved.resolution });
        continue;
      }
      if (
        (game.home.providerTeamId != null && game.home.providerTeamId !== fixture.home.id) ||
        (game.away.providerTeamId != null && game.away.providerTeamId !== fixture.away.id)
      ) {
        results.push({ ...base, status: "orientation_mismatch", quotes: 0, error: null });
        continue;
      }

      const drafts = (await source.getThreeWayQuotes(fixture))
        .map((quote) => marketQuoteDraft(game.fixtureId, fixture, quote))
        .filter((draft): draft is MarketQuoteDraft => draft != null);
      if (drafts.length === 0) {
        results.push({ ...base, status: "no_quotes", quotes: 0, error: null });
        continue;
      }
      const saved = await sink.saveQuotes(drafts);
      results.push({ ...base, status: "saved", quotes: saved, error: null });
    } catch (error) {
      results.push({
        ...base,
        status: "error",
        quotes: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}
