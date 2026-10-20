import { randomUUID } from "node:crypto";

import { runKapilotoWorkerCycle } from "./worker-runtime";

export async function runKapilotoDemandWorkerBurst(
  source: string,
  maxTasks = 2,
): Promise<void> {
  try {
    await runKapilotoWorkerCycle({
      workerId: `demand:${source}:${randomUUID()}`,
      maxTasks,
      leaseSeconds: 900,
      heartbeatIntervalMs: 30_000,
    });
  } catch (error) {
    console.error("Kapiloto demand worker burst failed", {
      source,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
