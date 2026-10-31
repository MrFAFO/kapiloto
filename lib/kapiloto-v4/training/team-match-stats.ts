import {
  TEAM_MATCH_STATS_FUNCTIONS,
  assertTeamMatchStatsQuery,
  parseTeamMatchStatsRows,
  type TeamMatchStatsQuery,
  type TeamMatchStatsResult,
} from "../team-match-stats";
import {
  RETROSPECTIVE_TRAINING_AVAILABILITY_VERSION,
  TEAM_MATCH_STATS_CONTRACT_VERSION,
  TEAM_MATCH_STATS_V2_CONTRACT_VERSION,
} from "../versions";

/**
 * TRAINING-ONLY retrospective read (kapiloto-retrospective-training-availability-v1).
 *
 * Backfilled history becomes available at min(first_seen_at, kickoff_at + 24h)
 * for version 1 only. That is an approximation of when a post-match report
 * would typically exist, NOT a reconstruction of what Kapiloto or the provider
 * knew live. Rows carry evaluation_class = 'retrospective'. A chain with a
 * later correction or withdrawal that is not yet effective at the training
 * cutoff is omitted (see loadRetrospectiveTrainingExclusions).
 *
 * Never import this from live prediction, squad-state, lineup or registry code
 * (boundaries.test.ts enforces it), and never present results built from it as
 * live-simulation or prospective performance. It is deliberately not exported
 * from lib/kapiloto-v4/index.ts.
 */

/**
 * Known-superseded content is excluded, never rewritten: a fixture chain whose
 * historically effective version has a later correction or withdrawal in the
 * ledger today is left out of training rows at that cutoff. This report lists
 * those exclusions (same filters as the training read) so they can be counted
 * apart from ordinary stat missingness. Not football data.
 */
export const RETROSPECTIVE_TRAINING_EXCLUSIONS_FUNCTION = "match_ledger_retrospective_training_exclusions";
export const RETROSPECTIVE_EXCLUSION_REASONS = ["later_correction", "later_withdrawal"] as const;
export type RetrospectiveExclusionReason = (typeof RETROSPECTIVE_EXCLUSION_REASONS)[number];

export type RetrospectiveTrainingExclusion = {
  fixture_id: string;
  provider: string;
  competition_id: string | null;
  kickoff_at: string;
  selected_observation_id: string;
  selected_observation_version: number;
  effective_available_at: string;
  availability_basis: "actual" | "retrospective_backfill";
  latest_observation_id: string;
  latest_observation_version: number;
  latest_observation_kind: "observation" | "withdrawal";
  latest_first_seen_at: string;
  exclusion_reason: RetrospectiveExclusionReason;
  availability_policy: typeof RETROSPECTIVE_TRAINING_AVAILABILITY_VERSION;
};

export type RetrospectiveTrainingExclusionsRpc = (
  fn: typeof RETROSPECTIVE_TRAINING_EXCLUSIONS_FUNCTION,
  args: { p_provider: string; p_competition_ids: string[] | null; p_from: string | null; p_training_cutoff: string; p_policy: string },
) => Promise<unknown>;

export async function loadRetrospectiveTrainingExclusions(
  rpc: RetrospectiveTrainingExclusionsRpc,
  query: TeamMatchStatsQuery & { trainingCutoff: string },
): Promise<RetrospectiveTrainingExclusion[]> {
  assertTeamMatchStatsQuery(query, query.trainingCutoff);
  const value = await rpc(RETROSPECTIVE_TRAINING_EXCLUSIONS_FUNCTION, {
    p_provider: query.provider,
    p_competition_ids: query.competitionIds?.map((id) => id.toLowerCase()) ?? null,
    p_from: query.from,
    p_training_cutoff: query.trainingCutoff,
    p_policy: RETROSPECTIVE_TRAINING_AVAILABILITY_VERSION,
  });
  if (!Array.isArray(value)) throw new Error("retrospective training exclusions must be an array");
  return value.map((item, index) => {
    const row = item as Record<string, unknown>;
    if (!(RETROSPECTIVE_EXCLUSION_REASONS as readonly string[]).includes(row.exclusion_reason as string)) {
      throw new Error(`retrospective exclusion ${index} has an unknown reason`);
    }
    if (row.availability_policy !== RETROSPECTIVE_TRAINING_AVAILABILITY_VERSION) throw new Error(`retrospective exclusion ${index}: unexpected policy`);
    if (!(Number(row.latest_observation_version) > Number(row.selected_observation_version))) {
      throw new Error(`retrospective exclusion ${index}: the latest version must be later than the selected one`);
    }
    return row as unknown as RetrospectiveTrainingExclusion;
  });
}

