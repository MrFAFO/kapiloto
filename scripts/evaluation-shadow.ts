import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { requiredHistoryLookbackDays } from "../lib/evaluation/arms";
import { backtestDeterministicArms } from "../lib/evaluation/backtest";
import { captureRoundMarketQuotes } from "../lib/evaluation/market-capture";
import { ingestLeagueResults } from "../lib/evaluation/results-ingest";
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

function envOrThrow(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for this command.`);
  return value;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const client = adminClient();
  const store = new SupabaseShadowEvaluationStore(client);
  const roundFixtures = async () => store.loadRoundFixtureIds(required(args, "round"));
  let result: unknown;

  switch (command) {
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
        new ApiFootballClient(envOrThrow("API_FOOTBALL_API_KEY"), {
          minRequestIntervalMs: getApiFootballMinRequestIntervalMs(),
        }),
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
