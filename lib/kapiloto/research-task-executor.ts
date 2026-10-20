import type OpenAI from "openai";

import type { KapilotoFixtureCard } from "./fixture-card";
import type { SolFixtureResearchOutput } from "./research-output";
import type { GroundingResult } from "./source-grounding";
import {
  researchFixtureWithSol,
  SolFixtureResearchError,
  type SolFixtureResearchOptions,
  type SolFixtureResearchResult,
} from "./openai-research";

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
  grounder?: FixtureEvidenceGrounder;
  traceId?: string | null;
};

export type ExecuteResearchTaskResult =
  | { status: "no_work" }
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
  if (
    attempt.fixtureCard.research_cutoff_at !== attempt.run.researchCutoffAt
  ) {
    throw new Error("Claimed attempt cutoff does not match run cutoff.");
  }

  return attempt.fixtureCard;
}

function retryableFailure(error: unknown): boolean {
  if (!(error instanceof SolFixtureResearchError)) return false;
  return (
    error.failureClass === "provider_transient" ||
    error.failureClass === "model_output_invalid"
  );
}

function failureClass(error: unknown): string {
  if (error instanceof SolFixtureResearchError) return error.failureClass;
  return "internal";
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
    totalTokens: null,
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

  const attempt = await queue.claim(options.workerId, leaseSeconds);
  if (!attempt) return { status: "no_work" };

  const startedAt = Date.now();
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
              if (!owned) heartbeatLost = true;
            })
            .catch(() => {
              heartbeatLost = true;
            })
            .finally(() => {
              heartbeatInFlight = false;
            });
        }, heartbeatIntervalMs)
      : null;

  try {
    const card = validateClaim(attempt);
    const modelStartedAt = Date.now();

    let research: SolFixtureResearchResult;
    try {
      research = await runner.research(card, {
        model: attempt.run.modelKey,
        reasoningEffort: options.reasoningEffort ?? "high",
      });
    } catch (error) {
      const owned = heartbeatLost
        ? false
        : await queue
            .heartbeat(attempt.attemptId, options.workerId, leaseSeconds)
            .catch(() => false);

      if (!owned) {
        return {
          status: "lease_lost",
          attemptId: attempt.attemptId,
          runId: attempt.runId,
        };
      }

      const retryable = retryableFailure(error);
      const finish = await queue.finish({
        attemptId: attempt.attemptId,
        workerId: options.workerId,
        success: false,
        retryable,
        retryDelaySeconds: retryDelaySeconds(attempt.attemptNo),
        modelSnapshot: attempt.run.modelKey,
        providerResponseId: null,
        ...emptyUsage(),
        webSearchCalls: null,
        sourcesCount: null,
        costMicros: null,
        pricingVersion: null,
        modelMs: Date.now() - modelStartedAt,
        validationMs: null,
        totalMs: Date.now() - startedAt,
        failureClass: failureClass(error),
        failureCode:
          error instanceof SolFixtureResearchError ? error.name : "internal_error",
        failureDetail: error instanceof Error ? error.message : String(error),
        validatedOutput: null,
        validationReport: {
          semantic_validation: "failed",
        },
        traceId: options.traceId ?? null,
      });

      return {
        status: "failed",
        attemptId: attempt.attemptId,
        runId: attempt.runId,
        retryable,
        retryCreated: finish.retryCreated,
        failureClass: failureClass(error),
      };
    }

    const validationStartedAt = Date.now();
    let grounding:
      | {
          grounding: GroundingResult;
          retrievalFailures: Array<{ url: string; error: string }>;
        }
      | null = null;

    if (options.grounder) {
      try {
        grounding = await options.grounder.ground(card, research.output);
      } catch (error) {
        const ownedAfterGrounding = heartbeatLost
          ? false
          : await queue
              .heartbeat(attempt.attemptId, options.workerId, leaseSeconds)
              .catch(() => false);

        if (!ownedAfterGrounding) {
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
          costMicros: null,
          pricingVersion: null,
          modelMs: validationStartedAt - modelStartedAt,
          validationMs: Date.now() - validationStartedAt,
          totalMs: Date.now() - startedAt,
          failureClass: "model_output_invalid",
          failureCode: "evidence_grounding_failed",
          failureDetail: error instanceof Error ? error.message : String(error),
          validatedOutput: null,
          validationReport: {
            semantic_validation: "passed",
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

    const owned = heartbeatLost
      ? false
      : await queue
          .heartbeat(attempt.attemptId, options.workerId, leaseSeconds)
          .catch(() => false);

    if (!owned) {
      return {
        status: "lease_lost",
        attemptId: attempt.attemptId,
        runId: attempt.runId,
      };
    }

    await queue.finish({
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
      costMicros: null,
      pricingVersion: null,
      modelMs: validationStartedAt - modelStartedAt,
      validationMs: Date.now() - validationStartedAt,
      totalMs: Date.now() - startedAt,
      failureClass: null,
      failureCode: null,
      failureDetail: null,
      validatedOutput: research.output,
      validationReport: {
        semantic_validation: "passed",
        source_urls_observed: research.provenance.sourceUrls,
        quote_verification: grounding ? "passed" : "pending",
        entailment_verification:
          grounding &&
          grounding.grounding.requiresEntailmentVerification.length === 0
            ? "not_required"
            : "pending",
        grounding: grounding?.grounding ?? null,
        source_retrieval_failures: grounding?.retrievalFailures ?? [],
      },
      traceId: options.traceId ?? null,
    });

    return {
      status: "succeeded",
      attemptId: attempt.attemptId,
      runId: attempt.runId,
    };
  } catch (error) {
    const owned = heartbeatLost
      ? false
      : await queue
          .heartbeat(attempt.attemptId, options.workerId, leaseSeconds)
          .catch(() => false);

    if (!owned) {
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
      totalMs: Date.now() - startedAt,
      failureClass: "internal",
      failureCode: "executor_validation_failed",
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
