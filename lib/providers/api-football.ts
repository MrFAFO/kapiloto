import { aggregateMarketPrior } from "./market";
import { bestAliasSimilarity, normalizeTeamName } from "./match";
import type {
  BookmakerThreeWayQuote,
  ProviderFixture,
  ProviderCapabilities,
  ProviderFixtureCoverage,
  ProviderSpikeFixtureInput,
} from "./types";

const DEFAULT_BASE_URL = "https://v3.football.api-sports.io";
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 6_500;
const MATCH_WINNER_BET_ID = 1;

export type ApiFootballClientOptions = {
  baseUrl?: string;
  minRequestIntervalMs?: number;
};

type ApiFootballEnvelope<T> = {
  errors?: Record<string, string> | string[];
  paging?: { current?: number; total?: number };
  response?: T[];
};

type ApiFootballFixtureRow = {
  fixture?: {
    id?: number;
    date?: string;
    timestamp?: number;
    status?: { short?: string };
  };
  league?: {
    id?: number;
    name?: string;
    country?: string;
    season?: number;
    round?: string;
  };
  teams?: {
    home?: { id?: number; name?: string };
    away?: { id?: number; name?: string };
  };
};

type ApiFootballLeagueRow = {
  seasons?: Array<{
    year?: number;
    coverage?: {
      fixtures?: { lineups?: boolean };
      injuries?: boolean;
      odds?: boolean;
      predictions?: boolean;
    };
  }>;
};

type ApiFootballOddsRow = {
  fixture?: { id?: number };
  update?: string;
  bookmakers?: Array<{
    id?: number;
    name?: string;
    bets?: Array<{
      id?: number;
      name?: string;
      values?: Array<{ value?: string; odd?: string }>;
    }>;
  }>;
};

function envelopeErrors(errors: ApiFootballEnvelope<unknown>["errors"]): string[] {
  if (!errors) return [];
  if (Array.isArray(errors)) return errors.filter(Boolean);
  return Object.entries(errors).map(([key, value]) => `${key}: ${value}`);
}

function requireResponse<T>(envelope: ApiFootballEnvelope<T>, context: string): T[] {
  const errors = envelopeErrors(envelope.errors);
  if (errors.length > 0) {
    throw new Error(`API-Football ${context} error: ${errors.join("; ")}`);
  }
  return envelope.response ?? [];
}

function toProviderFixture(row: ApiFootballFixtureRow): ProviderFixture | null {
  const fixtureId = row.fixture?.id;
  const kickoffAt = row.fixture?.date;
  const competitionId = row.league?.id;
  const competitionName = row.league?.name;
  const homeId = row.teams?.home?.id;
  const homeName = row.teams?.home?.name;
  const awayId = row.teams?.away?.id;
  const awayName = row.teams?.away?.name;

  if (
    fixtureId == null ||
    !kickoffAt ||
    competitionId == null ||
    !competitionName ||
    homeId == null ||
    !homeName ||
    awayId == null ||
    !awayName
  ) {
    return null;
  }

  return {
    provider: "api-football",
    providerFixtureId: String(fixtureId),
    kickoffAt,
    status: row.fixture?.status?.short ?? "unknown",
    season: row.league?.season ?? null,
    competition: {
      id: String(competitionId),
      name: competitionName,
      country: row.league?.country ?? null,
      round: row.league?.round ?? null,
    },
    home: { id: String(homeId), name: homeName },
    away: { id: String(awayId), name: awayName },
  };
}

function parseDecimal(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 1 ? parsed : null;
}

function normalizeOddLabel(value: string | undefined): "home" | "draw" | "away" | null {
  if (!value) return null;
  const normalized = normalizeTeamName(value);

  if (normalized === "home" || normalized === "1") return "home";
  if (normalized === "draw" || normalized === "x") return "draw";
  if (normalized === "away" || normalized === "2") return "away";
  return null;
}

