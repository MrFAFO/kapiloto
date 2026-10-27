import type { KapilotoFixtureCard } from "./fixture-card";
import {
  applyLegacyGroundingPolicy,
  KAPILOTO_LEGACY_GROUNDING_POLICY_VERSION,
} from "./grounding-policy-legacy";
import type {
  SolExpectedLineup,
  SolFixtureResearchOutput,
  SolMatchupAnalysis,
  SolTacticalFact,
} from "./research-output";
import {
  canonicalClaimTypeForDimension,
  evidenceIdentityKey,
  itemTrustTier,
  regimeMakesStructuredStale,
} from "./research-v3-rules";
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
  /** Policy version that produced this decision (v8 replays v1/v2). */
  policyVersion?: string;
  /** Teams whose structured form/xG provably predates a regime change. */
  preRegimeStructuredTeams?: Array<"home" | "away">;
};

export const V3_SANITIZED_SUMMARY =
  "Kapiloto published only the research items that passed evidence verification; some reported items were removed.";
export const V3_SANITIZED_MAIN_RISK =
  "Some reported inputs were excluded because they did not pass evidence policy.";

function independent(left: GroundedEvidence, right: GroundedEvidence): boolean {
  if (left.domain === right.domain) return false;
  return !(
    left.syndicationClusterId &&
    right.syndicationClusterId &&
    left.syndicationClusterId === right.syndicationClusterId
  );
}

