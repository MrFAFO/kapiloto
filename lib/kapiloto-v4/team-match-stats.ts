import type { DataStatus, MatchStatus, TeamSide } from "./match-ledger";
import { TEAM_MATCH_STATS_CONTRACT_VERSION } from "./versions";

/**
 * kapiloto-team-match-stats-v1: canonical per-team, per-fixture match stats
 * read from the Match Ledger. One row per team per selected finished fixture,
 * one provider per call, never zero for missing.
 *
 * This module is the STRICT as-of loader: a row exists only if the ledger
 * actually knew the observation at the cutoff (first_seen_at <= cutoff). The
 * retrospective training read lives in ./training/team-match-stats and must
 * never feed live predictions or the prediction registry.
 */

export const TEAM_MATCH_STAT_KEYS = [
  "expected_goals",
  "expected_goals_on_target",
  "expected_non_penalty_goals",
  "shots_total",
  "shots_on_target",
  "possession_pct",
  "corners",
] as const;
export type TeamMatchStatKey = (typeof TEAM_MATCH_STAT_KEYS)[number];

export const TEAM_MATCH_STAT_FAMILY: Readonly<Record<TeamMatchStatKey, "xg" | "statistics">> = {
  expected_goals: "xg",
  expected_goals_on_target: "xg",
  expected_non_penalty_goals: "xg",
  shots_total: "statistics",
  shots_on_target: "statistics",
  possession_pct: "statistics",
  corners: "statistics",
};

/**
 * observed: a value exists. not_observed: the family was fetched and the key
 * was absent (or unusable). family_not_provided: the family was not
 * requested, or the observation has no recorded family status.
 * not_separable: the match went to extra time; whole-match stats are not 90'.
 */
export const TEAM_MATCH_STAT_STATUSES = ["observed", "not_observed", "family_not_provided", "not_separable"] as const;
export type TeamMatchStatStatus = (typeof TEAM_MATCH_STAT_STATUSES)[number];

export type TeamMatchStatEntry = {
  value: number | null;
  status: TeamMatchStatStatus;
  definition_id: string | null;
  provider_stat_type: string | null;
  definition_version: string | null;
  period: "full_time" | null;
};

export type TeamMatchStatsRow = {
  fixture_id: string;
  team_id: string;
  opponent_team_id: string;
  side: TeamSide;
  neutral_venue: boolean | null;
  competition_id: string | null;
  season_key: string | null;
  provider_league_ref: string | null;
  provider_season_ref: string | null;
  provider: string;
  observation_id: string;
  observation_version: number;
  capture_mode: string;
  ingest_version: string;
  kickoff_at: string;
  first_seen_at: string;
  effective_available_at: string;
  availability_basis: "actual" | "retrospective_backfill";
  availability_policy: string | null;
  evaluation_class: "actual" | "retrospective";
  match_status: MatchStatus;
  goals_for_90: number;
  goals_against_90: number;
  went_to_extra_time: boolean;
  penalties_for: number | null;
  penalties_against: number | null;
  stats_for: Record<TeamMatchStatKey, TeamMatchStatEntry>;
  stats_against: Record<TeamMatchStatKey, TeamMatchStatEntry>;
  lineup_status: DataStatus;
  statistics_status: DataStatus;
  quality_flags: string[];
};

export type TeamMatchStatsResult = {
  contractVersion: typeof TEAM_MATCH_STATS_CONTRACT_VERSION;
  evaluationClass: "actual" | "retrospective";
  availabilityPolicy: string | null;
  provider: string;
  cutoff: string;
  rows: TeamMatchStatsRow[];
};

export const TEAM_MATCH_STATS_FUNCTIONS = {
  asOf: "match_ledger_team_match_stats_as_of",
  forTraining: "match_ledger_team_match_stats_for_training",
} as const;

export type TeamMatchStatsQuery = {
  provider: string;
  /** Null: every competition. */
  competitionIds: string[] | null;
  /** Inclusive lower kickoff bound; null: no lower bound. */
  from: string | null;
};

export type TeamMatchStatsRpc = (
  fn: typeof TEAM_MATCH_STATS_FUNCTIONS.asOf,
  args: { p_provider: string; p_competition_ids: string[] | null; p_from: string | null; p_cutoff: string },
) => Promise<unknown>;

const isInstant = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));

function parseEntry(value: unknown, label: string): TeamMatchStatEntry {
  if (typeof value !== "object" || value === null) throw new Error(`${label} must be an object`);
  const entry = value as Record<string, unknown>;
  const status = entry.status as TeamMatchStatStatus;
  if (!(TEAM_MATCH_STAT_STATUSES as readonly string[]).includes(status)) throw new Error(`${label} has an unknown status`);
  const raw = entry.value;
  const number = raw === null || raw === undefined ? null : typeof raw === "number" ? raw : Number(raw);
  if (status === "observed" ? number === null || !Number.isFinite(number) : number !== null) {
    throw new Error(`${label}: only observed stats carry a value`);
  }
  return {
    value: number,
    status,
    definition_id: (entry.definition_id as string | null) ?? null,
    provider_stat_type: (entry.provider_stat_type as string | null) ?? null,
    definition_version: (entry.definition_version as string | null) ?? null,
    period: (entry.period as "full_time" | null) ?? null,
  };
}

