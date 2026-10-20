import { randomUUID } from "node:crypto";

import { after } from "next/server";

import { verifyKapilotoWorkerAuthorization } from "@/lib/kapiloto/worker-auth";
import { runKapilotoWorkerCycle } from "@/lib/kapiloto/worker-runtime";
import { createAdminClient } from "@/lib/supabase/admin";

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

  let finalizeRuns = true;
  let preflight = false;
  try {
    const body = (await request.json()) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      if ("finalizeRuns" in body) {
        const requested = (body as { finalizeRuns?: unknown }).finalizeRuns;
        if (typeof requested !== "boolean") {
          return Response.json(
            { ok: false, error: "invalid_finalize_flag" },
            { status: 400 },
          );
        }
        finalizeRuns = requested;
      }

      if ("preflight" in body) {
        const requested = (body as { preflight?: unknown }).preflight;
        if (typeof requested !== "boolean") {
          return Response.json(
            { ok: false, error: "invalid_preflight_flag" },
            { status: 400 },
          );
        }
        preflight = requested;
      }
    }
  } catch {
    // Empty/malformed bodies are treated as a normal primary worker request.
  }

  if (preflight) {
    const admin = createAdminClient();
    const [
      { count: activeRuns, error: runError },
      { count: nonterminalAttempts, error: attemptError },
    ] = await Promise.all([
      admin
        .from("kapiloto_research_runs")
        .select("id", { count: "exact", head: true })
        .in("status", ["queued", "running"]),
      admin
        .from("kapiloto_research_attempts")
        .select("id", { count: "exact", head: true })
        .in("status", ["queued", "running"]),
    ]);

    if (runError || attemptError) {
      return Response.json(
        {
          ok: false,
          error: "database_preflight_failed",
          detail: runError?.message ?? attemptError?.message ?? "unknown",
          attemptClaimed: false,
          researchRunCreated: false,
          databaseChanged: false,
        },
        { status: 503 },
      );
    }

    return Response.json({
      ok: true,
      preflight: true,
      workerReady: true,
      openAIConfigured: true,
      activeRuns: activeRuns ?? 0,
      nonterminalAttempts: nonterminalAttempts ?? 0,
      attemptClaimed: false,
      researchRunCreated: false,
      databaseChanged: false,
      checkedAt: new Date().toISOString(),
    });
  }

  const workerId = `scheduler:${randomUUID()}`;

  after(async () => {
    try {
      const result = await runKapilotoWorkerCycle({
        workerId,
        maxTasks: 1,
        leaseSeconds: 180,
        heartbeatIntervalMs: 30_000,
        finalizeRuns,
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
      finalizeRuns,
      acceptedAt: new Date().toISOString(),
    },
    { status: 202 },
  );
}
