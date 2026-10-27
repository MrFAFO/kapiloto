import type OpenAI from "openai";

import type { KapilotoFixtureCard } from "./fixture-card";
import type { SolFixtureResearchOutput } from "./research-output";
import type { GroundingResult } from "./source-grounding";
import {
  classifyOpenAICallError,
  KAPILOTO_SOL_DEFAULT_MAX_OUTPUT_TOKENS,
  researchFixtureWithSol,
  SolFixtureResearchError,
  type KapilotoSearchContextSize,
  type KapilotoSolReasoningEffort,
  type SolFailureProvenance,
  type SolFixtureResearchOptions,
  type SolFixtureResearchResult,
} from "./openai-research";
import {
  KAPILOTO_PROMPT_TEMPLATE_SHA256,
  KAPILOTO_RESEARCH_PROTOCOL_VERSION,
  KAPILOTO_RESEARCH_SCHEMA_SHA256,
} from "./research-config";
import {
  estimateSolUsageCostMicros,
  KAPILOTO_SOL_PRICING_VERSION,
} from "./research-cost";

/** The provider request shape used by one attempt; persisted for audit. */
export type ResearchRequestProfile = {
  reasoningEffort: KapilotoSolReasoningEffort;
  searchContextSize: KapilotoSearchContextSize;
  maxOutputTokens: number;
};

export type PriorAttemptFailure = {
  attemptNo: number;
  failureCode: string | null;
  failureDetail: string | null;
  requestProfile: ResearchRequestProfile | null;
};

export const DEFAULT_RESEARCH_REQUEST_PROFILE: ResearchRequestProfile = {
  reasoningEffort: "medium",
  searchContextSize: "high",
  maxOutputTokens: KAPILOTO_SOL_DEFAULT_MAX_OUTPUT_TOKENS,
};

/** Grounding fetches sources (8s per request) and finishes the attempt. */
export const DEFAULT_POST_MODEL_RESERVE_MS = 60_000;
/** Below this, a fixture research call is not worth starting. */
export const DEFAULT_MINIMUM_MODEL_BUDGET_MS = 120_000;

export type ClaimedResearchAttempt = {
  attemptId: string;
  runId: string;
  roundId: string;
  taskKey: string;
  roundGameId: string | null;
  attemptNo: number;
  leaseExpiresAt: string;
  fixtureCard: KapilotoFixtureCard | null;
  run: {
    modelKey: string;
    researchProtocolVersion: string;
    promptTemplateSha256: string;
    maxAttemptsPerTask: number;
    executionTopology: "fixture_fanout" | "round_batch";
    researchCutoffAt: string;
  };
};

export type FinishResearchAttemptInput = {
  attemptId: string;
  workerId: string;
  success: boolean;
  retryable: boolean;
  retryDelaySeconds: number;
  modelSnapshot: string | null;
  providerResponseId: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  webSearchCalls: number | null;
  sourcesCount: number | null;
  costMicros: number | null;
  pricingVersion: string | null;
  modelMs: number | null;
  validationMs: number | null;
  totalMs: number | null;
  failureClass: string | null;
  failureCode: string | null;
  failureDetail: string | null;
  validatedOutput: unknown | null;
  validationReport: Record<string, unknown>;
  traceId: string | null;
};

export interface ResearchAttemptQueue {
  claim(workerId: string, leaseSeconds: number): Promise<ClaimedResearchAttempt | null>;
  heartbeat(
    attemptId: string,
    workerId: string,
    leaseSeconds: number,
  ): Promise<boolean>;
  finish(input: FinishResearchAttemptInput): Promise<{
    retryCreated: boolean;
    nextAttemptId: string | null;
  }>;
  /** Earlier terminal attempts of the same task, used to vary retries. */
  priorFailures?(
    runId: string,
    taskKey: string,
    beforeAttemptNo: number,
  ): Promise<PriorAttemptFailure[]>;
}

export interface FixtureResearchRunner {
  research(
    card: KapilotoFixtureCard,
    options: SolFixtureResearchOptions,
  ): Promise<SolFixtureResearchResult>;
}

export interface FixtureEvidenceGrounder {
  ground(
    card: KapilotoFixtureCard,
    output: SolFixtureResearchOutput,
    observedSourceUrls: string[],
  ): Promise<{
    grounding: GroundingResult;
    retrievalFailures: Array<{ url: string; error: string }>;
  }>;
}

