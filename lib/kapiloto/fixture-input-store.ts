import type { SupabaseClient } from "@supabase/supabase-js";

import type { FixtureCardInput } from "./fixture-card";

type RoundGameRow = {
  id: string;
  fixture_id: string;
  round_id: string;
  game_number: number;
  home_team_id: string;
  away_team_id: string;
  competition_id: string | null;
  competition_name_snapshot: string;
  competition_stage_snapshot: string | null;
  leg_number: number | null;
  aggregate_home_score: number | null;
  aggregate_away_score: number | null;
  neutral_venue: boolean;
  kickoff_at: string;
  settlement_rule: string | null;
};

type TeamRow = {
  id: string;
  canonical_name: string;
};

type TeamAliasRow = {
  team_id: string;
  alias: string;
};

type TeamMappingRow = {
  team_id: string;
  provider_name: string | null;
};

type MarketSnapshotRow = {
  id: string;
  fixture_id: string;
  captured_at: string;
  p_1_bp: number;
  p_x_bp: number;
  p_2_bp: number;
};

export const UNINFORMATIVE_LEAGUE_BASE_PRIOR = {
  home: 3334,
  draw: 3333,
  away: 3333,
} as const;

export type FixtureInputRows = {
  games: RoundGameRow[];
  teams: TeamRow[];
  teamAliases: TeamAliasRow[];
  teamMappings: TeamMappingRow[];
  marketSnapshots: MarketSnapshotRow[];
};

function latestSnapshotByFixture(
  snapshots: MarketSnapshotRow[],
  cutoffAt: string,
): Map<string, MarketSnapshotRow> {
  const cutoffMs = Date.parse(cutoffAt);
  if (!Number.isFinite(cutoffMs)) {
    throw new Error(`Invalid research cutoff: ${cutoffAt}`);
  }

  const latest = new Map<string, MarketSnapshotRow>();

  for (const snapshot of snapshots) {
    const capturedMs = Date.parse(snapshot.captured_at);
    if (!Number.isFinite(capturedMs) || capturedMs > cutoffMs) continue;

    const current = latest.get(snapshot.fixture_id);
    if (
      !current ||
      Date.parse(current.captured_at) < capturedMs
    ) {
      latest.set(snapshot.fixture_id, snapshot);
    }
  }

  return latest;
}

