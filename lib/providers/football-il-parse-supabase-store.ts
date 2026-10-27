import type { SupabaseClient } from "@supabase/supabase-js";

import { SupabaseFootballIlFactStore } from "./football-il-parse-facts";
import type {
  FootballIlResolvedFixture,
  FootballIlRoundGame,
  FootballIlSyncStore,
} from "./football-il-parse-sync";

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
  team_id: string;
  provider_team_id: string;
  provider_name: string | null;
};

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

export class SupabaseFootballIlSyncStore implements FootballIlSyncStore {
  private readonly facts: SupabaseFootballIlFactStore;

  constructor(private readonly client: SupabaseClient) {
    this.facts = new SupabaseFootballIlFactStore(client);
  }

  async loadRoundGames(roundId: string): Promise<FootballIlRoundGame[]> {
    const { data: gamesData, error: gamesError } = await this.client
      .from("round_games")
      .select(
        "id,fixture_id,game_number,kickoff_at,competition_id,competition_name_snapshot,home_team_id,away_team_id",
      )
      .eq("round_id", roundId)
      .order("game_number", { ascending: true });

    if (gamesError) {
      throw new Error("Failed to load round games: " + gamesError.message);
    }

    const games = (gamesData ?? []) as GameRow[];
    const teamIds = [
      ...new Set(games.flatMap((game) => [game.home_team_id, game.away_team_id])),
    ];
    const fixtureIds = games.map((game) => game.fixture_id);

    const [
      { data: teamsData, error: teamsError },
      { data: aliasesData, error: aliasesError },
      { data: teamMappingsData, error: teamMappingsError },
      { data: fixtureMappingsData, error: fixtureMappingsError },
    ] = await Promise.all([
      this.client.from("teams").select("id,canonical_name").in("id", teamIds),
      this.client
        .from("team_aliases")
        .select("team_id,alias")
        .in("team_id", teamIds),
      this.client
        .from("provider_team_mappings")
        .select("team_id,provider_team_id,provider_name")
        .eq("provider", "football-il-parse")
        .in("mapping_status", ["confirmed", "manual_override"])
        .in("team_id", teamIds),
      this.client
        .from("provider_fixture_mappings")
        .select("fixture_id,provider_fixture_id")
        .eq("provider", "football-il-parse")
        .in("mapping_status", ["confirmed", "manual_override"])
        .in("fixture_id", fixtureIds),
    ]);

    if (teamsError) {
      throw new Error("Failed to load teams: " + teamsError.message);
    }
    if (aliasesError) {
      throw new Error("Failed to load team aliases: " + aliasesError.message);
    }
    if (teamMappingsError) {
      throw new Error(
        "Failed to load football.co.il team mappings: " + teamMappingsError.message,
      );
    }
    if (fixtureMappingsError) {
      throw new Error(
        "Failed to load football.co.il fixture mappings: " + fixtureMappingsError.message,
      );
    }

    const teams = new Map(
      ((teamsData ?? []) as TeamRow[]).map((team) => [team.id, team]),
    );
    const aliases = groupAliases((aliasesData ?? []) as AliasRow[]);
    const teamMappings = new Map(
      ((teamMappingsData ?? []) as TeamMappingRow[]).map((mapping) => [
        mapping.team_id,
        mapping,
      ]),
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
          "Missing canonical team for Toto game " + game.game_number + ".",
        );
      }

