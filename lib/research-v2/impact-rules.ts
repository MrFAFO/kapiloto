import type { ImpactProposal } from "./adjustments";
import {
  FORECAST_CHANGING_CLAIM_KINDS,
  type ClaimKindV2,
  type ForecastChangingClaimKind,
  type Observation,
  type PlayerRole,
  type Side,
  type SquadStatus,
  type StatedStatus,
} from "./discovery-contract";
import type { ImpactClass } from "./evidence";
import { configProvenance, type ConfigProvenance, type VersionedConfig } from "./provenance";

/**
 * impact-rules-v1 (D-047): the only path from a verified claim to an
 * adjustment proposal. Direction comes from the claim kind, class from
 * server-verified squad status and role, uncertainty from the stated status.
 * No model prose sets direction or size; effect sizes stay in effect-sizes-v1.
 */

export type ImpactRulesConfig = VersionedConfig & {
  classes: { firstChoiceGoalkeeper: ImpactClass; firstChoiceOutfield: ImpactClass; rotation: ImpactClass };
  /** Named, supported first-choice players a rotation statement needs (excluding admitted absences). */
  rotationMinSupportedFirstChoicePlayers: number;
  uncertaintyByStatedStatus: Record<Exclude<StatedStatus, "denied">, ImpactProposal["uncertainty"]>;
};

/** Candidate values only; not approved and not derived from any outcome. */
export const CANDIDATE_IMPACT_RULES: ImpactRulesConfig = {
  id: "research-v2-impact-rules",
  version: "impact-rules-v1",
  status: "candidate",
  classes: { firstChoiceGoalkeeper: "moderate", firstChoiceOutfield: "minor", rotation: "minor" },
  rotationMinSupportedFirstChoicePlayers: 2,
  uncertaintyByStatedStatus: { confirmed: "low", expected: "medium", doubtful: "high" },
};

/** Facts the server established for one claim after citation and claim-level verification. */
export type VerifiedClaimFacts = {
  claimId: string;
  subjectKey: string;
  claimKind: ClaimKindV2;
  side: Side;
  statedStatus: StatedStatus;
  appliesToThisFixture: boolean;
  observation: Observation;
  /** Claim-level verification passed (accepted clusters satisfy the source policy). */
  verified: boolean;
  structuredDuplicate: boolean;
  conflict: boolean;
  role: PlayerRole;
  /** Squad status supported by the entailment judge; anything unsupported is `unknown`. */
  verifiedSquadStatus: SquadStatus;
  /** Rotation statements only. */
  rotation: { gradeADirectStatement: boolean; supportedFirstChoicePlayers: number } | null;
  /** Accepted evidence behind the claim. */
  evidenceIds: string[];
};

export const IMPACT_RULE_IDS = [
  "precondition_not_verified",
  "precondition_not_this_fixture",
  "precondition_inferred",
  "precondition_structured_duplicate",
  "precondition_conflict",
  "explanatory_kind",
  "denied_status",
  "availability_first_choice_goalkeeper",
  "availability_first_choice_outfield",
  "availability_not_first_choice",
  "return_first_choice_goalkeeper",
  "return_first_choice_outfield",
  "return_not_first_choice",
  "rotation_direct_statement",
  "rotation_insufficient",
] as const;
export type ImpactRuleId = (typeof IMPACT_RULE_IDS)[number];

export type ImpactRuleResult = {
  claimId: string;
  ruleId: ImpactRuleId;
  proposal: ImpactProposal | null;
  config: ConfigProvenance;
};

const FORECAST_CHANGING = new Set<ClaimKindV2>(FORECAST_CHANGING_CLAIM_KINDS);
const AVAILABILITY_LOSS = new Set<ClaimKindV2>(["absence", "suspension", "doubtful"]);

export function isForecastChangingKind(kind: ClaimKindV2): kind is ForecastChangingClaimKind {
  return FORECAST_CHANGING.has(kind);
}

/** Exactly one rule applies to every claim; only adjusting rules carry a proposal. */
export function applyImpactRules(facts: VerifiedClaimFacts, config: ImpactRulesConfig = CANDIDATE_IMPACT_RULES): ImpactRuleResult {
  const provenance = configProvenance(config);
  const none = (ruleId: ImpactRuleId): ImpactRuleResult => ({ claimId: facts.claimId, ruleId, proposal: null, config: provenance });
  const propose = (
    ruleId: ImpactRuleId,
    kind: ImpactProposal["kind"],
    effect: ImpactProposal["effect"],
    impactClass: ImpactClass,
    uncertainty: ImpactProposal["uncertainty"],
  ): ImpactRuleResult => ({
    claimId: facts.claimId,
    ruleId,
    proposal: {
      proposal_id: `${ruleId}:${facts.subjectKey}`,
      kind,
      team: facts.side,
      effect,
      impact_class: impactClass,
      uncertainty,
      evidence_ids: [...facts.evidenceIds].sort(),
      rationale: `${config.version}:${ruleId}`,
    },
    config: provenance,
  });

  if (!facts.verified || facts.evidenceIds.length === 0) return none("precondition_not_verified");
  if (!facts.appliesToThisFixture) return none("precondition_not_this_fixture");
  if (facts.observation === "inferred") return none("precondition_inferred");
  if (facts.structuredDuplicate) return none("precondition_structured_duplicate");
  if (facts.conflict) return none("precondition_conflict");
  if (!isForecastChangingKind(facts.claimKind)) return none("explanatory_kind");
  if (facts.statedStatus === "denied") return none("denied_status");

  const firstChoice = facts.verifiedSquadStatus === "first_choice";
  const goalkeeper = facts.role === "goalkeeper";
  const statusUncertainty = config.uncertaintyByStatedStatus[facts.statedStatus];

  if (AVAILABILITY_LOSS.has(facts.claimKind)) {
    if (!firstChoice) return none("availability_not_first_choice");
    const uncertainty = facts.claimKind === "doubtful" ? "high" : statusUncertainty;
    return goalkeeper
      ? propose("availability_first_choice_goalkeeper", "availability", "weakens", config.classes.firstChoiceGoalkeeper, uncertainty)
      : propose("availability_first_choice_outfield", "availability", "weakens", config.classes.firstChoiceOutfield, uncertainty);
  }
  if (facts.claimKind === "expected_return") {
    if (!firstChoice) return none("return_not_first_choice");
    return goalkeeper
      ? propose("return_first_choice_goalkeeper", "availability", "strengthens", config.classes.firstChoiceGoalkeeper, statusUncertainty)
      : propose("return_first_choice_outfield", "availability", "strengthens", config.classes.firstChoiceOutfield, statusUncertainty);
  }
  // rotation_statement
  const rotation = facts.rotation;
  if (
    rotation &&
    rotation.gradeADirectStatement &&
    facts.observation === "direct_statement" &&
    rotation.supportedFirstChoicePlayers >= config.rotationMinSupportedFirstChoicePlayers
  ) {
    return propose("rotation_direct_statement", "rotation", "weakens", config.classes.rotation, statusUncertainty);
  }
  return none("rotation_insufficient");
}
