import type { ApiFootballRoundGame } from "@/lib/providers/api-football-sync";

import {
  captureDueMarketQuotes,
  type DueCaptureResult,
  type MarketCaptureBudget,
  type MarketQuoteSource,
  type ProviderRequestMeter,
} from "./market-capture";
import {
  DEFAULT_CADENCE_CONFIG,
  isDue,
  KAPILOTO_SHADOW_CADENCE_VERSION,
  type CadenceConfig,
} from "./market-cadence";
import {
  projectKapilotoPublications,
  recordForwardDeterministicArms,
  scoreShadowFixtures,
  type RecordedFixture,
} from "./shadow-jobs";
import type { ShadowCycleStore } from "./supabase-store";

export type ShadowCycleConfig = {
  cadence: CadenceConfig;
  marketProvider: string;
  budget: Omit<MarketCaptureBudget, "usedLast24h">;
  /** Finished fixtures up to this many days back are (re)offered for scoring. */
  scoringLookbackDays: number;
  /** Minimum minutes after kickoff before a finished fixture is scored. */
  scoringSettleMinutes: number;
};

export const DEFAULT_SHADOW_CYCLE_CONFIG: ShadowCycleConfig = {
  cadence: DEFAULT_CADENCE_CONFIG,
  marketProvider: "api-football",
  budget: {
    maxRequestsPerRun: 30,
    maxRequestsPerDay: 200,
    providerReserve: 100,
    requestsPerCapture: 2,
  },
  scoringLookbackDays: 21,
  scoringSettleMinutes: 180,
};

type StepStatus = "ran" | "disabled" | "skipped" | "failed";

export type ShadowCycleSummary = {
  cadenceVersion: string;
  roundId: string;
  startedAt: string;
  fixtures: number;
  market: {
    status: StepStatus;
    notDue: number;
    requestsUsed: number;
    providerDailyRemaining: number | null;
    results: DueCaptureResult[];
    error: string | null;
  };
  predictions: {
    status: StepStatus;
    due: number;
    recorded: RecordedFixture[];
    error: string | null;
  };
  kapiloto: {
    status: StepStatus;
    publications: number;
    afterDeadline: number;
    inserted: number;
    duplicates: number;
    error: string | null;
  };
  scoring: {
    status: StepStatus;
    candidates: number;
    persisted: number;
    skipped: Array<{ fixtureId: string; reason: string }>;
    error: string | null;
  };
};

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/**
 * One scheduled shadow-evaluation pass. Each step is isolated: a failing step
 * is reported and later steps that depend on it are skipped. Re-running is
 * safe: cadence gates captures and predictions, projections and scores are
 * de-duplicated by unique keys.
 *
 * Only evaluation tables are written (through `store`); production research,
 * publication, prior and recommendation data are read-only here.
 */
