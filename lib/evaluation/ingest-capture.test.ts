import assert from "node:assert/strict";
import test from "node:test";

import type { ApiFootballRoundGame } from "@/lib/providers/api-football-sync";
import type { SportmonksLeagueResult } from "@/lib/providers/sportmonks";
import type { BookmakerThreeWayQuote, ProviderFixture } from "@/lib/providers/types";

import { backtestDeterministicArms } from "./backtest";
import {
  captureRoundMarketQuotes,
  type MarketQuoteDraft,
  type MarketQuoteSource,
} from "./market-capture";
import {
  backfillRange,
  dateWindows,
  ingestLeagueResults,
  toMatchResultRow,
  type MatchResultRow,
} from "./results-ingest";
import { syntheticLeague } from "./test-fixtures";

function completed(overrides: Partial<SportmonksLeagueResult> = {}): SportmonksLeagueResult {
  return {
    providerState: "FT",
    scoreSource: "2ND_HALF",
    provider: "sportmonks",
    providerFixtureId: "19000001",
    kickoffAt: "2026-05-01T18:00:00Z",
    competition: { id: "8", name: "Premier League", country: "England" },
    season: 2025,
    home: { id: "1", name: "Home FC" },
    away: { id: "2", name: "Away FC" },
    homeScore: 2,
    awayScore: 2,
    ...overrides,
  };
}

test("results ingest splits long ranges into bounded provider windows", () => {
  assert.deepEqual(dateWindows("2026-01-01", "2026-01-01"), [
    { start: "2026-01-01", end: "2026-01-01" },
  ]);
  const windows = dateWindows("2025-01-01", "2025-12-31");
  assert.equal(windows.length, 5);
  assert.deepEqual(windows[0], { start: "2025-01-01", end: "2025-03-31" });
  assert.equal(windows[4].end, "2025-12-31");
  assert.throws(() => dateWindows("2026-02-01", "2026-01-01"));
});

test("results ingest keeps only finished, in-league, well-formed regular-time results", () => {
  const observedAt = "2026-05-01T20:30:00.000Z";
  const row = toMatchResultRow(completed(), { leagueId: "8", observedAt });
  assert.equal(row?.home_goals_90, 2);
  assert.equal(row?.result_basis, "regular_time");
  assert.equal(row?.kickoff_at, "2026-05-01T18:00:00.000Z");

  assert.equal(toMatchResultRow(completed({ competition: { id: "9", name: "", country: null } }), { leagueId: "8", observedAt }), null);
  assert.equal(toMatchResultRow(completed({ away: { id: "1", name: "Home FC" } }), { leagueId: "8", observedAt }), null);
  assert.equal(toMatchResultRow(completed({ homeScore: -1 }), { leagueId: "8", observedAt }), null);
  assert.equal(
    toMatchResultRow(completed(), { leagueId: "8", observedAt: "2026-05-01T20:29:00.000Z" }),
    null,
  );
});

test("results ingest reports fetched, eligible and saved counts", async () => {
  const requested: string[] = [];
  const saved: MatchResultRow[] = [];
  const summary = await ingestLeagueResults(
    {
      async getLeagueCompletedMatchesBetween(leagueId, start, end) {
        requested.push(`${leagueId}:${start}:${end}`);
        return [completed(), completed({ providerFixtureId: "x", kickoffAt: "2026-06-01T18:00:00Z" })];
      },
    },
    {
      async saveResults(rows) {
        saved.push(...rows);
        return rows.length;
      },
    },
    { leagueId: "8", startDate: "2026-05-01", endDate: "2026-05-02", now: new Date("2026-05-03T00:00:00Z") },
  );
  assert.deepEqual(requested, ["8:2026-05-01:2026-05-02"]);
  assert.equal(summary.windows, 1);
  assert.equal(summary.fetched, 2);
  assert.equal(summary.eligible, 1);
  assert.equal(summary.saved, 1);
  assert.deepEqual(summary.rejected, { not_yet_final: 1 });
  assert.equal(saved[0].provider_fixture_id, "19000001");
  assert.equal(saved[0].score_source, "2ND_HALF");
  assert.equal(saved[0].provider_state, "FT");
});

