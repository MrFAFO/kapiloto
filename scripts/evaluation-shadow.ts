import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  buildDeterministicArmPredictions,
  EVAL_ARM,
  EVAL_SAFETY_MARGIN_MINUTES,
  requiredHistoryLookbackDays,
} from "../lib/evaluation/arms";
import { backtestDeterministicArms } from "../lib/evaluation/backtest";
import { shadowCycleConfigFromEnv } from "../lib/evaluation/env";
import type { HistoricalMatchResult } from "../lib/evaluation/history";
import {
  captureGameQuotes,
  captureRoundMarketQuotes,
  type MarketQuoteDraft,
  type ProviderRequestMeter,
} from "../lib/evaluation/market-capture";
import { DEFAULT_CADENCE_CONFIG, simulateCaptureSchedule } from "../lib/evaluation/market-cadence";
import type { MarketQuoteRecord } from "../lib/evaluation/market-prior";
import { buildShadowRoundReport } from "../lib/evaluation/report";
import {
  backfillRange,
  DEFAULT_BACKFILL_YEARS,
  ingestLeagueResults,
  type MatchResultRow,
} from "../lib/evaluation/results-ingest";
import { runShadowEvaluationCycle } from "../lib/evaluation/shadow-cycle";
import {
  projectKapilotoPublications,
  recordForwardDeterministicArms,
  recordReplayDeterministicArms,
  scoreShadowFixtures,
} from "../lib/evaluation/shadow-jobs";
import {
  SHADOW_HISTORY_PROVIDER,
  SupabaseMarketQuoteStore,
  SupabaseMatchResultStore,
  SupabaseShadowEvaluationStore,
} from "../lib/evaluation/supabase-store";
import { getApiFootballMinRequestIntervalMs } from "../lib/kapiloto/research-config";
import { ApiFootballClient } from "../lib/providers/api-football";
import { SupabaseApiFootballSyncStore } from "../lib/providers/api-football-supabase-store";
import { SportmonksClient } from "../lib/providers/sportmonks";

const USAGE = `Kapiloto shadow evaluation (server-side, never user-facing)

Read-only:
  dry-run          --round <id> [--years N] [--probe-market]
                   reads production + providers, writes nothing
  report           --round <id>                      operator coverage report

Writes evaluation tables only (migration must be applied):
  cycle            --round <id>                      one scheduled-cron pass
  backfill-results [--years N] [--league <sportmonks id>] [--dry-run]
  record           --round <id>                      forward B1-B4 at now
  replay           --round <id> [--lead-minutes N]   deterministic replay B1-B4
  project-kapiloto --round <id>                      B5 from immutable publications
  score            --round <id> --mode forward|replay [--persist]
  capture-market   --round <id>                      append raw API-Football quotes
  ingest-results   --league <sportmonks id> --from YYYY-MM-DD --to YYYY-MM-DD
  backtest         --league <sportmonks id> --from YYYY-MM-DD --to YYYY-MM-DD

Requires SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SECRET_KEY;
provider commands also need API_FOOTBALL_API_KEY or SPORTMONKS_API_TOKEN.`;

