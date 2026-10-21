import type { Json } from "@/lib/supabase/database.types";

export type TotoRoundTeamInput = {
  canonicalName: string;
  countryCode?: string | null;
  languageCode?: string | null;
  aliases?: string[];
};

export type TotoRoundCompetitionInput = {
  canonicalName: string;
  countryCode?: string | null;
  competitionType?: string | null;
};

export type TotoRoundGameInput = {
  gameNumber: number;
  home: TotoRoundTeamInput;
  away: TotoRoundTeamInput;
  competition: TotoRoundCompetitionInput;
  kickoffAt: string;
  seasonKey?: string | null;
  stageName?: string | null;
  roundName?: string | null;
  legNumber?: number | null;
  aggregateHomeScore?: number | null;
  aggregateAwayScore?: number | null;
  neutralVenue?: boolean;
  fixtureStatus?:
    | "upcoming"
    | "live"
    | "halftime"
    | "finished"
    | "postponed"
    | "cancelled"
    | "suspended"
    | "under_review";
  settlementRule?: string | null;
};

export type TotoRoundSnapshotInput = {
  source: string;
  externalRoundNumber: string;
  sourceVersion: string;
  startsAt: string;
  lockAt: string;
  status:
    | "upcoming"
    | "open"
    | "locked"
    | "live"
    | "finished"
    | "settled"
    | "under_review";
  games: TotoRoundGameInput[];
};

export type TotoRoundImportResult = {
  roundId: string;
  externalRoundNumber: string;
  source: string;
  sourceVersion: string;
  gamesImported: number;
  createdTeams: number;
  createdCompetitions: number;
  createdFixtures: number;
};

function nonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required.`);
  return trimmed;
}

function isoTime(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be an ISO-8601 timestamp.`);
  }
  return new Date(parsed).toISOString();
}

function normalizeTeam(
  team: TotoRoundTeamInput,
  field: string,
): Record<string, Json> {
  return {
    canonical_name: nonEmpty(team.canonicalName, `${field}.canonicalName`),
    country_code: team.countryCode?.trim().toUpperCase() || null,
    language_code: team.languageCode?.trim() || null,
    aliases: [
      ...new Set(
        (team.aliases ?? [])
          .map((alias) => alias.trim())
          .filter((alias) => alias.length > 0),
      ),
    ],
  };
}

export function validateTotoRoundSnapshot(
  snapshot: TotoRoundSnapshotInput,
): TotoRoundSnapshotInput {
  nonEmpty(snapshot.source, "source");
  nonEmpty(snapshot.externalRoundNumber, "externalRoundNumber");
  nonEmpty(snapshot.sourceVersion, "sourceVersion");
  isoTime(snapshot.startsAt, "startsAt");
  isoTime(snapshot.lockAt, "lockAt");

  if (snapshot.games.length !== 16) {
    throw new Error(
      `Winner 16 snapshot requires exactly 16 games; got ${snapshot.games.length}.`,
    );
  }

  const numbers = snapshot.games
    .map((game) => game.gameNumber)
    .sort((a, b) => a - b);

  for (let index = 0; index < 16; index += 1) {
    if (numbers[index] !== index + 1) {
      throw new Error("Winner 16 game numbers must be exactly 1..16.");
    }
  }

  for (const game of snapshot.games) {
    nonEmpty(game.home.canonicalName, `game ${game.gameNumber} home`);
    nonEmpty(game.away.canonicalName, `game ${game.gameNumber} away`);
    nonEmpty(
      game.competition.canonicalName,
      `game ${game.gameNumber} competition`,
    );
    isoTime(game.kickoffAt, `game ${game.gameNumber} kickoffAt`);

    if (
      game.home.canonicalName.trim().toLocaleLowerCase() ===
      game.away.canonicalName.trim().toLocaleLowerCase()
    ) {
      throw new Error(
        `Winner 16 game ${game.gameNumber} cannot use the same team twice.`,
      );
    }
  }

  return snapshot;
}

export function serializeTotoRoundSnapshot(
  snapshot: TotoRoundSnapshotInput,
): Json {
  validateTotoRoundSnapshot(snapshot);

  return {
    source: snapshot.source.trim(),
    external_round_number: snapshot.externalRoundNumber.trim(),
    source_version: snapshot.sourceVersion.trim(),
    starts_at: isoTime(snapshot.startsAt, "startsAt"),
    lock_at: isoTime(snapshot.lockAt, "lockAt"),
    status: snapshot.status,
    games: [...snapshot.games]
      .sort((a, b) => a.gameNumber - b.gameNumber)
      .map((game) => ({
        game_number: game.gameNumber,
        home: normalizeTeam(game.home, `game ${game.gameNumber}.home`),
        away: normalizeTeam(game.away, `game ${game.gameNumber}.away`),
        competition: {
          canonical_name: nonEmpty(
            game.competition.canonicalName,
            `game ${game.gameNumber}.competition.canonicalName`,
          ),
          country_code:
            game.competition.countryCode?.trim().toUpperCase() || null,
          competition_type:
            game.competition.competitionType?.trim() || null,
        },
        kickoff_at: isoTime(
          game.kickoffAt,
          `game ${game.gameNumber}.kickoffAt`,
        ),
        season_key: game.seasonKey?.trim() || null,
        stage_name: game.stageName?.trim() || null,
        round_name: game.roundName?.trim() || null,
        leg_number: game.legNumber ?? null,
        aggregate_home_score: game.aggregateHomeScore ?? null,
        aggregate_away_score: game.aggregateAwayScore ?? null,
        neutral_venue: game.neutralVenue ?? false,
        fixture_status: game.fixtureStatus ?? "upcoming",
        settlement_rule:
          game.settlementRule?.trim() ||
          "result_after_90_minutes_including_stoppage_time",
      })),
  };
}

export function parseTotoRoundImportResult(value: Json): TotoRoundImportResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Round import RPC returned an invalid payload.");
  }

  const row = value as Record<string, Json | undefined>;
  const requiredStrings = [
    "round_id",
    "external_round_number",
    "source",
    "source_version",
  ] as const;
  const requiredNumbers = [
    "games_imported",
    "created_teams",
    "created_competitions",
    "created_fixtures",
  ] as const;

  for (const field of requiredStrings) {
    if (typeof row[field] !== "string") {
      throw new Error(`Round import RPC omitted ${field}.`);
    }
  }
  for (const field of requiredNumbers) {
    if (typeof row[field] !== "number") {
      throw new Error(`Round import RPC omitted ${field}.`);
    }
  }

  return {
    roundId: row.round_id as string,
    externalRoundNumber: row.external_round_number as string,
    source: row.source as string,
    sourceVersion: row.source_version as string,
    gamesImported: row.games_imported as number,
    createdTeams: row.created_teams as number,
    createdCompetitions: row.created_competitions as number,
    createdFixtures: row.created_fixtures as number,
  };
}
