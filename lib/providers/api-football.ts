import { aggregateMarketPrior } from "./market";
import { kickoffWindowDates, selectApiFootballFixture } from "./api-football-resolution";
import { normalizeTeamName } from "./match";
import type {
  BookmakerThreeWayQuote,
  ProviderFixture,
  ProviderCapabilities,
  ProviderCompletedMatch,
  ProviderFixtureCoverage,
  ProviderSpikeFixtureInput,
  ProviderStanding,
} from "./types";

const DEFAULT_BASE_URL = "https://v3.football.api-sports.io";
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 6_500;
const MATCH_WINNER_BET_ID = 1;

export type ApiFootballResponseInfo = {
  path: string;
  status: number;
  dailyLimit: number | null;
  dailyRemaining: number | null;
  minuteRemaining: number | null;
};

export type ApiFootballClientOptions = {
  baseUrl?: string;
  minRequestIntervalMs?: number;
  /** Called once per HTTP response, including errors. */
  onResponse?: (info: ApiFootballResponseInfo) => void;
};

function headerNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

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
  goals?: { home?: number | null; away?: number | null };
  score?: {
    fulltime?: { home?: number | null; away?: number | null };
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

type ApiFootballStandingResponseRow = {
  league?: {
    id?: number;
    season?: number;
    standings?: Array<
      Array<{
        rank?: number;
        team?: { id?: number; name?: string };
        points?: number;
        goalsDiff?: number;
        all?: { played?: number };
      }>
    >;
  };
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

function completedScore(
  row: ApiFootballFixtureRow,
): { home: number; away: number } | null {
  const home = row.score?.fulltime?.home ?? row.goals?.home;
  const away = row.score?.fulltime?.away ?? row.goals?.away;
  if (
    typeof home !== "number" ||
    typeof away !== "number" ||
    !Number.isInteger(home) ||
    !Number.isInteger(away) ||
    home < 0 ||
    away < 0
  ) {
    return null;
  }
  return { home, away };
}

export function parseApiFootballCompletedMatches(
  rows: ApiFootballFixtureRow[],
): ProviderCompletedMatch[] {
  const matches: ProviderCompletedMatch[] = [];
  for (const row of rows) {
    if ((row.fixture?.status?.short ?? "").toUpperCase() !== "FT") continue;
    const fixture = toProviderFixture(row);
    const score = completedScore(row);
    if (!fixture || !score) continue;
    matches.push({
      provider: "api-football",
      providerFixtureId: fixture.providerFixtureId,
      kickoffAt: fixture.kickoffAt,
      competition: {
        id: fixture.competition.id,
        name: fixture.competition.name,
        country: fixture.competition.country,
      },
      season: fixture.season,
      home: fixture.home,
      away: fixture.away,
      homeScore: score.home,
      awayScore: score.away,
    });
  }
  return matches.sort(
    (a, b) => Date.parse(b.kickoffAt) - Date.parse(a.kickoffAt),
  );
}

export function parseApiFootballStandings(
  rows: ApiFootballStandingResponseRow[],
): ProviderStanding[] {
  const standings: ProviderStanding[] = [];
  for (const response of rows) {
    const league = response.league;
    if (league?.id == null || league.season == null) continue;
    for (const table of league.standings ?? []) {
      for (const row of table) {
        if (
          row.rank == null ||
          row.team?.id == null ||
          row.points == null
        ) {
          continue;
        }
        standings.push({
          provider: "api-football",
          competitionId: String(league.id),
          season: league.season,
          teamId: String(row.team.id),
          position: row.rank,
          points: row.points,
          played: row.all?.played ?? null,
          goalDifference: row.goalsDiff ?? null,
          pointsDeducted: null,
        });
      }
    }
  }
  return standings;
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

export class ApiFootballClient {
  private readonly fixturesByDateCache = new Map<string, ProviderFixture[]>();
  private readonly refusedDates = new Map<string, string>();
  private nextRequestAt = 0;
  private readonly baseUrl: string;
  private readonly minRequestIntervalMs: number;
  private readonly onResponse: ApiFootballClientOptions["onResponse"];

  constructor(
    private readonly apiKey: string,
    options: ApiFootballClientOptions = {},
  ) {
    if (!apiKey) throw new Error("API_FOOTBALL_API_KEY is required.");

    this.onResponse = options.onResponse;
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

    this.onResponse?.({
      path: url.pathname,
      status: response.status,
      dailyLimit: headerNumber(response.headers, "x-ratelimit-requests-limit"),
      dailyRemaining: headerNumber(response.headers, "x-ratelimit-requests-remaining"),
      minuteRemaining: headerNumber(response.headers, "x-ratelimit-remaining"),
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

  /** Account plan and daily usage; API-Football does not count this call. */
  async getAccountStatus(): Promise<{
    plan: string | null;
    active: boolean | null;
    subscriptionEnd: string | null;
    requestsToday: number | null;
    dailyLimit: number | null;
  }> {
    const envelope = (await this.request<unknown>("/status", {})) as unknown as {
      response?: {
        subscription?: { plan?: string; end?: string; active?: boolean };
        requests?: { current?: number; limit_day?: number };
      };
    };
    const status = Array.isArray(envelope.response) ? undefined : envelope.response;
    return {
      plan: status?.subscription?.plan ?? null,
      active: status?.subscription?.active ?? null,
      subscriptionEnd: status?.subscription?.end ?? null,
      requestsToday: status?.requests?.current ?? null,
      dailyLimit: status?.requests?.limit_day ?? null,
    };
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
    const [kickoffDate, ...adjacentDates] = kickoffWindowDates(input.kickoffAt);

    if (input.apiFootballFixtureId != null) {
      // A known fixture is looked up in the day lists this client already
      // fetched (one request per date, shared by every fixture that day) and
      // fetched by id only when it is not listed there.
      const knownId = String(input.apiFootballFixtureId);
      for (const date of kickoffDate ? [kickoffDate, ...adjacentDates] : []) {
        try {
          const listed = (await this.fixturesOnDate(date)).find(
            (fixture) => fixture.providerFixtureId === knownId,
          );
          if (listed) return { fixture: listed, resolution: "provided_id" };
        } catch {
          // An unreadable day falls through to the by-id lookup.
        }
      }
      return {
        fixture: await this.getFixtureById(input.apiFootballFixtureId),
        resolution: "provided_id",
      };
    }

    if (!kickoffDate) return { fixture: null, resolution: "not_found" };

    const candidates = new Map<string, ProviderFixture>();
    for (const fixture of await this.fixturesOnDate(kickoffDate)) {
      candidates.set(fixture.providerFixtureId, fixture);
    }
    let complete = true;
    for (const date of adjacentDates) {
      try {
        for (const fixture of await this.fixturesOnDate(date)) {
          candidates.set(fixture.providerFixtureId, fixture);
        }
      } catch {
        complete = false;
      }
    }

    const selection = selectApiFootballFixture(input, [...candidates.values()]);
    // An unreadable adjacent date may hide a second candidate: provider ids can
    // still decide, but a name-only match cannot be shown to be unique.
    if (!complete && selection.resolution === "name_match") {
      return { fixture: null, resolution: "ambiguous" };
    }
    return selection;
  }

  /** One provider day of fixtures, cached per client; plan refusals are cached too. */
  private async fixturesOnDate(date: string): Promise<ProviderFixture[]> {
    const cached = this.fixturesByDateCache.get(date);
    if (cached) return cached;
    const refused = this.refusedDates.get(date);
    if (refused) throw new Error(refused);

    const envelope = await this.request<ApiFootballFixtureRow>("/fixtures", {
      date,
      timezone: "UTC",
    });
    let rows: ApiFootballFixtureRow[];
    try {
      rows = requireResponse(envelope, "fixture resolution");
    } catch (error) {
      this.refusedDates.set(date, error instanceof Error ? error.message : String(error));
      throw error;
    }
    const fixtures = rows
      .map(toProviderFixture)
      .filter((fixture): fixture is ProviderFixture => fixture != null);
    this.fixturesByDateCache.set(date, fixtures);
    return fixtures;
  }

  async getTeamCompletedMatches(
    teamId: string,
    last = 12,
  ): Promise<ProviderCompletedMatch[]> {
    if (!/^\d+$/.test(teamId)) {
      throw new Error("API-Football team id must be numeric.");
    }
    const safeLast = Math.max(1, Math.min(99, Math.trunc(last)));
    const envelope = await this.request<ApiFootballFixtureRow>("/fixtures", {
      team: Number(teamId),
      last: safeLast,
      status: "FT",
      timezone: "UTC",
    });
    return parseApiFootballCompletedMatches(
      requireResponse(envelope, "team completed fixtures"),
    );
  }

  async getStandings(
    leagueId: string,
    season: number,
  ): Promise<ProviderStanding[]> {
    if (!/^\d+$/.test(leagueId) || !Number.isInteger(season)) {
      throw new Error("API-Football standings require numeric league and season.");
    }
    const envelope = await this.request<ApiFootballStandingResponseRow>(
      "/standings",
      {
        league: Number(leagueId),
        season,
      },
    );
    return parseApiFootballStandings(
      requireResponse(envelope, "standings"),
    );
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
