export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PARSE_API_BASE =
  "https://api.parse.bot/scraper/f13aebab-be30-4f04-8f99-36aac5f132cc";

const ALLOWED_ENDPOINTS = new Set([
  "get_league_standings",
  "get_fixtures_by_matchday",
  "get_all_teams",
  "get_team_profile",
  "get_team_squad",
  "get_team_fixtures",
  "get_team_statistics",
  "get_match_details",
  "get_match_statistics",
  "get_player_stats_leaders",
  "get_top_scorers",
  "get_player_match_stats",
  "get_player_season_summary",
]);

export async function GET(request: Request): Promise<Response> {
  if (process.env.VERCEL_ENV !== "preview") {
    return new Response(null, { status: 404 });
  }

  const apiKey = process.env.PARSE_API_KEY?.trim();
  if (!apiKey) {
    return Response.json(
      { ok: false, error: "configuration_missing", missing: ["PARSE_API_KEY"] },
      { status: 503 },
    );
  }

  const incoming = new URL(request.url);
  const endpoint = incoming.searchParams.get("endpoint")?.trim() ?? "";

  if (!ALLOWED_ENDPOINTS.has(endpoint)) {
    return Response.json(
      { ok: false, error: "invalid_endpoint" },
      { status: 400 },
    );
  }

  const target = new URL(`${PARSE_API_BASE}/${endpoint}`);
  for (const [key, value] of incoming.searchParams.entries()) {
    if (key === "endpoint") continue;
    if (!/^[A-Za-z0-9_]+$/.test(key) || value.length > 200) {
      return Response.json(
        { ok: false, error: "invalid_query_parameter", parameter: key },
        { status: 400 },
      );
    }
    target.searchParams.append(key, value);
  }

  try {
    const upstream = await fetch(target, {
      method: "GET",
      headers: {
        "X-API-Key": apiKey,
        "API-Snapshot-Version": "11",
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });

    const body = await upstream.text();

    return new Response(body, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: "parse_request_failed",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}
