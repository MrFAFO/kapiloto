import type { ApiFootballRoundGame } from "@/lib/providers/api-football-sync";
import type {
  BookmakerThreeWayQuote,
  ProviderFixture,
  ProviderSpikeFixtureInput,
} from "@/lib/providers/types";

import { devig, DEVIG_METHOD_VERSIONS, overround, type DevigMethod } from "./devig";
import {
  isDue,
  planCaptures,
  type CadenceConfig,
  type CadenceWindow,
  type DueDecision,
  type LastActivity,
} from "./market-cadence";

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
  status: GameCaptureOutcome["status"] | "skipped_kickoff";
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

type GameCaptureOutcome = {
  status: "saved" | "not_found" | "orientation_mismatch" | "no_quotes" | "error";
  quotes: number;
  bookmakers: number;
  providerFixtureId: string | null;
  error: string | null;
};

/**
 * Resolves one Toto game at the provider and appends its quotes. Orientation
 * is checked against mapped provider team ids when they exist; name-based
 * resolution already scores home against home and away against away.
 */
export async function captureGameQuotes(
  game: ApiFootballRoundGame,
  source: MarketQuoteSource,
  sink: MarketQuoteSink,
): Promise<GameCaptureOutcome> {
  let providerFixtureId: string | null = null;
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
      return {
        status: "not_found",
        quotes: 0,
        bookmakers: 0,
        providerFixtureId,
        error: resolved.resolution,
      };
    }
    providerFixtureId = fixture.providerFixtureId;
    if (
      (game.home.providerTeamId != null && game.home.providerTeamId !== fixture.home.id) ||
      (game.away.providerTeamId != null && game.away.providerTeamId !== fixture.away.id)
    ) {
      return { status: "orientation_mismatch", quotes: 0, bookmakers: 0, providerFixtureId, error: null };
    }

    const drafts = (await source.getThreeWayQuotes(fixture))
      .map((quote) => marketQuoteDraft(game.fixtureId, fixture, quote))
      .filter((draft): draft is MarketQuoteDraft => draft != null);
    if (drafts.length === 0) {
      return { status: "no_quotes", quotes: 0, bookmakers: 0, providerFixtureId, error: null };
    }
    const saved = await sink.saveQuotes(drafts);
    return {
      status: saved > 0 ? "saved" : "no_quotes",
      quotes: saved,
      bookmakers: new Set(drafts.map((draft) => draft.bookmaker_id)).size,
      providerFixtureId,
      error: null,
    };
  } catch (error) {
    return {
      status: "error",
      quotes: 0,
      bookmakers: 0,
      providerFixtureId,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    };
  }
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
    const outcome = await captureGameQuotes(game, source, sink);
    results.push({ ...base, status: outcome.status, quotes: outcome.quotes, error: outcome.error });
  }

  return results;
}

export type MarketCaptureAttemptDraft = {
  fixture_id: string;
  provider: string;
  status: GameCaptureOutcome["status"] | "skipped_budget";
  cadence_window: CadenceWindow;
  provider_fixture_id: string | null;
  quotes_saved: number;
  provider_requests: number;
  provider_daily_remaining: number | null;
  error: string | null;
  capture_version: string;
};

export interface MarketCaptureAttemptSink {
  saveAttempt(row: MarketCaptureAttemptDraft): Promise<void>;
}

/** Live request count and quota as reported by provider response headers. */
export type ProviderRequestMeter = {
  requests: number;
  dailyRemaining: number | null;
};

export type MarketCaptureBudget = {
  maxRequestsPerRun: number;
  maxRequestsPerDay: number;
  /** Requests already spent by shadow capture in the trailing 24 hours. */
  usedLast24h: number;
  /** Stop when the provider reports fewer remaining daily requests. */
  providerReserve: number;
  /** Conservative estimate (fixture resolution + odds page). */
  requestsPerCapture: number;
};

export type DueCaptureResult = {
  fixtureId: string;
  gameNumber: number;
  window: CadenceWindow;
  reason: DueDecision["reason"];
  status: MarketCaptureAttemptDraft["status"];
  quotes: number;
  bookmakers: number;
  requests: number;
  error: string | null;
};

