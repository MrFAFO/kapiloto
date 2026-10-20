import { randomUUID } from "node:crypto";

import { runKapilotoWorkerCycle } from "./worker-runtime";

export async function runKapilotoDemandWorkerBurst(
  source: string,
  maxTasks = 1,
): Promise<void> {
  try {
    await runKapilotoWorkerCycle({
      workerId: `demand:${source}:${randomUUID()}`,
      maxTasks,
      leaseSeconds: 180,
      heartbeatIntervalMs: 30_000,
      finalizeRuns: false,
    });
  } catch (error) {
    console.error("Kapiloto demand worker burst failed", {
      source,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
