import type { DeterministicBase, MarketQuality, StatArmId } from "./base";
import { maxDisagreementBp } from "./probability";
import { configProvenance, type ConfigProvenance, type VersionedConfig } from "./provenance";

/**
 * Research triage in three separable parts:
 *   1. extractTriageFeatures — pure facts about the fixture (no thresholds);
 *   2. TriageConfig          — versioned candidate scoring/threshold values;
 *   3. assignTriage          — scoring and tier assignment from 1 + 2.
 * Thresholds can be re-evaluated later without touching the engine.
 */

export const TRIAGE_ENGINE_VERSION = "kapiloto-research-v2-triage-engine-v1" as const;

/** Structured context from data feeds. It never contains an outcome. */
export type TriageContext = {
  /** Days since the most recent manager change for each side, null if none known. */
  managerChangeDaysAgo: { home: number | null; away: number | null };
  restDays: { home: number | null; away: number | null };
  matchesLast14Days: { home: number | null; away: number | null };
  competition: { isCup: boolean; isSecondLeg: boolean };
  promoted: { home: boolean | null; away: boolean | null };
  /** Key-player statuses left unresolved by an earlier pass for this fixture. */
  unresolvedAvailability: number;
};

export type TriageFeatures = {
  fixtureId: string;
  marketQuality: MarketQuality;
  statArm: StatArmId;
  statAvailable: boolean;
  /** Market vs stat disagreement in basis points, null when either is missing. */
  disagreementBp: number | null;
  managerChangeDaysAgo: number | null;
  minRestDays: number | null;
  maxMatchesLast14Days: number | null;
  neutralVenue: boolean;
  isCup: boolean;
  isSecondLeg: boolean;
  promotedSide: boolean;
  unresolvedAvailability: number;
};

/** Information needs Sol may be asked to research. Closed list, no generic topics. */
export const INFORMATION_NEED_KINDS = [
  "availability_rotation_check",
  "manager_change_context",
  "congestion_rotation",
  "market_stat_gap",
  "coverage_gap",
  "competition_context",
  "unresolved_availability",
] as const;
export type InformationNeedKind = (typeof INFORMATION_NEED_KINDS)[number];

export type InformationNeed = { needId: string; kind: InformationNeedKind; team: "home" | "away" | "both" };

export type ResearchTier = "minimal" | "standard" | "deep";

export type TriageConfig = VersionedConfig & {
  statArm: StatArmId;
  disagreementBands: Array<{ minBp: number; points: number }>;
  marketPoints: Record<MarketQuality, number>;
  statUnavailablePoints: number;
  managerChangeWindowDays: number;
  managerChangePoints: number;
  congestion: { maxRestDays: number; minMatchesLast14Days: number; points: number };
  competitionContextPoints: number;
  promotedPoints: number;
  unresolvedAvailabilityPoints: number;
  tierMinScore: { standard: number; deep: number };
  budgets: Record<ResearchTier, { maxSearches: number; maxVerifiedPages: number }>;
};

export type TriageDecision = {
  fixtureId: string;
  features: TriageFeatures;
  score: number;
  reasons: string[];
  tier: ResearchTier;
  needs: InformationNeed[];
  budget: { maxSearches: number; maxVerifiedPages: number };
  engineVersion: typeof TRIAGE_ENGINE_VERSION;
  config: ConfigProvenance;
};

const minOf = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.min(a, b));
const maxOf = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.max(a, b));

export function extractTriageFeatures(
  base: DeterministicBase,
  context: TriageContext,
  options: { statArm: StatArmId; neutralVenue: boolean },
): TriageFeatures {
  const stat = base.arms[options.statArm];
  const market = base.arms.p_market_v1;
  const managerChange = [context.managerChangeDaysAgo.home, context.managerChangeDaysAgo.away].filter(
    (days): days is number => days != null,
  );
  return {
    fixtureId: base.fixtureId,
    marketQuality: base.market.quality,
    statArm: options.statArm,
    statAvailable: stat.status === "available",
    disagreementBp:
      stat.status === "available" && market.status === "available"
        ? maxDisagreementBp(stat.probabilities, market.probabilities)
        : null,
    managerChangeDaysAgo: managerChange.length > 0 ? Math.min(...managerChange) : null,
    minRestDays: minOf(context.restDays.home, context.restDays.away),
    maxMatchesLast14Days: maxOf(context.matchesLast14Days.home, context.matchesLast14Days.away),
    neutralVenue: options.neutralVenue,
    isCup: context.competition.isCup,
    isSecondLeg: context.competition.isSecondLeg,
    promotedSide: context.promoted.home === true || context.promoted.away === true,
    unresolvedAvailability: context.unresolvedAvailability,
  };
}

