import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

export const KAPILOTO_SOL_PRICING_VERSION =
  "gpt-6.1-sol-standard-2026-10-22";

const MICROS_PER_USD = 1_000_000;
const TOKENS_PER_MILLION = 1_000_000;

// Current Standard-tier pricing for the configured gpt-6.1-sol research model.
const INPUT_USD_PER_MILLION = 2;
const CACHED_INPUT_USD_PER_MILLION = 0.1;
const OUTPUT_USD_PER_MILLION = 10;
const WEB_SEARCH_USD_PER_CALL = 0.01;

export type KapilotoMeteredUsage = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  webSearchCalls?: number | null;
};

function nonNegative(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

export function estimateSolUsageCostMicros(
  usage: KapilotoMeteredUsage,
): number | null {
  const input = nonNegative(usage.inputTokens);
  const cached = Math.min(input, nonNegative(usage.cachedInputTokens));
  const output = nonNegative(usage.outputTokens);
  const webSearchCalls = nonNegative(usage.webSearchCalls);

  if (
    usage.inputTokens == null &&
    usage.outputTokens == null &&
    usage.webSearchCalls == null
  ) {
    return null;
  }

  const uncached = Math.max(0, input - cached);
  const usd =
    (uncached / TOKENS_PER_MILLION) * INPUT_USD_PER_MILLION +
    (cached / TOKENS_PER_MILLION) * CACHED_INPUT_USD_PER_MILLION +
    (output / TOKENS_PER_MILLION) * OUTPUT_USD_PER_MILLION +
    webSearchCalls * WEB_SEARCH_USD_PER_CALL;

  return Math.round(usd * MICROS_PER_USD);
}

function envUsd(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative USD amount.`);
  }
  return value;
}

function usdMicros(value: number): number {
  return Math.round(value * MICROS_PER_USD);
}

type FinalizationUsageRow = {
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  finished_at: string | null;
};

export type KapilotoWeeklyBudgetStatus = {
  windowStartedAt: string;
  capMicros: number;
  fixedReserveMicros: number;
  untrackedReserveMicros: number;
  meteredAiMicros: number;
  inflightReserveMicros: number;
  committedMicros: number;
  remainingMicros: number;
  attemptReserveMicros: number;
  finalizationReserveMicros: number;
  newRunReserveMicros: number;
  canStartAttempt: boolean;
  canStartFinalization: boolean;
  canCreateRun: boolean;
  breakerOpen: boolean;
};

export async function loadKapilotoWeeklyBudgetStatus(
  client: SupabaseClient<Database>,
  env: Readonly<Record<string, string | undefined>> = process.env,
  now = new Date(),
): Promise<KapilotoWeeklyBudgetStatus> {
  const capMicros = usdMicros(
    envUsd(env.KAPILOTO_WEEKLY_BUDGET_USD, 40, "KAPILOTO_WEEKLY_BUDGET_USD"),
  );
  // Conservative all-in reserve based on the currently selected Sportmonks
  // package plus Vercel Pro, amortized weekly. Override when subscriptions change.
  const fixedReserveMicros = usdMicros(
    envUsd(
      env.KAPILOTO_WEEKLY_FIXED_COST_USD,
      31.1,
      "KAPILOTO_WEEKLY_FIXED_COST_USD",
    ),
  );
  // Covers legacy attempts/preflights for which provider usage was not persisted.
  const untrackedReserveMicros = usdMicros(
    envUsd(
      env.KAPILOTO_WEEKLY_UNTRACKED_RESERVE_USD,
      1,
      "KAPILOTO_WEEKLY_UNTRACKED_RESERVE_USD",
    ),
  );
  const attemptReserveMicros = usdMicros(
    envUsd(
      env.KAPILOTO_ATTEMPT_COST_RESERVE_USD,
      0.75,
      "KAPILOTO_ATTEMPT_COST_RESERVE_USD",
    ),
  );
  const finalizationReserveMicros = usdMicros(
    envUsd(
      env.KAPILOTO_FINALIZATION_COST_RESERVE_USD,
      0.75,
      "KAPILOTO_FINALIZATION_COST_RESERVE_USD",
    ),
  );
  // A run should not be created if there is insufficient room to make useful
  // progress and complete finalization without operator approval.
  const newRunReserveMicros = usdMicros(
    envUsd(
      env.KAPILOTO_NEW_RUN_COST_RESERVE_USD,
      4.5,
      "KAPILOTO_NEW_RUN_COST_RESERVE_USD",
    ),
  );

  const windowStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const windowStartedAt = windowStart.toISOString();

  const [
    attemptsResult,
    finalizationResult,
    runningAttemptsResult,
    runningFinalizationResult,
  ] = await Promise.all([
    client
      .from("kapiloto_research_attempts")
      .select(
        "input_tokens,cached_input_tokens,output_tokens,web_search_calls,finished_at",
      )
      .gte("finished_at", windowStartedAt),
    (client as SupabaseClient<any>)
      .from("kapiloto_run_finalization_attempts")
      .select(
        "input_tokens,cached_input_tokens,output_tokens,finished_at",
      )
      .gte("finished_at", windowStartedAt),
    client
      .from("kapiloto_research_attempts")
      .select("id", { count: "exact", head: true })
      .eq("status", "running"),
    (client as SupabaseClient<any>)
      .from("kapiloto_run_finalization_attempts")
      .select("id", { count: "exact", head: true })
      .in("status", ["claimed", "running"]),
  ]);

  if (attemptsResult.error) {
    throw new Error(
      `Failed to read Kapiloto research usage for budget guard: ${attemptsResult.error.message}`,
    );
  }
  if (finalizationResult.error) {
    throw new Error(
      `Failed to read Kapiloto finalization usage for budget guard: ${finalizationResult.error.message}`,
    );
  }
  if (runningAttemptsResult.error) {
    throw new Error(
      `Failed to read in-flight Kapiloto attempts for budget guard: ${runningAttemptsResult.error.message}`,
    );
  }
  if (runningFinalizationResult.error) {
    throw new Error(
      `Failed to read in-flight Kapiloto finalization for budget guard: ${runningFinalizationResult.error.message}`,
    );
  }

  let meteredAiMicros = 0;
  for (const row of attemptsResult.data ?? []) {
    meteredAiMicros +=
      estimateSolUsageCostMicros({
        inputTokens: row.input_tokens,
        cachedInputTokens: row.cached_input_tokens,
        outputTokens: row.output_tokens,
        webSearchCalls: row.web_search_calls,
      }) ?? 0;
  }
  for (const row of (finalizationResult.data ?? []) as FinalizationUsageRow[]) {
    meteredAiMicros +=
      estimateSolUsageCostMicros({
        inputTokens: row.input_tokens,
        cachedInputTokens: row.cached_input_tokens,
        outputTokens: row.output_tokens,
        webSearchCalls: 0,
      }) ?? 0;
  }

  const inflightReserveMicros =
    (runningAttemptsResult.count ?? 0) * attemptReserveMicros +
    (runningFinalizationResult.count ?? 0) * finalizationReserveMicros;
  const committedMicros =
    fixedReserveMicros +
    untrackedReserveMicros +
    meteredAiMicros +
    inflightReserveMicros;
  const remainingMicros = Math.max(0, capMicros - committedMicros);

  const canStartAttempt =
    committedMicros + attemptReserveMicros <= capMicros;
  const canStartFinalization =
    committedMicros + finalizationReserveMicros <= capMicros;
  const canCreateRun =
    committedMicros + newRunReserveMicros <= capMicros;

  return {
    windowStartedAt,
    capMicros,
    fixedReserveMicros,
    untrackedReserveMicros,
    meteredAiMicros,
    inflightReserveMicros,
    committedMicros,
    remainingMicros,
    attemptReserveMicros,
    finalizationReserveMicros,
    newRunReserveMicros,
    canStartAttempt,
    canStartFinalization,
    canCreateRun,
    breakerOpen: committedMicros >= capMicros,
  };
}
