import { configProvenance, type ConfigProvenance, type VersionedConfig } from "./provenance";

/**
 * Research v2 pricing (pricing-v2) and cost ledger (cost-ledger-v2), D-047,
 * D-048. Costs are integer micro-USD. Accounting uses the usage each response
 * actually reports and every recorded web-search tool call (all billable unless
 * reported otherwise), never the planned search targets. Missing or partial
 * usage is recorded as such and charged at the call's pre-call projection,
 * never silently as zero.
 *
 * Cache writes (`cache_write_tokens`, a subset of input tokens) are never
 * priced as ordinary input. Their lifetime is established in this order:
 * the usage breakdown `cache_write_tokens_details` (`ttl_30m_tokens`,
 * `ttl_12h_tokens`, which must reconcile with the total); else the TTL the
 * response reports it applied (`prompt_cache_options.ttl`); else the request's
 * effective `prompt_cache_options.ttl` (the documented default is `30m`; `12h`
 * only when the request selected it). Only when none of these is known is the
 * write charged at the 12-hour rate and the cost marked uncertain. The
 * deprecated `prompt_cache_retention` never decides the price.
 */

/** Prompt-cache write lifetime (`prompt_cache_options.ttl`); `30m` is the API default. */
export type CacheTtl = "30m" | "12h";
export const DEFAULT_CACHE_TTL: CacheTtl = "30m";
export const isCacheTtl = (value: unknown): value is CacheTtl => value === "30m" || value === "12h";

export type ModelPricing = {
  model: string;
  processingTier: "standard";
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  cacheWrite30mUsdPerMillion: number;
  cacheWrite12hUsdPerMillion: number;
  outputUsdPerMillion: number;
  /** When this model's rates were checked, and against what. */
  checkedOn: string;
  source: string;
};

export type PricingConfig = VersionedConfig & {
  currency: "USD";
  /** Latest date any rate in this config was checked. */
  checkedOn: string;
  /** Overall provenance note; each model also carries its own. */
  source: string;
  sol: ModelPricing;
  /** Null when a judge model's rates are unknown: judge calls are then blocked (pricing_unavailable). */
  luna: ModelPricing | null;
  /** Per billable web-search tool call; search-content tokens are charged at the Sol token rates. */
  webSearchUsdPerCall: number;
};

/** Candidate rates (Standard processing tier, short context). */
export const CANDIDATE_PRICING: PricingConfig = {
  id: "research-v2-pricing",
  version: "pricing-v2",
  status: "candidate",
  currency: "USD",
  checkedOn: "2026-10-25",
  source:
    "Official OpenAI API pricing (Standard tier, short context), supplied by the project owner on 2026-10-25, including 30-minute and 12-hour cache-write rates. Web search: $10 per 1,000 tool calls, with search-content tokens billed at the calling model's token rates.",
  sol: {
    model: "gpt-6.1-sol",
    processingTier: "standard",
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.1,
    cacheWrite30mUsdPerMillion: 2.5,
    cacheWrite12hUsdPerMillion: 5,
    outputUsdPerMillion: 10,
    checkedOn: "2026-10-25",
    source: "Official OpenAI Standard pricing, short context: input $2.00, cached input $0.10, 30-minute cache write $2.50, 12-hour cache write $5.00, output $10.00 per 1M tokens.",
  },
  luna: {
    model: "gpt-6-luna",
    processingTier: "standard",
    inputUsdPerMillion: 0.1,
    cachedInputUsdPerMillion: 0.01,
    cacheWrite30mUsdPerMillion: 0.125,
    cacheWrite12hUsdPerMillion: 0.25,
    outputUsdPerMillion: 0.5,
    checkedOn: "2026-10-25",
    source: "Official OpenAI Standard pricing, short context: input $0.10, cached input $0.01, 30-minute cache write $0.125, 12-hour cache write $0.25, output $0.50 per 1M tokens.",
  },
  webSearchUsdPerCall: 0.01,
};

export const MICROS_PER_USD = 1_000_000;
export const usdToMicros = (usd: number) => Math.round(usd * MICROS_PER_USD);