export function assignTriage(features: TriageFeatures, config: TriageConfig): TriageDecision {
  let score = 0;
  const reasons: string[] = [];
  const needs: InformationNeed[] = [
    { needId: "availability_rotation_check:home", kind: "availability_rotation_check", team: "home" },
    { needId: "availability_rotation_check:away", kind: "availability_rotation_check", team: "away" },
  ];
  const add = (points: number, reason: string, need?: Omit<InformationNeed, "needId">) => {
    if (points <= 0) return;
    score += points;
    reasons.push(reason);
    if (need && !needs.some((existing) => existing.kind === need.kind && existing.team === need.team)) {
      needs.push({ ...need, needId: `${need.kind}:${need.team}` });
    }
  };

  if (features.disagreementBp != null) {
    const band = [...config.disagreementBands].sort((a, b) => b.minBp - a.minBp).find((item) => features.disagreementBp! >= item.minBp);
    if (band) add(band.points, `market_stat_disagreement_${band.minBp}bp`, { kind: "market_stat_gap", team: "both" });
  }
  add(config.marketPoints[features.marketQuality], `market_${features.marketQuality}`, features.marketQuality === "standard" ? undefined : { kind: "coverage_gap", team: "both" });
  if (!features.statAvailable) add(config.statUnavailablePoints, "stat_unavailable", { kind: "coverage_gap", team: "both" });
  if (features.managerChangeDaysAgo != null && features.managerChangeDaysAgo <= config.managerChangeWindowDays) {
    add(config.managerChangePoints, "recent_manager_change", { kind: "manager_change_context", team: "both" });
  }
  if (
    (features.minRestDays != null && features.minRestDays <= config.congestion.maxRestDays) ||
    (features.maxMatchesLast14Days != null && features.maxMatchesLast14Days >= config.congestion.minMatchesLast14Days)
  ) {
    add(config.congestion.points, "congestion", { kind: "congestion_rotation", team: "both" });
  }
  if (features.isCup || features.isSecondLeg || features.neutralVenue) {
    add(config.competitionContextPoints, "competition_context", { kind: "competition_context", team: "both" });
  }
  if (features.promotedSide) add(config.promotedPoints, "promoted_side");
  if (features.unresolvedAvailability > 0) {
    add(config.unresolvedAvailabilityPoints, "unresolved_availability", { kind: "unresolved_availability", team: "both" });
  }

  const tier: ResearchTier =
    score >= config.tierMinScore.deep ? "deep" : score >= config.tierMinScore.standard ? "standard" : "minimal";
  return {
    fixtureId: features.fixtureId,
    features,
    score,
    reasons,
    tier,
    needs: needs.sort((a, b) => a.needId.localeCompare(b.needId)),
    budget: config.budgets[tier],
    engineVersion: TRIAGE_ENGINE_VERSION,
    config: configProvenance(config),
  };
}

/** Candidate values only; not approved and not derived from any outcome. */
export const CANDIDATE_TRIAGE_CONFIG: TriageConfig = {
  id: "research-v2-triage",
  version: "triage-v1",
  status: "candidate",
  statArm: "p_stat_elo_v1",
  disagreementBands: [
    { minBp: 800, points: 1 },
    { minBp: 1500, points: 2 },
  ],
  marketPoints: { standard: 0, thin: 1, stale: 2, missing: 2 },
  statUnavailablePoints: 2,
  managerChangeWindowDays: 30,
  managerChangePoints: 2,
  congestion: { maxRestDays: 3, minMatchesLast14Days: 4, points: 1 },
  competitionContextPoints: 1,
  promotedPoints: 1,
  unresolvedAvailabilityPoints: 2,
  tierMinScore: { standard: 2, deep: 4 },
  budgets: {
    minimal: { maxSearches: 2, maxVerifiedPages: 3 },
    standard: { maxSearches: 4, maxVerifiedPages: 6 },
    deep: { maxSearches: 8, maxVerifiedPages: 12 },
  },
};
