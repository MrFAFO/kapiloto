import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";

import { syntheticLeague } from "@/lib/evaluation/test-fixtures";

import { CANDIDATE_DETERMINISTIC_BASE_CONFIG, findResultLikeKeys } from "./base";
import { CANDIDATE_COMBINATIONS, type CombinationCandidate } from "./combination";
import { FORMAL_SAMPLING_ENABLED } from "./live-dev";
import { installLiveDevFetchGuard, installNoNetworkGuard, readOnlySupabaseClient } from "./live-dev-providers";
import {
  captureLiveDevArtifact,
  computeLiveDevOutputs,
  liveDevEligibility,
  planHistoryRequest,
  replayLiveDevArtifact,
  sealLiveDevArtifact,
  SPORTMONKS_HISTORY_FLOOR,
  type LiveDevArtifact,
  type LiveDevFixtureIdentity,
  type LiveDevProviders,
  type MarketInput,
} from "./live-dev-runner";
import { canonicalJson } from "./provenance";
import { CANDIDATE_TRIAGE_CONFIG } from "./triage";

const PREMIER = syntheticLeague({ teams: 10, seasons: 2, competitionKey: "sportmonks:8" });
const LIGAT = syntheticLeague({ teams: 10, seasons: 2, competitionKey: "sportmonks:372", seed: 11 });
const NOW = new Date(Math.max(...PREMIER.map((m) => Date.parse(m.kickoffAt))) + 20 * 86_400_000);
const at = (minutesFromNow: number) => new Date(NOW.getTime() + minutesFromNow * 60_000).toISOString();
const CONFIGS = { base: CANDIDATE_DETERMINISTIC_BASE_CONFIG, combinations: CANDIDATE_COMBINATIONS, triage: CANDIDATE_TRIAGE_CONFIG };

function identity(gameNumber: number, overrides: Partial<LiveDevFixtureIdentity> = {}): LiveDevFixtureIdentity {
  const league = gameNumber === 1 ? "372" : "8";
  return {
    fixtureId: `fixture-${gameNumber}`,
    roundId: "round-1",
    roundGameId: `rg-${gameNumber}`,
    gameNumber,
    homeTeamId: `home-${gameNumber}`,
    awayTeamId: `away-${gameNumber}`,
    homeName: `Home ${gameNumber}`,
    awayName: `Away ${gameNumber}`,
    competitionId: `competition-${league}`,
    competitionName: league === "372" ? "Ligat Ha'al" : "Premier League",
    competitionType: "league",
    kickoffAt: at(gameNumber === 1 ? 26 * 60 : 6 * 60),
    status: "upcoming",
    neutralVenue: false,
    legNumber: null,
    sportmonks: { leagueId: league, homeTeamId: "t0", awayTeamId: "t5", fixtureId: `sm-target-${gameNumber}` },
    ...overrides,
  };
}

function okMarket(bookmakers = 4): MarketInput {
  return {
    status: "ok",
    capturedAt: NOW.toISOString(),
    apiFootballFixtureId: "af-1",
    resolution: "provider_team_ids",
    quotes: Array.from({ length: bookmakers }, (_, index) => ({
      bookmakerId: `b${index}`,
      bookmakerName: `Book ${index}`,
      sourceUpdatedAt: at(-30),
      odds: { home: 1.9 + index * 0.01, draw: 3.6, away: 4.3 - index * 0.01 },
    })),
  };
}

