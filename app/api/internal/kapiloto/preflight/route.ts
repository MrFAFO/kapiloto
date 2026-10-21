import { createOpenAIClient } from "@/lib/kapiloto/openai-research";
import { runKapilotoOpenAIPreflight } from "@/lib/kapiloto/openai-preflight";
import { getKapilotoOpenAIModel } from "@/lib/kapiloto/research-config";
import { verifyKapilotoWorkerAuthorization } from "@/lib/kapiloto/worker-auth";

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

  try {
    const result = await runKapilotoOpenAIPreflight(
      createOpenAIClient(),
      getKapilotoOpenAIModel(),
    );

    return Response.json({
      ok: true,
      checkedAt: new Date().toISOString(),
      model: result.model,
      responseId: result.responseId,
      usage: {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      },
      researchRunCreated: false,
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
        researchRunCreated: false,
      },
      { status: 503 },
    );
  }
}
