import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";

import type { EntailmentJudge } from "./entailment-verifier";
import { verifyRequiredEntailment } from "./entailment-verifier";
import type { KapilotoFixtureCard } from "./fixture-card";
import type { SolFixtureResearchOutput } from "./research-output";
import {
  materializeValidatedResearchRound,
  type MaterializedRound,
  type ValidatedFixtureResearch,
} from "./run-materialization";
import type { GroundingResult } from "./source-grounding";

export type FinalizableResearchAttempt = {
  roundGameId: string;
  fixtureId: string;
  validatedOutput: SolFixtureResearchOutput;
  grounding: GroundingResult;
};

export type FinalizableResearchRun = {
  runId: string;
  roundId: string;
  status: "queued" | "running";
  fixtureSet: Array<{
    gameNumber: number;
    roundGameId: string;
    fixtureId: string;
    mode: "research";
    card: KapilotoFixtureCard;
  }>;
  attempts: FinalizableResearchAttempt[];
};

export interface KapilotoRunFinalizationStore {
  load(runId: string): Promise<FinalizableResearchRun>;
}

export interface KapilotoRunPublicationSink {
  publish(
    runId: string,
    materialized: MaterializedRound,
  ): Promise<{
    runId: string;
    roundId: string;
    status: "completed";
    analysisCount: number;
    publishedFixtureCount: number;
    replayed: boolean;
  }>;
}

export type FinalizeKapilotoRunResult = {
  runId: string;
  roundId: string;
  checkedEntailments: number;
  analysisCount: number;
  publishedFixtureCount: number;
  replayed: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseGrounding(value: unknown): GroundingResult {
  if (!isRecord(value)) {
    throw new Error("Succeeded research attempt is missing grounded evidence.");
  }

  const accepted = value.accepted;
  const rejected = value.rejected;
  const required = value.requiresEntailmentVerification;

  if (
    !Array.isArray(accepted) ||
    !Array.isArray(rejected) ||
    !Array.isArray(required)
  ) {
    throw new Error("Succeeded research attempt has an invalid grounding report.");
  }

  return value as unknown as GroundingResult;
}

function parseOutput(value: unknown): SolFixtureResearchOutput {
  if (!isRecord(value)) {
    throw new Error("Succeeded research attempt is missing validated output.");
  }
  return value as unknown as SolFixtureResearchOutput;
}

function parseFixtureSet(
  value: Json,
): FinalizableResearchRun["fixtureSet"] {
  if (!Array.isArray(value) || value.length !== 16) {
    throw new Error("Kapiloto run fixture snapshot must contain 16 fixtures.");
  }

  return value.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new Error("Kapiloto run fixture snapshot contains an invalid row.");
    }

    if (raw.mode !== "research") {
      throw new Error(
        "Run finalizer currently requires all 16 fixtures to be research tasks; carried/unavailable publication is not yet enabled.",
      );
    }

    const gameNumber = Number(raw.gameNumber);
    const roundGameId = raw.roundGameId;
    const fixtureId = raw.fixtureId;
    const card = raw.card;

    if (
      !Number.isInteger(gameNumber) ||
      gameNumber !== index + 1 ||
      typeof roundGameId !== "string" ||
      typeof fixtureId !== "string" ||
      !isRecord(card)
    ) {
      throw new Error("Kapiloto run fixture snapshot identity is invalid.");
    }

    return {
      gameNumber,
      roundGameId,
      fixtureId,
      mode: "research" as const,
      card: card as unknown as KapilotoFixtureCard,
    };
  });
}

type AttemptRow = {
  round_game_id: string | null;
  fixture_id: string | null;
  validated_output: Json | null;
  validation_report: Json | null;
};