function parseStats(value: unknown, label: string): Record<TeamMatchStatKey, TeamMatchStatEntry> {
  if (typeof value !== "object" || value === null) throw new Error(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...TEAM_MATCH_STAT_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) throw new Error(`${label} must carry exactly the v1 stat keys`);
  return Object.fromEntries(TEAM_MATCH_STAT_KEYS.map((key) => [key, parseEntry(record[key], `${label}.${key}`)])) as Record<
    TeamMatchStatKey,
    TeamMatchStatEntry
  >;
}

/** Structural check of the read rows; refuses rows from the wrong availability class. */
export function parseTeamMatchStatsRows(
  value: unknown,
  expected: { evaluationClass: "actual" | "retrospective"; availabilityPolicy: string | null; provider: string; cutoff: string },
): TeamMatchStatsRow[] {
  if (!Array.isArray(value)) throw new Error("team match stats must be an array");
  const cutoffMs = Date.parse(expected.cutoff);
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null) throw new Error(`team match stats row ${index} must be an object`);
    const row = item as Record<string, unknown>;
    for (const key of ["fixture_id", "team_id", "opponent_team_id", "observation_id", "provider", "ingest_version", "capture_mode"]) {
      if (typeof row[key] !== "string") throw new Error(`team match stats row ${index}: ${key} must be a string`);
    }
    for (const key of ["kickoff_at", "first_seen_at", "effective_available_at"]) {
      if (!isInstant(row[key])) throw new Error(`team match stats row ${index}: ${key} must be an instant`);
    }
    if (row.provider !== expected.provider) throw new Error(`team match stats row ${index}: unexpected provider`);
    if (row.evaluation_class !== expected.evaluationClass) throw new Error(`team match stats row ${index}: unexpected evaluation class`);
    if ((row.availability_policy ?? null) !== expected.availabilityPolicy) throw new Error(`team match stats row ${index}: unexpected availability policy`);
    if (row.match_status !== "finished") throw new Error(`team match stats row ${index}: not finished`);
    if (Date.parse(row.kickoff_at as string) >= cutoffMs) throw new Error(`team match stats row ${index}: kickoff is not before the cutoff`);
    if (Date.parse(row.effective_available_at as string) > cutoffMs) throw new Error(`team match stats row ${index}: not available at the cutoff`);
    if (expected.evaluationClass === "actual") {
      if (row.availability_basis !== "actual" || Date.parse(row.first_seen_at as string) > cutoffMs) {
        throw new Error(`team match stats row ${index}: not actually known at the cutoff`);
      }
    } else if (row.availability_basis !== "actual" && row.availability_basis !== "retrospective_backfill") {
      throw new Error(`team match stats row ${index}: unknown availability basis`);
    }
    if (typeof row.goals_for_90 !== "number" || typeof row.goals_against_90 !== "number") {
      throw new Error(`team match stats row ${index}: finished rows carry the 90-minute score`);
    }
    if (!Array.isArray(row.quality_flags)) throw new Error(`team match stats row ${index}: quality_flags must be an array`);
    return {
      ...(row as unknown as TeamMatchStatsRow),
      stats_for: parseStats(row.stats_for, `row ${index} stats_for`),
      stats_against: parseStats(row.stats_against, `row ${index} stats_against`),
    };
  });
}

/** Shared query validation of the strict and training loaders. */
export function assertTeamMatchStatsQuery(query: TeamMatchStatsQuery, cutoff: string): void {
  if (!/^[a-z0-9_]{1,40}$/.test(query.provider)) throw new Error("team match stats need one provider");
  if (!isInstant(cutoff)) throw new Error("team match stats need a cutoff instant");
  if (query.from !== null && !isInstant(query.from)) throw new Error("from must be an instant or null");
  if (query.competitionIds !== null && query.competitionIds.length === 0) throw new Error("competitionIds must be null or non-empty");
}

/** Strict as-of read: only observations the ledger actually knew at the cutoff. */
export async function loadTeamMatchStats(
  rpc: TeamMatchStatsRpc,
  query: TeamMatchStatsQuery & { cutoff: string },
): Promise<TeamMatchStatsResult> {
  assertTeamMatchStatsQuery(query, query.cutoff);
  const value = await rpc(TEAM_MATCH_STATS_FUNCTIONS.asOf, {
    p_provider: query.provider,
    p_competition_ids: query.competitionIds?.map((id) => id.toLowerCase()) ?? null,
    p_from: query.from,
    p_cutoff: query.cutoff,
  });
  return {
    contractVersion: TEAM_MATCH_STATS_CONTRACT_VERSION,
    evaluationClass: "actual",
    availabilityPolicy: null,
    provider: query.provider,
    cutoff: query.cutoff,
    rows: parseTeamMatchStatsRows(value, { evaluationClass: "actual", availabilityPolicy: null, provider: query.provider, cutoff: query.cutoff }),
  };
}
