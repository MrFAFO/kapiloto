import {
  ingestFootballIlSeasonAnalytics,
  type FootballIlFactContext,
  type FootballIlFactStore,
  type FootballIlSeasonAnalyticsSource,
} from "./football-il-parse-facts";
import type {
  FootballIlFixture,
  FootballIlTeam,
} from "./football-il-parse";

export type FootballIlRoundTeam = {
  teamId: string;
  canonicalName: string;
  aliases: string[];
  providerTeamId: string | null;
  providerName: string | null;
};

export type FootballIlRoundGame = {
  roundGameId: string;
  fixtureId: string;
  gameNumber: number;
  kickoffAt: string;
  competitionId: string | null;
  competitionName: string;
  home: FootballIlRoundTeam;
  away: FootballIlRoundTeam;
  providerFixtureId: number | null;
};

export type FootballIlResolvedFixture = {
  game: FootballIlRoundGame;
  providerFixtureId: number;
  tournamentId: number;
  home: {
    providerTeamId: number;
    providerName: string | null;
  };
  away: {
    providerTeamId: number;
    providerName: string | null;
  };
  capturedAt: string;
  resolution: "provided_id" | "exact_team_match";
};

export interface FootballIlSyncStore extends FootballIlFactStore {
  loadRoundGames(roundId: string): Promise<FootballIlRoundGame[]>;
  saveResolvedFixture(snapshot: FootballIlResolvedFixture): Promise<void>;
}

export interface FootballIlSyncClient extends FootballIlSeasonAnalyticsSource {
  getAllTeams(tournamentId: number): Promise<{ teams: FootballIlTeam[] }>;
  getTeamFixtures(
    teamId: number,
  ): Promise<{ fixtures: FootballIlFixture[] } | FootballIlFixture[]>;
  getMatchDetails(gameId: number): Promise<FootballIlFixture>;
}

export type FootballIlFixtureSyncResult = {
  gameNumber: number;
  roundGameId: string;
  fixtureId: string;
  status: "saved" | "unsupported" | "not_found" | "ambiguous" | "error";
  providerFixtureId: string | null;
  tournamentId: number | null;
  season: string | null;
  seasonRows: number;
  factsWritten: number;
  error: string | null;
};

export type FootballIlRoundSyncResult = {
  roundId: string;
  startedAt: string;
  completedAt: string;
  fixtures: FootballIlFixtureSyncResult[];
  summary: {
    requested: number;
    saved: number;
    unsupported: number;
    notFound: number;
    ambiguous: number;
    errors: number;
    seasonRows: number;
    factsWritten: number;
  };
};

type TeamResolution =
  | { status: "resolved"; team: FootballIlTeam }
  | { status: "not_found" | "ambiguous"; team: null };

function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/קריית/g, "קרית")
    .replace(/תקווה/g, "תקוה")
    .replace(/[״"'׳’‘´.\-_/()[\]{}:,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function footballIlTournamentId(
  competitionName: string,
): 902 | 719 | null {
  const normalized = normalizeName(competitionName);

  if (
    normalized === "ligat haal" ||
    normalized.includes("ליגת העל")
  ) {
    return 902;
  }

  if (
    normalized === "liga leumit" ||
    normalized.includes("ליגה לאומית")
  ) {
    return 719;
  }

  return null;
}

export function footballIlSeasonForKickoff(kickoffAt: string): string {
  const date = new Date(kickoffAt);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid kickoff timestamp for football.co.il season.");
  }

  const year = date.getUTCFullYear();
  const startYear = date.getUTCMonth() >= 6 ? year : year - 1;
  const short = (value: number) => String(value % 100).padStart(2, "0");
  return `${short(startYear)}/${short(startYear + 1)}`;
}

function teamNames(team: FootballIlTeam): string[] {
  return [
    team.name,
    team.hebrewName,
    team.hebrewFullName,
    team.arabicName,
  ].filter((value): value is string => Boolean(value?.trim()));
}

function resolveTeam(
  input: FootballIlRoundTeam,
  teams: FootballIlTeam[],
): TeamResolution {
  if (input.providerTeamId != null) {
    const mapped = teams.filter(
      (team) => String(team.id) === input.providerTeamId,
    );
    if (mapped.length === 1) return { status: "resolved", team: mapped[0] };
    return {
      status: mapped.length > 1 ? "ambiguous" : "not_found",
      team: null,
    };
  }

  const expected = new Set(
    [input.canonicalName, ...input.aliases]
      .map(normalizeName)
      .filter(Boolean),
  );

  const matches = teams.filter((team) =>
    teamNames(team).some((name) => expected.has(normalizeName(name))),
  );

  if (matches.length === 1) {
    return { status: "resolved", team: matches[0] };
  }

  return {
    status: matches.length > 1 ? "ambiguous" : "not_found",
    team: null,
  };
}

