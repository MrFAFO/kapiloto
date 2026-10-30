import {
  TEAM_MATCH_STATS_FUNCTIONS,
  assertTeamMatchStatsQuery,
  parseTeamMatchStatsRows,
  type TeamMatchStatsQuery,
  type TeamMatchStatsResult,
} from "../team-match-stats";
import { RETROSPECTIVE_TRAINING_AVAILABILITY_VERSION, TEAM_MATCH_STATS_CONTRACT_VERSION } from "../versions";

/**
 * TRAINING-ONLY retrospective read (kapiloto-retrospective-training-availability-v1).
 *
 * Backfilled history becomes available at min(first_seen_at, kickoff_at + 24h)
 * for version 1 only. That is an approximation of when a post-match report
 * would typically exist, NOT a reconstruction of what Kapiloto or the provider
 * knew live. Rows carry evaluation_class = 'retrospective'.
 *
 * Never import this from live prediction, squad-state, lineup or registry code
 * (boundaries.test.ts enforces it), and never present results built from it as
 * live-simulation or prospective performance. It is deliberately not exported
 * from lib/kapiloto-v4/index.ts.
 */

export type TeamMatchStatsTrainingRpc = (
  fn: typeof TEAM_MATCH_STATS_FUNCTIONS.forTraining,
  args: { p_provider: string; p_competition_ids: string[] | null; p_from: string | null; p_training_cutoff: string; p_policy: string },
) => Promise<unknown>;

export async function loadTeamMatchStatsForTraining(
  rpc: TeamMatchStatsTrainingRpc,
  query: TeamMatchStatsQuery & { trainingCutoff: string },
): Promise<TeamMatchStatsResult> {
  assertTeamMatchStatsQuery(query, query.trainingCutoff);
  const value = await rpc(TEAM_MATCH_STATS_FUNCTIONS.forTraining, {
    p_provider: query.provider,
    p_competition_ids: query.competitionIds?.map((id) => id.toLowerCase()) ?? null,
    p_from: query.from,
    p_training_cutoff: query.trainingCutoff,
    p_policy: RETROSPECTIVE_TRAINING_AVAILABILITY_VERSION,
  });
  return {
    contractVersion: TEAM_MATCH_STATS_CONTRACT_VERSION,
    evaluationClass: "retrospective",
    availabilityPolicy: RETROSPECTIVE_TRAINING_AVAILABILITY_VERSION,
    provider: query.provider,
    cutoff: query.trainingCutoff,
    rows: parseTeamMatchStatsRows(value, {
      evaluationClass: "retrospective",
      availabilityPolicy: RETROSPECTIVE_TRAINING_AVAILABILITY_VERSION,
      provider: query.provider,
      cutoff: query.trainingCutoff,
    }),
  };
}
