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

export const TRIAGE_ENGINE_VERSION = "kapiloto-research-v2-triage-engine-v2" as const;

/** Whether a side's manager situation was checked; `daysAgo` null means checked and no change found. */
export type ManagerChangeSignal = { status: "checked"; daysAgo: number | null } | { status: "unknown" };

type Sides<T> = { home: T; away: T };

/**
 * Structured context from data feeds. It never contains an outcome. Every
 * signal distinguishes "unknown" (never checked) from "checked, nothing found".
 */
export type TriageContext = {
  managerChange: Sides<ManagerChangeSignal>;
  restDays: Sides<number | null>;
  matchesLast14Days: Sides<number | null>;
  competition: { isCup: boolean; isSecondLeg: boolean };
  /** Key-player statuses left unresolved by an earlier pass; null when not assessed. */
  unresolvedAvailability: number | null;
};

/** Facts derived from stored history (league membership), not from the context feed. */
export type TriageHistoryFacts = {
  newToCompetition: Sides<boolean | null>;
};

export type TriageDataGap =
  | `manager_change_unknown:${"home" | "away"}`
  | `new_to_competition_unknown:${"home" | "away"}`
  | `rest_unknown:${"home" | "away"}`
  | `matches_14d_unknown:${"home" | "away"}`
  | `stat_team_matches_unknown:${"home" | "away"}`
  | "availability_unassessed";

export type TriageFeatures = {
  fixtureId: string;
  marketQuality: MarketQuality;
  statArm: StatArmId;
  statAvailable: boolean;
  /** Market vs stat disagreement in basis points, null when either is missing. */
  disagreementBp: number | null;
  /** Rated in-competition matches behind each side's stat rating (null when the stat arm is unavailable). */
  statTeamMatches: Sides<number | null>;
  /** Most recent known manager change in days (checked sides only). */
  managerChangeDaysAgo: number | null;
  minRestDays: number | null;
  maxMatchesLast14Days: number | null;
  neutralVenue: boolean;
  isCup: boolean;
  isSecondLeg: boolean;
  newToCompetition: Sides<boolean | null>;
  unresolvedAvailability: number | null;
  /** Inputs that are unknown rather than checked; never read as "no signal". */
  dataGaps: TriageDataGap[];
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
  "stat_cold_start_context",
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
  newToCompetitionPoints: number;
  unresolvedAvailabilityPoints: number;
  /**
   * A stat side is cold-start with fewer than `minTeamMatches` rated matches or
   * when it is new to the competition this season. Market/stat disagreement is
   * then not scored, and discovery is told the stat arm is immature.
   */
  statColdStart: { minTeamMatches: number; points: number };
  /** Points per data gap (unknown input). */
  dataGapPoints: number;
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
  /** null: maturity unknown (no match count and no independent new-to-competition signal). */
  statColdStart: Sides<boolean | null>;
  engineVersion: typeof TRIAGE_ENGINE_VERSION;
  config: ConfigProvenance;
};

const minOf = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.min(a, b));
const maxOf = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.max(a, b));

const SIDES = ["home", "away"] as const;

const numericDetail = (value: number | string | null | undefined) => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function extractTriageFeatures(
  base: DeterministicBase,
  context: TriageContext,
  options: { statArm: StatArmId; neutralVenue: boolean; history: TriageHistoryFacts },
): TriageFeatures {
  const stat = base.arms[options.statArm];
  const market = base.arms.p_market_v1;
  const statTeamMatches = {
    home: stat.status === "available" ? numericDetail(stat.detail.homeMatches) : null,
    away: stat.status === "available" ? numericDetail(stat.detail.awayMatches) : null,
  };
  const checkedChanges = SIDES.map((side) => context.managerChange[side])
    .map((signal) => (signal.status === "checked" ? signal.daysAgo : null))
    .filter((days): days is number => days != null);

  const dataGaps: TriageDataGap[] = [];
  for (const side of SIDES) {
    if (context.managerChange[side].status === "unknown") dataGaps.push(`manager_change_unknown:${side}`);
    if (options.history.newToCompetition[side] == null) dataGaps.push(`new_to_competition_unknown:${side}`);
    if (context.restDays[side] == null) dataGaps.push(`rest_unknown:${side}`);
    if (context.matchesLast14Days[side] == null) dataGaps.push(`matches_14d_unknown:${side}`);
    // Only an available stat arm has counts to miss; an unavailable one is scored as such.
    if (stat.status === "available" && statTeamMatches[side] == null) dataGaps.push(`stat_team_matches_unknown:${side}`);
  }
  if (context.unresolvedAvailability == null) dataGaps.push("availability_unassessed");

  return {
    fixtureId: base.fixtureId,
    marketQuality: base.market.quality,
    statArm: options.statArm,
    statAvailable: stat.status === "available",
    disagreementBp:
      stat.status === "available" && market.status === "available"
        ? maxDisagreementBp(stat.probabilities, market.probabilities)
        : null,
    statTeamMatches,
    managerChangeDaysAgo: checkedChanges.length > 0 ? Math.min(...checkedChanges) : null,
    minRestDays: minOf(context.restDays.home, context.restDays.away),
    maxMatchesLast14Days: maxOf(context.matchesLast14Days.home, context.matchesLast14Days.away),
    neutralVenue: options.neutralVenue,
    isCup: context.competition.isCup,
    isSecondLeg: context.competition.isSecondLeg,
    newToCompetition: { ...options.history.newToCompetition },
    unresolvedAvailability: context.unresolvedAvailability,
    dataGaps: dataGaps.sort(),
  };
}

