import assert from "node:assert/strict";
import test from "node:test";

import type { KapilotoFixtureCard } from "./fixture-card";
import {
  SolFixtureResearchError,
  type SolFixtureResearchOptions,
  type SolFixtureResearchResult,
} from "./openai-research";
import { KAPILOTO_RESEARCH_DIMENSIONS } from "./research-output";
import {
  DEFAULT_RESEARCH_REQUEST_PROFILE,
  executeOneResearchTask,
  selectRequestProfile,
  stepDownRequestProfile,
  type ClaimedResearchAttempt,
  type FinishResearchAttemptInput,
  type FixtureResearchRunner,
  type PriorAttemptFailure,
  type ResearchAttemptQueue,
  type ResearchRequestProfile,
} from "./research-task-executor";

const card: KapilotoFixtureCard = {
  fixture_card_version: "kapiloto-fixture-card-v2",
  fixture_key: "fixture-1",
  fixture_id: "fixture-1",
  round_game_id: "game-1",
  toto_number: 1,
  settlement: "result_after_90_minutes_including_stoppage_time",
  orientation: { "1": "home", "2": "away" },
  teams: {
    home: { id: "home", names: ["Home"] },
    away: { id: "away", names: ["Away"] },
  },
  competition: { id: "league", name: "League", stage: null, leg: null, aggregate: null },
  kickoff_at: "2026-10-20T18:00:00.000Z",
  neutral_venue: false,
  research_cutoff_at: "2026-10-18T12:00:00.000Z",
  structured: {
    table_snapshot_id: null,
    recent_matches: [],
    squad_snapshot_id: null,
    coach: null,
    prior: {
      type: "market",
      snapshot_id: "market",
      captured_at: "2026-10-18T11:00:00.000Z",
      p_home_bp: 4000,
      p_draw_bp: 3000,
      p_away_bp: 3000,
    },
  },
};

function claimed(attemptNo = 1): ClaimedResearchAttempt {
  return {
    attemptId: `attempt-${attemptNo}`,
    runId: "run-1",
    roundId: "round-1",
    taskKey: "fixture:fixture-1",
    roundGameId: "game-1",
    attemptNo,
    leaseExpiresAt: "2026-10-18T12:15:00Z",
    fixtureCard: card,
    run: {
      modelKey: "sol-model",
      researchProtocolVersion: "kapiloto-research-v1",
      promptTemplateSha256: "a".repeat(64),
      maxAttemptsPerTask: 3,
      executionTopology: "fixture_fanout",
      researchCutoffAt: card.research_cutoff_at,
    },
  };
}

function successResult(): SolFixtureResearchResult {
  return {
    output: {
      protocol_version: "kapiloto-research-v1",
      fixture_key: card.fixture_key,
      home_team_id: "home",
      away_team_id: "away",
      outcome: "analyzed",
      evidence: [],
      availability: [],
      factors: [],
      dimension_coverage: KAPILOTO_RESEARCH_DIMENSIONS.map((dimension) => ({
        dimension,
        status: "no_material_signal",
      })),
      conflicts: [],
      p_sol: { home_bp: 4000, draw_bp: 3000, away_bp: 3000 },
      market_deviation: null,
      key_assumptions: [],
      main_risk: "None.",
      summary: "Balanced fixture.",
      watch_items: [],
      data_quality: { sparse_coverage: false, language_limited: false, notes: "Adequate." },
      suspicious_content_observed: [],
      model_self_confidence: "medium",
    },
    provenance: {
      responseId: "resp-ok",
      model: "sol-model",
      sourceUrls: ["https://example.com/news"],
      webSearchCalls: 2,
      usage: {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 50,
        reasoningTokens: 10,
        totalTokens: 150,
      },
    },
  };
}

const incompleteProvenance = {
  responseId: "resp_incomplete",
  model: "sol-model-snapshot",
  sourceUrls: ["https://a.example/news", "https://b.example/news", "https://c.example/x"],
  webSearchCalls: 7,
  usage: {
    inputTokens: 52_000,
    cachedInputTokens: 4_000,
    outputTokens: 8_000,
    reasoningTokens: 7_600,
    totalTokens: 60_000,
  },
};

