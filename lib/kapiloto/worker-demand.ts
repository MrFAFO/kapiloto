import { randomUUID } from "node:crypto";

import {
  runKapilotoWorkerCycle,
  type KapilotoWorkerCycleOptions,
} from "./worker-runtime";

export function buildKapilotoDemandWorkerOptions(
  source: string,
): KapilotoWorkerCycleOptions {
  return {
    workerId: `demand:${source}:${randomUUID()}`,
    maxTasks: 1,
    leaseSeconds: 180,
    heartbeatIntervalMs: 30_000,
    finalizeRuns: false,
  };
}

export async function runKapilotoDemandWorkerBurst(
  source: string,
): Promise<void> {
  try {
    await runKapilotoWorkerCycle(
      buildKapilotoDemandWorkerOptions(source),
    );
  } catch (error) {
    console.error("Kapiloto demand worker burst failed", {
      source,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
