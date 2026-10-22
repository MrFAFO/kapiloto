import OpenAI from "openai";

import { createAdminClient } from "@/lib/supabase/admin";

import {
  createOpenAIEntailmentJudge,
} from "./entailment-verifier";
import {
  getKapilotoOpenAIModel,
  getKapilotoReasoningEffort,
} from "./research-config";
import { loadKapilotoWeeklyBudgetStatus } from "./research-cost";
import {
  createOpenAIFixtureResearchRunner,
  executeOneResearchTask,
  type ExecuteResearchTaskResult,
} from "./research-task-executor";
import {
  finalizeKapilotoRunWithClaim,
  KAPILOTO_FINALIZATION_LEASE_SECONDS,
  SupabaseKapilotoRunFinalizationStore,
  type ClaimedFinalizationResult,
} from "./run-finalizer";
import { createSupabaseFixtureEvidenceGrounder } from "./source-grounding-runtime";
import { SupabaseResearchAttemptQueue } from "./supabase-attempt-queue";
import { SupabaseKapilotoFinalizationLedger } from "./supabase-finalization-ledger";
import { assessRunFinalizationReadiness } from "./run-readiness";

export type KapilotoWorkerCycleOptions = {
  workerId: string;
  maxTasks?: number;
  leaseSeconds?: number;
  heartbeatIntervalMs?: number;
  finalizeRuns?: boolean;
  /**
   * Epoch ms by which all work in this serverless invocation must be done.
   * Defaults to a conservative budget measured from the cycle start.
   */
  deadlineAtMs?: number;
};

/** Worker routes run with maxDuration = 300s; keep a margin for shutdown. */
export const KAPILOTO_WORKER_DEFAULT_BUDGET_MS = 270_000;
/** Deadline for a cycle started by a request that began at `startedAtMs`. */
export function kapilotoInvocationDeadline(startedAtMs: number): number {
  return startedAtMs + KAPILOTO_WORKER_DEFAULT_BUDGET_MS;
}

/** Entailment verification plus publication must fit after research work. */
export const KAPILOTO_FINALIZATION_MIN_BUDGET_MS = 90_000;
/** Reasoning + verdict JSON for up to 128 claims; 4k caused incompletes. */
export const KAPILOTO_ENTAILMENT_MAX_OUTPUT_TOKENS = 16_000;

export type KapilotoWorkerCycleResult = {
  recoveredAttempts: number | null;
  failedRuns: number | null;
  tasks: ExecuteResearchTaskResult[];
  finalizedRuns: ClaimedFinalizationResult[];
  finalizationDeferred: Array<{
    runId: string;
    reason: string;
  }>;
};

function positiveBoundedInteger(
  value: number | undefined,
  fallback: number,
  max: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > max) {
    throw new Error(`${field} must be an integer between 1 and ${max}.`);
  }
  return resolved;
}