function providers(options: {
  identities?: LiveDevFixtureIdentity[];
  market?: (identity: LiveDevFixtureIdentity) => Promise<MarketInput>;
  history?: (leagueId: string) => Promise<typeof PREMIER>;
  calls?: string[];
} = {}): LiveDevProviders {
  return {
    now: () => NOW,
    async loadIdentities() {
      options.calls?.push("identities");
      return options.identities ?? [identity(1), identity(7), identity(8)];
    },
    async loadLeagueHistory(leagueId) {
      options.calls?.push(`history:${leagueId}`);
      if (options.history) return options.history(leagueId);
      return leagueId === "372" ? LIGAT : PREMIER;
    },
    async loadMarket(target) {
      options.calls?.push(`market:${target.gameNumber}`);
      return options.market ? options.market(target) : okMarket();
    },
    async loadTriageContext() {
      return {
        structuredSnapshotId: "snap",
        context: {
          managerChangeDaysAgo: { home: null, away: null },
          restDays: { home: 6, away: 6 },
          matchesLast14Days: { home: 2, away: 2 },
          competition: { isCup: false, isSecondLeg: false },
          promoted: { home: null, away: null },
          unresolvedAvailability: 0,
        },
      };
    },
  };
}

// The synthetic league predates the real account floor, so these tests request the full lookback.
const capture = (p: LiveDevProviders) =>
  captureLiveDevArtifact({ roundId: "round-1", providers: p, configs: CONFIGS, historyLookbackDays: 1460, historyFloor: null });
const fixtureOut = (artifact: LiveDevArtifact, game: number) =>
  artifact.deterministic.outputs.fixtures.find((fixture) => fixture.gameNumber === game)!;

test("a started fixture is excluded before any provider call", async () => {
  const calls: string[] = [];
  const artifact = await capture(providers({ identities: [identity(7, { status: "live" }), identity(8)], calls }));
  assert.equal(fixtureOut(artifact, 7).eligibility.reason, "not_upcoming");
  assert.equal(fixtureOut(artifact, 7).arms, null);
  assert.ok(!calls.includes("market:7"));
  assert.ok(calls.includes("market:8"));
});

test("a fixture less than 60 minutes from kickoff is excluded", async () => {
  const artifact = await capture(providers({ identities: [identity(7, { kickoffAt: at(59) }), identity(8)] }));
  assert.equal(fixtureOut(artifact, 7).eligibility.reason, "kickoff_within_min_lead");
  assert.equal(fixtureOut(artifact, 7).candidates.length, 0);
  assert.equal(fixtureOut(artifact, 8).eligibility.eligible, true);
});

test("the 60-minute boundary is inclusive and explicit", () => {
  assert.equal(liveDevEligibility(identity(7, { kickoffAt: at(60) }), NOW.toISOString(), 60).eligible, true);
  const justInside = liveDevEligibility(identity(7, { kickoffAt: new Date(NOW.getTime() + 60 * 60_000 - 1).toISOString() }), NOW.toISOString(), 60);
  assert.deepEqual([justInside.eligible, justInside.reason], [false, "kickoff_within_min_lead"]);
  assert.equal(liveDevEligibility(identity(7, { kickoffAt: at(0) }), NOW.toISOString(), 60).reason, "kickoff_passed");
});

test("an API-Football date-window refusal affects only that fixture's market arm", async () => {
  const artifact = await capture(
    providers({
      market: async (target) => {
        if (target.gameNumber === 1) throw new Error("API-Football fixture resolution error: plan: Free plans do not have access to this date");
        return okMarket();
      },
    }),
  );
  const monday = fixtureOut(artifact, 1);
  assert.equal(monday.market.status, "unavailable");
  assert.equal(monday.market.reason, "provider_plan_date_window");
  assert.equal(monday.arms?.p_market_v1.status, "unavailable");
  assert.equal(monday.arms?.p_stat_elo_v1.status, "available");
  assert.equal(monday.arms?.p_league_base_v1.status, "available");
  assert.ok(monday.degraded.includes("market_provider:provider_plan_date_window"));
  for (const sunday of [7, 8]) {
    assert.equal(fixtureOut(artifact, sunday).arms?.p_market_v1.status, "available", `game ${sunday}`);
  }
});

