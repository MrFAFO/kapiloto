import { randomUUID } from "node:crypto";

import { after } from "next/server";

import { ensureServerKapilotoResearch } from "@/lib/kapiloto/server-research";
import { verifyKapilotoWorkerAuthorization } from "@/lib/kapiloto/worker-auth";
import { runKapilotoDemandWorkerBurst } from "@/lib/kapiloto/worker-demand";
import { kapilotoInvocationDeadline } from "@/lib/kapiloto/worker-runtime";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Temporary bootstrap-only operator trigger for the first real research run.
 *
 * It deliberately refuses to choose an actor once more than one profile exists.
 * The normal product path remains the authenticated user-facing request API.
 */
export async function POST(request: Request): Promise<Response> {
  const requestStartedAt = Date.now();

  if (
    !verifyKapilotoWorkerAuthorization(
      request.headers.get("authorization"),
      process.env.KAPILOTO_OPERATOR_SECRET_SHA256,
    )
  ) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: {
    externalRoundNumber?: unknown;
    gameNumber?: unknown;
  } = {};

  try {
    const parsed = (await request.json()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as typeof body;
    }
  } catch {
    return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const externalRoundNumber =
    typeof body.externalRoundNumber === "string"
      ? body.externalRoundNumber.trim()
      : "";
  const gameNumber = Number(body.gameNumber ?? 1);

  if (!/^\d{6}$/.test(externalRoundNumber)) {
    return Response.json(
      { ok: false, error: "invalid_round_number" },
      { status: 400 },
    );
  }
  if (!Number.isInteger(gameNumber) || gameNumber < 1 || gameNumber > 16) {
    return Response.json(
      { ok: false, error: "invalid_game_number" },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const [
    profilesResult,
    roundResult,
  ] = await Promise.all([
    admin.from("profiles").select("id").order("created_at").limit(2),
    admin
      .from("rounds")
      .select("id,external_round_number")
      .eq("external_round_number", externalRoundNumber)
      .maybeSingle(),
  ]);

  if (profilesResult.error) {
    throw new Error(
      `Failed to resolve bootstrap research actor: ${profilesResult.error.message}`,
    );
  }
  if (roundResult.error) {
    throw new Error(
      `Failed to resolve bootstrap research round: ${roundResult.error.message}`,
    );
  }

  const profiles = profilesResult.data ?? [];
  if (profiles.length !== 1) {
    return Response.json(
      {
        ok: false,
        error: "bootstrap_actor_not_unique",
        actorCount: profiles.length,
        researchRunCreated: false,
      },
      { status: 409 },
    );
  }
  if (!roundResult.data) {
    return Response.json(
      { ok: false, error: "round_not_found", researchRunCreated: false },
      { status: 404 },
    );
  }

  const { data: roundGame, error: roundGameError } = await admin
    .from("round_games")
    .select("id")
    .eq("round_id", roundResult.data.id)
    .eq("game_number", gameNumber)
    .maybeSingle();

  if (roundGameError) {
    throw new Error(
      `Failed to resolve bootstrap fixture: ${roundGameError.message}`,
    );
  }
  if (!roundGame) {
    return Response.json(
      { ok: false, error: "fixture_not_found", researchRunCreated: false },
      { status: 404 },
    );
  }

  const result = await ensureServerKapilotoResearch(admin, {
    userId: String(profiles[0].id),
    roundId: String(roundResult.data.id),
    roundGameId: String(roundGame.id),
    intent: "consult",
    idempotencyKey: `operator-${externalRoundNumber}-${gameNumber}-${randomUUID()}`,
    basedOnRunId: null,
    breakerOpen: false,
  });

  if (result.outcome === "created_run") {
    after(() =>
      runKapilotoDemandWorkerBurst(
        `operator:${result.run_id ?? roundResult.data!.id}`,
        kapilotoInvocationDeadline(requestStartedAt),
      ),
    );
  }

  return Response.json({
    ok: true,
    externalRoundNumber,
    gameNumber,
    outcome: result.outcome,
    runId: result.run_id ?? null,
    activeRunId: result.active_run_id ?? null,
    currentRunId: result.current_run_id ?? null,
    runsConsumed: result.runs_consumed,
    taskCount: result.task_count ?? null,
    replayed: result.replayed,
    researchRunCreated: result.outcome === "created_run",
  });
}
