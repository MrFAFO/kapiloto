import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createClient } from "@supabase/supabase-js";

import { requiredHistoryLookbackDays } from "../lib/evaluation/arms";
import { CANDIDATE_DETERMINISTIC_BASE_CONFIG } from "../lib/research-v2/base";
import { CANDIDATE_COMBINATIONS } from "../lib/research-v2/combination";
import { CANDIDATE_LEAGUE_MEMBERSHIP_CONFIG } from "../lib/research-v2/league-membership";
import { FORMAL_SAMPLING_ENABLED, ROUND_264201_LIVE_DEV_FIXTURES } from "../lib/research-v2/live-dev";
import { createLiveDevProviders, installLiveDevFetchGuard, installNoNetworkGuard } from "../lib/research-v2/live-dev-providers";
import {
  captureLiveDevArtifact,
  DEFAULT_LIVE_DEV_MIN_LEAD_MINUTES,
  replayLiveDevArtifact,
  SPORTMONKS_HISTORY_FLOOR,
  type LiveDevArtifact,
  type ProviderHistoryFloor,
} from "../lib/research-v2/live-dev-runner";
import { CANDIDATE_TRIAGE_CONFIG } from "../lib/research-v2/triage";

const USAGE = `Research v2 live-dev deterministic-base runner (read-only, never published)

  capture --round <round id> [--min-lead-minutes 60] [--out <path>]
          [--history-floor YYYY-MM-DD | --no-history-floor]
          rereads fixture status, excludes started or too-close fixtures, loads
          Sportmonks history and API-Football odds, writes one local artifact
  replay  --artifact <path>
          recomputes the deterministic output from the stored inputs, no network

capture needs SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL), SUPABASE_SECRET_KEY
(read-only use), SPORTMONKS_API_TOKEN and API_FOOTBALL_API_KEY. It never
writes to any database, never calls a language model and never publishes.`;

function flag(args: string[], name: string): string | null {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for capture.`);
  return value;
}

async function capture(args: string[]) {
  if (FORMAL_SAMPLING_ENABLED) throw new Error("Formal sampling must stay disabled for live-dev runs.");
  const roundId = flag(args, "round");
  if (!roundId) throw new Error(`--round is required.\n\n${USAGE}`);
  const fixtureIds = ROUND_264201_LIVE_DEV_FIXTURES.filter((fixture) => fixture.roundId === roundId).map((fixture) => fixture.fixtureId);
  if (fixtureIds.length === 0) throw new Error(`No live-dev fixtures are tagged for round ${roundId}.`);
  const minLeadMinutes = Number(flag(args, "min-lead-minutes") ?? DEFAULT_LIVE_DEV_MIN_LEAD_MINUTES);
  if (!Number.isFinite(minLeadMinutes) || minLeadMinutes < DEFAULT_LIVE_DEV_MIN_LEAD_MINUTES) {
    throw new Error(`--min-lead-minutes must be at least ${DEFAULT_LIVE_DEV_MIN_LEAD_MINUTES}.`);
  }

  const historyFloor = resolveHistoryFloor(args);

  const supabaseUrl = process.env.SUPABASE_URL?.trim() || requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  const restoreFetch = installLiveDevFetchGuard(supabaseUrl);
  try {
    const providers = createLiveDevProviders({
      client: createClient(supabaseUrl, requiredEnv("SUPABASE_SECRET_KEY"), {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      }),
      roundId,
      fixtureIds,
      sportmonksToken: requiredEnv("SPORTMONKS_API_TOKEN"),
      apiFootballKey: requiredEnv("API_FOOTBALL_API_KEY"),
      apiFootballMinIntervalMs: Number(process.env.API_FOOTBALL_MIN_REQUEST_INTERVAL_MS ?? 6_500),
    });
    const artifact = await captureLiveDevArtifact({
      roundId,
      providers,
      configs: {
        base: CANDIDATE_DETERMINISTIC_BASE_CONFIG,
        combinations: CANDIDATE_COMBINATIONS,
        triage: CANDIDATE_TRIAGE_CONFIG,
        membership: CANDIDATE_LEAGUE_MEMBERSHIP_CONFIG,
      },
      minLeadMinutes,
      historyLookbackDays: requiredHistoryLookbackDays(),
      historyFloor,
    });
    const out =
      flag(args, "out") ??
      join("artifacts", "research-v2", `live-dev-${roundId}-${artifact.deterministic.inputs.executionCutoffAt.replace(/[:.]/g, "-")}.json`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
    return { out, artifactSha256: artifact.deterministic.artifactSha256, summary: artifact.deterministic.outputs.summary, guard: artifact.retrieval.guard };
  } finally {
    restoreFetch();
  }
}

/**
 * Default: the measured account floor. --history-floor records an operator
 * override as its own version; --no-history-floor requests the full lookback.
 */
function resolveHistoryFloor(args: string[]): ProviderHistoryFloor | null {
  if (args.includes("--no-history-floor")) return null;
  const override = flag(args, "history-floor");
  if (!override) return SPORTMONKS_HISTORY_FLOOR;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(override) || !Number.isFinite(Date.parse(`${override}T00:00:00Z`))) {
    throw new Error("--history-floor must be YYYY-MM-DD.");
  }
  return {
    ...SPORTMONKS_HISTORY_FLOOR,
    version: `${SPORTMONKS_HISTORY_FLOOR.version}+operator-${override}`,
    earliestDate: override,
    source: "operator override on the capture command line",
  };
}

function replay(args: string[]) {
  const path = flag(args, "artifact");
  if (!path) throw new Error(`--artifact is required.\n\n${USAGE}`);
  const artifact = JSON.parse(readFileSync(path, "utf8")) as LiveDevArtifact;
  const restoreFetch = installNoNetworkGuard();
  try {
    const result = replayLiveDevArtifact(artifact);
    return { identical: result.identical, artifactSha256: result.artifactSha256, stored: artifact.deterministic.artifactSha256 };
  } finally {
    restoreFetch();
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "capture") return capture(args);
  if (command === "replay") return replay(args);
  process.stdout.write(`${USAGE}\n`);
  return null;
}

main()
  .then((result) => {
    if (result) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
