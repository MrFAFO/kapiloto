import type { KapilotoFixtureCard } from "./fixture-card";
import type { SolFixtureResearchOutput } from "./research-output";
import type { GroundedEvidence, GroundingResult } from "./source-grounding";
import { verifyStructuredFactor } from "./structured-refs";

export const KAPILOTO_GROUNDING_POLICY_VERSION =
  "kapiloto-grounding-policy-v7" as const;

type ResearchFactor = SolFixtureResearchOutput["factors"][number];

export type GroundingPolicyDecision = {
  mode: "sol" | "market_only" | "insufficient_data";
  output: SolFixtureResearchOutput;
  pSolValid: boolean;
  removedItems: string[];
  removedDirectionalDimensions: string[];
  nonDirectionalRemovalCount: number;
  reasons: string[];
};

function independent(left: GroundedEvidence, right: GroundedEvidence): boolean {
  if (left.domain === right.domain) return false;
  return !(
    left.syndicationClusterId &&
    right.syndicationClusterId &&
    left.syndicationClusterId === right.syndicationClusterId
  );
}

function materialCorroboration(
  factor: ResearchFactor,
  supporting: GroundedEvidence[],
): boolean {
  if (factor.magnitude === "small") return true;
  if (supporting.some((item) => item.trustTier <= 2)) return true;
  return supporting.some((left, index) =>
    supporting
      .slice(index + 1)
      .some((right) => independent(left, right)),
  );
}

function cloneOutput(
  output: SolFixtureResearchOutput,
): SolFixtureResearchOutput {
  return JSON.parse(JSON.stringify(output)) as SolFixtureResearchOutput;
}

