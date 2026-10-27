import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";

import type {
  EntailmentJudge,
  EntailmentJudgeCall,
  EntailmentVerificationBatchResult,
} from "./entailment-verifier";
import {
  EntailmentProviderError,
  EntailmentVerificationError,
  verifyRequiredEntailment,
} from "./entailment-verifier";
import { classifyOpenAICallError } from "./openai-research";
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

/**
 * Deterministic data problem in the frozen run (identity, fixture set,
 * missing grounding). Retrying finalization cannot fix it.
 */
export class KapilotoFinalizationDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KapilotoFinalizationDataError";
  }
}

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
  downgradedFixtureIds: string[];
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
    throw new KapilotoFinalizationDataError("Succeeded research attempt is missing grounded evidence.");
  }

  const accepted = value.accepted;
  const rejected = value.rejected;
  const required = value.requiresEntailmentVerification;

  if (
    !Array.isArray(accepted) ||
    !Array.isArray(rejected) ||
    !Array.isArray(required)
  ) {
    throw new KapilotoFinalizationDataError(
      "Succeeded research attempt has an invalid grounding report.",
    );
  }

  return value as unknown as GroundingResult;
}

function parseOutput(value: unknown): SolFixtureResearchOutput {
  if (!isRecord(value)) {
    throw new KapilotoFinalizationDataError("Succeeded research attempt is missing validated output.");
  }
  return value as unknown as SolFixtureResearchOutput;
}

function parseReason(value: unknown): ResearchIneligibilityReason {
  if (typeof value !== "string" || !REASONS.has(value as ResearchIneligibilityReason)) {
    throw new KapilotoFinalizationDataError("Kapiloto run fixture snapshot has an invalid reason.");
  }
  return value as ResearchIneligibilityReason;
}

function parseContext(value: unknown): FrozenFixtureContext {
  if (!isRecord(value)) {
    throw new KapilotoFinalizationDataError("Kapiloto non-research fixture is missing frozen context.");
  }

  if (
    typeof value.kickoffAt !== "string" ||
    typeof value.settlementRule !== "string" ||
    typeof value.neutralVenue !== "boolean"
  ) {
    throw new KapilotoFinalizationDataError("Kapiloto frozen fixture context is invalid.");
  }

  return {
    kickoffAt: value.kickoffAt,
    settlementRule: value.settlementRule,
    neutralVenue: value.neutralVenue,
  };
}