export type ExecuteResearchTaskOptions = {
  workerId: string;
  leaseSeconds?: number;
  heartbeatIntervalMs?: number;
  reasoningEffort?: SolFixtureResearchOptions["reasoningEffort"];
  searchContextSize?: KapilotoSearchContextSize;
  maxOutputTokens?: number;
  grounder?: FixtureEvidenceGrounder;
  traceId?: string | null;
  /** Epoch ms by which this invocation must have finished its attempt. */
  deadlineAtMs?: number;
  postModelReserveMs?: number;
  minimumModelBudgetMs?: number;
  now?: () => number;
};

export type ExecuteResearchTaskResult =
  | { status: "no_work" }
  | {
      status: "deferred";
      reason: "insufficient_time" | "weekly_budget";
    }
  | { status: "succeeded"; attemptId: string; runId: string }
  | {
      status: "failed";
      attemptId: string;
      runId: string;
      retryable: boolean;
      retryCreated: boolean;
      failureClass: string;
    }
  | { status: "lease_lost"; attemptId: string; runId: string };

function validateClaim(attempt: ClaimedResearchAttempt): KapilotoFixtureCard {
  if (attempt.run.executionTopology !== "fixture_fanout") {
    throw new Error(
      "Fixture executor cannot process a round_batch research attempt.",
    );
  }
  if (!attempt.roundGameId || !attempt.fixtureCard) {
    throw new Error("Fixture research attempt is missing a frozen Fixture Card.");
  }
  if (attempt.fixtureCard.round_game_id !== attempt.roundGameId) {
    throw new Error("Claimed attempt round_game_id does not match Fixture Card.");
  }
  const cardCutoffMs = Date.parse(attempt.fixtureCard.research_cutoff_at);
  const runCutoffMs = Date.parse(attempt.run.researchCutoffAt);
  if (
    !Number.isFinite(cardCutoffMs) ||
    !Number.isFinite(runCutoffMs) ||
    cardCutoffMs !== runCutoffMs
  ) {
    throw new Error("Claimed attempt cutoff does not match run cutoff.");
  }

  return attempt.fixtureCard;
}

const EFFORT_LADDER: KapilotoSolReasoningEffort[] = ["low", "medium", "high"];
const SEARCH_CONTEXT_LADDER: KapilotoSearchContextSize[] = [
  "low",
  "medium",
  "high",
];

function sameProfile(
  left: ResearchRequestProfile,
  right: ResearchRequestProfile,
): boolean {
  return (
    left.reasoningEffort === right.reasoningEffort &&
    left.searchContextSize === right.searchContextSize &&
    left.maxOutputTokens === right.maxOutputTokens
  );
}

/**
 * The next cheaper request shape after a capacity failure (output budget or
 * deadline exhausted): lower reasoning effort first, then a smaller search
 * context. Returns null when nothing cheaper remains.
 */
export function stepDownRequestProfile(
  profile: ResearchRequestProfile,
): ResearchRequestProfile | null {
  const effortIndex = EFFORT_LADDER.indexOf(profile.reasoningEffort);
  if (effortIndex > 0) {
    return { ...profile, reasoningEffort: EFFORT_LADDER[effortIndex - 1] };
  }
  const contextIndex = SEARCH_CONTEXT_LADDER.indexOf(profile.searchContextSize);
  if (contextIndex > 0) {
    return {
      ...profile,
      searchContextSize: SEARCH_CONTEXT_LADDER[contextIndex - 1],
    };
  }
  return null;
}

export function isCapacityFailure(failure: PriorAttemptFailure): boolean {
  const code = failure.failureCode ?? "";
  return (
    code === "sol_incomplete:max_output_tokens" ||
    code === "sol_incomplete:unknown" ||
    code === "sol_deadline_exceeded"
  );
}

/**
 * Never repeat a request shape that already exhausted its budget for this
 * task. Failures recorded without a profile (pre-patch attempts that ran
 * with a smaller output cap) do not force a step-down.
 */
export function selectRequestProfile(
  base: ResearchRequestProfile,
  priorFailures: PriorAttemptFailure[],
): ResearchRequestProfile {
  let profile = base;
  const ordered = [...priorFailures].sort((a, b) => a.attemptNo - b.attemptNo);

  for (const failure of ordered) {
    if (!isCapacityFailure(failure) || !failure.requestProfile) continue;
    if (!sameProfile(failure.requestProfile, profile)) continue;
    profile = stepDownRequestProfile(profile) ?? profile;
  }

  return profile;
}

