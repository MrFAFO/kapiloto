import {
  CLAIM_KINDS_V2,
  type ClaimKindV2,
  type DiscoveryPlanSummary,
  type Side,
} from "./discovery-contract";
import { configProvenance, type ConfigProvenance, type VersionedConfig } from "./provenance";
import type {
  InformationNeedKind,
  ResearchTier,
  TriageConfig,
  TriageContext,
  TriageDecision,
} from "./triage";

/**
 * Deterministic discovery planner (discovery-plan-v1). Research is driven only
 * by triage needs; each planned need records the sides it actually covers and
 * why, the claim kinds Sol may report for it and neutral search hints. The
 * triage decision (needs, score, tier) is never changed.
 */

export const DISCOVERY_PLAN_VERSION = "discovery-plan-v1" as const;

export type DiscoveryBudgetTier = {
  /** Hard cap on every built-in tool call (search, open_page, find_in_page): the API's `max_tool_calls`. */
  maxWebToolCalls: number;
  /** Intended `search` actions; recorded and audited, not API-enforced. */
  targetSearchActions: number;
  /** Server-side page fetches by the safe fetcher. */
  maxFetchedPages: number;
  maxClaims: number;
  /** Claim × citation pairs sent to the entailment judge. */
  maxJudgeItems: number;
  maxOutputTokens: number;
};

export type DiscoveryBudgetConfig = VersionedConfig & { tiers: Record<ResearchTier, DiscoveryBudgetTier> };

/** Candidate values only; not approved and not derived from any outcome. */
export const CANDIDATE_DISCOVERY_BUDGET: DiscoveryBudgetConfig = {
  id: "research-v2-discovery-budget",
  version: "discovery-budget-v2",
  status: "candidate",
  tiers: {
    minimal: { maxWebToolCalls: 6, targetSearchActions: 2, maxFetchedPages: 3, maxClaims: 6, maxJudgeItems: 6, maxOutputTokens: 8_000 },
    standard: { maxWebToolCalls: 10, targetSearchActions: 4, maxFetchedPages: 6, maxClaims: 10, maxJudgeItems: 12, maxOutputTokens: 10_000 },
    deep: { maxWebToolCalls: 18, targetSearchActions: 8, maxFetchedPages: 12, maxClaims: 16, maxJudgeItems: 20, maxOutputTokens: 12_000 },
  },
};

const AVAILABILITY_KINDS: ClaimKindV2[] = ["absence", "suspension", "doubtful", "expected_return", "lineup_confirmed"];

export type DiscoveryPlanConfig = VersionedConfig & {
  allowedClaimKinds: Record<InformationNeedKind, ClaimKindV2[]>;
  /** Neutral search hints; `{team}`, `{home}`, `{away}` and `{competition}` are filled per fixture. */
  searchHints: Record<InformationNeedKind, string[]>;
  /** Source languages per competition key; English is always added. */
  languagesByCompetition: Record<string, string[]>;
};

export const CANDIDATE_DISCOVERY_PLAN_CONFIG: DiscoveryPlanConfig = {
  id: "research-v2-discovery-plan",
  version: DISCOVERY_PLAN_VERSION,
  status: "candidate",
  allowedClaimKinds: {
    availability_rotation_check: AVAILABILITY_KINDS,
    congestion_rotation: ["rotation_statement", ...AVAILABILITY_KINDS],
    stat_cold_start_context: [...AVAILABILITY_KINDS, "manager_change", "squad_change"],
    market_stat_gap: [...CLAIM_KINDS_V2],
    manager_change_context: ["manager_change"],
    coverage_gap: [...AVAILABILITY_KINDS, "schedule_disruption"],
    unresolved_availability: AVAILABILITY_KINDS,
    competition_context: ["other_context"],
  },
  searchHints: {
    availability_rotation_check: ["{team} team news injuries suspensions before {opponent}"],
    congestion_rotation: ["{team} rotation fitness after recent fixtures"],
    stat_cold_start_context: ["{team} squad changes this season"],
    market_stat_gap: ["{home} {away} team news"],
    manager_change_context: ["{team} manager"],
    coverage_gap: ["{home} {away} team news"],
    unresolved_availability: ["{team} player fitness update"],
    competition_context: ["{home} {away} {competition} fixture context"],
  },
  languagesByCompetition: {
    "sportmonks:8": ["en"],
    "sportmonks:564": ["es"],
    "sportmonks:372": ["he"],
  },
};

