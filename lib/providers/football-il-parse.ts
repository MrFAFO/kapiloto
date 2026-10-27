import type { ProviderName } from "./types";

const DEFAULT_BASE_URL =
  "https://api.parse.bot/scraper/f13aebab-be30-4f04-8f99-36aac5f132cc";
const SNAPSHOT_VERSION = "11";

export const FOOTBALL_IL_PARSE_PROVIDER: ProviderName = "football-il-parse";

type ParseEnvelope<T> = {
  status: "success" | "error" | string;
  data?: T;
  error?: unknown;
  message?: string;
};

export type FootballIlTeam = {
  id: number;
  name?: string | null;
  hebrewName?: string | null;
  arabicName?: string | null;
  hebrewFullName?: string | null;
  hebrewCoachName?: string | null;
  leagueId?: number | null;
  leagues?: Record<string, number>;
  stadiumId?:
    | number
    | {
        id: number;
        name?: string | null;
        hebrewName?: string | null;
        arabicName?: string | null;
      }
    | null;
  logoUrl?: string | null;
};

export type FootballIlFixture = {
  id: number;
  status?: number | null;
  homeTeamId: number | FootballIlTeam;
  awayTeamId: number | FootballIlTeam;
  stadiumId?:
    | number
    | {
        id: number;
        name?: string | null;
        hebrewName?: string | null;
        arabicName?: string | null;
      }
    | null;
  league: number;
  round: number;
  stage?: string | null;
  homeScore?: number | null;
  awayScore?: number | null;
  date?: { sec: number; usec?: number };
  stringDate?: string | null;
  hour?: string | null;
  currentMinute?: number | null;
  season: string;
  optaId?: string | null;
};

export type FootballIlTeamStatistics = {
  teamId: number;
  seasonName: string;
  tournamentId: number;
  stage: string;
  expectedGoals?: number | null;
  Goal?: number | null;
  CopedGoal?: number | null;
  AttemptonGoal?: number | null;
  OnTarget?: number | null;
  ShotInsidetheArea?: number | null;
  ShotOutsidetheArea?: number | null;
  ballPossession?: number | null;
  passes?: number | null;
  accuratePasses?: number | null;
  chanceTotal?: number | null;
  cleanNet?: number | null;
  [key: string]: unknown;
};

export type FootballIlPlayerAggregate = {
  playerId: number;
  teamId?: number | null;
  seasonName?: string | null;
  tournamentId?: number | null;
  expectedGoals?: number | null;
  Goal?: number | null;
  Assist?: number | null;
  appearances?: number | null;
  passes?: number | null;
  AttemptonGoal?: number | null;
  OnTarget?: number | null;
  [key: string]: unknown;
};

export type FootballIlPlayerMatchStat = {
  player_id: number;
  player_name?: string | null;
  player_hebrew_name?: string | null;
  team_id: number;
  team_name?: string | null;
  game_id: number;
  matchday: number;
  stage?: string | null;
  season: string;
  tournament_id: number;
  position?: string | null;
  shirt_number?: string | number | null;
  appeared?: boolean | null;
  minutes_played?: number | null;
  goals?: number | null;
  assists?: number | null;
  expected_goals?: number | null;
  started?: boolean | null;
  substituted_in?: boolean | null;
  substituted_out?: boolean | null;
  substitution_minute?: number | null;
  team_clean_sheet?: boolean | null;
  [key: string]: unknown;
};

export type FootballIlPlayerSeasonSummary = {
  player_id: number;
  player_name?: string | null;
  player_hebrew_name?: string | null;
  team_id: number;
  team_name?: string | null;
  position?: string | null;
  season: string;
  tournament_id: number;
  appearances?: number | null;
  minutes_played?: number | null;
  goals?: number | null;
  assists?: number | null;
  clean_sheets?: number | null;
  matches_in_squad?: number | null;
  [key: string]: unknown;
};

