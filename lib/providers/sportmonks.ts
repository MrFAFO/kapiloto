import { aggregateMarketPrior } from "./market";
import { bestAliasSimilarity, normalizeTeamName } from "./match";
import type {
  BookmakerThreeWayQuote,
  ProviderCapabilities,
  ProviderFixture,
  ProviderFixtureCoverage,
  ProviderSpikeFixtureInput,
} from "./types";

const DEFAULT_BASE_URL = "https://api.sportmonks.com/v3/football";
const MATCH_WINNER_MARKET_ID = 1;

type SportmonksEnvelope<T> = {
  data?: T;
  pagination?: {
    count?: number;
    per_page?: number;
    current_page?: number;
    next_page?: number | null;
    has_more?: boolean;
  };
};

type SportmonksParticipant = {
  id?: number;
  name?: string;
  meta?: { location?: string };
};

export type SportmonksMetricRow = {
  fixture_id?: number;
  participant_id?: number;
  type_id?: number;
  location?: string;
  data?: { value?: number | string | null };
  type?: {
    name?: string;
    developer_name?: string;
    code?: string;
  };
};

export type SportmonksPressureRow = {
  fixture_id?: number;
  participant_id?: number;
  minute?: number;
  pressure?: number;
};

type SportmonksFixtureRow = {
  id?: number;
  league_id?: number;
  season_id?: number;
  stage_id?: number;
  round_id?: number;
  state_id?: number;
  name?: string;
  starting_at?: string;
  starting_at_timestamp?: number;
  leg?: string | number | null;
  has_odds?: boolean;
  participants?: SportmonksParticipant[];
  lineups?: unknown[];
  sidelined?: unknown[];
  statistics?: SportmonksMetricRow[];
  xgfixture?: SportmonksMetricRow[];
  pressure?: SportmonksPressureRow[];
  league?: { id?: number; name?: string; country_id?: number };
  round?: { id?: number; name?: string };
  state?: { id?: number; short_name?: string; state?: string };
};

type SportmonksOddRow = {
  fixture_id?: number;
  market_id?: number;
  bookmaker_id?: number;
  label?: string;
  name?: string | null;
  value?: string;
  market_description?: string;
  updated_at?: string;
  latest_bookmaker_update?: string | null;
  bookmaker?: { id?: number; name?: string };
  market?: { id?: number; name?: string; developer_name?: string };
};

function requireData<T>(
  envelope: SportmonksEnvelope<T>,
  context: string,
): T {
  if (envelope.data == null) {
    throw new Error(`Sportmonks ${context} returned no data.`);
  }
  return envelope.data;
}

function participantByLocation(
  participants: SportmonksParticipant[] | undefined,
  location: "home" | "away",
): SportmonksParticipant | null {
  return (
    participants?.find(
      (participant) =>
        normalizeTeamName(participant.meta?.location ?? "") === location,
    ) ?? null
  );
}

function toProviderFixture(row: SportmonksFixtureRow): ProviderFixture | null {
  const home = participantByLocation(row.participants, "home");
  const away = participantByLocation(row.participants, "away");

  if (
    row.id == null ||
    row.league_id == null ||
    !row.starting_at ||
    home?.id == null ||
    !home.name ||
    away?.id == null ||
    !away.name
  ) {
    return null;
  }

  return {
    provider: "sportmonks",
    providerFixtureId: String(row.id),
    kickoffAt: row.starting_at,
    status: row.state?.short_name ?? row.state?.state ?? String(row.state_id ?? "unknown"),
    season: row.season_id ?? null,
    competition: {
      id: String(row.league_id),
      name: row.league?.name ?? String(row.league_id),
      country: null,
      round: row.round?.name ?? null,
    },
    home: { id: String(home.id), name: home.name },
    away: { id: String(away.id), name: away.name },
  };
}

function oddSide(
  row: SportmonksOddRow,
  fixture: ProviderFixture,
): "home" | "draw" | "away" | null {
  const label = normalizeTeamName(row.label ?? "");
  const name = normalizeTeamName(row.name ?? "");

  if (label === "1" || label === "home" || name === "home") return "home";
  if (label === "x" || label === "draw" || name === "draw") return "draw";
  if (label === "2" || label === "away" || name === "away") return "away";

  if (name && name === normalizeTeamName(fixture.home.name)) return "home";
  if (name && name === normalizeTeamName(fixture.away.name)) return "away";

  return null;
}

