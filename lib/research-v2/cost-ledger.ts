import { configProvenance, type ConfigProvenance, type VersionedConfig } from "./provenance";

/**
 * Research v2 pricing (pricing-v1) and cost ledger (cost-ledger-v1), D-047.
 * Costs are integer micro-USD. Accounting uses the usage each response
 * actually reports and every recorded web-search tool call (all billable unless
 * reported otherwise), never the planned search targets. Missing or partial
 * usage is recorded as such and charged at the call's pre-call projection,
 * never silently as zero.
 */

export type ModelPricing = {
  model: string;
  processingTier: "standard";
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
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

/** Candidate rates (Standard processing tier). */
export const CANDIDATE_PRICING: PricingConfig = {
  id: "research-v2-pricing",
  version: "pricing-v1",
  status: "candidate",
  currency: "USD",
  checkedOn: "2026-10-25",
  source:
    "Official OpenAI API pricing and model documentation (Standard tier). Web search: $10 per 1,000 tool calls, with search-content tokens billed at the calling model's token rates.",
  sol: {
    model: "gpt-6.1-sol",
    processingTier: "standard",
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.1,
    outputUsdPerMillion: 10,
    checkedOn: "2026-10-22",
    source: "Standard-tier rates recorded in lib/kapiloto/research-cost.ts (gpt-6.1-sol-standard-2026-10-22), consistent with the 2026-10-24 Run 5 cost fit.",
  },
  luna: {
    model: "gpt-6-luna",
    processingTier: "standard",
    inputUsdPerMillion: 0.1,
    cachedInputUsdPerMillion: 0.01,
    outputUsdPerMillion: 0.5,
    checkedOn: "2026-10-25",
    source: "Official OpenAI API pricing page and gpt-6-luna model page, Standard processing tier (identical on both).",
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
  cacheWriteTokens: number | null;
};

export type UsageStatus = "complete" | "partial" | "missing";

export function usageStatus(usage: RecordedUsage | null): UsageStatus {
  if (!usage) return "missing";
  const required = [usage.inputTokens, usage.outputTokens];
  if (required.every((value) => value == null)) return "missing";
  return required.every((value) => value != null) && usage.cachedInputTokens != null ? "complete" : "partial";
}

/** Token cost from complete usage; null when usage is not complete. */
export function tokenCostMicros(usage: RecordedUsage | null, pricing: ModelPricing): number | null {
  if (!usage || usageStatus(usage) !== "complete") return null;
  const input = Math.max(0, usage.inputTokens as number);
  const cached = Math.min(input, Math.max(0, usage.cachedInputTokens as number));
  const output = Math.max(0, usage.outputTokens as number);
  const usd =
    ((input - cached) * pricing.inputUsdPerMillion + cached * pricing.cachedInputUsdPerMillion + output * pricing.outputUsdPerMillion) / 1_000_000;
  return usdToMicros(usd);
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
}): CallCost {
  const modelPricing = input.kind === "discovery" ? input.pricing.sol : input.pricing.luna;
  const status = usageStatus(input.usage);
  const webSearchFeeMicros = input.billableWebSearchCalls * usdToMicros(input.pricing.webSearchUsdPerCall);
  const tokens = modelPricing ? tokenCostMicros(input.usage, modelPricing) : null;
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
    knownMicros,
    chargedMicros: tokens == null ? Math.max(knownMicros, input.projectedMicros) : knownMicros,
  };
}

export type FixtureTotals = {
  solInputTokens: number;
  solCachedInputTokens: number;
  solOutputTokens: number;
  lunaInputTokens: number;
  lunaCachedInputTokens: number;
  lunaOutputTokens: number;
  billableWebSearchCalls: number;
  webSearchFeeMicros: number;
  serverFetches: number;
  serverFetchBytes: number;
  knownMicros: number;
  chargedMicros: number;
  /** True when any call's usage was missing or partial. */
  costUncertain: boolean;
};

export type LedgerSnapshot = {
  version: "cost-ledger-v1";
  pricing: ConfigProvenance & { currency: string; checkedOn: string; source: string };
  calls: CallCost[];
  fetches: Array<{ fixtureRef: string; count: number; bytes: number }>;
  fixtures: Record<string, FixtureTotals>;
  run: FixtureTotals;
};

const emptyTotals = (): FixtureTotals => ({
  solInputTokens: 0,
  solCachedInputTokens: 0,
  solOutputTokens: 0,
  lunaInputTokens: 0,
  lunaCachedInputTokens: 0,
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
        totals.solOutputTokens += usage?.outputTokens ?? 0;
      } else {
        totals.lunaInputTokens += usage?.inputTokens ?? 0;
        totals.lunaCachedInputTokens += usage?.cachedInputTokens ?? 0;
        totals.lunaOutputTokens += usage?.outputTokens ?? 0;
      }
      totals.billableWebSearchCalls += call.billableWebSearchCalls;
      totals.webSearchFeeMicros += call.webSearchFeeMicros;
      totals.knownMicros += call.knownMicros;
      totals.chargedMicros += call.chargedMicros;
      totals.costUncertain ||= call.usageStatus !== "complete";
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
      version: "cost-ledger-v1",
      pricing: { ...configProvenance(this.pricing), currency: this.pricing.currency, checkedOn: this.pricing.checkedOn, source: this.pricing.source },
      calls: [...this.calls],
      fetches: [...this.fetches].map(([fixtureRef, fetch]) => ({ fixtureRef, ...fetch })).sort((a, b) => a.fixtureRef.localeCompare(b.fixtureRef)),
      fixtures: Object.fromEntries(Object.entries(fixtures).sort(([a], [b]) => a.localeCompare(b))),
      run,
    };
  }
}
