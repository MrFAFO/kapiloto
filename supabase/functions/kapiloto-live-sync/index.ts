import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

type GameState = {
  gameNumber: number;
  status:
    | "upcoming"
    | "live"
    | "halftime"
    | "finished"
    | "postponed"
    | "cancelled"
    | "suspended"
    | "under_review";
  homeScore: number | null;
  awayScore: number | null;
  outcome: "1" | "X" | "2" | null;
};

type DbGame = {
  id: string;
  game_number: number;
  home_team_id: string;
  away_team_id: string;
  kickoff_at: string;
  status: string;
  settlement_status: string;
};

type Scores365Game = {
  eventId: string;
  date: string;
  startTime: string | null;
  homeTeam: string;
  awayTeam: string;
  homeScore: number | null;
  awayScore: number | null;
  outcome: "1" | "X" | "2" | null;
  isFinal: boolean;
};

type Scores365Snapshot = {
  sourceVersion: string;
  date: string;
  games: Scores365Game[];
};

const STOP_TOKENS = new Set([
  "fc",
  "cf",
  "afc",
  "sc",
  "club",
  "football",
  "f.c",
]);

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&apos;|&#39;|&#x27;/gi, "'")
    .replace(/&amp;|&#38;/gi, "&")
    .replace(/&lt;|&#60;/gi, "<")
    .replace(/&gt;|&#62;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) =>
      String.fromCodePoint(Number.parseInt(code, 16))
    )
    .replace(/&#([0-9]+);/g, (_m, code) =>
      String.fromCodePoint(Number.parseInt(code, 10))
    );
}

function textFromHtml(value: string): string {
  return decodeHtml(
    value.replace(/<br\s*\/?\s*>/gi, " ").replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function parseScore(value: string): { home: number; away: number } | null {
  const match = value.match(/^(\d+)\s*[-:]\s*(\d+)$/);
  if (!match) return null;
  return { home: Number(match[1]), away: Number(match[2]) };
}

function statusOf(raw: string, hasScore: boolean): GameState["status"] {
  const value = raw.replace(/\s+/g, " ").trim();
  if (/הסתיים/.test(value)) return "finished";
  if (/מחצית/.test(value) || /^45['’]?\+?$/.test(value)) return "halftime";
  if (/^\d{1,3}['’]\+?$/.test(value)) return "live";
  if (/נדחה/.test(value)) return "postponed";
  if (/בוטל/.test(value)) return "cancelled";
  if (/הופסק|נפסק/.test(value)) return "suspended";
  if (/^\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}$/.test(value)) return "upcoming";
  if (/ת\.\s*סיום/.test(value)) return "upcoming";
  return hasScore ? "under_review" : "upcoming";
}

function parseWinner16(html: string): { roundNumber: string; games: GameState[] } {
  const section = html.match(
    /<h2\b[^>]*>\s*ווינר\s*16\s*-\s*מספר\s*מחזור\s*:\s*(\d+)\s*<\/h2>([\s\S]*?)(?=<h2\b|$)/i,
  );
  if (!section) throw new Error("winner16_section_not_found");

  const games: GameState[] = [];
  const tablePattern = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let table: RegExpExecArray | null;

  while ((table = tablePattern.exec(section[2])) !== null) {
    const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let row: RegExpExecArray | null;

    while ((row = rowPattern.exec(table[1])) !== null) {
      const cells = [
        ...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi),
      ].map((match) => textFromHtml(match[1]));
      if (cells.length < 5) continue;

      const number = cells[0].match(/^(\d{1,2})\.?$/);
      if (!number) continue;
      const gameNumber = Number(number[1]);
      if (gameNumber < 1 || gameNumber > 16) continue;

      const score = parseScore(cells[3] ?? "");
      const outcomeText = [...cells.slice(5)]
        .reverse()
        .find((x) => /^(1|X|2)$/.test(x.trim()));
      const outcome =
        outcomeText === "1" || outcomeText === "X" || outcomeText === "2"
          ? outcomeText
          : null;

      games.push({
        gameNumber,
        status: statusOf(cells[1] ?? "", score != null),
        homeScore: score?.home ?? null,
        awayScore: score?.away ?? null,
        outcome,
      });
    }
  }

  games.sort((a, b) => a.gameNumber - b.gameNumber);
  if (
    games.length !== 16 ||
    games.some((game, index) => game.gameNumber !== index + 1)
  ) {
    throw new Error(`winner16_invalid_game_set:${games.length}`);
  }

  return { roundNumber: section[1], games };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeTeamName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token && !STOP_TOKENS.has(token))
    .join(" ");
}

function israelDateKey(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid_kickoff:${isoTimestamp}`);
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return `${map.year}-${map.month}-${map.day}`;
}

function scores365Date(dateKey: string): string {
  const match = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`invalid_365_date:${dateKey}`);
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function integerScore(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parse365Games(payload: unknown, date: string): Scores365Game[] {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !Array.isArray((payload as { games?: unknown }).games)
  ) {
    throw new Error("365scores_invalid_schema");
  }

  const rows = (payload as { games: unknown[] }).games;
  const games: Scores365Game[] = [];

  for (const raw of rows) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const home =
      row.homeCompetitor &&
      typeof row.homeCompetitor === "object" &&
      !Array.isArray(row.homeCompetitor)
        ? (row.homeCompetitor as Record<string, unknown>)
        : null;
    const away =
      row.awayCompetitor &&
      typeof row.awayCompetitor === "object" &&
      !Array.isArray(row.awayCompetitor)
        ? (row.awayCompetitor as Record<string, unknown>)
        : null;
    if (!home || !away) continue;

    const eventId =
      typeof row.id === "number" || typeof row.id === "string"
        ? String(row.id)
        : "";
    const homeTeam =
      typeof home.name === "string" ? home.name.replace(/\s+/g, " ").trim() : "";
    const awayTeam =
      typeof away.name === "string" ? away.name.replace(/\s+/g, " ").trim() : "";
    if (!eventId || !homeTeam || !awayTeam) continue;

    const statusText =
      typeof row.statusText === "string" ? row.statusText.trim() : "";
    const isFinal =
      Number(row.statusGroup) === 4 ||
      /final|ended|הסתיים/i.test(statusText);
    const homeScore = integerScore(home.score);
    const awayScore = integerScore(away.score);
    const outcome =
      isFinal && homeScore != null && awayScore != null
        ? homeScore === awayScore
          ? "X"
          : homeScore > awayScore
            ? "1"
            : "2"
        : null;

    games.push({
      eventId,
      date,
      startTime:
        typeof row.startTime === "string" && row.startTime.trim()
          ? row.startTime.trim()
          : null,
      homeTeam,
      awayTeam,
      homeScore,
      awayScore,
      outcome,
      isFinal,
    });
  }

  return games;
}

async function fetch365GamesForDate(date: string): Promise<Scores365Snapshot> {
  const day = scores365Date(date);
  const params = new URLSearchParams({
    langId: "2",
    timezoneName: "Asia/Jerusalem",
    userCountryId: "6",
    appTypeId: "5",
    sports: "1",
    startDate: day,
    endDate: day,
  });
  const url = `https://webws.365scores.com/web/games/?${params}`;
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      origin: "https://www.365scores.com",
      referer: "https://www.365scores.com/he/football/match-results",
      "user-agent": "Mozilla/5.0",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`365scores_http_${response.status}`);
  }

  const raw = await response.text();
  const payload = JSON.parse(raw) as unknown;
  return {
    sourceVersion: `sha256:${await sha256(raw)}`,
    date,
    games: parse365Games(payload, date),
  };
}

function match365Game(
  dbGame: DbGame,
  homeNames: string[],
  awayNames: string[],
  games: Scores365Game[],
): Scores365Game | null {
  const date = israelDateKey(dbGame.kickoff_at);
  const home = new Set(homeNames.map(normalizeTeamName).filter(Boolean));
  const away = new Set(awayNames.map(normalizeTeamName).filter(Boolean));
  const kickoffMs = Date.parse(dbGame.kickoff_at);

  const matches = games.filter((game) => {
    if (game.date !== date) return false;
    if (!home.has(normalizeTeamName(game.homeTeam))) return false;
    if (!away.has(normalizeTeamName(game.awayTeam))) return false;

    if (game.startTime) {
      const providerKickoffMs = Date.parse(game.startTime);
      if (
        Number.isFinite(kickoffMs) &&
        Number.isFinite(providerKickoffMs) &&
        Math.abs(providerKickoffMs - kickoffMs) > 6 * 60 * 60_000
      ) {
        return false;
      }
    }

    return true;
  });

  return matches.length === 1 ? matches[0] : null;
}

async function loadTeamNames(
  supabase: ReturnType<typeof createClient>,
  dbGames: DbGame[],
): Promise<Map<string, string[]>> {
  const teamIds = [
    ...new Set(
      dbGames.flatMap((game) => [game.home_team_id, game.away_team_id]),
    ),
  ];
  const [
    { data: teams, error: teamError },
    { data: aliases, error: aliasError },
  ] = await Promise.all([
    supabase.from("teams").select("id,canonical_name").in("id", teamIds),
    supabase.from("team_aliases").select("team_id,alias").in("team_id", teamIds),
  ]);

  if (teamError) throw new Error(`team_query_failed:${teamError.message}`);
  if (aliasError) throw new Error(`alias_query_failed:${aliasError.message}`);

  const names = new Map<string, string[]>();
  for (const team of teams ?? []) {
    names.set(team.id, [team.canonical_name]);
  }
  for (const alias of aliases ?? []) {
    const values = names.get(alias.team_id) ?? [];
    values.push(alias.alias);
    names.set(alias.team_id, values);
  }
  return names;
}

async function load365Snapshots(
  dates: string[],
  strict: boolean,
): Promise<Map<string, Scores365Snapshot>> {
  const snapshots = new Map<string, Scores365Snapshot>();

  await Promise.all(
    dates.map(async (date) => {
      try {
        snapshots.set(date, await fetch365GamesForDate(date));
      } catch (error) {
        if (strict) throw error;
        console.warn(
          "365Scores cross-check unavailable",
          date,
          error instanceof Error ? error.message : String(error),
        );
      }
    }),
  );

  return snapshots;
}

function adminKey(): string {
  const modern = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (modern) {
    const parsed = JSON.parse(modern) as Record<string, string>;
    if (parsed.default) return parsed.default;
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacy) throw new Error("supabase_admin_key_missing");
  return legacy;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return Response.json(
      { ok: false, error: "method_not_allowed" },
      { status: 405 },
    );
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, adminKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const body = await req.json().catch(() => ({})) as {
      secret?: string;
      crossCheckPreflight?: boolean;
    };
    const { data: authorized, error: authError } = await supabase.rpc(
      "kapiloto_verify_scheduler_secret",
      { p_name: "live_sync", p_secret: body.secret ?? "" },
    );
    if (authError || authorized !== true) {
      return Response.json(
        { ok: false, error: "unauthorized" },
        { status: 403 },
      );
    }

    const { data: rounds, error: roundError } = await supabase
      .from("rounds")
      .select("id,external_round_number,status")
      .eq("source", "telesport-winner16")
      .neq("status", "settled")
      .order("external_round_number", { ascending: false })
      .limit(1);

    if (roundError) throw new Error(`round_query_failed:${roundError.message}`);
    const round = rounds?.[0];
    if (!round) {
      return Response.json({ ok: true, status: "no_active_round" });
    }

    const { data: gameRows, error: gamesError } = await supabase
      .from("round_games")
      .select(
        "id,game_number,home_team_id,away_team_id,kickoff_at,status,settlement_status",
      )
      .eq("round_id", round.id)
      .order("game_number", { ascending: true });

    if (gamesError) throw new Error(`games_query_failed:${gamesError.message}`);
    if (!gameRows || gameRows.length !== 16) {
      throw new Error("round_requires_16_games");
    }

    const dbGames = gameRows as DbGame[];
    const namesByTeam = await loadTeamNames(supabase, dbGames);

    if (body.crossCheckPreflight === true) {
      const dates = [
        ...new Set(dbGames.map((game) => israelDateKey(game.kickoff_at))),
      ];
      const snapshots = await load365Snapshots(dates, true);
      const matches = dbGames.map((game) => {
        const date = israelDateKey(game.kickoff_at);
        const snapshot = snapshots.get(date);
        const match = snapshot
          ? match365Game(
              game,
              namesByTeam.get(game.home_team_id) ?? [],
              namesByTeam.get(game.away_team_id) ?? [],
              snapshot.games,
            )
          : null;
        return {
          gameNumber: game.game_number,
          matched: match != null,
          eventId: match?.eventId ?? null,
          homeTeam: match?.homeTeam ?? null,
          awayTeam: match?.awayTeam ?? null,
        };
      });
      const unmatched = matches
        .filter((item) => !item.matched)
        .map((item) => item.gameNumber);

      return Response.json({
        ok: unmatched.length === 0,
        status: "cross_check_preflight",
        roundNumber: round.external_round_number,
        matched: matches.length - unmatched.length,
        unmatched,
        matches,
        databaseChanged: false,
      });
    }

    const firstKickoff = Math.min(
      ...dbGames.map((game) => Date.parse(game.kickoff_at)),
    );
    if (Date.now() < firstKickoff - 30 * 60_000) {
      return Response.json({
        ok: true,
        status: "before_live_window",
        roundNumber: round.external_round_number,
      });
    }

    const response = await fetch("https://www.telesport.co.il/toto.aspx", {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Kapiloto/0.1 Supabase live sync",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`telesport_http_${response.status}`);
    }

    const html = await response.text();
    const parsed = parseWinner16(html);
    if (parsed.roundNumber !== round.external_round_number) {
      return Response.json({
        ok: true,
        status: "source_round_mismatch",
        databaseRound: round.external_round_number,
        sourceRound: parsed.roundNumber,
      });
    }

    const datesNeedingCrossCheck = [
      ...new Set(
        dbGames
          .filter((game) => {
            if (
              game.settlement_status === "settled" ||
              game.settlement_status === "void"
            ) {
              return false;
            }
            const source = parsed.games[game.game_number - 1];
            return source?.status === "finished" && Boolean(source.outcome);
          })
          .map((game) => israelDateKey(game.kickoff_at)),
      ),
    ];
    const scores365ByDate = await load365Snapshots(
      datesNeedingCrossCheck,
      false,
    );

    const version = `sha256:${await sha256(html)}`;
    const observedAt = new Date().toISOString();
    const updates: Record<string, unknown>[] = [];
    let corroborated = 0;
    let unverified = 0;
    let conflicts = 0;

    for (const dbGame of dbGames) {
      if (
        dbGame.settlement_status === "settled" ||
        dbGame.settlement_status === "void"
      ) {
        continue;
      }

      const source = parsed.games[dbGame.game_number - 1];
      let status = source.status;
      if (
        dbGame.status === "finished" &&
        ["upcoming", "live", "halftime"].includes(status)
      ) {
        status = "finished";
      } else if (
        (dbGame.status === "live" || dbGame.status === "halftime") &&
        status === "upcoming"
      ) {
        status = dbGame.status as GameState["status"];
      }

      const update: Record<string, unknown> = {
        round_game_id: dbGame.id,
        status,
        observed_at: observedAt,
      };

      if (source.homeScore != null && source.awayScore != null) {
        update.home_score = source.homeScore;
        update.away_score = source.awayScore;
      }

      const settlementSource = `telesport-winner16:${version}`;
      if (source.status === "finished" && source.outcome) {
        const date = israelDateKey(dbGame.kickoff_at);
        const snapshot = scores365ByDate.get(date) ?? null;
        const crossCheck = snapshot
          ? match365Game(
              dbGame,
              namesByTeam.get(dbGame.home_team_id) ?? [],
              namesByTeam.get(dbGame.away_team_id) ?? [],
              snapshot.games,
            )
          : null;

        if (
          crossCheck?.isFinal &&
          crossCheck.homeScore != null &&
          crossCheck.awayScore != null &&
          crossCheck.outcome
        ) {
          const sourceLabel =
            `${settlementSource};365scores:${snapshot!.sourceVersion}`;
          const scoreConflict =
            source.homeScore != null &&
            source.awayScore != null &&
            (source.homeScore !== crossCheck.homeScore ||
              source.awayScore !== crossCheck.awayScore);
          const outcomeConflict = source.outcome !== crossCheck.outcome;

          if (scoreConflict || outcomeConflict) {
            update.pool_settlement_status = "under_review";
            update.settlement_source = sourceLabel;
            conflicts += 1;
          } else {
            update.pool_settlement_status = "settled";
            update.pool_outcome = source.outcome;
            update.settlement_source = sourceLabel;
            corroborated += 1;
          }
        } else {
          update.pool_settlement_status = "under_review";
          update.settlement_source =
            `${settlementSource};365scores:unverified`;
          unverified += 1;
        }
      } else if (
        ["postponed", "cancelled", "suspended", "under_review"].includes(
          source.status,
        )
      ) {
        update.pool_settlement_status = "under_review";
        update.settlement_source = settlementSource;
      }

      updates.push(update);
    }

    const { data: applied, error: applyError } = await supabase.rpc(
      "toto_apply_round_state_v1",
      { p_updates: updates },
    );
    if (applyError) throw new Error(`apply_failed:${applyError.message}`);

    return Response.json({
      ok: true,
      status: "synced",
      roundNumber: round.external_round_number,
      sourceVersion: version,
      updates: updates.length,
      crossCheck: {
        corroborated,
        unverified,
        conflicts,
      },
      applied,
    });
  } catch (error) {
    console.error(error);
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
});
