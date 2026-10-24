import assert from "node:assert/strict";
import test from "node:test";

import type { ApiFootballRoundGame } from "@/lib/providers/api-football-sync";
import type { BookmakerThreeWayQuote, ProviderFixture } from "@/lib/providers/types";

import { EVAL_ARM, type EvalPredictionDraft, type ShadowFixtureContext } from "./arms";
import { shadowCycleConfigFromEnv, shadowEvaluationFlags } from "./env";
import type { HistoricalMatchResult } from "./history";
import type { PublishedKapilotoAnalysis } from "./kapiloto-projection";
import type { LastActivity } from "./market-cadence";
import type {
  MarketCaptureAttemptDraft,
  MarketQuoteDraft,
  MarketQuoteSource,
  ProviderRequestMeter,
} from "./market-capture";
import type { MarketQuoteRecord } from "./market-prior";
import { buildShadowRoundReport } from "./report";
import type { EvalScoreDraft } from "./scoring";
import {
  DEFAULT_SHADOW_CYCLE_CONFIG,
  runShadowEvaluationCycle,
  type ShadowCycleConfig,
} from "./shadow-cycle";
import type { FixtureForEvaluation, StoredEvalPrediction } from "./selection";
import type { QuoteSnapshotSummary, ShadowCycleStore, StoredScoreSummary } from "./supabase-store";
import { syntheticLeague } from "./test-fixtures";

const HOUR = 3_600_000;
const league = syntheticLeague({ teams: 10, seasons: 3 });
const T0 = Date.parse(league[league.length - 1].kickoffAt) + 30 * 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

type FixtureState = FixtureForEvaluation & { context: ShadowFixtureContext; gameNumber: number };

/** In-memory stand-in that reproduces the database stamps and unique keys. */
class FakeStore implements ShadowCycleStore {
  nowMs = T0;
  fixtures = new Map<string, FixtureState>();
  predictions: StoredEvalPrediction[] = [];
  quotes: MarketQuoteRecord[] = [];
  attempts: Array<MarketCaptureAttemptDraft & { attempted_at: string }> = [];
  scores: EvalScoreDraft[] = [];
  publications: PublishedKapilotoAnalysis[] = [];
  failPublications = false;
  writes: string[] = [];
  private nextId = 1;

  constructor(readonly history: HistoricalMatchResult[]) {}

  addFixture(id: string, gameNumber: number, kickoffMs: number, home: string, away: string) {
    const homeTeamId = `00000000-0000-4000-8000-${home.padStart(12, "0")}`;
    const awayTeamId = `00000000-0000-4000-8000-${away.padStart(12, "0")}`;
    this.fixtures.set(id, {
      fixtureId: id,
      gameNumber,
      homeTeamId,
      awayTeamId,
      kickoffAt: iso(kickoffMs),
      actualKickoffAt: null,
      status: "upcoming",
      homeScore: null,
      awayScore: null,
      context: {
        fixtureId: id,
        roundGameId: `rg-${id}`,
        homeTeamId,
        awayTeamId,
        kickoffAt: iso(kickoffMs),
        neutralVenue: false,
        competitionKey: "sportmonks:8",
        homeTeamKey: `sportmonks:t${home}`,
        awayTeamKey: `sportmonks:t${away}`,
      },
    });
  }

  games(): ApiFootballRoundGame[] {
    return [...this.fixtures.values()].map((fixture) => ({
      roundGameId: `rg-${fixture.fixtureId}`,
      fixtureId: fixture.fixtureId,
      gameNumber: fixture.gameNumber,
      kickoffAt: fixture.kickoffAt,
      competitionId: "c",
      competitionName: "Premier League",
      home: { teamId: fixture.homeTeamId, canonicalName: fixture.fixtureId, aliases: [], providerTeamId: null },
      away: { teamId: fixture.awayTeamId, canonicalName: "away", aliases: [], providerTeamId: null },
      providerFixtureId: null,
    }));
  }

