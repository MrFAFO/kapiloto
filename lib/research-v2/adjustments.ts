import type { MarketState } from "./base";
import { IMPACT_CLASSES, type ImpactClass } from "./evidence";
import { shiftHomeAwayStrength, type ThreeWayProbabilities } from "./probability";
import { configProvenance, type ConfigProvenance, type VersionedConfig } from "./provenance";
import { corroboration, type CorroborationDecision, type SourcePolicyConfig } from "./sources";
import { subjectKey, type VerifiedEvidence } from "./verification";

export const IMPACT_CONTRACT_VERSION = "kapiloto-research-v2-impact-v1" as const;

export const ADJUSTMENT_KINDS = ["availability", "rotation", "manager_change", "congestion", "context"] as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];

/**
 * Stage 5 output: Sol interprets VERIFIED evidence in a closed vocabulary.
 * There is no probability, odds or pick field; the server alone maps impact
 * classes to bounded, versioned effects.
 */
export type ImpactProposal = {
  proposal_id: string;
  kind: AdjustmentKind;
  team: "home" | "away";
  effect: "weakens" | "strengthens";
  impact_class: ImpactClass;
  uncertainty: "low" | "medium" | "high";
  evidence_ids: string[];
  rationale: string;
};

export type ImpactOutput = {
  contract_version: typeof IMPACT_CONTRACT_VERSION;
  fixture_id: string;
  proposals: ImpactProposal[];
};

const enumOf = (values: readonly string[]) => ({ type: "string", enum: [...values] });

export const IMPACT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["contract_version", "fixture_id", "proposals"],
  properties: {
    contract_version: { type: "string", enum: [IMPACT_CONTRACT_VERSION] },
    fixture_id: { type: "string", minLength: 1, maxLength: 80 },
    proposals: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["proposal_id", "kind", "team", "effect", "impact_class", "uncertainty", "evidence_ids", "rationale"],
        properties: {
          proposal_id: { type: "string", minLength: 1, maxLength: 40 },
          kind: enumOf(ADJUSTMENT_KINDS),
          team: enumOf(["home", "away"]),
          effect: enumOf(["weakens", "strengthens"]),
          impact_class: enumOf(IMPACT_CLASSES),
          uncertainty: enumOf(["low", "medium", "high"]),
          evidence_ids: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 1, maxLength: 40 } },
          rationale: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
    },
  },
} as const;

/**
 * How an admitted adjustment may affect probabilities (adjustment-policy-v2,
 * on market-state-v2 information times):
 *  - full:                       evidence postdates the newest price used by a fresh,
 *                                standard market (freshness from the oldest price);
 *  - stat_path:                  market missing/stale/thin/old, so verified earlier evidence
 *                                may adjust only the stat input of a combination;
 *  - market_likely_incorporated: evidence published at or before the newest price of a
 *                                fresh, standard market; explanatory only, no shift;
 *  - explanatory:                admissible but impact class "none".
 */
export type AdjustmentPath = "full" | "stat_path" | "market_likely_incorporated" | "explanatory";

export type AdjustmentRejection =
  | "unknown_evidence"
  | "unverified_evidence"
  | "structured_duplicate"
  | "insufficient_source_quality"
  | "team_mismatch"
  | "duplicate_adjustment";

export type AdjustmentDecision = {
  proposal: ImpactProposal;
  status: "admitted" | "rejected";
  rejections: AdjustmentRejection[];
  path: AdjustmentPath | null;
  subjectKeys: string[];
  syndicationClusters: string[];
  earliestEvidenceAt: string | null;
  marketStateVersion: string;
  /** Information time of the newest price used; `full` requires evidence published after it. */
  marketInformationLatestAt: string | null;
  marketInformationAgeMinutes: number | null;
  marketQuality: MarketState["quality"];
  corroboration: CorroborationDecision | null;
};

export type AdjustmentPolicyConfig = VersionedConfig & {
  /** A standard market whose oldest price is older than this at the cutoff is treated as not fresh. */
  freshMarketMaxAgeMinutes: number;
  /** Market-time semantics this policy is defined on; any other market state is refused. */
  requiredMarketStateVersion: string;
};

export const CANDIDATE_ADJUSTMENT_POLICY: AdjustmentPolicyConfig = {
  id: "research-v2-adjustment-policy",
  version: "adjustment-policy-v2",
  status: "candidate",
  freshMarketMaxAgeMinutes: 360,
  requiredMarketStateVersion: "market-state-v2",
};

/**
 * Admits impact proposals deterministically. Order of the output follows the
 * proposal id, so equal inputs always give equal decisions.
 */