/**
 * Stage 1 (D-058) trust-aware exclusions: the V1 reasons plus the trust
 * reasons of the version the V2 training read would otherwise select. A trust
 * exclusion's latest version may be the selected version itself.
 */
export const RETROSPECTIVE_TRAINING_EXCLUSIONS_V2_FUNCTION = "match_ledger_retrospective_training_exclusions_v2";
export const RETROSPECTIVE_EXCLUSION_V2_REASONS = [
  ...RETROSPECTIVE_EXCLUSION_REASONS,
  "attestation_missing",
  "generation_revoked",
  "attestation_generation_stale",
  "mapping_missing",
  "mapping_not_manual_override",
  "mapping_disagrees",
] as const;
export type RetrospectiveExclusionV2Reason = (typeof RETROSPECTIVE_EXCLUSION_V2_REASONS)[number];

export type RetrospectiveTrainingExclusionV2 = Omit<RetrospectiveTrainingExclusion, "exclusion_reason"> & {
  exclusion_reason: RetrospectiveExclusionV2Reason;
};

export type RetrospectiveTrainingExclusionsV2Rpc = (
  fn: typeof RETROSPECTIVE_TRAINING_EXCLUSIONS_V2_FUNCTION,
  args: { p_provider: string; p_competition_ids: string[] | null; p_from: string | null; p_training_cutoff: string; p_policy: string },
) => Promise<unknown>;

export async function loadRetrospectiveTrainingExclusionsV2(
  rpc: RetrospectiveTrainingExclusionsV2Rpc,
  query: TeamMatchStatsQuery & { trainingCutoff: string },
): Promise<RetrospectiveTrainingExclusionV2[]> {
  assertTeamMatchStatsQuery(query, query.trainingCutoff);
  const value = await rpc(RETROSPECTIVE_TRAINING_EXCLUSIONS_V2_FUNCTION, {
    p_provider: query.provider,
    p_competition_ids: query.competitionIds?.map((id) => id.toLowerCase()) ?? null,
    p_from: query.from,
    p_training_cutoff: query.trainingCutoff,
    p_policy: RETROSPECTIVE_TRAINING_AVAILABILITY_VERSION,
  });
  if (!Array.isArray(value)) throw new Error("retrospective training exclusions must be an array");
  return value.map((item, index) => {
    const row = item as Record<string, unknown>;
    const reason = row.exclusion_reason as string;
    if (!(RETROSPECTIVE_EXCLUSION_V2_REASONS as readonly string[]).includes(reason)) {
      throw new Error(`retrospective exclusion ${index} has an unknown reason`);
    }
    if (row.availability_policy !== RETROSPECTIVE_TRAINING_AVAILABILITY_VERSION) throw new Error(`retrospective exclusion ${index}: unexpected policy`);
    if ((RETROSPECTIVE_EXCLUSION_REASONS as readonly string[]).includes(reason)
      && !(Number(row.latest_observation_version) > Number(row.selected_observation_version))) {
      throw new Error(`retrospective exclusion ${index}: the latest version must be later than the selected one`);
    }
    return row as unknown as RetrospectiveTrainingExclusionV2;
  });
}

export type TeamMatchStatsTrainingRpc = (
  fn: typeof TEAM_MATCH_STATS_FUNCTIONS.forTraining | typeof TEAM_MATCH_STATS_FUNCTIONS.forTrainingV2,
  args: { p_provider: string; p_competition_ids: string[] | null; p_from: string | null; p_training_cutoff: string; p_policy: string },
) => Promise<unknown>;

/** Stage 1 retrospective training read: the V1 training read over the attestation-gated row set (D-058). */
export async function loadTeamMatchStatsForTrainingV2(
  rpc: TeamMatchStatsTrainingRpc,
  query: TeamMatchStatsQuery & { trainingCutoff: string },
): Promise<TeamMatchStatsResult> {
  assertTeamMatchStatsQuery(query, query.trainingCutoff);
  const value = await rpc(TEAM_MATCH_STATS_FUNCTIONS.forTrainingV2, {
    p_provider: query.provider,
    p_competition_ids: query.competitionIds?.map((id) => id.toLowerCase()) ?? null,
    p_from: query.from,
    p_training_cutoff: query.trainingCutoff,
    p_policy: RETROSPECTIVE_TRAINING_AVAILABILITY_VERSION,
  });
  return {
    contractVersion: TEAM_MATCH_STATS_V2_CONTRACT_VERSION,
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
