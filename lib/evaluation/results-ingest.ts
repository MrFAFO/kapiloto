import type { ProviderCompletedMatch } from "@/lib/providers/types";

import { RESULT_KNOWN_AFTER_KICKOFF_MINUTES, parseInstant } from "./history";

export const FOOTBALL_RESULTS_INGEST_VERSION = "football-results-ingest-v1";

/** Sportmonks date-range endpoints accept at most 100 days per request. */
export const MAX_RESULTS_WINDOW_DAYS = 90;

export interface LeagueResultsSource {
  getLeagueCompletedMatchesBetween(
    leagueId: string,
    startDate: string,
    endDate: string,
  ): Promise<ProviderCompletedMatch[]>;
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
  neutral_venue: boolean;
  observed_at: string;
  ingest_version: string;
};

export interface MatchResultSink {
  saveResults(rows: MatchResultRow[]): Promise<number>;
}

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

/**
 * Converts a provider result into an immutable history row. Rows are only
 * produced for the requested league and only once the match could have
 * finished by the observation time.
 */
export function toMatchResultRow(
  match: ProviderCompletedMatch,
  options: { leagueId: string; observedAt: string },
): MatchResultRow | null {
  if (match.competition.id !== options.leagueId) return null;
  if (match.home.id === match.away.id) return null;
  if (
    !Number.isInteger(match.homeScore) ||
    !Number.isInteger(match.awayScore) ||
    match.homeScore < 0 ||
    match.awayScore < 0
  ) {
    return null;
  }
  const kickoffMs = parseInstant(match.kickoffAt, "kickoffAt");
  const observedMs = parseInstant(options.observedAt, "observedAt");
  if (kickoffMs + RESULT_KNOWN_AFTER_KICKOFF_MINUTES * 60_000 > observedMs) {
    return null;
  }

  return {
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
    neutral_venue: false,
    observed_at: new Date(observedMs).toISOString(),
    ingest_version: FOOTBALL_RESULTS_INGEST_VERSION,
  };
}

export async function ingestLeagueResults(
  source: LeagueResultsSource,
  sink: MatchResultSink,
  options: { leagueId: string; startDate: string; endDate: string; now?: Date },
): Promise<{ windows: number; fetched: number; eligible: number; saved: number }> {
  const observedAt = (options.now ?? new Date()).toISOString();
  let fetched = 0;
  let eligible = 0;
  let saved = 0;
  const windows = dateWindows(options.startDate, options.endDate);

  for (const window of windows) {
    const matches = await source.getLeagueCompletedMatchesBetween(
      options.leagueId,
      window.start,
      window.end,
    );
    fetched += matches.length;
    const rows = matches
      .map((match) => toMatchResultRow(match, { leagueId: options.leagueId, observedAt }))
      .filter((row): row is MatchResultRow => row != null);
    eligible += rows.length;
    if (rows.length > 0) saved += await sink.saveResults(rows);
  }

  return { windows: windows.length, fetched, eligible, saved };
}
