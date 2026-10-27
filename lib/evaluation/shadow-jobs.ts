import {
  buildDeterministicArmPredictions,
  DEFAULT_DETERMINISTIC_ARM_CONFIG,
  EVAL_SAFETY_MARGIN_MINUTES,
  requiredHistoryLookbackDays,
  type DeterministicArmConfig,
  type EvalPredictionDraft,
  type EvaluationMode,
  type ShadowFixtureContext,
} from "./arms";
import { projectKapilotoPublication } from "./kapiloto-projection";
import { evaluateFixtures, summarizeByArm } from "./scoring";
import type { ShadowEvaluationStore } from "./supabase-store";

/**
 * The database rejects forward rows whose information cutoff is later than
 * its own insert time, so the app-side cutoff trails the local clock.
 */
export const FORWARD_CUTOFF_CLOCK_SKEW_SECONDS = 60;

export type RecordedFixture = {
  fixtureId: string;
  status: "recorded" | "skipped_past_deadline";
  predictions: number;
  duplicates: number;
};

async function recordAtCutoff(
  store: ShadowEvaluationStore,
  fixtureIds: string[],
  mode: EvaluationMode,
  cutoffFor: (context: ShadowFixtureContext) => string,
  isPastDeadline: (kickoffAt: string) => boolean,
  config: DeterministicArmConfig,
): Promise<RecordedFixture[]> {
  const results: RecordedFixture[] = [];
  const lookbackDays = requiredHistoryLookbackDays(config);

  for (const context of await store.loadFixtureContexts(fixtureIds)) {
    if (isPastDeadline(context.kickoffAt)) {
      results.push({
        fixtureId: context.fixtureId,
        status: "skipped_past_deadline",
        predictions: 0,
        duplicates: 0,
      });
      continue;
    }
    const cutoffAt = cutoffFor(context);
    const [history, quotes] = await Promise.all([
      context.competitionKey
        ? store.loadHistory(context.competitionKey, cutoffAt, lookbackDays)
        : Promise.resolve([]),
      store.loadMarketQuotes(context.fixtureId, cutoffAt),
    ]);
    const drafts = buildDeterministicArmPredictions({
      context,
      cutoffAt,
      mode,
      history,
      quotes,
      config,
    });
    const written = await store.insertPredictions(drafts);
    results.push({
      fixtureId: context.fixtureId,
      status: "recorded",
      predictions: written.inserted,
      duplicates: written.duplicates,
    });
  }

  return results;
}

/**
 * Forward recording of B1-B4 at the current moment. Fixtures already inside
 * the kickoff safety window are skipped; the database stamps the issue time.
 *
 * `informationFloors` may raise a fixture's cutoff to a database-stamped
 * instant (e.g. the latest quote capture), which by construction is not later
 * than the database's insert time.
 */
export function recordForwardDeterministicArms(
  store: ShadowEvaluationStore,
  options: {
    fixtureIds: string[];
    now?: Date;
    config?: DeterministicArmConfig;
    informationFloors?: ReadonlyMap<string, string>;
  },
): Promise<RecordedFixture[]> {
  const nowMs = (options.now ?? new Date()).getTime();
  const deadlineMs = (kickoffAt: string) =>
    Date.parse(kickoffAt) - EVAL_SAFETY_MARGIN_MINUTES * 60_000;
  const baseCutoffMs = nowMs - FORWARD_CUTOFF_CLOCK_SKEW_SECONDS * 1000;
  return recordAtCutoff(
    store,
    options.fixtureIds,
    "forward",
    (context) => {
      const floor = options.informationFloors?.get(context.fixtureId);
      const floorMs = floor ? Date.parse(floor) : Number.NEGATIVE_INFINITY;
      const cutoffMs = Math.min(
        Math.max(baseCutoffMs, Number.isFinite(floorMs) ? floorMs : baseCutoffMs),
        deadlineMs(context.kickoffAt),
      );
      return new Date(cutoffMs).toISOString();
    },
    (kickoffAt) => nowMs > deadlineMs(kickoffAt),
    options.config ?? DEFAULT_DETERMINISTIC_ARM_CONFIG,
  );
}

/**
 * Historical replay for deterministic arms only: each fixture is predicted at
 * kickoff - safety margin - leadMinutes from data knowable at that instant.
 * Never used for LLM arms.
 */
export function recordReplayDeterministicArms(
  store: ShadowEvaluationStore,
  options: { fixtureIds: string[]; leadMinutes?: number; config?: DeterministicArmConfig },
): Promise<RecordedFixture[]> {
  const leadMs = (options.leadMinutes ?? 0) * 60_000;
  return recordAtCutoff(
    store,
    options.fixtureIds,
    "replay",
    (context) =>
      new Date(
        Date.parse(context.kickoffAt) - EVAL_SAFETY_MARGIN_MINUTES * 60_000 - leadMs,
      ).toISOString(),
    () => false,
    options.config ?? DEFAULT_DETERMINISTIC_ARM_CONFIG,
  );
}

/**
 * B5: append projections of immutable Kapiloto publications. Values are
 * copied from the publication, never recomputed, and the database takes the
 * issue time from the publication row; publications made after the
 * evaluation deadline are not recorded because they can never be selected.
 */
export async function projectKapilotoPublications(
  store: ShadowEvaluationStore,
  options: { fixtureIds: string[] },
): Promise<{ publications: number; afterDeadline: number; inserted: number; duplicates: number }> {
  const publications = await store.loadPublishedKapiloto(options.fixtureIds);
  const eligible = publications.filter(
    (publication) =>
      Date.parse(publication.publishedAt) <=
      Date.parse(publication.kickoffAtSnapshot) - EVAL_SAFETY_MARGIN_MINUTES * 60_000,
  );
  const drafts: EvalPredictionDraft[] = eligible.flatMap(projectKapilotoPublication);
  const written = await store.insertPredictions(drafts);
  return {
    publications: publications.length,
    afterDeadline: publications.length - eligible.length,
    ...written,
  };
}

export async function scoreShadowFixtures(
  store: ShadowEvaluationStore,
  options: { fixtureIds: string[]; mode: EvaluationMode; persist: boolean },
) {
  const [fixtures, predictions] = await Promise.all([
    store.loadFixturesForEvaluation(options.fixtureIds),
    store.loadPredictions(options.fixtureIds, options.mode),
  ]);
  const evaluation = evaluateFixtures(fixtures, predictions, options.mode);
  const persisted = options.persist ? await store.insertScores(evaluation.scores) : 0;
  return {
    mode: options.mode,
    fixtures: fixtures.length,
    skipped: evaluation.skipped,
    persisted,
    summary: summarizeByArm(evaluation.scores),
    scores: evaluation.scores,
  };
}
