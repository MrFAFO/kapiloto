import { randomUUID } from "node:crypto";

import { after } from "next/server";

import { verifyKapilotoWorkerAuthorization } from "@/lib/kapiloto/worker-auth";
import { runKapilotoWorkerCycle } from "@/lib/kapiloto/worker-runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  if (
    !verifyKapilotoWorkerAuthorization(
      request.headers.get("authorization"),
      process.env.KAPILOTO_WORKER_SECRET_SHA256,
    )
  ) {
    return Response.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  if (!process.env.OPENAI_API_KEY?.trim()) {
    return Response.json(
      {
        ok: false,
        error: "configuration_missing",
        missing: ["OPENAI_API_KEY"],
      },
      { status: 503 },
    );
  }

  const workerId = `scheduler:${randomUUID()}`;

  after(async () => {
    try {
      const result = await runKapilotoWorkerCycle({
        workerId,
        maxTasks: 1,
        leaseSeconds: 900,
        heartbeatIntervalMs: 30_000,
      });

      console.info("Kapiloto scheduled worker cycle completed", {
        workerId,
        result,
      });
    } catch (error) {
      console.error("Kapiloto scheduled worker cycle failed", {
        workerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return Response.json(
    {
      ok: true,
      accepted: true,
      workerId,
      acceptedAt: new Date().toISOString(),
    },
    { status: 202 },
  );
}