export function parseApiFootballThreeWayQuotes(
  rows: ApiFootballOddsRow[],
  fixture: ProviderFixture,
): BookmakerThreeWayQuote[] {
  const quotes: BookmakerThreeWayQuote[] = [];

  for (const row of rows) {
    for (const bookmaker of row.bookmakers ?? []) {
      const matchWinner = (bookmaker.bets ?? []).find(
        (bet) =>
          bet.id === MATCH_WINNER_BET_ID ||
          normalizeTeamName(bet.name ?? "") === "match winner",
      );
      if (!matchWinner) continue;

      const values: Partial<Record<"home" | "draw" | "away", number>> = {};

      for (const item of matchWinner.values ?? []) {
        let key = normalizeOddLabel(item.value);

        if (!key && item.value) {
          const normalizedValue = normalizeTeamName(item.value);
          if (normalizedValue === normalizeTeamName(fixture.home.name)) key = "home";
          if (normalizedValue === normalizeTeamName(fixture.away.name)) key = "away";
        }

        if (!key) continue;
        const decimal = parseDecimal(item.odd);
        if (decimal != null) values[key] = decimal;
      }

      if (
        values.home == null ||
        values.draw == null ||
        values.away == null ||
        bookmaker.id == null
      ) {
        continue;
      }

      quotes.push({
        provider: "api-football",
        providerFixtureId: fixture.providerFixtureId,
        bookmakerId: String(bookmaker.id),
        bookmakerName: bookmaker.name ?? String(bookmaker.id),
        capturedAt: row.update ?? null,
        odds: {
          home: values.home,
          draw: values.draw,
          away: values.away,
        },
      });
    }
  }

  return quotes;
}

function fixtureMatchScore(
  input: ProviderSpikeFixtureInput,
  fixture: ProviderFixture,
): number {
  const home = bestAliasSimilarity(
    fixture.home.name,
    input.homeTeam,
    input.aliases?.home,
  );
  const away = bestAliasSimilarity(
    fixture.away.name,
    input.awayTeam,
    input.aliases?.away,
  );

  if (home < 0.6 || away < 0.6) return 0;

  const targetTime = Date.parse(input.kickoffAt);
  const candidateTime = Date.parse(fixture.kickoffAt);
  const kickoffDiffHours =
    Number.isFinite(targetTime) && Number.isFinite(candidateTime)
      ? Math.abs(candidateTime - targetTime) / 3_600_000
      : 24;
  const kickoffScore = Math.max(0, 1 - kickoffDiffHours / 12);

  const competitionScore =
    input.competition &&
    normalizeTeamName(fixture.competition.name) ===
      normalizeTeamName(input.competition)
      ? 1
      : 0;

  return home * 0.4 + away * 0.4 + kickoffScore * 0.15 + competitionScore * 0.05;
}

export class ApiFootballClient {
  private readonly fixturesByDateCache = new Map<string, ProviderFixture[]>();
  private nextRequestAt = 0;
  private readonly baseUrl: string;
  private readonly minRequestIntervalMs: number;

  constructor(
    private readonly apiKey: string,
    options: ApiFootballClientOptions = {},
  ) {
    if (!apiKey) throw new Error("API_FOOTBALL_API_KEY is required.");

    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.minRequestIntervalMs =
      options.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS;

    if (
      !Number.isFinite(this.minRequestIntervalMs) ||
      this.minRequestIntervalMs < 0
    ) {
      throw new Error("minRequestIntervalMs must be a non-negative number.");
    }
  }

  private async waitForRateSlot(): Promise<void> {
    const now = Date.now();
    const waitMs = Math.max(0, this.nextRequestAt - now);
    this.nextRequestAt =
      Math.max(this.nextRequestAt, now) + this.minRequestIntervalMs;

    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  private async request<T>(
    path: string,
    params: Record<string, string | number | undefined>,
  ): Promise<ApiFootballEnvelope<T>> {
    await this.waitForRateSlot();

    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value != null) url.searchParams.set(key, String(value));
    }

    const response = await fetch(url, {
      headers: {
        "x-apisports-key": this.apiKey,
      },
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });

    if (!response.ok) {
      const remainingMinute = response.headers.get("x-ratelimit-remaining");
      const remainingDaily = response.headers.get("x-ratelimit-requests-remaining");
      throw new Error(
        `API-Football HTTP ${response.status} for ${url.pathname}` +
          (remainingMinute != null ? ` minute_remaining=${remainingMinute}` : "") +
          (remainingDaily != null ? ` daily_remaining=${remainingDaily}` : ""),
      );
    }

