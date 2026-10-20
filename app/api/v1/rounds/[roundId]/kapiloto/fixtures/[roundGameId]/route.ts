import { after } from "next/server";
import { handleFixtureAnalysisGet } from "@/lib/kapiloto/read-api";
import { serverKapilotoReadDeps } from "@/lib/kapiloto/server-read-deps";
import { runKapilotoDemandWorkerBurst } from "@/lib/kapiloto/worker-demand";

export const maxDuration = 300;

type RouteContext = {
  params: Promise<{ roundId: string; roundGameId: string }>;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const params = await context.params;
  const response = await handleFixtureAnalysisGet(
    request,
    params,
    serverKapilotoReadDeps,
  );

  if (response.ok) {
    after(() =>
      runKapilotoDemandWorkerBurst(
        `fixture:${params.roundGameId}`,
        2,
      ),
    );
  }

  return response;
}