function incompleteError() {
  return new SolFixtureResearchError(
    "Sol response did not complete: incomplete (max_output_tokens)",
    "provider_transient",
    incompleteProvenance,
    { code: "sol_incomplete:max_output_tokens", retryable: true, capacityLimited: true },
  );
}

class MemoryQueue implements ResearchAttemptQueue {
  claimValue: ClaimedResearchAttempt | null = claimed();
  claims = 0;
  heartbeatResults: Array<boolean | Error> = [];
  finishes: FinishResearchAttemptInput[] = [];
  finishFailures = 0;
  prior: PriorAttemptFailure[] | Error = [];

  async claim(): Promise<ClaimedResearchAttempt | null> {
    this.claims += 1;
    return this.claimValue;
  }

  async heartbeat(): Promise<boolean> {
    const next = this.heartbeatResults.shift();
    if (next instanceof Error) throw next;
    return next ?? true;
  }

  async finish(input: FinishResearchAttemptInput) {
    if (this.finishFailures > 0) {
      this.finishFailures -= 1;
      throw new Error("finish RPC unavailable");
    }
    this.finishes.push(input);
    return {
      retryCreated: input.retryable,
      nextAttemptId: input.retryable ? "attempt-next" : null,
    };
  }

  async priorFailures(): Promise<PriorAttemptFailure[]> {
    if (this.prior instanceof Error) throw this.prior;
    return this.prior;
  }
}

function recordingRunner(
  behavior: () => Promise<SolFixtureResearchResult>,
  calls: SolFixtureResearchOptions[] = [],
): FixtureResearchRunner {
  return {
    async research(_card, options) {
      calls.push(options);
      return behavior();
    },
  };
}

test("failed attempts persist provider provenance when Sol returned a response", async () => {
  const queue = new MemoryQueue();
  const result = await executeOneResearchTask(
    queue,
    recordingRunner(async () => {
      throw incompleteError();
    }),
    { workerId: "worker-1", heartbeatIntervalMs: 0 },
  );

  assert.equal(result.status, "failed");
  const finish = queue.finishes[0];
  assert.equal(finish.success, false);
  assert.equal(finish.providerResponseId, "resp_incomplete");
  assert.equal(finish.modelSnapshot, "sol-model-snapshot");
  assert.equal(finish.inputTokens, 52_000);
  assert.equal(finish.cachedInputTokens, 4_000);
  assert.equal(finish.outputTokens, 8_000);
  assert.equal(finish.reasoningTokens, 7_600);
  assert.equal(finish.webSearchCalls, 7);
  assert.equal(finish.sourcesCount, 3);
  assert.equal(finish.failureClass, "provider_transient");
  assert.equal(finish.failureCode, "sol_incomplete:max_output_tokens");
  assert.equal(finish.validationReport.provider_total_tokens, 60_000);
  assert.equal(finish.validationReport.provider_response_received, true);
  assert.deepEqual(finish.validationReport.request_profile, {
    reasoning_effort: "medium",
    search_context_size: "high",
    max_output_tokens: DEFAULT_RESEARCH_REQUEST_PROFILE.maxOutputTokens,
    prompt_template_sha256: (finish.validationReport.request_profile as Record<string, unknown>)
      .prompt_template_sha256,
    output_schema_sha256: (finish.validationReport.request_profile as Record<string, unknown>)
      .output_schema_sha256,
  });
});

test("failures without a provider response do not fabricate usage", async () => {
  const queue = new MemoryQueue();
  await executeOneResearchTask(
    queue,
    recordingRunner(async () => {
      throw new SolFixtureResearchError("socket hang up", "provider_transient", null, {
        code: "openai_connection_error",
      });
    }),
    { workerId: "worker-1", heartbeatIntervalMs: 0 },
  );

  const finish = queue.finishes[0];
  assert.equal(finish.providerResponseId, null);
  assert.equal(finish.inputTokens, null);
  assert.equal(finish.outputTokens, null);
  assert.equal(finish.webSearchCalls, null);
  assert.equal(finish.sourcesCount, null);
  assert.equal(finish.failureCode, "openai_connection_error");
  assert.equal(finish.retryable, true);
});