    return (await response.json()) as ApiFootballEnvelope<T>;
  }

  async getFixtureById(fixtureId: number): Promise<ProviderFixture | null> {
    const envelope = await this.request<ApiFootballFixtureRow>("/fixtures", {
      id: fixtureId,
      timezone: "UTC",
    });
    const rows = requireResponse(envelope, "fixture");
    return (
      rows
        .map(toProviderFixture)
        .find((fixture): fixture is ProviderFixture => fixture != null) ?? null
    );
  }

  async resolveFixture(
    input: ProviderSpikeFixtureInput,
  ): Promise<{
    fixture: ProviderFixture | null;
    resolution: ProviderFixtureCoverage["fixtureResolution"];
  }> {
    if (input.apiFootballFixtureId != null) {
      return {
        fixture: await this.getFixtureById(input.apiFootballFixtureId),
        resolution: "provided_id",
      };
    }

    const date = new Date(input.kickoffAt).toISOString().slice(0, 10);
    let dateFixtures = this.fixturesByDateCache.get(date);

    if (!dateFixtures) {
      const envelope = await this.request<ApiFootballFixtureRow>("/fixtures", {
        date,
        timezone: "UTC",
      });
      dateFixtures = requireResponse(envelope, "fixture resolution")
        .map(toProviderFixture)
        .filter((fixture): fixture is ProviderFixture => fixture != null);
      this.fixturesByDateCache.set(date, dateFixtures);
    }

    const candidates = dateFixtures
      .map((fixture) => ({ fixture, score: fixtureMatchScore(input, fixture) }))
      .filter(({ score }) => score >= 0.72)
      .sort((a, b) => b.score - a.score);

    if (candidates.length === 0) {
      return { fixture: null, resolution: "not_found" };
    }

    if (
      candidates.length > 1 &&
      Math.abs(candidates[0].score - candidates[1].score) < 0.04
    ) {
      return { fixture: null, resolution: "ambiguous" };
    }

    return { fixture: candidates[0].fixture, resolution: "name_match" };
  }

  async getLineupEntryCount(fixtureId: string): Promise<number> {
    const envelope = await this.request<{
      startXI?: unknown[];
      substitutes?: unknown[];
    }>("/fixtures/lineups", { fixture: fixtureId });

    return requireResponse(envelope, "lineups").reduce(
      (sum, team) =>
        sum + (team.startXI?.length ?? 0) + (team.substitutes?.length ?? 0),
      0,
    );
  }

  async getInjuryEntryCount(fixtureId: string): Promise<number> {
    const envelope = await this.request<unknown>("/injuries", {
      fixture: fixtureId,
      timezone: "UTC",
    });
    return requireResponse(envelope, "injuries").length;
  }

  async getThreeWayQuotes(
    fixture: ProviderFixture,
  ): Promise<BookmakerThreeWayQuote[]> {
    const rows: ApiFootballOddsRow[] = [];
    let page = 1;
    let totalPages = 1;

    do {
      const envelope = await this.request<ApiFootballOddsRow>("/odds", {
        fixture: fixture.providerFixtureId,
        page,
      });
      rows.push(...requireResponse(envelope, "odds"));
      totalPages = Math.max(1, envelope.paging?.total ?? 1);
      page += 1;
    } while (page <= totalPages);

    return parseApiFootballThreeWayQuotes(rows, fixture);
  }

  async probeFixture(
    input: ProviderSpikeFixtureInput,
  ): Promise<ProviderFixtureCoverage> {
    const providerErrors: string[] = [];
    let fixture: ProviderFixture | null = null;
    let fixtureResolution: ProviderFixtureCoverage["fixtureResolution"] =
      "not_found";

    try {
      const resolved = await this.resolveFixture(input);
      fixture = resolved.fixture;
      fixtureResolution = resolved.resolution;
    } catch (error) {
      providerErrors.push(error instanceof Error ? error.message : String(error));
    }

    if (!fixture) {
      return {
        gameNumber: input.gameNumber,
        input,
        resolvedFixture: null,
        fixtureResolution,
        capabilities: {
          lineups: null,
          injuries: null,
          odds: null,
          predictions: null,
        },
        lineupEntries: 0,
        injuryEntries: 0,
        completeBookmakers: 0,
        marketPrior: null,
        providerErrors,
      };
    }

    let capabilities: ProviderCapabilities = {
      lineups: null,
      injuries: null,
      odds: null,
      predictions: null,
    };
    let lineupEntries = 0;
    let injuryEntries = 0;
    let quotes: BookmakerThreeWayQuote[] = [];

    try {
      lineupEntries = await this.getLineupEntryCount(fixture.providerFixtureId);
      capabilities.lineups = true;
    } catch (error) {
      providerErrors.push(error instanceof Error ? error.message : String(error));
    }

    try {
      injuryEntries = await this.getInjuryEntryCount(fixture.providerFixtureId);
      capabilities.injuries = true;
    } catch (error) {
      providerErrors.push(error instanceof Error ? error.message : String(error));
    }

    try {
      quotes = await this.getThreeWayQuotes(fixture);
      capabilities.odds = true;
    } catch (error) {
      providerErrors.push(error instanceof Error ? error.message : String(error));
    }

    return {
      gameNumber: input.gameNumber,
      input,
      resolvedFixture: fixture,
      fixtureResolution,
      capabilities,
      lineupEntries,
      injuryEntries,
      completeBookmakers: quotes.length,
      marketPrior: aggregateMarketPrior(quotes),
      providerErrors,
    };
  }
}
