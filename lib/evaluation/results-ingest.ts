import type { SportmonksLeagueResult } from "@/lib/providers/sportmonks";

import { RESULT_KNOWN_AFTER_KICKOFF_MINUTES, parseInstant } from "./history";

export const FOOTBALL_RESULTS_INGEST_VERSION = "football-results-ingest-v1";

/** Sportmonks date-range endpoints accept at most 100 days per request. */
export const MAX_RESULTS_WINDOW_DAYS = 90;

export const DEFAULT_BACKFILL_YEARS = 3;

export interface LeagueResultsSource {
  getLeagueCompletedMatchesBetween(
    leagueId: string,
    startDate: string,
    endDate: string,
  ): Promise<SportmonksLeagueResult[]>;
}

export type MatchResultRow = {
  provider: string;
  provider_fixture_id: string;
  provider_competition_id: string;
  competition_name: string | null;
  provider_season_id: string | null;
  kickoff_at: string;
  provider_home_team_id: string;
  provider_home_team_name: string | null;
  provider_away_team_id: string;
  provider_away_team_name: string | null;
  home_goals_90: number;
  away_goals_90: number;
  result_basis: "regular_time";
  provider_state: string;
  score_source: "2ND_HALF" | "CURRENT";
  neutral_venue: boolean;
  /** Informational; the database stamps its own observation time. */
  observed_at: string;
  ingest_version: string;
};

export interface MatchResultSink {
  saveResults(rows: MatchResultRow[]): Promise<number>;
}

export type MatchResultRejection =
  | "other_competition"
  | "same_team"
  | "invalid_score"
  | "not_yet_final";

const DAY_MS = 86_400_000;

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function dateWindows(
  startDate: string,
  endDate: string,
  maxDays = MAX_RESULTS_WINDOW_DAYS,
): Array<{ start: string; end: string }> {
  const startMs = parseInstant(`${startDate}T00:00:00Z`, "startDate");
  const endMs = parseInstant(`${endDate}T00:00:00Z`, "endDate");
  if (endMs < startMs) throw new Error("endDate must not be before startDate.");
  const windows: Array<{ start: string; end: string }> = [];
  for (let from = startMs; from <= endMs; from += maxDays * DAY_MS) {
    const to = Math.min(endMs, from + (maxDays - 1) * DAY_MS);
    windows.push({ start: isoDate(from), end: isoDate(to) });
  }
  return windows;
}

export function classifyMatchResult(
  match: SportmonksLeagueResult,
  options: { leagueId: string; observedAt: string },
): { row: MatchResultRow } | { rejected: MatchResultRejection } {
  if (match.competition.id !== options.leagueId) return { rejected: "other_competition" };
  if (match.home.id === match.away.id) return { rejected: "same_team" };
  if (
    !Number.isInteger(match.homeScore) ||
    !Number.isInteger(match.awayScore) ||
    match.homeScore < 0 ||
    match.awayScore < 0
  ) {
    return { rejected: "invalid_score" };
  }
  const kickoffMs = parseInstant(match.kickoffAt, "kickoffAt");
  const observedMs = parseInstant(options.observedAt, "observedAt");
  if (kickoffMs + RESULT_KNOWN_AFTER_KICKOFF_MINUTES * 60_000 > observedMs) {
    return { rejected: "not_yet_final" };
  }

  return {
    row: {
      provider: match.provider,
      provider_fixture_id: match.providerFixtureId,
      provider_competition_id: match.competition.id,
      competition_name: match.competition.name || null,
      provider_season_id: match.season == null ? null : String(match.season),
      kickoff_at: new Date(kickoffMs).toISOString(),
      provider_home_team_id: match.home.id,
      provider_home_team_name: match.home.name || null,
      provider_away_team_id: match.away.id,
      provider_away_team_name: match.away.name || null,
      home_goals_90: match.homeScore,
      away_goals_90: match.awayScore,
      result_basis: "regular_time",
      provider_state: match.providerState,
      score_source: match.scoreSource,
      neutral_venue: false,
      observed_at: new Date(observedMs).toISOString(),
      ingest_version: FOOTBALL_RESULTS_INGEST_VERSION,
    },
  };
}

