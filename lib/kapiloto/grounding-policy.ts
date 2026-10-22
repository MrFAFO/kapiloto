import type { KapilotoFixtureCard } from "./fixture-card";
import type { SolFixtureResearchOutput } from "./research-output";
import type { GroundedEvidence, GroundingResult } from "./source-grounding";

export const KAPILOTO_GROUNDING_POLICY_VERSION =
  "kapiloto-grounding-policy-v4" as const;

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

  const fullyUsable = (ids: string[]) =>
    ids.length > 0 && ids.every((id) => usableById.has(id));

  output.availability = output.availability.filter((item) => {
    const keep = fullyUsable(item.evidence_ids);
    if (!keep) {
      removedItems.push(`availability:${item.player_name}`);
      nonDirectionalRemovalCount += 1;
    }
    return keep;
  });

  output.conflicts = output.conflicts.filter((item) => {
    const keep =
      fullyUsable(item.evidence_ids_a) &&
      fullyUsable(item.evidence_ids_b);
    if (!keep) {
      removedItems.push(`conflict:${item.topic}`);
      nonDirectionalRemovalCount += 1;
    }
    return keep;
  });

  if (
    output.market_deviation &&
    !fullyUsable(output.market_deviation.evidence_ids)
  ) {
    output.market_deviation = null;
    removedItems.push("market_deviation");
    nonDirectionalRemovalCount += 1;
  }

  output.factors = output.factors.filter((factor) => {
    const supporting = factor.evidence_ids
      .map((id) => usableById.get(id))
      .filter((item): item is GroundedEvidence => item != null);

    const allEvidenceUsable =
      supporting.length === factor.evidence_ids.length &&
      supporting.length > 0;
    const directionalEntailmentPassed =
      factor.favors === "none" ||
      supporting.every((item) => item.entailment === "supported");
    const keep =
      allEvidenceUsable &&
      directionalEntailmentPassed &&
      materialCorroboration(factor, supporting);

    if (keep) return true;

    removedItems.push(`factor:${factor.dimension}`);
    if (factor.favors === "none") {
      nonDirectionalRemovalCount += 1;
    } else {
      removedDirectionalDimensions.add(factor.dimension);
    }
    return false;
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

  const invalidationReasons = [
    ...[...removedDirectionalDimensions]
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
      removedItems.length > 0 ? ["secondary_items_removed"] : [],
  };
}
