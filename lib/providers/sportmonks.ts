import { aggregateMarketPrior } from "./market";
import { bestHybridAliasSimilarity, normalizeTeamName } from "./match";
import type {
  BookmakerThreeWayQuote,
  ProviderCapabilities,
  ProviderCompletedMatch,
  ProviderFixture,
  ProviderFixtureCoverage,
  ProviderSpikeFixtureInput,
  ProviderStanding,
} from "./types";

const DEFAULT_BASE_URL = "https://api.sportmonks.com/v3/football";
const MATCH_WINNER_MARKET_ID = 1;

type SportmonksEnvelope<T> = {
  data?: T;
  message?: string;
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

export type SportmonksScoreRow = {
  fixture_id?: number;
  participant_id?: number;
  description?: string;
  score?: {
    goals?: number | null;
    participant?: string;
  };
};

export type SportmonksLiveStatus =
  | "upcoming"
  | "live"
  | "halftime"
  | "finished"
  | "postponed"
  | "cancelled"
  | "suspended"
  | "under_review";

export type SportmonksLiveResult = {
  providerFixtureId: string;
  providerState: string;
  status: SportmonksLiveStatus;
  homeScore: number | null;
  awayScore: number | null;
  scoreBasis: "current" | "regular_time" | null;
  observedAt: string;
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
  scores?: SportmonksScoreRow[];
  league?: { id?: number; name?: string; country_id?: number };
  round?: { id?: number; name?: string };
  state?: {
    id?: number;
    short_name?: string;
    state?: string;
    developer_name?: string;
  };
};

type SportmonksStandingRow = {
  participant_id?: number;
  league_id?: number;
  season_id?: number;
  position?: number;
  points?: number;
  details?: Array<{
    value?: number | string | null;
    type?: { name?: string; developer_name?: string };
  }>;
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

function normalizedSportmonksState(row: SportmonksFixtureRow): string {
  return (
    row.state?.developer_name ??
    row.state?.state ??
    row.state?.short_name ??
    String(row.state_id ?? "UNKNOWN")
  )
    .trim()
    .toUpperCase();
}

export function canonicalSportmonksLiveStatus(
  providerState: string,
): SportmonksLiveStatus {
  const state = providerState.trim().toUpperCase();

  if (state === "NS" || state === "TBA" || state === "DELAYED") return "upcoming";
  if (
    state === "INPLAY_1ST_HALF" ||
    state === "INPLAY_2ND_HALF" ||
    state === "LIVE"
  ) {
    return "live";
  }
  if (state === "HT") return "halftime";
  if (
    state === "FT" ||
    state === "BREAK" ||
    state === "INPLAY_ET" ||
    state === "EXTRA_TIME_BREAK" ||
    state === "AET" ||
    state === "INPLAY_PENALTIES" ||
    state === "PEN_BREAK" ||
    state === "FT_PEN"
  ) {
    return "finished";
  }
  if (state === "POSTPONED") return "postponed";
  if (state === "CANCELLED" || state === "DELETED") return "cancelled";
  if (
    state === "SUSPENDED" ||
    state === "ABANDONED" ||
    state === "INTERRUPTED"
  ) {
    return "suspended";
  }

  return "under_review";
}

function sportmonksScorePair(
  rows: SportmonksScoreRow[] | undefined,
  description: string,
): { home: number; away: number } | null {
  const matching = (rows ?? []).filter(
    (row) => (row.description ?? "").trim().toUpperCase() === description,
  );
  const home = matching.find(
    (row) => normalizeTeamName(row.score?.participant ?? "") === "home",
  )?.score?.goals;
  const away = matching.find(
    (row) => normalizeTeamName(row.score?.participant ?? "") === "away",
  )?.score?.goals;

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

export function parseSportmonksLiveResult(
  row: SportmonksFixtureRow,
  observedAt = new Date().toISOString(),
): SportmonksLiveResult | null {
  if (row.id == null) return null;

  const providerState = normalizedSportmonksState(row);
  const status = canonicalSportmonksLiveStatus(providerState);
  const regularTimeFinishedStates = new Set([
    "FT",
    "BREAK",
    "INPLAY_ET",
    "EXTRA_TIME_BREAK",
    "AET",
    "INPLAY_PENALTIES",
    "PEN_BREAK",
    "FT_PEN",
  ]);

  const regularTime = sportmonksScorePair(row.scores, "2ND_HALF");
  const current = sportmonksScorePair(row.scores, "CURRENT");

  const score = regularTimeFinishedStates.has(providerState)
    ? regularTime ?? (providerState === "FT" ? current : null)
    : current;

  return {
    providerFixtureId: String(row.id),
    providerState,
    status,
    homeScore: score?.home ?? null,
    awayScore: score?.away ?? null,
    scoreBasis: score
      ? regularTimeFinishedStates.has(providerState)
        ? "regular_time"
        : "current"
      : null,
    observedAt,
  };
}

function numericStandingDetail(
  row: SportmonksStandingRow,
  names: string[],
): number | null {
  const normalizedNames = new Set(
    names.map((name) => normalizeTeamName(name)),
  );
  for (const detail of row.details ?? []) {
    const candidates = [
      detail.type?.developer_name,
      detail.type?.name,
    ]
      .filter((value): value is string => Boolean(value))
      .map((value) => normalizeTeamName(value));

    if (!candidates.some((name) => normalizedNames.has(name))) continue;

    const value = Number(detail.value);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

export function parseSportmonksStandings(
  rows: SportmonksStandingRow[],
): ProviderStanding[] {
  return rows.flatMap((row) => {
    if (
      row.participant_id == null ||
      row.league_id == null ||
      row.season_id == null ||
      row.position == null ||
      row.points == null
    ) {
      return [];
    }
    return [{
      provider: "sportmonks" as const,
      competitionId: String(row.league_id),
      season: row.season_id,
      teamId: String(row.participant_id),
      position: row.position,
      points: row.points,
      played: numericStandingDetail(row, [
        "overall matches",
        "overall matched played",
        "overall matches played",
        "matches played",
      ]),
      goalDifference: numericStandingDetail(row, [
        "goal difference",
        "overall goal difference",
      ]),
      pointsDeducted: null,
    }];
  });
}

export function parseSportmonksCompletedMatches(
  rows: SportmonksFixtureRow[],
): ProviderCompletedMatch[] {
  const matches: ProviderCompletedMatch[] = [];

  for (const row of rows) {
    if (canonicalSportmonksLiveStatus(normalizedSportmonksState(row)) !== "finished") {
      continue;
    }
    const fixture = toProviderFixture(row);
    if (!fixture) continue;

    const regularTime = sportmonksScorePair(row.scores, "2ND_HALF");
    const current = sportmonksScorePair(row.scores, "CURRENT");
    const score =
      regularTime ??
      (normalizedSportmonksState(row) === "FT" ? current : null);
    if (!score) continue;

    matches.push({
      provider: "sportmonks",
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

export type SportmonksLeagueResult = ProviderCompletedMatch & {
  providerState: string;
  scoreSource: "2ND_HALF" | "CURRENT";
};

/**
 * Finished league matches with their 90-minute score and its provenance.
 * The `2ND_HALF` row is the cumulative regular-time score; `CURRENT` is only
 * accepted for plain `FT`, where it cannot include extra time. Matches that
 * went beyond 90 minutes without a `2ND_HALF` row are dropped. Oldest first.
 */
export function parseSportmonksLeagueResults(
  rows: SportmonksFixtureRow[],
): SportmonksLeagueResult[] {
  const matches: SportmonksLeagueResult[] = [];

  for (const row of rows) {
    const providerState = normalizedSportmonksState(row);
    if (canonicalSportmonksLiveStatus(providerState) !== "finished") continue;
    const fixture = toProviderFixture(row);
    if (!fixture) continue;

    const regularTime = sportmonksScorePair(row.scores, "2ND_HALF");
    const current = providerState === "FT"
      ? sportmonksScorePair(row.scores, "CURRENT")
      : null;
    const score = regularTime ?? current;
    if (!score) continue;

    matches.push({
      provider: "sportmonks",
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
      providerState,
      scoreSource: regularTime ? "2ND_HALF" : "CURRENT",
    });
  }

  return matches.sort(
    (a, b) =>
      Date.parse(a.kickoffAt) - Date.parse(b.kickoffAt) ||
      a.providerFixtureId.localeCompare(b.providerFixtureId),
  );
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
  const home = bestHybridAliasSimilarity(
    fixture.home.name,
    input.homeTeam,
    input.aliases?.home,
  );
  const away = bestHybridAliasSimilarity(
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
  /** Provider messages returned instead of data by league-history requests. */
  readonly emptyResponseNotices: string[] = [];

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
    return "participants;league;round;state;lineups;sidelined;scores";
  }

  async getFixturesBetween(
    startDate: string,
    endDate: string,
  ): Promise<ProviderFixture[]> {
    const rows: ProviderFixture[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const envelope = await this.request<SportmonksFixtureRow[]>(
        `/fixtures/between/${startDate}/${endDate}`,
        {
          include: "participants;league;round;state",
          page,
        },
      );

      for (const raw of requireData(envelope, "fixture date range")) {
        const fixture = toProviderFixture(raw);
        if (fixture) rows.push(fixture);
      }

      hasMore = envelope.pagination?.has_more === true;
      page = envelope.pagination?.next_page ?? page + 1;

      if (page > 100) {
        throw new Error("Sportmonks fixture pagination exceeded safety limit.");
      }
    }

    return rows;
  }

  async getTeamCompletedMatches(
    teamId: string,
    startDate: string,
    endDate: string,
  ): Promise<ProviderCompletedMatch[]> {
    if (!/^\d+$/.test(teamId)) {
      throw new Error("Sportmonks team id must be numeric.");
    }

    const rows: SportmonksFixtureRow[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const envelope = await this.request<SportmonksFixtureRow[]>(
        `/fixtures/between/${startDate}/${endDate}/${teamId}`,
        {
          include: "participants;league;round;state;scores",
          page,
        },
      );
      rows.push(...requireData(envelope, "team fixture history"));
      hasMore = envelope.pagination?.has_more === true;
      page = envelope.pagination?.next_page ?? page + 1;
      if (page > 100) {
        throw new Error("Sportmonks team fixture pagination exceeded safety limit.");
      }
    }

    return parseSportmonksCompletedMatches(rows);
  }

  /**
   * League-wide finished matches (90-minute score with provenance) in a date
   * range. Pages are advanced numerically because Sportmonks returns
   * `next_page` as a URL.
   */
  async getLeagueCompletedMatchesBetween(
    leagueId: string,
    startDate: string,
    endDate: string,
  ): Promise<SportmonksLeagueResult[]> {
    if (!/^\d+$/.test(leagueId)) {
      throw new Error("Sportmonks league id must be numeric.");
    }

    const rows: SportmonksFixtureRow[] = [];
    for (let page = 1; ; page += 1) {
      if (page > 100) {
        throw new Error("Sportmonks league fixture pagination exceeded safety limit.");
      }
      const envelope = await this.request<SportmonksFixtureRow[]>(
        `/fixtures/between/${startDate}/${endDate}`,
        {
          include: "participants;league;round;state;scores",
          filters: `fixtureLeagues:${leagueId}`,
          per_page: 50,
          page,
        },
      );
      if (envelope.data == null && envelope.message) {
        this.emptyResponseNotices.push(
          `league ${leagueId} ${startDate}..${endDate}: ${envelope.message}`,
        );
      }
      rows.push(...(envelope.data ?? []));
      if (envelope.pagination?.has_more !== true) break;
    }

    return parseSportmonksLeagueResults(rows);
  }

  async getStandings(seasonId: number): Promise<ProviderStanding[]> {
    if (!Number.isInteger(seasonId) || seasonId <= 0) {
      throw new Error("Sportmonks standings require a positive season id.");
    }
    const envelope = await this.request<SportmonksStandingRow[]>(
      `/standings/seasons/${seasonId}`,
      { include: "participant;details.type" },
    );
    return parseSportmonksStandings(
      requireData(envelope, "standings"),
    );
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

  async getLiveResultById(
    fixtureId: number,
    observedAt = new Date().toISOString(),
  ): Promise<SportmonksLiveResult | null> {
    const envelope = await this.request<SportmonksFixtureRow>(
      `/fixtures/${fixtureId}`,
      { include: "state;scores" },
    );
    return parseSportmonksLiveResult(
      requireData(envelope, "live fixture"),
      observedAt,
    );
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