  async loadRoundFixtureIds() {
    return [...this.fixtures.values()]
      .sort((a, b) => a.gameNumber - b.gameNumber)
      .map((fixture) => fixture.fixtureId);
  }
  async loadFixtureContexts(ids: string[]) {
    return ids.flatMap((id) => (this.fixtures.get(id) ? [this.fixtures.get(id)!.context] : []));
  }
  async loadHistory(competitionKey: string, cutoffAt: string, lookbackDays: number) {
    const cutoffMs = Date.parse(cutoffAt);
    return this.history.filter(
      (match) =>
        match.competitionKey === competitionKey &&
        Date.parse(match.kickoffAt) < cutoffMs &&
        Date.parse(match.kickoffAt) >= cutoffMs - lookbackDays * 86_400_000,
    );
  }
  async loadMarketQuotes(fixtureId: string, cutoffAt: string) {
    return this.quotes.filter(
      (quote) => quote.fixtureId === fixtureId && quote.capturedAt <= cutoffAt,
    );
  }
  async insertPredictions(drafts: EvalPredictionDraft[]) {
    let inserted = 0;
    let duplicates = 0;
    for (const draft of drafts) {
      this.writes.push("kapiloto_eval_predictions");
      const fixture = this.fixtures.get(draft.fixture_id)!;
      const publication = this.publications.find((item) => item.analysisId === draft.source_analysis_id);
      const issuedAt =
        draft.issued_at_source === "recorded" ? iso(this.nowMs) : (publication?.publishedAt as string);
      if (draft.evaluation_mode === "forward" && draft.information_cutoff_at > issuedAt) {
        throw new Error("kapiloto_eval_information_after_issue");
      }
      const key = [draft.fixture_id, draft.arm, draft.arm_version, draft.evaluation_mode, draft.information_cutoff_at, draft.source_analysis_id].join("|");
      if (this.predictions.some((row) => (row as unknown as { key: string }).key === key)) {
        duplicates += 1;
        continue;
      }
      this.predictions.push({
        id: `p${this.nextId++}`,
        key,
        fixture_id: draft.fixture_id,
        arm: draft.arm,
        arm_version: draft.arm_version,
        evaluation_mode: draft.evaluation_mode,
        deterministic: draft.deterministic,
        information_cutoff_at: draft.information_cutoff_at,
        issued_at: issuedAt,
        recorded_at: iso(this.nowMs),
        kickoff_at_snapshot:
          draft.issued_at_source === "recorded" ? fixture.kickoffAt : draft.kickoff_at_snapshot,
        home_team_id: draft.home_team_id,
        away_team_id: draft.away_team_id,
        valid: draft.valid,
        invalid_reason: draft.invalid_reason,
        p_home: draft.p_home,
        p_draw: draft.p_draw,
        p_away: draft.p_away,
      } as StoredEvalPrediction);
      inserted += 1;
    }
    return { inserted, duplicates };
  }
  async loadPublishedKapiloto(ids: string[]) {
    if (this.failPublications) throw new Error("publications unavailable");
    return this.publications.filter((item) => ids.includes(item.fixtureId));
  }
  async loadPredictions(ids: string[], mode: string) {
    return this.predictions.filter((row) => ids.includes(row.fixture_id) && row.evaluation_mode === mode);
  }
  async loadFixturesForEvaluation(ids: string[]) {
    return ids.flatMap((id) => {
      const fixture = this.fixtures.get(id);
      if (!fixture) return [];
      const { context: _context, gameNumber: _game, ...rest } = fixture;
      return [rest];
    });
  }
  async insertScores(drafts: EvalScoreDraft[]) {
    let inserted = 0;
    for (const draft of drafts) {
      this.writes.push("kapiloto_eval_scores");
      const exists = this.scores.some(
        (row) =>
          row.fixture_id === draft.fixture_id &&
          row.arm === draft.arm &&
          row.arm_version === draft.arm_version &&
          row.evaluation_mode === draft.evaluation_mode,
      );
      if (!exists) {
        this.scores.push(draft);
        inserted += 1;
      }
    }
    return inserted;
  }
  async saveQuotes(rows: MarketQuoteDraft[]) {
    this.writes.push("fixture_market_quotes");
    for (const row of rows) {
      this.quotes.push({
        id: `q${this.nextId++}`,
        fixtureId: row.fixture_id,
        provider: row.provider,
        bookmakerId: row.bookmaker_id,
        bookmakerName: row.bookmaker_name ?? row.bookmaker_id,
        capturedAt: iso(this.nowMs),
        sourceUpdatedAt: row.source_updated_at,
        odds: { home: row.odds_home, draw: row.odds_draw, away: row.odds_away },
      });
    }
    return rows.length;
  }
  async saveAttempt(row: MarketCaptureAttemptDraft) {
    this.writes.push("fixture_market_capture_attempts");
    this.attempts.push({ ...row, attempted_at: iso(this.nowMs) });
  }
  async loadLatestCaptureAttempts(ids: string[]) {
    const latest = new Map<string, LastActivity>();
    for (const attempt of [...this.attempts].reverse()) {
      if (attempt.status === "skipped_budget" || !ids.includes(attempt.fixture_id)) continue;
      if (!latest.has(attempt.fixture_id)) {
        latest.set(attempt.fixture_id, { at: attempt.attempted_at, status: attempt.status });
      }
    }
    return latest;
  }
  async loadProviderRequestsSince(provider: string, sinceAt: string) {
    return this.attempts
      .filter((attempt) => attempt.provider === provider && attempt.attempted_at >= sinceAt)
      .reduce((sum, attempt) => sum + attempt.provider_requests, 0);
  }
  async loadLatestQuoteCapturedAt(ids: string[]) {
    const latest = new Map<string, string>();
    for (const quote of this.quotes) {
      if (!ids.includes(quote.fixtureId)) continue;
      if (!latest.has(quote.fixtureId) || quote.capturedAt > latest.get(quote.fixtureId)!) {
        latest.set(quote.fixtureId, quote.capturedAt);
      }
    }
    return latest;
  }
  async loadLatestPredictionIssuedAt(ids: string[], arm: string, mode: string) {
    const latest = new Map<string, string>();
    for (const row of this.predictions) {
      if (!ids.includes(row.fixture_id) || row.arm !== arm || row.evaluation_mode !== mode) continue;
      if (!latest.has(row.fixture_id) || row.issued_at > latest.get(row.fixture_id)!) {
        latest.set(row.fixture_id, row.issued_at);
      }
    }
    return latest;
  }
  async loadFinishedFixtureIdsBetween(fromAt: string, toAt: string) {
    return [...this.fixtures.values()]
      .filter(
        (fixture) =>
          (fixture.status === "finished" || fixture.status === "cancelled") &&
          fixture.kickoffAt >= fromAt &&
          fixture.kickoffAt < toAt,
      )
      .map((fixture) => fixture.fixtureId);
  }
  async loadScores(ids: string[], mode: string): Promise<StoredScoreSummary[]> {
    return this.scores.filter((row) => ids.includes(row.fixture_id) && row.evaluation_mode === mode);
  }
  async loadLatestQuoteSnapshots(ids: string[]): Promise<QuoteSnapshotSummary[]> {
    const latest = await this.loadLatestQuoteCapturedAt(ids);
    return [...latest.entries()].map(([fixtureId, capturedAt]) => ({
      fixtureId,
      capturedAt,
      bookmakers: new Set(
        this.quotes
          .filter((quote) => quote.fixtureId === fixtureId && quote.capturedAt === capturedAt)
          .map((quote) => quote.bookmakerId),
      ).size,
    }));
  }
  async loadSupportedCompetitionKeys() {
    return ["sportmonks:8"];
  }
}