function flag(args: string[], name: string): string | null {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function required(args: string[], name: string): string {
  const value = flag(args, name);
  if (!value) throw new Error(`--${name} is required.\n\n${USAGE}`);
  return value;
}

function adminClient(): SupabaseClient {
  const url =
    process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!url || !secretKey) {
    throw new Error(
      "SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SECRET_KEY are required.",
    );
  }
  return createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

const MUTATIONS = new Set(["insert", "upsert", "update", "delete"]);

/** Supabase client whose table builders refuse every mutation. */
function readOnlyClient(client: SupabaseClient): SupabaseClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "rpc") {
        return () => {
          throw new Error("read-only dry run: rpc is not allowed");
        };
      }
      if (property === "from") {
        return (table: string) => {
          const builder = target.from(table);
          return new Proxy(builder, {
            get(inner, key) {
              if (typeof key === "string" && MUTATIONS.has(key)) {
                throw new Error(`read-only dry run: ${key} on ${table}`);
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

/** Counts outgoing requests per host and blocks non-GET requests to Supabase. */
function installFetchGuard(supabaseUrl: string | null): Record<string, number> {
  const counts: Record<string, number> = {};
  const supabaseHost = supabaseUrl ? new URL(supabaseUrl).host : null;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url.host === supabaseHost && method !== "GET" && method !== "HEAD") {
      throw new Error(`read-only dry run: blocked ${method} to Supabase`);
    }
    counts[url.host] = (counts[url.host] ?? 0) + 1;
    return original(input, init);
  };
  return counts;
}

function envOrNull(name: string): string | null {
  return process.env[name]?.trim() || null;
}

function envOrThrow(name: string): string {
  const value = envOrNull(name);
  if (!value) throw new Error(`${name} is required for this command.`);
  return value;
}

function apiFootballClient(meter: ProviderRequestMeter): ApiFootballClient {
  return new ApiFootballClient(envOrThrow("API_FOOTBALL_API_KEY"), {
    minRequestIntervalMs: getApiFootballMinRequestIntervalMs(),
    onResponse: (info) => {
      meter.requests += 1;
      if (info.dailyRemaining != null) meter.dailyRemaining = info.dailyRemaining;
    },
  });
}

function toHistory(rows: MatchResultRow[]): HistoricalMatchResult[] {
  return rows.map((row) => ({
    provider: row.provider,
    providerFixtureId: row.provider_fixture_id,
    competitionKey: `${row.provider}:${row.provider_competition_id}`,
    kickoffAt: row.kickoff_at,
    homeTeamKey: `${row.provider}:${row.provider_home_team_id}`,
    awayTeamKey: `${row.provider}:${row.provider_away_team_id}`,
    homeGoals: row.home_goals_90,
    awayGoals: row.away_goals_90,
    neutralVenue: row.neutral_venue,
  }));
}

async function dryRun(args: string[]) {
  const supabaseUrl =
    process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || null;
  const requestCounts = installFetchGuard(supabaseUrl);
  const client = readOnlyClient(adminClient());
  const store = new SupabaseShadowEvaluationStore(client);
  const roundId = required(args, "round");
  const years = Number(flag(args, "years") ?? DEFAULT_BACKFILL_YEARS);
  const now = new Date();
  const fixtureIds = await store.loadRoundFixtureIds(roundId);
  const contexts = await store.loadFixtureContexts(fixtureIds);
  const leagues = await store.loadSupportedCompetitionKeys();
  const range = backfillRange(now, years);
  const output: Record<string, unknown> = {
    generatedAt: now.toISOString(),
    roundId,
    fixtures: fixtureIds.length,
    mappedContexts: {
      competition: contexts.filter((context) => context.competitionKey).length,
      bothTeams: contexts.filter((context) => context.homeTeamKey && context.awayTeamKey).length,
      neutralVenue: contexts.filter((context) => context.neutralVenue).length,
    },
    supportedLeagues: leagues,
    backfillRange: range,
  };

  const historyByLeague = new Map<string, HistoricalMatchResult[]>();
  const sportmonksToken = envOrNull("SPORTMONKS_API_TOKEN");
  if (!sportmonksToken) {
    output.history = "not_measured: SPORTMONKS_API_TOKEN is not set";
  } else {
    const sportmonks = new SportmonksClient(sportmonksToken);
    const perLeague: Record<string, unknown> = {};
    for (const league of leagues) {
      const leagueId = league.slice(league.indexOf(":") + 1);
      const collected: MatchResultRow[] = [];
      try {
        const summary = await ingestLeagueResults(sportmonks, null, {
          leagueId,
          ...range,
          now,
          dryRun: true,
          onRows: (rows) => collected.push(...rows),
        });
        const history = toHistory(collected);
        historyByLeague.set(league, history);
        const backtestFrom = new Date(now.getTime() - 365 * 86_400_000).toISOString();
        perLeague[league] = {
          ...summary,
          backtestLast365Days: backtestDeterministicArms(history, {
            competitionKey: league,
            fromAt: backtestFrom,
            toAt: now.toISOString(),
          }).summaries,
        };
      } catch (error) {
        perLeague[league] = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    output.history = perLeague;
    output.sportmonksNotices = sportmonks.emptyResponseNotices.slice(0, 50);
  }

  let marketDrafts = new Map<string, MarketQuoteDraft[]>();
  const apiFootballKey = envOrNull("API_FOOTBALL_API_KEY");
  if (!apiFootballKey) {
    output.market = "not_measured: API_FOOTBALL_API_KEY is not set";
  } else {
    const meter: ProviderRequestMeter = { requests: 0, dailyRemaining: null };
    const apiFootball = apiFootballClient(meter);
    const account = await apiFootball.getAccountStatus().catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    const market: Record<string, unknown> = { account };
    const remaining =
      "dailyLimit" in account && account.dailyLimit != null && account.requestsToday != null
        ? account.dailyLimit - account.requestsToday
        : null;
    if (!args.includes("--probe-market")) {
      market.coverage = "not_probed: pass --probe-market to spend ~1 request per fixture";
    } else if (remaining != null && remaining < 60) {
      market.coverage = `not_probed: only ${remaining} daily requests remain`;
    } else {
      const games = await new SupabaseApiFootballSyncStore(client).loadRoundGames(roundId);
      const perFixture: Array<Record<string, unknown>> = [];
      marketDrafts = new Map();
      for (const game of games) {
        const drafts: MarketQuoteDraft[] = [];
        const outcome = await captureGameQuotes(game, apiFootball, {
          async saveQuotes(rows) {
            drafts.push(...rows);
            return rows.length;
          },
        });
        marketDrafts.set(game.fixtureId, drafts);
        perFixture.push({
          game: game.gameNumber,
          competition: game.competitionName,
          status: outcome.status,
          bookmakers: outcome.bookmakers,
          providerFixtureId: outcome.providerFixtureId,
          latestProviderUpdate:
            drafts.map((draft) => draft.source_updated_at).filter(Boolean).sort().at(-1) ?? null,
          error: outcome.error,
        });
      }
      market.coverage = perFixture;
      market.requestsUsed = meter.requests;
      market.dailyRemainingAfter = meter.dailyRemaining;
    }
    output.market = market;
  }

  const lookback = requiredHistoryLookbackDays();
  output.currentFixtureArms = await Promise.all(
    contexts.map(async (context) => {
      const deadlineMs = Date.parse(context.kickoffAt) - EVAL_SAFETY_MARGIN_MINUTES * 60_000;
      const cutoffAt = new Date(Math.min(now.getTime(), deadlineMs)).toISOString();
      const history = (context.competitionKey && historyByLeague.get(context.competitionKey)) || [];
      const quotes: MarketQuoteRecord[] = (marketDrafts.get(context.fixtureId) ?? []).map(
        (draft, index) => ({
          id: `dry-${index}`,
          fixtureId: context.fixtureId,
          provider: draft.provider,
          bookmakerId: draft.bookmaker_id,
          bookmakerName: draft.bookmaker_name ?? draft.bookmaker_id,
          capturedAt: cutoffAt,
          sourceUpdatedAt: null,
          odds: { home: draft.odds_home, draw: draft.odds_draw, away: draft.odds_away },
        }),
      );
      const drafts = buildDeterministicArmPredictions({
        context,
        cutoffAt,
        mode: "forward",
        history: history.filter(
          (match) => Date.parse(match.kickoffAt) >= Date.parse(cutoffAt) - lookback * 86_400_000,
        ),
        quotes,
      });
      const state = (arm: string) => {
        const draft = drafts.find((item) => item.arm === arm);
        return draft?.valid ? "valid" : `unavailable:${draft?.invalid_reason}`;
      };
      return {
        fixtureId: context.fixtureId,
        kickoffAt: context.kickoffAt,
        competition: context.competitionKey,
        leagueBase: state(EVAL_ARM.leagueBase),
        pStat: state(EVAL_ARM.pStat),
        market: state(EVAL_ARM.market),
      };
    }),
  );

  const fixtures = await store.loadFixturesForEvaluation(fixtureIds);
  const roundSchedule = fixtures.map((fixture) => ({
    fixtureId: fixture.fixtureId,
    kickoffAt: fixture.kickoffAt,
  }));
  const firstKickoff = Math.min(...roundSchedule.map((fixture) => Date.parse(fixture.kickoffAt)));
  output.cadenceEstimate = {
    cadence: DEFAULT_CADENCE_CONFIG,
    budget: shadowCycleConfigFromEnv(process.env).budget,
    remainderOfCurrentRound: simulateCaptureSchedule(roundSchedule, {
      fromAt: now.toISOString(),
      cronMinute: 7,
    }),
    fullRoundFromSevenDaysBefore: simulateCaptureSchedule(roundSchedule, {
      fromAt: new Date(firstKickoff - 7 * 86_400_000).toISOString(),
      cronMinute: 7,
    }),
  };
  output.outboundRequestsByHost = requestCounts;
  return output;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (command === "dry-run") {
    process.stdout.write(`${JSON.stringify(await dryRun(args), null, 2)}\n`);
    return;
  }

  const client = adminClient();
  const store = new SupabaseShadowEvaluationStore(client);
  const roundFixtures = async () => store.loadRoundFixtureIds(required(args, "round"));
  let result: unknown;

  switch (command) {
    case "report":
      result = await buildShadowRoundReport(new SupabaseShadowEvaluationStore(readOnlyClient(client)), {
        roundId: required(args, "round"),
        now: new Date(),
      });
      break;
    case "cycle": {
      const meter: ProviderRequestMeter = { requests: 0, dailyRemaining: null };
      result = await runShadowEvaluationCycle({
        store,
        roundId: required(args, "round"),
        loadRoundGames: (roundId) => new SupabaseApiFootballSyncStore(client).loadRoundGames(roundId),
        market: envOrNull("API_FOOTBALL_API_KEY")
          ? { source: apiFootballClient(meter), meter }
          : null,
        now: new Date(),
        config: shadowCycleConfigFromEnv(process.env),
      });
      break;
    }
    case "backfill-results": {
      const years = Number(flag(args, "years") ?? DEFAULT_BACKFILL_YEARS);
      const leagueFlag = flag(args, "league");
      const leagues = leagueFlag
        ? [`${SHADOW_HISTORY_PROVIDER}:${leagueFlag}`]
        : await store.loadSupportedCompetitionKeys();
      const dry = args.includes("--dry-run");
      const sportmonks = new SportmonksClient(envOrThrow("SPORTMONKS_API_TOKEN"));
      const sink = dry ? null : new SupabaseMatchResultStore(client);
      const summaries = [];
      for (const league of leagues) {
        summaries.push(
          await ingestLeagueResults(sportmonks, sink, {
            leagueId: league.slice(league.indexOf(":") + 1),
            ...backfillRange(new Date(), years),
            dryRun: dry,
          }),
        );
      }
      result = { summaries, notices: sportmonks.emptyResponseNotices };
      break;
    }
    case "record":
      result = await recordForwardDeterministicArms(store, {
        fixtureIds: await roundFixtures(),
      });
      break;
    case "replay":
      result = await recordReplayDeterministicArms(store, {
        fixtureIds: await roundFixtures(),
        leadMinutes: Number(flag(args, "lead-minutes") ?? 0),
      });
      break;
    case "project-kapiloto":
      result = await projectKapilotoPublications(store, {
        fixtureIds: await roundFixtures(),
      });
      break;
    case "score": {
      const mode = required(args, "mode");
      if (mode !== "forward" && mode !== "replay") throw new Error("--mode must be forward or replay.");
      const scored = await scoreShadowFixtures(store, {
        fixtureIds: await roundFixtures(),
        mode,
        persist: args.includes("--persist"),
      });
      result = { ...scored, scores: undefined };
      break;
    }
    case "capture-market": {
      const games = await new SupabaseApiFootballSyncStore(client).loadRoundGames(
        required(args, "round"),
      );
      result = await captureRoundMarketQuotes(
        games,
        apiFootballClient({ requests: 0, dailyRemaining: null }),
        new SupabaseMarketQuoteStore(client),
      );
      break;
    }
    case "ingest-results":
      result = await ingestLeagueResults(
        new SportmonksClient(envOrThrow("SPORTMONKS_API_TOKEN")),
        new SupabaseMatchResultStore(client),
        {
          leagueId: required(args, "league"),
          startDate: required(args, "from"),
          endDate: required(args, "to"),
        },
      );
      break;
    case "backtest": {
      const from = `${required(args, "from")}T00:00:00Z`;
      const to = `${required(args, "to")}T00:00:00Z`;
      const competitionKey = `${SHADOW_HISTORY_PROVIDER}:${required(args, "league")}`;
      const spanDays = Math.ceil((Date.parse(to) - Date.parse(from)) / 86_400_000);
      const history = await store.loadHistory(
        competitionKey,
        to,
        spanDays + requiredHistoryLookbackDays(),
      );
      result = backtestDeterministicArms(history, {
        competitionKey,
        fromAt: from,
        toAt: to,
      }).summaries;
      break;
    }
    default:
      throw new Error(`Unknown command ${command}.\n\n${USAGE}`);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