test("a retry after a capacity failure never repeats the identical request shape", async () => {
  const queue = new MemoryQueue();
  queue.claimValue = claimed(2);
  queue.prior = [
    {
      attemptNo: 1,
      failureCode: "sol_incomplete:max_output_tokens",
      failureDetail: "Sol response did not complete: incomplete (max_output_tokens)",
      requestProfile: { ...DEFAULT_RESEARCH_REQUEST_PROFILE },
    },
  ];
  const calls: SolFixtureResearchOptions[] = [];

  const result = await executeOneResearchTask(
    queue,
    recordingRunner(async () => successResult(), calls),
    { workerId: "worker-1", heartbeatIntervalMs: 0 },
  );

  assert.equal(result.status, "succeeded");
  assert.equal(calls[0].reasoningEffort, "low");
  assert.equal(calls[0].maxOutputTokens, DEFAULT_RESEARCH_REQUEST_PROFILE.maxOutputTokens);
});

test("legacy failures recorded without a profile do not force a weaker retry", () => {
  const legacy: PriorAttemptFailure = {
    attemptNo: 1,
    failureCode: "SolFixtureResearchError",
    failureDetail: "Sol response did not complete: incomplete",
    requestProfile: null,
  };
  assert.deepEqual(
    selectRequestProfile(DEFAULT_RESEARCH_REQUEST_PROFILE, [legacy]),
    DEFAULT_RESEARCH_REQUEST_PROFILE,
  );
});

test("profile step-down lowers effort, then search context, then stops", () => {
  let profile: ResearchRequestProfile | null = {
    reasoningEffort: "high",
    searchContextSize: "high",
    maxOutputTokens: 32_000,
  };
  const seen: string[] = [];
  while (profile) {
    seen.push(`${profile.reasoningEffort}/${profile.searchContextSize}`);
    profile = stepDownRequestProfile(profile);
  }
  assert.deepEqual(seen, ["high/high", "medium/high", "low/high", "low/medium", "low/low"]);
});

test("a capacity failure at the cheapest profile is not retried", async () => {
  const queue = new MemoryQueue();
  const result = await executeOneResearchTask(
    queue,
    recordingRunner(async () => {
      throw incompleteError();
    }),
    {
      workerId: "worker-1",
      heartbeatIntervalMs: 0,
      reasoningEffort: "low",
      searchContextSize: "low",
    },
  );

  assert.equal(result.status, "failed");
  if (result.status !== "failed") throw new Error("expected failure");
  assert.equal(result.retryable, false);
  assert.equal(queue.finishes[0].retryable, false);
});

test("non-retryable configuration errors fail fast", async () => {
  const queue = new MemoryQueue();
  const result = await executeOneResearchTask(
    queue,
    recordingRunner(async () => {
      throw new SolFixtureResearchError("Invalid schema", "internal", null, {
        code: "openai_bad_request",
        retryable: false,
      });
    }),
    { workerId: "worker-1", heartbeatIntervalMs: 0 },
  );

  assert.equal(result.status, "failed");
  assert.equal(queue.finishes[0].retryable, false);
  assert.equal(queue.finishes[0].failureClass, "internal");
  assert.equal(queue.finishes[0].failureCode, "openai_bad_request");
});

test("a history-read failure falls back to the base profile instead of failing", async () => {
  const queue = new MemoryQueue();
  queue.claimValue = claimed(2);
  queue.prior = new Error("read timeout");
  const calls: SolFixtureResearchOptions[] = [];

  const result = await executeOneResearchTask(
    queue,
    recordingRunner(async () => successResult(), calls),
    { workerId: "worker-1", heartbeatIntervalMs: 0 },
  );

  assert.equal(result.status, "succeeded");
  assert.equal(calls[0].reasoningEffort, DEFAULT_RESEARCH_REQUEST_PROFILE.reasoningEffort);
});