export type PlannedNeed = {
  needId: string;
  kind: InformationNeedKind;
  /** Sides this need actually covers, recorded explicitly (never an ambiguous "both"). */
  scope: Side[];
  scopeReason: string;
  allowedClaimKinds: ClaimKindV2[];
  searchHints: string[];
};

export type DiscoveryPlan = {
  version: typeof DISCOVERY_PLAN_VERSION;
  fixtureRef: string;
  tier: ResearchTier;
  budget: DiscoveryBudgetTier;
  languages: string[];
  needs: PlannedNeed[];
  config: { plan: ConfigProvenance; budget: ConfigProvenance; triage: ConfigProvenance };
};

const SIDES: Side[] = ["home", "away"];

function congestionScope(context: TriageContext, triage: TriageConfig): { scope: Side[]; reason: string } {
  const { maxRestDays, minMatchesLast14Days } = triage.congestion;
  const describe = (side: Side) => `${side} rest ${context.restDays[side] ?? "unknown"}d, ${context.matchesLast14Days[side] ?? "unknown"} matches/14d`;
  const congested = SIDES.filter((side) => {
    const rest = context.restDays[side];
    const recent = context.matchesLast14Days[side];
    return (rest != null && rest <= maxRestDays) || (recent != null && recent >= minMatchesLast14Days);
  });
  const rule = `rest ≤ ${maxRestDays}d or ≥ ${minMatchesLast14Days} matches/14d`;
  if (congested.length === 0) return { scope: [...SIDES], reason: `no side meets ${rule} individually; ${SIDES.map(describe).join("; ")}` };
  return { scope: congested, reason: `${rule}: ${SIDES.map(describe).join("; ")}` };
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/**
 * One plan per fixture from its triage decision. `names` are search names
 * (first entry preferred); `fixtureRef` is the opaque reference given to Sol.
 */
export function buildDiscoveryPlan(
  input: {
    fixtureRef: string;
    triage: TriageDecision;
    triageConfig: TriageConfig;
    context: TriageContext;
    competitionKey: string | null;
    competitionName: string;
    names: { home: string; away: string };
  },
  configs: { plan: DiscoveryPlanConfig; budget: DiscoveryBudgetConfig } = {
    plan: CANDIDATE_DISCOVERY_PLAN_CONFIG,
    budget: CANDIDATE_DISCOVERY_BUDGET,
  },
): DiscoveryPlan {
  const { plan: planConfig, budget } = configs;
  const needs = input.triage.needs.map((need): PlannedNeed => {
    let scope: Side[];
    let scopeReason: string;
    if (need.team !== "both") {
      scope = [need.team];
      scopeReason = "side-specific need";
    } else if (need.kind === "congestion_rotation") {
      ({ scope, reason: scopeReason } = congestionScope(input.context, input.triageConfig));
    } else {
      scope = [...SIDES];
      scopeReason = "need covers both sides";
    }
    const hints = planConfig.searchHints[need.kind].flatMap((template) =>
      template.includes("{team}")
        ? scope.map((side) =>
            fill(template, {
              team: input.names[side],
              opponent: input.names[side === "home" ? "away" : "home"],
              home: input.names.home,
              away: input.names.away,
              competition: input.competitionName,
            }),
          )
        : [fill(template, { home: input.names.home, away: input.names.away, competition: input.competitionName })],
    );
    return {
      needId: need.needId,
      kind: need.kind,
      scope,
      scopeReason,
      allowedClaimKinds: [...planConfig.allowedClaimKinds[need.kind]],
      searchHints: [...new Set(hints)],
    };
  });
  const sourceLanguages = (input.competitionKey && planConfig.languagesByCompetition[input.competitionKey]) || [];
  return {
    version: DISCOVERY_PLAN_VERSION,
    fixtureRef: input.fixtureRef,
    tier: input.triage.tier,
    budget: { ...budget.tiers[input.triage.tier] },
    languages: [...new Set([...sourceLanguages, "en"])],
    needs,
    config: { plan: configProvenance(planConfig), budget: configProvenance(budget), triage: input.triage.config },
  };
}

/** The part of a plan the discovery parser enforces. */
export function planSummary(plan: DiscoveryPlan): DiscoveryPlanSummary {
  return {
    fixtureRef: plan.fixtureRef,
    maxClaims: plan.budget.maxClaims,
    needs: plan.needs.map((need) => ({ needId: need.needId, scope: need.scope, allowedClaimKinds: need.allowedClaimKinds })),
  };
}