export type RecordedUsage = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  /** Input tokens written to the prompt cache (a subset of input tokens). */
  cacheWriteTokens: number | null;
  /**
   * Fields below are absent in artifacts captured before cost-ledger-v2.
   * `cache_write_tokens_details` was present in the response (even if empty).
   */
  cacheWriteDetailsReported?: boolean;
  /** `cache_write_tokens_details.ttl_30m_tokens` / `ttl_12h_tokens`, when reported. */
  cacheWriteTtl30mTokens?: number | null;
  cacheWriteTtl12hTokens?: number | null;
  /** The `prompt_cache_options.ttl` the response reports it applied, as reported. */
  responseCacheTtl?: string | null;
};

/**
 * How the lifetime of cache-write tokens was established: none written; the
 * usage TTL breakdown (reconciled, or not and then charged conservatively);
 * the TTL the response reports; the request's effective TTL; unknown (12-hour
 * rate, uncertain); or writes not reported at all (all uncached input at the
 * 12-hour rate, uncertain).
 */
export type CacheWriteBasis = "none" | "usage_detail" | "usage_detail_unreconciled" | "response_ttl" | "request_ttl" | "unknown_ttl" | "unreported";

export type UsageStatus = "complete" | "partial" | "missing";

export function usageStatus(usage: RecordedUsage | null): UsageStatus {
  if (!usage) return "missing";
  const required = [usage.inputTokens, usage.outputTokens];
  if (required.every((value) => value == null)) return "missing";
  return required.every((value) => value != null) && usage.cachedInputTokens != null ? "complete" : "partial";
}

export type CacheWriteSplit = { basis: CacheWriteBasis; ttl30mTokens: number; ttl12hTokens: number; uncertain: boolean };

/**
 * Splits cache-write tokens by lifetime. `requestTtl` is the request's
 * effective `prompt_cache_options.ttl` (null when it is not known).
 */
export function cacheWriteSplit(usage: RecordedUsage, requestTtl: CacheTtl | null): CacheWriteSplit {
  const total = usage.cacheWriteTokens;
  const t30 = usage.cacheWriteTtl30mTokens ?? null;
  const t12 = usage.cacheWriteTtl12hTokens ?? null;
  if (usage.cacheWriteDetailsReported || t30 != null || t12 != null) {
    const ttl30mTokens = Math.max(0, t30 ?? 0);
    const reported12h = Math.max(0, t12 ?? 0);
    if (total != null && ttl30mTokens + reported12h === total) return { basis: "usage_detail", ttl30mTokens, ttl12hTokens: reported12h, uncertain: false };
    // Not reconciled: keep the reported split and charge any unexplained remainder at the 12-hour rate.
    const remainder = Math.max(0, (total ?? 0) - ttl30mTokens - reported12h);
    return { basis: "usage_detail_unreconciled", ttl30mTokens, ttl12hTokens: reported12h + remainder, uncertain: true };
  }
  if (total == null) return { basis: "unreported", ttl30mTokens: 0, ttl12hTokens: 0, uncertain: true };
  if (total <= 0) return { basis: "none", ttl30mTokens: 0, ttl12hTokens: 0, uncertain: false };
  const responseTtl = isCacheTtl(usage.responseCacheTtl) ? usage.responseCacheTtl : null;
  const ttl = responseTtl ?? requestTtl;
  if (ttl == null) return { basis: "unknown_ttl", ttl30mTokens: 0, ttl12hTokens: total, uncertain: true };
  return { basis: responseTtl ? "response_ttl" : "request_ttl", ttl30mTokens: ttl === "30m" ? total : 0, ttl12hTokens: ttl === "12h" ? total : 0, uncertain: false };
}