function profileReport(profile: ResearchRequestProfile) {
  return {
    reasoning_effort: profile.reasoningEffort,
    search_context_size: profile.searchContextSize,
    max_output_tokens: profile.maxOutputTokens,
    prompt_template_sha256: KAPILOTO_PROMPT_TEMPLATE_SHA256,
    output_schema_sha256: KAPILOTO_RESEARCH_SCHEMA_SHA256,
  };
}

function solFailure(error: unknown): SolFixtureResearchError {
  return error instanceof SolFixtureResearchError
    ? error
    : classifyOpenAICallError(error);
}

function provenanceUsage(provenance: SolFailureProvenance | null) {
  return {
    inputTokens: provenance?.usage.inputTokens ?? null,
    cachedInputTokens: provenance?.usage.cachedInputTokens ?? null,
    outputTokens: provenance?.usage.outputTokens ?? null,
    reasoningTokens: provenance?.usage.reasoningTokens ?? null,
  };
}

function semanticStage(code: string): string {
  if (code === "sol_semantic_validation_failed") return "failed";
  if (code === "sol_output_unparseable" || code === "sol_output_empty") {
    return "failed";
  }
  return "not_started";
}

/**
 * A run frozen under another research protocol must never be executed with
 * this worker's prompt/schema. Raised before any paid model call.
 */
export class ResearchProtocolMismatchError extends Error {
  constructor(readonly runProtocol: string) {
    super(
      `Frozen research run protocol ${runProtocol} does not match worker protocol ${KAPILOTO_RESEARCH_PROTOCOL_VERSION}.`,
    );
    this.name = "ResearchProtocolMismatchError";
  }
}

/** Marks a failed write of a successful result; never recorded as failure. */
class SuccessFinishError extends Error {
  constructor(readonly cause: unknown) {
    super("Failed to record a successful Kapiloto research attempt.");
    this.name = "SuccessFinishError";
  }
}

function retryDelaySeconds(attemptNo: number): number {
  return Math.min(60, 5 * 2 ** Math.max(0, attemptNo - 1));
}

function emptyUsage() {
  return {
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
  };
}

export const GROUNDING_POLICY_DOWNGRADE_REASON =
  "grounding_policy_insufficient";

function downgradeOutputForGroundingPolicy(
  output: SolFixtureResearchOutput,
): SolFixtureResearchOutput {
  return {
    ...output,
    outcome: "insufficient_data",
    availability: [],
    factors: [],
    dimension_coverage: output.dimension_coverage.map((item) => ({
      ...item,
      status: "insufficient_data" as const,
    })),
    conflicts: [],
    market_deviation: null,
    key_assumptions: [],
    main_risk: "Grounded evidence was insufficient for a reliable recommendation.",
    summary: "No recommendation was published because required evidence did not pass grounding.",
    watch_items: [],
    data_quality: {
      ...output.data_quality,
      sparse_coverage: true,
      notes: GROUNDING_POLICY_DOWNGRADE_REASON,
    },
    model_self_confidence: "low",
  };
}

function groundedEvidenceIndependent(
  left: GroundingResult["accepted"][number],
  right: GroundingResult["accepted"][number],
): boolean {
  if (left.domain === right.domain) return false;
  return !(
    left.syndicationClusterId &&
    right.syndicationClusterId &&
    left.syndicationClusterId === right.syndicationClusterId
  );
}