export function applyGroundingPolicy(
  rawOutput: SolFixtureResearchOutput,
  grounding: GroundingResult,
  card: KapilotoFixtureCard,
): GroundingPolicyDecision {
  const output = cloneOutput(rawOutput);
  const usableById = new Map(
    grounding.accepted
      .filter((item) => item.entailment !== "unsupported")
      .map((item) => [item.modelEvidenceId, item]),
  );
  const removedItems: string[] = [];
  const removedDirectionalDimensions = new Set<string>();
  let nonDirectionalRemovalCount = 0;

  const usableEvidenceIds = (ids: string[]) =>
    ids.filter((id) => usableById.has(id));

  output.availability = output.availability.flatMap((item) => {
    const evidenceIds = usableEvidenceIds(item.evidence_ids);
    if (evidenceIds.length === 0) {
      removedItems.push(`availability:${item.player_name}`);
      nonDirectionalRemovalCount += 1;
      return [];
    }
    if (evidenceIds.length !== item.evidence_ids.length) {
      removedItems.push(`availability_evidence_pruned:${item.player_name}`);
    }
    return [{ ...item, evidence_ids: evidenceIds }];
  });

  output.conflicts = output.conflicts.flatMap((item) => {
    const evidenceIdsA = usableEvidenceIds(item.evidence_ids_a);
    const evidenceIdsB = usableEvidenceIds(item.evidence_ids_b);
    if (evidenceIdsA.length === 0 || evidenceIdsB.length === 0) {
      removedItems.push(`conflict:${item.topic}`);
      nonDirectionalRemovalCount += 1;
      return [];
    }
    if (
      evidenceIdsA.length !== item.evidence_ids_a.length ||
      evidenceIdsB.length !== item.evidence_ids_b.length
    ) {
      removedItems.push(`conflict_evidence_pruned:${item.topic}`);
    }
    return [{
      ...item,
      evidence_ids_a: evidenceIdsA,
      evidence_ids_b: evidenceIdsB,
    }];
  });

  if (output.market_deviation) {
    const evidenceIds = usableEvidenceIds(
      output.market_deviation.evidence_ids,
    );
    if (evidenceIds.length === 0) {
      output.market_deviation = null;
      removedItems.push("market_deviation");
      nonDirectionalRemovalCount += 1;
    } else {
      if (evidenceIds.length !== output.market_deviation.evidence_ids.length) {
        removedItems.push("market_deviation_evidence_pruned");
      }
      output.market_deviation = {
        ...output.market_deviation,
        evidence_ids: evidenceIds,
      };
    }
  }

  const removedDirectionalFactors: ResearchFactor[] = [];
  output.factors = output.factors.flatMap((rawFactor) => {
    const evidenceIds = usableEvidenceIds(rawFactor.evidence_ids);
    const factor = { ...rawFactor, evidence_ids: evidenceIds };
    const supporting = evidenceIds
      .map((id) => usableById.get(id))
      .filter((item): item is GroundedEvidence => item != null);
    const structured =
      (factor.structured_refs?.length ?? 0) > 0
        ? verifyStructuredFactor(factor, card)
        : null;

    const structuredUsable =
      structured == null || structured.valid;
    const hasVerifiedSupport =
      supporting.length > 0 || structured?.valid === true;
    const directionalEntailmentPassed =
      factor.favors === "none" ||
      structured?.valid === true ||
      supporting.every((item) => item.entailment === "supported");
    const corroborationPassed =
      factor.magnitude === "small" ||
      structured?.valid === true ||
      (supporting.length > 0 &&
        materialCorroboration(factor, supporting));

    const keep =
      structuredUsable &&
      hasVerifiedSupport &&
      directionalEntailmentPassed &&
      corroborationPassed;

    if (keep) {
      if (evidenceIds.length !== rawFactor.evidence_ids.length) {
        removedItems.push(`factor_evidence_pruned:${factor.dimension}`);
      }
      return [factor];
    }

    removedItems.push(`factor:${factor.dimension}`);
    if (factor.favors === "none") {
      nonDirectionalRemovalCount += 1;
    } else {
      removedDirectionalDimensions.add(factor.dimension);
      removedDirectionalFactors.push(rawFactor);
    }
    return [];
  });

  const removedDimensions = new Set(
    removedItems
      .filter((item) => item.startsWith("factor:"))
      .map((item) => item.split(":")[1]),
  );

  output.dimension_coverage = output.dimension_coverage.map((item) =>
    removedDimensions.has(item.dimension)
      ? { ...item, status: "no_material_signal" as const }
      : item,
  );

  if (removedItems.length > 0) {
    output.key_assumptions = [];
    output.watch_items = [];
    output.main_risk =
      "Some reported inputs were excluded because they did not pass evidence policy.";
    output.data_quality = {
      ...output.data_quality,
      sparse_coverage: true,
      notes: [output.data_quality.notes, "unsupported_items_removed"]
        .filter(Boolean)
        .join("; "),
    };
  }

  if (rawOutput.outcome === "insufficient_data") {
    return {
      mode: "insufficient_data",
      output,
      pSolValid: false,
      removedItems,
      removedDirectionalDimensions: [...removedDirectionalDimensions].sort(),
      nonDirectionalRemovalCount,
      reasons: ["sol_reported_insufficient_data"],
    };
  }

  const survivingDirectional = output.factors.filter(
    (factor) => factor.favors !== "none",
  );

  // Small directional claims are deliberately advisory. If one is removed
  // by grounding policy, reduce reliability but do not invalidate the entire
  // Sol distribution while another grounded directional signal survives.
  // Medium/large removed directional claims can materially change the model
  // distribution and therefore still fail closed.
  const unsafeRemovedDirectional = removedDirectionalFactors.filter(
    (factor) => factor.magnitude !== "small",
  );

  const invalidationReasons = [
    ...unsafeRemovedDirectional
      .map((factor) => factor.dimension)
      .sort()
      .map((dimension) => `p_sol_invalidated:${dimension}`),
    ...(survivingDirectional.length === 0
      ? ["p_sol_invalidated:no_grounded_directional_signal"]
      : []),
  ];

  if (invalidationReasons.length > 0) {
    const informativePrior = card.structured.prior.type !== "league_base";
    return {
      mode: informativePrior ? "market_only" : "insufficient_data",
      output,
      pSolValid: false,
      removedItems,
      removedDirectionalDimensions: [...removedDirectionalDimensions].sort(),
      nonDirectionalRemovalCount,
      reasons: invalidationReasons,
    };
  }

  return {
    mode: "sol",
    output,
    pSolValid: true,
    removedItems,
    removedDirectionalDimensions: [],
    nonDirectionalRemovalCount,
    reasons:
      removedItems.length > 0
        ? [
            ...(removedDirectionalFactors.length > 0
              ? ["directional_items_pruned"]
              : []),
            "secondary_items_removed",
          ]
        : [],
  };
}