/** Tier 1/2 for the item's canonical class, or two independent sources. */
function strongOrIndependent(
  supporting: GroundedEvidence[],
  canonicalClaimType: string,
): boolean {
  if (supporting.some((item) => itemTrustTier(item, canonicalClaimType) <= 2)) {
    return true;
  }
  return supporting.some((left, index) =>
    supporting.slice(index + 1).some((right) => independent(left, right)),
  );
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
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function lineupShapeValid(lineup: SolExpectedLineup): boolean {
  if (!lineup.formation || lineup.starters.length !== 11) return false;
  if (lineup.starters.some((starter) => starter.position === "unknown")) {
    return false;
  }
  const digits = lineup.formation.split("-").map(Number);
  const expected = {
    DF: digits[0] ?? 0,
    MF: digits.slice(1, -1).reduce((sum, value) => sum + value, 0),
    FW: digits[digits.length - 1] ?? 0,
  };
  const count = (position: string) =>
    lineup.starters.filter((starter) => starter.position === position).length;
  return (
    count("GK") === 1 &&
    count("DF") === expected.DF &&
    count("MF") === expected.MF &&
    count("FW") === expected.FW
  );
}

/** Server-derived lineup status after pruning. */
export function deriveLineupStatus(
  lineup: SolExpectedLineup,
  supporting: GroundedEvidence[],
): SolExpectedLineup["status"] {
  if (!lineup.formation && lineup.starters.length === 0) {
    return "insufficient_data";
  }
  if (lineupShapeValid(lineup) && strongOrIndependent(supporting, "lineup")) {
    return "supported";
  }
  return "partial";
}

const STALE_REF_SUFFIXES = [".form", ".attack_xg"];

/** Removal keys for descriptive research that never moves probabilities. */
const DESCRIPTIVE_REMOVAL = /^(availability_function|lineup|tactical_fact|regime|matchup):/;

function structuredFamily(ref: string): string {
  const dot = ref.indexOf(".");
  return dot < 0 ? ref : ref.slice(dot + 1);
}

export function applyGroundingPolicy(
  rawOutput: SolFixtureResearchOutput,
  grounding: GroundingResult,
  card: KapilotoFixtureCard,
): GroundingPolicyDecision {
  if (rawOutput.protocol_version !== "kapiloto-research-v3") {
    return {
      ...applyLegacyGroundingPolicy(rawOutput, grounding, card),
      policyVersion: KAPILOTO_LEGACY_GROUNDING_POLICY_VERSION,
    };
  }

  const output = cloneOutput(rawOutput);
  const usableById = new Map(
    grounding.accepted
      .filter((item) => item.entailment !== "unsupported")
      .map((item) => [item.modelEvidenceId, item]),
  );
  const verdicts = grounding.itemEntailmentVerdicts ?? {};
  const exclusions = grounding.itemEvidenceExclusions ?? {};
  const removedItems: string[] = [];
  const removedDirectionalDimensions = new Set<string>();
  const forcedInvalidation = new Set<string>();
  let nonDirectionalRemovalCount = 0;

  const usableIds = (ids: string[], itemKey?: string) => {
    const excluded = new Set(itemKey ? (exclusions[itemKey] ?? []) : []);
    return ids.filter((id) => usableById.has(id) && !excluded.has(id));
  };
  const evidenceFor = (ids: string[]) =>
    ids
      .map((id) => usableById.get(id))
      .filter((item): item is GroundedEvidence => item != null);
  const supported = (verificationId: string) =>
    verdicts[verificationId] === "supported";

  // Availability, with each role pruned independently of the absence.
  output.availability = output.availability.flatMap((rawItem, index) => {
    const evidenceIds = usableIds(rawItem.evidence_ids, `availability:${index}`);
    if (evidenceIds.length === 0) {
      removedItems.push(`availability:${rawItem.player_name}`);
      nonDirectionalRemovalCount += 1;
      return [];
    }
    const item = { ...rawItem, evidence_ids: evidenceIds };
    if (evidenceIds.length !== rawItem.evidence_ids.length) {
      removedItems.push(`availability_evidence_pruned:${rawItem.player_name}`);
    }

    const roleEvidence = rawItem.function_evidence_ids ?? [];
    const roleEvidenceUsable =
      usableIds(roleEvidence).length === roleEvidence.length;
    const functions = (rawItem.functions ?? []).filter((role) => {
      const keep =
        roleEvidenceUsable &&
        supported(`availability:functions:${index}:${role}`);
      if (!keep) {
        removedItems.push(`availability_function:${rawItem.player_name}:${role}`);
      }
      return keep;
    });
    item.functions = functions;
    item.function_evidence_ids = functions.length > 0 ? roleEvidence : [];
    return [item];
  });

  // Expected lineups: starters/formation pruned item by item, status
  // recomputed by the server.
  const unavailable = {
    home: new Set<string>(),
    away: new Set<string>(),
  };
  for (const item of output.availability) {
    if (
      (item.status === "out" || item.status === "suspended") &&
      (item.certainty === "confirmed" || item.certainty === "probable")
    ) {
      unavailable[item.team].add(normalizeName(item.player_name));
    }
  }
  for (const side of ["home", "away"] as const) {
    const rawLineup = output.expected_lineups?.[side];
    if (!rawLineup || !output.expected_lineups) continue;
    const enabled = card.lineup_research === "enabled";

    const formationIds = usableIds(rawLineup.formation_evidence_ids);
    const formation =
      enabled &&
      rawLineup.formation != null &&
      supported(`lineup:${side}:formation`) &&
      formationIds.length === rawLineup.formation_evidence_ids.length
        ? rawLineup.formation
        : null;
    if (rawLineup.formation != null && formation == null) {
      removedItems.push(`lineup:${side}:formation`);
    }

    const starters = rawLineup.starters.flatMap((starter, index) => {
      const ids = usableIds(starter.evidence_ids);
      if (
        !enabled ||
        !supported(`lineup:${side}:starter:${index}`) ||
        ids.length !== starter.evidence_ids.length ||
        unavailable[side].has(normalizeName(starter.player_name))
      ) {
        removedItems.push(`lineup:${side}:starter:${starter.player_name}`);
        return [];
      }
      return [{ ...starter, evidence_ids: ids }];
    });

    const sanitized: SolExpectedLineup = {
      formation,
      formation_evidence_ids: formation == null ? [] : formationIds,
      starters,
      status: "insufficient_data",
    };
    sanitized.status = deriveLineupStatus(
      sanitized,
      evidenceFor([
        ...sanitized.formation_evidence_ids,
        ...starters.flatMap((starter) => starter.evidence_ids),
      ]),
    );
    output.expected_lineups[side] = sanitized;
  }

  // Tactical facts: descriptive, removed individually.
  const facts: SolTacticalFact[] = [];
  for (const fact of output.tactical_facts ?? []) {
    const ids = usableIds(fact.evidence_ids);
    if (
      !supported(`tactical_fact:${fact.fact_id}`) ||
      ids.length !== fact.evidence_ids.length
    ) {
      removedItems.push(`tactical_fact:${fact.fact_id}`);
      nonDirectionalRemovalCount += 1;
      continue;
    }
    facts.push({ ...fact, evidence_ids: ids });
  }
  output.tactical_facts = facts;
  const factIds = new Set<string>(facts.map((fact) => fact.fact_id));

  // Regime changes: contextual only; need strong or independent sources.
  output.regime_changes = (output.regime_changes ?? []).flatMap(
    (regime, index) => {
      const ids = usableIds(regime.evidence_ids);
      if (
        !supported(`regime:${index}`) ||
        ids.length !== regime.evidence_ids.length ||
        !strongOrIndependent(evidenceFor(ids), "coach_regime")
      ) {
        removedItems.push(`regime:${index}`);
        nonDirectionalRemovalCount += 1;
        return [];
      }
      return [{ ...regime, evidence_ids: ids }];
    },
  );
  const preRegimeTeams = new Set<"home" | "away">();
  for (const regime of output.regime_changes) {
    if (regimeMakesStructuredStale(regime, card)) preRegimeTeams.add(regime.team);
  }

  // Matchups: descriptive; removed when their inference or inputs fail.
  const linkedMatchupIds = new Set(
    output.factors.flatMap((factor) => factor.matchup_ids ?? []),
  );
  const matchups: SolMatchupAnalysis[] = [];
  for (const matchup of output.matchup_analysis ?? []) {
    const ids = usableIds(matchup.evidence_ids);
    const keep =
      supported(`matchup:${matchup.matchup_id}`) &&
      ids.length === matchup.evidence_ids.length &&
      matchup.fact_ids.every((id) => factIds.has(id)) &&
      (matchup.magnitude === "small" ||
        strongOrIndependent(
          evidenceFor(ids),
          matchup.kind === "absence_impact" ? "availability" : "tactical_setup",
        )) &&
      (matchup.kind !== "aerial_set_piece" || matchup.magnitude === "small");
    if (!keep) {
      removedItems.push(`matchup:${matchup.matchup_id}`);
      if (matchup.favors === "none") nonDirectionalRemovalCount += 1;
      continue;
    }
    if (matchup.favors !== "none" && !linkedMatchupIds.has(matchup.matchup_id)) {
      // Defensive: validation rejects this, but a replayed output must not
      // leave an undeclared directional signal behind.
      removedItems.push(`matchup:${matchup.matchup_id}:unlinked`);
      if (matchup.magnitude !== "small") {
        forcedInvalidation.add("p_sol_invalidated:unlinked_directional_matchup");
      }
      continue;
    }
    matchups.push({ ...matchup, evidence_ids: ids });
  }
  output.matchup_analysis = matchups;
  const matchupById = new Map<string, SolMatchupAnalysis>(
    matchups.map((item) => [item.matchup_id, item]),
  );

  output.conflicts = output.conflicts.flatMap((item) => {
    const a = usableIds(item.evidence_ids_a);
    const b = usableIds(item.evidence_ids_b);
    if (a.length === 0 || b.length === 0) {
      removedItems.push(`conflict:${item.topic}`);
      nonDirectionalRemovalCount += 1;
      return [];
    }
    if (a.length !== item.evidence_ids_a.length || b.length !== item.evidence_ids_b.length) {
      removedItems.push(`conflict_evidence_pruned:${item.topic}`);
    }
    return [{ ...item, evidence_ids_a: a, evidence_ids_b: b }];
  });

  if (output.market_deviation) {
    const ids = usableIds(output.market_deviation.evidence_ids);
    if (ids.length === 0) {
      output.market_deviation = null;
      removedItems.push("market_deviation");
      nonDirectionalRemovalCount += 1;
    } else {
      if (ids.length !== output.market_deviation.evidence_ids.length) {
        removedItems.push("market_deviation_evidence_pruned");
      }
      output.market_deviation = { ...output.market_deviation, evidence_ids: ids };
    }
  }

  // Factors: the only probability-moving channel.
  const absenceEvidenceKeys = new Set(
    output.availability.flatMap((item) =>
      evidenceFor(item.evidence_ids).map(evidenceIdentityKey),
    ),
  );
  const removedDirectional: ResearchFactor[] = [];
  const removeFactor = (factor: ResearchFactor, reason: string) => {
    removedItems.push(`factor:${factor.dimension}:${reason}`);
    if (factor.favors === "none") {
      nonDirectionalRemovalCount += 1;
    } else {
      removedDirectionalDimensions.add(factor.dimension);
      removedDirectional.push(factor);
    }
  };

  let directionalTactical = 0;
  const kept: ResearchFactor[] = [];
  output.factors.forEach((rawFactor, index) => {
    const ids = usableIds(rawFactor.evidence_ids, `factor:${index}`);
    const factor = { ...rawFactor, evidence_ids: ids };
    const supporting = evidenceFor(ids);
    const canonical = canonicalClaimTypeForDimension(factor.dimension);
    const refs = factor.structured_refs ?? [];
    const structured = refs.length > 0 ? verifyStructuredFactor(factor, card) : null;
    const directional = factor.favors !== "none";

    const staleRef = refs.some((ref) => {
      const side = ref.split(".")[0] as "home" | "away";
      return (
        preRegimeTeams.has(side) &&
        STALE_REF_SUFFIXES.some((suffix) => ref.endsWith(suffix))
      );
    });
    if (staleRef) return removeFactor(rawFactor, "pre_regime_structured_ref");
    if (structured && !structured.valid) {
      return removeFactor(rawFactor, `structured_${structured.reason}`);
    }
    if (supporting.length === 0 && structured?.valid !== true) {
      return removeFactor(rawFactor, "no_verified_support");
    }
    if (
      directional &&
      supporting.length > 0 &&
      !supporting.every((item) => item.entailment === "supported")
    ) {
      return removeFactor(rawFactor, "entailment_not_supported");
    }
    if (
      factor.magnitude !== "small" &&
      (supporting.length === 0 || !strongOrIndependent(supporting, canonical))
    ) {
      return removeFactor(rawFactor, "corroboration");
    }
    if ((factor.matchup_ids ?? []).some((id) => !matchupById.has(id))) {
      return removeFactor(rawFactor, "linked_matchup_removed");
    }

    if (factor.dimension === "tactical_matchup" && directional) {
      directionalTactical += 1;
      if (directionalTactical > 1) {
        forcedInvalidation.add("p_sol_invalidated:multiple_tactical_factors");
        return removeFactor(rawFactor, "multiple_tactical_factors");
      }
      if (factor.magnitude === "large") {
        return removeFactor(rawFactor, "tactical_magnitude_cap");
      }
      const linked = (factor.matchup_ids ?? []).map((id) => matchupById.get(id)!);
      if (
        linked.length > 0 &&
        linked.every((item) => item.kind === "aerial_set_piece") &&
        factor.magnitude !== "small"
      ) {
        return removeFactor(rawFactor, "set_piece_magnitude_cap");
      }
      if (supporting.some((item) => absenceEvidenceKeys.has(evidenceIdentityKey(item)))) {
        // One absence is counted once, in the availability factor.
        return removeFactor(rawFactor, "absence_double_count");
      }
    }

    if (factor.dimension === "availability" && directional) {
      const disfavored =
        factor.favors === "home"
          ? ["away"]
          : factor.favors === "away"
            ? ["home"]
            : ["home", "away"];
      const factorKeys = new Set(supporting.map(evidenceIdentityKey));
      const roleBacked = output.availability.filter(
        (item) =>
          disfavored.includes(item.team) &&
          (item.status === "out" || item.status === "suspended") &&
          (item.certainty === "confirmed" || item.certainty === "probable") &&
          (item.functions?.length ?? 0) > 0 &&
          evidenceFor(item.evidence_ids).some((evidence) =>
            factorKeys.has(evidenceIdentityKey(evidence)),
          ),
      ).length;
      const cap = roleBacked >= 2 ? 3 : roleBacked === 1 ? 2 : 1;
      if (magnitudeRank(factor.magnitude) > cap) {
        return removeFactor(rawFactor, "absence_magnitude_cap");
      }
    }

    if (ids.length !== rawFactor.evidence_ids.length) {
      removedItems.push(`factor_evidence_pruned:${factor.dimension}`);
    }
    kept.push(factor);
  });

  // Double counting across directional factors: one evidence identity and
  // one structured strength family may back at most one directional factor.
  const evidenceUsers = new Map<string, Set<number>>();
  const familyUsers = new Map<string, Set<number>>();
  kept.forEach((factor, index) => {
    if (factor.favors === "none") return;
    for (const evidence of evidenceFor(factor.evidence_ids)) {
      const key = evidenceIdentityKey(evidence);
      const users = evidenceUsers.get(key) ?? new Set<number>();
      users.add(index);
      evidenceUsers.set(key, users);
    }
    for (const ref of factor.structured_refs ?? []) {
      const family = structuredFamily(ref);
      if (family === "rest") continue;
      const users = familyUsers.get(family) ?? new Set<number>();
      users.add(index);
      familyUsers.set(family, users);
    }
  });
  const doubleCounted = new Set<number>();
  for (const users of evidenceUsers.values()) {
    if (users.size > 1) {
      users.forEach((index) => doubleCounted.add(index));
      forcedInvalidation.add("p_sol_invalidated:duplicate_directional_evidence");
    }
  }
  for (const users of familyUsers.values()) {
    if (users.size > 1) {
      users.forEach((index) => doubleCounted.add(index));
      forcedInvalidation.add("p_sol_invalidated:duplicate_structured_strength");
    }
  }
  output.factors = kept.filter((factor, index) => {
    if (!doubleCounted.has(index)) return true;
    removeFactor(factor, "double_count");
    return false;
  });

  // Factor failure removes its linked matchups.
  const survivingLinks = new Set(
    output.factors.flatMap((factor) => factor.matchup_ids ?? []),
  );
  output.matchup_analysis = output.matchup_analysis.filter((matchup) => {
    if (matchup.favors === "none" || survivingLinks.has(matchup.matchup_id)) {
      return true;
    }
    removedItems.push(`matchup:${matchup.matchup_id}:factor_removed`);
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
    // Never publish model prose that may describe removed items. Only the
    // removal of probability-relevant inputs is a data-quality signal for
    // reliability; pruning purely descriptive research (lineups, roles,
    // tactical facts, regimes, matchups) must not depress p_final by itself.
    const materialRemoval = removedItems.some(
      (item) => !DESCRIPTIVE_REMOVAL.test(item),
    );
    output.key_assumptions = [];
    output.watch_items = [];
    output.summary = V3_SANITIZED_SUMMARY;
    output.main_risk = V3_SANITIZED_MAIN_RISK;
    output.data_quality = {
      ...output.data_quality,
      sparse_coverage: output.data_quality.sparse_coverage || materialRemoval,
      notes: "unsupported_items_removed",
    };
  }

  const base = {
    output,
    removedItems,
    removedDirectionalDimensions: [...removedDirectionalDimensions].sort(),
    nonDirectionalRemovalCount,
    policyVersion: KAPILOTO_GROUNDING_POLICY_VERSION,
    preRegimeStructuredTeams: [...preRegimeTeams].sort(),
  };

  if (rawOutput.outcome === "insufficient_data") {
    return {
      ...base,
      mode: "insufficient_data",
      pSolValid: false,
      reasons: ["sol_reported_insufficient_data"],
    };
  }

  const invalidation = [
    ...forcedInvalidation,
    ...removedDirectional
      .filter((factor) => factor.magnitude !== "small")
      .map((factor) => `p_sol_invalidated:${factor.dimension}`),
    ...(output.factors.some((factor) => factor.favors !== "none")
      ? []
      : ["p_sol_invalidated:no_grounded_directional_signal"]),
  ];

  if (invalidation.length > 0) {
    return {
      ...base,
      mode:
        card.structured.prior.type !== "league_base"
          ? "market_only"
          : "insufficient_data",
      pSolValid: false,
      reasons: [...new Set(invalidation)].sort(),
    };
  }

  return {
    ...base,
    mode: "sol",
    pSolValid: true,
    reasons:
      removedItems.length > 0
        ? [
            ...(removedDirectional.length > 0 ? ["directional_items_pruned"] : []),
            "secondary_items_removed",
          ]
        : [],
  };
}