export function admitAdjustments(input: {
  proposals: readonly ImpactProposal[];
  evidence: readonly VerifiedEvidence[];
  market: MarketState;
  sourcePolicy: SourcePolicyConfig;
  policy: AdjustmentPolicyConfig;
}): { decisions: AdjustmentDecision[]; policy: ConfigProvenance } {
  if (input.market.policy.version !== input.policy.requiredMarketStateVersion) {
    throw new Error(
      `research_v2_market_state_mismatch: ${input.policy.version} requires ${input.policy.requiredMarketStateVersion}, got ${input.market.policy.version}`,
    );
  }
  const byId = new Map(input.evidence.map((item) => [item.item.evidence_id, item]));
  const newestPriceAt = input.market.informationLatestAt;
  const freshStandardMarket =
    input.market.quality === "standard" &&
    newestPriceAt != null &&
    input.market.informationAgeMinutesAtCutoff != null &&
    input.market.informationAgeMinutesAtCutoff <= input.policy.freshMarketMaxAgeMinutes;
  const claimedSubjects = new Set<string>();
  const claimedClusters = new Set<string>();

  const decisions = [...input.proposals]
    .sort((a, b) => a.proposal_id.localeCompare(b.proposal_id))
    .map((proposal): AdjustmentDecision => {
      const rejections: AdjustmentRejection[] = [];
      const supporting = proposal.evidence_ids.map((id) => byId.get(id));
      if (supporting.some((item) => item == null)) rejections.push("unknown_evidence");
      const known = supporting.filter((item): item is VerifiedEvidence => item != null);
      if (known.some((item) => item.status !== "verified")) rejections.push("unverified_evidence");
      if (known.some((item) => item.item.team !== proposal.team && item.item.team !== "both")) rejections.push("team_mismatch");
      const usable = known.filter((item) => item.status === "verified" && !item.structuredDuplicate);
      if (known.length > 0 && usable.length === 0 && known.every((item) => item.structuredDuplicate)) {
        rejections.push("structured_duplicate");
      }
      const decision = usable.length > 0
        ? corroboration(usable.map((item) => ({ quality: item.source.quality, clusterId: item.syndicationClusterId })), input.sourcePolicy)
        : null;
      if (decision && !decision.forecastEligible) rejections.push("insufficient_source_quality");

      const subjects = [...new Set(usable.map((item) => subjectKey(item.item)))].sort();
      const clusters = [...new Set(usable.map((item) => item.syndicationClusterId))].sort();
      if (
        rejections.length === 0 &&
        (subjects.some((subject) => claimedSubjects.has(subject)) || clusters.some((cluster) => claimedClusters.has(cluster)))
      ) {
        rejections.push("duplicate_adjustment");
      }
      const earliestEvidenceAt = usable.map((item) => item.publishedAt).filter((at): at is string => at != null).sort()[0] ?? null;

      let path: AdjustmentPath | null = null;
      if (rejections.length === 0) {
        subjects.forEach((subject) => claimedSubjects.add(subject));
        clusters.forEach((cluster) => claimedClusters.add(cluster));
        if (proposal.impact_class === "none") path = "explanatory";
        else if (!freshStandardMarket) path = "stat_path";
        else if (earliestEvidenceAt != null && Date.parse(earliestEvidenceAt) > Date.parse(newestPriceAt as string)) path = "full";
        else path = "market_likely_incorporated";
      }
      return {
        proposal,
        status: rejections.length === 0 ? "admitted" : "rejected",
        rejections,
        path,
        subjectKeys: subjects,
        syndicationClusters: clusters,
        earliestEvidenceAt,
        marketStateVersion: input.market.policy.version,
        marketInformationLatestAt: newestPriceAt,
        marketInformationAgeMinutes: input.market.informationAgeMinutesAtCutoff,
        marketQuality: input.market.quality,
        corroboration: decision,
      };
    });
  return { decisions, policy: configProvenance(input.policy) };
}

/** Versioned mapping from impact class to a bounded home/away strength shift (log-odds). */
export type EffectSizeConfig = VersionedConfig & {
  unit: "log_odds_home_away_shift";
  impact: Record<ImpactClass, number>;
  uncertaintyMultiplier: Record<ImpactProposal["uncertainty"], number>;
  /** Absolute cap on the summed shift per application. */
  totalCap: number;
};

/** Placeholder candidate values. Not approved; not derived from any outcome. */
export const CANDIDATE_EFFECT_SIZES: EffectSizeConfig = {
  id: "research-v2-effect-sizes",
  version: "effect-sizes-v1",
  status: "candidate",
  unit: "log_odds_home_away_shift",
  impact: { none: 0, minor: 0.05, moderate: 0.12, major: 0.25 },
  uncertaintyMultiplier: { low: 1, medium: 0.6, high: 0.3 },
  totalCap: 0.4,
};

export type AppliedAdjustments = {
  probabilities: ThreeWayProbabilities;
  rawShift: number;
  appliedShift: number;
  capped: boolean;
  proposalIds: string[];
};

/** Applies admitted adjustments of the given paths; a pure, capped strength shift. */
export function applyAdjustments(
  probabilities: ThreeWayProbabilities,
  decisions: readonly AdjustmentDecision[],
  paths: ReadonlyArray<AdjustmentPath>,
  effects: EffectSizeConfig,
): AppliedAdjustments {
  const applicable = decisions
    .filter((decision) => decision.status === "admitted" && decision.path != null && paths.includes(decision.path))
    .sort((a, b) => a.proposal.proposal_id.localeCompare(b.proposal.proposal_id));
  const rawShift = applicable.reduce((sum, decision) => {
    const { team, effect, impact_class: impact, uncertainty } = decision.proposal;
    const size = effects.impact[impact] * effects.uncertaintyMultiplier[uncertainty];
    const towardHome = (team === "home") === (effect === "strengthens") ? 1 : -1;
    return sum + towardHome * size;
  }, 0);
  const appliedShift = Math.max(-effects.totalCap, Math.min(effects.totalCap, rawShift));
  return {
    probabilities: shiftHomeAwayStrength(probabilities, appliedShift),
    rawShift,
    appliedShift,
    capped: appliedShift !== rawShift,
    proposalIds: applicable.map((decision) => decision.proposal.proposal_id),
  };
}

export function effectSizesProvenance(effects: EffectSizeConfig): ConfigProvenance {
  return configProvenance(effects);
}