export async function runShadowEvaluationCycle(deps: {
  store: ShadowCycleStore;
  roundId: string;
  loadRoundGames: (roundId: string) => Promise<ApiFootballRoundGame[]>;
  market: { source: MarketQuoteSource; meter: ProviderRequestMeter } | null;
  now: Date;
  config?: ShadowCycleConfig;
}): Promise<ShadowCycleSummary> {
  const config = deps.config ?? DEFAULT_SHADOW_CYCLE_CONFIG;
  const nowMs = deps.now.getTime();
  const fixtureIds = await deps.store.loadRoundFixtureIds(deps.roundId);
  const summary: ShadowCycleSummary = {
    cadenceVersion: KAPILOTO_SHADOW_CADENCE_VERSION,
    roundId: deps.roundId,
    startedAt: deps.now.toISOString(),
    fixtures: fixtureIds.length,
    market: {
      status: deps.market ? "ran" : "disabled",
      notDue: 0,
      requestsUsed: 0,
      providerDailyRemaining: null,
      results: [],
      error: null,
    },
    predictions: { status: "ran", due: 0, recorded: [], error: null },
    kapiloto: {
      status: "ran",
      publications: 0,
      afterDeadline: 0,
      inserted: 0,
      duplicates: 0,
      error: null,
    },
    scoring: { status: "ran", candidates: 0, persisted: 0, skipped: [], error: null },
  };

  const capturedNow = new Set<string>();
  if (deps.market) {
    try {
      const [games, lastAttempts, usedLast24h] = await Promise.all([
        deps.loadRoundGames(deps.roundId),
        deps.store.loadLatestCaptureAttempts(fixtureIds),
        deps.store.loadProviderRequestsSince(
          config.marketProvider,
          new Date(nowMs - 86_400_000).toISOString(),
        ),
      ]);
      const capture = await captureDueMarketQuotes(
        games,
        deps.market.source,
        { quotes: deps.store, attempts: deps.store },
        {
          now: deps.now,
          provider: config.marketProvider,
          lastAttempts,
          meter: deps.market.meter,
          budget: { ...config.budget, usedLast24h },
          cadence: config.cadence,
        },
      );
      summary.market.notDue = capture.notDue;
      summary.market.requestsUsed = capture.requestsUsed;
      summary.market.results = capture.results;
      for (const result of capture.results) {
        if (result.status === "saved") capturedNow.add(result.fixtureId);
      }
    } catch (error) {
      summary.market.status = "failed";
      summary.market.error = message(error);
    }
    summary.market.providerDailyRemaining = deps.market.meter.dailyRemaining;
  }

  try {
    const [fixtures, lastPredictions] = await Promise.all([
      deps.store.loadFixturesForEvaluation(fixtureIds),
      deps.store.loadLatestPredictionIssuedAt(fixtureIds, "uniform", "forward"),
    ]);
    const dueIds = fixtures
      .filter((fixture) => {
        const last = lastPredictions.get(fixture.fixtureId);
        const decision = isDue(
          nowMs,
          fixture.kickoffAt,
          last ? { at: last, status: "saved" } : null,
          config.cadence,
        );
        return decision.window != null && (decision.due || capturedNow.has(fixture.fixtureId));
      })
      .map((fixture) => fixture.fixtureId)
      .sort();
    summary.predictions.due = dueIds.length;
    if (dueIds.length > 0) {
      const floors = await deps.store.loadLatestQuoteCapturedAt(dueIds);
      summary.predictions.recorded = await recordForwardDeterministicArms(deps.store, {
        fixtureIds: dueIds,
        now: deps.now,
        informationFloors: floors,
      });
    }
  } catch (error) {
    summary.predictions.status = "failed";
    summary.predictions.error = message(error);
  }

  const scoringFrom = new Date(nowMs - config.scoringLookbackDays * 86_400_000).toISOString();
  const scoringTo = new Date(nowMs - config.scoringSettleMinutes * 60_000).toISOString();
  let finishedIds: string[] = [];
  try {
    finishedIds = await deps.store.loadFinishedFixtureIdsBetween(scoringFrom, scoringTo);
    const projection = await projectKapilotoPublications(deps.store, {
      fixtureIds: [...new Set([...fixtureIds, ...finishedIds])].sort(),
    });
    Object.assign(summary.kapiloto, projection);
  } catch (error) {
    summary.kapiloto.status = "failed";
    summary.kapiloto.error = message(error);
  }

  if (summary.kapiloto.status === "failed") {
    summary.scoring.status = "skipped";
    summary.scoring.error = "kapiloto_projection_failed";
  } else {
    try {
      summary.scoring.candidates = finishedIds.length;
      if (finishedIds.length > 0) {
        const scored = await scoreShadowFixtures(deps.store, {
          fixtureIds: finishedIds,
          mode: "forward",
          persist: true,
        });
        summary.scoring.persisted = scored.persisted;
        summary.scoring.skipped = scored.skipped;
      }
    } catch (error) {
      summary.scoring.status = "failed";
      summary.scoring.error = message(error);
    }
  }

  return summary;
}