function parseFixtureSet(value: Json): ResearchFixtureDisposition[] {
  if (!Array.isArray(value) || value.length !== 16) {
    throw new KapilotoFinalizationDataError("Kapiloto run fixture snapshot must contain 16 fixtures.");
  }

  return value.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new KapilotoFinalizationDataError("Kapiloto run fixture snapshot contains an invalid row.");
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
      throw new KapilotoFinalizationDataError("Kapiloto run fixture snapshot identity is invalid.");
    }

    if (raw.mode === "research") {
      if (!isRecord(raw.card)) {
        throw new KapilotoFinalizationDataError("Kapiloto research fixture is missing its frozen card.");
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
        throw new KapilotoFinalizationDataError("Kapiloto carry-forward fixture snapshot is invalid.");
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

    throw new KapilotoFinalizationDataError("Kapiloto run fixture snapshot has an invalid mode.");
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
      // Carry-forward deliberately drops time-sensitive V3 tactical detail.
      // A stale predicted XI must never be presented as current after the
      // source run's cutoff.
      expected_lineups: null,
      tactical_facts: null,
      matchup_analysis: null,
      regime_changes: null,
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
      throw new KapilotoFinalizationDataError("Kapiloto run not found.");
    }
    if (attemptsError) {
      throw new Error(
        `Failed to load succeeded Kapiloto attempts: ${attemptsError.message}`,
      );
    }
    if (runData.status !== "queued" && runData.status !== "running") {
      throw new KapilotoFinalizationDataError(
        `Kapiloto run is not finalizable from status ${runData.status}.`,
      );
    }

    const fixtureSet = parseFixtureSet(runData.fixture_set);
    const attempts = ((attemptsData ?? []) as AttemptRow[]).map((row) => {
      if (!row.round_game_id || !row.fixture_id) {
        throw new KapilotoFinalizationDataError(
          "Succeeded fixture attempt is missing canonical identity.",
        );
      }

      const report = row.validation_report;
      if (!isRecord(report)) {
        throw new KapilotoFinalizationDataError(
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
        throw new KapilotoFinalizationDataError("Kapiloto carry-forward source analysis is missing.");
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
    throw new KapilotoFinalizationDataError(
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
    throw new KapilotoFinalizationDataError("Kapiloto run has duplicate succeeded fixture attempts.");
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
        throw new KapilotoFinalizationDataError(
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
        throw new KapilotoFinalizationDataError(
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

export type PreparedKapilotoPublication = {
  materialized: MaterializedRound;
  entailment: EntailmentVerificationBatchResult;
};

/**
 * Deterministic preparation of the 16-fixture publication payload. A genuine
 * `unsupported` entailment verdict is a business result: the affected fixture
 * is withheld as insufficient_data while the rest of the round proceeds.
 */
export async function prepareKapilotoRunPublication(
  run: FinalizableResearchRun,
  judge: EntailmentJudge,
  options: { entailmentTimeoutMs?: number } = {},
): Promise<PreparedKapilotoPublication> {
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
    options.entailmentTimeoutMs != null
      ? { timeoutMs: options.entailmentTimeoutMs }
      : {},
  );

  const groundingByFixture = new Map(
    entailment.fixtures.map((fixture) => [
      fixture.fixtureId,
      fixture.grounding,
    ]),
  );
  const unsupportedByFixture = new Map<string, typeof entailment.unsupported>();
  for (const item of entailment.unsupported) {
    const list = unsupportedByFixture.get(item.fixtureId) ?? [];
    list.push(item);
    unsupportedByFixture.set(item.fixtureId, list);
  }

  let materialized: MaterializedRound;
  try {
    materialized = materializeKapilotoResearchRun(
      materializable.map((fixture) =>
        fixture.mode === "research"
          ? {
              ...fixture,
              grounding:
                groundingByFixture.get(fixture.fixtureId) ?? fixture.grounding,
              ...(unsupportedByFixture.has(fixture.fixtureId)
                ? {
                    entailment: {
                      unsupported: unsupportedByFixture.get(fixture.fixtureId)!,
                      calls: entailment.calls,
                    },
                  }
                : {}),
            }
          : fixture,
      ),
    );
  } catch (error) {
    throw new KapilotoFinalizationDataError(
      error instanceof Error ? error.message : String(error),
    );
  }

  if (entailment.checkedEvidenceCount > 0) {
    const researchedIds = new Set(
      researched.map((fixture) => fixture.fixtureId),
    );
    materialized.analyses
      .filter((analysis) => researchedIds.has(analysis.fixture_id))
      .forEach((analysis) => {
        analysis.inputs.push({
          input_type: "entailment_verification",
          input_version: "kapiloto-entailment-batch-v2",
          metadata: {
            response_ids: entailment.calls
              .map((call) => call.responseId)
              .filter((id): id is string => id != null),
            model: entailment.provenance.model,
            checked_claims: entailment.checkedEvidenceCount,
            unsupported_claims: entailment.unsupported.length,
          },
        });
      });
  }

  return { materialized, entailment };
}

/**
 * Unfenced finalization used by tests and operator tooling. The scheduled
 * worker must use finalizeKapilotoRunWithClaim instead.
 */
export async function finalizeKapilotoRun(
  store: KapilotoRunFinalizationStore,
  publisher: KapilotoRunPublicationSink,
  judge: EntailmentJudge,
  runId: string,
): Promise<FinalizeKapilotoRunResult> {
  const run = await store.load(runId);
  const prepared = await prepareKapilotoRunPublication(run, judge);
  const published = await publisher.publish(runId, prepared.materialized);

  return {
    runId: published.runId,
    roundId: published.roundId,
    checkedEntailments: prepared.entailment.checkedEvidenceCount,
    downgradedFixtureIds: prepared.entailment.downgradedFixtureIds,
    analysisCount: published.analysisCount,
    publishedFixtureCount: published.publishedFixtureCount,
    replayed: published.replayed,
  };
}

// ---------------------------------------------------------------------------
// Database-owned finalization lifecycle
// ---------------------------------------------------------------------------

export const KAPILOTO_FINALIZATION_MAX_ATTEMPTS = 3;
export const KAPILOTO_FINALIZATION_LEASE_SECONDS = 180;
export const KAPILOTO_FINALIZATION_RETRY_DELAY_SECONDS = 60;

export type FinalizationClaimResult =
  | {
      outcome: "claimed";
      attemptId: string;
      attemptNo: number;
      leaseExpiresAt: string;
    }
  | {
      outcome:
        | "already_claimed"
        | "already_completed"
        | "not_finalizable"
        | "not_ready"
        | "backoff"
        | "exhausted";
      detail: Record<string, unknown>;
    };

/** Persisted per finalization attempt. Unknown values are omitted/null. */
export type FinalizationObservability = {
  checked_claims?: number;
  unsupported_claims?: number;
  downgraded_fixture_ids?: string[];
  entailment_response_ids?: string[];
  entailment_model?: string | null;
  input_tokens?: number | null;
  cached_input_tokens?: number | null;
  output_tokens?: number | null;
  reasoning_tokens?: number | null;
  total_tokens?: number | null;
  report?: Record<string, unknown>;
};

export type FinalizationFailure = {
  retryable: boolean;
  code: string;
  detail: string;
  retryDelaySeconds: number;
};

export type FencedPublicationResult = {
  runId: string;
  roundId: string;
  analysisCount: number;
  publishedFixtureCount: number;
  replayed: boolean;
  claimOutcome: "published" | "already_completed";
};

/** The fenced publish RPC rejected this worker: another owner exists. */
export class FinalizationClaimLostError extends Error {
  constructor(message = "Kapiloto finalization claim lost") {
    super(message);
    this.name = "FinalizationClaimLostError";
  }
}

export interface KapilotoFinalizationLedger {
  claim(
    runId: string,
    workerId: string,
    leaseSeconds: number,
  ): Promise<FinalizationClaimResult>;
  heartbeat(
    attemptId: string,
    workerId: string,
    leaseSeconds: number,
    observability?: FinalizationObservability,
  ): Promise<boolean>;
  publish(
    attemptId: string,
    workerId: string,
    materialized: MaterializedRound,
    observability: FinalizationObservability,
  ): Promise<FencedPublicationResult>;
  fail(
    attemptId: string,
    workerId: string,
    failure: FinalizationFailure,
    observability: FinalizationObservability,
  ): Promise<{ outcome: "claim_lost" | "retry_scheduled" | "run_failed" }>;
}

export type ClaimedFinalizationResult =
  | { status: "skipped"; runId: string; reason: string }
  | {
      status: "published";
      runId: string;
      roundId: string;
      attemptNo: number;
      replayed: boolean;
      checkedEntailments: number;
      downgradedFixtureIds: string[];
      analysisCount: number;
      publishedFixtureCount: number;
    }
  | {
      status: "failed";
      runId: string;
      attemptNo: number;
      code: string;
      retryable: boolean;
      ledgerOutcome: "retry_scheduled" | "run_failed";
    }
  | { status: "claim_lost"; runId: string; attemptNo: number; stage: string };

// Exceptions raised by the identity-guarded materialization RPCs. They are
// deterministic for a frozen run, so retrying cannot help.
const DETERMINISTIC_PUBLICATION_FAILURES = [
  /does not match frozen fixture_set/i,
  /requires exactly 16/i,
  /must contain exactly 16/i,
  /partially materialized/i,
  /duplicate fixture identities/i,
  /inconsistent fixture context/i,
  /does not cover 16 distinct/i,
  /Invalid Kapiloto analysis outcome/i,
  /requires at least one accepted grounded evidence/i,
  /Factor references missing/i,
  /not completable from status/i,
  /no longer owns active round state/i,
  /active-run ownership changed/i,
  /still has \d+ active attempts/i,
  /violates check constraint/i,
];

export function classifyFinalizationError(
  error: unknown,
): Omit<FinalizationFailure, "retryDelaySeconds"> {
  const detail = error instanceof Error ? error.message : String(error);

  if (error instanceof EntailmentVerificationError) {
    return {
      retryable: error.retryable,
      code: `entailment_${error.code}`,
      detail,
    };
  }
  if (error instanceof EntailmentProviderError) {
    const provider = classifyOpenAICallError(error.cause);
    return {
      retryable: provider.retryable,
      code: `entailment_${provider.code}`,
      detail,
    };
  }
  if (error instanceof KapilotoFinalizationDataError) {
    return { retryable: false, code: "finalization_data_invalid", detail };
  }
  if (DETERMINISTIC_PUBLICATION_FAILURES.some((pattern) => pattern.test(detail))) {
    return { retryable: false, code: "publication_rejected", detail };
  }
  return { retryable: true, code: "finalization_operational_error", detail };
}

function callsFromError(error: unknown): EntailmentJudgeCall[] {
  if (error instanceof EntailmentVerificationError) return error.calls;
  if (error instanceof EntailmentProviderError) return error.calls;
  return [];
}

function sumUsage(
  calls: EntailmentJudgeCall[],
  pick: (usage: NonNullable<EntailmentJudgeCall["usage"]>) => number | null,
): number | null {
  // Only report a total when every call reported the value; a partial sum
  // would understate real usage.
  if (calls.length === 0) return null;
  let total = 0;
  for (const call of calls) {
    const value = call.usage ? pick(call.usage) : null;
    if (value == null) return null;
    total += value;
  }
  return total;
}

export function finalizationObservability(
  calls: EntailmentJudgeCall[],
  extra: Partial<FinalizationObservability> = {},
): FinalizationObservability {
  return {
    ...extra,
    entailment_response_ids: calls
      .map((call) => call.responseId)
      .filter((id): id is string => id != null),
    entailment_model: calls.find((call) => call.model != null)?.model ?? null,
    input_tokens: sumUsage(calls, (usage) => usage.inputTokens),
    cached_input_tokens: sumUsage(calls, (usage) => usage.cachedInputTokens),
    output_tokens: sumUsage(calls, (usage) => usage.outputTokens),
    reasoning_tokens: sumUsage(calls, (usage) => usage.reasoningTokens),
    total_tokens: sumUsage(calls, (usage) => usage.totalTokens),
    report: {
      ...(extra.report ?? {}),
      entailment_calls: calls.map((call) => ({
        response_id: call.responseId,
        model: call.model,
        claims: call.claims,
        usage: call.usage,
      })),
    },
  };
}

export type FinalizeWithClaimOptions = {
  workerId: string;
  leaseSeconds?: number;
  heartbeatIntervalMs?: number;
  retryDelaySeconds?: number;
  /** Epoch ms by which publication must be complete. */
  deadlineAtMs?: number;
  /** Time kept for the publish RPC after entailment. */
  publishReserveMs?: number;
  now?: () => number;
};

/**
 * Claim → load → entail → materialize exactly 16 → fenced publish.
 * Only the database claim owner may call the entailment judge or publish.
 */
export async function finalizeKapilotoRunWithClaim(
  deps: {
    ledger: KapilotoFinalizationLedger;
    store: KapilotoRunFinalizationStore;
    judge: EntailmentJudge;
  },
  runId: string,
  options: FinalizeWithClaimOptions,
): Promise<ClaimedFinalizationResult> {
  const leaseSeconds = options.leaseSeconds ?? KAPILOTO_FINALIZATION_LEASE_SECONDS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
  const now = options.now ?? Date.now;

  const claim = await deps.ledger.claim(runId, options.workerId, leaseSeconds);
  if (claim.outcome !== "claimed") {
    return { status: "skipped", runId, reason: claim.outcome };
  }

  const { attemptId, attemptNo } = claim;
  let leaseRejected = false;
  let heartbeatInFlight = false;
  const timer =
    heartbeatIntervalMs > 0
      ? setInterval(() => {
          if (heartbeatInFlight || leaseRejected) return;
          heartbeatInFlight = true;
          void deps.ledger
            .heartbeat(attemptId, options.workerId, leaseSeconds)
            .then((owned) => {
              if (!owned) leaseRejected = true;
            })
            .catch(() => undefined)
            .finally(() => {
              heartbeatInFlight = false;
            });
        }, heartbeatIntervalMs)
      : null;

  let calls: EntailmentJudgeCall[] = [];
  let observability: FinalizationObservability = {};

  try {
    const run = await deps.store.load(runId);

    const entailmentTimeoutMs =
      options.deadlineAtMs == null
        ? undefined
        : Math.max(
            10_000,
            Math.min(
              120_000,
              options.deadlineAtMs - now() - (options.publishReserveMs ?? 20_000),
            ),
          );

    const prepared = await prepareKapilotoRunPublication(
      run,
      deps.judge,
      entailmentTimeoutMs != null ? { entailmentTimeoutMs } : {},
    );
    calls = prepared.entailment.calls;
    observability = finalizationObservability(calls, {
      checked_claims: prepared.entailment.checkedEvidenceCount,
      unsupported_claims: prepared.entailment.unsupported.length,
      downgraded_fixture_ids: prepared.entailment.downgradedFixtureIds,
    });

    // Persist the paid entailment usage before publishing, and confirm the
    // claim. A transient heartbeat error is not proof of loss: the publish
    // RPC is fenced by the claim and is the final authority.
    const owned = leaseRejected
      ? false
      : await deps.ledger
          .heartbeat(attemptId, options.workerId, leaseSeconds, observability)
          .catch(() => null);
    if (owned === false) {
      return { status: "claim_lost", runId, attemptNo, stage: "before_publish" };
    }

    const published = await deps.ledger.publish(
      attemptId,
      options.workerId,
      prepared.materialized,
      observability,
    );

    return {
      status: "published",
      runId: published.runId,
      roundId: published.roundId,
      attemptNo,
      replayed: published.replayed,
      checkedEntailments: prepared.entailment.checkedEvidenceCount,
      downgradedFixtureIds: prepared.entailment.downgradedFixtureIds,
      analysisCount: published.analysisCount,
      publishedFixtureCount: published.publishedFixtureCount,
    };
  } catch (error) {
    if (error instanceof FinalizationClaimLostError) {
      return { status: "claim_lost", runId, attemptNo, stage: "publish" };
    }

    const failure = classifyFinalizationError(error);
    const failureCalls = calls.length > 0 ? calls : callsFromError(error);
    const failureObservability =
      calls.length > 0
        ? observability
        : finalizationObservability(failureCalls);

    const recorded = await deps.ledger.fail(
      attemptId,
      options.workerId,
      {
        ...failure,
        retryDelaySeconds:
          options.retryDelaySeconds ?? KAPILOTO_FINALIZATION_RETRY_DELAY_SECONDS,
      },
      {
        ...failureObservability,
        report: { ...(failureObservability.report ?? {}), failure_code: failure.code },
      },
    );

    if (recorded.outcome === "claim_lost") {
      return { status: "claim_lost", runId, attemptNo, stage: "fail" };
    }

    return {
      status: "failed",
      runId,
      attemptNo,
      code: failure.code,
      retryable: failure.retryable,
      ledgerOutcome: recorded.outcome,
    };
  } finally {
    if (timer) clearInterval(timer);
  }
}
