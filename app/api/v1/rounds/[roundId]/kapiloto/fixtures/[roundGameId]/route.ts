import { handleFixtureAnalysisGet } from "@/lib/kapiloto/read-api";
import { serverKapilotoReadDeps } from "@/lib/kapiloto/server-read-deps";

export const maxDuration = 300;

type RouteContext = {
  params: Promise<{ roundId: string; roundGameId: string }>;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const params = await context.params;
  return handleFixtureAnalysisGet(
    request,
    params,
    serverKapilotoReadDeps,
  );
}