function marketSource(meter: ProviderRequestMeter, bookmakers = 3): MarketQuoteSource {
  return {
    async resolveFixture(input) {
      meter.requests += 1;
      const fixture: ProviderFixture = {
        provider: "api-football",
        providerFixtureId: `af-${input.homeTeam}`,
        kickoffAt: input.kickoffAt,
        status: "NS",
        season: 2026,
        competition: { id: "39", name: "Premier League", country: null, round: null },
        home: { id: "1", name: input.homeTeam },
        away: { id: "2", name: input.awayTeam },
      };
      return { fixture, resolution: "name_match" };
    },
    async getThreeWayQuotes(fixture) {
      meter.requests += 1;
      return Array.from({ length: bookmakers }, (_, index): BookmakerThreeWayQuote => ({
        provider: "api-football",
        providerFixtureId: fixture.providerFixtureId,
        bookmakerId: String(index + 1),
        bookmakerName: `Book ${index + 1}`,
        capturedAt: null,
        odds: { home: 1.9 + index / 50, draw: 3.5, away: 4.2 },
      }));
    },
  };
}

function setup() {
  const store = new FakeStore(league);
  store.addFixture("f-near", 1, T0 + 3 * HOUR, "0", "9");
  store.addFixture("f-mid", 2, T0 + 30 * HOUR, "1", "8");
  store.addFixture("f-far", 3, T0 + 100 * HOUR, "2", "7");
  return store;
}

