import type { SupabaseClient } from "@supabase/supabase-js";

import type { HistoricalMatchResult } from "@/lib/evaluation/history";
import { ingestLeagueResults, type MatchResultRow } from "@/lib/evaluation/results-ingest";
import { SupabaseFixtureStructuredSnapshotStore } from "@/lib/football-features/supabase-store";
import { ApiFootballClient } from "@/lib/providers/api-football";
import { SupabaseApiFootballSyncStore } from "@/lib/providers/api-football-supabase-store";
import type { ApiFootballRoundGame } from "@/lib/providers/api-football-sync";
import { SportmonksClient } from "@/lib/providers/sportmonks";

import type { LiveDevFixtureIdentity, LiveDevProviders, MarketInput } from "./live-dev-runner";

/**
 * Real provider access for the live-dev runner. Every database access goes
 * through `readOnlySupabaseClient`; every network request goes through the
 * fetch guard, which allows only GET to Supabase and only the two football
 * data providers. Nothing here can reach a language model.
 */

const MUTATIONS = new Set(["insert", "upsert", "update", "delete"]);
const TRUSTED = ["confirmed", "manual_override"];

/** Supabase client whose builders refuse every mutation, RPC, storage and function call. */
export function readOnlySupabaseClient(client: SupabaseClient): SupabaseClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "rpc" || property === "storage" || property === "functions") {
        throw new Error(`live_dev_read_only: ${String(property)} is not allowed`);
      }
      if (property === "from") {
        return (table: string) => {
          const builder = target.from(table);
          return new Proxy(builder, {
            get(inner, key) {
              if (typeof key === "string" && MUTATIONS.has(key)) {
                throw new Error(`live_dev_read_only: ${key} on ${table}`);
              }
              const value = Reflect.get(inner, key);
              return typeof value === "function" ? value.bind(inner) : value;
            },
          });
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

export const LIVE_DEV_ALLOWED_PROVIDER_HOSTS = ["api.sportmonks.com", "v3.football.api-sports.io"] as const;

/**
 * Replaces global fetch: GET/HEAD only to Supabase, and only the football data
 * provider hosts otherwise. Returns a restore function.
 */
export function installLiveDevFetchGuard(supabaseUrl: string): () => void {
  const supabaseHost = new URL(supabaseUrl).host;
  const allowed = new Set<string>([supabaseHost, ...LIVE_DEV_ALLOWED_PROVIDER_HOSTS]);
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (!allowed.has(url.host)) throw new Error(`live_dev_fetch_blocked: host ${url.host} is not allowed`);
    if (url.host === supabaseHost && method !== "GET" && method !== "HEAD") {
      throw new Error(`live_dev_fetch_blocked: ${method} to Supabase`);
    }
    if (url.host !== supabaseHost && method !== "GET") throw new Error(`live_dev_fetch_blocked: ${method} to ${url.host}`);
    return original(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** Replay mode: any network request at all is an error. Returns a restore function. */
export function installNoNetworkGuard(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    throw new Error(`live_dev_replay_network_blocked: ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

type Row = Record<string, unknown>;

async function rows(query: PromiseLike<{ data: unknown; error: { message: string } | null }>, context: string): Promise<Row[]> {
  const { data, error } = await query;
  if (error) throw new Error(`${context}: ${error.message}`);
  return (data ?? []) as Row[];
}

const str = (value: unknown) => (value == null ? null : String(value));

function toHistory(row: MatchResultRow): HistoricalMatchResult {
  return {
    provider: row.provider,
    providerFixtureId: row.provider_fixture_id,
    competitionKey: `${row.provider}:${row.provider_competition_id}`,
    kickoffAt: row.kickoff_at,
    homeTeamKey: `${row.provider}:${row.provider_home_team_id}`,
    awayTeamKey: `${row.provider}:${row.provider_away_team_id}`,
    homeGoals: row.home_goals_90,
    awayGoals: row.away_goals_90,
    neutralVenue: row.neutral_venue,
  };
}

export function createLiveDevProviders(options: {
  client: SupabaseClient;
  roundId: string;
  fixtureIds: readonly string[];
  sportmonksToken: string;
  apiFootballKey: string;
  apiFootballMinIntervalMs: number;
  now?: () => Date;
}): LiveDevProviders {
  const client = readOnlySupabaseClient(options.client);
  const now = options.now ?? (() => new Date());
  const sportmonks = new SportmonksClient(options.sportmonksToken);
  const apiFootball = new ApiFootballClient(options.apiFootballKey, { minRequestIntervalMs: options.apiFootballMinIntervalMs });
  let roundGames: Promise<Map<string, ApiFootballRoundGame>> | null = null;
  const gameFor = async (fixtureId: string) => {
    roundGames ??= new SupabaseApiFootballSyncStore(client)
      .loadRoundGames(options.roundId)
      .then((games) => new Map(games.map((game) => [game.fixtureId, game])));
    return (await roundGames).get(fixtureId) ?? null;
  };

  return {
    now,
    async loadIdentities() {
      const fixtureIds = [...options.fixtureIds];
      // Explicit columns only: no score, outcome or settlement column is ever read.
      const games = await rows(
        client.from("round_games").select("id,round_id,game_number,fixture_id,competition_id,competition_name_snapshot").eq("round_id", options.roundId).in("fixture_id", fixtureIds),
        "round_games",
      );
      const fixtures = await rows(
        client.from("fixtures").select("id,competition_id,home_team_id,away_team_id,leg_number,neutral_venue,kickoff_at,status").in("id", fixtureIds),
        "fixtures",
      );
      const teamIds = [...new Set(fixtures.flatMap((fixture) => [String(fixture.home_team_id), String(fixture.away_team_id)]))];
      const competitionIds = [...new Set(fixtures.map((fixture) => str(fixture.competition_id)).filter((id): id is string => id != null))];
      const [teams, competitions, teamMaps, competitionMaps, fixtureMaps] = await Promise.all([
        rows(client.from("teams").select("id,canonical_name").in("id", teamIds), "teams"),
        competitionIds.length > 0 ? rows(client.from("competitions").select("id,canonical_name,competition_type").in("id", competitionIds), "competitions") : Promise.resolve([]),
        rows(client.from("provider_team_mappings").select("team_id,provider_team_id").eq("provider", "sportmonks").in("mapping_status", TRUSTED).in("team_id", teamIds), "provider_team_mappings"),
        competitionIds.length > 0
          ? rows(client.from("provider_competition_mappings").select("competition_id,provider_competition_id").eq("provider", "sportmonks").in("mapping_status", TRUSTED).in("competition_id", competitionIds), "provider_competition_mappings")
          : Promise.resolve([]),
        rows(client.from("provider_fixture_mappings").select("fixture_id,provider_fixture_id").eq("provider", "sportmonks").in("mapping_status", TRUSTED).in("fixture_id", fixtureIds), "provider_fixture_mappings"),
      ]);
      const teamName = (id: string) => String(teams.find((team) => team.id === id)?.canonical_name ?? id);
      const smTeam = (id: string) => str(teamMaps.find((map) => map.team_id === id)?.provider_team_id);
      return fixtures.flatMap((fixture): LiveDevFixtureIdentity[] => {
        const game = games.find((row) => row.fixture_id === fixture.id);
        if (!game) return [];
        const competitionId = str(fixture.competition_id ?? game.competition_id);
        const competition = competitions.find((row) => row.id === competitionId);
        return [{
          fixtureId: String(fixture.id),
          roundId: String(game.round_id),
          roundGameId: String(game.id),
          gameNumber: Number(game.game_number),
          homeTeamId: String(fixture.home_team_id),
          awayTeamId: String(fixture.away_team_id),
          homeName: teamName(String(fixture.home_team_id)),
          awayName: teamName(String(fixture.away_team_id)),
          competitionId,
          competitionName: String(game.competition_name_snapshot ?? competition?.canonical_name ?? ""),
          competitionType: str(competition?.competition_type),
          kickoffAt: new Date(String(fixture.kickoff_at)).toISOString(),
          status: String(fixture.status),
          neutralVenue: fixture.neutral_venue === true,
          legNumber: fixture.leg_number == null ? null : Number(fixture.leg_number),
          sportmonks: {
            leagueId: str(competitionMaps.find((map) => map.competition_id === competitionId)?.provider_competition_id),
            homeTeamId: smTeam(String(fixture.home_team_id)),
            awayTeamId: smTeam(String(fixture.away_team_id)),
            fixtureId: str(fixtureMaps.find((map) => map.fixture_id === fixture.id)?.provider_fixture_id),
          },
        }];
      });
    },

    async loadLeagueHistory(leagueId, window) {
      const collected: MatchResultRow[] = [];
      await ingestLeagueResults(sportmonks, null, {
        leagueId,
        startDate: window.startDate,
        endDate: window.endDate,
        now: now(),
        dryRun: true,
        onRows: (batch) => collected.push(...batch),
      });
      return collected.map(toHistory);
    },

    async loadMarket(identity): Promise<MarketInput> {
      const game = await gameFor(identity.fixtureId);
      if (!game) return { status: "unavailable", reason: "round_game_not_loaded", resolution: null, apiFootballFixtureId: null };
      const resolved = await apiFootball.resolveFixture({
        gameNumber: game.gameNumber,
        homeTeam: game.home.canonicalName,
        awayTeam: game.away.canonicalName,
        kickoffAt: game.kickoffAt,
        competition: game.competitionName,
        aliases: { home: game.home.aliases, away: game.away.aliases },
        apiFootballFixtureId: game.providerFixtureId ?? undefined,
        providerTeamIds: { home: game.home.providerTeamId, away: game.away.providerTeamId },
        providerCompetitionId: game.providerCompetitionId ?? null,
      });
      if (!resolved.fixture) {
        return { status: "unavailable", reason: `fixture_${resolved.resolution}`, resolution: resolved.resolution, apiFootballFixtureId: null };
      }
      const quotes = await apiFootball.getThreeWayQuotes(resolved.fixture);
      const capturedAt = now().toISOString();
      if (quotes.length === 0) {
        return { status: "unavailable", reason: "no_complete_quotes", resolution: resolved.resolution, apiFootballFixtureId: resolved.fixture.providerFixtureId };
      }
      return {
        status: "ok",
        capturedAt,
        apiFootballFixtureId: resolved.fixture.providerFixtureId,
        resolution: resolved.resolution,
        quotes: quotes
          .map((quote) => ({ bookmakerId: quote.bookmakerId, bookmakerName: quote.bookmakerName, sourceUpdatedAt: quote.capturedAt, odds: quote.odds }))
          .sort((a, b) => a.bookmakerId.localeCompare(b.bookmakerId)),
      };
    },

    async loadTriageContext(identity) {
      const snapshots = await new SupabaseFixtureStructuredSnapshotStore(client).loadLatestAtOrBefore([identity.fixtureId], now().toISOString());
      const snapshot = snapshots.get(identity.fixtureId) ?? null;
      const features = snapshot?.features;
      return {
        structuredSnapshotId: snapshot?.id ?? null,
        context: {
          managerChangeDaysAgo: { home: null, away: null },
          restDays: { home: features?.home.rest?.rest_days ?? null, away: features?.away.rest?.rest_days ?? null },
          matchesLast14Days: { home: features?.home.rest?.matches_last_14d ?? null, away: features?.away.rest?.matches_last_14d ?? null },
          competition: { isCup: identity.competitionType === "cup", isSecondLeg: identity.legNumber === 2 },
          promoted: { home: null, away: null },
          unresolvedAvailability: 0,
        },
      };
    },
  };
}
