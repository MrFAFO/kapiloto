import { createOpenAIClient } from "@/lib/kapiloto/openai-research";
import { runKapilotoOpenAIPreflight } from "@/lib/kapiloto/openai-preflight";
import { summarizeKapilotoPreparedRun } from "@/lib/kapiloto/plan-preflight";
import { getKapilotoOpenAIModel } from "@/lib/kapiloto/research-config";
import { SupabaseKapilotoResearchPreparer } from "@/lib/kapiloto/research-plan-preparer";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  if (process.env.VERCEL_ENV !== "preview") {
    return new Response(null, { status: 404 });
  }

  const url = new URL(request.url);
  const externalRoundNumber =
    url.searchParams.get("round")?.trim() || "264201";

  if (!/^\d{6}$/.test(externalRoundNumber)) {
    return Response.json(
      { ok: false, error: "invalid_round_number" },
      { status: 400 },
    );
  }

  if (!process.env.OPENAI_API_KEY?.trim()) {
    return Response.json(
      {
        ok: false,
        error: "configuration_missing",
        missing: ["OPENAI_API_KEY"],
        researchRunCreated: false,
        databaseChanged: false,
      },
      { status: 503 },
    );
  }

  try {
    const admin = createAdminClient();
    const { data: round, error: roundError } = await admin
      .from("rounds")
      .select("id,external_round_number")
      .eq("external_round_number", externalRoundNumber)
      .maybeSingle();

    if (roundError) {
      throw new Error(
        `Failed to load preview smoke round: ${roundError.message}`,
      );
    }
    if (!round) {
      return Response.json(
        {
          ok: false,
          error: "round_not_found",
          researchRunCreated: false,
          databaseChanged: false,
        },
        { status: 404 },
      );
    }

    const [
      openAI,
      stateResult,
      runCountResult,
      attemptCountResult,
    ] = await Promise.all([
      runKapilotoOpenAIPreflight(
        createOpenAIClient(),
        getKapilotoOpenAIModel(),
      ),
      admin
        .from("kapiloto_round_research_state")
        .select("runs_consumed,active_run_id,current_run_id")
        .eq("round_id", round.id)
        .maybeSingle(),
      admin
        .from("kapiloto_research_runs")
        .select("id", { count: "exact", head: true })
        .eq("round_id", round.id),
      admin
        .from("kapiloto_research_attempts")
        .select("id", { count: "exact", head: true })
        .eq("round_id", round.id),
    ]);

    if (stateResult.error) {
      throw new Error(
        `Failed to load preview smoke research state: ${stateResult.error.message}`,
      );
    }
    if (runCountResult.error) {
      throw new Error(
        `Failed to count preview smoke runs: ${runCountResult.error.message}`,
      );
    }
    if (attemptCountResult.error) {
      throw new Error(
        `Failed to count preview smoke attempts: ${attemptCountResult.error.message}`,
      );
    }

    const prepared = await new SupabaseKapilotoResearchPreparer(
      admin,
      null,
    ).prepare({
      roundId: round.id,
      currentRunId: stateResult.data?.current_run_id ?? null,
    });
    const plan = summarizeKapilotoPreparedRun(prepared);

    return Response.json({
      ok: true,
      environment: process.env.VERCEL_ENV,
      externalRoundNumber: round.external_round_number,
      openAI: {
        ok: true,
        model: openAI.model,
        responseId: openAI.responseId,
        inputTokens: openAI.inputTokens,
        outputTokens: openAI.outputTokens,
      },
      plan,
      researchState: {
        runsConsumed: stateResult.data?.runs_consumed ?? 0,
        activeRunId: stateResult.data?.active_run_id ?? null,
        currentRunId: stateResult.data?.current_run_id ?? null,
        runCount: runCountResult.count ?? 0,
        attemptCount: attemptCountResult.count ?? 0,
      },
      researchRunCreated: false,
      databaseChanged: false,
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        environment: process.env.VERCEL_ENV ?? null,
        externalRoundNumber,
        error: error instanceof Error ? error.message : String(error),
        researchRunCreated: false,
        databaseChanged: false,
      },
      { status: 503 },
    );
  }
}
