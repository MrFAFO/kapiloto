import OpenAI from "openai";

import { createAdminClient } from "@/lib/supabase/admin";

import {
  createOpenAIEntailmentJudge,
} from "./entailment-verifier";
import {
  getKapilotoOpenAIModel,
  getKapilotoReasoningEffort,
} from "./research-config";
import {
  createOpenAIFixtureResearchRunner,
  executeOneResearchTask,
  type ExecuteResearchTaskResult,
} from "./research-task-executor";
import {
  finalizeKapilotoRun,
  SupabaseKapilotoRunFinalizationStore,
  type FinalizeKapilotoRunResult,
} from "./run-finalizer";
import { createSupabaseFixtureEvidenceGrounder } from "./source-grounding-runtime";
import { SupabaseResearchAttemptQueue } from "./supabase-attempt-queue";
import { SupabaseKapilotoRunPublisher } from "./supabase-run-publisher";

export type KapilotoWorkerCycleOptions = {
  workerId: string;
  maxTasks?: number;
  leaseSeconds?: number;
  heartbeatIntervalMs?: number;
};

export type KapilotoWorkerCycleResult = {
  recoveredAttempts: number | null;
  tasks: ExecuteResearchTaskResult[];
  finalizedRuns: FinalizeKapilotoRunResult[];
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
  const recovered = (data as Record<string, unknown>).recovered_count;
  return typeof recovered === "number" ? recovered : null;
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

  const fixtureSet = run.fixture_set;
  if (!Array.isArray(fixtureSet) || fixtureSet.length !== 16) {
    return { ready: false, reason: "invalid_fixture_set" };
  }

  const researchCount = fixtureSet.filter(
    (item) =>
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).mode === "research",
  ).length;

  if (researchCount !== 16) {
    return {
      ready: false,
      reason: "mixed_dispositions_not_yet_materializable",
    };
  }

  const rows = attempts ?? [];
  const active = rows.filter(
    (attempt) => attempt.status === "queued" || attempt.status === "running",
  ).length;
  const succeeded = rows.filter(
    (attempt) => attempt.status === "succeeded",
  ).length;

  if (active > 0) {
    return { ready: false, reason: `active_attempts:${active}` };
  }
  if (succeeded !== 16) {
    return {
      ready: false,
      reason: `succeeded_attempts:${succeeded}/16`,
    };
  }

  return { ready: true, reason: "ready" };
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
    900,
    3600,
    "leaseSeconds",
  );

  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  if (!openAiKey) {
    throw new Error("OPENAI_API_KEY is required for Kapiloto worker execution.");
  }

  const admin = createAdminClient();
  const openai = new OpenAI({ apiKey: openAiKey });
  const queue = new SupabaseResearchAttemptQueue(admin);
  const runner = createOpenAIFixtureResearchRunner(openai);
  const grounder = createSupabaseFixtureEvidenceGrounder(admin);
  const model = getKapilotoOpenAIModel();
  const reasoningEffort = getKapilotoReasoningEffort();

  const recoveredAttempts = await recoverExpiredAttempts(admin);
  const tasks: ExecuteResearchTaskResult[] = [];
  const touchedRuns = new Set<string>();

  for (let index = 0; index < maxTasks; index += 1) {
    const result = await executeOneResearchTask(queue, runner, {
      workerId: options.workerId,
      leaseSeconds,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      reasoningEffort,
      grounder,
      traceId: `${options.workerId}:${Date.now()}:${index}`,
    });

    tasks.push(result);

    if (result.status === "no_work") break;
    touchedRuns.add(result.runId);
  }

  const publisher = new SupabaseKapilotoRunPublisher(admin);
  const finalizationStore = new SupabaseKapilotoRunFinalizationStore(admin);
  const entailmentJudge = createOpenAIEntailmentJudge(openai, {
    model,
    reasoningEffort: "medium",
  });

  const finalizedRuns: FinalizeKapilotoRunResult[] = [];
  const finalizationDeferred: KapilotoWorkerCycleResult["finalizationDeferred"] =
    [];

  for (const runId of touchedRuns) {
    const readiness = await runReadyForFinalization(admin, runId);

    if (!readiness.ready) {
      finalizationDeferred.push({ runId, reason: readiness.reason });
      continue;
    }

    try {
      finalizedRuns.push(
        await finalizeKapilotoRun(
          finalizationStore,
          publisher,
          entailmentJudge,
          runId,
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

  return {
    recoveredAttempts,
    tasks,
    finalizedRuns,
    finalizationDeferred,
  };
}
