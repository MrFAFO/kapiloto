import { WinnerOfficialResultsClient } from "@/lib/rounds/winner-results";
import { verifyKapilotoWorkerAuthorization } from "@/lib/kapiloto/worker-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

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

  const now = new Date();
  const start = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

  try {
    const snapshot = await new WinnerOfficialResultsClient().getResults(
      isoDate(start),
      isoDate(now),
    );

    const footballEvents = snapshot.events.filter(
      (event) => event.sportId === 240,
    );
    const scoredFootballEvents = footballEvents.filter(
      (event) =>
        event.homeScore != null &&
        event.awayScore != null,
    );

    return Response.json({
      ok: true,
      source: "winner-official-results",
      sourceUrl: snapshot.sourceUrl,
      fetchedAt: snapshot.fetchedAt,
      eventCount: snapshot.events.length,
      footballEventCount: footballEvents.length,
      scoredFootballEventCount: scoredFootballEvents.length,
      schemaValidated: true,
      databaseChanged: false,
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        source: "winner-official-results",
        error: error instanceof Error ? error.message : String(error),
        schemaValidated: false,
        databaseChanged: false,
      },
      { status: 503 },
    );
  }
}