async function recoverExpiredAttempts(
  admin: ReturnType<typeof createAdminClient>,
): Promise<number | null> {
  const { data, error } = await admin.rpc(
    "kapiloto_recover_expired_attempts",
    {
      p_limit: 100,
      p_retry_delay_seconds: 5,
    },
  );

  if (error) {
    throw new Error(
      `Failed to recover expired Kapiloto attempts: ${error.message}`,
    );
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const recovered = record.recovered ?? record.recovered_count;
  return typeof recovered === "number" ? recovered : null;
}

async function failExhaustedRuns(
  admin: ReturnType<typeof createAdminClient>,
): Promise<number | null> {
  const { data, error } = await admin.rpc("kapiloto_fail_exhausted_runs", {
    p_limit: 20,
  });

  if (error) {
    throw new Error(
      `Failed to close exhausted Kapiloto runs: ${error.message}`,
    );
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const failed = (data as Record<string, unknown>).failed_runs;
  return typeof failed === "number" ? failed : null;
}

async function runReadyForFinalization(
  admin: ReturnType<typeof createAdminClient>,
  runId: string,
): Promise<{ ready: boolean; reason: string }> {
  const [{ data: run, error: runError }, { data: attempts, error: attemptsError }] =
    await Promise.all([
      admin
        .from("kapiloto_research_runs")
        .select("status,fixture_set")
        .eq("id", runId)
        .maybeSingle(),
      admin
        .from("kapiloto_research_attempts")
        .select("status")
        .eq("run_id", runId),
    ]);

  if (runError) {
    throw new Error(
      `Failed to inspect Kapiloto run before finalization: ${runError.message}`,
    );
  }
  if (!run) return { ready: false, reason: "run_not_found" };
  if (attemptsError) {
    throw new Error(
      `Failed to inspect Kapiloto attempts before finalization: ${attemptsError.message}`,
    );
  }
  if (run.status === "completed") {
    return { ready: false, reason: "already_completed" };
  }
  if (run.status !== "queued" && run.status !== "running") {
    return { ready: false, reason: `terminal_status:${run.status}` };
  }

  return assessRunFinalizationReadiness(
    run.fixture_set,
    (attempts ?? []).map((attempt) => String(attempt.status)),
  );
}

async function loadFinalizationCandidateRunIds(
  admin: ReturnType<typeof createAdminClient>,
  limit = 16,
): Promise<string[]> {
  const { data, error } = await admin
    .from("kapiloto_research_runs")
    .select("id")
    .in("status", ["queued", "running"])
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(
      `Failed to discover Kapiloto finalization candidates: ${error.message}`,
    );
  }

  return (data ?? []).map((row) => String(row.id));
}

export async function runKapilotoWorkerCycle(
  options: KapilotoWorkerCycleOptions,
): Promise<KapilotoWorkerCycleResult> {
  const maxTasks = positiveBoundedInteger(
    options.maxTasks,
    4,
    16,
    "maxTasks",
  );
  const leaseSeconds = positiveBoundedInteger(
    options.leaseSeconds,
    180,
    3600,
    "leaseSeconds",
  );

  const deadlineAtMs =
    options.deadlineAtMs ?? Date.now() + KAPILOTO_WORKER_DEFAULT_BUDGET_MS;

  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  if (!openAiKey) {
    throw new Error("OPENAI_API_KEY is required for Kapiloto worker execution.");
  }

  const admin = createAdminClient();
  // Attempt-level retries live in the database queue; SDK-level retries would
  // repeat multi-minute paid requests inside one bounded invocation.
  const openai = new OpenAI({ apiKey: openAiKey, maxRetries: 0 });
  const queue = new SupabaseResearchAttemptQueue(admin);
  const runner = createOpenAIFixtureResearchRunner(openai);
  const grounder = createSupabaseFixtureEvidenceGrounder(admin);
  const model = getKapilotoOpenAIModel();
  const reasoningEffort = getKapilotoReasoningEffort();

  const recoveredAttempts = await recoverExpiredAttempts(admin);
  const failedBeforeWork = await failExhaustedRuns(admin);
  const tasks: ExecuteResearchTaskResult[] = [];
  const touchedRuns = new Set<string>();

  for (let index = 0; index < maxTasks; index += 1) {
    const budget = await loadKapilotoWeeklyBudgetStatus(admin);
    if (!budget.canStartAttempt) {
      console.warn("Kapiloto weekly budget blocked another research attempt", {
        committedMicros: budget.committedMicros,
        capMicros: budget.capMicros,
        remainingMicros: budget.remainingMicros,
        attemptReserveMicros: budget.attemptReserveMicros,
      });
      tasks.push({ status: "deferred", reason: "weekly_budget" });
      break;
    }

    const result = await executeOneResearchTask(queue, runner, {
      workerId: options.workerId,
      leaseSeconds,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      reasoningEffort,
      grounder,
      traceId: `${options.workerId}:${Date.now()}:${index}`,
      deadlineAtMs,
    });

    tasks.push(result);

    if (result.status === "no_work" || result.status === "deferred") break;
    touchedRuns.add(result.runId);
  }

  const failedAfterWork = await failExhaustedRuns(admin);
  const failedRuns =
    failedBeforeWork == null && failedAfterWork == null
      ? null
      : (failedBeforeWork ?? 0) + (failedAfterWork ?? 0);

  const finalizedRuns: ClaimedFinalizationResult[] = [];
  const finalizationDeferred: KapilotoWorkerCycleResult["finalizationDeferred"] =
    [];

  if (options.finalizeRuns !== false) {
    for (const runId of await loadFinalizationCandidateRunIds(admin)) {
      touchedRuns.add(runId);
    }

    const finalizationBudget = await loadKapilotoWeeklyBudgetStatus(admin);
    if (!finalizationBudget.canStartFinalization) {
      console.warn("Kapiloto weekly budget blocked paid finalization", {
        committedMicros: finalizationBudget.committedMicros,
        capMicros: finalizationBudget.capMicros,
        remainingMicros: finalizationBudget.remainingMicros,
        finalizationReserveMicros:
          finalizationBudget.finalizationReserveMicros,
      });
      for (const runId of touchedRuns) {
        finalizationDeferred.push({ runId, reason: "weekly_budget" });
      }
      return {
        recoveredAttempts,
        failedRuns,
        tasks,
        finalizedRuns,
        finalizationDeferred,
      };
    }

    // Correctness does not depend on which scheduler slot finalizes: the
    // database claim admits one owner per run, fences publication and bounds
    // finalization attempts.
    const ledger = new SupabaseKapilotoFinalizationLedger(admin);
    const finalizationStore = new SupabaseKapilotoRunFinalizationStore(admin);
    const entailmentJudge = createOpenAIEntailmentJudge(openai, {
      model,
      reasoningEffort: "medium",
      maxOutputTokens: KAPILOTO_ENTAILMENT_MAX_OUTPUT_TOKENS,
    });

    for (const runId of touchedRuns) {
      // A finalizer killed mid-entailment wastes a paid call and retries on
      // the next tick; only start when publication can complete.
      if (deadlineAtMs - Date.now() < KAPILOTO_FINALIZATION_MIN_BUDGET_MS) {
        finalizationDeferred.push({ runId, reason: "insufficient_time" });
        continue;
      }

      const readiness = await runReadyForFinalization(admin, runId);

      if (!readiness.ready) {
        finalizationDeferred.push({ runId, reason: readiness.reason });
        continue;
      }

      try {
        finalizedRuns.push(
          await finalizeKapilotoRunWithClaim(
            { ledger, store: finalizationStore, judge: entailmentJudge },
            runId,
            {
              workerId: options.workerId,
              leaseSeconds: KAPILOTO_FINALIZATION_LEASE_SECONDS,
              heartbeatIntervalMs: 30_000,
              deadlineAtMs,
            },
          ),
        );
      } catch (error) {
        finalizationDeferred.push({
          runId,
          reason:
            error instanceof Error
              ? `finalization_error:${error.message}`
              : `finalization_error:${String(error)}`,
        });
      }
    }
  }

  return {
    recoveredAttempts,
    failedRuns,
    tasks,
    finalizedRuns,
    finalizationDeferred,
  };
}