test("backfill is chronological, de-duplicated, idempotent and writes nothing in dry-run", async () => {
  const windowsAsked: string[] = [];
  const source = {
    async getLeagueCompletedMatchesBetween(_league: string, start: string) {
      windowsAsked.push(start);
      return [
        completed({ providerFixtureId: `${start}-b`, kickoffAt: `${start}T20:00:00Z` }),
        completed({ providerFixtureId: `${start}-a`, kickoffAt: `${start}T15:00:00Z` }),
        completed({ providerFixtureId: `${start}-a`, kickoffAt: `${start}T15:00:00Z` }),
      ];
    },
  };
  const store = new Map<string, MatchResultRow>();
  const order: string[] = [];
  const sink = {
    async saveResults(rows: MatchResultRow[]) {
      let inserted = 0;
      for (const row of rows) {
        order.push(row.provider_fixture_id);
        if (!store.has(row.provider_fixture_id)) {
          store.set(row.provider_fixture_id, row);
          inserted += 1;
        }
      }
      return inserted;
    },
  };
  const options = { leagueId: "8", startDate: "2025-01-01", endDate: "2025-06-29", now: new Date("2026-01-01T00:00:00Z") };

  const dry = await ingestLeagueResults(source, sink, { ...options, dryRun: true });
  assert.equal(dry.saved, 0);
  assert.equal(store.size, 0);
  assert.equal(dry.eligible, 4);
  assert.equal(dry.duplicatesInFetch, 2);

  const first = await ingestLeagueResults(source, sink, options);
  const second = await ingestLeagueResults(source, sink, options);
  assert.equal(first.saved, 4);
  assert.equal(second.saved, 0);
  assert.deepEqual(windowsAsked.slice(0, 2), ["2025-01-01", "2025-04-01"]);
  assert.deepEqual(order.slice(0, 4), ["2025-01-01-a", "2025-01-01-b", "2025-04-01-a", "2025-04-01-b"]);
  assert.equal(first.firstKickoffAt, "2025-01-01T15:00:00.000Z");
  assert.deepEqual(first.scoreSources, { "2ND_HALF": 4 });
});

test("backfill range covers whole days up to yesterday", () => {
  assert.deepEqual(backfillRange(new Date("2026-10-24T09:00:00Z"), 3), {
    startDate: "2023-10-24",
    endDate: "2026-10-23",
  });
});

function roundGame(overrides: Partial<ApiFootballRoundGame> = {}): ApiFootballRoundGame {
  return {
    roundGameId: "rg-1",
    fixtureId: "fixture-1",
    gameNumber: 1,
    kickoffAt: "2026-10-24T18:00:00.000Z",
    competitionId: "39",
    competitionName: "Premier League",
    home: { teamId: "t-home", canonicalName: "Home", aliases: [], providerTeamId: "33" },
    away: { teamId: "t-away", canonicalName: "Away", aliases: [], providerTeamId: "34" },
    providerFixtureId: 1001,
    ...overrides,
  };
}

const providerFixture: ProviderFixture = {
  provider: "api-football",
  providerFixtureId: "1001",
  kickoffAt: "2026-10-24T18:00:00+00:00",
  status: "NS",
  season: 2026,
  competition: { id: "39", name: "Premier League", country: "England", round: null },
  home: { id: "33", name: "Home" },
  away: { id: "34", name: "Away" },
};

const quote = (bookmakerId: string, odds = { home: 2.1, draw: 3.4, away: 3.6 }): BookmakerThreeWayQuote => ({
  provider: "api-football",
  providerFixtureId: "1001",
  bookmakerId,
  bookmakerName: `Book ${bookmakerId}`,
  capturedAt: "2026-10-24T09:00:00+00:00",
  odds,
});

function source(fixture: ProviderFixture | null, quotes: BookmakerThreeWayQuote[]): MarketQuoteSource {
  return {
    async resolveFixture() {
      return { fixture, resolution: fixture ? "provided_id" : "not_found" };
    },
    async getThreeWayQuotes() {
      return quotes;
    },
  };
}

