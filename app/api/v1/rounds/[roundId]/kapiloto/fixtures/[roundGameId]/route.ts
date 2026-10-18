import { handleFixtureAnalysisGet } from "@/lib/kapiloto/read-api";
import { serverKapilotoReadDeps } from "@/lib/kapiloto/server-read-deps";

type RouteContext = {
  params: Promise<{ roundId: string; roundGameId: string }>;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return handleFixtureAnalysisGet(
    request,
    await context.params,
    serverKapilotoReadDeps,
  );
}