test("Monday provider unavailability does not fail Sunday fixtures", async () => {
  const artifact = await capture(
    providers({
      market: async (target) => {
        if (target.gameNumber === 1) throw new Error("socket hang up");
        return okMarket();
      },
      history: async (leagueId) => {
        if (leagueId === "372") throw new Error("sportmonks 503");
        return PREMIER;
      },
    }),
  );
  assert.equal(artifact.deterministic.outputs.summary.eligible, 3);
  assert.equal(fixtureOut(artifact, 1).market.reason, "provider_error:socket hang up");
  for (const sunday of [7, 8]) {
    const out = fixtureOut(artifact, sunday);
    assert.equal(out.arms?.p_market_v1.status, "available");
    assert.equal(out.arms?.p_stat_elo_v1.status, "available");
    assert.ok(out.candidates.some((candidate) => candidate.candidateId === "log_market65_elo" && candidate.status === "available"));
  }
});

test("a missing market degrades explicitly, never to uniform probabilities", async () => {
  const artifact = await capture(
    providers({ market: async () => ({ status: "unavailable", reason: "fixture_not_found", resolution: "not_found", apiFootballFixtureId: null }) }),
  );
  const out = fixtureOut(artifact, 8);
  assert.equal(out.market.quality, "missing");
  assert.equal(out.arms?.p_market_v1.status, "unavailable");
  for (const candidate of out.candidates) {
    if (candidate.candidateId === "stat_elo_only") {
      assert.equal(candidate.status, "available");
    } else if (candidate.candidateId === "stat_goal_model_only") {
      assert.equal(candidate.reason, "p_stat_goal_model_v1_not_implemented");
    } else {
      assert.equal(candidate.status, "unavailable", candidate.candidateId);
      assert.equal(candidate.reason, "market_missing", candidate.candidateId);
    }
  }
});

test("a thin or stale market is preserved, classified and gates candidates", async () => {
  const thin = await capture(providers({ market: async () => okMarket(2) }));
  const thinOut = fixtureOut(thin, 8);
  assert.equal(thinOut.market.quality, "thin");
  assert.equal(thinOut.market.bookmakersUsed.length, 2);
  const strict: CombinationCandidate = { id: "market_standard_only", version: "x", status: "candidate", kind: "market_only", minMarketQuality: "standard" };
  const strictInputs = { ...thin.deterministic.inputs, configs: { ...CONFIGS, combinations: [strict] } };
  const strictOut = computeLiveDevOutputs(strictInputs).fixtures.find((f) => f.gameNumber === 8)!;
  assert.equal(strictOut.candidates[0].status, "unavailable");
  assert.equal(strictOut.candidates[0].reason, "market_below_standard:thin");

  const stale = structuredClone(thin.deterministic.inputs);
  for (const fixture of stale.fixtures) {
    if (fixture.market?.status === "ok") fixture.market = { ...okMarket(4), capturedAt: at(-30 * 60) } as MarketInput;
  }
  const staleOut = computeLiveDevOutputs(stale).fixtures.find((f) => f.gameNumber === 8)!;
  assert.equal(staleOut.market.quality, "stale");
  assert.equal(staleOut.market.status, "ok", "the raw capture is kept");
  assert.equal(staleOut.arms?.p_market_v1.status, "unavailable");
});

test("missing Sportmonks history never invents p_stat or a league base", async () => {
  const artifact = await capture(providers({ history: async () => { throw new Error("sportmonks timeout"); } }));
  const out = fixtureOut(artifact, 8);
  assert.equal(out.sportmonks.historyStatus, "failed");
  assert.equal(out.arms?.p_stat_elo_v1.status, "unavailable");
  assert.equal(out.arms?.p_league_base_v1.status, "unavailable");
  assert.match(out.arms?.p_stat_elo_v1.status === "unavailable" ? out.arms.p_stat_elo_v1.reason : "", /sportmonks_history_unavailable/);
  assert.equal(out.arms?.p_market_v1.status, "available");
  assert.equal(artifact.deterministic.inputs.leagues.every((league) => league.status === "failed"), true);

  const unmapped = await capture(providers({ identities: [identity(8, { sportmonks: { leagueId: null, homeTeamId: null, awayTeamId: null, fixtureId: null } })] }));
  assert.equal(fixtureOut(unmapped, 8).sportmonks.historyStatus, "unmapped");
  assert.equal(fixtureOut(unmapped, 8).arms?.p_stat_elo_v1.status, "unavailable");
});