export type FootballIlStandingRow = {
  id: number;
  name?: string | null;
  hebrewName?: string | null;
  position: number;
  points: number;
  wins: number;
  draws: number;
  losses: number;
  goalsScored: number;
  goalsReceived: number;
  gamesCount: number;
  [key: string]: unknown;
};

export type FootballIlStandings = Record<string, FootballIlStandingRow[]>;

export type StandingsValidationIssue = {
  stage: string;
  teamId: number | null;
  code:
    | "empty_stage"
    | "all_zero_played"
    | "played_out_of_range"
    | "points_out_of_range"
    | "negative_stat"
    | "position_out_of_range"
    | "duplicate_position";
  message: string;
};

export type StandingsValidationResult = {
  trustworthy: boolean;
  issues: StandingsValidationIssue[];
};

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function validateFootballIlStandings(
  standings: FootballIlStandings,
  options: {
    requirePlayedMatches?: boolean;
    maxPlayedMatches?: number;
  } = {},
): StandingsValidationResult {
  const issues: StandingsValidationIssue[] = [];
  const maxPlayedMatches = options.maxPlayedMatches ?? 50;

  for (const [stage, rows] of Object.entries(standings)) {
    if (!Array.isArray(rows) || rows.length === 0) {
      issues.push({
        stage,
        teamId: null,
        code: "empty_stage",
        message: `${stage} contains no standings rows.`,
      });
      continue;
    }

    if (
      options.requirePlayedMatches &&
      rows.every((row) => row.gamesCount === 0)
    ) {
      issues.push({
        stage,
        teamId: null,
        code: "all_zero_played",
        message: `${stage} has zero played matches for every team.`,
      });
    }

    const seenPositions = new Set<number>();

    for (const row of rows) {
      const teamId = finiteNumber(row.id) ? row.id : null;

      if (
        !finiteNumber(row.gamesCount) ||
        row.gamesCount < 0 ||
        row.gamesCount > maxPlayedMatches
      ) {
        issues.push({
          stage,
          teamId,
          code: "played_out_of_range",
          message: `${stage} team ${teamId ?? "unknown"} has invalid gamesCount=${String(row.gamesCount)}.`,
        });
      }

      if (
        !finiteNumber(row.points) ||
        row.points < 0 ||
        (finiteNumber(row.gamesCount) && row.points > row.gamesCount * 3)
      ) {
        issues.push({
          stage,
          teamId,
          code: "points_out_of_range",
          message: `${stage} team ${teamId ?? "unknown"} has invalid points=${String(row.points)} for gamesCount=${String(row.gamesCount)}.`,
        });
      }

      for (const value of [
        row.wins,
        row.draws,
        row.losses,
        row.goalsScored,
        row.goalsReceived,
      ]) {
        if (!finiteNumber(value) || value < 0) {
          issues.push({
            stage,
            teamId,
            code: "negative_stat",
            message: `${stage} team ${teamId ?? "unknown"} has a negative or non-numeric standing statistic.`,
          });
          break;
        }
      }

      if (
        !finiteNumber(row.position) ||
        row.position < 1 ||
        row.position > rows.length
      ) {
        issues.push({
          stage,
          teamId,
          code: "position_out_of_range",
          message: `${stage} team ${teamId ?? "unknown"} has invalid position=${String(row.position)}.`,
        });
      } else if (seenPositions.has(row.position)) {
        issues.push({
          stage,
          teamId,
          code: "duplicate_position",
          message: `${stage} contains duplicate position ${row.position}.`,
        });
      } else {
        seenPositions.add(row.position);
      }
    }
  }

  return {
    trustworthy: issues.length === 0,
    issues,
  };
}

