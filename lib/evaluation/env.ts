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
