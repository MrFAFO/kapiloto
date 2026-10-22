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