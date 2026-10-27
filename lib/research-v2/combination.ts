import type { ArmResult, BaseArmId, DeterministicBase, MarketQuality, StatArmId } from "./base";
import { linearPool, logarithmicPool, type ThreeWayProbabilities } from "./probability";
import { configProvenance, type ConfigProvenance, type VersionedConfig } from "./provenance";

/**
 * A market/stat combination arm. Weights are supplied by versioned config and
 * are candidates only: several arms run side by side in shadow and forward
 * evaluation (never the current round) decides between them later.
 */
export type CombinationCandidate = VersionedConfig &
  (
    | { kind: "market_only"; minMarketQuality: Exclude<MarketQuality, "stale" | "missing"> }
    | { kind: "stat_only"; statArm: StatArmId }
    | {
        kind: "linear_pool" | "log_pool";
        statArm: StatArmId;
        /** Weight on the market arm; the stat arm receives 1 - marketWeight. */
        marketWeight: number;
        minMarketQuality: Exclude<MarketQuality, "stale" | "missing">;
      }
  );

export type CombinationResult =
  | {
      candidateId: string;
      status: "available";
      probabilities: ThreeWayProbabilities;
      /** Arms this candidate consumed, for audit. */
      usedArms: BaseArmId[];
      config: ConfigProvenance;
    }
  | {
      candidateId: string;
      status: "unavailable";
      reason: string;
      config: ConfigProvenance;
    };

const QUALITY_RANK: Record<MarketQuality, number> = { missing: 0, stale: 1, thin: 2, standard: 3 };

export function assertCombinationCandidate(candidate: CombinationCandidate): void {
  if (candidate.kind === "linear_pool" || candidate.kind === "log_pool") {
    if (!Number.isFinite(candidate.marketWeight) || candidate.marketWeight < 0 || candidate.marketWeight > 1) {
      throw new Error(`Combination ${candidate.id}: marketWeight must be within [0, 1].`);
    }
  }
}

function marketInput(base: DeterministicBase, minimum: MarketQuality): { ok: true; arm: ArmResult & { status: "available" } } | { ok: false; reason: string } {
  const arm = base.arms.p_market_v1;
  if (arm.status !== "available") return { ok: false, reason: `market_${base.market.quality}` };
  if (QUALITY_RANK[base.market.quality] < QUALITY_RANK[minimum]) {
    return { ok: false, reason: `market_below_${minimum}:${base.market.quality}` };
  }
  return { ok: true, arm };
}

/**
 * Evaluates one candidate. `statTransform`, when given, rewrites the stat
 * input before pooling (used for stat-path research adjustments); it never
 * touches the market input.
 */
export function combineCandidate(
  base: DeterministicBase,
  candidate: CombinationCandidate,
  statTransform: (statArm: StatArmId, probabilities: ThreeWayProbabilities) => ThreeWayProbabilities = (_, p) => p,
): CombinationResult {
  assertCombinationCandidate(candidate);
  const config = configProvenance(candidate);
  const unavailableResult = (reason: string): CombinationResult => ({
    candidateId: candidate.id,
    status: "unavailable",
    reason,
    config,
  });

  if (candidate.kind === "market_only") {
    const market = marketInput(base, candidate.minMarketQuality);
    if (!market.ok) return unavailableResult(market.reason);
    return {
      candidateId: candidate.id,
      status: "available",
      probabilities: market.arm.probabilities,
      usedArms: ["p_market_v1"],
      config,
    };
  }

  const statArm = base.arms[candidate.statArm];
  if (statArm.status !== "available") return unavailableResult(`${candidate.statArm}_${statArm.reason}`);
  const stat = statTransform(candidate.statArm, statArm.probabilities);

  if (candidate.kind === "stat_only") {
    return { candidateId: candidate.id, status: "available", probabilities: stat, usedArms: [candidate.statArm], config };
  }

  const market = marketInput(base, candidate.minMarketQuality);
  if (!market.ok) return unavailableResult(market.reason);
  const parts = [
    { probabilities: market.arm.probabilities, weight: candidate.marketWeight },
    { probabilities: stat, weight: 1 - candidate.marketWeight },
  ];
  return {
    candidateId: candidate.id,
    status: "available",
    probabilities: candidate.kind === "linear_pool" ? linearPool(parts) : logarithmicPool(parts),
    usedArms: ["p_market_v1", candidate.statArm],
    config,
  };
}

type CandidateSpec = CombinationCandidate extends infer C
  ? C extends unknown
    ? Omit<C, "id" | "version" | "status">
    : never
  : never;

function candidate(id: string, spec: CandidateSpec): CombinationCandidate {
  return { id, version: "combination-v1", status: "candidate", ...spec } as CombinationCandidate;
}

/**
 * Candidate arms for forward shadow evaluation. The weights span a grid on
 * purpose; none of them is selected, and none was chosen from any outcome.
 */
export const CANDIDATE_COMBINATIONS: CombinationCandidate[] = [
  candidate("market_only", { kind: "market_only", minMarketQuality: "thin" }),
  candidate("stat_elo_only", { kind: "stat_only", statArm: "p_stat_elo_v1" }),
  candidate("stat_goal_model_only", { kind: "stat_only", statArm: "p_stat_goal_model_v1" }),
  ...[0.5, 0.65, 0.8].flatMap((weight) => {
    const tag = String(Math.round(weight * 100));
    return [
      candidate(`linear_market${tag}_elo`, { kind: "linear_pool", statArm: "p_stat_elo_v1", marketWeight: weight, minMarketQuality: "thin" }),
      candidate(`log_market${tag}_elo`, { kind: "log_pool", statArm: "p_stat_elo_v1", marketWeight: weight, minMarketQuality: "thin" }),
    ];
  }),
];