/**
 * Captures quotes only for fixtures whose cadence window says a snapshot is
 * due, most urgent first, within the request budget. Every processed or
 * budget-skipped fixture gets an immutable attempt row, so missing markets
 * are recorded rather than silently absent.
 */
export async function captureDueMarketQuotes(
  games: readonly ApiFootballRoundGame[],
  source: MarketQuoteSource,
  sinks: { quotes: MarketQuoteSink; attempts: MarketCaptureAttemptSink },
  options: {
    now: Date;
    provider: string;
    lastAttempts: ReadonlyMap<string, LastActivity>;
    meter: ProviderRequestMeter;
    budget: MarketCaptureBudget;
    cadence?: CadenceConfig;
  },
): Promise<{ results: DueCaptureResult[]; notDue: number; requestsUsed: number }> {
  const nowMs = options.now.getTime();
  const due = new Map<string, { game: ApiFootballRoundGame; decision: DueDecision }>();
  let notDue = 0;
  for (const game of games) {
    const decision = isDue(
      nowMs,
      game.kickoffAt,
      options.lastAttempts.get(game.fixtureId) ?? null,
      options.cadence,
    );
    if (decision.due && decision.window) due.set(game.fixtureId, { game, decision });
    else notDue += 1;
  }

  const { budget } = options;
  const available = Math.min(
    budget.maxRequestsPerRun,
    budget.maxRequestsPerDay - budget.usedLast24h,
  );
  const plan = planCaptures(
    [...due.values()].map(({ game, decision }) => ({
      fixtureId: game.fixtureId,
      kickoffAt: game.kickoffAt,
      window: decision.window as CadenceWindow,
    })),
    { availableRequests: available, requestsPerCapture: budget.requestsPerCapture },
  );

  const results: DueCaptureResult[] = [];
  const startRequests = options.meter.requests;
  const skip = async (fixtureId: string) => {
    const { game, decision } = due.get(fixtureId) as { game: ApiFootballRoundGame; decision: DueDecision };
    await sinks.attempts.saveAttempt({
      fixture_id: fixtureId,
      provider: options.provider,
      status: "skipped_budget",
      cadence_window: decision.window as CadenceWindow,
      provider_fixture_id: null,
      quotes_saved: 0,
      provider_requests: 0,
      provider_daily_remaining: options.meter.dailyRemaining,
      error: null,
      capture_version: KAPILOTO_MARKET_QUOTE_CAPTURE_VERSION,
    });
    results.push({
      fixtureId,
      gameNumber: game.gameNumber,
      window: decision.window as CadenceWindow,
      reason: decision.reason,
      status: "skipped_budget",
      quotes: 0,
      bookmakers: 0,
      requests: 0,
      error: null,
    });
  };

  for (const candidate of plan.admitted) {
    const runSpent = options.meter.requests - startRequests;
    if (
      (options.meter.dailyRemaining != null &&
        options.meter.dailyRemaining < budget.providerReserve) ||
      runSpent + budget.requestsPerCapture > available
    ) {
      await skip(candidate.fixtureId);
      continue;
    }
    const { game, decision } = due.get(candidate.fixtureId) as {
      game: ApiFootballRoundGame;
      decision: DueDecision;
    };
    const before = options.meter.requests;
    const outcome = await captureGameQuotes(game, source, sinks.quotes);
    const requests = options.meter.requests - before;
    await sinks.attempts.saveAttempt({
      fixture_id: game.fixtureId,
      provider: options.provider,
      status: outcome.status,
      cadence_window: candidate.window,
      provider_fixture_id: outcome.providerFixtureId,
      quotes_saved: outcome.quotes,
      provider_requests: requests,
      provider_daily_remaining: options.meter.dailyRemaining,
      error: outcome.error,
      capture_version: KAPILOTO_MARKET_QUOTE_CAPTURE_VERSION,
    });
    results.push({
      fixtureId: game.fixtureId,
      gameNumber: game.gameNumber,
      window: candidate.window,
      reason: decision.reason,
      status: outcome.status,
      quotes: outcome.quotes,
      bookmakers: outcome.bookmakers,
      requests,
      error: outcome.error,
    });
  }
  for (const candidate of plan.skipped) await skip(candidate.fixtureId);

  return { results, notDue, requestsUsed: options.meter.requests - startRequests };
}