test("no database write is possible through the runner's client or network", async () => {
  const fake = {
    from: () => ({ select: () => ({}), insert: () => ({}), upsert: () => ({}), update: () => ({}), delete: () => ({}) }),
    rpc: () => ({}),
    storage: {},
    functions: {},
  } as unknown as SupabaseClient;
  const client = readOnlySupabaseClient(fake);
  for (const mutation of ["insert", "upsert", "update", "delete"]) {
    assert.throws(() => (client.from("fixtures") as unknown as Record<string, unknown>)[mutation], /read_only/);
  }
  assert.throws(() => client.rpc, /read_only/);
  assert.throws(() => client.storage, /read_only/);
  assert.doesNotThrow(() => client.from("fixtures").select("id"));

  const restore = installLiveDevFetchGuard("https://project.supabase.co");
  try {
    await assert.rejects(fetch("https://project.supabase.co/rest/v1/fixtures", { method: "POST", body: "{}" }), /blocked: POST to Supabase/);
    await assert.rejects(fetch("https://api.openai.com/v1/responses", { method: "POST" }), /host api.openai.com is not allowed/);
    await assert.rejects(fetch("https://v3.football.api-sports.io/odds", { method: "POST" }), /blocked: POST/);
  } finally {
    restore();
  }
  const noNetwork = installNoNetworkGuard();
  try {
    await assert.rejects(fetch("https://api.sportmonks.com/v3"), /replay_network_blocked/);
  } finally {
    noNetwork();
  }
});

test("no Sol, OpenAI or web-search code is reachable from the runner", () => {
  const root = process.cwd();
  const seen = new Set<string>();
  const resolveImport = (from: string, specifier: string): string | null => {
    const base = specifier.startsWith("@/") ? join(root, specifier.slice(2)) : specifier.startsWith(".") ? resolve(dirname(from), specifier) : null;
    if (!base) return null;
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
      if (existsSync(candidate) && candidate.match(/\.(ts|tsx|json)$/)) return candidate;
    }
    return null;
  };
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const next = resolveImport(file, match[1]);
      if (next && next.endsWith(".ts")) walk(next);
    }
  };
  walk(join(root, "scripts", "research-v2-live-dev.ts"));
  assert.ok(seen.size > 5);
  // The only Kapiloto module allowed is the pure SHA-256 helper (node:crypto only).
  const ALLOWED_KAPILOTO = new Set(["lib/kapiloto/snapshot.ts"]);
  for (const file of seen) {
    const rel = file.slice(root.length + 1).replace(/\\/g, "/");
    assert.ok(!rel.startsWith("lib/kapiloto/") || ALLOWED_KAPILOTO.has(rel), `${rel} is a Kapiloto research module`);
    assert.doesNotMatch(readFileSync(file, "utf8"), /openai|web_search|responses\.create/i, rel);
  }
});

test("the same frozen provider inputs replay bit-for-bit", async () => {
  const artifact = await capture(providers());
  const stored = JSON.parse(JSON.stringify(artifact)) as LiveDevArtifact;
  const replayed = replayLiveDevArtifact(stored);
  assert.equal(replayed.identical, true);
  assert.equal(canonicalJson(replayed.outputs), canonicalJson(artifact.deterministic.outputs));
  const elo = (a: LiveDevArtifact) => fixtureOut(a, 8).arms!.p_stat_elo_v1;
  const original = elo(artifact);
  const again = replayed.outputs.fixtures.find((f) => f.gameNumber === 8)!.arms!.p_stat_elo_v1;
  if (original.status === "available" && again.status === "available") {
    assert.equal(again.probabilities.home, original.probabilities.home);
    assert.equal(again.probabilities.draw, original.probabilities.draw);
  }
});

