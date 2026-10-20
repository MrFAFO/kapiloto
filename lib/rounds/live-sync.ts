import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";
import {
  TelesportWinner16Provider,
  type TelesportGameState,
} from "./telesport";

type RoundRow = {
  id: string;
  external_round_number: string;
  status: string;
};

type RoundGameRow = {
  id: string;
  game_number: number;
  status: string;
  field_home_score: number | null;
  field_away_score: number | null;
  settlement_status: string;
  pool_settlement_outcome: string | null;
  last_synced_at: string | null;
};

export type AutomaticLiveSyncResult =
  | {
      status: "synced";
      roundId: string;
      roundNumber: string;
      fetchedAt: string;
      touchedGames: number;
      settledGames: number;
      underReviewGames: number;
    }
  | {
      status: "fresh";
      roundId: string;
      roundNumber: string;
      lastSyncedAt: string;
    }
  | {
      status: "round_settled";
      roundId: string;
      roundNumber: string;
    }
  | {
      status: "round_not_found";
      roundId: string;
    }
  | {
      status: "source_round_mismatch";
      roundId: string;
      expectedRoundNumber: string;
      sourceRoundNumber: string;
    };

function liveSyncMinSeconds(): number {
  const parsed = Number(process.env.KAPILOTO_LIVE_SYNC_MIN_SECONDS ?? "25");
  if (!Number.isInteger(parsed) || parsed < 10 || parsed > 300) return 25;
  return parsed;
}

function latestCompleteSyncAt(games: RoundGameRow[]): string | null {
  if (games.length !== 16 || games.some((game) => !game.last_synced_at)) {
    return null;
  }

  const oldest = Math.min(
    ...games.map((game) => Date.parse(game.last_synced_at as string)),
  );
  return Number.isFinite(oldest) ? new Date(oldest).toISOString() : null;
}

function preserveMonotonicStatus(
  current: string,
  incoming: TelesportGameState["status"],
): TelesportGameState["status"] {
  if (current === "finished" && ["upcoming", "live", "halftime"].includes(incoming)) {
    return "finished";
  }

  if (
    (current === "live" || current === "halftime") &&
    incoming === "upcoming"
  ) {
    return current;
  }

  return incoming;
}

export function buildTelesportGameUpdate(
  game: RoundGameRow,
  source: TelesportGameState,
  sourceVersion: string,
  fetchedAt: string,
): Json {
  const status = preserveMonotonicStatus(game.status, source.status);
  const update: Record<string, Json> = {
    round_game_id: game.id,
    status,
    observed_at: fetchedAt,
  };

  if (source.homeScore != null && source.awayScore != null) {
    update.home_score = source.homeScore;
    update.away_score = source.awayScore;
  }

  const settlementSource = `telesport-winner16:${sourceVersion}`;

  if (source.status === "finished" && source.outcome) {
    update.pool_settlement_status = "settled";
    update.pool_outcome = source.outcome;
    update.settlement_source = settlementSource;
  } else if (
    source.status === "postponed" ||
    source.status === "cancelled" ||
    source.status === "suspended" ||
    source.status === "under_review"
  ) {
    update.pool_settlement_status = "under_review";
    update.settlement_source = settlementSource;
  }

  return update;
}

const inFlightByRound = new Map<string, Promise<AutomaticLiveSyncResult>>();

async function syncOnce(
  client: SupabaseClient<Database>,
  roundId: string,
  now: Date,
): Promise<AutomaticLiveSyncResult> {
  const { data: roundData, error: roundError } = await client
    .from("rounds")
    .select("id,external_round_number,status")
    .eq("id", roundId)
    .maybeSingle();

  if (roundError) {
    throw new Error(`Failed to load live-sync round: ${roundError.message}`);
  }
  if (!roundData) {
    return { status: "round_not_found", roundId };
  }

  const round = roundData as RoundRow;
  if (round.status === "settled") {
    return {
      status: "round_settled",
      roundId: round.id,
      roundNumber: round.external_round_number,
    };
  }

  const { data: gamesData, error: gamesError } = await client
    .from("round_games")
    .select(
      "id,game_number,status,field_home_score,field_away_score,settlement_status,pool_settlement_outcome,last_synced_at",
    )
    .eq("round_id", round.id)
    .order("game_number", { ascending: true });

  if (gamesError) {
    throw new Error(`Failed to load live-sync games: ${gamesError.message}`);
  }

  const games = (gamesData ?? []) as RoundGameRow[];
  if (games.length !== 16) {
    throw new Error(
      `Winner 16 live sync requires 16 games; got ${games.length}.`,
    );
  }

  const completeSyncAt = latestCompleteSyncAt(games);
  if (
    completeSyncAt &&
    now.getTime() - Date.parse(completeSyncAt) < liveSyncMinSeconds() * 1_000
  ) {
    return {
      status: "fresh",
      roundId: round.id,
      roundNumber: round.external_round_number,
      lastSyncedAt: completeSyncAt,
    };
  }

  const source = await new TelesportWinner16Provider({
    now: () => now,
  }).getCurrentState();

  if (source.externalRoundNumber !== round.external_round_number) {
    return {
      status: "source_round_mismatch",
      roundId: round.id,
      expectedRoundNumber: round.external_round_number,
      sourceRoundNumber: source.externalRoundNumber,
    };
  }

  let touchedGames = 0;
  let settledGames = 0;
  let underReviewGames = 0;

  for (const game of games) {
    const sourceGame = source.games[game.game_number - 1];
    if (!sourceGame || sourceGame.gameNumber !== game.game_number) {
      throw new Error(
        `Telesport live sync is missing game ${game.game_number}.`,
      );
    }

    if (
      game.settlement_status === "settled" ||
      game.settlement_status === "void"
    ) {
      touchedGames += 1;
      continue;
    }

    const payload = buildTelesportGameUpdate(
      game,
      sourceGame,
      source.sourceVersion,
      source.fetchedAt,
    );

    const { error } = await client.rpc("toto_apply_game_state_v1", {
      p_update: payload,
    });
    if (error) {
      throw new Error(
        `Failed to apply Winner 16 game ${game.game_number} state: ${error.message}`,
      );
    }

    touchedGames += 1;
    if (sourceGame.status === "finished" && sourceGame.outcome) {
      settledGames += 1;
    } else if (
      sourceGame.status === "postponed" ||
      sourceGame.status === "cancelled" ||
      sourceGame.status === "suspended" ||
      sourceGame.status === "under_review"
    ) {
      underReviewGames += 1;
    }
  }

  return {
    status: "synced",
    roundId: round.id,
    roundNumber: round.external_round_number,
    fetchedAt: source.fetchedAt,
    touchedGames,
    settledGames,
    underReviewGames,
  };
}

export async function runAutomaticLiveSync(
  client: SupabaseClient<Database>,
  roundId: string,
  options: { now?: Date } = {},
): Promise<AutomaticLiveSyncResult> {
  const existing = inFlightByRound.get(roundId);
  if (existing) return existing;

  const promise = syncOnce(client, roundId, options.now ?? new Date()).finally(() => {
    inFlightByRound.delete(roundId);
  });
  inFlightByRound.set(roundId, promise);

  return promise;
}
