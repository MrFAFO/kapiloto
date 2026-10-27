import type { SupabaseClient } from "@supabase/supabase-js";

import {
  mappingEvidence,
  type ApiFootballResolvedSnapshot,
  type ApiFootballRoundGame,
  type ApiFootballSyncStore,
  type MappingEvidence,
} from "./api-football-sync";

type GameRow = {
  id: string;
  fixture_id: string;
  game_number: number;
  kickoff_at: string;
  competition_id: string | null;
  competition_name_snapshot: string;
  home_team_id: string;
  away_team_id: string;
};

type TeamRow = {
  id: string;
  canonical_name: string;
};

type AliasRow = {
  team_id: string;
  alias: string;
};

type TeamMappingRow = {
  provider: string;
  team_id: string;
  provider_team_id: string;
  provider_name: string | null;
};

type CompetitionMappingRow = {
  competition_id: string;
  provider_competition_id: string;
};

/** Mapping states trusted for resolution; `unverified` rows are ignored. */
const TRUSTED_MAPPING_STATUSES = ["confirmed", "manual_override"];

type FixtureMappingRow = {
  fixture_id: string;
  provider_fixture_id: string;
};

function groupAliases(rows: AliasRow[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();

  for (const row of rows) {
    const aliases = grouped.get(row.team_id) ?? [];
    const alias = row.alias.trim();
    if (
      alias &&
      !aliases.some(
        (existing) => existing.toLocaleLowerCase() === alias.toLocaleLowerCase(),
      )
    ) {
      aliases.push(alias);
    }
    grouped.set(row.team_id, aliases);
  }

  return grouped;
}

export class SupabaseApiFootballSyncStore implements ApiFootballSyncStore {
  constructor(private readonly client: SupabaseClient) {}

  async loadRoundGames(roundId: string): Promise<ApiFootballRoundGame[]> {
    const { data: gamesData, error: gamesError } = await this.client
      .from("round_games")
      .select(
        "id,fixture_id,game_number,kickoff_at,competition_id,competition_name_snapshot,home_team_id,away_team_id",
      )
      .eq("round_id", roundId)
      .order("game_number", { ascending: true });

    if (gamesError) {
      throw new Error(`Failed to load round games: ${gamesError.message}`);
    }

    const games = (gamesData ?? []) as GameRow[];
    const teamIds = [
      ...new Set(games.flatMap((game) => [game.home_team_id, game.away_team_id])),
    ];
    const fixtureIds = games.map((game) => game.fixture_id);
    const competitionIds = [
      ...new Set(
        games
          .map((game) => game.competition_id)
          .filter((id): id is string => id != null),
      ),
    ];

    const [
      { data: teamsData, error: teamsError },
      { data: aliasesData, error: aliasesError },
      { data: teamMappingsData, error: teamMappingsError },
      { data: fixtureMappingsData, error: fixtureMappingsError },
      { data: competitionMappingsData, error: competitionMappingsError },
    ] = await Promise.all([
      this.client.from("teams").select("id,canonical_name").in("id", teamIds),
      this.client
        .from("team_aliases")
        .select("team_id,alias")
        .in("team_id", teamIds),
      // Every provider's trusted mapping: API-Football ids drive resolution;
      // other providers' names give an English identity for name bootstrap.
      this.client
        .from("provider_team_mappings")
        .select("provider,team_id,provider_team_id,provider_name")
        .in("mapping_status", TRUSTED_MAPPING_STATUSES)
        .in("team_id", teamIds),
      this.client
        .from("provider_fixture_mappings")
        .select("fixture_id,provider_fixture_id")
        .eq("provider", "api-football")
        .in("mapping_status", TRUSTED_MAPPING_STATUSES)
        .in("fixture_id", fixtureIds),
      competitionIds.length > 0
        ? this.client
            .from("provider_competition_mappings")
            .select("competition_id,provider_competition_id")
            .eq("provider", "api-football")
            .in("mapping_status", TRUSTED_MAPPING_STATUSES)
            .in("competition_id", competitionIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (teamsError) {
      throw new Error(`Failed to load teams: ${teamsError.message}`);
    }
    if (aliasesError) {
      throw new Error(`Failed to load team aliases: ${aliasesError.message}`);
    }
    if (teamMappingsError) {
      throw new Error(
        `Failed to load API-Football team mappings: ${teamMappingsError.message}`,
      );
    }
    if (fixtureMappingsError) {
      throw new Error(
        `Failed to load API-Football fixture mappings: ${fixtureMappingsError.message}`,
      );
    }
    if (competitionMappingsError) {
      throw new Error(
        `Failed to load API-Football competition mappings: ${competitionMappingsError.message}`,
      );
    }

    const teams = new Map(
      ((teamsData ?? []) as TeamRow[]).map((team) => [team.id, team]),
    );
    const mappingRows = (teamMappingsData ?? []) as TeamMappingRow[];
    const aliases = groupAliases([
      ...((aliasesData ?? []) as AliasRow[]),
      ...mappingRows
        .filter((mapping) => mapping.provider_name)
        .map((mapping) => ({
          team_id: mapping.team_id,
          alias: mapping.provider_name as string,
        })),
    ]);
    const teamMappings = new Map(
      mappingRows
        .filter((mapping) => mapping.provider === "api-football")
        .map((mapping) => [mapping.team_id, mapping]),
    );
    const competitionMappings = new Map(
      ((competitionMappingsData ?? []) as CompetitionMappingRow[]).map(
        (mapping) => [mapping.competition_id, mapping.provider_competition_id],
      ),
    );
    const fixtureMappings = new Map(
      ((fixtureMappingsData ?? []) as FixtureMappingRow[]).map((mapping) => [
        mapping.fixture_id,
        mapping.provider_fixture_id,
      ]),
    );

    return games.map((game) => {
      const home = teams.get(game.home_team_id);
      const away = teams.get(game.away_team_id);
      if (!home || !away) {
        throw new Error(
          `Missing canonical team for Toto game ${game.game_number}.`,
        );
      }

      const homeMapping = teamMappings.get(game.home_team_id);
      const awayMapping = teamMappings.get(game.away_team_id);

      const homeAliases = aliases.get(game.home_team_id) ?? [];
      const awayAliases = aliases.get(game.away_team_id) ?? [];

      const providerFixtureIdRaw = fixtureMappings.get(game.fixture_id);
      const providerFixtureId =
        providerFixtureIdRaw != null && /^\d+$/.test(providerFixtureIdRaw)
          ? Number(providerFixtureIdRaw)
          : null;

      return {
        roundGameId: game.id,
        fixtureId: game.fixture_id,
        gameNumber: game.game_number,
        kickoffAt: game.kickoff_at,
        competitionId: game.competition_id,
        competitionName: game.competition_name_snapshot,
        home: {
          teamId: home.id,
          canonicalName: home.canonical_name,
          aliases: [...new Set(homeAliases)],
          providerTeamId: homeMapping?.provider_team_id ?? null,
        },
        away: {
          teamId: away.id,
          canonicalName: away.canonical_name,
          aliases: [...new Set(awayAliases)],
          providerTeamId: awayMapping?.provider_team_id ?? null,
        },
        providerFixtureId,
        providerCompetitionId:
          game.competition_id != null
            ? (competitionMappings.get(game.competition_id) ?? null)
            : null,
      };
    });
  }

  async saveResolvedSnapshot(
    snapshot: ApiFootballResolvedSnapshot,
  ): Promise<void> {
    const evidence = mappingEvidence(snapshot);
    // Confirmed evidence refreshes (and may promote) a row; unverified evidence
    // only fills a gap and never overwrites or downgrades an existing row.
    const write = (level: MappingEvidence, onConflict: string) => ({
      onConflict,
      ignoreDuplicates: level === "unverified",
    });
    const confidence = (level: MappingEvidence) => (level === "confirmed" ? 1 : 0.9);

    const mappingWrites = [
      this.client.from("provider_fixture_mappings").upsert(
        {
          fixture_id: snapshot.game.fixtureId,
          round_game_id: snapshot.game.roundGameId,
          provider: "api-football",
          provider_fixture_id: snapshot.fixture.providerFixtureId,
          mapping_status: evidence.fixture,
          mapping_confidence: confidence(evidence.fixture),
          mapped_at: snapshot.capturedAt,
        },
        write(evidence.fixture, "fixture_id,provider"),
      ),
      this.client.from("provider_team_mappings").upsert(
        {
          provider: "api-football",
          provider_team_id: snapshot.fixture.home.id,
          team_id: snapshot.game.home.teamId,
          provider_name: snapshot.fixture.home.name,
          mapping_status: evidence.home,
          mapping_confidence: confidence(evidence.home),
          last_verified_at: snapshot.capturedAt,
        },
        write(evidence.home, "provider,provider_team_id"),
      ),
      this.client.from("provider_team_mappings").upsert(
        {
          provider: "api-football",
          provider_team_id: snapshot.fixture.away.id,
          team_id: snapshot.game.away.teamId,
          provider_name: snapshot.fixture.away.name,
          mapping_status: evidence.away,
          mapping_confidence: confidence(evidence.away),
          last_verified_at: snapshot.capturedAt,
        },
        write(evidence.away, "provider,provider_team_id"),
      ),
    ];

    if (snapshot.game.competitionId != null) {
      mappingWrites.push(
        this.client.from("provider_competition_mappings").upsert(
          {
            provider: "api-football",
            provider_competition_id: snapshot.fixture.competition.id,
            competition_id: snapshot.game.competitionId,
            provider_name: snapshot.fixture.competition.name,
            mapping_status: evidence.competition,
            last_verified_at: snapshot.capturedAt,
          },
          write(evidence.competition, "provider,provider_competition_id"),
        ),
      );
    }

    const mappingResults = await Promise.all(mappingWrites);
    const mappingError = mappingResults.find((result) => result.error)?.error;
    if (mappingError) {
      throw new Error(
        `Failed to persist API-Football mappings: ${mappingError.message}`,
      );
    }

    const { error: marketError } = await this.client
      .from("fixture_market_snapshots")
      .insert({
        fixture_id: snapshot.game.fixtureId,
        round_game_id: snapshot.game.roundGameId,
        provider: "api-football",
        market_type: "1x2_90m",
        captured_at: snapshot.capturedAt,
        p_1_bp: snapshot.marketPrior.probabilitiesBp.home,
        p_x_bp: snapshot.marketPrior.probabilitiesBp.draw,
        p_2_bp: snapshot.marketPrior.probabilitiesBp.away,
        source_version: `${snapshot.marketPrior.method};bookmakers=${snapshot.marketPrior.bookmakerCount}`,
      });

    if (marketError) {
      throw new Error(
        `Failed to persist market prior: ${marketError.message}`,
      );
    }

    const [{ error: fixtureError }, { error: gameError }] = await Promise.all([
      this.client
        .from("fixtures")
        .update({ last_synced_at: snapshot.capturedAt })
        .eq("id", snapshot.game.fixtureId),
      this.client
        .from("round_games")
        .update({ last_synced_at: snapshot.capturedAt })
        .eq("id", snapshot.game.roundGameId),
    ]);

    if (fixtureError) {
      throw new Error(
        `Failed to update canonical fixture sync timestamp: ${fixtureError.message}`,
      );
    }

    if (gameError) {
      throw new Error(
        `Failed to update round game sync timestamp: ${gameError.message}`,
      );
    }
  }
}