test("does not claim work when the invocation cannot finish a research call", async () => {
  const queue = new MemoryQueue();
  const result = await executeOneResearchTask(
    queue,
    recordingRunner(async () => successResult()),
    {
      workerId: "worker-1",
      heartbeatIntervalMs: 0,
      now: () => 1_000_000,
      deadlineAtMs: 1_000_000 + 150_000,
      postModelReserveMs: 60_000,
      minimumModelBudgetMs: 120_000,
    },
  );

  assert.deepEqual(result, { status: "deferred", reason: "insufficient_time" });
  assert.equal(queue.claims, 0);
});

test("the provider timeout leaves room for grounding and finishing", async () => {
  const queue = new MemoryQueue();
  const calls: SolFixtureResearchOptions[] = [];

  await executeOneResearchTask(
    queue,
    recordingRunner(async () => successResult(), calls),
    {
      workerId: "worker-1",
      heartbeatIntervalMs: 0,
      now: () => 1_000_000,
      deadlineAtMs: 1_000_000 + 270_000,
      postModelReserveMs: 60_000,
    },
  );

  assert.equal(calls[0].timeoutMs, 210_000);
});

test("a transient heartbeat error does not discard a paid successful result", async () => {
  const queue = new MemoryQueue();
  // Interval heartbeat fails once with an RPC error; the ownership check
  // before finishing then succeeds.
  queue.heartbeatResults = [new Error("network blip"), true, true, true];

  const result = await executeOneResearchTask(
    queue,
    recordingRunner(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return successResult();
    }),
    { workerId: "worker-1", heartbeatIntervalMs: 5 },
  );

  assert.equal(result.status, "succeeded");
  assert.equal(queue.finishes.length, 1);
  assert.equal(queue.finishes[0].providerResponseId, "resp-ok");
});

test("an explicit lease rejection still discards the result", async () => {
  const queue = new MemoryQueue();
  queue.heartbeatResults = [false, false, false, false, false];

  const result = await executeOneResearchTask(
    queue,
    recordingRunner(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return successResult();
    }),
    { workerId: "worker-1", heartbeatIntervalMs: 5 },
  );

  assert.equal(result.status, "lease_lost");
  assert.equal(queue.finishes.length, 0);
});

test("a transient success-write failure is retried once", async () => {
  const queue = new MemoryQueue();
  queue.finishFailures = 1;

  const result = await executeOneResearchTask(
    queue,
    recordingRunner(async () => successResult()),
    { workerId: "worker-1", heartbeatIntervalMs: 0 },
  );

  assert.equal(result.status, "succeeded");
  assert.equal(queue.finishes.length, 1);
  assert.equal(queue.finishes[0].success, true);
});

test("a persistent success-write failure never records a non-retryable failure", async () => {
  const queue = new MemoryQueue();
  queue.finishFailures = 2;

  await assert.rejects(
    executeOneResearchTask(
      queue,
      recordingRunner(async () => successResult()),
      { workerId: "worker-1", heartbeatIntervalMs: 0 },
    ),
    /finish RPC unavailable/,
  );
  assert.equal(queue.finishes.length, 0);
});

test("a transient grounding error is retried in-process before failing", async () => {
  const queue = new MemoryQueue();
  let groundCalls = 0;

  const result = await executeOneResearchTask(
    queue,
    recordingRunner(async () => successResult()),
    {
      workerId: "worker-1",
      heartbeatIntervalMs: 0,
      grounder: {
        async ground() {
          groundCalls += 1;
          if (groundCalls === 1) throw new Error("registry read failed");
          return {
            grounding: {
              accepted: [],
              rejected: [],
              requiresEntailmentVerification: [],
            } as never,
            retrievalFailures: [],
          };
        },
      },
    },
  );

  assert.equal(groundCalls, 2);
  assert.equal(result.status, "succeeded");
});