function fixtureTeamId(value: FootballIlFixture["homeTeamId"]): number {
  return typeof value === "number" ? value : value.id;
}

function fixtureTeamName(
  value: FootballIlFixture["homeTeamId"],
): string | null {
  if (typeof value === "number") return null;
  return value.hebrewFullName ?? value.hebrewName ?? value.name ?? null;
}

function fixtureRows(
  response: { fixtures: FootballIlFixture[] } | FootballIlFixture[],
): FootballIlFixture[] {
  return Array.isArray(response) ? response : response.fixtures;
}

function kickoffDistanceMs(
  fixture: FootballIlFixture,
  kickoffAt: string,
): number {
  if (!fixture.date?.sec) return Number.POSITIVE_INFINITY;
  const target = new Date(kickoffAt).getTime();
  if (!Number.isFinite(target)) return Number.POSITIVE_INFINITY;
  return Math.abs(fixture.date.sec * 1000 - target);
}

function ensureFixtureOrientation(
  game: FootballIlRoundGame,
  fixture: FootballIlFixture,
): void {
  if (
    game.home.providerTeamId != null &&
    Number(game.home.providerTeamId) !== fixtureTeamId(fixture.homeTeamId)
  ) {
    throw new Error(
      `football.co.il home-team mapping mismatch for Toto game ${game.gameNumber}.`,
    );
  }

  if (
    game.away.providerTeamId != null &&
    Number(game.away.providerTeamId) !== fixtureTeamId(fixture.awayTeamId)
  ) {
    throw new Error(
      `football.co.il away-team mapping mismatch for Toto game ${game.gameNumber}.`,
    );
  }
}

function factContext(
  game: FootballIlRoundGame,
  resolved: FootballIlResolvedFixture,
): FootballIlFactContext {
  return {
    fixtureId: game.fixtureId,
    providerGameId: String(resolved.providerFixtureId),
    capturedAt: resolved.capturedAt,
    home: {
      canonicalTeamId: game.home.teamId,
      providerTeamId: String(resolved.home.providerTeamId),
    },
    away: {
      canonicalTeamId: game.away.teamId,
      providerTeamId: String(resolved.away.providerTeamId),
    },
  };
}

