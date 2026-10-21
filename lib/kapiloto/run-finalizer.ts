import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";

import type { EntailmentJudge } from "./entailment-verifier";
import { verifyRequiredEntailment } from "./entailment-verifier";
import type { KapilotoFixtureCard } from "./fixture-card";
import type {
  FrozenFixtureContext,
  ResearchFixtureDisposition,
  ResearchIneligibilityReason,
} from "./research-run-plan";
import type { SolFixtureResearchOutput } from "./research-output";
import {
  materializeKapilotoResearchRun,
  type CarryForwardSource,
  type MaterializableFixture,
  type MaterializedAnalysis,
  type MaterializedRound,
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
  researchCutoffAt: string;
  fixtureSet: ResearchFixtureDisposition[];
  attempts: FinalizableResearchAttempt[];
  carriedSources: CarryForwardSource[];
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

type AnalysisRow = Database["public"]["Tables"]["kapiloto_analyses"]["Row"];

const REASONS = new Set<ResearchIneligibilityReason>([
  "kickoff_too_close",
  "already_started",
  "missing_prior",
  "post_cutoff_prior",
  "invalid_fixture",
]);

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
    throw new Error(
      "Succeeded research attempt has an invalid grounding report.",
    );
  }

  return value as unknown as GroundingResult;
}

function parseOutput(value: unknown): SolFixtureResearchOutput {
  if (!isRecord(value)) {
    throw new Error("Succeeded research attempt is missing validated output.");
  }
  return value as unknown as SolFixtureResearchOutput;
}

function parseReason(value: unknown): ResearchIneligibilityReason {
  if (typeof value !== "string" || !REASONS.has(value as ResearchIneligibilityReason)) {
    throw new Error("Kapiloto run fixture snapshot has an invalid reason.");
  }
  return value as ResearchIneligibilityReason;
}

function parseContext(value: unknown): FrozenFixtureContext {
  if (!isRecord(value)) {
    throw new Error("Kapiloto non-research fixture is missing frozen context.");
  }

  if (
    typeof value.kickoffAt !== "string" ||
    typeof value.settlementRule !== "string" ||
    typeof value.neutralVenue !== "boolean"
  ) {
    throw new Error("Kapiloto frozen fixture context is invalid.");
  }

  return {
    kickoffAt: value.kickoffAt,
    settlementRule: value.settlementRule,
    neutralVenue: value.neutralVenue,
  };
}

function parseFixtureSet(value: Json): ResearchFixtureDisposition[] {
  if (!Array.isArray(value) || value.length !== 16) {
    throw new Error("Kapiloto run fixture snapshot must contain 16 fixtures.");
  }

  return value.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new Error("Kapiloto run fixture snapshot contains an invalid row.");
    }

    const gameNumber = Number(raw.gameNumber);
    const roundGameId = raw.roundGameId;
    const fixtureId = raw.fixtureId;

    if (
      !Number.isInteger(gameNumber) ||
      gameNumber !== index + 1 ||
      typeof roundGameId !== "string" ||
      typeof fixtureId !== "string"
    ) {
      throw new Error("Kapiloto run fixture snapshot identity is invalid.");
    }

    if (raw.mode === "research") {
      if (!isRecord(raw.card)) {
        throw new Error("Kapiloto research fixture is missing its frozen card.");
      }

      return {
        gameNumber,
        roundGameId,
        fixtureId,
        mode: "research" as const,
        taskKey:
          typeof raw.taskKey === "string"
            ? raw.taskKey
            : `fixture:${fixtureId}`,
        card: raw.card as unknown as KapilotoFixtureCard,
      };
    }

    const reason = parseReason(raw.reason);
    const context = parseContext(raw.context);

    if (raw.mode === "carried_forward") {
      if (
        reason === "invalid_fixture" ||
        typeof raw.carriedFromAnalysisId !== "string"
      ) {
        throw new Error("Kapiloto carry-forward fixture snapshot is invalid.");
      }

      return {
        gameNumber,
        roundGameId,
        fixtureId,
        mode: "carried_forward" as const,
        carriedFromAnalysisId: raw.carriedFromAnalysisId,
        reason,
        context,
      };
    }

    if (raw.mode === "research_unavailable") {
      return {
        gameNumber,
        roundGameId,
        fixtureId,
        mode: "research_unavailable" as const,
        reason,
        context,
      };
    }

    throw new Error("Kapiloto run fixture snapshot has an invalid mode.");
  });
}