test("provider retrieval timestamps never change the deterministic hash", async () => {
  const artifact = await capture(providers());
  const shifted = sealLiveDevArtifact(artifact.deterministic.inputs, {
    ...artifact.retrieval,
    guardCheckedAt: "2000-01-01T00:00:00.000Z",
    startedAt: "2000-01-01T00:00:00.000Z",
    finishedAt: "2099-01-01T00:00:00.000Z",
    calls: artifact.retrieval.calls.map((call) => ({ ...call, startedAt: "2000-01-01T00:00:00.000Z" })),
  });
  assert.equal(shifted.deterministic.artifactSha256, artifact.deterministic.artifactSha256);
  const tampered = structuredClone(artifact);
  tampered.retrieval.calls = [];
  assert.equal(replayLiveDevArtifact(tampered).identical, true);
});

test("no target-fixture result field can enter the deterministic inputs or the artifact", async () => {
  const artifact = await capture(providers());
  const { leagues, fixtures } = artifact.deterministic.inputs;
  assert.deepEqual(findResultLikeKeys(fixtures), [], "fixture identity, market and triage inputs");
  assert.deepEqual(findResultLikeKeys(artifact.deterministic.outputs.fixtures.map(({ triage, ...fixture }) => fixture)), []);
  assert.ok(leagues.every((league) => league.status !== "ok" || league.matches.every((m) => !m.providerFixtureId.startsWith("sm-target"))));

  const poisoned = structuredClone(artifact.deterministic.inputs);
  (poisoned.fixtures[0].identity as Record<string, unknown>).home_score = 1;
  assert.throws(() => computeLiveDevOutputs(poisoned), /result_leakage/);

  const leaked = structuredClone(artifact.deterministic.inputs);
  const league8 = leaked.leagues.find((league) => league.leagueId === "8");
  if (league8?.status === "ok") league8.matches.push({ ...league8.matches[0], providerFixtureId: "sm-target-8" });
  assert.throws(() => computeLiveDevOutputs(leaked), /target fixture sm-target-8 appears in league history/);
});

test("changing one candidate config changes only that candidate arm", async () => {
  const artifact = await capture(providers());
  const changed = structuredClone(artifact.deterministic.inputs);
  changed.configs.combinations = changed.configs.combinations.map((candidate) =>
    candidate.id === "linear_market50_elo" && candidate.kind === "linear_pool" ? { ...candidate, marketWeight: 0.3 } : candidate,
  );
  const before = artifact.deterministic.outputs.fixtures.find((f) => f.gameNumber === 8)!;
  const after = computeLiveDevOutputs(changed).fixtures.find((f) => f.gameNumber === 8)!;
  assert.equal(canonicalJson(after.arms), canonicalJson(before.arms));
  assert.equal(canonicalJson(after.triage), canonicalJson(before.triage));
  for (const candidate of before.candidates) {
    const other = after.candidates.find((c) => c.candidateId === candidate.candidateId)!;
    if (candidate.candidateId === "linear_market50_elo") assert.notEqual(canonicalJson(other), canonicalJson(candidate));
    else assert.equal(canonicalJson(other), canonicalJson(candidate), candidate.candidateId);
  }
});

test("formal sampling stays disabled; outputs are live_dev with no adjustment, Sol call or recommendation", async () => {
  assert.equal(FORMAL_SAMPLING_ENABLED, false);
  const artifact = await capture(providers());
  assert.equal(artifact.tag, "live_dev");
  assert.equal(artifact.formalSamplingEnabled, false);
  assert.equal(artifact.publication, false);
  for (const fixture of artifact.deterministic.outputs.fixtures) {
    assert.equal(fixture.tag, "live_dev");
    assert.equal(fixture.formalSample, false);
    assert.equal(fixture.researchAdjustmentsApplied, 0);
    assert.equal(fixture.solCalls, 0);
    assert.equal(fixture.recommendation, null);
  }
  const triaged = fixtureOut(artifact, 8).triage!;
  assert.ok(triaged.needs.some((need) => need.kind === "availability_rotation_check"));
  assert.ok(["minimal", "standard", "deep"].includes(triaged.tier));
});