      const homeMapping = teamMappings.get(game.home_team_id);
      const awayMapping = teamMappings.get(game.away_team_id);
      const providerFixtureIdRaw = fixtureMappings.get(game.fixture_id);

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
          aliases: aliases.get(home.id) ?? [],
          providerTeamId: homeMapping?.provider_team_id ?? null,
          providerName: homeMapping?.provider_name ?? null,
        },
        away: {
          teamId: away.id,
          canonicalName: away.canonical_name,
          aliases: aliases.get(away.id) ?? [],
          providerTeamId: awayMapping?.provider_team_id ?? null,
          providerName: awayMapping?.provider_name ?? null,
        },
        providerFixtureId:
          providerFixtureIdRaw != null && /^\d+$/.test(providerFixtureIdRaw)
            ? Number(providerFixtureIdRaw)
            : null,
      };
    });
  }

  async hasFreshSeasonFacts(
    fixtureId: string,
    season: string,
    capturedAfter: string,
  ): Promise<boolean> {
    const { data, error } = await this.client
      .from("fixture_fact_snapshots")
      .select("subject_team_id,captured_at,metadata")
      .eq("fixture_id", fixtureId)
      .eq("provider", "football-il-parse")
      .eq("fact_key", "season.xg.expected")
      .gte("captured_at", capturedAfter);

    if (error) {
      throw new Error(
        "Failed to inspect football.co.il season facts: " + error.message,
      );
    }

    const teams = new Set<string>();
    for (const row of data ?? []) {
      const metadata =
        row.metadata != null && typeof row.metadata === "object"
          ? (row.metadata as Record<string, unknown>)
          : {};
      if (
        metadata.season === season &&
        typeof row.subject_team_id === "string" &&
        row.subject_team_id
      ) {
        teams.add(row.subject_team_id);
      }
    }

    return teams.size >= 2;
  }

  async saveResolvedFixture(
    snapshot: FootballIlResolvedFixture,
  ): Promise<void> {
    const mappingConfidence =
      snapshot.resolution === "provided_id" ? 1 : 0.99;

    const writes = [
      this.client.from("provider_fixture_mappings").upsert(
        {
          fixture_id: snapshot.game.fixtureId,
          round_game_id: snapshot.game.roundGameId,
          provider: "football-il-parse",
          provider_fixture_id: String(snapshot.providerFixtureId),
          mapping_status: "confirmed",
          mapping_confidence: mappingConfidence,
          mapped_at: snapshot.capturedAt,
        },
        { onConflict: "fixture_id,provider" },
      ),
      this.client.from("provider_team_mappings").upsert(
        {
          provider: "football-il-parse",
          provider_team_id: String(snapshot.home.providerTeamId),
          team_id: snapshot.game.home.teamId,
          provider_name:
            snapshot.home.providerName ?? snapshot.game.home.providerName,
          mapping_status: "confirmed",
          mapping_confidence: mappingConfidence,
          last_verified_at: snapshot.capturedAt,
        },
        { onConflict: "provider,provider_team_id" },
      ),
      this.client.from("provider_team_mappings").upsert(
        {
          provider: "football-il-parse",
          provider_team_id: String(snapshot.away.providerTeamId),
          team_id: snapshot.game.away.teamId,
          provider_name:
            snapshot.away.providerName ?? snapshot.game.away.providerName,
          mapping_status: "confirmed",
          mapping_confidence: mappingConfidence,
          last_verified_at: snapshot.capturedAt,
        },
        { onConflict: "provider,provider_team_id" },
      ),
    ];

    if (snapshot.game.competitionId != null) {
      writes.push(
        this.client.from("provider_competition_mappings").upsert(
          {
            provider: "football-il-parse",
            provider_competition_id: String(snapshot.tournamentId),
            competition_id: snapshot.game.competitionId,
            provider_name: snapshot.game.competitionName,
            mapping_status: "confirmed",
            last_verified_at: snapshot.capturedAt,
          },
          { onConflict: "provider,provider_competition_id" },
        ),
      );
    }

    const results = await Promise.all(writes);
    const mappingError = results.find((result) => result.error)?.error;

    if (mappingError) {
      throw new Error(
        "Failed to persist football.co.il mappings: " + mappingError.message,
      );
    }

    const { error: fixtureError } = await this.client
      .from("fixtures")
      .update({ last_synced_at: snapshot.capturedAt })
      .eq("id", snapshot.game.fixtureId);

    if (fixtureError) {
      throw new Error(
        "Failed to update canonical fixture sync timestamp: " + fixtureError.message,
      );
    }
  }

  saveFacts(
    facts: Parameters<SupabaseFootballIlFactStore["saveFacts"]>[0],
  ) {
    return this.facts.saveFacts(facts);
  }
}
