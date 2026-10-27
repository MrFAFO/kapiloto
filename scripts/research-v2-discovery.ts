import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  baseAgeGate,
  eligibilityRecord,
  planFromSnapshot,
  replayDiscoveryArtifact,
  snapshotFromBase,
  verifySnapshot,
  type DiscoveryArtifact,
  type ResearchConfigs,
  type SearchNames,
} from "../lib/research-v2/discovery-artifact";
import type { LiveDevArtifact } from "../lib/research-v2/live-dev-runner";
import { blockAllNetwork } from "../lib/research-v2/network-block";

const USAGE = `Research v2 discovery runner (live_dev only; never published, never a formal sample)

  plan     --base-artifact <path> [--search-names <path>]
           freshness, eligibility (as stored) and the discovery plan per fixture;
           makes no model, web, provider or database call
  research --round <round id> --search-names <path> [--game <n>]
           captures a fresh deterministic base, then researches each eligible
           fixture that has search names (Sol discovery, safe fetch, gpt-6-luna);
           writes one discovery artifact. Needs SUPABASE_URL (or
           NEXT_PUBLIC_SUPABASE_URL), SUPABASE_SECRET_KEY, SPORTMONKS_API_TOKEN,
           API_FOOTBALL_API_KEY and OPENAI_API_KEY. No database write.
  replay   --artifact <path> [--base-artifact <path>]
           recomputes every deterministic stage offline; all network blocked

search-names file: { "<game number or fixture id>": { "home": { "en": "...", "source": [] }, "away": { ... } } }`;