/**
 * Cold start is judged only for an available stat arm (an unavailable one is
 * scored as such). New to the competition is cold whatever the count; without
 * that signal, a missing count leaves maturity unknown (null), never assumed.
 */
function statColdStartSides(features: TriageFeatures, config: TriageConfig): Sides<boolean | null> {
  const cold = (side: "home" | "away"): boolean | null => {
    if (!features.statAvailable) return false;
    if (features.newToCompetition[side] === true) return true;
    const matches = features.statTeamMatches[side];
    return matches == null ? null : matches < config.statColdStart.minTeamMatches;
  };
  return { home: cold("home"), away: cold("away") };
}

export function assignTriage(features: TriageFeatures, config: TriageConfig): TriageDecision {
  let score = 0;
  const reasons: string[] = [];
  const needs: InformationNeed[] = [
    { needId: "availability_rotation_check:home", kind: "availability_rotation_check", team: "home" },
    { needId: "availability_rotation_check:away", kind: "availability_rotation_check", team: "away" },
  ];
  const addNeed = (need: Omit<InformationNeed, "needId">) => {
    if (!needs.some((existing) => existing.kind === need.kind && existing.team === need.team)) {
      needs.push({ ...need, needId: `${need.kind}:${need.team}` });
    }
  };
  const add = (points: number, reason: string, need?: Omit<InformationNeed, "needId">) => {
    if (points <= 0) return;
    score += points;
    reasons.push(reason);
    if (need) addNeed(need);
  };

  const coldStart = statColdStartSides(features, config);
  const coldSides = SIDES.filter((side) => coldStart[side] === true);
  if (features.disagreementBp != null) {
    if (coldSides.length > 0) {
      // An immature rating explains part of any gap, so it is not scored as disagreement.
      reasons.push("market_stat_disagreement_not_scored:stat_cold_start");
    } else {
      const band = [...config.disagreementBands].sort((a, b) => b.minBp - a.minBp).find((item) => features.disagreementBp! >= item.minBp);
      if (band) add(band.points, `market_stat_disagreement_${band.minBp}bp`, { kind: "market_stat_gap", team: "both" });
    }
  }
  for (const side of coldSides) {
    // Always surfaced to discovery, whatever its points.
    score += Math.max(0, config.statColdStart.points);
    reasons.push(`stat_cold_start:${side}`);
    addNeed({ kind: "stat_cold_start_context", team: side });
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
  if (features.newToCompetition.home === true || features.newToCompetition.away === true) {
    add(config.newToCompetitionPoints, "new_to_competition_side");
  }
  if (features.unresolvedAvailability != null && features.unresolvedAvailability > 0) {
    add(config.unresolvedAvailabilityPoints, "unresolved_availability", { kind: "unresolved_availability", team: "both" });
  }
  // Gaps are recorded, never researched by default: a need requires an actual signal.
  for (const gap of features.dataGaps) {
    score += Math.max(0, config.dataGapPoints);
    reasons.push(`data_gap:${gap}`);
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
    statColdStart: coldStart,
    engineVersion: TRIAGE_ENGINE_VERSION,
    config: configProvenance(config),
  };
}

/** Candidate values only; not approved and not derived from any outcome. */
export const CANDIDATE_TRIAGE_CONFIG: TriageConfig = {
  id: "research-v2-triage",
  version: "triage-v2",
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
  newToCompetitionPoints: 1,
  unresolvedAvailabilityPoints: 2,
  statColdStart: { minTeamMatches: 20, points: 0 },
  dataGapPoints: 0,
  tierMinScore: { standard: 2, deep: 4 },
  budgets: {
    minimal: { maxSearches: 2, maxVerifiedPages: 3 },
    standard: { maxSearches: 4, maxVerifiedPages: 6 },
    deep: { maxSearches: 8, maxVerifiedPages: 12 },
  },
};
