import { after } from "next/server";
import { handleRoundResearchStateGet } from "@/lib/kapiloto/read-api";
import { serverKapilotoReadDeps } from "@/lib/kapiloto/server-read-deps";
import { runKapilotoDemandWorkerBurst } from "@/lib/kapiloto/worker-demand";

export const maxDuration = 300;

type RouteContext = {
  params: Promise<{ roundId: string }>;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const params = await context.params;
  const response = await handleRoundResearchStateGet(
    request,
    params,
    serverKapilotoReadDeps,
  );

  if (response.ok) {
    after(() =>
      runKapilotoDemandWorkerBurst(`state:${params.roundId}`, 2),
    );
  }

  return response;
}
