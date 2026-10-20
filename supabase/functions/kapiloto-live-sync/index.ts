import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

type GameState = {
  gameNumber: number;
  status: "upcoming" | "live" | "halftime" | "finished" | "postponed" | "cancelled" | "suspended" | "under_review";
  homeScore: number | null;
  awayScore: number | null;
  outcome: "1" | "X" | "2" | null;
};

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&apos;|&#39;|&#x27;/gi, "'")
    .replace(/&amp;|&#38;/gi, "&")
    .replace(/&lt;|&#60;/gi, "<")
    .replace(/&gt;|&#62;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_m, code) => String.fromCodePoint(Number.parseInt(code, 10)));
}

function textFromHtml(value: string): string {
  return decodeHtml(value.replace(/<br\s*\/?\s*>/gi, " ").replace(/<[^>]+>/g, " "))
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
      const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
        .map((match) => textFromHtml(match[1]));
      if (cells.length < 5) continue;

      const number = cells[0].match(/^(\d{1,2})\.?$/);
      if (!number) continue;
      const gameNumber = Number(number[1]);
      if (gameNumber < 1 || gameNumber > 16) continue;

      const score = parseScore(cells[3] ?? "");
      const outcomeText = [...cells.slice(5)].reverse().find((x) => /^(1|X|2)$/.test(x.trim()));
      const outcome = outcomeText === "1" || outcomeText === "X" || outcomeText === "2" ? outcomeText : null;

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
  if (games.length !== 16 || games.some((g, i) => g.gameNumber !== i + 1)) {
    throw new Error(`winner16_invalid_game_set:${games.length}`);
  }

  return { roundNumber: section[1], games };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
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
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, adminKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const body = await req.json().catch(() => ({})) as { secret?: string };
    const { data: authorized, error: authError } = await supabase.rpc(
      "kapiloto_verify_scheduler_secret",
      { p_name: "live_sync", p_secret: body.secret ?? "" },
    );
    if (authError || authorized !== true) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 403 });
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
    if (!round) return Response.json({ ok: true, status: "no_active_round" });

    const { data: dbGames, error: gamesError } = await supabase
      .from("round_games")
      .select("id,game_number,kickoff_at,status,settlement_status")
      .eq("round_id", round.id)
      .order("game_number", { ascending: true });

    if (gamesError) throw new Error(`games_query_failed:${gamesError.message}`);
    if (!dbGames || dbGames.length !== 16) throw new Error("round_requires_16_games");

    const firstKickoff = Math.min(...dbGames.map((g) => Date.parse(g.kickoff_at)));
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
    if (!response.ok) throw new Error(`telesport_http_${response.status}`);

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

    const version = `sha256:${await sha256(html)}`;
    const observedAt = new Date().toISOString();
    const updates: Record<string, unknown>[] = [];

    for (const dbGame of dbGames) {
      if (dbGame.settlement_status === "settled" || dbGame.settlement_status === "void") continue;

      const source = parsed.games[dbGame.game_number - 1];
      let status = source.status;
      if (dbGame.status === "finished" && ["upcoming", "live", "halftime"].includes(status)) {
        status = "finished";
      } else if ((dbGame.status === "live" || dbGame.status === "halftime") && status === "upcoming") {
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
        update.pool_settlement_status = "settled";
        update.pool_outcome = source.outcome;
        update.settlement_source = settlementSource;
      } else if (["postponed", "cancelled", "suspended", "under_review"].includes(source.status)) {
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
      applied,
    });
  } catch (error) {
    console.error(error);
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
});