async function cycle(
  store: FakeStore,
  meter: ProviderRequestMeter | null,
  config: ShadowCycleConfig = DEFAULT_SHADOW_CYCLE_CONFIG,
) {
  return runShadowEvaluationCycle({
    store,
    roundId: "round",
    loadRoundGames: async () => store.games(),
    market: meter ? { source: marketSource(meter), meter } : null,
    now: new Date(store.nowMs),
    config,
  });
}

test("a cycle captures due markets, then records B1-B4 that can see the fresh quotes", async () => {
  const store = setup();
  const meter = { requests: 0, dailyRemaining: null };
  const summary = await cycle(store, meter);

  assert.deepEqual(
    summary.market.results.map((result) => [result.fixtureId, result.window, result.status]),
    [
      ["f-near", "near", "saved"],
      ["f-mid", "mid", "saved"],
      ["f-far", "far", "saved"],
    ],
  );
  assert.equal(summary.market.requestsUsed, 6);
  assert.deepEqual(store.attempts.map((attempt) => attempt.provider_requests), [2, 2, 2]);
  assert.equal(summary.predictions.due, 3);
  assert.equal(store.predictions.length, 12);
  for (const prediction of store.predictions) {
    assert.ok(prediction.information_cutoff_at <= prediction.issued_at);
  }
  const markets = store.predictions.filter((row) => row.arm === EVAL_ARM.market);
  assert.ok(markets.every((row) => row.valid), "fresh quotes are inside the cutoff");
  assert.ok(store.predictions.filter((row) => row.arm === EVAL_ARM.pStat).every((row) => row.valid));
});

test("re-running immediately captures and records nothing new", async () => {
  const store = setup();
  await cycle(store, { requests: 0, dailyRemaining: null });
  const counts = [store.predictions.length, store.quotes.length, store.attempts.length];
  store.nowMs += 60_000;
  const rerun = await cycle(store, { requests: 0, dailyRemaining: null });
  assert.equal(rerun.market.results.length, 0);
  assert.equal(rerun.market.notDue, 3);
  assert.equal(rerun.predictions.due, 0);
  assert.deepEqual([store.predictions.length, store.quotes.length, store.attempts.length], counts);
});