export async function syncFootballIlRoundAnalytics(
  store: FootballIlSyncStore,
  client: FootballIlSyncClient,
  roundId: string,
  clock: () => Date = () => new Date(),
): Promise<FootballIlRoundSyncResult> {
  const startedAt = clock().toISOString();
  const games = await store.loadRoundGames(roundId);
  const fixtures: FootballIlFixtureSyncResult[] = [];

  const teamsByTournament = new Map<number, FootballIlTeam[]>();
  const fixturesByTeam = new Map<number, FootballIlFixture[]>();

  async function loadTeams(tournamentId: number): Promise<FootballIlTeam[]> {
    const cached = teamsByTournament.get(tournamentId);
    if (cached) return cached;
    const response = await client.getAllTeams(tournamentId);
    teamsByTournament.set(tournamentId, response.teams);
    return response.teams;
  }

  async function loadTeamFixtures(teamId: number): Promise<FootballIlFixture[]> {
    const cached = fixturesByTeam.get(teamId);
    if (cached) return cached;
    const rows = fixtureRows(await client.getTeamFixtures(teamId));
    fixturesByTeam.set(teamId, rows);
    return rows;
  }

  for (const game of [...games].sort((a, b) => a.gameNumber - b.gameNumber)) {
    const tournamentId = footballIlTournamentId(game.competitionName);

    if (tournamentId == null) {
      fixtures.push({
        gameNumber: game.gameNumber,
        roundGameId: game.roundGameId,
        fixtureId: game.fixtureId,
        status: "unsupported",
        providerFixtureId: null,
        tournamentId: null,
        season: null,
        seasonRows: 0,
        factsWritten: 0,
        error: null,
      });
      continue;
    }

    try {
      let resolved: FootballIlResolvedFixture | null = null;

      if (game.providerFixtureId != null) {
        const fixture = await client.getMatchDetails(game.providerFixtureId);
        ensureFixtureOrientation(game, fixture);

        resolved = {
          game,
          providerFixtureId: fixture.id,
          tournamentId,
          home: {
            providerTeamId: fixtureTeamId(fixture.homeTeamId),
            providerName: fixtureTeamName(fixture.homeTeamId),
          },
          away: {
            providerTeamId: fixtureTeamId(fixture.awayTeamId),
            providerName: fixtureTeamName(fixture.awayTeamId),
          },
          capturedAt: clock().toISOString(),
          resolution: "provided_id",
        };
      } else {
        const teams = await loadTeams(tournamentId);
        const home = resolveTeam(game.home, teams);
        const away = resolveTeam(game.away, teams);

        if (home.status !== "resolved" || away.status !== "resolved") {
          const ambiguous =
            home.status === "ambiguous" || away.status === "ambiguous";
          fixtures.push({
            gameNumber: game.gameNumber,
            roundGameId: game.roundGameId,
            fixtureId: game.fixtureId,
            status: ambiguous ? "ambiguous" : "not_found",
            providerFixtureId: null,
            tournamentId,
            season: null,
            seasonRows: 0,
            factsWritten: 0,
            error: null,
          });
          continue;
        }

        const candidates = (await loadTeamFixtures(home.team.id))
          .filter((fixture) => fixture.league === tournamentId)
          .filter(
            (fixture) =>
              fixtureTeamId(fixture.homeTeamId) === home.team.id &&
              fixtureTeamId(fixture.awayTeamId) === away.team.id,
          )
          .map((fixture) => ({
            fixture,
            distance: kickoffDistanceMs(fixture, game.kickoffAt),
          }))
          .filter(({ distance }) => distance <= 12 * 60 * 60 * 1000)
          .sort((a, b) => a.distance - b.distance);

        if (candidates.length === 0) {
          fixtures.push({
            gameNumber: game.gameNumber,
            roundGameId: game.roundGameId,
            fixtureId: game.fixtureId,
            status: "not_found",
            providerFixtureId: null,
            tournamentId,
            season: null,
            seasonRows: 0,
            factsWritten: 0,
            error: null,
          });
          continue;
        }

        if (
          candidates.length > 1 &&
          candidates[0].distance === candidates[1].distance
        ) {
          fixtures.push({
            gameNumber: game.gameNumber,
            roundGameId: game.roundGameId,
            fixtureId: game.fixtureId,
            status: "ambiguous",
            providerFixtureId: null,
            tournamentId,
            season: null,
            seasonRows: 0,
            factsWritten: 0,
            error: null,
          });
          continue;
        }

        const fixture = candidates[0].fixture;
        resolved = {
          game,
          providerFixtureId: fixture.id,
          tournamentId,
          home: {
            providerTeamId: home.team.id,
            providerName:
              fixtureTeamName(fixture.homeTeamId) ??
              home.team.hebrewFullName ??
              home.team.hebrewName ??
              home.team.name ??
              null,
          },
          away: {
            providerTeamId: away.team.id,
            providerName:
              fixtureTeamName(fixture.awayTeamId) ??
              away.team.hebrewFullName ??
              away.team.hebrewName ??
              away.team.name ??
              null,
          },
          capturedAt: clock().toISOString(),
          resolution: "exact_team_match",
        };
      }

      await store.saveResolvedFixture(resolved);
      const season = footballIlSeasonForKickoff(game.kickoffAt);
      const analytics = await ingestFootballIlSeasonAnalytics(
        client,
        store,
        factContext(game, resolved),
        season,
      );

      fixtures.push({
        gameNumber: game.gameNumber,
        roundGameId: game.roundGameId,
        fixtureId: game.fixtureId,
        status: "saved",
        providerFixtureId: String(resolved.providerFixtureId),
        tournamentId,
        season,
        seasonRows: analytics.rawRows,
        factsWritten: analytics.factsWritten,
        error: null,
      });
    } catch (error) {
      fixtures.push({
        gameNumber: game.gameNumber,
        roundGameId: game.roundGameId,
        fixtureId: game.fixtureId,
        status: "error",
        providerFixtureId: null,
        tournamentId,
        season: null,
        seasonRows: 0,
        factsWritten: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    roundId,
    startedAt,
    completedAt: clock().toISOString(),
    fixtures,
    summary: {
      requested: fixtures.length,
      saved: fixtures.filter((fixture) => fixture.status === "saved").length,
      unsupported: fixtures.filter(
        (fixture) => fixture.status === "unsupported",
      ).length,
      notFound: fixtures.filter(
        (fixture) => fixture.status === "not_found",
      ).length,
      ambiguous: fixtures.filter(
        (fixture) => fixture.status === "ambiguous",
      ).length,
      errors: fixtures.filter((fixture) => fixture.status === "error").length,
      seasonRows: fixtures.reduce(
        (total, fixture) => total + fixture.seasonRows,
        0,
      ),
      factsWritten: fixtures.reduce(
        (total, fixture) => total + fixture.factsWritten,
        0,
      ),
    },
  };
}