/**
 * Converts a provider result into an immutable history row. Rows are only
 * produced for the requested league and only once the match could have
 * finished by the observation time.
 */
export function toMatchResultRow(
  match: SportmonksLeagueResult,
  options: { leagueId: string; observedAt: string },
): MatchResultRow | null {
  const result = classifyMatchResult(match, options);
  return "row" in result ? result.row : null;
}

function compareRows(a: MatchResultRow, b: MatchResultRow): number {
  return (
    Date.parse(a.kickoff_at) - Date.parse(b.kickoff_at) ||
    a.provider_fixture_id.localeCompare(b.provider_fixture_id)
  );
}

export type LeagueIngestSummary = {
  leagueId: string;
  startDate: string;
  endDate: string;
  windows: number;
  fetched: number;
  eligible: number;
  duplicatesInFetch: number;
  rejected: Partial<Record<MatchResultRejection, number>>;
  scoreSources: Partial<Record<"2ND_HALF" | "CURRENT", number>>;
  seasons: Record<string, number>;
  firstKickoffAt: string | null;
  lastKickoffAt: string | null;
  saved: number;
  dryRun: boolean;
};

/**
 * Chronological, idempotent league backfill: windows are fetched oldest
 * first, rows are de-duplicated by provider fixture and written in kickoff
 * order. The sink ignores rows that already exist. With `dryRun` nothing is
 * written.
 */
export async function ingestLeagueResults(
  source: LeagueResultsSource,
  sink: MatchResultSink | null,
  options: {
    leagueId: string;
    startDate: string;
    endDate: string;
    now?: Date;
    dryRun?: boolean;
    onRows?: (rows: MatchResultRow[]) => void;
  },
): Promise<LeagueIngestSummary> {
  const dryRun = options.dryRun === true || sink == null;
  const observedAt = (options.now ?? new Date()).toISOString();
  const windows = dateWindows(options.startDate, options.endDate);
  const seen = new Set<string>();
  const summary: LeagueIngestSummary = {
    leagueId: options.leagueId,
    startDate: options.startDate,
    endDate: options.endDate,
    windows: windows.length,
    fetched: 0,
    eligible: 0,
    duplicatesInFetch: 0,
    rejected: {},
    scoreSources: {},
    seasons: {},
    firstKickoffAt: null,
    lastKickoffAt: null,
    saved: 0,
    dryRun,
  };

  for (const window of windows) {
    const matches = await source.getLeagueCompletedMatchesBetween(
      options.leagueId,
      window.start,
      window.end,
    );
    summary.fetched += matches.length;
    const rows: MatchResultRow[] = [];
    for (const match of matches) {
      const result = classifyMatchResult(match, { leagueId: options.leagueId, observedAt });
      if ("rejected" in result) {
        summary.rejected[result.rejected] = (summary.rejected[result.rejected] ?? 0) + 1;
        continue;
      }
      const key = `${result.row.provider}:${result.row.provider_fixture_id}`;
      if (seen.has(key)) {
        summary.duplicatesInFetch += 1;
        continue;
      }
      seen.add(key);
      rows.push(result.row);
    }
    rows.sort(compareRows);

    for (const row of rows) {
      summary.scoreSources[row.score_source] = (summary.scoreSources[row.score_source] ?? 0) + 1;
      const season = row.provider_season_id ?? "unknown";
      summary.seasons[season] = (summary.seasons[season] ?? 0) + 1;
      if (summary.firstKickoffAt == null || row.kickoff_at < summary.firstKickoffAt) {
        summary.firstKickoffAt = row.kickoff_at;
      }
      if (summary.lastKickoffAt == null || row.kickoff_at > summary.lastKickoffAt) {
        summary.lastKickoffAt = row.kickoff_at;
      }
    }
    summary.eligible += rows.length;
    options.onRows?.(rows);
    if (!dryRun && rows.length > 0 && sink) summary.saved += await sink.saveResults(rows);
  }

  return summary;
}

