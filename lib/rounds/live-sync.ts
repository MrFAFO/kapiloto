import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";
import {
  TelesportWinner16Provider,
  type TelesportGameState,
} from "./telesport";
import {
  israelDateKey,
  matchScores365FinalResult,
  Scores365ResultsProvider,
  type Scores365FinalResult,
} from "./scores365";

type RoundRow = {
  id: string;
  external_round_number: string;
  status: string;
};

type RoundGameRow = {
  id: string;
  game_number: number;
  home_team_id: string;
  away_team_id: string;
  kickoff_at: string;
  status: string;
  field_home_score: number | null;
  field_away_score: number | null;
  settlement_status: string;
  pool_settlement_outcome: string | null;
  last_synced_at: string | null;
};

type TeamRow = {
  id: string;
  canonical_name: string;
};

type TeamAliasRow = {
  team_id: string;
  alias: string;
};

type Scores365CrossCheck = {
  result: Scores365FinalResult;
  sourceVersion: string;
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
  scores365: Scores365CrossCheck | null = null,
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
    if (scores365) {
      const outcomeConflict = scores365.result.outcome !== source.outcome;
      const scoreConflict =
        source.homeScore != null &&
        source.awayScore != null &&
        (scores365.result.homeScore !== source.homeScore ||
          scores365.result.awayScore !== source.awayScore);
      const corroboratedSource =
        `${settlementSource};365scores:${scores365.sourceVersion}`;

      if (outcomeConflict || scoreConflict) {
        update.pool_settlement_status = "under_review";
        update.settlement_source = corroboratedSource;
      } else {
        update.pool_settlement_status = "settled";
        update.pool_outcome = source.outcome;
        update.settlement_source = corroboratedSource;
      }
    } else {
      update.pool_settlement_status = "settled";
      update.pool_outcome = source.outcome;
      update.settlement_source = settlementSource;
    }
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
      "id,game_number,home_team_id,away_team_id,kickoff_at,status,field_home_score,field_away_score,settlement_status,pool_settlement_outcome,last_synced_at",
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

  const teamIds = [
    ...new Set(
      games.flatMap((game) => [game.home_team_id, game.away_team_id]),
    ),
  ];
  const [
    { data: teamData, error: teamError },
    { data: aliasData, error: aliasError },
  ] = await Promise.all([
    client.from("teams").select("id,canonical_name").in("id", teamIds),
    client.from("team_aliases").select("team_id,alias").in("team_id", teamIds),
  ]);

  if (teamError) {
    throw new Error(
      `Failed to load team names for live cross-check: ${teamError.message}`,
    );
  }
  if (aliasError) {
    throw new Error(
      `Failed to load team aliases for live cross-check: ${aliasError.message}`,
    );
  }

  const namesByTeam = new Map<string, string[]>();
  for (const team of (teamData ?? []) as TeamRow[]) {
    namesByTeam.set(team.id, [team.canonical_name]);
  }
  for (const alias of (aliasData ?? []) as TeamAliasRow[]) {
    const names = namesByTeam.get(alias.team_id) ?? [];
    names.push(alias.alias);
    namesByTeam.set(alias.team_id, names);
  }

  const finishedDates = [
    ...new Set(
      games
        .filter((game) => {
          const sourceGame = source.games[game.game_number - 1];
          return sourceGame?.status === "finished" && Boolean(sourceGame.outcome);
        })
        .map((game) => israelDateKey(game.kickoff_at)),
    ),
  ];
  const scores365ByDate = new Map<
    string,
    Awaited<ReturnType<Scores365ResultsProvider["getFinalResultsForDate"]>>
  >();
  const scores365 = new Scores365ResultsProvider({ now: () => now });

  await Promise.all(
    finishedDates.map(async (date) => {
      try {
        const snapshot = await scores365.getFinalResultsForDate(date);
        scores365ByDate.set(date, snapshot);
      } catch {
        // Cross-check availability must never block the operational Telesport
        // live feed. No exact 365Scores result means the existing settlement
        // path remains unchanged.
      }
    }),
  );

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

    const date = israelDateKey(game.kickoff_at);
    const scoresSnapshot = scores365ByDate.get(date) ?? null;
    const scoresResult =
      scoresSnapshot == null
        ? null
        : matchScores365FinalResult(
            {
              kickoffAt: game.kickoff_at,
              homeNames: namesByTeam.get(game.home_team_id) ?? [],
              awayNames: namesByTeam.get(game.away_team_id) ?? [],
            },
            scoresSnapshot.results,
          );

    const payload = buildTelesportGameUpdate(
      game,
      sourceGame,
      source.sourceVersion,
      source.fetchedAt,
      scoresResult && scoresSnapshot
        ? {
            result: scoresResult,
            sourceVersion: scoresSnapshot.sourceVersion,
          }
        : null,
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
    const appliedPayload = payload as Record<string, unknown>;
    if (appliedPayload.pool_settlement_status === "settled") {
      settledGames += 1;
    } else if (appliedPayload.pool_settlement_status === "under_review") {
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
