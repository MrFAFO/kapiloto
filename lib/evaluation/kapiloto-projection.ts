import { sha256Hex } from "@/lib/kapiloto/snapshot";

import { EVAL_ARM, type EvalPredictionDraft } from "./arms";
import { fromBasisPoints, type ThreeWayProbabilities } from "./probabilities";

export const KAPILOTO_PUBLISHED_PROJECTION_VERSION =
  "kapiloto-published-projection-v1";

type BasisPointTriple = { home: number; draw: number; away: number };

/**
 * One immutable fixture publication joined with its analysis. Probabilities
 * are in the Toto round-game orientation the analysis was produced in.
 */
export type PublishedKapilotoAnalysis = {
  publicationId: string;
  publishedAt: string;
  analysisId: string;
  researchRunId: string;
  fixtureId: string;
  roundGameId: string;
  outcome: string;
  orientationVerified: boolean;
  researchCutoffAt: string;
  kickoffAtSnapshot: string;
  roundGameHomeTeamId: string;
  roundGameAwayTeamId: string;
  priorType: string | null;
  pFinal: BasisPointTriple | null;
  pSol: BasisPointTriple | null;
  derivationVersion: string | null;
  blendPolicyVersion: string | null;
  reliabilityFormulaVersion: string | null;
  calibrationVersion: string | null;
};

const SCOREABLE_OUTCOMES = new Set(["analyzed", "carried_forward"]);

function projected(
  row: PublishedKapilotoAnalysis,
  arm: string,
  probabilities: BasisPointTriple | null,
): EvalPredictionDraft {
  let invalidReason: string | null = null;
  let parsed: ThreeWayProbabilities | null = null;
  if (!SCOREABLE_OUTCOMES.has(row.outcome)) {
    invalidReason = `kapiloto_outcome_${row.outcome}`;
  } else if (!row.orientationVerified) {
    invalidReason = "orientation_unverified";
  } else if (!probabilities) {
    invalidReason = "probabilities_missing";
  } else {
    parsed = fromBasisPoints(probabilities);
  }

  return {
    fixture_id: row.fixtureId,
    round_game_id: row.roundGameId,
    arm,
    arm_version: KAPILOTO_PUBLISHED_PROJECTION_VERSION,
    evaluation_mode: "forward",
    deterministic: false,
    information_cutoff_at: new Date(row.researchCutoffAt).toISOString(),
    issued_at_source: "kapiloto_publication",
    source_analysis_id: row.analysisId,
    kickoff_at_snapshot: row.kickoffAtSnapshot,
    home_team_id: row.roundGameHomeTeamId,
    away_team_id: row.roundGameAwayTeamId,
    valid: parsed != null,
    invalid_reason: parsed ? null : invalidReason,
    p_home: parsed?.home ?? null,
    p_draw: parsed?.draw ?? null,
    p_away: parsed?.away ?? null,
    basis: {
      publication_id: row.publicationId,
      research_run_id: row.researchRunId,
      analysis_outcome: row.outcome,
      prior_type: row.priorType,
      derivation_version: row.derivationVersion,
      blend_policy_version: row.blendPolicyVersion,
      reliability_formula_version: row.reliabilityFormulaVersion,
      calibration_version: row.calibrationVersion,
    },
    input_sha256: sha256Hex({
      arm,
      analysis_id: row.analysisId,
      publication_id: row.publicationId,
      probabilities,
    }),
  };
}

/**
 * B5: read-only projection of what Kapiloto actually published. `p_final` is
 * the production recommendation; raw `p_sol` is projected as a separate arm.
 * The issue time is the database publication timestamp, re-derived by the
 * insert trigger, so a projection can never be backdated.
 */
export function projectKapilotoPublication(
  row: PublishedKapilotoAnalysis,
): EvalPredictionDraft[] {
  return [
    projected(row, EVAL_ARM.kapilotoPublished, row.pFinal),
    projected(row, EVAL_ARM.kapilotoSol, row.pSol),
  ];
}
