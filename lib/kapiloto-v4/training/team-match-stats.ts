import { RETROSPECTIVE_TRAINING_AVAILABILITY_VERSION } from "../versions";
import type { TeamMatchStatsRow } from "../team-match-stats";

export type TrainingTeamMatchStatsRpc = (args: {
  provider: string;
  competitionIds: string[];
  from: string;
  trainingCutoff: string;
  policy: typeof RETROSPECTIVE_TRAINING_AVAILABILITY_VERSION;
}) => Promise<TeamMatchStatsRow[]>;

export function loadTeamMatchStatsForTraining(
  rpc: TrainingTeamMatchStatsRpc,
  args: Omit<Parameters<TrainingTeamMatchStatsRpc>[0], "policy">,
): Promise<TeamMatchStatsRow[]> {
  return rpc({ ...args, policy: RETROSPECTIVE_TRAINING_AVAILABILITY_VERSION });
}
