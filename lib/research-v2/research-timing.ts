import type { AdjustmentDecision, AdjustmentPath, AdjustmentPolicyConfig } from "./adjustments";
import type { MarketState } from "./base";
import type { ClaimDecisionV2 } from "./claim-decisions";
import { configProvenance, type ConfigProvenance, type VersionedConfig } from "./provenance";

/**
 * Market timing of verified, adjusting claims against the research-time
 * (revalidated) market state, under adjustment-policy-v2. Freshness comes from
 * the oldest price; `full` needs evidence strictly after the newest price and
 * at or before the knowledge cutoff; imprecise or near-boundary publication
 * times take the conservative "already incorporated" path. Effect sizes are
 * not touched here.
 */

export type TimingMarginConfig = VersionedConfig & { ambiguityMarginMinutes: number };

export const CANDIDATE_TIMING_MARGIN: TimingMarginConfig = {
  id: "research-v2-timing-margin",
  version: "timing-margin-v1",
  status: "candidate",
  ambiguityMarginMinutes: 30,
};

export type TimingClass = "non_fresh_market" | "ambiguous" | "after_newest_price" | "at_or_before_newest_price";

export type TimedAdjustment = {
  claimId: string;
  timing: {
    class: TimingClass;
    evidenceAt: string | null;
    newestPriceAt: string | null;
    knowledgeCutoffAt: string;
    marginMinutes: number;
  };
  decision: AdjustmentDecision;
};

export function timeClaimAdjustments(input: {
  claims: readonly ClaimDecisionV2[];
  market: MarketState;
  knowledgeCutoffAt: string;
  policy: AdjustmentPolicyConfig;
  margin?: TimingMarginConfig;
}): { adjustments: TimedAdjustment[]; policy: ConfigProvenance; margin: ConfigProvenance } {
  const margin = input.margin ?? CANDIDATE_TIMING_MARGIN;
  if (input.market.policy.version !== input.policy.requiredMarketStateVersion) {
    throw new Error(`research_v2_market_state_mismatch: ${input.policy.version} requires ${input.policy.requiredMarketStateVersion}, got ${input.market.policy.version}`);
  }
  const knowledgeMs = Date.parse(input.knowledgeCutoffAt);
  if (!Number.isFinite(knowledgeMs)) throw new Error(`Invalid knowledgeCutoffAt: ${input.knowledgeCutoffAt}`);
  const newestMs = input.market.informationLatestAt != null ? Date.parse(input.market.informationLatestAt) : null;
  const fresh =
    input.market.quality === "standard" &&
    newestMs != null &&
    input.market.informationAgeMinutesAtCutoff != null &&
    input.market.informationAgeMinutesAtCutoff <= input.policy.freshMarketMaxAgeMinutes;
  const marginMs = margin.ambiguityMarginMinutes * 60_000;

  const adjustments = [...input.claims]
    .filter((claim) => claim.status === "adjusting" && claim.proposal != null)
    .sort((a, b) => a.claimId.localeCompare(b.claimId))
    .map((claim): TimedAdjustment => {
      const evidenceMs = claim.evidenceTimeMs;
      let timingClass: TimingClass;
      let path: AdjustmentPath;
      if (!fresh) {
        timingClass = "non_fresh_market";
        path = "stat_path";
      } else if (evidenceMs == null || claim.timingImprecise || Math.abs(evidenceMs - (newestMs as number)) <= marginMs) {
        timingClass = "ambiguous";
        path = "market_likely_incorporated";
      } else if (evidenceMs > (newestMs as number) && evidenceMs <= knowledgeMs) {
        timingClass = "after_newest_price";
        path = "full";
      } else {
        timingClass = "at_or_before_newest_price";
        path = "market_likely_incorporated";
      }
      return {
        claimId: claim.claimId,
        timing: {
          class: timingClass,
          evidenceAt: evidenceMs != null ? new Date(evidenceMs).toISOString() : null,
          newestPriceAt: input.market.informationLatestAt,
          knowledgeCutoffAt: new Date(knowledgeMs).toISOString(),
          marginMinutes: margin.ambiguityMarginMinutes,
        },
        decision: {
          proposal: claim.proposal!,
          status: "admitted",
          rejections: [],
          path,
          subjectKeys: [claim.subjectKey],
          syndicationClusters: claim.clusters.map((cluster) => cluster.clusterId),
          earliestEvidenceAt: evidenceMs != null ? new Date(evidenceMs).toISOString() : null,
          marketStateVersion: input.market.policy.version,
          marketInformationLatestAt: input.market.informationLatestAt,
          marketInformationAgeMinutes: input.market.informationAgeMinutesAtCutoff,
          marketQuality: input.market.quality,
          corroboration: null,
        },
      };
    });
  return { adjustments, policy: configProvenance(input.policy), margin: configProvenance(margin) };
}