/** Backfill window ending yesterday (UTC) and starting `years` earlier. */
export function backfillRange(now: Date, years = DEFAULT_BACKFILL_YEARS): {
  startDate: string;
  endDate: string;
} {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const start = new Date(Date.UTC(end.getUTCFullYear() - years, end.getUTCMonth(), end.getUTCDate() + 1));
  return { startDate: isoDate(start.getTime()), endDate: isoDate(end.getTime()) };
}

/**
 * Recurring (incremental) results ingestion keeps league history current
 * after the one-time backfill, so p_stat and league base rates do not freeze.
 * It never performs a silent multi-year backfill: with no stored rows it only
 * looks back `initialLookbackDays`; the full backfill stays an explicit step.
 */
export type IncrementalIngestConfig = {
  /** Re-read this many days before the latest stored kickoff (late corrections, postponements). */
  overlapDays: number;
  /** Window used for a league with no stored rows. */
  initialLookbackDays: number;
  /** Minimum hours between incremental runs. */
  minHoursBetweenRuns: number;
};

export const DEFAULT_INCREMENTAL_INGEST_CONFIG: IncrementalIngestConfig = {
  overlapDays: 7,
  initialLookbackDays: 30,
  minHoursBetweenRuns: 20,
};

export type IncrementalIngestPlanItem = { leagueId: string; startDate: string; endDate: string };

export function planIncrementalIngest(
  now: Date,
  leagueIds: readonly string[],
  latestKickoffByLeague: ReadonlyMap<string, string | null>,
  config: IncrementalIngestConfig = DEFAULT_INCREMENTAL_INGEST_CONFIG,
): IncrementalIngestPlanItem[] {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1);
  return [...new Set(leagueIds)]
    .sort()
    .flatMap((leagueId) => {
      const latest = latestKickoffByLeague.get(leagueId);
      const latestMs = latest ? Date.parse(latest) : Number.NaN;
      const latestDay = Number.isFinite(latestMs)
        ? Date.UTC(new Date(latestMs).getUTCFullYear(), new Date(latestMs).getUTCMonth(), new Date(latestMs).getUTCDate())
        : Number.NaN;
      const start = Number.isFinite(latestDay)
        ? latestDay - config.overlapDays * DAY_MS
        : end - (config.initialLookbackDays - 1) * DAY_MS;
      return start > end ? [] : [{ leagueId, startDate: isoDate(start), endDate: isoDate(end) }];
    });
}

/** Whether an incremental run is due, from the latest stored observation time. */
export function incrementalIngestDue(
  latestObservedAt: string | null,
  now: Date,
  config: IncrementalIngestConfig = DEFAULT_INCREMENTAL_INGEST_CONFIG,
): boolean {
  if (latestObservedAt == null) return true;
  const observedMs = Date.parse(latestObservedAt);
  if (!Number.isFinite(observedMs)) return true;
  return now.getTime() - observedMs >= config.minHoursBetweenRuns * 3_600_000;
}

export async function ingestRecentLeagueResults(
  source: LeagueResultsSource,
  sink: MatchResultSink | null,
  options: { plan: readonly IncrementalIngestPlanItem[]; now: Date; dryRun?: boolean },
): Promise<LeagueIngestSummary[]> {
  const summaries: LeagueIngestSummary[] = [];
  for (const item of options.plan) {
    summaries.push(
      await ingestLeagueResults(source, sink, {
        leagueId: item.leagueId,
        startDate: item.startDate,
        endDate: item.endDate,
        now: options.now,
        dryRun: options.dryRun,
      }),
    );
  }
  return summaries;
}