function aliasesByTeam(
  aliasRows: TeamAliasRow[],
  mappingRows: TeamMappingRow[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();

  const add = (teamId: string, rawAlias: string | null | undefined) => {
    const alias = rawAlias?.trim();
    if (!alias) return;

    const aliases = map.get(teamId) ?? [];
    if (
      !aliases.some(
        (value) => value.toLocaleLowerCase() === alias.toLocaleLowerCase(),
      )
    ) {
      aliases.push(alias);
    }
    map.set(teamId, aliases);
  };

  for (const row of aliasRows) add(row.team_id, row.alias);
  for (const row of mappingRows) add(row.team_id, row.provider_name);

  return map;
}

export function assembleFixtureCardInputs(
  rows: FixtureInputRows,
  researchCutoffAt: string,
): FixtureCardInput[] {
  if (rows.games.length !== 16) {
    throw new Error(`Expected 16 round games; got ${rows.games.length}.`);
  }

  const sortedGames = [...rows.games].sort(
    (a, b) => a.game_number - b.game_number,
  );
  for (let index = 0; index < sortedGames.length; index += 1) {
    if (sortedGames[index].game_number !== index + 1) {
      throw new Error("Round games must contain Toto numbers 1..16 exactly once.");
    }
  }

  const teams = new Map(rows.teams.map((team) => [team.id, team]));
  const aliases = aliasesByTeam(rows.teamAliases, rows.teamMappings);
  const priors = latestSnapshotByFixture(rows.marketSnapshots, researchCutoffAt);

  return sortedGames.map((game) => {
    const home = teams.get(game.home_team_id);
    const away = teams.get(game.away_team_id);
    const prior = priors.get(game.fixture_id);

    if (!home || !away) {
      throw new Error(`Missing canonical team row for Toto game ${game.game_number}.`);
    }
    return {
      fixtureId: game.fixture_id,
      roundId: game.round_id,
      roundGameId: game.id,
      gameNumber: game.game_number,
      home: {
        id: home.id,
        canonicalName: home.canonical_name,
        aliases: aliases.get(home.id) ?? [],
      },
      away: {
        id: away.id,
        canonicalName: away.canonical_name,
        aliases: aliases.get(away.id) ?? [],
      },
      competition: {
        id: game.competition_id,
        name: game.competition_name_snapshot,
        stage: game.competition_stage_snapshot,
        leg: game.leg_number,
        aggregateHome: game.aggregate_home_score,
        aggregateAway: game.aggregate_away_score,
      },
      kickoffAt: game.kickoff_at,
      neutralVenue: game.neutral_venue,
      settlementRule: game.settlement_rule,
      prior:
        prior == null
          ? {
              type: "league_base",
              snapshotId: null,
              capturedAt: null,
              probabilitiesBp: {
                ...UNINFORMATIVE_LEAGUE_BASE_PRIOR,
              },
            }
          : {
              type: "market",
              snapshotId: prior.id,
              capturedAt: prior.captured_at,
              probabilitiesBp: {
                home: prior.p_1_bp,
                draw: prior.p_x_bp,
                away: prior.p_2_bp,
              },
            },
    };
  });
}

export async function loadRoundFixtureCardInputs(
  client: SupabaseClient,
  roundId: string,
  researchCutoffAt: string,
  provider = "api-football",
): Promise<FixtureCardInput[]> {
  const { data: gamesData, error: gamesError } = await client
    .from("round_games")
    .select(
      "id,fixture_id,round_id,game_number,home_team_id,away_team_id,competition_id,competition_name_snapshot,competition_stage_snapshot,leg_number,aggregate_home_score,aggregate_away_score,neutral_venue,kickoff_at,settlement_rule",
    )
    .eq("round_id", roundId)
    .order("game_number", { ascending: true });

  if (gamesError) {
    throw new Error(`Failed to load round games: ${gamesError.message}`);
  }

  const games = (gamesData ?? []) as RoundGameRow[];
  const teamIds = [
    ...new Set(games.flatMap((game) => [game.home_team_id, game.away_team_id])),
  ];
  const fixtureIds = games.map((game) => game.fixture_id);

  const [
    { data: teamsData, error: teamsError },
    { data: aliasesData, error: aliasesError },
    { data: mappingsData, error: mappingsError },
    { data: marketsData, error: marketsError },
  ] = await Promise.all([
    client.from("teams").select("id,canonical_name").in("id", teamIds),
    client
      .from("team_aliases")
      .select("team_id,alias")
      .in("team_id", teamIds),
    client
      .from("provider_team_mappings")
      .select("team_id,provider_name")
      .eq("provider", provider)
      .in("team_id", teamIds),
    client
      .from("fixture_market_snapshots")
      .select("id,fixture_id,captured_at,p_1_bp,p_x_bp,p_2_bp")
      .eq("provider", provider)
      .in("fixture_id", fixtureIds)
      .lte("captured_at", researchCutoffAt)
      .order("captured_at", { ascending: false }),
  ]);

  if (teamsError) {
    throw new Error(`Failed to load teams: ${teamsError.message}`);
  }
  if (aliasesError) {
    throw new Error(`Failed to load canonical team aliases: ${aliasesError.message}`);
  }
  if (mappingsError) {
    throw new Error(`Failed to load provider team aliases: ${mappingsError.message}`);
  }
  if (marketsError) {
    throw new Error(`Failed to load market priors: ${marketsError.message}`);
  }

  return assembleFixtureCardInputs(
    {
      games,
      teams: (teamsData ?? []) as TeamRow[],
      teamAliases: (aliasesData ?? []) as TeamAliasRow[],
      teamMappings: (mappingsData ?? []) as TeamMappingRow[],
      marketSnapshots: (marketsData ?? []) as MarketSnapshotRow[],
    },
    researchCutoffAt,
  );
}