export function sanitizeOutputForGrounding(
  output: SolFixtureResearchOutput,
  grounding: GroundingResult,
): {
  output: SolFixtureResearchOutput;
  droppedItems: string[];
  wholeFixtureDowngraded: boolean;
} {
  const acceptedById = new Map(
    grounding.accepted.map((item) => [item.modelEvidenceId, item]),
  );
  const allAccepted = (ids: string[]) =>
    ids.length > 0 && ids.every((id) => acceptedById.has(id));
  const droppedItems: string[] = [];

  const availability = output.availability.filter((item) => {
    const keep = allAccepted(item.evidence_ids);
    if (!keep) droppedItems.push(`availability:${item.player_name}`);
    return keep;
  });

  const factors = output.factors.filter((factor) => {
    if (!allAccepted(factor.evidence_ids)) {
      droppedItems.push(`factor:${factor.dimension}`);
      return false;
    }
    if (factor.magnitude === "small") return true;

    const supporting = factor.evidence_ids.map((id) => acceptedById.get(id)!);
    const hasStrongSource = supporting.some((item) => item.trustTier <= 2);
    const hasTwoIndependent = supporting.some((left, index) =>
      supporting
        .slice(index + 1)
        .some((right) => groundedEvidenceIndependent(left, right)),
    );
    if (!hasStrongSource && !hasTwoIndependent) {
      droppedItems.push(`factor:${factor.dimension}:insufficient_corroboration`);
      return false;
    }
    return true;
  });

  const conflicts = output.conflicts.filter((conflict) => {
    const keep =
      allAccepted(conflict.evidence_ids_a) &&
      allAccepted(conflict.evidence_ids_b);
    if (!keep) droppedItems.push(`conflict:${conflict.topic}`);
    return keep;
  });

  const marketDeviation =
    output.market_deviation &&
    allAccepted(output.market_deviation.evidence_ids)
      ? output.market_deviation
      : null;
  if (output.market_deviation && !marketDeviation) {
    droppedItems.push("market_deviation");
  }

  if (output.outcome === "analyzed" && factors.length === 0) {
    return {
      output: downgradeOutputForGroundingPolicy(output),
      droppedItems,
      wholeFixtureDowngraded: true,
    };
  }

  const droppedDimensions = new Set(
    droppedItems
      .filter((item) => item.startsWith("factor:"))
      .map((item) => item.split(":")[1]),
  );

  return {
    output: {
      ...output,
      availability,
      factors,
      conflicts,
      market_deviation: marketDeviation,
      dimension_coverage: output.dimension_coverage.map((item) =>
        droppedDimensions.has(item.dimension)
          ? { ...item, status: "insufficient_data" as const }
          : item,
      ),
      ...(droppedItems.length > 0
        ? {
            summary:
              factors.length > 0
                ? factors
                    .slice(0, 2)
                    .map((factor) => factor.rationale)
                    .join(" ")
                : output.summary,
            main_risk:
              "Some reported inputs were excluded because they did not pass evidence grounding.",
            key_assumptions: [],
            watch_items: [],
            data_quality: {
              ...output.data_quality,
              sparse_coverage: true,
              notes: [
                output.data_quality.notes,
                "unsupported_items_removed",
              ]
                .filter(Boolean)
                .join("; "),
            },
          }
        : {}),
    },
    droppedItems,
    wholeFixtureDowngraded: false,
  };
}

export function createOpenAIFixtureResearchRunner(
  client: OpenAI,
): FixtureResearchRunner {
  return {
    research(card, options) {
      return researchFixtureWithSol(client, card, options);
    },
  };
}

