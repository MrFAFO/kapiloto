import {
  DEFAULT_CADENCE_CONFIG,
  FREE_PLAN_CADENCE_CONFIG,
  type CadenceConfig,
} from "./market-cadence";
import { DEFAULT_SHADOW_CYCLE_CONFIG, type ShadowCycleConfig } from "./shadow-cycle";

type Env = Record<string, string | undefined>;

/**
 * Both switches default to off: the scheduled route does nothing unless
 * `KAPILOTO_SHADOW_EVALUATION_ENABLED=true`, and spends no market-provider
 * requests unless `KAPILOTO_SHADOW_MARKET_CAPTURE_ENABLED=true` as well.
 */
export function shadowEvaluationFlags(env: Env): { enabled: boolean; marketCapture: boolean } {
  const on = (name: string) => env[name]?.trim().toLowerCase() === "true";
  const enabled = on("KAPILOTO_SHADOW_EVALUATION_ENABLED");
  return { enabled, marketCapture: enabled && on("KAPILOTO_SHADOW_MARKET_CAPTURE_ENABLED") };
}

/**
 * Recurring league-results ingestion (keeps p_stat history fresh). Off unless
 * shadow evaluation is enabled and `KAPILOTO_SHADOW_RESULTS_INGEST_ENABLED=true`.
 */
export function shadowResultsIngestEnabled(env: Env): boolean {
  return (
    shadowEvaluationFlags(env).enabled &&
    env.KAPILOTO_SHADOW_RESULTS_INGEST_ENABLED?.trim().toLowerCase() === "true"
  );
}

export type ShadowCadenceProfile = "free_plan" | "adaptive";

/**
 * `KAPILOTO_SHADOW_MARKET_CADENCE=adaptive` opts into the 7-day adaptive
 * cadence, which needs a paid API-Football plan. Anything else, including an
 * unset or misspelled value, selects the low-cost Free-plan cadence.
 */
export function shadowCadenceProfile(env: Env): ShadowCadenceProfile {
  return env.KAPILOTO_SHADOW_MARKET_CADENCE?.trim().toLowerCase() === "adaptive"
    ? "adaptive"
    : "free_plan";
}

const CADENCES: Record<ShadowCadenceProfile, CadenceConfig> = {
  free_plan: FREE_PLAN_CADENCE_CONFIG,
  adaptive: DEFAULT_CADENCE_CONFIG,
};

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

export function shadowCycleConfigFromEnv(env: Env): ShadowCycleConfig {
  const defaults = DEFAULT_SHADOW_CYCLE_CONFIG.budget;
  return {
    ...DEFAULT_SHADOW_CYCLE_CONFIG,
    cadence: CADENCES[shadowCadenceProfile(env)],
    budget: {
      ...defaults,
      maxRequestsPerRun: boundedInteger(
        env.KAPILOTO_SHADOW_MARKET_MAX_REQUESTS_PER_RUN,
        defaults.maxRequestsPerRun,
        0,
        200,
      ),
      maxRequestsPerDay: boundedInteger(
        env.KAPILOTO_SHADOW_MARKET_MAX_REQUESTS_PER_DAY,
        defaults.maxRequestsPerDay,
        0,
        100_000,
      ),
      providerReserve: boundedInteger(
        env.KAPILOTO_SHADOW_MARKET_PROVIDER_RESERVE,
        defaults.providerReserve,
        0,
        100_000,
      ),
    },
  };
}