test("the request budget admits the most urgent fixture and records the rest as skipped", async () => {
  const store = setup();
  const config = {
    ...DEFAULT_SHADOW_CYCLE_CONFIG,
    budget: { ...DEFAULT_SHADOW_CYCLE_CONFIG.budget, maxRequestsPerRun: 3 },
  };
  const summary = await cycle(store, { requests: 0, dailyRemaining: null }, config);
  assert.deepEqual(
    summary.market.results.map((result) => [result.fixtureId, result.status]),
    [
      ["f-near", "saved"],
      ["f-mid", "skipped_budget"],
      ["f-far", "skipped_budget"],
    ],
  );
  const market = store.predictions.filter((row) => row.arm === EVAL_ARM.market);
  assert.deepEqual(
    market.map((row) => [row.fixture_id, row.valid, row.invalid_reason]).sort(),
    [
      ["f-far", false, "no_quotes_before_cutoff"],
      ["f-mid", false, "no_quotes_before_cutoff"],
      ["f-near", true, null],
    ],
  );
});

test("capture stops when the provider's remaining daily quota reaches the reserve", async () => {
  const store = setup();
  const summary = await cycle(store, { requests: 0, dailyRemaining: 50 });
  assert.ok(summary.market.results.every((result) => result.status === "skipped_budget"));
  assert.equal(summary.market.requestsUsed, 0);
});

test("budget already spent in the last 24 hours is honoured", async () => {
  const store = setup();
  const config = {
    ...DEFAULT_SHADOW_CYCLE_CONFIG,
    budget: { ...DEFAULT_SHADOW_CYCLE_CONFIG.budget, maxRequestsPerDay: 4 },
  };
  await cycle(store, { requests: 0, dailyRemaining: null }, config);
  assert.equal(store.attempts.filter((attempt) => attempt.status === "saved").length, 2);
  store.nowMs += 5 * HOUR;
  const later = await cycle(store, { requests: 0, dailyRemaining: null }, config);
  assert.ok(later.market.results.every((result) => result.status === "skipped_budget"));
});

test("without a market provider B1-B3 are still recorded and B4 is honestly unavailable", async () => {
  const store = setup();
  const summary = await cycle(store, null);
  assert.equal(summary.market.status, "disabled");
  assert.equal(store.attempts.length, 0);
  const market = store.predictions.filter((row) => row.arm === EVAL_ARM.market);
  assert.ok(market.every((row) => !row.valid && row.invalid_reason === "no_quotes_before_cutoff"));
});

function publication(
  fixtureId: string,
  analysisId: string,
  publishedAt: string,
  kickoffAt: string,
  store: FakeStore,
): PublishedKapilotoAnalysis {
  const fixture = store.fixtures.get(fixtureId)!;
  return {
    publicationId: `pub-${analysisId}`,
    publishedAt,
    analysisId,
    researchRunId: "run",
    fixtureId,
    roundGameId: `rg-${fixtureId}`,
    outcome: "analyzed",
    orientationVerified: true,
    researchCutoffAt: iso(Date.parse(publishedAt) - HOUR),
    kickoffAtSnapshot: kickoffAt,
    roundGameHomeTeamId: fixture.homeTeamId,
    roundGameAwayTeamId: fixture.awayTeamId,
    priorType: "league_base",
    pFinal: { home: 5000, draw: 2800, away: 2200 },
    pSol: { home: 5400, draw: 2600, away: 2000 },
    derivationVersion: "d",
    blendPolicyVersion: "b",
    reliabilityFormulaVersion: "r",
    calibrationVersion: null,
  };
}