function flag(args: string[], name: string): string | null {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

function namesFor(names: Record<string, SearchNames> | null, gameNumber: number, fixtureId: string): SearchNames | null {
  if (!names) return null;
  return names[String(gameNumber)] ?? names[fixtureId] ?? null;
}

function plan(args: string[]) {
  const basePath = flag(args, "base-artifact");
  if (!basePath) throw new Error(`--base-artifact is required.\n\n${USAGE}`);
  const base = readJson<LiveDevArtifact>(basePath);
  const namesPath = flag(args, "search-names");
  const names = namesPath ? readJson<Record<string, SearchNames>>(namesPath) : null;
  blockAllNetwork();
  return import("../lib/research-v2/discovery-plan").then(({ CANDIDATE_DISCOVERY_BUDGET, CANDIDATE_DISCOVERY_PLAN_CONFIG }) => {
    const now = new Date().toISOString();
    const freshness = { id: "research-v2-base-freshness", version: "research-base-freshness-v1", status: "candidate" as const, maxBaseAgeMinutes: 15 };
    return base.deterministic.inputs.fixtures.map((fixture) => {
      const snapshot = snapshotFromBase(base, fixture.identity.fixtureId);
      const identity = snapshot.fixtureInput.identity;
      const searchNames = namesFor(names, identity.gameNumber, identity.fixtureId) ?? { home: { en: identity.homeName, source: [] }, away: { en: identity.awayName, source: [] } };
      const discoveryPlan = planFromSnapshot(snapshot, searchNames, { plan: CANDIDATE_DISCOVERY_PLAN_CONFIG, budget: CANDIDATE_DISCOVERY_BUDGET });
      return {
        gameNumber: identity.gameNumber,
        competition: identity.competitionName,
        freshness: baseAgeGate(snapshot.baseCutoffAt, now, freshness),
        eligibilityAsStored: eligibilityRecord(snapshot, { status: identity.status, kickoffAt: identity.kickoffAt }, now, 60),
        tier: discoveryPlan?.tier ?? null,
        budget: discoveryPlan?.budget ?? null,
        needs: discoveryPlan?.needs.map((need) => ({ needId: need.needId, scope: need.scope, scopeReason: need.scopeReason, searchHints: need.searchHints })) ?? [],
        intendedCalls: discoveryPlan && discoveryPlan.needs.length > 0
          ? { solDiscovery: 1, maxRetries: 1, maxWebToolCalls: discoveryPlan.budget.maxWebToolCalls, maxFetchedPages: discoveryPlan.budget.maxFetchedPages, lunaBatchMaxItems: discoveryPlan.budget.maxJudgeItems }
          : null,
      };
    });
  });
}

function replay(args: string[]) {
  const path = flag(args, "artifact");
  if (!path) throw new Error(`--artifact is required.\n\n${USAGE}`);
  const artifact = readJson<DiscoveryArtifact>(path);
  const basePath = flag(args, "base-artifact");
  const base = basePath ? readJson<LiveDevArtifact>(basePath) : null;
  blockAllNetwork();
  const result = replayDiscoveryArtifact(artifact);
  return {
    identical: result.identical,
    artifactSha256: result.artifactSha256,
    stored: artifact.deterministic.artifactSha256,
    snapshotsVerified: result.snapshotsVerified,
    ...(base ? { baseCrossCheck: artifact.deterministic.inputs.fixtures.every((record) => verifySnapshot(record.snapshot, base)) } : {}),
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for research.`);
  return value;
}

/** Research network policy: GET to Supabase and the two football hosts, POST only to the Responses endpoint. */
function installResearchFetchGuard(supabaseUrl: string): () => void {
  const supabaseHost = new URL(supabaseUrl).host;
  const getHosts = new Set([supabaseHost, "api.sportmonks.com", "v3.football.api-sports.io"]);
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const modelCall = url.host === "api.openai.com" && method === "POST" && url.pathname === "/v1/responses";
    if (!modelCall && !(getHosts.has(url.host) && (method === "GET" || method === "HEAD"))) {
      throw new Error(`research_fetch_blocked: ${method} ${url.host}${url.pathname}`);
    }
    return original(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function research(args: string[]) {
  const roundId = flag(args, "round");
  const namesPath = flag(args, "search-names");
  if (!roundId || !namesPath) throw new Error(`--round and --search-names are required.\n\n${USAGE}`);
  const names = readJson<Record<string, SearchNames>>(namesPath);
  const onlyGame = flag(args, "game");
  const [{ createClient }, providersModule, runnerModule, liveDev, liveDevRunner, evaluationArms, base, combination, triage, membership, modelCall] = await Promise.all([
    import("@supabase/supabase-js"),
    import("../lib/research-v2/live-dev-providers"),
    import("../lib/research-v2/discovery-runner"),
    import("../lib/research-v2/live-dev"),
    import("../lib/research-v2/live-dev-runner"),
    import("../lib/evaluation/arms"),
    import("../lib/research-v2/base"),
    import("../lib/research-v2/combination"),
    import("../lib/research-v2/triage"),
    import("../lib/research-v2/league-membership"),
    import("../lib/research-v2/model-call"),
  ]);
  const supabaseUrl = process.env.SUPABASE_URL?.trim() || requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  const restore = installResearchFetchGuard(supabaseUrl);
  try {
    const client = providersModule.readOnlySupabaseClient(
      createClient(supabaseUrl, requiredEnv("SUPABASE_SECRET_KEY"), { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }),
    );
    const fixtureIds = liveDev.ROUND_264201_LIVE_DEV_FIXTURES.filter((fixture) => fixture.roundId === roundId).map((fixture) => fixture.fixtureId);
    if (fixtureIds.length === 0) throw new Error(`No live-dev fixtures are tagged for round ${roundId}.`);
    // Fresh base capture immediately before research.
    const baseArtifact = await liveDevRunner.captureLiveDevArtifact({
      roundId,
      providers: providersModule.createLiveDevProviders({
        client,
        roundId,
        fixtureIds,
        sportmonksToken: requiredEnv("SPORTMONKS_API_TOKEN"),
        apiFootballKey: requiredEnv("API_FOOTBALL_API_KEY"),
        apiFootballMinIntervalMs: Number(process.env.API_FOOTBALL_MIN_REQUEST_INTERVAL_MS ?? 6_500),
      }),
      configs: { base: base.CANDIDATE_DETERMINISTIC_BASE_CONFIG, combinations: combination.CANDIDATE_COMBINATIONS, triage: triage.CANDIDATE_TRIAGE_CONFIG, membership: membership.CANDIDATE_LEAGUE_MEMBERSHIP_CONFIG },
      historyLookbackDays: evaluationArms.requiredHistoryLookbackDays(),
      historyFloor: liveDevRunner.SPORTMONKS_HISTORY_FLOOR,
    });
    const stamp = baseArtifact.deterministic.inputs.executionCutoffAt.replace(/[:.]/g, "-");
    const basePath = join("artifacts", "research-v2", `live-dev-${roundId}-${stamp}.json`);
    mkdirSync(dirname(basePath), { recursive: true });
    writeFileSync(basePath, `${JSON.stringify(baseArtifact, null, 2)}\n`, { flag: "wx" });

    const targets = baseArtifact.deterministic.outputs.fixtures
      .filter((fixture) => fixture.eligibility.eligible && (!onlyGame || String(fixture.gameNumber) === onlyGame))
      .map((fixture) => ({ fixtureId: fixture.fixtureId, searchNames: namesFor(names, fixture.gameNumber, fixture.fixtureId) }))
      .filter((target): target is { fixtureId: string; searchNames: SearchNames } => target.searchNames != null);
    const artifact = await runnerModule.runDiscoveryResearch({
      base: baseArtifact,
      baseArtifactPath: basePath,
      fixtures: targets,
      deps: {
        now: () => new Date(),
        responsesClient: modelCall.createResponsesClient(requiredEnv("OPENAI_API_KEY")),
        async loadFixtureStatus(fixtureId) {
          const { data, error } = await client.from("fixtures").select("id,status,kickoff_at").eq("id", fixtureId).single();
          if (error || !data) throw new Error(`fixture status unavailable: ${error?.message ?? fixtureId}`);
          return { status: String(data.status), kickoffAt: String(data.kickoff_at) };
        },
      },
      configs: runnerModule.CANDIDATE_RESEARCH_CONFIGS as ResearchConfigs,
    });
    const out = join("artifacts", "research-v2", `discovery-${roundId}-${stamp}.json`);
    writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
    return { baseArtifact: basePath, discoveryArtifact: out, artifactSha256: artifact.deterministic.artifactSha256, summary: artifact.deterministic.outputs.summary };
  } finally {
    restore();
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "plan") return plan(args);
  if (command === "replay") return replay(args);
  if (command === "research") return research(args);
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
