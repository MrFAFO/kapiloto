import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { ROUND_264301, TELESPORT_264301_MODERN_HTML } from "./round-264301";

// Test-only: round 264301 as production stores it after its last sync before
// the D-062 fix. The three draws are settled; the thirteen other games are
// finished and under review with home and away goals swapped, because
// Telesport's away-first score text was read home first.

export const ROUND_ID = "26430100-0000-4000-8000-000000000001";
export const TICKET_VERSION_ID = "26430100-0000-4000-8000-000000000006";
export const PREVIOUS_SYNC_AT = "2026-11-02T21:00:00.000Z";
export const DRAWS = new Set([2, 3, 9]);

const COMPETITION_ID = "26430100-0000-4000-8000-000000000002";
const USER_ID = "26430100-0000-4000-8000-000000000003";
const GROUP_ID = "26430100-0000-4000-8000-000000000004";
const TICKET_ID = "26430100-0000-4000-8000-000000000005";

const id = (prefix: string, game: number) =>
  `${prefix}-0000-4000-8000-${String(game).padStart(12, "0")}`;
export const roundGameId = (game: number) => id("26430102", game);
const fixtureId = (game: number) => id("26430103", game);

export async function seedStoredRound264301(db: PGlite): Promise<void> {
  await db.query("insert into auth.users (id, email) values ($1, 'w16@example.com')", [USER_ID]);
  await db.query("insert into public.competitions (id, canonical_name) values ($1, 'League')", [COMPETITION_ID]);
  await db.query(
    `insert into public.rounds (id, external_round_number, starts_at, lock_at, source, status)
     values ($1, '264301', '2026-10-31T15:00:00Z', '2026-10-31T14:30:00Z', 'telesport-winner16', 'under_review')`,
    [ROUND_ID],
  );

  for (const game of ROUND_264301) {
    const homeId = id("26430101", game.game * 2);
    const awayId = id("26430101", game.game * 2 + 1);
    await db.query("insert into public.teams (id, canonical_name) values ($1, $2), ($3, $4)", [
      homeId, game.homeNames[0], awayId, game.awayNames[0],
    ]);
    // Round 264201's stored 365Scores aliases (Hull City, Leeds United).
    for (const [teamId, names] of [[homeId, game.homeNames], [awayId, game.awayNames]] as const) {
      for (const alias of names.slice(1)) {
        await db.query(
          "insert into public.team_aliases (team_id, alias, source, language_code) values ($1, $2, '365scores', 'he')",
          [teamId, alias],
        );
      }
    }

    const [home, away] = game.score;
    const settled = DRAWS.has(game.game);
    const stored = settled ? [home, away] : [away, home];
    const storedOutcome = stored[0] === stored[1] ? "X" : stored[0] > stored[1] ? "1" : "2";
    await db.query(
      `insert into public.fixtures (id, competition_id, home_team_id, away_team_id, kickoff_at,
         actual_kickoff_at, status, home_score, away_score, last_synced_at)
       values ($1, $2, $3, $4, $5, $5, 'finished', $6, $7, $8)`,
      [fixtureId(game.game), COMPETITION_ID, homeId, awayId, game.kickoffAt, stored[0], stored[1], PREVIOUS_SYNC_AT],
    );
    await db.query(
      `insert into public.round_games (id, round_id, game_number, home_team_id, away_team_id,
         competition_name_snapshot, kickoff_at, actual_kickoff_at, fixture_id, competition_id,
         status, field_home_score, field_away_score, field_outcome, settlement_status,
         pool_settlement_outcome, settlement_source, settlement_confirmed_at, last_synced_at)
       values ($1, $2, $3, $4, $5, 'League', $6, $6, $7, $8, 'finished', $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        roundGameId(game.game), ROUND_ID, game.game, homeId, awayId, game.kickoffAt,
        fixtureId(game.game), COMPETITION_ID, stored[0], stored[1], storedOutcome,
        settled ? "settled" : "under_review",
        settled ? game.outcome : null,
        `telesport-winner16:sha256:previous;365scores:event=${game.eventId}:sha256:previous`,
        settled ? PREVIOUS_SYNC_AT : null,
        PREVIOUS_SYNC_AT,
      ],
    );
  }

  // One submitted ticket: 2 on Liverpool-Arsenal (a hit), 2 on Bournemouth-Leeds (a miss).
  await db.query(
    "insert into public.groups (id, name, owner_user_id, join_code) values ($1, 'Group', $2, 'W16CODE')",
    [GROUP_ID, USER_ID],
  );
  await db.query(
    `insert into public.user_tickets (id, group_id, round_id, user_id, state, submitted_at)
     values ($1, $2, $3, $4, 'submitted', '2026-10-31T10:00:00Z')`,
    [TICKET_ID, GROUP_ID, ROUND_ID, USER_ID],
  );
  await db.query(
    `insert into public.ticket_versions (id, user_ticket_id, version_no, state_at_snapshot, submitted_at)
     values ($1, $2, 1, 'submitted', '2026-10-31T10:00:00Z')`,
    [TICKET_VERSION_ID, TICKET_ID],
  );
  for (const [game, pick] of [[7, "2"], [10, "2"]] as const) {
    await db.query(
      "insert into public.ticket_version_picks (ticket_version_id, round_game_id, pick) values ($1, $2, $3)",
      [TICKET_VERSION_ID, roundGameId(game), pick],
    );
    await db.query(
      `insert into public.ticket_pick_results (ticket_version_id, round_game_id, evaluation_state)
       values ($1, $2, 'under_review')`,
      [TICKET_VERSION_ID, roundGameId(game)],
    );
  }
}

export type StoredGameState = {
  game_number: number;
  status: string;
  field_home_score: number;
  field_away_score: number;
  field_outcome: string;
  settlement_status: string;
  pool_settlement_outcome: string | null;
  settlement_source: string;
  last_synced_at: Date;
  home_score: number;
  away_score: number;
};

export async function readGames264301(db: PGlite): Promise<StoredGameState[]> {
  return (
    await db.query<StoredGameState>(
      `select g.game_number, g.status, g.field_home_score, g.field_away_score, g.field_outcome,
              g.settlement_status, g.pool_settlement_outcome, g.settlement_source, g.last_synced_at,
              f.home_score, f.away_score
       from public.round_games g join public.fixtures f on f.id = g.fixture_id
       where g.round_id = $1 order by g.game_number`,
      [ROUND_ID],
    )
  ).rows;
}

export async function readRoundStatus264301(db: PGlite): Promise<string> {
  return (await db.query<{ status: string }>("select status from public.rounds where id = $1", [ROUND_ID])).rows[0].status;
}

type Filter = { column: string; op: "eq" | "in"; value: unknown };

// The few supabase-js calls live sync makes, answered from PGlite.
export function pgliteSupabaseClient(db: PGlite): SupabaseClient<Database> {
  function query(table: string, columns: string, filters: Filter[], order: string | null) {
    const params: unknown[] = [];
    const where = filters.map((filter) => {
      params.push(filter.value);
      return filter.op === "eq"
        ? `${filter.column} = $${params.length}`
        : `${filter.column} = any($${params.length})`;
    });
    const sql = `select ${columns} from public.${table}${
      where.length ? ` where ${where.join(" and ")}` : ""
    }${order ? ` order by ${order}` : ""}`;
    return db.query<Record<string, unknown>>(sql, params).then(
      (result) => ({
        data: result.rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]),
          ),
        ),
        error: null,
      }),
      (error: Error) => ({ data: null, error: { message: error.message } }),
    );
  }

  function builder(table: string) {
    let columns = "*";
    const filters: Filter[] = [];
    let order: string | null = null;
    const chain = {
      select(value: string) {
        columns = value;
        return chain;
      },
      eq(column: string, value: unknown) {
        filters.push({ column, op: "eq", value });
        return chain;
      },
      in(column: string, value: unknown[]) {
        filters.push({ column, op: "in", value });
        return chain;
      },
      order(column: string, options: { ascending: boolean }) {
        order = `${column} ${options.ascending ? "asc" : "desc"}`;
        return chain;
      },
      maybeSingle() {
        return query(table, columns, filters, order).then(({ data, error }) => ({
          data: data?.[0] ?? null,
          error,
        }));
      },
      then<T>(resolve: (value: Awaited<ReturnType<typeof query>>) => T, reject?: (error: unknown) => T) {
        return query(table, columns, filters, order).then(resolve, reject);
      },
    };
    return chain;
  }

  return {
    from: builder,
    rpc: (name: string, args: { p_update: unknown }) => {
      if (name !== "toto_apply_game_state_v1") throw new Error(`unexpected rpc ${name}`);
      return db
        .query("select public.toto_apply_game_state_v1($1::jsonb) as result", [JSON.stringify(args.p_update)])
        .then(
          (result) => ({ data: result.rows[0], error: null }),
          (error: Error) => ({ data: null, error: { message: error.message } }),
        );
    },
  } as unknown as SupabaseClient<Database>;
}

const SCORES365_BY_DATE = JSON.parse(
  readFileSync(join(process.cwd(), "lib", "rounds", "fixtures", "scores365-264301-finals.json"), "utf8"),
) as Record<string, { games: Array<Record<string, unknown>> }>;

// Telesport and 365Scores as they answered on 2026-11-03; 365Scores events
// can be edited per date.
export function stubRound264301Providers(
  options: {
    scores365?: (date: string, games: Array<Record<string, unknown>>) => Array<Record<string, unknown>>;
  } = {},
): { requests: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url === "https://www.telesport.co.il/winner-16") {
      return new Response(TELESPORT_264301_MODERN_HTML, { status: 200 });
    }
    const match = url.match(/^https:\/\/webws\.365scores\.com\/web\/games\/\?.*startDate=(\d{2})%2F(\d{2})%2F(\d{4})/);
    if (match) {
      const date = `${match[3]}-${match[2]}-${match[1]}`;
      const games = SCORES365_BY_DATE[date]?.games ?? [];
      return new Response(JSON.stringify({ games: options.scores365?.(date, games) ?? games }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

export async function readTicketResults264301(db: PGlite): Promise<Array<[string, string, boolean | null, string | null]>> {
  const result = await db.query<{ round_game_id: string; evaluation_state: string; is_hit: boolean | null; evaluated_outcome: string | null }>(
    `select round_game_id, evaluation_state, is_hit, evaluated_outcome
     from public.ticket_pick_results where ticket_version_id = $1 order by round_game_id`,
    [TICKET_VERSION_ID],
  );
  return result.rows.map((row) => [row.round_game_id, row.evaluation_state, row.is_hit, row.evaluated_outcome]);
}