export function parseSportmonksThreeWayQuotes(
  rows: SportmonksOddRow[],
  fixture: ProviderFixture,
): BookmakerThreeWayQuote[] {
  const grouped = new Map<
    string,
    {
      bookmakerName: string;
      capturedAt: string | null;
      values: Partial<Record<"home" | "draw" | "away", number>>;
    }
  >();

  for (const row of rows) {
    const isMatchWinner =
      row.market_id === MATCH_WINNER_MARKET_ID ||
      normalizeTeamName(row.market_description ?? "") === "match winner" ||
      normalizeTeamName(row.market_description ?? "") === "fulltime result" ||
      normalizeTeamName(row.market?.name ?? "") === "match winner";

    if (!isMatchWinner || row.bookmaker_id == null) continue;

    const side = oddSide(row, fixture);
    const decimal = Number(row.value);
    if (!side || !Number.isFinite(decimal) || decimal <= 1) continue;

    const key = String(row.bookmaker_id);
    const existing = grouped.get(key) ?? {
      bookmakerName: row.bookmaker?.name ?? key,
      capturedAt: row.latest_bookmaker_update ?? row.updated_at ?? null,
      values: {},
    };
    existing.values[side] = decimal;
    if (row.bookmaker?.name) existing.bookmakerName = row.bookmaker.name;
    if (row.latest_bookmaker_update ?? row.updated_at) {
      existing.capturedAt = row.latest_bookmaker_update ?? row.updated_at ?? null;
    }
    grouped.set(key, existing);
  }

  const quotes: BookmakerThreeWayQuote[] = [];

  for (const [bookmakerId, group] of grouped) {
    if (
      group.values.home == null ||
      group.values.draw == null ||
      group.values.away == null
    ) {
      continue;
    }

    quotes.push({
      provider: "sportmonks",
      providerFixtureId: fixture.providerFixtureId,
      bookmakerId,
      bookmakerName: group.bookmakerName,
      capturedAt: group.capturedAt,
      odds: {
        home: group.values.home,
        draw: group.values.draw,
        away: group.values.away,
      },
    });
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

export class SportmonksClient {
  constructor(
    private readonly apiToken: string,
    private readonly baseUrl = DEFAULT_BASE_URL,
  ) {
    if (!apiToken) throw new Error("SPORTMONKS_API_TOKEN is required.");
  }

  private async request<T>(
    path: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<SportmonksEnvelope<T>> {
    const url = new URL(
      path.startsWith("/") ? `${this.baseUrl}${path}` : `${this.baseUrl}/${path}`,
    );

    url.searchParams.set("api_token", this.apiToken);
    for (const [key, value] of Object.entries(params)) {
      if (value != null) url.searchParams.set(key, String(value));
    }

    const response = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(
        `Sportmonks HTTP ${response.status} for ${url.pathname}`,
      );
    }

    return (await response.json()) as SportmonksEnvelope<T>;
  }

  private fixtureIncludes(): string {
    return "participants;league;round;state;lineups;sidelined";
  }

  async getFixtureById(fixtureId: number): Promise<{
    fixture: ProviderFixture | null;
    raw: SportmonksFixtureRow | null;
  }> {
    const envelope = await this.request<SportmonksFixtureRow>(
      `/fixtures/${fixtureId}`,
      { include: this.fixtureIncludes() },
    );
    const raw = requireData(envelope, "fixture");
    return { fixture: toProviderFixture(raw), raw };
  }

  async resolveFixture(
    input: ProviderSpikeFixtureInput,
  ): Promise<{
    fixture: ProviderFixture | null;
    raw: SportmonksFixtureRow | null;
    resolution: ProviderFixtureCoverage["fixtureResolution"];
  }> {
    if (input.sportmonksFixtureId != null) {
      const resolved = await this.getFixtureById(input.sportmonksFixtureId);
      return { ...resolved, resolution: "provided_id" };
    }

    const date = new Date(input.kickoffAt).toISOString().slice(0, 10);
    const envelope = await this.request<SportmonksFixtureRow[]>(
      `/fixtures/date/${date}`,
      { include: this.fixtureIncludes() },
    );
    const rawRows = requireData(envelope, "fixture resolution");

    const candidates = rawRows
      .map((raw) => ({ raw, fixture: toProviderFixture(raw) }))
      .filter(
        (row): row is { raw: SportmonksFixtureRow; fixture: ProviderFixture } =>
          row.fixture != null,
      )
      .map((row) => ({
        ...row,
        score: fixtureMatchScore(input, row.fixture),
      }))
      .filter(({ score }) => score >= 0.72)
      .sort((a, b) => b.score - a.score);

    if (candidates.length === 0) {
      return { fixture: null, raw: null, resolution: "not_found" };
    }

    if (
      candidates.length > 1 &&
      Math.abs(candidates[0].score - candidates[1].score) < 0.04
    ) {
      return { fixture: null, raw: null, resolution: "ambiguous" };
    }

    return {
      fixture: candidates[0].fixture,
      raw: candidates[0].raw,
      resolution: "name_match",
    };
  }

  async getThreeWayQuotes(
    fixture: ProviderFixture,
  ): Promise<BookmakerThreeWayQuote[]> {
    const rows: SportmonksOddRow[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const envelope = await this.request<SportmonksOddRow[]>(
        `/odds/pre-match/fixtures/${fixture.providerFixtureId}`,
        {
          include: "bookmaker;market",
          filters: `markets:${MATCH_WINNER_MARKET_ID}`,
          page,
        },
      );

      rows.push(...requireData(envelope, "odds"));
      hasMore = envelope.pagination?.has_more === true;
      page = envelope.pagination?.next_page ?? page + 1;

      if (page > 100) {
        throw new Error("Sportmonks odds pagination exceeded safety limit.");
      }
    }

    return parseSportmonksThreeWayQuotes(rows, fixture);
  }

  async getStatisticsRows(
    fixtureId: string,
  ): Promise<SportmonksMetricRow[]> {
    const envelope = await this.request<SportmonksFixtureRow>(
      `/fixtures/${fixtureId}`,
      { include: "statistics.type" },
    );
    return requireData(envelope, "fixture statistics").statistics ?? [];
  }

  async getXgRows(fixtureId: string): Promise<SportmonksMetricRow[]> {
    const envelope = await this.request<SportmonksFixtureRow>(
      `/fixtures/${fixtureId}`,
      { include: "xGFixture.type" },
    );
    return requireData(envelope, "fixture xG").xgfixture ?? [];
  }

  async getPressureRows(fixtureId: string): Promise<SportmonksPressureRow[]> {
    const envelope = await this.request<SportmonksFixtureRow>(
      `/fixtures/${fixtureId}`,
      { include: "pressure" },
    );
    return requireData(envelope, "fixture pressure").pressure ?? [];
  }

  async getStatisticsEntryCount(fixtureId: string): Promise<number> {
    return (await this.getStatisticsRows(fixtureId)).length;
  }

  async getXgCoverage(fixtureId: string): Promise<{
    entries: number;
    metricDeveloperNames: string[];
  }> {
    const rows = await this.getXgRows(fixtureId);
    const metricDeveloperNames = [
      ...new Set(
        rows
          .map((row) => row.type?.developer_name)
          .filter((name): name is string => Boolean(name)),
      ),
    ].sort();

    return {
      entries: rows.length,
      metricDeveloperNames,
    };
  }

  async getPressureCoverage(fixtureId: string): Promise<{
    entries: number;
    participants: number;
  }> {
    const rows = await this.getPressureRows(fixtureId);
    return {
      entries: rows.length,
      participants: new Set(
        rows
          .map((row) => row.participant_id)
          .filter((id): id is number => id != null),
      ).size,
    };
  }

  async probeFixture(
    input: ProviderSpikeFixtureInput,
  ): Promise<ProviderFixtureCoverage> {
    const providerErrors: string[] = [];
    let fixture: ProviderFixture | null = null;
    let raw: SportmonksFixtureRow | null = null;
    let fixtureResolution: ProviderFixtureCoverage["fixtureResolution"] =
      "not_found";

    try {
      const resolved = await this.resolveFixture(input);
      fixture = resolved.fixture;
      raw = resolved.raw;
      fixtureResolution = resolved.resolution;
    } catch (error) {
      providerErrors.push(error instanceof Error ? error.message : String(error));
    }

    if (!fixture || !raw) {
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

    let quotes: BookmakerThreeWayQuote[] = [];
    try {
      quotes = await this.getThreeWayQuotes(fixture);
    } catch (error) {
      providerErrors.push(error instanceof Error ? error.message : String(error));
    }

    let statisticsEntries = 0;
    let xgEntries = 0;
    let xgMetricDeveloperNames: string[] = [];
    let pressureEntries = 0;
    let pressureParticipants = 0;

    const capabilities: ProviderCapabilities = {
      lineups: raw.lineups ? true : null,
      injuries: raw.sidelined ? true : null,
      odds: raw.has_odds ?? (quotes.length > 0 ? true : null),
      predictions: null,
      statistics: null,
      xg: null,
      pressure: null,
    };

    try {
      statisticsEntries = await this.getStatisticsEntryCount(
        fixture.providerFixtureId,
      );
      capabilities.statistics = true;
    } catch (error) {
      providerErrors.push(
        `statistics: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      const xg = await this.getXgCoverage(fixture.providerFixtureId);
      xgEntries = xg.entries;
      xgMetricDeveloperNames = xg.metricDeveloperNames;
      capabilities.xg = true;
    } catch (error) {
      providerErrors.push(
        `xg: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      const pressure = await this.getPressureCoverage(fixture.providerFixtureId);
      pressureEntries = pressure.entries;
      pressureParticipants = pressure.participants;
      capabilities.pressure = true;
    } catch (error) {
      providerErrors.push(
        `pressure: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return {
      gameNumber: input.gameNumber,
      input,
      resolvedFixture: fixture,
      fixtureResolution,
      capabilities,
      lineupEntries: raw.lineups?.length ?? 0,
      injuryEntries: raw.sidelined?.length ?? 0,
      completeBookmakers: quotes.length,
      marketPrior: aggregateMarketPrior(quotes),
      analytics: {
        statisticsEntries,
        xgEntries,
        xgMetricDeveloperNames,
        pressureEntries,
        pressureParticipants,
      },
      providerErrors,
    };
  }
}
