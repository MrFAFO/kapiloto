import { summarizeKapilotoPreparedRun } from "@/lib/kapiloto/plan-preflight";
import { SupabaseKapilotoResearchPreparer } from "@/lib/kapiloto/research-plan-preparer";
import { verifyKapilotoWorkerAuthorization } from "@/lib/kapiloto/worker-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

  let externalRoundNumber = "";
  try {
    const body = (await request.json()) as unknown;
    if (
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      typeof (body as { externalRoundNumber?: unknown }).externalRoundNumber ===
        "string"
    ) {
      externalRoundNumber = (
        body as { externalRoundNumber: string }
      ).externalRoundNumber.trim();
    }
  } catch {
    // Validation below returns a stable client error.
  }

  if (!externalRoundNumber) {
    return Response.json(
      { ok: false, error: "externalRoundNumber_required" },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const { data: round, error: roundError } = await admin
    .from("rounds")
    .select("id,external_round_number")
    .eq("external_round_number", externalRoundNumber)
    .maybeSingle();

  if (roundError) {
    throw new Error(
      `Failed to load round for plan preflight: ${roundError.message}`,
    );
  }
  if (!round) {
    return Response.json(
      { ok: false, error: "round_not_found" },
      { status: 404 },
    );
  }

  const { data: state, error: stateError } = await admin
    .from("kapiloto_round_research_state")
    .select("runs_consumed,active_run_id,current_run_id")
    .eq("round_id", round.id)
    .maybeSingle();

  if (stateError) {
    throw new Error(
      `Failed to load research state for plan preflight: ${stateError.message}`,
    );
  }

  try {
    const prepared = await new SupabaseKapilotoResearchPreparer(admin).prepare({
      roundId: round.id,
      currentRunId: state?.current_run_id ?? null,
    });
    const summary = summarizeKapilotoPreparedRun(prepared);

    return Response.json({
      ok: true,
      roundId: round.id,
      externalRoundNumber: round.external_round_number,
      researchCutoffAt: prepared.researchCutoffAt,
      fixtureSetSha256: prepared.fixtureSetSha256,
      ...summary,
      runsConsumed: state?.runs_consumed ?? 0,
      activeRunId: state?.active_run_id ?? null,
      currentRunId: state?.current_run_id ?? null,
      researchRunCreated: false,
      databaseChanged: false,
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        externalRoundNumber,
        error: error instanceof Error ? error.message : String(error),
        researchRunCreated: false,
        databaseChanged: false,
      },
      { status: 503 },
    );
  }
}