function jsonArray<T>(value: Json): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function jsonStringArray(value: Json): string[] {
  return jsonArray<unknown>(value).filter(
    (item): item is string => typeof item === "string",
  );
}

function materializedSource(row: AnalysisRow): CarryForwardSource {
  const priorType =
    row.prior_type === "market" ||
    row.prior_type === "rating" ||
    row.prior_type === "league_base"
      ? row.prior_type
      : null;
  const reliabilityBand =
    row.reliability_band === "low" ||
    row.reliability_band === "medium" ||
    row.reliability_band === "high"
      ? row.reliability_band
      : null;
  const modelConfidence =
    row.model_self_confidence === "low" ||
    row.model_self_confidence === "medium" ||
    row.model_self_confidence === "high"
      ? row.model_self_confidence
      : null;
  const primaryPick =
    row.primary_pick === "1" ||
    row.primary_pick === "X" ||
    row.primary_pick === "2"
      ? row.primary_pick
      : null;
  const suggestedDouble =
    row.suggested_double === "1X" ||
    row.suggested_double === "X2" ||
    row.suggested_double === "12"
      ? row.suggested_double
      : null;

  return {
    analysisId: row.id,
    analysis: {
      round_game_id: row.round_game_id,
      fixture_id: row.fixture_id,
      outcome: row.outcome as MaterializedAnalysis["outcome"],
      carried_from_analysis_id: row.carried_from_analysis_id,
      research_cutoff_at: row.research_cutoff_at,
      kickoff_at_snapshot: row.kickoff_at_snapshot,
      settlement_rule_snapshot: row.settlement_rule_snapshot,
      neutral_venue_snapshot: row.neutral_venue_snapshot,
      orientation_verified: row.orientation_verified,
      prior_type: priorType,
      market_snapshot_id: row.market_snapshot_id,
      p_prior_1_bp: row.p_prior_1_bp,
      p_prior_x_bp: row.p_prior_x_bp,
      p_prior_2_bp: row.p_prior_2_bp,
      p_sol_1_bp: row.p_sol_1_bp,
      p_sol_x_bp: row.p_sol_x_bp,
      p_sol_2_bp: row.p_sol_2_bp,
      p_final_1_bp: row.p_final_1_bp,
      p_final_x_bp: row.p_final_x_bp,
      p_final_2_bp: row.p_final_2_bp,
      reliability: row.reliability,
      reliability_band: reliabilityBand,
      reliability_reasons: jsonStringArray(row.reliability_reasons),
      model_self_confidence: modelConfidence,
      primary_pick: primaryPick,
      suggested_double: suggestedDouble,
      double_priority_rank: row.double_priority_rank,
      double_gain_score: row.double_gain_score,
      blend_weight: row.blend_weight,
      deviation_cap_applied: row.deviation_cap_applied,
      summary: row.summary,
      main_risk: row.main_risk,
      availability: jsonArray(row.availability) as SolFixtureResearchOutput["availability"],
      dimension_coverage: jsonArray(row.dimension_coverage) as SolFixtureResearchOutput["dimension_coverage"],
      conflicts: jsonArray(row.conflicts) as SolFixtureResearchOutput["conflicts"],
      watch_items: jsonArray(row.watch_items) as SolFixtureResearchOutput["watch_items"],
      key_assumptions: jsonStringArray(row.key_assumptions),
      data_quality: (
        isRecord(row.data_quality)
          ? row.data_quality
          : { sparse_coverage: true, language_limited: false, notes: "" }
      ) as SolFixtureResearchOutput["data_quality"],
      suspicious_content: jsonArray(row.suspicious_content) as SolFixtureResearchOutput["suspicious_content_observed"],
      valid_until: row.valid_until,
      generated_at: row.generated_at,
      evidence: [],
      factors: [],
      inputs: [],
    },
  };
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
    const [
      { data: runData, error: runError },
      { data: attemptsData, error: attemptsError },
    ] = await Promise.all([
      this.client
        .from("kapiloto_research_runs")
        .select("id,round_id,status,fixture_set,research_cutoff_at")
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
        throw new Error(
          "Succeeded fixture attempt is missing canonical identity.",
        );
      }

      const report = row.validation_report;
      if (!isRecord(report)) {
        throw new Error(
          "Succeeded research attempt is missing validation report.",
        );
      }

      return {
        roundGameId: row.round_game_id,
        fixtureId: row.fixture_id,
        validatedOutput: parseOutput(row.validated_output),
        grounding: parseGrounding(report.grounding),
      };
    });

    const carriedIds = fixtureSet.flatMap((fixture) =>
      fixture.mode === "carried_forward"
        ? [fixture.carriedFromAnalysisId]
        : [],
    );

    let carriedSources: CarryForwardSource[] = [];
    if (carriedIds.length > 0) {
      const { data, error } = await this.client
        .from("kapiloto_analyses")
        .select("*")
        .in("id", carriedIds);

      if (error) {
        throw new Error(
          `Failed to load carry-forward analyses: ${error.message}`,
        );
      }

      carriedSources = ((data ?? []) as AnalysisRow[]).map(materializedSource);
      if (carriedSources.length !== new Set(carriedIds).size) {
        throw new Error("Kapiloto carry-forward source analysis is missing.");
      }
    }

    return {
      runId: String(runData.id),
      roundId: String(runData.round_id),
      status: runData.status,
      researchCutoffAt: String(runData.research_cutoff_at),
      fixtureSet,
      attempts,
      carriedSources,
    };
  }
}

