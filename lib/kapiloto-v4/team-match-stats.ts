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
export type TeamMatchStatStatus = "observed" | "not_observed" | "family_not_provided" | "not_separable";
export type TeamMatchStatValue = {
  value: number | null;
  status: TeamMatchStatStatus;
  definition_id: string;
  provider_stat_type: string;
  definition_version: string;
  period: "full_time";
};
export type TeamMatchStatsRow = {
  contract_version: "kapiloto-team-match-stats-v1";
  fixture_id: string;
  team_id: string;
  opponent_team_id: string;
  side: "home" | "away";
  neutral_venue: boolean | null;
  competition_id: string | null;
  season_key: string | null;
  provider_league_ref: string | null;
  provider_season_ref: string | null;
  provider: string;
  observation_id: string;
  observation_version: number;
  capture_mode: "scheduled_sync" | "backfill" | "manual_import";
  ingest_version: string;
  kickoff_at: string;
  first_seen_at: string;
  effective_available_at: string;
  availability_basis: "actual" | "retrospective_backfill";
  availability_policy: string | null;
  evaluation_class: "actual" | "retrospective";
  match_status: "finished";
  goals_for_90: number;
  goals_against_90: number;
  went_to_extra_time: boolean;
  penalties_for: number | null;
  penalties_against: number | null;
  stats_for: Record<TeamMatchStatKey, TeamMatchStatValue>;
  stats_against: Record<TeamMatchStatKey, TeamMatchStatValue>;
  lineup_status: "complete" | "partial" | "not_provided";
  statistics_status: "complete" | "partial" | "not_provided";
  quality_flags: string[];
};

export type TeamMatchStatsRpc = (args: {
  provider: string;
  competitionIds: string[];
  from: string;
  cutoff: string;
}) => Promise<TeamMatchStatsRow[]>;

export function loadTeamMatchStats(
  rpc: TeamMatchStatsRpc,
  args: Parameters<TeamMatchStatsRpc>[0],
): Promise<TeamMatchStatsRow[]> {
  return rpc(args);
}
