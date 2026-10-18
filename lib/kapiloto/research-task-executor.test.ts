import assert from "node:assert/strict";
import test from "node:test";

import type { KapilotoFixtureCard } from "./fixture-card";
import {
  executeOneResearchTask,
  type ClaimedResearchAttempt,
  type FixtureResearchRunner,
  type FinishResearchAttemptInput,
  type ResearchAttemptQueue,
} from "./research-task-executor";
import {
  SolFixtureResearchError,
  type SolFixtureResearchResult,
} from "./openai-research";
import { KAPILOTO_RESEARCH_DIMENSIONS } from "./research-output";

const card: KapilotoFixtureCard = {
  fixture_card_version: "kapiloto-fixture-card-v1",
  fixture_key: "round-1:1",
  round_game_id: "game-1",
  toto_number: 1,
  settlement: "result_after_90_minutes_including_stoppage_time",
  orientation: { "1": "home", "2": "away" },
  teams: {
    home: { id: "home", names: ["Home"] },
    away: { id: "away", names: ["Away"] },
  },
  competition: {
    id: "league",
    name: "League",
    stage: null,
    leg: null,
    aggregate: null,
  },
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

function claimed(): ClaimedResearchAttempt {
  return {
    attemptId: "attempt-1",
    runId: "run-1",
    roundId: "round-1",
    taskKey: "fixture:game-1",
    roundGameId: "game-1",
    attemptNo: 1,
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
      data_quality: {
        sparse_coverage: false,
        language_limited: false,
        notes: "Adequate.",
      },
      suspicious_content_observed: [],
      model_self_confidence: "medium",
    },
    provenance: {
      responseId: "resp-1",
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

class MemoryQueue implements ResearchAttemptQueue {
  claimValue: ClaimedResearchAttempt | null = claimed();
  heartbeatOwned = true;
  finishes: FinishResearchAttemptInput[] = [];

  async claim(): Promise<ClaimedResearchAttempt | null> {
    return this.claimValue;
  }

  async heartbeat(): Promise<boolean> {
    return this.heartbeatOwned;
  }

  async finish(input: FinishResearchAttemptInput) {
    this.finishes.push(input);
    return {
      retryCreated: input.retryable,
      nextAttemptId: input.retryable ? "attempt-2" : null,
    };
  }
}

test("returns no_work when the queue is empty", async () => {
  const queue = new MemoryQueue();
  queue.claimValue = null;

  const runner: FixtureResearchRunner = {
    async research() {
      throw new Error("must not run");
    },
  };

  assert.deepEqual(
    await executeOneResearchTask(queue, runner, {
      workerId: "worker-1",
      heartbeatIntervalMs: 0,
    }),
    { status: "no_work" },
  );
});

test("persists a successful Sol fixture attempt with provenance", async () => {
  const queue = new MemoryQueue();
  const runner: FixtureResearchRunner = {
    async research() {
      return successResult();
    },
  };

  const result = await executeOneResearchTask(queue, runner, {
    workerId: "worker-1",
    heartbeatIntervalMs: 0,
  });

  assert.equal(result.status, "succeeded");
  assert.equal(queue.finishes.length, 1);
  assert.equal(queue.finishes[0].success, true);
  assert.equal(queue.finishes[0].providerResponseId, "resp-1");
  assert.equal(queue.finishes[0].sourcesCount, 1);
  assert.equal(
    queue.finishes[0].validationReport.quote_verification,
    "pending",
  );
});

test("transient/model-output failures create bounded retry requests", async () => {
  const queue = new MemoryQueue();
  const runner: FixtureResearchRunner = {
    async research() {
      throw new SolFixtureResearchError(
        "temporary provider problem",
        "provider_transient",
      );
    },
  };

  const result = await executeOneResearchTask(queue, runner, {
    workerId: "worker-1",
    heartbeatIntervalMs: 0,
  });

  assert.equal(result.status, "failed");
  if (result.status !== "failed") throw new Error("expected failure");
  assert.equal(result.retryable, true);
  assert.equal(result.retryCreated, true);
  assert.equal(queue.finishes[0].retryable, true);
});

test("model refusal is terminal for this logical task", async () => {
  const queue = new MemoryQueue();
  const runner: FixtureResearchRunner = {
    async research() {
      throw new SolFixtureResearchError("refused", "model_refusal");
    },
  };

  const result = await executeOneResearchTask(queue, runner, {
    workerId: "worker-1",
    heartbeatIntervalMs: 0,
  });

  assert.equal(result.status, "failed");
  if (result.status !== "failed") throw new Error("expected failure");
  assert.equal(result.retryable, false);
  assert.equal(queue.finishes[0].retryable, false);
});

test("lost lease discards a returned model result without finishing it", async () => {
  const queue = new MemoryQueue();
  queue.heartbeatOwned = false;

  const runner: FixtureResearchRunner = {
    async research() {
      return successResult();
    },
  };

  const result = await executeOneResearchTask(queue, runner, {
    workerId: "worker-1",
    heartbeatIntervalMs: 0,
  });

  assert.equal(result.status, "lease_lost");
  assert.equal(queue.finishes.length, 0);
});