function buildMaterializableRound(
  run: FinalizableResearchRun,
): MaterializableFixture[] {
  const researchFixtures = run.fixtureSet.filter(
    (
      fixture,
    ): fixture is Extract<ResearchFixtureDisposition, { mode: "research" }> =>
      fixture.mode === "research",
  );

  if (run.attempts.length !== researchFixtures.length) {
    throw new Error(
      `Kapiloto run is not complete: ${run.attempts.length}/${researchFixtures.length} succeeded research tasks.`,
    );
  }

  const attempts = new Map(
    run.attempts.map((attempt) => [
      `${attempt.fixtureId}:${attempt.roundGameId}`,
      attempt,
    ]),
  );
  if (attempts.size !== run.attempts.length) {
    throw new Error("Kapiloto run has duplicate succeeded fixture attempts.");
  }

  const carriedSources = new Map(
    run.carriedSources.map((source) => [source.analysisId, source]),
  );

  return run.fixtureSet.map((fixture) => {
    if (fixture.mode === "research") {
      const attempt = attempts.get(
        `${fixture.fixtureId}:${fixture.roundGameId}`,
      );
      if (!attempt) {
        throw new Error(
          `Kapiloto run is missing succeeded attempt for fixture ${fixture.fixtureId}.`,
        );
      }

      return {
        mode: "research" as const,
        gameNumber: fixture.gameNumber,
        roundGameId: fixture.roundGameId,
        fixtureId: fixture.fixtureId,
        card: fixture.card,
        output: attempt.validatedOutput,
        grounding: attempt.grounding,
      };
    }

    if (fixture.mode === "carried_forward") {
      const source = carriedSources.get(fixture.carriedFromAnalysisId);
      if (!source) {
        throw new Error(
          `Kapiloto run is missing carry-forward source ${fixture.carriedFromAnalysisId}.`,
        );
      }

      return {
        mode: "carried_forward" as const,
        gameNumber: fixture.gameNumber,
        roundGameId: fixture.roundGameId,
        fixtureId: fixture.fixtureId,
        carriedFromAnalysisId: fixture.carriedFromAnalysisId,
        reason: fixture.reason,
        context: fixture.context,
        researchCutoffAt: run.researchCutoffAt,
        source,
      };
    }

    return {
      mode: "research_unavailable" as const,
      gameNumber: fixture.gameNumber,
      roundGameId: fixture.roundGameId,
      fixtureId: fixture.fixtureId,
      reason: fixture.reason,
      context: fixture.context,
      researchCutoffAt: run.researchCutoffAt,
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
  const materializable = buildMaterializableRound(run);
  const researched = materializable.filter(
    (
      fixture,
    ): fixture is Extract<MaterializableFixture, { mode: "research" }> =>
      fixture.mode === "research",
  );

  const entailment = await verifyRequiredEntailment(
    researched.map((fixture) => ({
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

  const materialized = materializeKapilotoResearchRun(
    materializable.map((fixture) =>
      fixture.mode === "research"
        ? {
            ...fixture,
            grounding:
              groundingByFixture.get(fixture.fixtureId) ??
              fixture.grounding,
          }
        : fixture,
    ),
  );

  if (entailment.checkedEvidenceCount > 0) {
    const researchedIds = new Set(
      researched.map((fixture) => fixture.fixtureId),
    );
    materialized.analyses
      .filter((analysis) => researchedIds.has(analysis.fixture_id))
      .forEach((analysis) => {
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