test("finished fixtures are scored on frozen pre-deadline predictions only", async () => {
  const store = setup();
  const near = store.fixtures.get("f-near")!;
  store.publications = [
    publication("f-near", "a-early", iso(T0 - HOUR), near.kickoffAt, store),
    publication("f-near", "a-late", iso(Date.parse(near.kickoffAt) - 5 * 60_000), near.kickoffAt, store),
  ];
  await cycle(store, { requests: 0, dailyRemaining: null });
  const projected = store.predictions.filter((row) => row.arm.startsWith("kapiloto"));
  assert.equal(projected.length, 2, "only the pre-deadline publication is projected");

  near.status = "finished";
  near.homeScore = 2;
  near.awayScore = 0;
  store.nowMs = Date.parse(near.kickoffAt) + 4 * HOUR;
  const after = await cycle(store, { requests: 0, dailyRemaining: null });
  assert.equal(after.scoring.candidates, 1);
  const nearScores = store.scores.filter((row) => row.fixture_id === "f-near");
  assert.deepEqual(
    nearScores.map((row) => [row.arm, row.status]).sort(),
    [
      ["kapiloto_published", "scored"],
      ["kapiloto_sol", "scored"],
      ["league_base", "scored"],
      ["market", "scored"],
      ["p_stat", "scored"],
      ["uniform", "scored"],
    ],
  );
  assert.ok(nearScores.every((row) => row.outcome === "1"));

  const again = await cycle(store, { requests: 0, dailyRemaining: null });
  assert.equal(again.scoring.persisted, 0);
});

test("scoring is skipped when the Kapiloto projection step fails", async () => {
  const store = setup();
  await cycle(store, null);
  const near = store.fixtures.get("f-near")!;
  near.status = "finished";
  near.homeScore = 1;
  near.awayScore = 1;
  store.nowMs = Date.parse(near.kickoffAt) + 4 * HOUR;
  store.failPublications = true;
  const summary = await cycle(store, null);
  assert.equal(summary.kapiloto.status, "failed");
  assert.equal(summary.scoring.status, "skipped");
  assert.equal(store.scores.length, 0);
});

test("the cycle only writes evaluation tables", async () => {
  const store = setup();
  store.publications = [
    publication("f-near", "a-early", iso(T0 - HOUR), store.fixtures.get("f-near")!.kickoffAt, store),
  ];
  await cycle(store, { requests: 0, dailyRemaining: null });
  assert.deepEqual(
    [...new Set(store.writes)].sort(),
    [
      "fixture_market_capture_attempts",
      "fixture_market_quotes",
      "kapiloto_eval_predictions",
    ],
  );
});

test("the operator report summarises coverage for the round", async () => {
  const store = setup();
  store.publications = [
    publication("f-near", "a-early", iso(T0 - HOUR), store.fixtures.get("f-near")!.kickoffAt, store),
  ];
  await cycle(store, { requests: 0, dailyRemaining: null });
  store.nowMs += 30 * 60_000;
  const report = await buildShadowRoundReport(store, { roundId: "round", now: new Date(store.nowMs) });
  assert.equal(report.fixtures, 3);
  assert.equal(report.withLeagueHistory, 3);
  assert.equal(report.withValidPStat, 3);
  assert.deepEqual(report.withMarket, { available: 3, standard: 3, thin: 0 });
  assert.deepEqual(report.marketSnapshots.bookmakersPerSnapshot, { min: 3, median: 3, max: 3 });
  assert.deepEqual(report.marketSnapshots.latestSnapshotAgeMinutes, { min: 30, max: 30 });
  assert.deepEqual(report.frozenKapiloto, { published: 1, sol: 1 });
  assert.equal(report.evaluatedFixtures, 0);
  assert.deepEqual(report.unavailableArms, { kapiloto_published: { none_before_deadline: 2 } });
});