/** Token cost from complete usage (null when usage is not complete), with how cache writes were priced. */
export function tokenCost(
  usage: RecordedUsage | null,
  pricing: ModelPricing,
  requestTtl: CacheTtl | null = null,
): { micros: number | null; split: CacheWriteSplit | null; uncertain: boolean } {
  if (!usage || usageStatus(usage) !== "complete") return { micros: null, split: null, uncertain: true };
  const input = Math.max(0, usage.inputTokens as number);
  const cached = Math.min(input, Math.max(0, usage.cachedInputTokens as number));
  const output = Math.max(0, usage.outputTokens as number);
  const uncached = input - cached;
  const reported = cacheWriteSplit(usage, requestTtl);
  // Writes are a subset of uncached input: unreported writes charge all of it at the 12-hour rate; an over-report
  // is trimmed from the cheaper lifetime first and marked uncertain.
  const w12 = reported.basis === "unreported" ? uncached : Math.min(uncached, reported.ttl12hTokens);
  const w30 = Math.min(uncached - w12, reported.ttl30mTokens);
  const trimmed = w12 + w30 < reported.ttl12hTokens + reported.ttl30mTokens;
  const split: CacheWriteSplit = { ...reported, ttl30mTokens: w30, ttl12hTokens: w12, uncertain: reported.uncertain || trimmed };
  const usd =
    ((uncached - w30 - w12) * pricing.inputUsdPerMillion +
      cached * pricing.cachedInputUsdPerMillion +
      w30 * pricing.cacheWrite30mUsdPerMillion +
      w12 * pricing.cacheWrite12hUsdPerMillion +
      output * pricing.outputUsdPerMillion) /
    1_000_000;
  return { micros: usdToMicros(usd), split, uncertain: split.uncertain };
}

export function tokenCostMicros(usage: RecordedUsage | null, pricing: ModelPricing, requestTtl: CacheTtl | null = null): number | null {
  return tokenCost(usage, pricing, requestTtl).micros;
}

export type CallKind = "discovery" | "entailment";

export type CallCost = {
  kind: CallKind;
  fixtureRef: string;
  callId: string;
  model: string;
  usage: RecordedUsage | null;
  usageStatus: UsageStatus;
  billableWebSearchCalls: number;
  webSearchFeeMicros: number;
  tokenCostMicros: number | null;
  /** The request's effective `prompt_cache_options.ttl` (null when not known). */
  cacheTtl: CacheTtl | null;
  /** How cache-write tokens were split by lifetime and priced (null when usage is incomplete). */
  cacheWrites: CacheWriteSplit | null;
  /** Usage incomplete, or cache-write lifetime not established (charged conservatively). */
  costUncertain: boolean;
  /** Known cost: web-search fees plus token cost when usage is complete. */
  knownMicros: number;
  /** What the guard charges: known cost, or the pre-call projection when usage is incomplete. */
  chargedMicros: number;
};

/** Cost of one completed model call from what the response actually reported. */
export function callCost(input: {
  kind: CallKind;
  fixtureRef: string;
  callId: string;
  model: string;
  usage: RecordedUsage | null;
  billableWebSearchCalls: number;
  projectedMicros: number;
  pricing: PricingConfig;
  /** The request's effective cache TTL; omitted or null means it is not known. */
  cacheTtl?: CacheTtl | null;
}): CallCost {
  const modelPricing = input.kind === "discovery" ? input.pricing.sol : input.pricing.luna;
  const status = usageStatus(input.usage);
  const webSearchFeeMicros = input.billableWebSearchCalls * usdToMicros(input.pricing.webSearchUsdPerCall);
  const cacheTtl = input.cacheTtl ?? null;
  const priced = modelPricing ? tokenCost(input.usage, modelPricing, cacheTtl) : { micros: null, split: null, uncertain: true };
  const tokens = priced.micros;
  const knownMicros = webSearchFeeMicros + (tokens ?? 0);
  return {
    kind: input.kind,
    fixtureRef: input.fixtureRef,
    callId: input.callId,
    model: input.model,
    usage: input.usage,
    usageStatus: status,
    billableWebSearchCalls: input.billableWebSearchCalls,
    webSearchFeeMicros,
    tokenCostMicros: tokens,
    cacheTtl,
    cacheWrites: priced.split,
    costUncertain: status !== "complete" || priced.uncertain,
    knownMicros,
    chargedMicros: tokens == null ? Math.max(knownMicros, input.projectedMicros) : knownMicros,
  };
}

export type FixtureTotals = {
  solInputTokens: number;
  solCachedInputTokens: number;
  solCacheWriteTokens: number;
  solOutputTokens: number;
  lunaInputTokens: number;
  lunaCachedInputTokens: number;
  lunaCacheWriteTokens: number;
  lunaOutputTokens: number;
  billableWebSearchCalls: number;
  webSearchFeeMicros: number;
  serverFetches: number;
  serverFetchBytes: number;
  knownMicros: number;
  chargedMicros: number;
  /** True when any call's usage was missing or partial, or its cache-write lifetime was not established. */
  costUncertain: boolean;
};

