import {
  buildDeterministicArmPredictions,
  EVAL_ARM,
  EVAL_SAFETY_MARGIN_MINUTES,
  requiredHistoryLookbackDays,
} from "./arms";
import type { HistoricalMatchResult } from "./history";
import { selectScoredPrediction } from "./selection";
import type { ShadowCycleStore } from "./supabase-store";

export type ShadowRoundReport = {
  roundId: string;
  generatedAt: string;
  fixtures: number;
  withLeagueHistory: number;
  withValidPStat: number;
  withMarket: { available: number; standard: number; thin: number };
  marketSnapshots: {
    fixturesWithSnapshot: number;
    bookmakersPerSnapshot: { min: number | null; median: number | null; max: number | null };
    latestSnapshotAgeMinutes: { min: number | null; max: number | null };
  };
  frozenKapiloto: { published: number; sol: number };
  storedForwardPredictions: number;
  evaluatedFixtures: number;
  unavailableArms: Record<string, Record<string, number>>;
  perFixture: Array<{
    game: number;
    fixtureId: string;
    kickoffAt: string;
    competition: string | null;
    leagueBase: string;
    pStat: string;
    market: string;
    bookmakers: number | null;
    snapshotAgeMinutes: number | null;
    kapilotoPublished: string;
    scoredArms: number;
  }>;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

/**
 * Read-only operator view of shadow evaluation for one Toto round. Arm
 * availability is recomputed at `now` with the same pure builders the cron
 * uses (capped at each fixture's evaluation deadline); stored predictions and
 * scores are reported as they are. Contains no user data and is never served
 * to clients.
 */
export async function buildShadowRoundReport(
  store: ShadowCycleStore,
  options: { roundId: string; now: Date },
): Promise<ShadowRoundReport> {
  const nowMs = options.now.getTime();
  const fixtureIds = await store.loadRoundFixtureIds(options.roundId);
  const [contexts, fixtures, predictions, scores, snapshots] = await Promise.all([
    store.loadFixtureContexts(fixtureIds),
    store.loadFixturesForEvaluation(fixtureIds),
    store.loadPredictions(fixtureIds, "forward"),
    store.loadScores(fixtureIds, "forward"),
    store.loadLatestQuoteSnapshots(
      fixtureIds,
      new Date(nowMs - 7 * 86_400_000).toISOString(),
    ),
  ]);

  const historyByCompetition = new Map<string, HistoricalMatchResult[]>();
  for (const key of new Set(contexts.map((context) => context.competitionKey))) {
    if (!key) continue;
    historyByCompetition.set(
      key,
      await store.loadHistory(key, options.now.toISOString(), requiredHistoryLookbackDays()),
    );
  }

  const fixtureById = new Map(fixtures.map((fixture) => [fixture.fixtureId, fixture]));
  const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.fixtureId, snapshot]));
  const unavailable: Record<string, Record<string, number>> = {};
  const note = (arm: string, reason: string) => {
    unavailable[arm] = unavailable[arm] ?? {};
    unavailable[arm][reason] = (unavailable[arm][reason] ?? 0) + 1;
  };

  const report: ShadowRoundReport = {
    roundId: options.roundId,
    generatedAt: options.now.toISOString(),
    fixtures: fixtureIds.length,
    withLeagueHistory: 0,
    withValidPStat: 0,
    withMarket: { available: 0, standard: 0, thin: 0 },
    marketSnapshots: {
      fixturesWithSnapshot: snapshots.length,
      bookmakersPerSnapshot: {
        min: snapshots.length ? Math.min(...snapshots.map((s) => s.bookmakers)) : null,
        median: median(snapshots.map((s) => s.bookmakers)),
        max: snapshots.length ? Math.max(...snapshots.map((s) => s.bookmakers)) : null,
      },
      latestSnapshotAgeMinutes: {
        min: snapshots.length
          ? Math.round(Math.min(...snapshots.map((s) => nowMs - Date.parse(s.capturedAt))) / 60_000)
          : null,
        max: snapshots.length
          ? Math.round(Math.max(...snapshots.map((s) => nowMs - Date.parse(s.capturedAt))) / 60_000)
          : null,
      },
    },
    frozenKapiloto: { published: 0, sol: 0 },
    storedForwardPredictions: predictions.length,
    evaluatedFixtures: new Set(scores.map((score) => score.fixture_id)).size,
    unavailableArms: unavailable,
    perFixture: [],
  };

  for (const [index, fixtureId] of fixtureIds.entries()) {
    const context = contexts.find((item) => item.fixtureId === fixtureId);
    const fixture = fixtureById.get(fixtureId);
    if (!context || !fixture) continue;
    const deadlineMs = Date.parse(context.kickoffAt) - EVAL_SAFETY_MARGIN_MINUTES * 60_000;
    const cutoffAt = new Date(Math.min(nowMs, deadlineMs)).toISOString();
    const drafts = buildDeterministicArmPredictions({
      context,
      cutoffAt,
      mode: "forward",
      history: context.competitionKey ? historyByCompetition.get(context.competitionKey) ?? [] : [],
      quotes: await store.loadMarketQuotes(fixtureId, cutoffAt),
    });
    const draft = (arm: string) => drafts.find((item) => item.arm === arm);
    const describe = (arm: string) => {
      const item = draft(arm);
      if (!item) return "missing";
      if (!item.valid) {
        note(arm, item.invalid_reason ?? "unknown");
        return `unavailable:${item.invalid_reason}`;
      }
      return "valid";
    };
    const leagueBase = describe(EVAL_ARM.leagueBase);
    const pStat = describe(EVAL_ARM.pStat);
    const market = describe(EVAL_ARM.market);
    if (leagueBase === "valid") report.withLeagueHistory += 1;
    if (pStat === "valid") report.withValidPStat += 1;
    if (market === "valid") {
      report.withMarket.available += 1;
      const quality = (draft(EVAL_ARM.market)?.basis as { quality?: string }).quality;
      if (quality === "standard") report.withMarket.standard += 1;
      else report.withMarket.thin += 1;
    }

    const kapiloto = (arm: string) =>
      selectScoredPrediction(
        predictions.filter((prediction) => prediction.arm === arm),
        fixture,
        "forward",
      );
    const published = kapiloto(EVAL_ARM.kapilotoPublished);
    const sol = kapiloto(EVAL_ARM.kapilotoSol);
    if (published.status === "selected" && published.prediction.valid) {
      report.frozenKapiloto.published += 1;
    }
    if (sol.status === "selected" && sol.prediction.valid) report.frozenKapiloto.sol += 1;
    const kapilotoPublished =
      published.status === "selected"
        ? published.prediction.valid
          ? "frozen"
          : `unavailable:${published.prediction.invalid_reason}`
        : "none_before_deadline";
    if (kapilotoPublished !== "frozen") note(EVAL_ARM.kapilotoPublished, kapilotoPublished);

    const snapshot = snapshotById.get(fixtureId);
    report.perFixture.push({
      game: index + 1,
      fixtureId,
      kickoffAt: context.kickoffAt,
      competition: context.competitionKey,
      leagueBase,
      pStat,
      market,
      bookmakers: snapshot?.bookmakers ?? null,
      snapshotAgeMinutes: snapshot
        ? Math.round((nowMs - Date.parse(snapshot.capturedAt)) / 60_000)
        : null,
      kapilotoPublished,
      scoredArms: scores.filter((score) => score.fixture_id === fixtureId).length,
    });
  }

  return report;
}