test("the history request starts at the later of the lookback start and the provider floor", () => {
  const floor = { ...SPORTMONKS_HISTORY_FLOOR, earliestDate: "2024-08-01" };
  const later = planHistoryRequest("2026-10-25T09:00:00.000Z", 1460, floor);
  assert.equal(later.lookbackStartDate, "2022-10-26");
  assert.equal(later.requestedStartDate, "2024-08-01");
  assert.equal(later.requestedEndDate, "2026-10-25");
  const lookbackWins = planHistoryRequest("2026-10-25T09:00:00.000Z", 365, floor);
  assert.equal(lookbackWins.requestedStartDate, lookbackWins.lookbackStartDate);
  assert.equal(planHistoryRequest("2026-10-25T09:00:00.000Z", 1460, null).requestedStartDate, "2022-10-26");
  assert.equal(SPORTMONKS_HISTORY_FLOOR.earliestDate, "2024-08-01");
});

test("the provider is asked only for floored windows, and the plan is recorded and replays", async () => {
  const floorDate = PREMIER[0].kickoffAt.slice(0, 10);
  const floor = { ...SPORTMONKS_HISTORY_FLOOR, version: "test-floor", earliestDate: floorDate };
  const windows: string[] = [];
  const base = providers();
  const recording: LiveDevProviders = {
    ...base,
    async loadLeagueHistory(leagueId, window) {
      windows.push(`${leagueId}:${window.startDate}..${window.endDate}`);
      return base.loadLeagueHistory(leagueId, window);
    },
  };
  const artifact = await captureLiveDevArtifact({ roundId: "round-1", providers: recording, configs: CONFIGS, historyLookbackDays: 1460, historyFloor: floor });
  assert.ok(windows.length > 0 && windows.every((window) => window.includes(`:${floorDate}..`)));
  assert.deepEqual(artifact.deterministic.inputs.historyPlan.floor, floor);
  assert.equal(artifact.deterministic.inputs.historyPlan.requestedStartDate, floorDate);
  assert.ok(artifact.deterministic.inputs.leagues.every((league) => league.window.startDate === floorDate));
  assert.equal(replayLiveDevArtifact(JSON.parse(JSON.stringify(artifact))).identical, true);
});

test("a floor at or before the earliest available match changes no statistic, only the recorded plan", async () => {
  const floorDate = [...PREMIER, ...LIGAT].map((match) => match.kickoffAt.slice(0, 10)).sort()[0];
  const floored = await captureLiveDevArtifact({
    roundId: "round-1", providers: providers(), configs: CONFIGS, historyLookbackDays: 1460,
    historyFloor: { ...SPORTMONKS_HISTORY_FLOOR, earliestDate: floorDate },
  });
  const unbounded = await capture(providers());
  const strip = (artifact: LiveDevArtifact) =>
    artifact.deterministic.outputs.fixtures.map(({ sportmonks, ...fixture }) => ({ ...fixture, historyRowsUsed: sportmonks.historyRowsUsed }));
  assert.equal(canonicalJson(strip(floored)), canonicalJson(strip(unbounded)));
  assert.notEqual(floored.deterministic.inputSha256, unbounded.deterministic.inputSha256, "the plan is part of the recorded inputs");
});

test("the CLI defaults to the measured provider floor", () => {
  const source = readFileSync(join(process.cwd(), "scripts", "research-v2-live-dev.ts"), "utf8");
  assert.match(source, /if \(!override\) return SPORTMONKS_HISTORY_FLOOR;/);
  assert.match(source, /historyFloor,\n/);
});