test("shadow switches default to off and budgets are bounded", () => {
  assert.deepEqual(shadowEvaluationFlags({}), { enabled: false, marketCapture: false });
  assert.deepEqual(
    shadowEvaluationFlags({ KAPILOTO_SHADOW_MARKET_CAPTURE_ENABLED: "true" }),
    { enabled: false, marketCapture: false },
  );
  assert.deepEqual(
    shadowEvaluationFlags({
      KAPILOTO_SHADOW_EVALUATION_ENABLED: "true",
      KAPILOTO_SHADOW_MARKET_CAPTURE_ENABLED: "TRUE",
    }),
    { enabled: true, marketCapture: true },
  );
  const config = shadowCycleConfigFromEnv({
    KAPILOTO_SHADOW_MARKET_MAX_REQUESTS_PER_RUN: "12",
    KAPILOTO_SHADOW_MARKET_MAX_REQUESTS_PER_DAY: "-5",
  });
  assert.equal(config.budget.maxRequestsPerRun, 12);
  assert.equal(config.budget.maxRequestsPerDay, DEFAULT_SHADOW_CYCLE_CONFIG.budget.maxRequestsPerDay);
});

function resultsDeps(options: { latestObservedAt: string | null; latestKickoff: string | null; fail?: boolean }) {
  const calls: Array<{ leagueId: string; startDate: string; endDate: string }> = [];
  return {
    calls,
    deps: {
      source: {
        async getLeagueCompletedMatchesBetween(leagueId: string, startDate: string, endDate: string) {
          if (options.fail) throw new Error("sportmonks unavailable");
          calls.push({ leagueId, startDate, endDate });
          return [];
        },
      },
      sink: { async saveResults() { return 0; } },
      freshness: {
        async loadLatestObservedAt() { return options.latestObservedAt; },
        async loadLatestKickoffs(ids: readonly string[]) { return new Map(ids.map((id) => [id, options.latestKickoff])); },
      },
      loadLeagueIds: async () => ["8", "372"],
    },
  };
}

test("recurring results ingestion is disabled unless its dependencies are supplied", async () => {
  const summary = await cycle(setup(), null);
  assert.equal(summary.results.status, "disabled");
});

test("recurring results ingestion skips when it ran recently and never calls the provider", async () => {
  const store = setup();
  const { deps, calls } = resultsDeps({ latestObservedAt: iso(store.nowMs - 2 * HOUR), latestKickoff: iso(store.nowMs - 3 * 86_400_000) });
  const summary = await runShadowEvaluationCycle({
    store, roundId: "round", loadRoundGames: async () => store.games(), market: null, results: deps, now: new Date(store.nowMs),
  });
  assert.equal(summary.results.status, "skipped");
  assert.equal(summary.results.due, false);
  assert.equal(calls.length, 0);
});

test("recurring results ingestion runs when due, from the latest stored kickoff minus the overlap", async () => {
  const store = setup();
  const latestKickoff = iso(store.nowMs - 3 * 86_400_000);
  const { deps, calls } = resultsDeps({ latestObservedAt: iso(store.nowMs - 30 * HOUR), latestKickoff });
  const summary = await runShadowEvaluationCycle({
    store, roundId: "round", loadRoundGames: async () => store.games(), market: null, results: deps, now: new Date(store.nowMs),
  });
  assert.equal(summary.results.status, "ran");
  assert.equal(summary.results.leagues, 2);
  const start = new Date(Date.parse(latestKickoff.slice(0, 10)) - 7 * 86_400_000).toISOString().slice(0, 10);
  assert.ok(calls.length >= 2 && calls.every((call) => call.startDate >= start));
  assert.deepEqual([...new Set(calls.map((call) => call.leagueId))].sort(), ["372", "8"]);
});

test("a failing results ingestion is reported without stopping the other steps", async () => {
  const store = setup();
  const { deps } = resultsDeps({ latestObservedAt: null, latestKickoff: null, fail: true });
  const summary = await runShadowEvaluationCycle({
    store, roundId: "round", loadRoundGames: async () => store.games(), market: null, results: deps, now: new Date(store.nowMs),
  });
  assert.equal(summary.results.status, "failed");
  assert.match(summary.results.error ?? "", /sportmonks unavailable/);
  assert.equal(summary.predictions.status, "ran");
});
