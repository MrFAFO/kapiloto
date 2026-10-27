import { randomUUID } from "node:crypto";

import {
  runKapilotoWorkerCycle,
  type KapilotoWorkerCycleOptions,
} from "./worker-runtime";

export function buildKapilotoDemandWorkerOptions(
  source: string,
  deadlineAtMs?: number,
): KapilotoWorkerCycleOptions {
  return {
    workerId: `demand:${source}:${randomUUID()}`,
    maxTasks: 1,
    leaseSeconds: 180,
    heartbeatIntervalMs: 30_000,
    finalizeRuns: false,
    ...(deadlineAtMs != null ? { deadlineAtMs } : {}),
  };
}

export async function runKapilotoDemandWorkerBurst(
  source: string,
  deadlineAtMs?: number,
): Promise<void> {
  try {
    await runKapilotoWorkerCycle(
      buildKapilotoDemandWorkerOptions(source, deadlineAtMs),
    );
  } catch (error) {
    console.error("Kapiloto demand worker burst failed", {
      source,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