export class SupabaseKapilotoRunFinalizationStore
  implements KapilotoRunFinalizationStore
{
  constructor(private readonly client: SupabaseClient<Database>) {}

  async load(runId: string): Promise<FinalizableResearchRun> {
    const [{ data: runData, error: runError }, { data: attemptsData, error: attemptsError }] =
      await Promise.all([
        this.client
          .from("kapiloto_research_runs")
          .select("id,round_id,status,fixture_set")
          .eq("id", runId)
          .maybeSingle(),
        this.client
          .from("kapiloto_research_attempts")
          .select(
            "round_game_id,fixture_id,validated_output,validation_report",
          )
          .eq("run_id", runId)
          .eq("status", "succeeded"),
      ]);

    if (runError) {
      throw new Error(`Failed to load Kapiloto run: ${runError.message}`);
    }
    if (!runData) {
      throw new Error("Kapiloto run not found.");
    }
    if (attemptsError) {
      throw new Error(
        `Failed to load succeeded Kapiloto attempts: ${attemptsError.message}`,
      );
    }
    if (runData.status !== "queued" && runData.status !== "running") {
      throw new Error(
        `Kapiloto run is not finalizable from status ${runData.status}.`,
      );
    }

    const fixtureSet = parseFixtureSet(runData.fixture_set);
    const attempts = ((attemptsData ?? []) as AttemptRow[]).map((row) => {
      if (!row.round_game_id || !row.fixture_id) {
        throw new Error("Succeeded fixture attempt is missing canonical identity.");
      }

      const report = row.validation_report;
      if (!isRecord(report)) {
        throw new Error("Succeeded fixture attempt is missing validation report.");
      }

      return {
        roundGameId: row.round_game_id,
        fixtureId: row.fixture_id,
        validatedOutput: parseOutput(row.validated_output),
        grounding: parseGrounding(report.grounding),
      };
    });

    return {
      runId: String(runData.id),
      roundId: String(runData.round_id),
      status: runData.status,
      fixtureSet,
      attempts,
    };
  }
}

function buildValidatedRound(
  run: FinalizableResearchRun,
): ValidatedFixtureResearch[] {
  if (run.fixtureSet.length !== 16 || run.attempts.length !== 16) {
    throw new Error(
      `Kapiloto run is not complete: ${run.attempts.length}/16 succeeded fixture tasks.`,
    );
  }

  const attempts = new Map(
    run.attempts.map((attempt) => [
      `${attempt.fixtureId}:${attempt.roundGameId}`,
      attempt,
    ]),
  );

  if (attempts.size !== 16) {
    throw new Error("Kapiloto run has duplicate succeeded fixture attempts.");
  }

  return run.fixtureSet.map((fixture) => {
    const attempt = attempts.get(
      `${fixture.fixtureId}:${fixture.roundGameId}`,
    );

    if (!attempt) {
      throw new Error(
        `Kapiloto run is missing succeeded attempt for fixture ${fixture.fixtureId}.`,
      );
    }

    return {
      gameNumber: fixture.gameNumber,
      roundGameId: fixture.roundGameId,
      fixtureId: fixture.fixtureId,
      card: fixture.card,
      output: attempt.validatedOutput,
      grounding: attempt.grounding,
    };
  });
}

export async function finalizeKapilotoRun(
  store: KapilotoRunFinalizationStore,
  publisher: KapilotoRunPublicationSink,
  judge: EntailmentJudge,
  runId: string,
): Promise<FinalizeKapilotoRunResult> {
  const run = await store.load(runId);
  const validated = buildValidatedRound(run);

  const entailment = await verifyRequiredEntailment(
    validated.map((fixture) => ({
      fixtureId: fixture.fixtureId,
      grounding: fixture.grounding,
    })),
    judge,
  );

  const groundingByFixture = new Map(
    entailment.fixtures.map((fixture) => [
      fixture.fixtureId,
      fixture.grounding,
    ]),
  );

  const materialized = materializeValidatedResearchRound(
    validated.map((fixture) => ({
      ...fixture,
      grounding:
        groundingByFixture.get(fixture.fixtureId) ?? fixture.grounding,
    })),
  );

  if (entailment.checkedEvidenceCount > 0) {
    materialized.analyses.forEach((analysis) => {
      analysis.inputs.push({
        input_type: "entailment_verification",
        input_version: "kapiloto-entailment-batch-v1",
        metadata: {
          response_id: entailment.provenance.responseId,
          model: entailment.provenance.model,
        },
      });
    });
  }

  const published = await publisher.publish(runId, materialized);

  return {
    runId: published.runId,
    roundId: published.roundId,
    checkedEntailments: entailment.checkedEvidenceCount,
    analysisCount: published.analysisCount,
    publishedFixtureCount: published.publishedFixtureCount,
    replayed: published.replayed,
  };
}
