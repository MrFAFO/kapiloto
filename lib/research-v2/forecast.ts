import {
  admitAdjustments,
  applyAdjustments,
  type AdjustmentDecision,
  type AdjustmentPolicyConfig,
  type EffectSizeConfig,
  type ImpactProposal,
} from "./adjustments";
import {
  buildDeterministicBase,
  type DeterministicBase,
  type DeterministicBaseConfig,
  type DeterministicBaseInputs,
} from "./base";
import { combineCandidate, type CombinationCandidate, type CombinationResult } from "./combination";
import { assertNoForecastKeys } from "./evidence";
import { configProvenance, RESEARCH_V2_ENGINE_VERSION, sha256Canonical, type ConfigProvenance } from "./provenance";
import type { SourcePolicyConfig } from "./sources";
import type { VerificationReport } from "./verification";

export type ResearchV2Configs = {
  base: DeterministicBaseConfig;
  combinations: CombinationCandidate[];
  sourcePolicy: SourcePolicyConfig;
  adjustmentPolicy: AdjustmentPolicyConfig;
  effects: EffectSizeConfig;
};

/** Everything a forecast is computed from; storing this is enough to replay it. */
export type ResearchV2ForecastInputs = {
  base: DeterministicBaseInputs;
  /** Null before any research: the forecast is then the pre-research blend. */
  research: { verification: VerificationReport; proposals: ImpactProposal[] } | null;
};

export type CandidateForecast = {
  candidateId: string;
  /** Pre-research blend of the deterministic arms. */
  pre: CombinationResult;
  /** After admitted research adjustments (equal to pre when nothing applies). */
  post: CombinationResult;
  statPathShift: number;
  fullShift: number;
};

export type ResearchV2Forecast = {
  engineVersion: typeof RESEARCH_V2_ENGINE_VERSION;
  fixtureId: string;
  inputSha256: string;
  base: DeterministicBase;
  adjustments: AdjustmentDecision[];
  candidates: CandidateForecast[];
  provenance: {
    base: ConfigProvenance;
    combinations: ConfigProvenance[];
    sourcePolicy: ConfigProvenance;
    adjustmentPolicy: ConfigProvenance;
    effects: ConfigProvenance;
    verification: ConfigProvenance | null;
  };
};

/**
 * Stages 1 and 6 for one fixture: deterministic base, every candidate
 * combination before and after admitted research adjustments. A pure function
 * of `inputs` and `configs`.
 */
export function computeResearchV2Forecast(inputs: ResearchV2ForecastInputs, configs: ResearchV2Configs): ResearchV2Forecast {
  if (inputs.research) assertNoForecastKeys(inputs.research.proposals, "research.proposals");
  const base = buildDeterministicBase(inputs.base, configs.base);
  const adjustments = inputs.research
    ? admitAdjustments({
        proposals: inputs.research.proposals,
        evidence: inputs.research.verification.evidence,
        market: base.market,
        sourcePolicy: configs.sourcePolicy,
        policy: configs.adjustmentPolicy,
      }).decisions
    : [];

  const ids = new Set<string>();
  const candidates = configs.combinations.map((candidate): CandidateForecast => {
    if (ids.has(candidate.id)) throw new Error(`Duplicate combination candidate ${candidate.id}.`);
    ids.add(candidate.id);
    const pre = combineCandidate(base, candidate);
    let statPathShift = 0;
    const pooled = combineCandidate(base, candidate, (_, probabilities) => {
      const applied = applyAdjustments(probabilities, adjustments, ["stat_path"], configs.effects);
      statPathShift = applied.appliedShift;
      return applied.probabilities;
    });
    if (pooled.status !== "available") return { candidateId: candidate.id, pre, post: pooled, statPathShift: 0, fullShift: 0 };
    const full = applyAdjustments(pooled.probabilities, adjustments, ["full"], configs.effects);
    return {
      candidateId: candidate.id,
      pre,
      post: { ...pooled, probabilities: full.probabilities },
      statPathShift,
      fullShift: full.appliedShift,
    };
  });

  return {
    engineVersion: RESEARCH_V2_ENGINE_VERSION,
    fixtureId: inputs.base.fixture.fixtureId,
    inputSha256: sha256Canonical(inputs),
    base,
    adjustments,
    candidates,
    provenance: {
      base: configProvenance(configs.base),
      combinations: configs.combinations.map(configProvenance),
      sourcePolicy: configProvenance(configs.sourcePolicy),
      adjustmentPolicy: configProvenance(configs.adjustmentPolicy),
      effects: configProvenance(configs.effects),
      verification: inputs.research?.verification.config ?? null,
    },
  };
}

/** Flat list of every arm a forecast produced, for forward evaluation storage. */
export function forecastEvaluationArms(forecast: ResearchV2Forecast): Array<{
  arm: string;
  configSha256: string | null;
  status: "available" | "unavailable";
  probabilities: { home: number; draw: number; away: number } | null;
  reason: string | null;
}> {
  const baseArms = Object.values(forecast.base.arms)
    .sort((a, b) => a.arm.localeCompare(b.arm))
    .map((arm) => ({
      arm: arm.arm,
      configSha256: forecast.base.config.sha256,
      status: arm.status,
      probabilities: arm.status === "available" ? arm.probabilities : null,
      reason: arm.status === "available" ? null : arm.reason,
    }));
  const combined = forecast.candidates.flatMap((candidate) =>
    (["pre", "post"] as const).map((stage) => {
      const result = candidate[stage];
      return {
        arm: `${candidate.candidateId}:${stage === "pre" ? "pre_research" : "post_research"}`,
        configSha256: result.config.sha256,
        status: result.status,
        probabilities: result.status === "available" ? result.probabilities : null,
        reason: result.status === "available" ? null : result.reason,
      };
    }),
  );
  return [...baseArms, ...combined];
}
