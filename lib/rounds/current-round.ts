import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

export type CurrentRoundGame = {
  roundGameId: string;
  fixtureId: string;
  number: number;
  home: string;
  away: string;
  league: string;
  kickoffAt: string;
  status: string;
};

export type CurrentRoundData = {
  roundId: string;
  externalRoundNumber: string;
  startsAt: string | null;
  lockAt: string;
  status: string;
  games: CurrentRoundGame[];
};

type RoundRow = {
  id: string;
  external_round_number: string;
  starts_at: string | null;
  lock_at: string;
  status: string;
};

type GameRow = {
  id: string;
  fixture_id: string;
  game_number: number;
  home_team_id: string;
  away_team_id: string;
  competition_name_snapshot: string;
  kickoff_at: string;
  status: string;
};

type TeamRow = {
  id: string;
  canonical_name: string;
};

function statusPriority(status: string): number {
  switch (status) {
    case "open":
      return 0;
    case "upcoming":
      return 1;
    case "live":
      return 2;
    case "locked":
      return 3;
    case "finished":
      return 4;
    case "under_review":
      return 5;
    case "settled":
      return 6;
    default:
      return 99;
  }
}

export function chooseCurrentRound(
  rows: RoundRow[],
  nowMs = Date.now(),
): RoundRow | null {
  if (rows.length === 0) return null;

  return [...rows].sort((a, b) => {
    const pa = statusPriority(a.status);
    const pb = statusPriority(b.status);
    if (pa !== pb) return pa - pb;

    const aLock = Date.parse(a.lock_at);
    const bLock = Date.parse(b.lock_at);

    const aFuture = aLock >= nowMs;
    const bFuture = bLock >= nowMs;
    if (aFuture !== bFuture) return aFuture ? -1 : 1;

    return aFuture ? aLock - bLock : bLock - aLock;
  })[0];
}

export class SupabaseCurrentRoundLoader {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async load(now = new Date()): Promise<CurrentRoundData | null> {
    const { data: roundsData, error: roundsError } = await this.client
      .from("rounds")
      .select("id,external_round_number,starts_at,lock_at,status")
      .order("lock_at", { ascending: false })
      .limit(12);

    if (roundsError) {
      throw new Error(`Failed to load Toto rounds: ${roundsError.message}`);
    }

    const round = chooseCurrentRound(
      (roundsData ?? []) as RoundRow[],
      now.getTime(),
    );

    if (!round) return null;

    const { data: gamesData, error: gamesError } = await this.client
      .from("round_games")
      .select(
        "id,fixture_id,game_number,home_team_id,away_team_id,competition_name_snapshot,kickoff_at,status",
      )
      .eq("round_id", round.id)
      .order("game_number", { ascending: true });

    if (gamesError) {
      throw new Error(`Failed to load Toto round games: ${gamesError.message}`);
    }

    const games = (gamesData ?? []) as GameRow[];
    if (games.length !== 16) {
      throw new Error(
        `Winner 16 round ${round.external_round_number} must contain 16 games; got ${games.length}.`,
      );
    }

    const teamIds = [
      ...new Set(games.flatMap((game) => [game.home_team_id, game.away_team_id])),
    ];

    const { data: teamsData, error: teamsError } = await this.client
      .from("teams")
      .select("id,canonical_name")
      .in("id", teamIds);

    if (teamsError) {
      throw new Error(`Failed to load round teams: ${teamsError.message}`);
    }

    const teams = new Map(
      ((teamsData ?? []) as TeamRow[]).map((team) => [
        team.id,
        team.canonical_name,
      ]),
    );

    const normalizedGames = games.map((game, index) => {
      if (game.game_number !== index + 1) {
        throw new Error("Winner 16 round game numbers must be exactly 1..16.");
      }

      const home = teams.get(game.home_team_id);
      const away = teams.get(game.away_team_id);
      if (!home || !away) {
        throw new Error(
          `Winner 16 game ${game.game_number} is missing a canonical team.`,
        );
      }

      return {
        roundGameId: game.id,
        fixtureId: game.fixture_id,
        number: game.game_number,
        home,
        away,
        league: game.competition_name_snapshot,
        kickoffAt: game.kickoff_at,
        status: game.status,
      };
    });

    return {
      roundId: round.id,
      externalRoundNumber: round.external_round_number,
      startsAt: round.starts_at,
      lockAt: round.lock_at,
      status: round.status,
      games: normalizedGames,
    };
  }
}
