import type { KapilotoFixtureCard } from "./fixture-card";
import type {
  SolExpectedLineup,
  SolFixtureResearchOutput,
  SolMatchupAnalysis,
  SolTacticalFact,
} from "./research-output";
import type { GroundedEvidence, GroundingResult } from "./source-grounding";
import { verifyStructuredFactor } from "./structured-refs";

export const KAPILOTO_GROUNDING_POLICY_VERSION =
  "kapiloto-grounding-policy-v9" as const;

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

function hasStrongOrIndependent(supporting: GroundedEvidence[]): boolean {
  if (supporting.some((item) => item.trustTier <= 2)) return true;
  return supporting.some((left, index) =>
    supporting
      .slice(index + 1)
      .some((right) => independent(left, right)),
  );
}

function materialCorroboration(
  factor: ResearchFactor,
  supporting: GroundedEvidence[],
): boolean {
  if (factor.magnitude === "small") return true;
  return hasStrongOrIndependent(supporting);
}

function cloneOutput(
  output: SolFixtureResearchOutput,
): SolFixtureResearchOutput {
  return JSON.parse(JSON.stringify(output)) as SolFixtureResearchOutput;
}

function magnitudeRank(value: "small" | "medium" | "large"): number {
  return value === "small" ? 1 : value === "medium" ? 2 : 3;
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function lineupPositionCounts(lineup: SolExpectedLineup): {
  valid: boolean;
  full: boolean;
} {
  if (!lineup.formation || lineup.starters.length !== 11) {
    return { valid: false, full: false };
  }
  if (lineup.starters.some((starter) => starter.position === "unknown")) {
    return { valid: false, full: true };
  }

  const digits = lineup.formation.split("-").map(Number);
  const expectedDf = digits[0] ?? 0;
  const expectedFw = digits[digits.length - 1] ?? 0;
  const expectedMf = digits.slice(1, -1).reduce((sum, value) => sum + value, 0);
  const actual = {
    GK: lineup.starters.filter((starter) => starter.position === "GK").length,
    DF: lineup.starters.filter((starter) => starter.position === "DF").length,
    MF: lineup.starters.filter((starter) => starter.position === "MF").length,
    FW: lineup.starters.filter((starter) => starter.position === "FW").length,
  };

  return {
    full: true,
    valid:
      actual.GK === 1 &&
      actual.DF === expectedDf &&
      actual.MF === expectedMf &&
      actual.FW === expectedFw,
  };
}

function deriveLineupStatus(
  lineup: SolExpectedLineup,
  supporting: GroundedEvidence[],
): SolExpectedLineup["status"] {
  if (!lineup.formation && lineup.starters.length === 0) {
    return "insufficient_data";
  }

  const shape = lineupPositionCounts(lineup);
  if (
    shape.full &&
    shape.valid &&
    hasStrongOrIndependent(supporting)
  ) {
    return "supported";
  }
  return "partial";
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
  const itemVerdicts = grounding.itemEntailmentVerdicts ?? {};
  const removedItems: string[] = [];
  const removedDirectionalDimensions = new Set<string>();
  const forcedInvalidationReasons = new Set<string>();
  let nonDirectionalRemovalCount = 0;

  const usableEvidenceIds = (ids: string[]) =>
    ids.filter((id) => usableById.has(id));
  const evidenceFor = (ids: string[]) =>
    usableEvidenceIds(ids)
      .map((id) => usableById.get(id))
      .filter((item): item is GroundedEvidence => item != null);
  const itemSupported = (verificationId: string) =>
    itemVerdicts[verificationId] === "supported";

  output.availability = output.availability.flatMap((rawItem, index) => {
    const evidenceIds = usableEvidenceIds(rawItem.evidence_ids);
    if (evidenceIds.length === 0) {
      removedItems.push(`availability:${rawItem.player_name}`);
      nonDirectionalRemovalCount += 1;
      return [];
    }

    const item = { ...rawItem, evidence_ids: evidenceIds };
    if (evidenceIds.length !== rawItem.evidence_ids.length) {
      removedItems.push(
        `availability_evidence_pruned:${rawItem.player_name}`,
      );
    }

    if (output.protocol_version === "kapiloto-research-v3") {
      const functions = rawItem.functions ?? [];
      const functionEvidence = usableEvidenceIds(
        rawItem.function_evidence_ids ?? [],
      );
      if (
        functions.length > 0 &&
        (!itemSupported(`availability:functions:${index}`) ||
          functionEvidence.length !==
            (rawItem.function_evidence_ids ?? []).length)
      ) {
        item.functions = [];
        item.function_evidence_ids = [];
        removedItems.push(
          `availability_functions:${rawItem.player_name}`,
        );
      } else {
        item.functions = functions;
        item.function_evidence_ids = functionEvidence;
      }
    }

    return [item];
  });

  if (output.protocol_version === "kapiloto-research-v3") {
    const unavailableBySide = {
      home: new Set(
        output.availability
          .filter(
            (item) =>
              item.team === "home" &&
              (item.status === "out" || item.status === "suspended"),
          )
          .map((item) => normalizeName(item.player_name)),
      ),
      away: new Set(
        output.availability
          .filter(
            (item) =>
              item.team === "away" &&
              (item.status === "out" || item.status === "suspended"),
          )
          .map((item) => normalizeName(item.player_name)),
      ),
    };

    for (const side of ["home", "away"] as const) {
      const rawLineup = output.expected_lineups?.[side];
      if (!rawLineup) continue;

      const formationEvidence = usableEvidenceIds(
        rawLineup.formation_evidence_ids,
      );
      const formation =
        rawLineup.formation != null &&
        itemSupported(`lineup:${side}:formation`) &&
        formationEvidence.length === rawLineup.formation_evidence_ids.length
          ? rawLineup.formation
          : null;

      if (rawLineup.formation && !formation) {
        removedItems.push(`lineup:${side}:formation`);
      }

      const starters = rawLineup.starters.flatMap((starter, index) => {
        const evidenceIds = usableEvidenceIds(starter.evidence_ids);
        const unavailable = unavailableBySide[side].has(
          normalizeName(starter.player_name),
        );
        if (
          !itemSupported(`lineup:${side}:starter:${index}`) ||
          evidenceIds.length !== starter.evidence_ids.length ||
          unavailable
        ) {
          removedItems.push(
            `lineup:${side}:starter:${starter.player_name}`,
          );
          return [];
        }
        return [{ ...starter, evidence_ids: evidenceIds }];
      });

      const sanitized: SolExpectedLineup = {
        ...rawLineup,
        formation,
        formation_evidence_ids:
          formation == null ? [] : formationEvidence,
        starters,
        status: "insufficient_data",
      };
      const allEvidence = evidenceFor([
        ...sanitized.formation_evidence_ids,
        ...sanitized.starters.flatMap((starter) => starter.evidence_ids),
      ]);
      sanitized.status = deriveLineupStatus(sanitized, allEvidence);
      output.expected_lineups![side] = sanitized;
    }

    const survivingFacts: SolTacticalFact[] = [];
    for (const fact of output.tactical_facts ?? []) {
      const evidenceIds = usableEvidenceIds(fact.evidence_ids);
      if (
        !itemSupported(`tactical_fact:${fact.fact_id}`) ||
        evidenceIds.length !== fact.evidence_ids.length
      ) {
        removedItems.push(`tactical_fact:${fact.fact_id}`);
        nonDirectionalRemovalCount += 1;
        continue;
      }
      survivingFacts.push({ ...fact, evidence_ids: evidenceIds });
    }
    output.tactical_facts = survivingFacts;
    const factIds = new Set<string>(survivingFacts.map((fact) => fact.fact_id));

    const survivingMatchups: SolMatchupAnalysis[] = [];
    for (const matchup of output.matchup_analysis ?? []) {
      const evidenceIds = usableEvidenceIds(matchup.evidence_ids);
      const supporting = evidenceFor(evidenceIds);
      const factsSurvive = matchup.fact_ids.every((id) => factIds.has(id));
      const recentDirectionalEvidence =
        matchup.favors === "none" ||
        supporting.some((item) => {
          if (!item.publishedAt) return false;
          return (
            Date.parse(card.research_cutoff_at) -
              Date.parse(item.publishedAt) <=
            14 * 86_400_000
          );
        });
      const corroborated =
        matchup.magnitude === "small" ||
        hasStrongOrIndependent(supporting);
      const magnitudeAllowed =
        matchup.kind !== "aerial_set_piece" ||
        matchup.magnitude === "small";

      if (
        !itemSupported(`matchup:${matchup.matchup_id}`) ||
        evidenceIds.length !== matchup.evidence_ids.length ||
        !factsSurvive ||
        !recentDirectionalEvidence ||
        !corroborated ||
        !magnitudeAllowed
      ) {
        removedItems.push(`matchup:${matchup.matchup_id}`);
        if (matchup.favors === "none") {
          nonDirectionalRemovalCount += 1;
        }
        continue;
      }

      survivingMatchups.push({ ...matchup, evidence_ids: evidenceIds });
    }
    output.matchup_analysis = survivingMatchups;

    output.regime_changes = (output.regime_changes ?? []).flatMap(
      (regime, index) => {
        const evidenceIds = usableEvidenceIds(regime.evidence_ids);
        const supporting = evidenceFor(evidenceIds);
        if (
          !itemSupported(`regime:${index}`) ||
          evidenceIds.length !== regime.evidence_ids.length ||
          !hasStrongOrIndependent(supporting)
        ) {
          removedItems.push(`regime:${index}`);
          nonDirectionalRemovalCount += 1;
          return [];
        }
        return [{ ...regime, evidence_ids: evidenceIds }];
      },
    );
  }

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
    return [
      {
        ...item,
        evidence_ids_a: evidenceIdsA,
        evidence_ids_b: evidenceIdsB,
      },
    ];
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
      if (
        evidenceIds.length !== output.market_deviation.evidence_ids.length
      ) {
        removedItems.push("market_deviation_evidence_pruned");
      }
      output.market_deviation = {
        ...output.market_deviation,
        evidence_ids: evidenceIds,
      };
    }
  }

  const survivingMatchupById = new Map<string, SolMatchupAnalysis>(
    (output.matchup_analysis ?? []).map((item) => [item.matchup_id, item]),
  );
  const removedDirectionalFactors: ResearchFactor[] = [];
  const kept: Array<{ factor: ResearchFactor; originalIndex: number }> = [];
  let directionalTacticalCount = 0;

  const recordRemovedFactor = (factor: ResearchFactor, reason?: string) => {
    removedItems.push(
      `factor:${factor.dimension}${reason ? `:${reason}` : ""}`,
    );
    if (factor.favors === "none") {
      nonDirectionalRemovalCount += 1;
    } else {
      removedDirectionalDimensions.add(factor.dimension);
      removedDirectionalFactors.push(factor);
    }
  };

  for (let index = 0; index < output.factors.length; index += 1) {
    const rawFactor = output.factors[index];
    const evidenceIds = usableEvidenceIds(rawFactor.evidence_ids);
    const factor = { ...rawFactor, evidence_ids: evidenceIds };
    const supporting = evidenceFor(evidenceIds);
    const structured =
      (factor.structured_refs?.length ?? 0) > 0
        ? verifyStructuredFactor(factor, card)
        : null;
    const linkedMatchups = (factor.matchup_ids ?? []).map((id) =>
      survivingMatchupById.get(id),
    );

    const structuredUsable = structured == null || structured.valid;
    const hasVerifiedSupport =
      supporting.length > 0 || structured?.valid === true;
    const directionalEntailmentPassed =
      factor.favors === "none" ||
      (supporting.length === 0
        ? structured?.valid === true
        : supporting.every((item) => item.entailment === "supported"));
    const corroborationPassed =
      factor.magnitude === "small" ||
      (supporting.length > 0 &&
        materialCorroboration(factor, supporting));
    const matchupsSurvive =
      linkedMatchups.every((item) => item != null);

    let specialRulesPass = true;

    if (
      factor.dimension === "tactical_matchup" &&
      factor.favors !== "none"
    ) {
      directionalTacticalCount += 1;
      if (directionalTacticalCount > 1) {
        specialRulesPass = false;
        forcedInvalidationReasons.add(
          "p_sol_invalidated:multiple_tactical_factors",
        );
      }
      if (factor.magnitude === "large") specialRulesPass = false;
      const linked = linkedMatchups.filter(
        (item): item is SolMatchupAnalysis => item != null,
      );
      if (
        linked.length > 0 &&
        linked.every((item) => item.kind === "aerial_set_piece") &&
        factor.magnitude !== "small"
      ) {
        specialRulesPass = false;
      }
    }

    if (
      factor.dimension === "availability" &&
      factor.favors !== "none"
    ) {
      const supportedMaterialAbsences = output.availability.filter(
        (item) =>
          (item.status === "out" || item.status === "suspended") &&
          (item.certainty === "confirmed" || item.certainty === "probable") &&
          (item.functions?.length ?? 0) > 0,
      ).length;
      const maximumRank =
        supportedMaterialAbsences >= 2
          ? 3
          : supportedMaterialAbsences === 1
            ? 2
            : 1;
      if (magnitudeRank(factor.magnitude) > maximumRank) {
        specialRulesPass = false;
      }
    }

    const keep =
      structuredUsable &&
      hasVerifiedSupport &&
      directionalEntailmentPassed &&
      corroborationPassed &&
      matchupsSurvive &&
      specialRulesPass;

    if (!keep) {
      recordRemovedFactor(
        rawFactor,
        !matchupsSurvive ? "linked_matchup_removed" : undefined,
      );
      continue;
    }

    if (evidenceIds.length !== rawFactor.evidence_ids.length) {
      removedItems.push(`factor_evidence_pruned:${factor.dimension}`);
    }
    kept.push({ factor, originalIndex: index });
  }

  const directionalEvidenceUsers = new Map<string, number[]>();
  const directionalStructuredUsers = new Map<string, number[]>();
  for (let index = 0; index < kept.length; index += 1) {
    const factor = kept[index].factor;
    if (factor.favors === "none") continue;
    for (const evidenceId of factor.evidence_ids) {
      const users = directionalEvidenceUsers.get(evidenceId) ?? [];
      users.push(index);
      directionalEvidenceUsers.set(evidenceId, users);
    }
    for (const ref of factor.structured_refs ?? []) {
      const family = ref.endsWith(".form")
        ? "form"
        : ref.endsWith(".attack_xg")
          ? "attack_xg"
          : ref.endsWith(".table")
            ? "table"
            : ref.endsWith(".rest")
              ? "rest"
              : ref;
      const users = directionalStructuredUsers.get(family) ?? [];
      users.push(index);
      directionalStructuredUsers.set(family, users);
    }
  }

  const doubleCountedIndexes = new Set<number>();
  for (const users of directionalEvidenceUsers.values()) {
    if (new Set(users).size > 1) {
      users.forEach((index) => doubleCountedIndexes.add(index));
      forcedInvalidationReasons.add(
        "p_sol_invalidated:duplicate_directional_evidence",
      );
    }
  }
  for (const users of directionalStructuredUsers.values()) {
    if (new Set(users).size > 1) {
      users.forEach((index) => doubleCountedIndexes.add(index));
      forcedInvalidationReasons.add(
        "p_sol_invalidated:duplicate_structured_strength",
      );
    }
  }

  output.factors = kept.flatMap((record, keptIndex) => {
    if (!doubleCountedIndexes.has(keptIndex)) return [record.factor];
    recordRemovedFactor(record.factor, "double_count");
    return [];
  });

  if (output.protocol_version === "kapiloto-research-v3") {
    const linkedSurviving = new Set(
      output.factors.flatMap((factor) => factor.matchup_ids ?? []),
    );
    output.matchup_analysis = (output.matchup_analysis ?? []).filter(
      (matchup) =>
        matchup.favors === "none" ||
        linkedSurviving.has(matchup.matchup_id),
    );
  }

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
    output.summary =
      output.factors.length > 0
        ? output.factors
            .slice(0, 2)
            .map((factor) => factor.rationale)
            .join(" ")
        : "Only limited verified pre-match information remained after evidence checks.";
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

  const unsafeRemovedDirectional = removedDirectionalFactors.filter(
    (factor) => factor.magnitude !== "small",
  );

  const invalidationReasons = [
    ...forcedInvalidationReasons,
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
      reasons: [...new Set(invalidationReasons)].sort(),
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