export async function executeOneResearchTask(
  queue: ResearchAttemptQueue,
  runner: FixtureResearchRunner,
  options: ExecuteResearchTaskOptions,
): Promise<ExecuteResearchTaskResult> {
  const leaseSeconds = options.leaseSeconds ?? 900;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? Math.max(15_000, Math.floor((leaseSeconds * 1000) / 3));
  const now = options.now ?? Date.now;
  const postModelReserveMs =
    options.postModelReserveMs ?? DEFAULT_POST_MODEL_RESERVE_MS;
  const minimumModelBudgetMs =
    options.minimumModelBudgetMs ?? DEFAULT_MINIMUM_MODEL_BUDGET_MS;

  const modelBudgetMs = () =>
    options.deadlineAtMs == null
      ? null
      : options.deadlineAtMs - now() - postModelReserveMs;

  // Do not claim work this invocation cannot finish: a platform kill after a
  // paid provider call loses its provenance and burns an attempt via lease
  // expiry.
  const initialBudget = modelBudgetMs();
  if (initialBudget != null && initialBudget < minimumModelBudgetMs) {
    return { status: "deferred", reason: "insufficient_time" };
  }

  const attempt = await queue.claim(options.workerId, leaseSeconds);
  if (!attempt) return { status: "no_work" };

  const startedAt = now();
  let heartbeatLost = false;
  let heartbeatInFlight = false;

  const heartbeatTimer =
    heartbeatIntervalMs > 0
      ? setInterval(() => {
          if (heartbeatInFlight || heartbeatLost) return;
          heartbeatInFlight = true;
          void queue
            .heartbeat(attempt.attemptId, options.workerId, leaseSeconds)
            .then((owned) => {
              // Only an explicit rejection proves another owner. A transient
              // RPC error is re-checked by the ownership test before finish.
              if (!owned) heartbeatLost = true;
            })
            .catch(() => undefined)
            .finally(() => {
              heartbeatInFlight = false;
            });
        }, heartbeatIntervalMs)
      : null;

  const confirmOwnership = async (): Promise<boolean> =>
    heartbeatLost
      ? false
      : queue
          .heartbeat(attempt.attemptId, options.workerId, leaseSeconds)
          .catch(() => false);

  const reportLostProvenance = (
    stage: string,
    provenance: SolFailureProvenance | SolFixtureResearchResult["provenance"] | null,
  ) => {
    if (!provenance) return;
    // The finish RPC rejects a non-owner, so keep billable usage visible in
    // logs when the lease was lost after the provider call returned.
    console.warn("Kapiloto attempt lost its lease after a provider response", {
      attemptId: attempt.attemptId,
      runId: attempt.runId,
      stage,
      providerResponseId: provenance.responseId,
      model: provenance.model,
      usage: provenance.usage,
      webSearchCalls: provenance.webSearchCalls,
    });
  };

  try {
    const card = validateClaim(attempt);

    if (
      attempt.run.researchProtocolVersion !==
      KAPILOTO_RESEARCH_PROTOCOL_VERSION
    ) {
      throw new ResearchProtocolMismatchError(
        attempt.run.researchProtocolVersion,
      );
    }

    const baseProfile: ResearchRequestProfile = {
      reasoningEffort:
        options.reasoningEffort ?? DEFAULT_RESEARCH_REQUEST_PROFILE.reasoningEffort,
      searchContextSize:
        options.searchContextSize ??
        DEFAULT_RESEARCH_REQUEST_PROFILE.searchContextSize,
      maxOutputTokens:
        options.maxOutputTokens ?? DEFAULT_RESEARCH_REQUEST_PROFILE.maxOutputTokens,
    };
    // Retry-shape selection is an optimisation: a failed history read must
    // not turn into a non-retryable task failure.
    const priorFailures =
      attempt.attemptNo > 1 && queue.priorFailures
        ? await queue
            .priorFailures(attempt.runId, attempt.taskKey, attempt.attemptNo)
            .catch(() => [])
        : [];
    const profile = selectRequestProfile(baseProfile, priorFailures);
    const timeoutMs = modelBudgetMs();

    const modelStartedAt = now();

    let research: SolFixtureResearchResult;
    try {
      research = await runner.research(card, {
        model: attempt.run.modelKey,
        reasoningEffort: profile.reasoningEffort,
        searchContextSize: profile.searchContextSize,
        maxOutputTokens: profile.maxOutputTokens,
        ...(timeoutMs != null ? { timeoutMs: Math.max(1_000, timeoutMs) } : {}),
      });
    } catch (error) {
      const failure = solFailure(error);
      const provenance = failure.provenance;

      if (!(await confirmOwnership())) {
        reportLostProvenance("model_call", provenance);
        return {
          status: "lease_lost",
          attemptId: attempt.attemptId,
          runId: attempt.runId,
        };
      }

      // A capacity failure only deserves another attempt if the next attempt
      // can use a cheaper request shape; repeating it verbatim wastes budget.
      const retryable =
        failure.retryable &&
        (!failure.capacityLimited || stepDownRequestProfile(profile) != null);

      const finish = await queue.finish({
        attemptId: attempt.attemptId,
        workerId: options.workerId,
        success: false,
        retryable,
        retryDelaySeconds: retryDelaySeconds(attempt.attemptNo),
        modelSnapshot: provenance?.model ?? attempt.run.modelKey,
        providerResponseId: provenance?.responseId ?? null,
        ...provenanceUsage(provenance),
        webSearchCalls: provenance?.webSearchCalls ?? null,
        sourcesCount: provenance ? provenance.sourceUrls.length : null,
        costMicros: provenance
          ? estimateSolUsageCostMicros({
              inputTokens: provenance.usage.inputTokens,
              cachedInputTokens: provenance.usage.cachedInputTokens,
              outputTokens: provenance.usage.outputTokens,
              webSearchCalls: provenance.webSearchCalls,
            })
          : null,
        pricingVersion: provenance ? KAPILOTO_SOL_PRICING_VERSION : null,
        modelMs: now() - modelStartedAt,
        validationMs: null,
        totalMs: now() - startedAt,
        failureClass: failure.failureClass,
        failureCode: failure.code,
        failureDetail: failure.message,
        validatedOutput: null,
        validationReport: {
          semantic_validation: semanticStage(failure.code),
          request_profile: profileReport(profile),
          request_timeout_ms: timeoutMs,
          provider_response_received: provenance != null,
          provider_total_tokens: provenance?.usage.totalTokens ?? null,
          source_urls_observed: provenance?.sourceUrls ?? [],
          capacity_limited: failure.capacityLimited,
          prior_failure_codes: priorFailures.map((item) => item.failureCode),
        },
        traceId: options.traceId ?? null,
      });

      return {
        status: "failed",
        attemptId: attempt.attemptId,
        runId: attempt.runId,
        retryable,
        retryCreated: finish.retryCreated,
        failureClass: failure.failureClass,
      };
    }

    const validationStartedAt = now();
    const rawValidatedOutput = JSON.parse(
      JSON.stringify(research.output),
    ) as SolFixtureResearchOutput;
    let grounding:
      | {
          grounding: GroundingResult;
          retrievalFailures: Array<{ url: string; error: string }>;
        }
      | null = null;

    if (options.grounder) {
      const grounder = options.grounder;
      const groundOnce = () =>
        grounder.ground(card, research.output, research.provenance.sourceUrls);
      try {
        try {
          grounding = await groundOnce();
        } catch (firstError) {
          // Grounding re-fetches sources and reads the registry; a transient
          // failure there must not discard a paid, validated Sol result.
          // Retry once in-process when the invocation still has time.
          const remaining =
            options.deadlineAtMs == null
              ? Number.POSITIVE_INFINITY
              : options.deadlineAtMs - now();
          if (remaining < 30_000) throw firstError;
          grounding = await groundOnce();
        }
      } catch (error) {
        if (!(await confirmOwnership())) {
          reportLostProvenance("grounding", research.provenance);
          return {
            status: "lease_lost",
            attemptId: attempt.attemptId,
            runId: attempt.runId,
          };
        }

        const finish = await queue.finish({
          attemptId: attempt.attemptId,
          workerId: options.workerId,
          success: false,
          retryable: true,
          retryDelaySeconds: retryDelaySeconds(attempt.attemptNo),
          modelSnapshot: research.provenance.model,
          providerResponseId: research.provenance.responseId,
          inputTokens: research.provenance.usage.inputTokens,
          cachedInputTokens: research.provenance.usage.cachedInputTokens,
          outputTokens: research.provenance.usage.outputTokens,
          reasoningTokens: research.provenance.usage.reasoningTokens,
          webSearchCalls: research.provenance.webSearchCalls,
          sourcesCount: research.provenance.sourceUrls.length,
          costMicros: estimateSolUsageCostMicros({
            inputTokens: research.provenance.usage.inputTokens,
            cachedInputTokens: research.provenance.usage.cachedInputTokens,
            outputTokens: research.provenance.usage.outputTokens,
            webSearchCalls: research.provenance.webSearchCalls,
          }),
          pricingVersion: KAPILOTO_SOL_PRICING_VERSION,
          modelMs: validationStartedAt - modelStartedAt,
          validationMs: now() - validationStartedAt,
          totalMs: now() - startedAt,
          failureClass: "model_output_invalid",
          failureCode: "evidence_grounding_failed",
          failureDetail: error instanceof Error ? error.message : String(error),
          validatedOutput: null,
          validationReport: {
            semantic_validation: "passed",
            request_profile: profileReport(profile),
            request_timeout_ms: timeoutMs,
            provider_total_tokens: research.provenance.usage.totalTokens,
            source_urls_observed: research.provenance.sourceUrls,
            quote_verification: "failed",
            entailment_verification: "not_started",
          },
          traceId: options.traceId ?? null,
        });

        return {
          status: "failed",
          attemptId: attempt.attemptId,
          runId: attempt.runId,
          retryable: true,
          retryCreated: finish.retryCreated,
          failureClass: "model_output_invalid",
        };
      }
    }

    const groundingPolicyFailures =
      grounding?.grounding.policyFailures?.filter(Boolean) ?? [];

    // Publication policy is intentionally deferred until after entailment.
    // Persist the complete validated model output here so finalization can
    // make one deterministic decision from raw output + grounding + verdicts.
    // Do not sanitize or downgrade the fixture at attempt time.
    const groundingSanitization = null;

    if (!(await confirmOwnership())) {
      reportLostProvenance("finish", research.provenance);
      return {
        status: "lease_lost",
        attemptId: attempt.attemptId,
        runId: attempt.runId,
      };
    }

    const successInput: FinishResearchAttemptInput = {
      attemptId: attempt.attemptId,
      workerId: options.workerId,
      success: true,
      retryable: false,
      retryDelaySeconds: 0,
      modelSnapshot: research.provenance.model,
      providerResponseId: research.provenance.responseId,
      inputTokens: research.provenance.usage.inputTokens,
      cachedInputTokens: research.provenance.usage.cachedInputTokens,
      outputTokens: research.provenance.usage.outputTokens,
      reasoningTokens: research.provenance.usage.reasoningTokens,
      webSearchCalls: research.provenance.webSearchCalls,
      sourcesCount: research.provenance.sourceUrls.length,
      costMicros: estimateSolUsageCostMicros({
        inputTokens: research.provenance.usage.inputTokens,
        cachedInputTokens: research.provenance.usage.cachedInputTokens,
        outputTokens: research.provenance.usage.outputTokens,
        webSearchCalls: research.provenance.webSearchCalls,
      }),
      pricingVersion: KAPILOTO_SOL_PRICING_VERSION,
      modelMs: validationStartedAt - modelStartedAt,
      validationMs: now() - validationStartedAt,
      totalMs: now() - startedAt,
      failureClass: null,
      failureCode: null,
      failureDetail: null,
      validatedOutput: research.output,
      validationReport: {
        semantic_validation: "passed",
        request_profile: profileReport(profile),
        request_timeout_ms: timeoutMs,
        provider_total_tokens: research.provenance.usage.totalTokens,
        source_urls_observed: research.provenance.sourceUrls,
        quote_verification: grounding ? "passed" : "pending",
        entailment_verification:
          grounding &&
          grounding.grounding.requiresEntailmentVerification.length === 0
            ? "not_required"
            : "pending",
        grounding: grounding?.grounding ?? null,
        grounding_policy_downgraded: false,
        grounding_policy_failures: groundingPolicyFailures,
        grounding_policy_dropped_items: [],
        raw_validated_output: rawValidatedOutput,
        source_retrieval_failures: grounding?.retrievalFailures ?? [],
      },
      traceId: options.traceId ?? null,
    };

    try {
      await queue.finish(successInput);
    } catch {
      // Retry the success write once. If it still fails, do NOT fall through
      // to the generic failure path: recording a non-retryable failure would
      // fail the whole run although the research succeeded. Leaving the
      // attempt running lets lease recovery retry it instead.
      try {
        await queue.finish(successInput);
      } catch (finishError) {
        reportLostProvenance("finish", research.provenance);
        throw new SuccessFinishError(finishError);
      }
    }

    return {
      status: "succeeded",
      attemptId: attempt.attemptId,
      runId: attempt.runId,
    };
  } catch (error) {
    if (error instanceof SuccessFinishError) throw error.cause;

    if (!(await confirmOwnership())) {
      return {
        status: "lease_lost",
        attemptId: attempt.attemptId,
        runId: attempt.runId,
      };
    }

    const finish = await queue.finish({
      attemptId: attempt.attemptId,
      workerId: options.workerId,
      success: false,
      retryable: false,
      retryDelaySeconds: 0,
      modelSnapshot: attempt.run.modelKey,
      providerResponseId: null,
      ...emptyUsage(),
      webSearchCalls: null,
      sourcesCount: null,
      costMicros: null,
      pricingVersion: null,
      modelMs: null,
      validationMs: null,
      totalMs: now() - startedAt,
      failureClass: "internal",
      failureCode:
        error instanceof ResearchProtocolMismatchError
          ? "research_protocol_mismatch"
          : "executor_validation_failed",
      failureDetail: error instanceof Error ? error.message : String(error),
      validatedOutput: null,
      validationReport: {
        semantic_validation: "not_started",
      },
      traceId: options.traceId ?? null,
    });

    return {
      status: "failed",
      attemptId: attempt.attemptId,
      runId: attempt.runId,
      retryable: false,
      retryCreated: finish.retryCreated,
      failureClass: "internal",
    };
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}