export type LedgerSnapshot = {
  /** cost-ledger-v1 appears only in artifacts captured before pricing-v2. */
  version: "cost-ledger-v1" | "cost-ledger-v2";
  pricing: ConfigProvenance & { currency: string; checkedOn: string; source: string };
  calls: CallCost[];
  fetches: Array<{ fixtureRef: string; count: number; bytes: number }>;
  fixtures: Record<string, FixtureTotals>;
  run: FixtureTotals;
};

const emptyTotals = (): FixtureTotals => ({
  solInputTokens: 0,
  solCachedInputTokens: 0,
  solCacheWriteTokens: 0,
  solOutputTokens: 0,
  lunaInputTokens: 0,
  lunaCachedInputTokens: 0,
  lunaCacheWriteTokens: 0,
  lunaOutputTokens: 0,
  billableWebSearchCalls: 0,
  webSearchFeeMicros: 0,
  serverFetches: 0,
  serverFetchBytes: 0,
  knownMicros: 0,
  chargedMicros: 0,
  costUncertain: false,
});

/** Append-only ledger for one run. */
export class CostLedger {
  private readonly calls: CallCost[] = [];
  private readonly fetches = new Map<string, { count: number; bytes: number }>();

  constructor(readonly pricing: PricingConfig = CANDIDATE_PRICING) {}

  recordCall(cost: CallCost): void {
    this.calls.push(cost);
  }

  recordFetch(fixtureRef: string, bytes: number): void {
    const current = this.fetches.get(fixtureRef) ?? { count: 0, bytes: 0 };
    this.fetches.set(fixtureRef, { count: current.count + 1, bytes: current.bytes + Math.max(0, bytes) });
  }

  chargedMicros(fixtureRef?: string): number {
    return this.calls.filter((call) => fixtureRef == null || call.fixtureRef === fixtureRef).reduce((sum, call) => sum + call.chargedMicros, 0);
  }

  snapshot(): LedgerSnapshot {
    const fixtures: Record<string, FixtureTotals> = {};
    const run = emptyTotals();
    const add = (totals: FixtureTotals, call: CallCost) => {
      const usage = call.usage;
      if (call.kind === "discovery") {
        totals.solInputTokens += usage?.inputTokens ?? 0;
        totals.solCachedInputTokens += usage?.cachedInputTokens ?? 0;
        totals.solCacheWriteTokens += usage?.cacheWriteTokens ?? 0;
        totals.solOutputTokens += usage?.outputTokens ?? 0;
      } else {
        totals.lunaInputTokens += usage?.inputTokens ?? 0;
        totals.lunaCachedInputTokens += usage?.cachedInputTokens ?? 0;
        totals.lunaCacheWriteTokens += usage?.cacheWriteTokens ?? 0;
        totals.lunaOutputTokens += usage?.outputTokens ?? 0;
      }
      totals.billableWebSearchCalls += call.billableWebSearchCalls;
      totals.webSearchFeeMicros += call.webSearchFeeMicros;
      totals.knownMicros += call.knownMicros;
      totals.chargedMicros += call.chargedMicros;
      totals.costUncertain ||= call.costUncertain;
    };
    for (const call of this.calls) {
      fixtures[call.fixtureRef] ??= emptyTotals();
      add(fixtures[call.fixtureRef], call);
      add(run, call);
    }
    for (const [fixtureRef, fetch] of this.fetches) {
      fixtures[fixtureRef] ??= emptyTotals();
      fixtures[fixtureRef].serverFetches += fetch.count;
      fixtures[fixtureRef].serverFetchBytes += fetch.bytes;
      run.serverFetches += fetch.count;
      run.serverFetchBytes += fetch.bytes;
    }
    return {
      version: "cost-ledger-v2",
      pricing: { ...configProvenance(this.pricing), currency: this.pricing.currency, checkedOn: this.pricing.checkedOn, source: this.pricing.source },
      calls: [...this.calls],
      fetches: [...this.fetches].map(([fixtureRef, fetch]) => ({ fixtureRef, ...fetch })).sort((a, b) => a.fixtureRef.localeCompare(b.fixtureRef)),
      fixtures: Object.fromEntries(Object.entries(fixtures).sort(([a], [b]) => a.localeCompare(b))),
      run,
    };
  }
}