test("market capture stores raw quotes with normalized implied probabilities", async () => {
  const stored: MarketQuoteDraft[] = [];
  const results = await captureRoundMarketQuotes(
    [roundGame()],
    source(providerFixture, [quote("8"), quote("11", { home: 1, draw: 3, away: 3 })]),
    { async saveQuotes(rows) { stored.push(...rows); return rows.length; } },
    { clock: () => new Date("2026-10-24T10:00:00Z") },
  );
  assert.deepEqual(results.map((item) => [item.status, item.quotes]), [["saved", 1]]);
  assert.equal(stored.length, 1);
  const row = stored[0];
  assert.equal(row.fixture_id, "fixture-1");
  assert.equal(row.devig_method_version, "devig-power-v1");
  assert.equal(row.source_updated_at, "2026-10-24T09:00:00.000Z");
  assert.ok(Math.abs(row.implied_home + row.implied_draw + row.implied_away - 1) < 1e-9);
  assert.ok(row.overround > 0);
});

test("market capture skips kicked-off games, mismatched orientation and empty books", async () => {
  const never = { async saveQuotes(): Promise<number> { throw new Error("should not save"); } };
  const clock = () => new Date("2026-10-24T17:50:00Z");
  assert.equal((await captureRoundMarketQuotes([roundGame()], source(providerFixture, [quote("8")]), never, { clock }))[0].status, "skipped_kickoff");

  const later = () => new Date("2026-10-24T10:00:00Z");
  const swapped = { ...providerFixture, home: providerFixture.away, away: providerFixture.home };
  assert.equal((await captureRoundMarketQuotes([roundGame()], source(swapped, [quote("8")]), never, { clock: later }))[0].status, "orientation_mismatch");
  assert.equal((await captureRoundMarketQuotes([roundGame()], source(providerFixture, []), never, { clock: later }))[0].status, "no_quotes");
  assert.equal((await captureRoundMarketQuotes([roundGame()], source(null, []), never, { clock: later }))[0].status, "not_found");
});

test("market capture resolves through mapped provider ids and reports resolver orientation rejections", async () => {
  const never = { async saveQuotes(): Promise<number> { throw new Error("should not save"); } };
  const later = () => new Date("2026-10-24T10:00:00Z");
  const seen: unknown[] = [];
  const rejecting: MarketQuoteSource = {
    async resolveFixture(input) {
      seen.push({ teamIds: input.providerTeamIds, competitionId: input.providerCompetitionId });
      return { fixture: null, resolution: "orientation_mismatch" };
    },
    async getThreeWayQuotes() {
      throw new Error("should not fetch odds");
    },
  };
  const game = roundGame({ providerFixtureId: null, providerCompetitionId: "39" });
  const [result] = await captureRoundMarketQuotes([game], rejecting, never, { clock: later });
  assert.equal(result.status, "orientation_mismatch");
  assert.deepEqual(seen, [{ teamIds: { home: "33", away: "34" }, competitionId: "39" }]);
});

test("deterministic backtest predicts each match from strictly earlier results", () => {
  const league = syntheticLeague({ teams: 10, seasons: 3 });
  const fromAt = league[180].kickoffAt;
  const toAt = league[225].kickoffAt;
  const { summaries } = backtestDeterministicArms(league, {
    competitionKey: "sportmonks:8",
    fromAt,
    toAt,
  });
  const [uniform, leagueBase, pStat] = summaries;
  assert.equal(uniform.targets, 45);
  assert.equal(uniform.scored, 45);
  assert.ok(Math.abs((uniform.metrics?.meanLogLoss ?? 0) - Math.log(3)) < 1e-12);
  assert.equal(leagueBase.scored, 45);
  assert.ok(pStat.scored > 0);

  const poisoned = league.map((item) =>
    Date.parse(item.kickoffAt) >= Date.parse(toAt) ? { ...item, homeGoals: 9 } : item,
  );
  assert.deepEqual(
    backtestDeterministicArms(poisoned, { competitionKey: "sportmonks:8", fromAt, toAt }).summaries,
    summaries,
  );
});
