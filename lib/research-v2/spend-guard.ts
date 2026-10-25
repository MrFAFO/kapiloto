import { DEFAULT_CACHE_TTL, usdToMicros, type CacheTtl, type CallKind, type CostLedger, type ModelPricing, type PricingConfig } from "./cost-ledger";
import { configProvenance, type ConfigProvenance, type VersionedConfig } from "./provenance";

/**
 * Spend guard (spend-guard-v2, D-047, D-048). Before every model call — discovery,
 * a discovery retry, the entailment judge — the call's conservative projected
 * maximum must fit both the fixture's and the run's remaining budget, or the
 * call is blocked without any network attempt. After a call, its recorded cost
 * is charged; once a cap is reached, no further calls are allowed.
 *
 * This is an operational stop between calls, not a mathematical guarantee:
 * search-content tokens are not hard-capped by the API, so one call can still
 * exceed its own pre-call projection. The guard then stops every later call.
 */

export type SpendGuardConfig = VersionedConfig & {
  perFixtureCapUsd: number;
  runCapUsd: number;
  /** Projection assumptions (conservative; cache reads ignored, cache writes priced at the request's TTL rate). */
  assumedPromptTokens: number;
  assumedSearchContentTokensPerToolCall: number;
  assumedJudgePromptTokens: number;
  assumedTokensPerJudgeItem: number;
  /** Discovery input tokens that may be written to the prompt cache per call (first real run: 5,275). */
  assumedDiscoveryCacheWriteTokens: number;
};

/** Caps approved with the design; assumptions are candidates. */
export const CANDIDATE_SPEND_GUARD: SpendGuardConfig = {
  id: "research-v2-spend-guard",
  version: "spend-guard-v2",
  status: "candidate",
  perFixtureCapUsd: 0.75,
  runCapUsd: 3.0,
  assumedPromptTokens: 3_000,
  assumedSearchContentTokensPerToolCall: 12_000,
  assumedJudgePromptTokens: 1_500,
  assumedTokensPerJudgeItem: 1_000,
  assumedDiscoveryCacheWriteTokens: 12_000,
};

/** `cacheTtl` is the request's effective `prompt_cache_options.ttl`; omitted means the API default (30m). */
export type CallProjection =
  | { kind: "discovery"; fixtureRef: string; maxToolCalls: number; maxOutputTokens: number; cacheTtl?: CacheTtl }
  | { kind: "entailment"; fixtureRef: string; items: number; maxOutputTokens: number; cacheTtl?: CacheTtl };

export type GuardReason = "fixture_cap_would_be_exceeded" | "run_cap_would_be_exceeded" | "fixture_cap_reached" | "run_cap_reached" | "pricing_unavailable";

export type GuardDecision = {
  allowed: boolean;
  reason: GuardReason | null;
  kind: CallKind;
  fixtureRef: string;
  projectedMicros: number | null;
  fixtureChargedMicros: number;
  runChargedMicros: number;
  fixtureCapMicros: number;
  runCapMicros: number;
  config: ConfigProvenance;
};

const fullPriceInput = (tokens: number, pricing: ModelPricing) => (tokens * pricing.inputUsdPerMillion) / 1_000_000;
/** Input that may be written to the cache, at the request TTL's write rate (never below the input rate). */
const cacheWriteInput = (tokens: number, pricing: ModelPricing, ttl: CacheTtl) =>
  (tokens * Math.max(pricing.inputUsdPerMillion, ttl === "12h" ? pricing.cacheWrite12hUsdPerMillion : pricing.cacheWrite30mUsdPerMillion)) / 1_000_000;
const outputCost = (tokens: number, pricing: ModelPricing) => (tokens * pricing.outputUsdPerMillion) / 1_000_000;

/** Conservative maximum cost of one call (null when the model's price is unknown). */
export function projectCallMicros(projection: CallProjection, pricing: PricingConfig, config: SpendGuardConfig = CANDIDATE_SPEND_GUARD): number | null {
  const ttl = projection.cacheTtl ?? DEFAULT_CACHE_TTL;
  if (projection.kind === "discovery") {
    const inputTokens = config.assumedPromptTokens + projection.maxToolCalls * config.assumedSearchContentTokensPerToolCall;
    const writes = Math.min(inputTokens, config.assumedDiscoveryCacheWriteTokens);
    const usd =
      fullPriceInput(inputTokens - writes, pricing.sol) +
      cacheWriteInput(writes, pricing.sol, ttl) +
      outputCost(projection.maxOutputTokens, pricing.sol) +
      projection.maxToolCalls * pricing.webSearchUsdPerCall;
    return usdToMicros(usd);
  }
  if (!pricing.luna) return null;
  // The first real run wrote nearly all judge input to the cache, so all of it is projected at the write rate.
  const inputTokens = config.assumedJudgePromptTokens + projection.items * config.assumedTokensPerJudgeItem;
  return usdToMicros(cacheWriteInput(inputTokens, pricing.luna, ttl) + outputCost(projection.maxOutputTokens, pricing.luna));
}

/** May this call go out? Checked before every model call; never makes a network call itself. */
export function checkSpend(projection: CallProjection, ledger: CostLedger, config: SpendGuardConfig = CANDIDATE_SPEND_GUARD): GuardDecision {
  const fixtureCapMicros = usdToMicros(config.perFixtureCapUsd);
  const runCapMicros = usdToMicros(config.runCapUsd);
  const fixtureChargedMicros = ledger.chargedMicros(projection.fixtureRef);
  const runChargedMicros = ledger.chargedMicros();
  const projectedMicros = projectCallMicros(projection, ledger.pricing, config);
  const decision = (reason: GuardReason | null): GuardDecision => ({
    allowed: reason == null,
    reason,
    kind: projection.kind,
    fixtureRef: projection.fixtureRef,
    projectedMicros,
    fixtureChargedMicros,
    runChargedMicros,
    fixtureCapMicros,
    runCapMicros,
    config: configProvenance(config),
  });
  if (runChargedMicros >= runCapMicros) return decision("run_cap_reached");
  if (fixtureChargedMicros >= fixtureCapMicros) return decision("fixture_cap_reached");
  if (projectedMicros == null) return decision("pricing_unavailable");
  if (fixtureChargedMicros + projectedMicros > fixtureCapMicros) return decision("fixture_cap_would_be_exceeded");
  if (runChargedMicros + projectedMicros > runCapMicros) return decision("run_cap_would_be_exceeded");
  return decision(null);
}