export class FootballIlParseClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = DEFAULT_BASE_URL,
  ) {
    if (!apiKey.trim()) {
      throw new Error("PARSE_API_KEY is required.");
    }
  }

  private async request<T>(
    endpoint: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<T> {
    const url = new URL(
      endpoint.startsWith("/")
        ? `${this.baseUrl}${endpoint}`
        : `${this.baseUrl}/${endpoint}`,
    );

    for (const [key, value] of Object.entries(params)) {
      if (value != null) url.searchParams.set(key, String(value));
    }

    const response = await fetch(url, {
      headers: {
        "X-API-Key": this.apiKey,
        "API-Snapshot-Version": SNAPSHOT_VERSION,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(
        `football.co.il Parse HTTP ${response.status} for ${url.pathname}`,
      );
    }

    const envelope = (await response.json()) as ParseEnvelope<T>;
    if (envelope.status !== "success" || envelope.data == null) {
      throw new Error(
        envelope.message ||
          `football.co.il Parse returned status=${String(envelope.status)} for ${endpoint}`,
      );
    }

    return envelope.data;
  }

  getAllTeams(tournamentId = 902): Promise<{ teams: FootballIlTeam[] }> {
    return this.request("get_all_teams", {
      tournament_id: tournamentId,
    });
  }

  getTeamProfile(teamId: number): Promise<FootballIlTeam> {
    return this.request("get_team_profile", { team_id: teamId });
  }

  getTeamSquad(teamId: number): Promise<{ players: FootballIlTeam[] }> {
    return this.request("get_team_squad", { team_id: teamId });
  }

  getTeamFixtures(teamId: number): Promise<{ fixtures: FootballIlFixture[] } | FootballIlFixture[]> {
    return this.request("get_team_fixtures", { team_id: teamId });
  }

  getTeamStatistics(
    season: string,
    teamId: number,
  ): Promise<{ stats: FootballIlTeamStatistics[] }> {
    return this.request("get_team_statistics", {
      season,
      team_id: teamId,
    });
  }

  getLeagueStandings(
    season: string,
    tournamentId = 902,
  ): Promise<FootballIlStandings> {
    return this.request("get_league_standings", {
      season,
      tournament_id: tournamentId,
    });
  }

  getFixturesByMatchday(
    season: string,
    matchday: number,
    tournamentId = 902,
  ): Promise<{ fixtures: FootballIlFixture[]; round_info?: unknown }> {
    return this.request("get_fixtures_by_matchday", {
      season,
      tournament_id: tournamentId,
      matchday,
    });
  }

  getMatchDetails(gameId: number): Promise<FootballIlFixture> {
    return this.request("get_match_details", { game_id: gameId });
  }

  getMatchStatistics(
    gameId: number,
  ): Promise<{ stats: FootballIlTeamStatistics[] }> {
    return this.request("get_match_statistics", { game_id: gameId });
  }

  getPlayerStatsLeaders(
    season: string,
    tournamentId = 902,
  ): Promise<{ players: FootballIlPlayerAggregate[] }> {
    return this.request("get_player_stats_leaders", {
      season,
      tournament_id: tournamentId,
    });
  }

  getTopScorers(
    season: string,
    tournamentId = 902,
  ): Promise<{ players: FootballIlPlayerAggregate[] }> {
    return this.request("get_top_scorers", {
      season,
      tournament_id: tournamentId,
    });
  }

  getPlayerMatchStats(
    season: string,
    options: {
      tournamentId?: number;
      teamId?: number;
      matchday?: number;
      page?: number;
      limit?: number;
    } = {},
  ): Promise<{
    season: string;
    tournament_id: number;
    team_id?: number | null;
    matchday?: number | null;
    total_records: number;
    page: number;
    limit: number;
    has_more: boolean;
    unavailable_fields?: string[];
    records: FootballIlPlayerMatchStat[];
  }> {
    return this.request("get_player_match_stats", {
      season,
      tournament_id: options.tournamentId ?? 902,
      team_id: options.teamId,
      matchday: options.matchday,
      page: options.page ?? 1,
      limit: options.limit ?? 2000,
    });
  }

  getPlayerSeasonSummary(
    season: string,
    tournamentId = 902,
  ): Promise<{
    season: string;
    tournament_id: number;
    matches_counted: number;
    total_players: number;
    players: FootballIlPlayerSeasonSummary[];
  }> {
    return this.request("get_player_season_summary", {
      season,
      tournament_id: tournamentId,
    });
  }
}
